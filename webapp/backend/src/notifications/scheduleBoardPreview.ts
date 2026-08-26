/**
 * Ports cogs/notification_schedule.py's `_generate_schedule_embed_internal()`
 * / `_format_event_line()` -- the bucketing + 30-day repeat expansion +
 * per-event display logic behind a schedule board's posted embed. Pure
 * functions only; DB fetching (vault_notifications, notification_days,
 * custom_events icons, vault_notification_embeds titles) happens in
 * routes/scheduleBoards.ts and is handed in as plain data.
 *
 * This is read-only preview support (Stage 7g) -- see the plan doc's
 * decision to skip board CRUD entirely: every board mutation
 * (create/edit/move/delete) requires synchronously posting/editing/
 * deleting a real Discord message, which this webapp has no mechanism
 * for (see routes/scheduleBoards.ts's doc comment for the full
 * reasoning). The bucketing/formatting logic ported here has no such
 * constraint -- it's pure computation over already-existing
 * vault_notifications rows, safe to expose as a live preview tool.
 *
 * Deliberately preserves a known quirk in the source rather than "fixing"
 * it, per the plan's port-exactly policy for schedule/date math: monthly
 * custom-event notifications (repeat_minutes == -2) are NEVER expanded
 * here (only > 0 and == -1 are), so they only ever show their single next
 * occurrence -- faithful to _format_event_line()'s actual code, not an
 * oversight in this port.
 */
import { parseWeekdayRows } from "./weekdays.js";
import { scheduleTimezoneOffsetMinutes } from "./timezone.js";

export interface ScheduleNotificationRow {
  id: number;
  channelId: string;
  hour: number;
  minute: number;
  timezone: string;
  description: string;
  notificationType: number;
  nextNotification: string;
  isEnabled: boolean;
  repeatEnabled: boolean;
  repeatMinutes: number | null;
  eventType: string | null;
}

interface ExpandedEvent {
  time: Date;
  notif: ScheduleNotificationRow;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Localizes a Y-M-D calendar date + hour:minute wall-clock time in
 * `timeZone` to its UTC instant -- same guess-then-resolve-offset
 * approach as timezone.ts's localizedIsoString, reused here for weekday
 * occurrence expansion instead of notification creation. */
function localizeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = scheduleTimezoneOffsetMinutes(timeZone, guess);
  return new Date(guess.getTime() - offset * MS_PER_MINUTE);
}

/** Y-M-D calendar date (and Python-convention weekday, Monday=0) that
 * `date` reads as when displayed in `timeZone`. */
function calendarDateInTimezone(date: Date, timeZone: string): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const jsWeekday = weekdayNames.indexOf(map.weekday!); // 0=Sunday
  const pythonWeekday = (jsWeekday + 6) % 7; // 0=Monday
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), weekday: pythonWeekday };
}

/** Hard ceiling on occurrences expanded per notification, independent of
 * the requested date window -- protects against a pathological
 * low-interval repeat (e.g. repeat_minutes=1) generating an unbounded
 * number of rows when a caller asks for a wide window (the calendar
 * feature can request months at a time, unlike the schedule board's
 * fixed 30-day window). */
const MAX_OCCURRENCES_PER_NOTIFICATION = 500;

/**
 * Expands each notification's single next_notification into every
 * occurrence up to `windowEnd`, when repeating -- mirrors the expansion
 * loop in _generate_schedule_embed_internal() exactly, including which
 * repeat_minutes values get expanded at all (> 0 and -1 only; -2
 * monthly custom events are NOT expanded here, matching the source).
 * The source hardcodes `windowEnd` to "now + 30 days"; that's still
 * exactly what routes/scheduleBoards.ts passes, so its behavior is
 * unchanged -- `windowEnd` was generalized only so routes/calendar.ts
 * (a new, non-ported feature) can request an arbitrary range.
 */
export function expandRepeatingEvents(
  notifications: ScheduleNotificationRow[],
  weekdayRowsByNotificationId: Map<number, { weekday: string | null }[]>,
  now: Date,
  showRepeatingEvents: boolean,
  windowEnd: Date,
): ExpandedEvent[] {
  const expanded: ExpandedEvent[] = [];

  for (const notif of notifications) {
    const nextTime = new Date(notif.nextNotification);
    expanded.push({ time: nextTime, notif });

    if (!showRepeatingEvents || !notif.repeatEnabled) continue;

    if (typeof notif.repeatMinutes === "number" && notif.repeatMinutes > 0) {
      let current = nextTime;
      for (let count = 0; count < MAX_OCCURRENCES_PER_NOTIFICATION; count++) {
        current = new Date(current.getTime() + notif.repeatMinutes * MS_PER_MINUTE);
        if (current > windowEnd) break;
        expanded.push({ time: current, notif: { ...notif, nextNotification: current.toISOString() } });
      }
    } else if (notif.repeatMinutes === -1) {
      const rows = weekdayRowsByNotificationId.get(notif.id) ?? [];
      const days = new Set(parseWeekdayRows(rows));
      if (days.size === 0) continue;

      const { year, month, day } = calendarDateInTimezone(nextTime, notif.timezone);
      const currentDate = new Date(Date.UTC(year, month - 1, day));

      let occurrences = 0;
      for (let dayOffset = 1; occurrences < MAX_OCCURRENCES_PER_NOTIFICATION; dayOffset++) {
        const checkDate = new Date(currentDate.getTime() + dayOffset * MS_PER_DAY);
        // Not a premature-exit optimization on checkDate itself: it's
        // UTC midnight of the candidate calendar day, which can sit on
        // either side of windowEnd relative to the ACTUAL localized
        // instant for a non-UTC timezone. Only the authoritative check
        // below (after localizing to notif.timezone) decides whether to
        // stop -- this loop keeps going until that check trips or the
        // iteration cap is hit, so it never breaks early by mistake.
        const checkWeekday = (checkDate.getUTCDay() + 6) % 7; // Monday=0
        if (!days.has(checkWeekday)) continue;

        const occurrenceUtc = localizeToUtc(
          checkDate.getUTCFullYear(),
          checkDate.getUTCMonth() + 1,
          checkDate.getUTCDate(),
          notif.hour,
          notif.minute,
          notif.timezone,
        );
        if (occurrenceUtc > windowEnd) break;
        expanded.push({ time: occurrenceUtc, notif: { ...notif, nextNotification: occurrenceUtc.toISOString() } });
        occurrences++;
      }
    }
  }

  expanded.sort((a, b) => a.time.getTime() - b.time.getTime());
  return expanded;
}

export type BucketKey = "imminent" | "soon" | "upcoming" | "thisWeek" | "nextWeek" | "later";
export const BUCKET_ORDER: BucketKey[] = ["imminent", "soon", "upcoming", "thisWeek", "nextWeek", "later"];

/** Which urgency bucket an event falls into relative to `now` -- exact
 * thresholds from _generate_schedule_embed_internal(). */
export function bucketFor(eventTime: Date, now: Date): BucketKey {
  const hoursUntil = (eventTime.getTime() - now.getTime()) / (60 * 60 * 1000);
  const daysUntil = hoursUntil / 24;
  if (hoursUntil < 1) return "imminent";
  if (hoursUntil < 6) return "soon";
  if (hoursUntil < 24) return "upcoming";
  if (daysUntil < 7) return "thisWeek";
  if (daysUntil < 14) return "nextWeek";
  return "later";
}

export interface EventLookups {
  /** event_type name -> icon (already resolved via the same
   * _looks_like_emoji fallback as elsewhere), for events with one. */
  iconByEventType: Map<string, string>;
  /** notification id -> its linked embed's title, for EMBED_MESSAGE:
   * descriptions only. */
  embedTitleByNotificationId: Map<number, string | null>;
  defaultIcon: string;
}

export interface FormattedEvent {
  time: Date;
  timeLabel: string;
  icon: string;
  name: string;
  channelId: string;
  isEnabled: boolean;
}

/**
 * Extracts the display name for one event line -- mirrors
 * _format_event_line()'s name-extraction branches exactly. A
 * CUSTOM_TIMES-encoded description (every custom event's) is unwrapped
 * first, matching the same idiom used at send time (process_notification)
 * and in _format_paused_line() -- this used to be a gap faithfully ported
 * from the source (which fell into the generic 30-char-truncate branch and
 * showed raw "CUSTOM_TIMES:N-N|" encoding for every custom event on a real
 * schedule board), fixed in both places together. PLAIN_MESSAGE: is
 * likewise never stripped here (only recognized as a substring below) --
 * that one gap is intentionally preserved, matching the actual embed a
 * real board would post.
 */
function extractEventName(notif: ScheduleNotificationRow, lookups: EventLookups, eventTimeInTz: Date): string {
  let { description } = notif;
  const { eventType } = notif;
  const emoji = eventType ? (lookups.iconByEventType.get(eventType) ?? lookups.defaultIcon) : lookups.defaultIcon;
  const eventName = eventType || "Event";
  const eventTimeStr = `${String(eventTimeInTz.getUTCHours()).padStart(2, "0")}:${String(eventTimeInTz.getUTCMinutes()).padStart(2, "0")}`;
  const eventDateStr = eventTimeInTz.toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });

  if (description.startsWith("CUSTOM_TIMES:")) {
    // indexOf, not split("|", n) -- JS's split(sep, limit) truncates the
    // full split rather than stopping after the first separator like
    // Python's str.split(sep, 1), so it would silently drop the remainder
    // of a message that itself contains a "|" (see description.ts's
    // splitOnFirst for the same gotcha).
    const pipeIdx = description.indexOf("|");
    description = pipeIdx === -1 ? "" : description.slice(pipeIdx + 1);
  }

  let name: string;
  if (description.includes("EMBED_MESSAGE:")) {
    name = lookups.embedTitleByNotificationId.get(notif.id) || "Event";
  } else if (description.includes("PLAIN_MESSAGE:")) {
    const afterPrefix = description.split("PLAIN_MESSAGE:").at(-1)!.split("|")[0]!.trim();
    name = afterPrefix.length > 30 ? `${afterPrefix.slice(0, 27)}...` : afterPrefix;
  } else {
    name = description.length > 30 ? description.slice(0, 30) : description;
  }

  name = name
    .replaceAll("%i", emoji)
    .replaceAll("%n", eventName)
    .replaceAll("%e", eventTimeStr)
    .replaceAll("%d", eventDateStr)
    .replaceAll("%t", "")
    .replaceAll("{time}", "")
    .replaceAll("{tag}", "")
    .replaceAll("@tag", "");
  while (name.includes("  ")) name = name.replaceAll("  ", " ");
  name = name.trim();
  if (name.endsWith(" Notification")) name = name.slice(0, -" Notification".length);

  return name;
}

/** One formatted line per event, matching _format_event_line() (minus
 * the show_channel/[DISABLED] suffix logic, which the frontend renders
 * from the structured fields instead of appending to the string). */
export function formatEvents(events: ExpandedEvent[], displayTimezone: string, lookups: EventLookups): FormattedEvent[] {
  return events.map(({ time, notif }) => {
    const offset = scheduleTimezoneOffsetMinutes(displayTimezone, time);
    const inTz = new Date(time.getTime() + offset * MS_PER_MINUTE);
    const timeLabel = `${String(inTz.getUTCHours()).padStart(2, "0")}:${String(inTz.getUTCMinutes()).padStart(2, "0")}`;
    const icon = notif.eventType ? (lookups.iconByEventType.get(notif.eventType) ?? lookups.defaultIcon) : lookups.defaultIcon;
    return {
      time,
      timeLabel,
      icon,
      name: extractEventName(notif, lookups, inTz),
      channelId: notif.channelId,
      isEnabled: notif.isEnabled,
    };
  });
}

export interface DayGroup {
  /** ISO date (YYYY-MM-DD) in the display timezone, for the frontend to
   * format however it likes. */
  date: string;
  events: FormattedEvent[];
}

/** Groups already-bucketed, already-formatted events by calendar date
 * in the display timezone, sorted ascending -- mirrors
 * format_section_with_days()'s day grouping (the actual heading text
 * formatting is left to the frontend). */
export function groupByDay(events: FormattedEvent[], displayTimezone: string): DayGroup[] {
  const groups = new Map<string, FormattedEvent[]>();
  for (const event of events) {
    const offset = scheduleTimezoneOffsetMinutes(displayTimezone, event.time);
    const inTz = new Date(event.time.getTime() + offset * MS_PER_MINUTE);
    const dateKey = inTz.toISOString().slice(0, 10);
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey)!.push(event);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, dayEvents]) => ({ date, events: dayEvents }));
}

/** Embed color mirroring the "nearest urgency present" rule in
 * _generate_schedule_embed_internal(). */
export function colorForSections(sections: Record<BucketKey, unknown[]>): number {
  if (sections.imminent.length > 0) return 0xff0000;
  if (sections.soon.length > 0) return 0xff8c00;
  if (sections.upcoming.length > 0) return 0x00ff00;
  return 0x0080ff;
}
