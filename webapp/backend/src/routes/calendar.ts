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

      // Icon lookup: every custom_events row for this guild, keyed by
      // name -- mirrors get_event_icon()'s per-name lookup, batched.
      const customEvents = await eventsDb
        .selectFrom("custom_events")
        .select(["name", "icon_url"])
        .where("guild_id", "=", guildId)
        .execute();
      const iconByEventType = new Map<string, string>();
      for (const ce of customEvents) {
        if (ce.name && looksLikeEmoji(ce.icon_url)) iconByEventType.set(ce.name, ce.icon_url!);
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
      const futureFormatted = formatEvents(expanded, "UTC", lookups).map((e, i) => ({
        id: `future-${expanded[i]!.notif.id}-${e.time.toISOString()}`,
        time: e.time.toISOString(),
        isPast: false,
        icon: e.icon,
        name: e.name,
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
        name: e.name,
        eventType: pastNotifs[i]!.eventType,
        channelId: e.channelId,
      }));

      const events = [...futureFormatted, ...pastFormatted].sort((a, b) => a.time.localeCompare(b.time));

      return { guildId, events };
    },
  );
}
