import type { Guest, PendingTransaction, Transaction } from "../domain/types.js";

export type LoyaltyNotifier = {
  guestRegistered(guest: Guest): Promise<void>;
  pointsEarned(guest: Guest, transaction: Transaction): Promise<void>;
  spendRequested(guest: Guest, pending: PendingTransaction): Promise<void>;
  spendConfirmed(guest: Guest, transaction: Transaction): Promise<void>;
  spendCancelled(guest: Guest, pending: PendingTransaction): Promise<void>;
  spendExpired(guest: Guest, pending: PendingTransaction): Promise<void>;
  birthdayRewarded(guest: Guest, transaction: Transaction): Promise<void>;
};

export class NoopNotifier implements LoyaltyNotifier {
  async guestRegistered(): Promise<void> {}
  async pointsEarned(): Promise<void> {}
  async spendRequested(): Promise<void> {}
  async spendConfirmed(): Promise<void> {}
  async spendCancelled(): Promise<void> {}
  async spendExpired(): Promise<void> {}
  async birthdayRewarded(): Promise<void> {}
}

export class CompositeNotifier implements LoyaltyNotifier {
  constructor(private readonly targets: LoyaltyNotifier[]) {}

  async guestRegistered(...args: Parameters<LoyaltyNotifier["guestRegistered"]>): Promise<void> {
    await this.call("guestRegistered", args);
  }

  async pointsEarned(...args: Parameters<LoyaltyNotifier["pointsEarned"]>): Promise<void> {
    await this.call("pointsEarned", args);
  }

  async spendRequested(...args: Parameters<LoyaltyNotifier["spendRequested"]>): Promise<void> {
    await this.call("spendRequested", args);
  }

  async spendConfirmed(...args: Parameters<LoyaltyNotifier["spendConfirmed"]>): Promise<void> {
    await this.call("spendConfirmed", args);
  }

  async spendCancelled(...args: Parameters<LoyaltyNotifier["spendCancelled"]>): Promise<void> {
    await this.call("spendCancelled", args);
  }

  async spendExpired(...args: Parameters<LoyaltyNotifier["spendExpired"]>): Promise<void> {
    await this.call("spendExpired", args);
  }

  async birthdayRewarded(...args: Parameters<LoyaltyNotifier["birthdayRewarded"]>): Promise<void> {
    await this.call("birthdayRewarded", args);
  }

  private async call<K extends keyof LoyaltyNotifier>(method: K, args: Parameters<LoyaltyNotifier[K]>): Promise<void> {
    const results = await Promise.allSettled(
      this.targets.map((target) => (target[method] as (...callArgs: Parameters<LoyaltyNotifier[K]>) => Promise<void>)(...args)),
    );
    for (const result of results) {
      if (result.status === "rejected") console.error("Notifier failed", result.reason);
    }
  }
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

  async spendExpired(...args: Parameters<LoyaltyNotifier["spendExpired"]>): Promise<void> {
    await this.target.spendExpired(...args);
  }

  async birthdayRewarded(...args: Parameters<LoyaltyNotifier["birthdayRewarded"]>): Promise<void> {
    await this.target.birthdayRewarded(...args);
  }
}
