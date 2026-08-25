/**
 * Member-facing calendar (new feature, not a port of anything in the
 * Python source -- the bot has no calendar view at all). Reuses the
 * expansion/formatting logic already built for the schedule board
 * preview (Stage 7g) against an arbitrary caller-specified date range
 * instead of the schedule board's fixed 30-day window, plus a
 * past-events view derived from notification_history that the schedule
 * board never touches.
 */

export interface CalendarHistoryRow {
  notificationId: number;
  notificationTime: number;
  sentAt: string;
}

export interface DedupedPastOccurrence {
  notificationId: number;
  time: Date;
}

/**
 * Collapses multiple reminder-sends (e.g. the 30/10/5/0-minutes-before
 * quartet from notification_type 1) for the same underlying occurrence
 * into one calendar entry. Groups by (notification_id, UTC calendar
 * date of sent_at) and keeps the row with the lowest notification_time
 * -- 0 ("at the time") is preferred as the canonical "this is when it
 * happened" marker, falling back to whatever offset was actually sent
 * if 0 was never one of them (e.g. notification_type 4's 5-minutes-
 * before-only preset).
 *
 * This is a simplification for a nice-to-have member view, not a
 * scheduling-correctness path like the rest of notifications/*.ts: a
 * genuinely high-frequency repeat (e.g. hourly) with multiple real
 * occurrences landing in history on the same UTC day would incorrectly
 * collapse into a single calendar entry. Accepted tradeoff -- the real
 * bot has no equivalent to be unfaithful to here.
 *
 * `rows[].sentAt` must already be normalized (see timezone.ts's
 * normalizeStoredUtcTimestamp) -- notification_history.sent_at is a
 * bare SQLite `DEFAULT CURRENT_TIMESTAMP` column with no offset suffix,
 * and constructing a Date from it unnormalized would silently apply
 * this SERVER process's local timezone instead of UTC.
 */
export function dedupePastOccurrences(rows: CalendarHistoryRow[]): DedupedPastOccurrence[] {
  const dateKeyOf = (sentAt: string) => sentAt.slice(0, 10);
  const groups = new Map<string, CalendarHistoryRow[]>();
  for (const row of rows) {
    const key = `${row.notificationId}|${dateKeyOf(row.sentAt)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const result: DedupedPastOccurrence[] = [];
  for (const groupRows of groups.values()) {
    const canonical = groupRows.reduce((best, r) => (r.notificationTime < best.notificationTime ? r : best));
    result.push({ notificationId: canonical.notificationId, time: new Date(canonical.sentAt) });
  }
  return result;
}
