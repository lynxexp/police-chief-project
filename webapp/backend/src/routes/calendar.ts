/**
 * Member-facing event calendar -- new feature (not a port; the bot has
 * no calendar view). Alliance-open, matching the same access rule as
 * roster/leaderboard/attendance in routes/member.ts: any member of the
 * alliance, or an admin with reach to it, can view it (canViewAlliance),
 * not just guild admins. Resolves the alliance's linked Discord server
 * internally and shows that guild's events -- reuses the same
 * expansion/formatting machinery built for the schedule board preview
 * (Stage 7g) against an arbitrary date range, plus a past-events view
 * derived from notification_history that the schedule board never
 * touches. See notifications/calendarEvents.ts's doc comment for the
 * past-event deduplication approach and its known limitation.
 */
import type { FastifyInstance } from "fastify";
import { eventsDb, allianceDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";
import { resolveAuthContext, canViewAlliance } from "../auth/context.js";
import { expandRepeatingEvents, formatEvents, type EventLookups, type ScheduleNotificationRow } from "../notifications/scheduleBoardPreview.js";
import { dedupePastOccurrences, type CalendarHistoryRow } from "../notifications/calendarEvents.js";
import { normalizeStoredUtcTimestamp, toNaiveSqliteTimestamp } from "../notifications/timezone.js";
import { calculateNextOccurrence } from "../notifications/nextOccurrence.js";

const allianceIdParam = {
  type: "object",
  required: ["allianceId"],
  properties: { allianceId: { type: "integer" } },
} as const;

const calendarQuerystring = {
  type: "object",
  required: ["rangeStart", "rangeEnd"],
  properties: {
    rangeStart: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
    rangeEnd: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
  },
} as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Bounds how wide a single request can ask for -- generous enough for
// a multi-month calendar view, well short of the expansion function's
// own per-notification safety cap.
const MAX_RANGE_DAYS = 120;
const DEFAULT_EVENT_ICON = "📅";

function looksLikeEmoji(value: string | null): boolean {
  if (!value) return false;
  if (value.startsWith("http://") || value.startsWith("https://")) return false;
  return value.length <= 8;
}

// Same order of magnitude as expandRepeatingEvents()'s own per-notification
// cap -- a calendar-only event has no notification row to bound this via,
// so it needs its own safety limit.
const MAX_SILENT_EVENT_OCCURRENCES = 500;

/** Enumerates every occurrence of a calendar-only (notifications disabled)
 * custom event within [rangeStart, rangeEnd], using the exact same
 * calendar-aware recurrence math as everything else that advances a
 * custom event's schedule -- there's no notification history to derive
 * past occurrences from, and no materialized notification to expand for
 * future ones, so this is computed directly instead. */
function expandSilentCustomEvent(
  firstOccurrence: Date,
  recurrenceType: string,
  recurrenceInterval: number,
  rangeStart: Date,
  rangeEnd: Date,
): Date[] {
  const occurrences: Date[] = [];
  let pointer = firstOccurrence > rangeStart ? firstOccurrence : rangeStart;
  for (let i = 0; i < MAX_SILENT_EVENT_OCCURRENCES; i++) {
    const next = calculateNextOccurrence(firstOccurrence, recurrenceType, recurrenceInterval, pointer);
    if (!next || next > rangeEnd) break;
    occurrences.push(next);
    pointer = new Date(next.getTime() + 1);
  }
  return occurrences;
}

export interface ComputedCalendarEvent {
  id: string;
  time: string;
  isPast: boolean;
  icon: string;
  name: string;
  eventType: string | null;
  channelId: string | null;
}

/** Everything routes/calendar.ts's GET handler used to do inline, minus
 * auth/range-validation -- pulled out so routes/calendarFeed.ts's .ics
 * feed can compute the exact same event set for a different (fixed,
 * wider) window without duplicating this logic. */
export async function computeCalendarEvents(
  allianceId: number,
  rangeStartUtc: Date,
  rangeEndUtc: Date,
): Promise<{ guildId: string | null; events: ComputedCalendarEvent[] }> {
  const alliance = await allianceDb
    .selectFrom("alliance_list")
    .select(snowflake("discord_server_id").as("discord_server_id"))
    .where("alliance_id", "=", allianceId)
    .executeTakeFirst();
  const guildId = alliance?.discord_server_id ?? null;
  if (!guildId) {
    return { guildId: null, events: [] };
  }

  const now = new Date();

  const rawRows = await eventsDb
    .selectFrom("vault_notifications")
    .select([
      "id", snowflake("channel_id").as("channel_id"), "hour", "minute", "timezone",
      "description", "notification_type", "next_notification", "is_enabled",
      "repeat_enabled", "repeat_minutes", "event_type",
    ])
    .where("guild_id", "=", guildId)
    .execute();

  const notifById = new Map<number, ScheduleNotificationRow>();
  const enabledWithSchedule: ScheduleNotificationRow[] = [];
  for (const r of rawRows) {
    if (r.next_notification === null) continue;
    const row: ScheduleNotificationRow = {
      id: r.id,
      channelId: r.channel_id!,
      hour: r.hour,
      minute: r.minute,
      timezone: r.timezone,
      description: r.description,
      notificationType: r.notification_type,
      nextNotification: r.next_notification,
      isEnabled: Boolean(r.is_enabled),
      repeatEnabled: Boolean(r.repeat_enabled),
      repeatMinutes: r.repeat_minutes,
      eventType: r.event_type,
    };
    notifById.set(r.id, row);
    if (row.isEnabled) enabledWithSchedule.push(row);
  }

  // Future occurrences: expand only enabled notifications -- a
  // disabled/paused reminder shouldn't appear on a member calendar
  // as if it were still going to fire.
  const weekdayIds = enabledWithSchedule.filter((n) => n.repeatMinutes === -1).map((n) => n.id);
  const weekdayRows =
    weekdayIds.length > 0
      ? await eventsDb.selectFrom("notification_days").select(["notification_id", "weekday"]).where("notification_id", "in", weekdayIds).execute()
      : [];
  const weekdayRowsByNotificationId = new Map<number, { weekday: string | null }[]>();
  for (const row of weekdayRows) {
    if (row.notification_id === null) continue;
    if (!weekdayRowsByNotificationId.has(row.notification_id)) weekdayRowsByNotificationId.set(row.notification_id, []);
    weekdayRowsByNotificationId.get(row.notification_id)!.push({ weekday: row.weekday });
  }

  const expanded = expandRepeatingEvents(enabledWithSchedule, weekdayRowsByNotificationId, now, true, rangeEndUtc).filter(
    (e) => e.time >= now && e.time >= rangeStartUtc && e.time <= rangeEndUtc,
  );

  // Past occurrences: notification_history, deduped per-day so a
  // notification_type 1's 30/10/5/0-minute quartet collapses to one
  // calendar entry -- see calendarEvents.ts's doc comment.
  const historyRaw = await eventsDb
    .selectFrom("notification_history as h")
    .innerJoin("vault_notifications as n", "n.id", "h.notification_id")
    .select(["h.notification_id", "h.notification_time", "h.sent_at"])
    .where("n.guild_id", "=", guildId)
    .where("h.sent_at", ">=", toNaiveSqliteTimestamp(rangeStartUtc))
    .where("h.sent_at", "<=", toNaiveSqliteTimestamp(rangeEndUtc))
    .execute();
  const historyRows: CalendarHistoryRow[] = historyRaw
    .filter((r) => r.sent_at !== null)
    .map((r) => ({
      notificationId: r.notification_id,
      notificationTime: r.notification_time,
      sentAt: normalizeStoredUtcTimestamp(r.sent_at!),
    }));
  const pastOccurrences = dedupePastOccurrences(historyRows).filter(
    (o) => o.time >= rangeStartUtc && o.time <= rangeEndUtc && notifById.has(o.notificationId),
  );

  // Every custom_events row for this guild -- icon lookup (mirrors
  // get_event_icon()'s per-name lookup, batched) and, for the
  // notifications-disabled ones, the source of their calendar
  // occurrences (computed directly, see expandSilentCustomEvent()).
  const customEvents = await eventsDb
    .selectFrom("custom_events")
    .select([
      "id", "name", "icon_url", "first_occurrence", "recurrence_type",
      "recurrence_interval", "notifications_enabled",
    ])
    .where("guild_id", "=", guildId)
    .execute();
  const iconByEventType = new Map<string, string>();
  for (const ce of customEvents) {
    if (ce.name && looksLikeEmoji(ce.icon_url)) iconByEventType.set(ce.name, ce.icon_url!);
  }

  const silentFormatted: ComputedCalendarEvent[] = [];
  for (const ce of customEvents) {
    if (ce.notifications_enabled !== 0 || !ce.first_occurrence || !ce.recurrence_type) continue;
    const occurrences = expandSilentCustomEvent(
      new Date(ce.first_occurrence), ce.recurrence_type, ce.recurrence_interval ?? 1, rangeStartUtc, rangeEndUtc,
    );
    const icon = ce.name && looksLikeEmoji(ce.icon_url) ? ce.icon_url! : DEFAULT_EVENT_ICON;
    for (const time of occurrences) {
      silentFormatted.push({
        id: `silent-${ce.id}-${time.toISOString()}`,
        time: time.toISOString(),
        isPast: time < now,
        icon,
        name: ce.name ?? "Custom",
        eventType: ce.name,
        channelId: null,
      });
    }
  }

  // Embed titles, batched for every EMBED_MESSAGE: notification
  // appearing in either the future or past sets.
  const candidateIds = new Set<number>();
  for (const e of expanded) if (e.notif.description.includes("EMBED_MESSAGE:")) candidateIds.add(e.notif.id);
  for (const o of pastOccurrences) {
    const notif = notifById.get(o.notificationId)!;
    if (notif.description.includes("EMBED_MESSAGE:")) candidateIds.add(notif.id);
  }
  const embedTitleByNotificationId = new Map<number, string | null>();
  if (candidateIds.size > 0) {
    const embedRows = await eventsDb
      .selectFrom("vault_notification_embeds")
      .select(["notification_id", "title"])
      .where("notification_id", "in", [...candidateIds])
      .execute();
    for (const row of embedRows) embedTitleByNotificationId.set(row.notification_id, row.title);
  }

  const lookups: EventLookups = { iconByEventType, embedTitleByNotificationId, defaultIcon: DEFAULT_EVENT_ICON };

  // formatEvents() returns one output per input, in the same order
  // -- zip by index rather than re-matching on (time, channel),
  // which could collide if two distinct events land on the exact
  // same instant in the same channel.
  // formatEvents()'s `name` reproduces the notification's literal
  // message template (e.g. "**Vault Trap 1** starts in !", %t blanked
  // the same way a live schedule board blanks it) -- appropriate for
  // that board, but a nonsensical label on a plain per-day calendar
  // list. Prefer the event's real name (event_type) for a plain-text
  // message; an embed's title is admin-curated content in its own
  // right, so that one's left as formatEvents() extracted it.
  const calendarName = (notif: ScheduleNotificationRow, extracted: string): string =>
    !notif.description.includes("EMBED_MESSAGE:") && notif.eventType ? notif.eventType : extracted;

  const futureFormatted = formatEvents(expanded, "UTC", lookups).map((e, i) => ({
    id: `future-${expanded[i]!.notif.id}-${e.time.toISOString()}`,
    time: e.time.toISOString(),
    isPast: false,
    icon: e.icon,
    name: calendarName(expanded[i]!.notif, e.name),
    eventType: expanded[i]!.notif.eventType,
    channelId: e.channelId,
  }));

  const pastNotifs = pastOccurrences.map((o) => notifById.get(o.notificationId)!);
  const pastFormatted = formatEvents(
    pastOccurrences.map((o, i) => ({ time: o.time, notif: pastNotifs[i]! })),
    "UTC",
    lookups,
  ).map((e, i) => ({
    id: `past-${pastOccurrences[i]!.notificationId}-${e.time.toISOString()}`,
    time: e.time.toISOString(),
    isPast: true,
    icon: e.icon,
    name: calendarName(pastNotifs[i]!, e.name),
    eventType: pastNotifs[i]!.eventType,
    channelId: e.channelId,
  }));

  const events = [...futureFormatted, ...pastFormatted, ...silentFormatted].sort((a, b) => a.time.localeCompare(b.time));

  return { guildId, events };
}

export default async function calendarRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get<{ Params: { allianceId: number }; Querystring: { rangeStart: string; rangeEnd: string } }>(
    "/alliance/:allianceId/calendar",
    { schema: { params: allianceIdParam, querystring: calendarQuerystring } },
    async (request, reply) => {
      const { allianceId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canViewAlliance(ctx, allianceId))) {
        return reply.code(403).send({ error: "not_alliance_member" });
      }

      const { rangeStart, rangeEnd } = request.query;
      if (rangeEnd < rangeStart) {
        return reply.code(400).send({ error: "invalid_range" });
      }
      // Buffer a day on each side of the naive UTC interpretation of the
      // requested dates -- the browser's local calendar day (which is
      // what the requester actually means by "this range") can sit up
      // to ~14 hours off of UTC in either direction.
      const rangeStartUtc = new Date(new Date(`${rangeStart}T00:00:00Z`).getTime() - MS_PER_DAY);
      const rangeEndUtc = new Date(new Date(`${rangeEnd}T23:59:59Z`).getTime() + MS_PER_DAY);
      if (rangeEndUtc.getTime() - rangeStartUtc.getTime() > (MAX_RANGE_DAYS + 2) * MS_PER_DAY) {
        return reply.code(400).send({ error: "range_too_wide" });
      }

      return computeCalendarEvents(allianceId, rangeStartUtc, rangeEndUtc);
    },
  );
}
