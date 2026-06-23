import { calculateEarnedPoints, normalizePhone } from "../domain/loyalty.js";
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
    if (!guest.tgId) throw new Error("Guest has no Telegram link for spend confirmation");
    const pending = await this.store.createPendingSpend(input);
    await this.notifier.spendRequested(guest, pending);
    return pending;
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
