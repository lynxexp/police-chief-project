/**
 * notification_days.weekday encoding for repeat_minutes == -1 (specific
 * weekdays). Mirrors save_notification_fixed() exactly: ONE row per
 * notification (not one row per day), holding every selected weekday as
 * a pipe-joined, ascending-sorted list of Python .weekday() integers
 * (Monday=0 ... Sunday=6) -- see cogs/notification_system.py's
 * DaysMenu/ConfirmDaysButton (`weekdays_index`) and
 * save_notification_fixed()'s `"|".join(str(d) for d in sorted_days))`.
 */

export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** Parses one or more notification_days rows into the set of selected
 * weekday integers. In practice there's always at most one row (create
 * and edit both DELETE-then-INSERT a single row), but this tolerates
 * multiple defensively rather than assuming that invariant holds. */
export function parseWeekdayRows(rows: { weekday: string | null }[]): number[] {
  const days = new Set<number>();
  for (const row of rows) {
    if (!row.weekday) continue;
    for (const part of row.weekday.split("|")) {
      if (part === "") continue;
      const n = parseInt(part, 10);
      if (!Number.isNaN(n)) days.add(n);
    }
  }
  return [...days].sort((a, b) => a - b);
}

/** Builds the single stored row's value from selected weekday integers
 * -- mirrors save_notification_fixed()'s `sorted_days` + "|".join(). */
export function encodeWeekdays(days: number[]): string {
  return [...days].sort((a, b) => a - b).join("|");
}

export function weekdayName(day: number): string {
  return WEEKDAY_NAMES[day] ?? `Day ${day}`;
}
