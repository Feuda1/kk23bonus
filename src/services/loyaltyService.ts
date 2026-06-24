import { calculateEarnedPoints, DEFAULT_BIRTHDAY_REWARD_POINTS, normalizePhone } from "../domain/loyalty.js";
import type { Guest, GuestRegistration, PendingTransaction, Transaction } from "../domain/types.js";
import type { LoyaltyStore, SearchGuestInput } from "../store/store.js";
import type { LoyaltyNotifier } from "./notifier.js";

export class LoyaltyService {
  constructor(
    private readonly store: LoyaltyStore,
    private readonly notifier: LoyaltyNotifier,
  ) {}

  async registerGuest(input: GuestRegistration): Promise<Guest> {
    const guest = await this.store.createOrUpdateGuest({
      ...input,
      phone: normalizePhone(input.phone),
    });
    await this.store.updateCardTimestamp(guest.id);
    const updated = await this.store.getGuest(guest.id);
    if (!updated) throw new Error("Guest not found after registration");
    await this.notifier.guestRegistered(updated);
    return updated;
  }

  async searchGuest(input: SearchGuestInput): Promise<Guest | null> {
    return this.store.searchGuest(input);
  }

  async getGuest(id: string): Promise<Guest | null> {
    return this.store.getGuest(id);
  }

  async getGuestByTelegramId(tgId: string): Promise<Guest | null> {
    return this.store.getGuestByTelegramId(tgId);
  }

  async getGuestByVkId(vkId: string): Promise<Guest | null> {
    return this.store.getGuestByVkId(vkId);
  }

  async updateTelegramCardMessage(guestId: string, messageId: number): Promise<Guest> {
    return this.store.updateTelegramCardMessage(guestId, messageId);
  }

  async updateTelegramHeaderMessage(guestId: string, messageId: number | null): Promise<Guest> {
    return this.store.updateTelegramHeaderMessage(guestId, messageId);
  }

  async updateTelegramHistoryMessage(guestId: string, messageId: number | null): Promise<Guest> {
    return this.store.updateTelegramHistoryMessage(guestId, messageId);
  }

  async updateVkCardMessage(guestId: string, messageId: number | null): Promise<Guest> {
    return this.store.updateVkCardMessage(guestId, messageId);
  }

  async pushNotificationMessage(guestId: string, messageId: number): Promise<Guest> {
    return this.store.pushNotificationMessage(guestId, messageId);
  }

  async clearNotificationMessages(guestId: string): Promise<Guest> {
    return this.store.clearNotificationMessages(guestId);
  }

  async updateFlowMessage(guestId: string, messageId: number | null): Promise<Guest> {
    return this.store.updateFlowMessage(guestId, messageId);
  }

  async updateGuestName(guestId: string, name: string): Promise<Guest> {
    return this.store.updateGuestName(guestId, name);
  }

  async updateGuestBirthday(guestId: string, birthday: string | null): Promise<Guest> {
    return this.store.updateGuestBirthday(guestId, birthday);
  }

  async setNotificationsEnabled(guestId: string, enabled: boolean): Promise<Guest> {
    return this.store.setNotificationsEnabled(guestId, enabled);
  }

  /**
   * Grants a birthday reward if the guest is eligible (it's their birthday and no reward was given in
   * the last ~year). The anti-abuse gate lives in the store transaction so concurrent calls can't
   * double-grant. Throws `birthday_reward_denied:<reason>` when not eligible.
   */
  async grantBirthdayReward(
    guestId: string,
    points: number = DEFAULT_BIRTHDAY_REWARD_POINTS,
    now: Date = new Date(),
  ): Promise<{ guest: Guest; transaction: Transaction }> {
    const result = await this.store.grantBirthdayReward(guestId, points, now);
    await this.notifier.birthdayRewarded(result.guest, result.transaction);
    return result;
  }

  /** Bumps the card's "updated at" so an explicit "Карта" tap visibly refreshes it. */
  async touchCard(guestId: string): Promise<Guest> {
    return this.store.updateCardTimestamp(guestId);
  }

  async earn(input: { guestId: string; amount: number; baristaId?: string | null }): Promise<{ guest: Guest; transaction: Transaction }> {
    const guest = await this.store.getGuest(input.guestId);
    if (!guest) throw new Error("Guest not found");
    const points = calculateEarnedPoints(input.amount, guest.level);
    const result = await this.store.earnPoints({ ...input, points });
    await this.notifier.pointsEarned(result.guest, result.transaction);
    return result;
  }

  async requestSpend(input: { guestId: string; points: number; baristaId?: string | null }): Promise<PendingTransaction> {
    const guest = await this.store.getGuest(input.guestId);
    if (!guest) throw new Error("Guest not found");
    if (!guest.tgId && !guest.vkId) throw new Error("Guest has no linked bot for spend confirmation");
    const pending = await this.store.createPendingSpend(input);
    await this.notifier.spendRequested(guest, pending);
    return pending;
  }

  async attachPendingMessage(pendingId: string, messageId: number): Promise<PendingTransaction> {
    return this.store.attachPendingMessage(pendingId, messageId);
  }

  /** Flips due pending spends to "expired" and notifies the guest. Call on a timer. */
  async expireDuePending(): Promise<void> {
    const expired = await this.store.expirePendingTransactions();
    for (const pending of expired) {
      const guest = await this.store.getGuest(pending.guestId);
      if (guest) await this.notifier.spendExpired(guest, pending);
    }
  }

  async confirmSpend(pendingId: string): Promise<{ guest: Guest; pending: PendingTransaction; transaction: Transaction }> {
    const result = await this.store.confirmPending(pendingId);
    await this.notifier.spendConfirmed(result.guest, result.transaction);
    return result;
  }

  async cancelSpend(pendingId: string): Promise<PendingTransaction> {
    const pending = await this.store.cancelPending(pendingId);
    const guest = await this.store.getGuest(pending.guestId);
    if (guest) await this.notifier.spendCancelled(guest, pending);
    return pending;
  }

  async getPending(id: string): Promise<PendingTransaction | null> {
    return this.store.getPending(id);
  }

  async listTransactions(guestId: string, limit = 10): Promise<Transaction[]> {
    return this.store.listTransactions(guestId, limit);
  }
}
