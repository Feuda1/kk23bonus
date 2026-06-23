import { Bot, InlineKeyboard, InputFile, Keyboard } from "grammy";
import { generateLoyaltyCard } from "../card/generateCard.js";
import type { Guest, PendingTransaction, Transaction } from "../domain/types.js";
import type { LoyaltyService } from "../services/loyaltyService.js";
import type { LoyaltyNotifier } from "../services/notifier.js";

const CONTACT_KEYBOARD = new Keyboard().requestContact("Отправить телефон").row().text("Показать карту").text("Баланс").resized();

export class TelegramLoyaltyBot implements LoyaltyNotifier {
  private readonly bot: Bot;

  constructor(
    token: string,
    private readonly service: LoyaltyService,
  ) {
    this.bot = new Bot(token);
    this.registerHandlers();
    void this.bot.start();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async guestRegistered(guest: Guest): Promise<void> {
    if (!guest.tgId) return;
    await this.sendCard(guest, `Добро пожаловать в KK23, ${guest.name}!`);
  }

  async pointsEarned(guest: Guest, transaction: Transaction): Promise<void> {
    if (!guest.tgId) return;
    await this.sendCard(guest, `Начислено ${transaction.points} баллов. Новый баланс: ${guest.balance}.`);
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
    await this.sendCard(guest, `Списано ${Math.abs(transaction.points)} баллов. Новый баланс: ${guest.balance}.`);
  }

  async spendCancelled(guest: Guest, pending: PendingTransaction): Promise<void> {
    if (!guest.tgId) return;
    await this.bot.api.sendMessage(guest.tgId, `Списание ${pending.points} баллов отменено.`);
  }

  private registerHandlers(): void {
    this.bot.command("start", async (ctx) => {
      const chatId = ctx.chat.id;
      const existing = await this.service.getGuestByTelegramId(String(ctx.from?.id ?? chatId));
      if (existing) {
        await this.sendCard(existing, `Рады снова видеть, ${existing.name}!`);
        return;
      }

      await ctx.reply("Привет! Это бонусная карта KK23. Отправьте телефон, чтобы создать карту с PIN и балансом.", {
        reply_markup: CONTACT_KEYBOARD,
      });
    });

    this.bot.on("message:contact", async (ctx) => {
      const contact = ctx.message.contact;
      if (!contact?.phone_number) return;
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
      if (text.startsWith("/")) return;
      const tgId = String(ctx.from?.id ?? ctx.chat.id);
      const guest = await this.service.getGuestByTelegramId(tgId);
      if (!guest) {
        await ctx.reply("Сначала отправьте телефон, чтобы создать карту.", { reply_markup: CONTACT_KEYBOARD });
        return;
      }

      if (text === "Показать карту") {
        await this.sendCard(guest, "Ваша карта KK23.");
        return;
      }

      if (text === "Баланс") {
        await ctx.reply(`Ваш PIN: ${guest.loyaltyCode}. Баланс: ${guest.balance} баллов.`);
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
          return;
        }

        await this.service.cancelSpend(pendingId);
        await ctx.answerCallbackQuery({ text: "Списание отменено" });
      } catch (error) {
        await ctx.answerCallbackQuery({
          text: error instanceof Error ? error.message : "Не удалось обработать запрос",
          show_alert: true,
        });
      }
    });
  }

  private async sendCard(guest: Guest, caption: string): Promise<void> {
    if (!guest.tgId) return;
    const image = await generateLoyaltyCard(guest);
    await this.bot.api.sendPhoto(guest.tgId, new InputFile(image, `kk23-${guest.loyaltyCode}.png`), { caption });
  }
}
