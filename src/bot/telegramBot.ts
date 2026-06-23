import { Bot, InlineKeyboard, InputFile, Keyboard } from "grammy";
import type { Context } from "grammy";
import { generateLoyaltyCard } from "../card/generateCard.js";
import type { Guest, PendingTransaction, Transaction } from "../domain/types.js";
import type { LoyaltyService } from "../services/loyaltyService.js";
import type { LoyaltyNotifier } from "../services/notifier.js";

const CONTACT_KEYBOARD = new Keyboard().requestContact("Отправить телефон").oneTime().resized();
const MAIN_KEYBOARD = new Keyboard().text("☕ Карта").persistent().resized().placeholder("Ваша карта KK23");
const BOT_DESCRIPTION =
  "Бонусная карта KK23: PIN для кассы, баланс баллов, история начислений и безопасное подтверждение списаний.";
const BOT_SHORT_DESCRIPTION = "Бонусная карта KK23 с PIN и балансом.";

export class TelegramLoyaltyBot implements LoyaltyNotifier {
  private readonly bot: Bot;
  private readonly contactPromptMessages = new Map<number, number>();

  constructor(
    token: string,
    private readonly service: LoyaltyService,
  ) {
    this.bot = new Bot(token);
    this.registerHandlers();
    void this.bootstrap();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async guestRegistered(guest: Guest): Promise<void> {
    if (!guest.tgId) return;
    await this.deliverCard(guest);
  }

  async pointsEarned(guest: Guest, transaction: Transaction): Promise<void> {
    if (!guest.tgId) return;
    void transaction;
    await this.deliverCard(guest);
  }

  async spendRequested(guest: Guest, pending: PendingTransaction): Promise<void> {
    if (!guest.tgId) return;
    const keyboard = new InlineKeyboard()
      .text("Да, списать", `spend:confirm:${pending.id}`)
      .text("Нет", `spend:cancel:${pending.id}`);
    await this.bot.api.sendMessage(guest.tgId, `Списать ${pending.points} баллов? Скидка ${pending.points} ₽.`, {
      reply_markup: keyboard,
    });
  }

  async spendConfirmed(guest: Guest, transaction: Transaction): Promise<void> {
    if (!guest.tgId) return;
    void transaction;
    await this.deliverCard(guest);
  }

  async spendCancelled(guest: Guest, pending: PendingTransaction): Promise<void> {
    if (!guest.tgId) return;
    void pending;
  }

  private registerHandlers(): void {
    this.bot.command("start", async (ctx) => {
      await this.safeDeleteCurrentMessage(ctx);
      const chatId = ctx.chat.id;
      const existing = await this.service.getGuestByTelegramId(String(ctx.from?.id ?? chatId));
      if (existing) {
        await this.deliverCard(existing, { cleanupPrevious: true });
        return;
      }

      const prompt = await ctx.reply("Подтвердите телефон, чтобы выпустить карту KK23.", {
        reply_markup: CONTACT_KEYBOARD,
      });
      this.contactPromptMessages.set(chatId, prompt.message_id);
    });

    this.bot.command("card", async (ctx) => {
      await this.safeDeleteCurrentMessage(ctx);
      const guest = await this.service.getGuestByTelegramId(String(ctx.from?.id ?? ctx.chat.id));
      if (guest) {
        await this.deliverCard(guest, { cleanupPrevious: true });
        return;
      }
      const prompt = await ctx.reply("Подтвердите телефон, чтобы выпустить карту KK23.", {
        reply_markup: CONTACT_KEYBOARD,
      });
      this.contactPromptMessages.set(ctx.chat.id, prompt.message_id);
    });

    this.bot.callbackQuery("card:refresh", async (ctx) => {
      const guest = await this.service.getGuestByTelegramId(String(ctx.from?.id ?? ctx.chat?.id));
      if (!guest) {
        await ctx.answerCallbackQuery({ text: "Карта ещё не выпущена", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Карта обновлена" });
      await this.deliverCard(guest, { cleanupPrevious: true, previousMessageId: ctx.callbackQuery.message?.message_id });
    });

    this.bot.on("message:contact", async (ctx) => {
      const contact = ctx.message.contact;
      if (!contact?.phone_number) return;
      await this.safeDeleteCurrentMessage(ctx);
      await this.deleteStoredContactPrompt(ctx.chat.id);
      const tgId = String(ctx.from?.id ?? ctx.chat.id);
      const fallbackName = ctx.from?.first_name ?? contact.first_name ?? "Гость";
      await this.service.registerGuest({
        phone: contact.phone_number,
        name: fallbackName,
        tgId,
      });
    });

    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      await this.safeDeleteCurrentMessage(ctx);
      if (text.startsWith("/")) return;
      const tgId = String(ctx.from?.id ?? ctx.chat.id);
      const guest = await this.service.getGuestByTelegramId(tgId);
      if (!guest) {
        const prompt = await ctx.reply("Подтвердите телефон, чтобы выпустить карту KK23.", { reply_markup: CONTACT_KEYBOARD });
        this.contactPromptMessages.set(ctx.chat.id, prompt.message_id);
        return;
      }

      if (["☕ Карта", "Карта", "Показать карту"].includes(text)) {
        await this.deliverCard(guest, { cleanupPrevious: true });
        return;
      }

      if (text === "Баланс") {
        await this.deliverCard(guest, { cleanupPrevious: true });
      }
    });

    this.bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      const [, action, pendingId] = data.split(":");
      if (!pendingId || !["confirm", "cancel"].includes(action)) return;

      try {
        if (action === "confirm") {
          await this.service.confirmSpend(pendingId);
          await ctx.answerCallbackQuery({ text: "Списание подтверждено" });
          await this.deleteCallbackMessage(ctx);
          return;
        }

        await this.service.cancelSpend(pendingId);
        await ctx.answerCallbackQuery({ text: "Списание отменено" });
        await this.deleteCallbackMessage(ctx);
      } catch (error) {
        await this.deleteCallbackMessage(ctx);
        await ctx.answerCallbackQuery({
          text: error instanceof Error ? error.message : "Не удалось обработать запрос",
          show_alert: true,
        });
      }
    });
  }

  private async bootstrap(): Promise<void> {
    await this.bot.api.setMyDescription(BOT_DESCRIPTION);
    await this.bot.api.setMyShortDescription(BOT_SHORT_DESCRIPTION);
    await this.bot.api.deleteMyCommands();
    await this.bot.api.setChatMenuButton({ menu_button: { type: "default" } });
    this.bot.catch((error) => {
      console.error("Telegram bot error", error);
    });
    await this.bot.start();
  }

  private async deliverCard(
    guest: Guest,
    options: { cleanupPrevious?: boolean; previousMessageId?: number } = {},
  ): Promise<void> {
    if (!guest.tgId) return;
    const image = await generateLoyaltyCard(guest);
    const file = new InputFile(image, `kk23-${guest.loyaltyCode}.png`);
    const caption = this.makeCardCaption(guest);

    const lastMessageId = options.previousMessageId ?? guest.tgCardMessageId;
    if (lastMessageId) {
      if (options.cleanupPrevious) {
        await this.deleteMessageWindow(guest.tgId, lastMessageId, 8);
      } else {
        await this.safeDeleteMessage(guest.tgId, lastMessageId);
      }
    }

    const message = await this.bot.api.sendPhoto(guest.tgId, file, {
      caption,
      reply_markup: MAIN_KEYBOARD,
    });
    await this.service.updateTelegramCardMessage(guest.id, message.message_id);
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

  private async deleteMessageWindow(chatId: number | string, lastMessageId: number, count: number): Promise<void> {
    const ids = Array.from({ length: count }, (_, index) => lastMessageId - index).filter((id) => id > 0);
    await Promise.all(ids.map((id) => this.safeDeleteMessage(chatId, id)));
  }
}
