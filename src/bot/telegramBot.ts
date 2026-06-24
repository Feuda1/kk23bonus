import { Bot, GrammyError, InlineKeyboard, InputFile, Keyboard } from "grammy";
import type { Context } from "grammy";
import { run, sequentialize, type RunnerHandle } from "@grammyjs/runner";
import { generateLoyaltyCard } from "../card/generateCard.js";
import type { Guest, PendingTransaction, Transaction } from "../domain/types.js";
import type { LoyaltyService } from "../services/loyaltyService.js";
import type { LoyaltyNotifier } from "../services/notifier.js";

const CONTACT_KEYBOARD = new Keyboard()
  .requestContact({ text: "Отправить телефон", style: "primary" })
  .oneTime()
  .resized();
const HISTORY_CLOSE_KEYBOARD = new InlineKeyboard().text("✕ Скрыть", "history:close");
const NOTIF_CLOSE_KEYBOARD = new InlineKeyboard().text("Закрыть всё", "notif:close");
const BIRTHDAY_KEYBOARD = new InlineKeyboard().text("Пропустить", "birthday:skip");
const BACK_TO_SETTINGS_KEYBOARD = new InlineKeyboard().text("← Назад", "settings:open");
const DONE_KEYBOARD = new InlineKeyboard().text("Готово", "settings:close");
const BIRTHDAY_PROMPT_TEXT =
  "🎂 <b>Когда у тебя день рождения?</b>\nНапиши датой — например <b>25.12</b>. Это нужно для подарков ко дню рождения.\nМожно пропустить и заполнить позже в настройках.";
const BOT_COMMANDS = [
  { command: "card", description: "☕ Моя карта" },
  { command: "history", description: "🧾 История операций" },
  { command: "settings", description: "⚙️ Настройки" },
];
const BOT_DESCRIPTION =
  "Бонусная карта KK23: Назовите/покажите ПИН-код баристе, копите бонусы и увеличивайте свой уровень гостя.";
const BOT_SHORT_DESCRIPTION = "Бонусная карта KK23 с PIN и балансом.";
const CARD_THROTTLE_MS = 1200;
const HISTORY_TTL_MS = 2 * 60 * 1000;
const MAX_NAME_LENGTH = 40;
type AwaitedInput = "name" | "birthday";

export class TelegramLoyaltyBot implements LoyaltyNotifier {
  private readonly bot: Bot;
  private readonly contactPromptMessages = new Map<number, number>();
  private readonly cardDeliveryQueue = new Map<string, Promise<void>>();
  private readonly historyQueue = new Map<string, Promise<void>>();
  private readonly notificationQueue = new Map<string, Promise<void>>();
  private readonly lastInteractiveCardRequestAt = new Map<string, number>();
  private readonly historyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly cardCache = new Map<string, { signature: string; image: Buffer }>();
  private readonly awaitingInput = new Map<string, AwaitedInput>();
  private runner?: RunnerHandle;

  constructor(
    token: string,
    private readonly service: LoyaltyService,
  ) {
    this.bot = new Bot(token);
    this.registerHandlers();
    void this.bootstrap();
  }

  async stop(): Promise<void> {
    if (this.runner?.isRunning()) await this.runner.stop();
  }

  async guestRegistered(guest: Guest): Promise<void> {
    if (!guest.tgId) return;
    await this.deliverCard(guest);
  }

  async pointsEarned(guest: Guest, transaction: Transaction): Promise<void> {
    if (!guest.tgId) return;
    await this.deliverCard(guest);
    if (transaction.points > 0) await this.pushNotification(guest, earnNotificationText(transaction));
  }

  async spendRequested(guest: Guest, pending: PendingTransaction): Promise<void> {
    if (!guest.tgId) return;
    await this.clearHistoryMessage(guest);
    const keyboard = new InlineKeyboard()
      .text("Да, списать", `spend:confirm:${pending.id}`)
      .text("Нет", `spend:cancel:${pending.id}`);
    const message = await this.bot.api.sendMessage(
      guest.tgId,
      `Списываем ${pending.points} ${pluralPoints(pending.points)}? Это −${pending.points} ₽ к заказу ☕`,
      { reply_markup: keyboard },
    );
    await this.service.attachPendingMessage(pending.id, message.message_id);
  }

  async spendConfirmed(guest: Guest, transaction: Transaction): Promise<void> {
    if (!guest.tgId) return;
    await this.deliverCard(guest);
    await this.pushNotification(guest, spendNotificationText(transaction));
  }

  async spendCancelled(guest: Guest, pending: PendingTransaction): Promise<void> {
    if (!guest.tgId) return;
    void pending;
  }

  async spendExpired(guest: Guest, pending: PendingTransaction): Promise<void> {
    if (!guest.tgId || !pending.tgMessageId) return;
    await this.safeDeleteMessage(guest.tgId, pending.tgMessageId);
  }

  async birthdayRewarded(guest: Guest, transaction: Transaction): Promise<void> {
    if (!guest.tgId) return;
    await this.deliverCard(guest);
    await this.pushNotification(guest, giftNotificationText(transaction));
  }

  private registerHandlers(): void {
    // Process updates concurrently across guests, but keep a single guest's updates in order.
    this.bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

    this.bot.command("start", async (ctx) => {
      await this.safeDeleteCurrentMessage(ctx);
      const tgId = String(ctx.from?.id ?? ctx.chat.id);
      this.awaitingInput.delete(tgId);
      const existing = await this.service.getGuestByTelegramId(tgId);
      if (existing) {
        await this.clearHistoryMessage(existing);
        await this.closeNotifications(existing);
        await this.clearFlow(existing);
        await this.clearHeaderMessage(existing);
        await this.deliverCard(existing, { resend: true });
        return;
      }
      await this.promptContact(ctx);
    });

    this.bot.command("card", async (ctx) => {
      await this.safeDeleteCurrentMessage(ctx);
      const tgId = String(ctx.from?.id ?? ctx.chat.id);
      this.awaitingInput.delete(tgId);
      const guest = await this.service.getGuestByTelegramId(tgId);
      if (!guest) {
        await this.promptContact(ctx);
        return;
      }
      if (!this.takeInteractiveCardSlot(tgId)) return;
      await this.clearHistoryMessage(guest);
      await this.closeNotifications(guest);
      await this.clearFlow(guest);
      await this.service.touchCard(guest.id);
      await this.deliverCard(guest);
    });

    this.bot.command("history", async (ctx) => {
      await this.safeDeleteCurrentMessage(ctx);
      const tgId = String(ctx.from?.id ?? ctx.chat.id);
      this.awaitingInput.delete(tgId);
      const guest = await this.service.getGuestByTelegramId(tgId);
      if (!guest) {
        await this.promptContact(ctx);
        return;
      }
      await this.openHistory(guest);
    });

    this.bot.command("settings", async (ctx) => {
      await this.safeDeleteCurrentMessage(ctx);
      const tgId = String(ctx.from?.id ?? ctx.chat.id);
      this.awaitingInput.delete(tgId);
      const guest = await this.service.getGuestByTelegramId(tgId);
      if (!guest) {
        await this.promptContact(ctx);
        return;
      }
      await this.openSettings(guest);
    });

    this.bot.on("message:contact", async (ctx) => {
      const contact = ctx.message.contact;
      if (!contact?.phone_number) return;
      await this.safeDeleteCurrentMessage(ctx);
      await this.deleteStoredContactPrompt(ctx.chat.id);
      const tgId = String(ctx.from?.id ?? ctx.chat.id);
      const fallbackName = ctx.from?.first_name ?? contact.first_name ?? "Гость";
      const guest = await this.service.registerGuest({
        phone: contact.phone_number,
        name: fallbackName,
        tgId,
      });
      // Right after the card, offer to add a birthday — it flows under the card and can be skipped.
      if (guest.tgId && !guest.birthday) {
        this.awaitingInput.set(guest.tgId, "birthday");
        await this.sendFlow(guest, BIRTHDAY_PROMPT_TEXT, BIRTHDAY_KEYBOARD);
      }
    });

    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      void this.safeDeleteCurrentMessage(ctx);
      if (text.startsWith("/")) return;
      const tgId = String(ctx.from?.id ?? ctx.chat.id);
      const guest = await this.service.getGuestByTelegramId(tgId);
      if (!guest) {
        await this.promptContact(ctx);
        return;
      }

      const pending = this.awaitingInput.get(tgId);
      if (pending === "name") {
        await this.handleNameInput(guest, text);
        return;
      }
      if (pending === "birthday") {
        await this.handleBirthdayInput(guest, text);
      }
    });

    this.bot.on("message", async (ctx) => {
      await this.safeDeleteCurrentMessage(ctx);
    });

    this.bot.on("callback_query:data", async (ctx) => {
      const [namespace, action, id] = ctx.callbackQuery.data.split(":");
      if (namespace === "spend") {
        await this.handleSpendCallback(ctx, action, id);
        return;
      }
      if (namespace === "history") {
        await this.handleHistoryCallback(ctx, action);
        return;
      }
      if (namespace === "notif") {
        await this.handleNotifCallback(ctx);
        return;
      }
      if (namespace === "settings") {
        await this.handleSettingsCallback(ctx, action);
        return;
      }
      if (namespace === "birthday") {
        await this.handleBirthdayCallback(ctx, action);
        return;
      }
      await ctx.answerCallbackQuery().catch(() => {});
    });
  }

  private async handleSettingsCallback(ctx: Context, action: string): Promise<void> {
    const tgId = String(ctx.from?.id ?? ctx.chat?.id ?? "");
    const guest = tgId ? await this.service.getGuestByTelegramId(tgId) : null;
    if (!guest || !guest.tgId) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    if (action === "notif") {
      const updated = await this.service.setNotificationsEnabled(guest.id, !guest.notificationsEnabled);
      await this.editFlow(updated, settingsText(updated), settingsKeyboard(updated));
      await ctx.answerCallbackQuery({ text: updated.notificationsEnabled ? "Уведомления включены 🔔" : "Уведомления выключены 🔕" });
      return;
    }
    if (action === "name") {
      this.awaitingInput.set(guest.tgId, "name");
      await this.editFlow(guest, "✏️ <b>Напиши новое имя</b>", BACK_TO_SETTINGS_KEYBOARD);
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    if (action === "birthday") {
      this.awaitingInput.set(guest.tgId, "birthday");
      await this.editFlow(guest, BIRTHDAY_PROMPT_TEXT, BIRTHDAY_KEYBOARD);
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    if (action === "open") {
      this.awaitingInput.delete(guest.tgId);
      await this.editFlow(guest, settingsText(guest), settingsKeyboard(guest));
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    // close
    await this.clearFlow(guest);
    await ctx.answerCallbackQuery().catch(() => {});
  }

  private async handleBirthdayCallback(ctx: Context, action: string): Promise<void> {
    const tgId = String(ctx.from?.id ?? ctx.chat?.id ?? "");
    const guest = tgId ? await this.service.getGuestByTelegramId(tgId) : null;
    if (guest && action === "skip") await this.clearFlow(guest);
    await ctx.answerCallbackQuery().catch(() => {});
  }

  private async handleNotifCallback(ctx: Context): Promise<void> {
    const tgId = String(ctx.from?.id ?? ctx.chat?.id ?? "");
    const guest = tgId ? await this.service.getGuestByTelegramId(tgId) : null;
    if (guest) await this.closeNotifications(guest);
    await ctx.answerCallbackQuery().catch(() => {});
  }

  private async handleSpendCallback(ctx: Context, action: string, pendingId: string): Promise<void> {
    if (!pendingId || !["confirm", "cancel"].includes(action)) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    try {
      if (action === "confirm") {
        await this.service.confirmSpend(pendingId);
        await ctx.answerCallbackQuery({ text: "Готово! Баллы списаны ✨" });
      } else {
        await this.service.cancelSpend(pendingId);
        await ctx.answerCallbackQuery({ text: "Окей, баллы остаются с вами ☕" });
      }
      await this.deleteCallbackMessage(ctx);
    } catch (error) {
      await this.deleteCallbackMessage(ctx);
      await ctx.answerCallbackQuery({ text: friendlySpendError(error), show_alert: true });
    }
  }

  private async handleHistoryCallback(ctx: Context, action: string): Promise<void> {
    const tgId = String(ctx.from?.id ?? ctx.chat?.id ?? "");
    const guest = tgId ? await this.service.getGuestByTelegramId(tgId) : null;
    if (!guest) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    if (action === "close") {
      await this.clearHistoryMessage(guest);
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    await this.openHistory(guest);
    await ctx.answerCallbackQuery().catch(() => {});
  }

  private async openHistory(guest: Guest): Promise<void> {
    if (!guest.tgId) return;
    await this.enqueue(this.historyQueue, guest.tgId, () => this.openHistoryUnlocked(guest));
  }

  private async openHistoryUnlocked(guest: Guest): Promise<void> {
    if (!guest.tgId) return;
    // Re-read so we delete whatever history message currently exists, then send a fresh one.
    // Only one history message may live at a time, and it always lands at the bottom of the chat.
    const current = (await this.service.getGuest(guest.id)) ?? guest;
    await this.clearHistoryMessage(current);
    await this.closeNotifications(current);
    await this.clearFlow(current);

    const transactions = await this.service.listTransactions(guest.id, 10);
    const text = makeHistoryText(transactions);
    const message = await this.bot.api.sendMessage(guest.tgId, text, {
      parse_mode: "HTML",
      reply_markup: HISTORY_CLOSE_KEYBOARD,
    });
    await this.service.updateTelegramHistoryMessage(guest.id, message.message_id);
    this.scheduleHistoryAutoClose(guest.id, guest.tgId, message.message_id);
  }

  private async clearHistoryMessage(guest: Guest): Promise<void> {
    this.clearHistoryTimer(guest.id);
    if (!guest.tgId || !guest.tgHistoryMessageId) return;
    await this.safeDeleteMessage(guest.tgId, guest.tgHistoryMessageId);
    await this.service.updateTelegramHistoryMessage(guest.id, null);
  }

  private scheduleHistoryAutoClose(guestId: string, tgId: string, messageId: number): void {
    this.clearHistoryTimer(guestId);
    const timer = setTimeout(() => {
      this.historyTimers.delete(guestId);
      void this.autoCloseHistory(guestId, tgId, messageId);
    }, HISTORY_TTL_MS);
    timer.unref?.();
    this.historyTimers.set(guestId, timer);
  }

  private clearHistoryTimer(guestId: string): void {
    const timer = this.historyTimers.get(guestId);
    if (timer) {
      clearTimeout(timer);
      this.historyTimers.delete(guestId);
    }
  }

  private async autoCloseHistory(guestId: string, tgId: string, messageId: number): Promise<void> {
    await this.safeDeleteMessage(tgId, messageId);
    const guest = await this.service.getGuest(guestId);
    if (guest?.tgHistoryMessageId === messageId) {
      await this.service.updateTelegramHistoryMessage(guestId, null);
    }
  }

  private async clearHeaderMessage(guest: Guest): Promise<void> {
    if (!guest.tgId || !guest.tgHeaderMessageId) return;
    await this.safeDeleteMessage(guest.tgId, guest.tgHeaderMessageId);
    await this.service.updateTelegramHeaderMessage(guest.id, null);
  }

  /** Posts a small notification under the card. Only the newest one carries the "Закрыть всё" button. */
  private async pushNotification(guest: Guest, text: string): Promise<void> {
    if (!guest.tgId) return;
    await this.enqueue(this.notificationQueue, guest.tgId, async () => {
      const fresh = (await this.service.getGuest(guest.id)) ?? guest;
      if (!fresh.tgId || !fresh.notificationsEnabled) return;
      const previous = fresh.tgNotificationIds.at(-1);
      if (previous) await this.safeStripReplyMarkup(fresh.tgId, previous);
      const message = await this.bot.api.sendMessage(fresh.tgId, text, {
        parse_mode: "HTML",
        reply_markup: NOTIF_CLOSE_KEYBOARD,
      });
      await this.service.pushNotificationMessage(fresh.id, message.message_id);
    });
  }

  /** Closes every notification at once — works any time, survives restarts (ids live in the DB). */
  private async closeNotifications(guest: Guest): Promise<void> {
    if (!guest.tgId) return;
    await this.enqueue(this.notificationQueue, guest.tgId, async () => {
      const fresh = (await this.service.getGuest(guest.id)) ?? guest;
      if (!fresh.tgId || fresh.tgNotificationIds.length === 0) return;
      for (const id of fresh.tgNotificationIds) await this.safeDeleteMessage(fresh.tgId, id);
      await this.service.clearNotificationMessages(fresh.id);
    });
  }

  private async safeStripReplyMarkup(chatId: number | string, messageId: number): Promise<void> {
    try {
      await this.bot.api.editMessageReplyMarkup(chatId, messageId);
    } catch {}
  }

  private async promptContact(ctx: Context): Promise<void> {
    const prompt = await ctx.reply("Подтвердите телефон, чтобы выпустить карту KK23.", { reply_markup: CONTACT_KEYBOARD });
    if (ctx.chat) this.contactPromptMessages.set(ctx.chat.id, prompt.message_id);
  }

  private async openSettings(guest: Guest): Promise<void> {
    await this.sendFlow(guest, settingsText(guest), settingsKeyboard(guest));
  }

  private async handleNameInput(guest: Guest, text: string): Promise<void> {
    if (!guest.tgId) return;
    const name = text.trim();
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      await this.editFlow(guest, `✏️ Имя должно быть от 1 до ${MAX_NAME_LENGTH} символов. Попробуй ещё раз:`, BACK_TO_SETTINGS_KEYBOARD);
      return;
    }
    this.awaitingInput.delete(guest.tgId);
    const updated = await this.service.updateGuestName(guest.id, name);
    await this.service.touchCard(updated.id);
    await this.deliverCard(updated);
    await this.editFlow(updated, settingsText(updated), settingsKeyboard(updated));
  }

  private async handleBirthdayInput(guest: Guest, text: string): Promise<void> {
    if (!guest.tgId) return;
    const iso = parseBirthday(text);
    if (!iso) {
      await this.editFlow(guest, "🎂 Хм, не похоже на дату. Напиши как <b>25.12</b> 🎂", BIRTHDAY_KEYBOARD);
      return;
    }
    this.awaitingInput.delete(guest.tgId);
    const updated = await this.service.updateGuestBirthday(guest.id, iso);
    await this.editFlow(updated, `🎂 Отлично! День рождения сохранён: <b>${formatBirthday(iso)}</b>`, DONE_KEYBOARD);
  }

  /** Sends a fresh flow panel (settings / birthday) under the card, replacing any previous one. */
  private async sendFlow(guest: Guest, text: string, keyboard: InlineKeyboard): Promise<void> {
    if (!guest.tgId) return;
    await this.clearFlowMessageOnly(guest);
    const message = await this.bot.api.sendMessage(guest.tgId, text, { parse_mode: "HTML", reply_markup: keyboard });
    await this.service.updateFlowMessage(guest.id, message.message_id);
  }

  /** Updates the existing flow panel in place; falls back to a fresh send if it was removed. */
  private async editFlow(guest: Guest, text: string, keyboard: InlineKeyboard): Promise<void> {
    if (!guest.tgId) return;
    if (guest.tgFlowMessageId) {
      try {
        await this.bot.api.editMessageText(guest.tgId, guest.tgFlowMessageId, text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
        return;
      } catch (error) {
        if (isMessageNotModified(error)) return;
        // gone — fall through to a fresh send
      }
    }
    const message = await this.bot.api.sendMessage(guest.tgId, text, { parse_mode: "HTML", reply_markup: keyboard });
    await this.service.updateFlowMessage(guest.id, message.message_id);
  }

  private async clearFlow(guest: Guest): Promise<void> {
    if (guest.tgId) this.awaitingInput.delete(guest.tgId);
    await this.clearFlowMessageOnly(guest);
  }

  private async clearFlowMessageOnly(guest: Guest): Promise<void> {
    if (!guest.tgId || !guest.tgFlowMessageId) return;
    await this.safeDeleteMessage(guest.tgId, guest.tgFlowMessageId);
    await this.service.updateFlowMessage(guest.id, null);
  }

  private async bootstrap(): Promise<void> {
    await this.bot.api.setMyDescription(BOT_DESCRIPTION);
    await this.bot.api.setMyShortDescription(BOT_SHORT_DESCRIPTION);
    await this.bot.api.setMyCommands(BOT_COMMANDS);
    await this.bot.api.setChatMenuButton({ menu_button: { type: "commands" } });
    this.bot.catch((error) => {
      console.error("Telegram bot error", error);
    });
    this.runner = run(this.bot);
  }

  /** Serialises async work per key so concurrent updates for one guest never interleave. */
  private enqueue(map: Map<string, Promise<void>>, key: string, fn: () => Promise<void>): Promise<void> {
    const previous = map.get(key)?.catch(() => undefined);
    const next = (previous ?? Promise.resolve()).then(fn);
    const queued = next.finally(() => {
      if (map.get(key) === queued) map.delete(key);
    });
    map.set(key, queued);
    return next;
  }

  private async deliverCard(guest: Guest, options: { interactive?: boolean; resend?: boolean } = {}): Promise<void> {
    if (!guest.tgId) return;
    if (options.interactive && !this.takeInteractiveCardSlot(guest.tgId)) return;
    try {
      await this.enqueue(this.cardDeliveryQueue, guest.tgId, () => this.deliverCardUnlocked(guest, options.resend ?? false));
    } catch (error) {
      // Card delivery is a side effect of earn/spend — never let it break the core operation.
      console.error("Card delivery failed", error);
    }
  }

  /**
   * Keeps exactly one card message per guest and edits it in place — editing has no 48h limit, so the
   * card never goes stale. The card carries NO keyboard (a photo sent with a reply keyboard cannot
   * have its media edited by Telegram); navigation lives in the bot's command menu instead. `resend`,
   * or a card that can't be edited, triggers a fresh send.
   */
  private async deliverCardUnlocked(guest: Guest, resend: boolean): Promise<void> {
    const latestGuest = (await this.service.getGuest(guest.id)) ?? guest;
    const tgId = latestGuest.tgId;
    if (!tgId) return;

    // Re-render only when the visible content actually changed; otherwise reuse the cached PNG.
    // The render (SVG → PNG) is the expensive step, so caching it keeps "Карта" taps snappy.
    const signature = makeCardSignature(latestGuest);
    const cached = this.cardCache.get(latestGuest.id);
    const image = cached?.signature === signature ? cached.image : await generateLoyaltyCard(latestGuest);
    this.cardCache.set(latestGuest.id, { signature, image });
    const caption = this.makeCardCaption(latestGuest);
    const cardId = latestGuest.tgCardMessageId;

    if (cardId && !resend) {
      try {
        await this.bot.api.editMessageMedia(tgId, cardId, {
          type: "photo",
          media: this.makeCardFile(image, latestGuest.loyaltyCode),
          caption,
        });
        return;
      } catch (error) {
        if (isMessageNotModified(error)) return;
        if (!isEditImpossible(error)) throw error;
        // Deleted by the guest, or a legacy card that can't be edited — replace it with a fresh one.
      }
    }

    if (cardId) await this.safeDeleteMessage(tgId, cardId);
    const message = await this.bot.api.sendPhoto(tgId, this.makeCardFile(image, latestGuest.loyaltyCode), { caption });
    await this.service.updateTelegramCardMessage(latestGuest.id, message.message_id);
  }

  private makeCardFile(image: Buffer, loyaltyCode: string): InputFile {
    return new InputFile(image, `kk23-${loyaltyCode}.png`);
  }

  private makeCardCaption(guest: Guest): string {
    const level = guest.level === "guest" ? "Гость" : guest.level === "regular" ? "Постоянный" : "Свой";
    return [`☕ PIN: ${guest.loyaltyCode}`, `💰 Баланс: ${guest.balance} баллов`, `⭐ Уровень: ${level}`].join("\n");
  }

  private async deleteStoredContactPrompt(chatId: number): Promise<void> {
    const messageId = this.contactPromptMessages.get(chatId);
    if (!messageId) return;
    this.contactPromptMessages.delete(chatId);
    await this.safeDeleteMessage(chatId, messageId);
  }

  private async deleteCallbackMessage(ctx: Context): Promise<void> {
    const message = ctx.callbackQuery?.message;
    if (!message) return;
    await this.safeDeleteMessage(message.chat.id, message.message_id);
  }

  private async safeDeleteCurrentMessage(ctx: { deleteMessage: () => Promise<true> }): Promise<void> {
    try {
      await ctx.deleteMessage();
    } catch {}
  }

  private async safeDeleteMessage(chatId: number | string, messageId: number): Promise<void> {
    try {
      await this.bot.api.deleteMessage(chatId, messageId);
    } catch {}
  }

  private takeInteractiveCardSlot(tgId: string | null): boolean {
    if (!tgId) return false;
    const now = Date.now();
    const last = this.lastInteractiveCardRequestAt.get(tgId) ?? 0;
    if (now - last < CARD_THROTTLE_MS) return false;
    this.lastInteractiveCardRequestAt.set(tgId, now);
    return true;
  }
}

function earnNotificationText(transaction: Transaction): string {
  const points = transaction.points;
  return `➕ <b>Пополнение +${points} ${pluralPoints(points)}</b>\nЗа покупку на ${transaction.amount} ₽`;
}

function spendNotificationText(transaction: Transaction): string {
  const points = Math.abs(transaction.points);
  return `➖ <b>Списание ${points} ${pluralPoints(points)}</b>\nСкидка ${points} ₽`;
}

function giftNotificationText(transaction: Transaction): string {
  const points = transaction.points;
  return `🎁 <b>Подарок на день рождения +${points} ${pluralPoints(points)}</b>\nС днём рождения! 🎉`;
}

function makeCardSignature(guest: Guest): string {
  return [guest.loyaltyCode, guest.name, guest.balance, guest.level, guest.cardUpdatedAt ?? ""].join("|");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function settingsText(guest: Guest): string {
  return [
    "⚙️ <b>Настройки</b>",
    "",
    `👤 Имя: <b>${escapeHtml(guest.name)}</b>`,
    `🎂 День рождения: <b>${guest.birthday ? formatBirthday(guest.birthday) : "не указан"}</b>`,
    `🔔 Уведомления: <b>${guest.notificationsEnabled ? "включены" : "выключены"}</b>`,
  ].join("\n");
}

function settingsKeyboard(guest: Guest): InlineKeyboard {
  return new InlineKeyboard()
    .text("✏️ Изменить имя", "settings:name")
    .row()
    .text(guest.birthday ? "🎂 Изменить день рождения" : "🎂 Указать день рождения", "settings:birthday")
    .row()
    .text(guest.notificationsEnabled ? "🔕 Выключить уведомления" : "🔔 Включить уведомления", "settings:notif")
    .row()
    .text("✕ Закрыть", "settings:close");
}

/** Parses "ДД.ММ" or "ДД.ММ.ГГГГ" (any of . / - space separators) into an ISO date, or null. */
function parseBirthday(text: string): string | null {
  const match = text.trim().match(/^(\d{1,2})[.\-/ ](\d{1,2})(?:[.\-/ ](\d{2,4}))?$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = match[3] ? Number(match[3]) : 2000;
  if (year < 100) year += 1900;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatBirthday(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${day}.${month}`;
}

function isMessageNotModified(error: unknown): boolean {
  return error instanceof GrammyError && error.description.includes("message is not modified");
}

/** True when the card message cannot be edited (deleted, wrong type, or a legacy reply-keyboard photo). */
function isEditImpossible(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  const d = error.description;
  return (
    d.includes("message to edit not found") ||
    d.includes("MESSAGE_ID_INVALID") ||
    d.includes("message can't be edited") ||
    d.includes("message media can't be edited") ||
    d.includes("message to delete not found")
  );
}

function pluralPoints(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return "баллов";
  if (last === 1) return "балл";
  if (last >= 2 && last <= 4) return "балла";
  return "баллов";
}

function friendlySpendError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("expired") || message.includes("not active")) {
    return "Кнопка уже остыла ☕ Попросите бариста повторить запрос.";
  }
  if (message.includes("Not enough")) {
    return "На балансе пока не хватает баллов 🙈";
  }
  return "Не получилось обработать запрос. Попробуйте ещё раз 🙏";
}

const HISTORY_DATE_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

function makeHistoryText(transactions: Transaction[]): string {
  const header = "🧾 <b>История операций</b>";
  if (transactions.length === 0) {
    return `${header}\n\nПока пусто — самое время за кофе ☕`;
  }
  const rows = transactions.map((transaction) => {
    const when = HISTORY_DATE_FORMAT.format(new Date(transaction.createdAt));
    const points = transaction.points;
    const signed = points > 0 ? `+${points}` : `−${Math.abs(points)}`;
    const line =
      transaction.type === "earn"
        ? `➕ <b>${signed}</b> ${pluralPoints(points)} · пополнение`
        : transaction.type === "spend"
          ? `➖ <b>${signed}</b> ${pluralPoints(points)} · списание`
          : transaction.type === "expire"
            ? `🔥 <b>${signed}</b> ${pluralPoints(points)} · сгорели`
            : `🎁 <b>${signed}</b> ${pluralPoints(points)} · подарок`;
    return `${line}\n<i>${when}</i>`;
  });
  return `${header}\n\n${rows.join("\n\n")}`;
}
