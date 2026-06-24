export type LoyaltyLevel = "guest" | "regular" | "own";

export type Guest = {
  id: string;
  phone: string;
  loyaltyCode: string;
  name: string;
  birthday: string | null;
  totalSpent: number;
  balance: number;
  level: LoyaltyLevel;
  lastVisit: string | null;
  tgId: string | null;
  tgHeaderMessageId: number | null;
  tgCardMessageId: number | null;
  tgHistoryMessageId: number | null;
  tgNotificationIds: number[];
  tgFlowMessageId: number | null;
  vkId: string | null;
  vkCardMessageId: number | null;
  notificationsEnabled: boolean;
  lastBirthdayRewardAt: string | null;
  cardUpdatedAt: string | null;
  createdAt: string;
};

export type TransactionType = "earn" | "spend" | "expire" | "gift";

export type Transaction = {
  id: string;
  guestId: string;
  type: TransactionType;
  amount: number;
  points: number;
  baristaId: string | null;
  createdAt: string;
};

export type PendingStatus = "pending" | "confirmed" | "cancelled" | "expired";

export type PendingTransaction = {
  id: string;
  guestId: string;
  points: number;
  status: PendingStatus;
  baristaId: string | null;
  tgMessageId: number | null;
  expiresAt: string;
  createdAt: string;
};

export type GuestRegistration = {
  phone: string;
  name: string;
  birthday?: string | null;
  tgId?: string | null;
  vkId?: string | null;
};
