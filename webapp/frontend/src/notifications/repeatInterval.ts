/**
 * Port of notification_system.py's RepeatIntervalModal unit math
 * (months/weeks/days/hours/minutes -> total_minutes). Note "months" here
 * is a flat 30-day approximation, exactly like the bot's own modal
 * (`months * 30 * 24 * 60`) -- NOT calendar-aware month math. True
 * calendar-month recurrence (day-of-month clamping across Jan 31 -> Feb
 * 28, etc.) only exists for Custom Events' repeat_minutes=-2 sentinel
 * (see notifications/nextOccurrence.ts). A plain notification's "1 month"
 * repeat will drift against the calendar day over time, same as it does
 * on the bot's own Discord wizard.
 */
export interface RepeatIntervalUnits {
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
}

const MINUTES_PER_MONTH = 30 * 24 * 60;
const MINUTES_PER_WEEK = 7 * 24 * 60;
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_HOUR = 60;

export function unitsToMinutes(u: RepeatIntervalUnits): number {
  return (
    u.months * MINUTES_PER_MONTH +
    u.weeks * MINUTES_PER_WEEK +
    u.days * MINUTES_PER_DAY +
    u.hours * MINUTES_PER_HOUR +
    u.minutes
  );
}

/** Greedy decomposition for editing/display -- not necessarily how the
 * value was originally entered, but mathematically equivalent. */
export function minutesToUnits(total: number): RepeatIntervalUnits {
  let remaining = Math.max(0, Math.floor(total));
  const months = Math.floor(remaining / MINUTES_PER_MONTH);
  remaining -= months * MINUTES_PER_MONTH;
  const weeks = Math.floor(remaining / MINUTES_PER_WEEK);
  remaining -= weeks * MINUTES_PER_WEEK;
  const days = Math.floor(remaining / MINUTES_PER_DAY);
  remaining -= days * MINUTES_PER_DAY;
  const hours = Math.floor(remaining / MINUTES_PER_HOUR);
  remaining -= hours * MINUTES_PER_HOUR;
  return { months, weeks, days, hours, minutes: remaining };
}

export function describeRepeatMinutes(total: number): string {
  if (total <= 0) return "0 minutes";
  const u = minutesToUnits(total);
  const parts: string[] = [];
  if (u.months > 0) parts.push(`${u.months} month${u.months > 1 ? "s" : ""}`);
  if (u.weeks > 0) parts.push(`${u.weeks} week${u.weeks > 1 ? "s" : ""}`);
  if (u.days > 0) parts.push(`${u.days} day${u.days > 1 ? "s" : ""}`);
  if (u.hours > 0) parts.push(`${u.hours} hour${u.hours > 1 ? "s" : ""}`);
  if (u.minutes > 0) parts.push(`${u.minutes} minute${u.minutes > 1 ? "s" : ""}`);
  if (parts.length === 0) return "0 minutes";
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
