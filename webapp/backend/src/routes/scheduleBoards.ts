/**
 * Schedule boards -- Phase 2, Stage 7g. Read-only by deliberate choice
 * (confirmed with the user): unlike every other notifications sub-stage,
 * a schedule board's DB row is meaningless without an already-posted,
 * pinned Discord message -- cogs/notification_schedule.py's
 * create_schedule_board()/delete_schedule_board()/move_schedule_board()
 * each synchronously post, pin, edit, or delete the real message as
 * part of the same operation, and update_schedule_board() (run by the
 * bot's own daily refresh loop) auto-DELETES any board whose message_id
 * no longer resolves. A DB-only "create" from the web wouldn't just be
 * inert -- the bot would garbage-collect it within a day on its own.
 * Building this properly would mean the web's first real Discord WRITE
 * (posting/pinning/deleting a message via the bot's REST API, not just
 * reading channels), plus the board's pagination buttons likely
 * wouldn't work unless the live gateway process also registers a
 * matching persistent view for that custom_id. Out of scope here.
 *
 * What IS safe and valuable: listing existing board configuration
 * (pure read), and a general bucketed-preview tool that runs the same
 * imminent/soon/upcoming/this-week/next-week/later computation a real
 * board's embed would, live, against current vault_notifications data
 * -- see notifications/scheduleBoardPreview.ts for the ported logic.
 */
import type { FastifyInstance } from "fastify";
import { eventsDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";
import { resolveAuthContext, canManageGuild } from "../auth/context.js";
import { isValidTimezone, formatTimezoneDisplay, normalizeStoredUtcTimestamp } from "../notifications/timezone.js";
import {
  expandRepeatingEvents,
  bucketFor,
  groupByDay,
  formatEvents,
  colorForSections,
  BUCKET_ORDER,
  type BucketKey,
  type ScheduleNotificationRow,
  type EventLookups,
} from "../notifications/scheduleBoardPreview.js";

const guildIdParam = {
  type: "object",
  required: ["guildId"],
  properties: { guildId: { type: "string", pattern: "^[0-9]+$" } },
} as const;

const previewQuerystring = {
  type: "object",
  properties: {
    boardType: { type: "string", enum: ["server", "channel"] },
    targetChannelId: { type: "string", pattern: "^[0-9]+$" },
    maxEvents: { type: "integer", minimum: 1, maximum: 30 },
    showDisabled: { type: "boolean" },
    filterName: { type: "string", maxLength: 200 },
    filterTimeRangeHours: { type: "integer", minimum: 1 },
    showRepeatingEvents: { type: "boolean" },
    timezone: { type: "string", minLength: 1, maxLength: 50 },
    useUserTimezone: { type: "boolean" },
    hideDailyReset: { type: "boolean" },
    page: { type: "integer", minimum: 0 },
  },
} as const;

const DEFAULT_EVENT_ICON = "📅";

function looksLikeEmoji(value: string | null): boolean {
  if (!value) return false;
  if (value.startsWith("http://") || value.startsWith("https://")) return false;
  return value.length <= 8;
}

interface PreviewQuery {
  boardType?: "server" | "channel";
  targetChannelId?: string;
  maxEvents?: number;
  showDisabled?: boolean;
  filterName?: string;
  filterTimeRangeHours?: number;
  showRepeatingEvents?: boolean;
  timezone?: string;
  useUserTimezone?: boolean;
  hideDailyReset?: boolean;
  page?: number;
}

export default async function scheduleBoardRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get<{ Params: { guildId: string } }>(
    "/admin/guilds/:guildId/schedule-boards",
    { schema: { params: guildIdParam } },
    async (request, reply) => {
      const { guildId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const rows = await eventsDb
        .selectFrom("notification_schedule_boards")
        .select([
          "id", snowflake("channel_id").as("channel_id"), "board_type",
          snowflake("target_channel_id").as("target_channel_id"), "max_events", "show_disabled",
          "auto_pin", "timezone", "filter_name", "filter_time_range", "show_repeating_events",
          "use_user_timezone", "hide_daily_reset", snowflake("created_by").as("created_by"),
          "created_at", "last_updated",
        ])
        .where("guild_id", "=", guildId)
        .orderBy("created_at", "asc")
        .execute();

      return rows.map((r) => ({
        id: r.id,
        channelId: r.channel_id,
        boardType: r.board_type,
        targetChannelId: r.target_channel_id,
        maxEvents: r.max_events,
        showDisabled: Boolean(r.show_disabled),
        autoPin: Boolean(r.auto_pin),
        timezone: r.timezone,
        timezoneDisplay: formatTimezoneDisplay(r.timezone),
        filterName: r.filter_name,
        filterTimeRange: r.filter_time_range,
        showRepeatingEvents: r.show_repeating_events === null ? true : Boolean(r.show_repeating_events),
        useUserTimezone: Boolean(r.use_user_timezone),
        hideDailyReset: r.hide_daily_reset === null ? true : Boolean(r.hide_daily_reset),
        createdBy: r.created_by,
        createdAt: normalizeStoredUtcTimestamp(r.created_at),
        lastUpdated: r.last_updated,
      }));
    },
  );

  fastify.get<{ Params: { guildId: string }; Querystring: PreviewQuery }>(
    "/admin/guilds/:guildId/schedule-preview",
    { schema: { params: guildIdParam, querystring: previewQuerystring } },
    async (request, reply) => {
      const { guildId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const {
        boardType = "server",
        targetChannelId,
        maxEvents = 15,
        showDisabled = false,
        filterName,
        filterTimeRangeHours,
        showRepeatingEvents = true,
        timezone = "UTC",
        useUserTimezone = false,
        hideDailyReset = true,
        page = 0,
      } = request.query;

      if (boardType === "channel" && !targetChannelId) {
        return reply.code(400).send({ error: "target_channel_id_required" });
      }
      if (!isValidTimezone(timezone)) {
        return reply.code(400).send({ error: "invalid_timezone" });
      }

      let query = eventsDb
        .selectFrom("vault_notifications")
        .select([
          "id", snowflake("channel_id").as("channel_id"), "hour", "minute", "timezone",
          "description", "notification_type", "next_notification", "is_enabled",
          "repeat_enabled", "repeat_minutes", "event_type",
        ])
        .where("guild_id", "=", guildId);
      if (boardType === "channel") {
        query = query.where("channel_id", "=", targetChannelId!);
      }
      if (!showDisabled) {
        query = query.where("is_enabled", "=", 1);
      }
      const rawRows = await query.execute();

      const now = new Date();
      const nameFilters = filterName
        ? filterName.split(",").map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0)
        : null;

      let notifications: ScheduleNotificationRow[] = rawRows
        .filter((r) => r.next_notification !== null)
        .map((r) => ({
          id: r.id,
          // channel_id is NOT NULL on vault_notifications -- snowflake()
          // just can't express that in its return type.
          channelId: r.channel_id!,
          hour: r.hour,
          minute: r.minute,
          timezone: r.timezone,
          description: r.description,
          notificationType: r.notification_type,
          nextNotification: r.next_notification!,
          isEnabled: Boolean(r.is_enabled),
          repeatEnabled: Boolean(r.repeat_enabled),
          repeatMinutes: r.repeat_minutes,
          eventType: r.event_type,
        }))
        // "AND next_notification IS NOT NULL AND datetime(next_notification) > datetime('now')"
        .filter((n) => new Date(n.nextNotification) > now);

      if (nameFilters) {
        notifications = notifications.filter((n) =>
          nameFilters.some((f) => n.description.toLowerCase().includes(f)),
        );
      }
      if (filterTimeRangeHours) {
        const cutoff = new Date(now.getTime() + filterTimeRangeHours * 60 * 60 * 1000);
        notifications = notifications.filter((n) => new Date(n.nextNotification) <= cutoff);
      }
      if (hideDailyReset) {
        notifications = notifications.filter((n) => n.eventType !== "Daily Reset");
      }

      // Weekday rows, batched for every -1-repeat notification (needed
      // for expansion even if the resulting occurrences land off-page).
      const weekdayIds = notifications.filter((n) => n.repeatMinutes === -1).map((n) => n.id);
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

      // 30 days -- matches _generate_schedule_embed_internal()'s own
      // hardcoded expansion window exactly (see scheduleBoardPreview.ts's
      // doc comment on why this is now an explicit parameter).
      const windowEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const expanded = expandRepeatingEvents(notifications, weekdayRowsByNotificationId, now, showRepeatingEvents, windowEnd)
        .filter((e) => e.time > now);

      if (expanded.length === 0) {
        return {
          isEmpty: true,
          totalEvents: 0,
          totalPages: 1,
          page: 0,
          color: 0x808080,
          timezoneDisplay: useUserTimezone ? "Local time" : formatTimezoneDisplay(timezone),
          boardType,
          sections: Object.fromEntries(BUCKET_ORDER.map((k) => [k, []])),
          lastUpdated: now.toISOString(),
        };
      }

      const cappedMaxEvents = Math.min(maxEvents, 30);
      const totalEvents = expanded.length;
      const totalPages = Math.max(1, Math.ceil(totalEvents / cappedMaxEvents));
      const clampedPage = Math.max(0, Math.min(page, totalPages - 1));
      const startIdx = clampedPage * cappedMaxEvents;
      const pageEvents = expanded.slice(startIdx, startIdx + cappedMaxEvents);

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

      // Embed titles, batched for only the page's EMBED_MESSAGE: notifications.
      const embedNotifIds = [...new Set(pageEvents.filter((e) => e.notif.description.includes("EMBED_MESSAGE:")).map((e) => e.notif.id))];
      const embedTitleByNotificationId = new Map<number, string | null>();
      if (embedNotifIds.length > 0) {
        const embedRows = await eventsDb
          .selectFrom("vault_notification_embeds")
          .select(["notification_id", "title"])
          .where("notification_id", "in", embedNotifIds)
          .execute();
        for (const row of embedRows) embedTitleByNotificationId.set(row.notification_id, row.title);
      }

      const lookups: EventLookups = { iconByEventType, embedTitleByNotificationId, defaultIcon: DEFAULT_EVENT_ICON };
      const displayTimezone = useUserTimezone ? "UTC" : timezone;
      const formatted = formatEvents(pageEvents, displayTimezone, lookups);

      const sections: Record<BucketKey, typeof formatted> = {
        imminent: [], soon: [], upcoming: [], thisWeek: [], nextWeek: [], later: [],
      };
      for (let i = 0; i < pageEvents.length; i++) {
        sections[bucketFor(pageEvents[i]!.time, now)].push(formatted[i]!);
      }

      const showChannel = boardType === "server";
      const sectionsOut = Object.fromEntries(
        BUCKET_ORDER.map((key) => [
          key,
          groupByDay(sections[key], displayTimezone).map((g) => ({
            date: g.date,
            events: g.events.map((e) => ({
              timeLabel: e.timeLabel,
              icon: e.icon,
              name: e.name,
              channelId: showChannel ? e.channelId : null,
              isEnabled: e.isEnabled,
            })),
          })),
        ]),
      );

      return {
        isEmpty: false,
        totalEvents,
        totalPages,
        page: clampedPage,
        color: colorForSections(sections),
        timezoneDisplay: useUserTimezone ? "Local time" : formatTimezoneDisplay(timezone),
        boardType,
        sections: sectionsOut,
        lastUpdated: now.toISOString(),
      };
    },
  );
}
