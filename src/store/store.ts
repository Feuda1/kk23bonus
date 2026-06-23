import type { Guest, GuestRegistration, PendingTransaction, Transaction } from "../domain/types.js";

export type SearchGuestInput = {
  loyaltyCode?: string;
  phone?: string;
  phoneLast4?: string;
};

export type LoyaltyStore = {
  ensureReady(): Promise<void>;
  close(): Promise<void>;
  createOrUpdateGuest(input: GuestRegistration): Promise<Guest>;
  getGuest(id: string): Promise<Guest | null>;
  getGuestByTelegramId(tgId: string): Promise<Guest | null>;
  searchGuest(input: SearchGuestInput): Promise<Guest | null>;
  updateCardTimestamp(guestId: string): Promise<Guest>;
  updateTelegramCardMessage(guestId: string, messageId: number): Promise<Guest>;
  earnPoints(input: { guestId: string; amount: number; points: number; baristaId?: string | null }): Promise<{ guest: Guest; transaction: Transaction }>;
  createPendingSpend(input: { guestId: string; points: number; baristaId?: string | null }): Promise<PendingTransaction>;
  getPending(id: string): Promise<PendingTransaction | null>;
  getActivePendingForGuest(guestId: string): Promise<PendingTransaction | null>;
  confirmPending(id: string): Promise<{ guest: Guest; pending: PendingTransaction; transaction: Transaction }>;
  cancelPending(id: string): Promise<PendingTransaction>;
  expirePendingTransactions(): Promise<PendingTransaction[]>;
  listTransactions(guestId: string, limit: number): Promise<Transaction[]>;
};
