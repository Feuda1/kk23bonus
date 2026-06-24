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

// --- Birthday reward + anti-abuse ---------------------------------------------------------------

export const DEFAULT_BIRTHDAY_REWARD_POINTS = 200;
/**
 * Minimum days between two birthday rewards. A real birthday recurs every ~365 days, so a guest is
 * never blocked, but changing the saved date can't unlock a second reward within the same year — and
 * this rolling window also covers the year-boundary case a fixed calendar-year rule would miss.
 */
export const BIRTHDAY_REWARD_MIN_GAP_DAYS = 330;

const DAY_MS = 24 * 60 * 60 * 1000;

export type BirthdayRewardDenial = "no_birthday" | "not_birthday" | "already_claimed";

type BirthdayRewardState = { birthday: string | null; lastBirthdayRewardAt: string | null };

function mskParts(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** True if `now` (Moscow time) falls on the guest's birthday. Feb 29 is celebrated on Feb 28 in common years. */
export function isBirthdayToday(birthday: string, now: Date): boolean {
  const [, monthStr, dayStr] = birthday.split("-");
  const bMonth = Number(monthStr);
  const bDay = Number(dayStr);
  const today = mskParts(now);
  if (today.month === bMonth && today.day === bDay) return true;
  if (bMonth === 2 && bDay === 29 && today.month === 2 && today.day === 28 && !isLeapYear(today.year)) return true;
  return false;
}

/** Returns why a birthday reward cannot be granted right now, or null when the guest is eligible. */
export function birthdayRewardDenial(guest: BirthdayRewardState, now: Date): BirthdayRewardDenial | null {
  if (!guest.birthday) return "no_birthday";
  if (!isBirthdayToday(guest.birthday, now)) return "not_birthday";
  if (guest.lastBirthdayRewardAt) {
    const gapDays = (now.getTime() - new Date(guest.lastBirthdayRewardAt).getTime()) / DAY_MS;
    if (gapDays < BIRTHDAY_REWARD_MIN_GAP_DAYS) return "already_claimed";
  }
  return null;
}
