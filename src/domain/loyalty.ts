import type { LoyaltyLevel } from "./types.js";

export const LEVELS: Record<LoyaltyLevel, { title: string; threshold: number; cashback: number }> = {
  guest: { title: "Гость", threshold: 0, cashback: 0.05 },
  regular: { title: "Постоянный", threshold: 3000, cashback: 0.07 },
  own: { title: "Свой", threshold: 10000, cashback: 0.1 },
};

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) {
    return `7${digits.slice(1)}`;
  }
  return digits;
}

export function getLevel(totalSpent: number): LoyaltyLevel {
  if (totalSpent >= LEVELS.own.threshold) return "own";
  if (totalSpent >= LEVELS.regular.threshold) return "regular";
  return "guest";
}

export function calculateEarnedPoints(amountRub: number, level: LoyaltyLevel): number {
  return Math.floor(amountRub * LEVELS[level].cashback);
}

export function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}
