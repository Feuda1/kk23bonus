import { randomInt } from "node:crypto";
import { generateLoyaltyCard } from "../card/generateCard.js";
import { LEVELS, normalizePhone } from "../domain/loyalty.js";
import type { Guest, PendingTransaction, Transaction } from "../domain/types.js";
import type { VkConfig } from "../config.js";
import type { LoyaltyService } from "../services/loyaltyService.js";
import type { LoyaltyNotifier } from "../services/notifier.js";

type VkCallbackResult = { status: number; text: string };
type VkPayload = Record<string, unknown>;
type VkMessage = {
  id?: number;
  peer_id?: number;
  from_id?: number;
  text?: string;
  payload?: string;
};
type VkCallbackPayload = {
  type?: string;
  group_id?: number | string;
  secret?: string;
  object?: {
    message?: VkMessage;
    payload?: unknown;
    user_id?: number;
    peer_id?: number;
  };
};
type VkKeyboardColor = "primary" | "secondary" | "positive" | "negative";
type VkButton = {
  action: {
    type: "text";
    label: string;
    payload: string;
  };
  color: VkKeyboardColor;
};
type VkKeyboard = {
  one_time: boolean;
  inline?: boolean;
  buttons: VkButton[][];
};
type VkApiEnvelope<T> = { response?: T; error?: { error_code: number; error_msg: string } };
type VkUploadServer = { upload_url: string };
type VkUploadedPhoto = { server?: number | string; photo?: string; hash?: string };
type VkSavedPhoto = { owner_id: number; id: number; access_key?: string };

const PHONE_PROMPT =
  "Напишите номер телефона одним сообщением, например +7 999 123-45-67. Так выпустим вашу карту KK23.";

export class VkLoyaltyBot implements LoyaltyNotifier {
  private readonly cardDeliveryQueue = new Map<string, Promise<void>>();
  private readonly messageQueue = new Map<string, Promise<void>>();
  private readonly cardCache = new Map<string, { signature: string; image: Buffer }>();

  constructor(
    private readonly config: VkConfig,
    private readonly service: LoyaltyService,
  ) {}

  async handleCallback(payload: unknown): Promise<VkCallbackResult> {
    const body = payload as VkCallbackPayload;
    if (body.type === "confirmation") {
      if (!this.isExpectedGroup(body.group_id)) return { status: 403, text: "invalid group" };
      return { status: 200, text: this.config.confirmationToken };
    }

    if (!this.isExpectedGroup(body.group_id)) return { status: 403, text: "invalid group" };
    if (body.secret !== this.config.secretKey) return { status: 403, text: "invalid secret" };

    void this.handleEvent(body).catch((error) => console.error("VK callback handling failed", error));
    return { status: 200, text: "ok" };
  }

  async guestRegistered(guest: Guest): Promise<void> {
    if (!guest.vkId) return;
    await this.deliverCard(guest);
  }

  async pointsEarned(guest: Guest, transaction: Transaction): Promise<void> {
    if (!guest.vkId) return;
    await this.deliverCard(guest);
    if (transaction.points > 0) {
      await this.sendMessage(Number(guest.vkId), earnNotificationText(transaction), mainKeyboard());
    }
  }

  async spendRequested(guest: Guest, pending: PendingTransaction): Promise<void> {
    if (!guest.vkId) return;
    await this.sendMessage(
      Number(guest.vkId),
      `Списываем ${pending.points} ${pluralPoints(pending.points)}? Это −${pending.points} ₽ к заказу.`,
      spendKeyboard(pending.id),
    );
  }

  async spendConfirmed(guest: Guest, transaction: Transaction): Promise<void> {
    if (!guest.vkId) return;
    await this.deliverCard(guest);
    await this.sendMessage(Number(guest.vkId), spendNotificationText(transaction), mainKeyboard());
  }

  async spendCancelled(guest: Guest, pending: PendingTransaction): Promise<void> {
    if (!guest.vkId) return;
    void pending;
  }

  async spendExpired(guest: Guest, pending: PendingTransaction): Promise<void> {
    if (!guest.vkId) return;
    await this.sendMessage(Number(guest.vkId), `Запрос на списание ${pending.points} ${pluralPoints(pending.points)} истёк.`, mainKeyboard());
  }

  async birthdayRewarded(guest: Guest, transaction: Transaction): Promise<void> {
    if (!guest.vkId) return;
    await this.deliverCard(guest);
    await this.sendMessage(Number(guest.vkId), giftNotificationText(transaction), mainKeyboard());
  }

  private async handleEvent(payload: VkCallbackPayload): Promise<void> {
    if (payload.type !== "message_new") return;
    const message = payload.object?.message;
    if (!message?.peer_id || !message.from_id || message.from_id <= 0) return;
    await this.enqueue(this.messageQueue, String(message.from_id), () => this.handleMessage(message));
  }

  private async handleMessage(message: VkMessage): Promise<void> {
    const peerId = message.peer_id;
    const vkId = message.from_id;
    if (!peerId || !vkId) return;

    const payload = parsePayload(message.payload);
    const text = (message.text ?? "").trim();
    const phone = extractRussianPhone(text);
    const guest = await this.service.getGuestByVkId(String(vkId));

    if (!guest) {
      if (phone) {
        const name = await this.getUserName(vkId);
        await this.service.registerGuest({ phone, name, vkId: String(vkId) });
        return;
      }
      await this.sendMessage(peerId, PHONE_PROMPT, phoneKeyboard());
      return;
    }

    const command = payload?.cmd;
    if (payload && (command === "spend_confirm" || command === "spend_cancel")) {
      await this.handleSpendCommand(peerId, guest, payload);
      return;
    }
    if (command === "history" || isHistoryText(text)) {
      await this.sendHistory(peerId, guest);
      return;
    }
    if (command === "settings" || isSettingsText(text)) {
      await this.sendSettings(peerId, guest);
      return;
    }
    if (command === "notif_on" || command === "notif_off") {
      const updated = await this.service.setNotificationsEnabled(guest.id, command === "notif_on");
      await this.sendSettings(peerId, updated);
      return;
    }
    if (command === "phone") {
      await this.sendMessage(peerId, PHONE_PROMPT, phoneKeyboard());
      return;
    }

    if (command === "card" || isCardText(text) || !command) {
      await this.service.touchCard(guest.id);
      const fresh = (await this.service.getGuest(guest.id)) ?? guest;
      await this.deliverCard(fresh);
    }
  }

  private async handleSpendCommand(peerId: number, guest: Guest, payload: VkPayload): Promise<void> {
    const pendingId = typeof payload.id === "string" ? payload.id : "";
    const pending = pendingId ? await this.service.getPending(pendingId) : null;
    if (!pending || pending.guestId !== guest.id) {
      await this.sendMessage(peerId, "Этот запрос на списание уже неактуален.", mainKeyboard());
      return;
    }

    try {
      if (payload.cmd === "spend_confirm") {
        await this.service.confirmSpend(pendingId);
      } else {
        await this.service.cancelSpend(pendingId);
        await this.sendMessage(peerId, "Окей, баллы остаются на карте.", mainKeyboard());
      }
    } catch (error) {
      await this.sendMessage(peerId, friendlySpendError(error), mainKeyboard());
    }
  }

  private async sendHistory(peerId: number, guest: Guest): Promise<void> {
    const transactions = await this.service.listTransactions(guest.id, 10);
    await this.sendMessage(peerId, makeHistoryText(transactions), mainKeyboard());
  }

  private async sendSettings(peerId: number, guest: Guest): Promise<void> {
    await this.sendMessage(peerId, settingsText(guest), settingsKeyboard(guest));
  }

  private async deliverCard(guest: Guest): Promise<void> {
    if (!guest.vkId) return;
    await this.enqueue(this.cardDeliveryQueue, guest.vkId, () => this.deliverCardUnlocked(guest));
  }

  private async deliverCardUnlocked(guest: Guest): Promise<void> {
    const latestGuest = (await this.service.getGuest(guest.id)) ?? guest;
    if (!latestGuest.vkId) return;
    const peerId = Number(latestGuest.vkId);

    if (latestGuest.vkCardMessageId) {
      await this.deleteMessage(latestGuest.vkCardMessageId);
      await this.service.updateVkCardMessage(latestGuest.id, null);
    }

    const caption = makeCardCaption(latestGuest);
    try {
      const signature = makeCardSignature(latestGuest);
      const cached = this.cardCache.get(latestGuest.id);
      const image = cached?.signature === signature ? cached.image : await generateLoyaltyCard(latestGuest);
      this.cardCache.set(latestGuest.id, { signature, image });
      const attachment = await this.uploadMessagePhoto(peerId, image);
      const messageId = await this.sendMessage(peerId, caption, mainKeyboard(), attachment);
      await this.service.updateVkCardMessage(latestGuest.id, messageId);
    } catch (error) {
      console.error("VK card image delivery failed", error);
      const messageId = await this.sendMessage(peerId, `${caption}\n\nКарта временно доступна текстом.`, mainKeyboard());
      await this.service.updateVkCardMessage(latestGuest.id, messageId);
    }
  }

  private async uploadMessagePhoto(peerId: number, image: Buffer): Promise<string> {
    const uploadServer = await this.api<VkUploadServer>("photos.getMessagesUploadServer", {
      peer_id: peerId,
      group_id: this.config.groupId,
    });
    const uploaded = await this.uploadPhoto(uploadServer.upload_url, image);
    if (!uploaded.server || !uploaded.photo || !uploaded.hash) {
      throw new Error("VK photo upload returned an unexpected payload");
    }
    const saved = await this.api<VkSavedPhoto[]>("photos.saveMessagesPhoto", {
      server: uploaded.server,
      photo: uploaded.photo,
      hash: uploaded.hash,
    });
    const photo = saved[0];
    if (!photo) throw new Error("VK did not save the uploaded photo");
    return `photo${photo.owner_id}_${photo.id}${photo.access_key ? `_${photo.access_key}` : ""}`;
  }

  private async uploadPhoto(uploadUrl: string, image: Buffer): Promise<VkUploadedPhoto> {
    let lastError: unknown;
    for (const field of ["file1", "photo"]) {
      try {
        const form = new FormData();
        const bytes = new Uint8Array(image.length);
        bytes.set(image);
        form.append(field, new Blob([bytes], { type: "image/png" }), "kk23-card.png");
        const response = await fetch(uploadUrl, { method: "POST", body: form });
        const data = (await response.json()) as VkUploadedPhoto & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `VK upload failed with ${response.status}`);
        return data;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("VK upload failed");
  }

  private async sendMessage(peerId: number, message: string, keyboard?: VkKeyboard, attachment?: string): Promise<number> {
    const response = await this.api<number>("messages.send", {
      peer_id: peerId,
      random_id: randomInt(1, 2_147_483_647),
      message,
      ...(attachment ? { attachment } : {}),
      ...(keyboard ? { keyboard: JSON.stringify(keyboard) } : {}),
    });
    return response;
  }

  private async deleteMessage(messageId: number): Promise<void> {
    try {
      await this.api("messages.delete", {
        message_ids: messageId,
        delete_for_all: 1,
      });
    } catch {}
  }

  private async getUserName(userId: number): Promise<string> {
    try {
      const users = await this.api<Array<{ first_name?: string }>>("users.get", { user_ids: userId });
      const firstName = users[0]?.first_name?.trim();
      return firstName || "Гость";
    } catch {
      return "Гость";
    }
  }

  private async api<T = unknown>(method: string, params: Record<string, string | number>): Promise<T> {
    const body = new URLSearchParams();
    body.set("access_token", this.config.accessToken);
    body.set("v", this.config.apiVersion);
    for (const [key, value] of Object.entries(params)) body.set(key, String(value));

    const response = await fetch(`https://api.vk.com/method/${method}`, { method: "POST", body });
    const data = (await response.json()) as VkApiEnvelope<T>;
    if (!response.ok) throw new Error(`VK API ${method} failed with HTTP ${response.status}`);
    if (data.error) throw new Error(`VK API ${method}: ${data.error.error_msg}`);
    if (data.response === undefined) throw new Error(`VK API ${method}: empty response`);
    return data.response;
  }

  private isExpectedGroup(groupId: unknown): boolean {
    return String(groupId ?? "") === this.config.groupId;
  }

  private enqueue(map: Map<string, Promise<void>>, key: string, fn: () => Promise<void>): Promise<void> {
    const previous = map.get(key)?.catch(() => undefined);
    const next = (previous ?? Promise.resolve()).then(fn);
    const queued = next.finally(() => {
      if (map.get(key) === queued) map.delete(key);
    });
    map.set(key, queued);
    return next;
  }
}

function button(label: string, color: VkKeyboardColor, payload: VkPayload): VkButton {
  return {
    action: { type: "text", label, payload: JSON.stringify(payload) },
    color,
  };
}

function keyboard(buttons: VkButton[][], inline = false): VkKeyboard {
  return { one_time: false, inline, buttons };
}

function phoneKeyboard(): VkKeyboard {
  return keyboard([[button("📱 Ввести телефон", "primary", { cmd: "phone" })]]);
}

function mainKeyboard(): VkKeyboard {
  return keyboard([
    [button("☕ Карта", "primary", { cmd: "card" }), button("🧾 История", "secondary", { cmd: "history" })],
    [button("⚙️ Настройки", "secondary", { cmd: "settings" })],
  ]);
}

function settingsKeyboard(guest: Guest): VkKeyboard {
  return keyboard([
    [
      guest.notificationsEnabled
        ? button("🔕 Выключить уведомления", "negative", { cmd: "notif_off" })
        : button("🔔 Включить уведомления", "positive", { cmd: "notif_on" }),
    ],
    [button("☕ Карта", "primary", { cmd: "card" })],
  ]);
}

function spendKeyboard(pendingId: string): VkKeyboard {
  return keyboard(
    [
      [
        button("✅ Да, списать", "positive", { cmd: "spend_confirm", id: pendingId }),
        button("✕ Нет", "negative", { cmd: "spend_cancel", id: pendingId }),
      ],
    ],
    true,
  );
}

function parsePayload(payload: string | undefined): VkPayload | undefined {
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as VkPayload) : undefined;
  } catch {
    return undefined;
  }
}

function extractRussianPhone(text: string): string | null {
  const normalized = normalizePhone(text);
  if (normalized.length === 11 && normalized.startsWith("7")) return normalized;
  if (normalized.length === 10 && normalized.startsWith("9")) return `7${normalized}`;
  return null;
}

function isCardText(text: string): boolean {
  const value = text.toLowerCase();
  return value.includes("карта") || value.includes("баланс") || value === "начать" || value === "start" || value === "/start";
}

function isHistoryText(text: string): boolean {
  return text.toLowerCase().includes("истор");
}

function isSettingsText(text: string): boolean {
  return text.toLowerCase().includes("настрой");
}

function makeCardCaption(guest: Guest): string {
  return [`☕ PIN: ${guest.loyaltyCode}`, `💰 Баланс: ${guest.balance} баллов`, `⭐ Уровень: ${LEVELS[guest.level].title}`].join("\n");
}

function makeCardSignature(guest: Guest): string {
  return [guest.loyaltyCode, guest.name, guest.balance, guest.level, guest.cardUpdatedAt ?? ""].join("|");
}

function earnNotificationText(transaction: Transaction): string {
  const points = transaction.points;
  return `➕ Пополнение +${points} ${pluralPoints(points)}\nЗа покупку на ${transaction.amount} ₽`;
}

function spendNotificationText(transaction: Transaction): string {
  const points = Math.abs(transaction.points);
  return `➖ Списание ${points} ${pluralPoints(points)}\nСкидка ${points} ₽`;
}

function giftNotificationText(transaction: Transaction): string {
  const points = transaction.points;
  return `🎁 Подарок на день рождения +${points} ${pluralPoints(points)}\nС днём рождения!`;
}

function settingsText(guest: Guest): string {
  return [
    "⚙️ Настройки KK23",
    "",
    `Имя: ${guest.name}`,
    `Уведомления: ${guest.notificationsEnabled ? "включены" : "выключены"}`,
  ].join("\n");
}

function makeHistoryText(transactions: Transaction[]): string {
  if (transactions.length === 0) return "🧾 История операций\n\nПока пусто.";
  const rows = transactions.map((transaction) => {
    const points = transaction.points;
    const signed = points > 0 ? `+${points}` : `−${Math.abs(points)}`;
    const type =
      transaction.type === "earn"
        ? "пополнение"
        : transaction.type === "spend"
          ? "списание"
          : transaction.type === "gift"
            ? "подарок"
            : "сгорание";
    return `${signed} ${pluralPoints(points)} · ${type}`;
  });
  return `🧾 История операций\n\n${rows.join("\n")}`;
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
    return "Кнопка уже неактуальна. Попросите бариста повторить запрос.";
  }
  if (message.includes("Not enough")) return "На балансе пока не хватает баллов.";
  return "Не получилось обработать запрос. Попробуйте ещё раз.";
}
