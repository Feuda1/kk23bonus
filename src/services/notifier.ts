import type { Guest, PendingTransaction, Transaction } from "../domain/types.js";

export type LoyaltyNotifier = {
  guestRegistered(guest: Guest): Promise<void>;
  pointsEarned(guest: Guest, transaction: Transaction): Promise<void>;
  spendRequested(guest: Guest, pending: PendingTransaction): Promise<void>;
  spendConfirmed(guest: Guest, transaction: Transaction): Promise<void>;
  spendCancelled(guest: Guest, pending: PendingTransaction): Promise<void>;
};

export class NoopNotifier implements LoyaltyNotifier {
  async guestRegistered(): Promise<void> {}
  async pointsEarned(): Promise<void> {}
  async spendRequested(): Promise<void> {}
  async spendConfirmed(): Promise<void> {}
  async spendCancelled(): Promise<void> {}
}

export class MutableNotifier implements LoyaltyNotifier {
  private target: LoyaltyNotifier = new NoopNotifier();

  setTarget(target: LoyaltyNotifier): void {
    this.target = target;
  }

  async guestRegistered(guest: Parameters<LoyaltyNotifier["guestRegistered"]>[0]): Promise<void> {
    await this.target.guestRegistered(guest);
  }

  async pointsEarned(...args: Parameters<LoyaltyNotifier["pointsEarned"]>): Promise<void> {
    await this.target.pointsEarned(...args);
  }

  async spendRequested(...args: Parameters<LoyaltyNotifier["spendRequested"]>): Promise<void> {
    await this.target.spendRequested(...args);
  }

  async spendConfirmed(...args: Parameters<LoyaltyNotifier["spendConfirmed"]>): Promise<void> {
    await this.target.spendConfirmed(...args);
  }

  async spendCancelled(...args: Parameters<LoyaltyNotifier["spendCancelled"]>): Promise<void> {
    await this.target.spendCancelled(...args);
  }
}
