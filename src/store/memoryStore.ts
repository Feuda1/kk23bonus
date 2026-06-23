import { randomUUID } from "node:crypto";
import { assertPositiveInteger, getLevel, normalizePhone } from "../domain/loyalty.js";
import type { Guest, GuestRegistration, PendingTransaction, Transaction } from "../domain/types.js";
import type { LoyaltyStore, SearchGuestInput } from "./store.js";

function nowIso(): string {
  return new Date().toISOString();
}

function makeCode(used: Set<string>): string {
  for (let i = 0; i < 10000; i += 1) {
    const code = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    if (!used.has(code)) return code;
  }
  throw new Error("No free loyalty PINs left");
}

export class MemoryStore implements LoyaltyStore {
  private guests = new Map<string, Guest>();
  private transactions = new Map<string, Transaction>();
  private pending = new Map<string, PendingTransaction>();
  private usedCodes = new Set<string>();

  async ensureReady(): Promise<void> {}

  async close(): Promise<void> {}

  async createOrUpdateGuest(input: GuestRegistration): Promise<Guest> {
    const phone = normalizePhone(input.phone);
    const tgId = input.tgId ?? null;
    const existing = [...this.guests.values()].find((guest) => guest.phone === phone || (tgId && guest.tgId === tgId));

    if (existing) {
      const updated: Guest = {
        ...existing,
        phone,
        name: input.name || existing.name,
        birthday: input.birthday ?? existing.birthday,
        tgId: tgId ?? existing.tgId,
      };
      this.guests.set(updated.id, updated);
      return updated;
    }

    const loyaltyCode = makeCode(this.usedCodes);
    this.usedCodes.add(loyaltyCode);
    const guest: Guest = {
      id: randomUUID(),
      phone,
      loyaltyCode,
      name: input.name,
      birthday: input.birthday ?? null,
      totalSpent: 0,
      balance: 0,
      level: "guest",
      lastVisit: null,
      tgId,
      tgCardMessageId: null,
      cardUpdatedAt: null,
      createdAt: nowIso(),
    };
    this.guests.set(guest.id, guest);
    return guest;
  }

  async getGuest(id: string): Promise<Guest | null> {
    return this.guests.get(id) ?? null;
  }

  async getGuestByTelegramId(tgId: string): Promise<Guest | null> {
    return [...this.guests.values()].find((guest) => guest.tgId === tgId) ?? null;
  }

  async searchGuest(input: SearchGuestInput): Promise<Guest | null> {
    const phone = input.phone ? normalizePhone(input.phone) : undefined;
    return (
      [...this.guests.values()].find((guest) => {
        if (input.loyaltyCode && guest.loyaltyCode === input.loyaltyCode) return true;
        if (phone && guest.phone === phone) return true;
        if (input.phoneLast4 && guest.phone.endsWith(input.phoneLast4)) return true;
        return false;
      }) ?? null
    );
  }

  async updateCardTimestamp(guestId: string): Promise<Guest> {
    const guest = await this.requireGuest(guestId);
    const updated = { ...guest, cardUpdatedAt: nowIso() };
    this.guests.set(updated.id, updated);
    return updated;
  }

  async updateTelegramCardMessage(guestId: string, messageId: number): Promise<Guest> {
    const guest = await this.requireGuest(guestId);
    const updated = { ...guest, tgCardMessageId: messageId };
    this.guests.set(updated.id, updated);
    return updated;
  }

  async earnPoints(input: { guestId: string; amount: number; points: number; baristaId?: string | null }): Promise<{ guest: Guest; transaction: Transaction }> {
    assertPositiveInteger(input.amount, "amount");
    if (!Number.isInteger(input.points) || input.points < 0) throw new Error("points must be a non-negative integer");
    const guest = await this.requireGuest(input.guestId);
    const nextTotalSpent = guest.totalSpent + input.amount;
    const updated: Guest = {
      ...guest,
      totalSpent: nextTotalSpent,
      balance: guest.balance + input.points,
      level: getLevel(nextTotalSpent),
      lastVisit: nowIso(),
      cardUpdatedAt: nowIso(),
    };
    const transaction = this.makeTransaction({
      guestId: guest.id,
      type: "earn",
      amount: input.amount,
      points: input.points,
      baristaId: input.baristaId ?? null,
    });
    this.guests.set(updated.id, updated);
    this.transactions.set(transaction.id, transaction);
    return { guest: updated, transaction };
  }

  async createPendingSpend(input: { guestId: string; points: number; baristaId?: string | null }): Promise<PendingTransaction> {
    assertPositiveInteger(input.points, "points");
    const guest = await this.requireGuest(input.guestId);
    if (guest.balance < input.points) throw new Error("Not enough points");
    const active = await this.getActivePendingForGuest(guest.id);
    if (active) throw new Error("Guest already has an active pending spend");

    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    const pending: PendingTransaction = {
      id: randomUUID(),
      guestId: guest.id,
      points: input.points,
      status: "pending",
      baristaId: input.baristaId ?? null,
      expiresAt,
      createdAt: nowIso(),
    };
    this.pending.set(pending.id, pending);
    return pending;
  }

  async getPending(id: string): Promise<PendingTransaction | null> {
    return this.pending.get(id) ?? null;
  }

  async getActivePendingForGuest(guestId: string): Promise<PendingTransaction | null> {
    await this.expirePendingTransactions();
    return [...this.pending.values()].find((pending) => pending.guestId === guestId && pending.status === "pending") ?? null;
  }

  async confirmPending(id: string): Promise<{ guest: Guest; pending: PendingTransaction; transaction: Transaction }> {
    await this.expirePendingTransactions();
    const pending = this.pending.get(id);
    if (!pending || pending.status !== "pending") throw new Error("Pending spend is not active");
    const guest = await this.requireGuest(pending.guestId);
    if (guest.balance < pending.points) throw new Error("Not enough points");

    const updatedGuest: Guest = {
      ...guest,
      balance: guest.balance - pending.points,
      lastVisit: nowIso(),
      cardUpdatedAt: nowIso(),
    };
    const updatedPending: PendingTransaction = { ...pending, status: "confirmed" };
    const transaction = this.makeTransaction({
      guestId: guest.id,
      type: "spend",
      amount: pending.points,
      points: -pending.points,
      baristaId: pending.baristaId,
    });
    this.guests.set(updatedGuest.id, updatedGuest);
    this.pending.set(updatedPending.id, updatedPending);
    this.transactions.set(transaction.id, transaction);
    return { guest: updatedGuest, pending: updatedPending, transaction };
  }

  async cancelPending(id: string): Promise<PendingTransaction> {
    const pending = this.pending.get(id);
    if (!pending || pending.status !== "pending") throw new Error("Pending spend is not active");
    const updated = { ...pending, status: "cancelled" as const };
    this.pending.set(updated.id, updated);
    return updated;
  }

  async expirePendingTransactions(): Promise<PendingTransaction[]> {
    const expired: PendingTransaction[] = [];
    const now = Date.now();
    for (const pending of this.pending.values()) {
      if (pending.status === "pending" && new Date(pending.expiresAt).getTime() <= now) {
        const updated = { ...pending, status: "expired" as const };
        this.pending.set(updated.id, updated);
        expired.push(updated);
      }
    }
    return expired;
  }

  async listTransactions(guestId: string, limit: number): Promise<Transaction[]> {
    return [...this.transactions.values()]
      .filter((transaction) => transaction.guestId === guestId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  private async requireGuest(id: string): Promise<Guest> {
    const guest = this.guests.get(id);
    if (!guest) throw new Error("Guest not found");
    return guest;
  }

  private makeTransaction(input: Omit<Transaction, "id" | "createdAt">): Transaction {
    return {
      id: randomUUID(),
      createdAt: nowIso(),
      ...input,
    };
  }
}
