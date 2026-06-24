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
  getGuestByVkId(vkId: string): Promise<Guest | null>;
  searchGuest(input: SearchGuestInput): Promise<Guest | null>;
  updateCardTimestamp(guestId: string): Promise<Guest>;
  updateTelegramHeaderMessage(guestId: string, messageId: number | null): Promise<Guest>;
  updateTelegramCardMessage(guestId: string, messageId: number): Promise<Guest>;
  updateTelegramHistoryMessage(guestId: string, messageId: number | null): Promise<Guest>;
  updateVkCardMessage(guestId: string, messageId: number | null): Promise<Guest>;
  pushNotificationMessage(guestId: string, messageId: number): Promise<Guest>;
  clearNotificationMessages(guestId: string): Promise<Guest>;
  updateFlowMessage(guestId: string, messageId: number | null): Promise<Guest>;
  updateGuestName(guestId: string, name: string): Promise<Guest>;
  updateGuestBirthday(guestId: string, birthday: string | null): Promise<Guest>;
  setNotificationsEnabled(guestId: string, enabled: boolean): Promise<Guest>;
  grantBirthdayReward(guestId: string, points: number, now: Date): Promise<{ guest: Guest; transaction: Transaction }>;
  earnPoints(input: { guestId: string; amount: number; points: number; baristaId?: string | null }): Promise<{ guest: Guest; transaction: Transaction }>;
  createPendingSpend(input: { guestId: string; points: number; baristaId?: string | null }): Promise<PendingTransaction>;
  attachPendingMessage(pendingId: string, messageId: number): Promise<PendingTransaction>;
  getPending(id: string): Promise<PendingTransaction | null>;
  getActivePendingForGuest(guestId: string): Promise<PendingTransaction | null>;
  confirmPending(id: string): Promise<{ guest: Guest; pending: PendingTransaction; transaction: Transaction }>;
  cancelPending(id: string): Promise<PendingTransaction>;
  expirePendingTransactions(): Promise<PendingTransaction[]>;
  listTransactions(guestId: string, limit: number): Promise<Transaction[]>;
};
