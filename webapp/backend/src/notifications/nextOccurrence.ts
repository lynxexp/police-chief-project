/**
 * Line-by-line port of cogs/notification_schedule.py's
 * calculate_next_occurrence() and its _shift_months() helper. Pure date
 * math, no I/O -- this is the single highest-value "port exactly, don't
 * reinvent" piece in the whole Phase 2 plan (per the plan doc): get the
 * daily/weekly cycle-counting or the monthly day-clamping wrong and a
 * custom event's next occurrence is silently off, with nothing anywhere
 * surfacing that as an error.
 *
 * All Date arithmetic here is done in UTC millisecond epoch math
 * (first_occurrence/from_date are always UTC-aware timestamps on the
 * Python side too -- see the docstring's "timezone-aware, UTC"), so
 * there's no local-timezone drift to account for.
 */
export type RecurrenceType = "daily" | "weekly" | "monthly";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Add `months` calendar months to `date`, clamping the day to the
 * target month's actual length (e.g. Jan 31 + 1 month -> Feb 28/29, not
 * Mar 3) -- mirrors _shift_months() exactly. */
function shiftMonths(date: Date, months: number): Date {
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12; // JS % can return negative; Python's // always floors
  const daysInTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), daysInTargetMonth);
  const result = new Date(date.getTime());
  result.setUTCFullYear(year, month, day);
  return result;
}

/** Whole days between two dates, matching Python's `(from_date -
 * first_occurrence).days` -- floor division on total seconds, not a
 * calendar-day count (so DST-observing local times would differ, but
 * everything here is UTC, so this is exact). */
function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * Next occurrence at or after `fromDate` (defaults to now). Returns null
 * for an unrecognized recurrence type, matching the Python function's
 * `return None`.
 */
export function calculateNextOccurrence(
  firstOccurrence: Date,
  recurrenceType: string,
  recurrenceInterval: number,
  fromDate: Date = new Date(),
): Date | null {
  const interval = recurrenceInterval && recurrenceInterval >= 1 ? recurrenceInterval : 1;

  if (firstOccurrence.getTime() >= fromDate.getTime()) {
    return firstOccurrence;
  }

  if (recurrenceType === "daily") {
    const daysDiff = daysBetween(firstOccurrence, fromDate);
    const cyclesPassed = Math.floor(daysDiff / interval);
    let next = new Date(firstOccurrence.getTime() + cyclesPassed * interval * MS_PER_DAY);
    while (next.getTime() < fromDate.getTime()) {
      next = new Date(next.getTime() + interval * MS_PER_DAY);
    }
    return next;
  }

  if (recurrenceType === "weekly") {
    const cycleDays = interval * 7;
    const daysDiff = daysBetween(firstOccurrence, fromDate);
    const cyclesPassed = Math.floor(daysDiff / cycleDays);
    let next = new Date(firstOccurrence.getTime() + cyclesPassed * cycleDays * MS_PER_DAY);
    while (next.getTime() < fromDate.getTime()) {
      next = new Date(next.getTime() + cycleDays * MS_PER_DAY);
    }
    return next;
  }

  if (recurrenceType === "monthly") {
    const monthsDiff =
      (fromDate.getUTCFullYear() - firstOccurrence.getUTCFullYear()) * 12 +
      (fromDate.getUTCMonth() - firstOccurrence.getUTCMonth());
    let cyclesPassed = Math.max(0, Math.floor(monthsDiff / interval));
    let next = shiftMonths(firstOccurrence, cyclesPassed * interval);
    while (next.getTime() < fromDate.getTime()) {
      cyclesPassed += interval;
      next = shiftMonths(firstOccurrence, cyclesPassed);
    }
    return next;
  }

  return null;
}
