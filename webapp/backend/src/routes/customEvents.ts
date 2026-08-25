/**
 * Custom events -- Phase 2, Stage 7d. The admin-configured calendar
 * cogs/notification_event_types.py's docstring describes ("Police Chief
 * has no verified event schedule data... a DB-backed, admin-configured
 * custom-event calendar instead"). Guild-scoped (canManageGuild, Server
 * tier+), same as routes/notifications.ts.
 *
 * A custom_events row is the source of truth; it is NOT independently
 * meaningful without its "materialized" vault_notifications row -- the
 * actual reminder that fires on schedule. Every create/edit here
 * re-materializes that row exactly the way
 * notification_wizard.py's save_custom_event() does: delete whatever
 * was previously materialized for this event, then insert a fresh
 * notification_type=6 row with a CUSTOM_TIMES:-encoded description,
 * repeat_minutes derived from recurrence_type (daily/weekly -> a literal
 * minutes interval; monthly -> the -2 sentinel, advanced via
 * calculateNextOccurrence() same as the bot's own
 * _next_monthly_custom_event_time()). This is the ONLY place
 * notification_type 6 / repeat_minutes -2 get set -- the basic
 * notification CRUD in routes/notifications.ts deliberately excludes
 * both, matching the source (a custom event's materialized reminder
 * isn't independently editable via the basic modal flow there either).
 */
import type { FastifyInstance } from "fastify";
import { eventsDb, allianceDb, vaultDataDb, capitolWarDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";
import { resolveAuthContext, canManageGuild } from "../auth/context.js";
import { calculateNextOccurrence } from "../notifications/nextOccurrence.js";
import { encodeCustomTimesDescription } from "../notifications/description.js";
import { localizedIsoString, toUtcIsoString, normalizeStoredUtcTimestamp } from "../notifications/timezone.js";
import { deleteNotificationRow } from "../notifications/deleteNotification.js";
import { logAppAction } from "../audit.js";

const guildIdParam = {
  type: "object",
  required: ["guildId"],
  properties: { guildId: { type: "string", pattern: "^[0-9]+$" } },
} as const;

const allianceIdParam = {
  type: "object",
  required: ["allianceId"],
  properties: { allianceId: { type: "integer" } },
} as const;

/** event_type strings this app derives attendance from -- see
 * routes/member.ts's vault/capitol attendance endpoints. Matched
 * case-insensitively against a guild's custom_events.name since there's
 * no other link between attendance data and the Notifications system
 * (the plan doc calls this gap out explicitly: "an admin has to create
 * matching custom-event rows" -- this suggestion just surfaces that). */
const ATTENDANCE_EVENT_TYPES = ["Vault Trap", "Capitol War"] as const;

const customEventParams = {
  type: "object",
  required: ["guildId", "id"],
  properties: {
    guildId: { type: "string", pattern: "^[0-9]+$" },
    id: { type: "integer" },
  },
} as const;

const MENTION_TYPE_PATTERN = "^(none|everyone|role_[0-9]+|member_[0-9]+)$";
const RECURRENCE_TYPE_PATTERN = "^(daily|weekly|monthly)$";

const customTimesSchema = {
  type: "array",
  items: { type: "integer", minimum: 0 },
  minItems: 1,
  maxItems: 20,
} as const;

const customEventBody = {
  type: "object",
  required: [
    "name", "date", "hour", "minute", "recurrenceType", "recurrenceInterval",
    "channelId", "notificationType", "mentionType",
  ],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    iconUrl: { type: ["string", "null"], maxLength: 200 },
    // Always UTC -- see notification_wizard.py's CustomEventDateTimeModal
    // (title "First Occurrence (UTC)"), no per-event timezone field.
    date: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
    hour: { type: "integer", minimum: 0, maximum: 23 },
    minute: { type: "integer", minimum: 0, maximum: 59 },
    recurrenceType: { type: "string", pattern: RECURRENCE_TYPE_PATTERN },
    recurrenceInterval: { type: "integer", minimum: 1 },
    channelId: { type: "string", pattern: "^[0-9]+$" },
    channelName: { type: ["string", "null"] },
    // 1-5 = preset reminder offsets; 6 = customTimes (required then).
    notificationType: { type: "integer", minimum: 1, maximum: 6 },
    customTimes: customTimesSchema,
    mentionType: { type: "string", pattern: MENTION_TYPE_PATTERN },
    // Defaults to the wizard's own template ("%i **%n** starts in %t!")
    // when omitted -- see DEFAULT_CUSTOM_EVENT_MESSAGE below.
    message: { type: "string", maxLength: 500 },
  },
  if: { properties: { notificationType: { const: 6 } } },
  then: { required: ["customTimes"] },
} as const;

const DEFAULT_CUSTOM_EVENT_MESSAGE = "%i **%n** starts in %t!";

/** The materialized description is always CUSTOM_TIMES:-encoded here, so
 * an admin-typed message containing one of the OTHER reserved sentinels
 * would get misread by decodeDescription() -- see
 * notifications/description.ts's doc comment on PLAIN_MESSAGE:. */
function hasReservedMessagePrefix(message: string): boolean {
  return message.startsWith("PLAIN_MESSAGE:") || message.includes("EMBED_MESSAGE:") || message.startsWith("CUSTOM_TIMES:");
}

const NOTIFICATION_TYPE_PRESETS: Record<number, number[]> = {
  1: [30, 10, 5, 0],
  2: [10, 5, 0],
  3: [5, 0],
  4: [5],
  5: [0],
};

/** Mirrors CustomEventSession.reminder_offsets(). */
function reminderOffsetsFor(notificationType: number, customTimes: number[] | undefined): number[] {
  if (notificationType === 6 && customTimes && customTimes.length > 0) return customTimes;
  return NOTIFICATION_TYPE_PRESETS[notificationType] ?? [10, 5, 0];
}

/** Mirrors save_custom_event()'s repeat_minutes derivation exactly. */
function repeatMinutesForRecurrence(recurrenceType: string, interval: number): number {
  if (recurrenceType === "daily") return Math.max(1, interval) * 1440;
  if (recurrenceType === "weekly") return Math.max(1, interval) * 7 * 1440;
  return -2;
}

interface MaterializeParams {
  guildId: string;
  customEventId: number;
  name: string;
  firstOccurrenceIso: string;
  recurrenceType: string;
  recurrenceInterval: number;
  channelId: string;
  channelName: string | null;
  createdBy: string;
  notificationType: number;
  customTimes?: number[];
  mentionType: string;
  message: string;
}

/** Drops whatever notification(s) were previously materialized for this
 * custom event, then inserts a fresh one -- mirrors save_custom_event()'s
 * "simplest way to keep the reminder in sync" delete-then-recreate. */
async function materializeCustomEventNotification(params: MaterializeParams): Promise<void> {
  const old = await eventsDb
    .selectFrom("vault_notifications")
    .select("id")
    .where("custom_event_id", "=", params.customEventId)
    .execute();
  for (const row of old) {
    await deleteNotificationRow(row.id);
  }

  const firstOccurrence = new Date(params.firstOccurrenceIso);
  const nextOcc = calculateNextOccurrence(firstOccurrence, params.recurrenceType, params.recurrenceInterval, new Date());
  if (!nextOcc) {
    throw new Error(`calculateNextOccurrence returned null for recurrenceType "${params.recurrenceType}"`);
  }

  const offsets = reminderOffsetsFor(params.notificationType, params.customTimes);
  const description = encodeCustomTimesDescription(offsets, params.message);
  const repeatMinutes = repeatMinutesForRecurrence(params.recurrenceType, params.recurrenceInterval);

  await eventsDb
    .insertInto("vault_notifications")
    .values({
      guild_id: params.guildId,
      channel_id: params.channelId,
      channel_name: params.channelName,
      // Always UTC for custom events -- see save_custom_event()'s
      // hardcoded `timezone="UTC"`.
      hour: nextOcc.getUTCHours(),
      minute: nextOcc.getUTCMinutes(),
      timezone: "UTC",
      description,
      notification_type: 6,
      mention_type: params.mentionType,
      repeat_enabled: 1,
      repeat_minutes: repeatMinutes,
      created_by: params.createdBy,
      next_notification: toUtcIsoString(nextOcc),
      event_type: params.name,
      custom_event_id: params.customEventId,
    })
    .execute();
}

export default async function customEventRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  /** Surfaces attendance data (Vault Trap / Capitol War) that has no
   * matching custom event yet, so an admin sees "there's data but no
   * reminder wired up" instead of silently missing it -- see the
   * ATTENDANCE_EVENT_TYPES doc comment above. */
  fastify.get<{ Params: { allianceId: number } }>(
    "/admin/alliances/:allianceId/custom-event-suggestions",
    { schema: { params: allianceIdParam } },
    async (request, reply) => {
      const { allianceId } = request.params;
      const ctx = await resolveAuthContext(request.session!);

      const alliance = await allianceDb
        .selectFrom("alliance_list")
        .select(snowflake("discord_server_id").as("discord_server_id"))
        .where("alliance_id", "=", allianceId)
        .executeTakeFirst();
      const guildId = alliance?.discord_server_id ?? null;
      if (!guildId) {
        return { guildId: null, missing: [] };
      }
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const [hasVaultData, hasCapitolData, existingEvents] = await Promise.all([
        vaultDataDb.selectFrom("vault_hunts").select("id").where("alliance_id", "=", allianceId).limit(1).executeTakeFirst(),
        capitolWarDb.selectFrom("capitol_war_events").select("id").where("alliance_id", "=", allianceId).limit(1).executeTakeFirst(),
        eventsDb.selectFrom("custom_events").select("name").where("guild_id", "=", guildId).execute(),
      ]);
      const existingNames = existingEvents.map((e) => (e.name ?? "").toLowerCase());
      const hasDataByType: Record<(typeof ATTENDANCE_EVENT_TYPES)[number], boolean> = {
        "Vault Trap": !!hasVaultData,
        "Capitol War": !!hasCapitolData,
      };

      // Substring match, not exact -- admins commonly name these per-trap
      // ("Vault Trap 1", "Vault Trap 2") rather than verbatim, and an
      // exact-equality check would keep nagging them to create a
      // duplicate for an event they've already wired up.
      const missing = ATTENDANCE_EVENT_TYPES.filter(
        (eventType) =>
          hasDataByType[eventType] && !existingNames.some((name) => name.includes(eventType.toLowerCase())),
      );

      return { guildId, missing };
    },
  );

  fastify.get<{ Params: { guildId: string } }>(
    "/admin/guilds/:guildId/custom-events",
    { schema: { params: guildIdParam } },
    async (request, reply) => {
      const { guildId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const rows = await eventsDb
        .selectFrom("custom_events")
        .select([
          "id", "name", "icon_url", "first_occurrence", "recurrence_type", "recurrence_interval",
          "reminder_offsets", snowflake("channel_id").as("channel_id"),
          snowflake("created_by").as("created_by"), "created_at",
        ])
        .where("guild_id", "=", guildId)
        .orderBy("name", "asc")
        .execute();

      const now = new Date();
      return rows.map((r) => {
        const nextOcc = r.first_occurrence
          ? calculateNextOccurrence(new Date(r.first_occurrence), r.recurrence_type ?? "monthly", r.recurrence_interval ?? 1, now)
          : null;
        return {
          id: r.id,
          name: r.name,
          iconUrl: r.icon_url,
          firstOccurrence: r.first_occurrence,
          recurrenceType: r.recurrence_type,
          recurrenceInterval: r.recurrence_interval,
          reminderOffsets: r.reminder_offsets ? (JSON.parse(r.reminder_offsets) as number[]) : [],
          channelId: r.channel_id,
          createdBy: r.created_by,
          createdAt: normalizeStoredUtcTimestamp(r.created_at),
          nextOccurrence: nextOcc ? toUtcIsoString(nextOcc) : null,
        };
      });
    },
  );

  fastify.get<{ Params: { guildId: string; id: number } }>(
    "/admin/guilds/:guildId/custom-events/:id",
    { schema: { params: customEventParams } },
    async (request, reply) => {
      const { guildId, id } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const row = await eventsDb
        .selectFrom("custom_events")
        .select([
          "id", "name", "icon_url", "first_occurrence", "recurrence_type", "recurrence_interval",
          "reminder_offsets", snowflake("channel_id").as("channel_id"),
          snowflake("created_by").as("created_by"), "created_at",
        ])
        .where("id", "=", id)
        .where("guild_id", "=", guildId)
        .executeTakeFirst();
      if (!row) {
        return reply.code(404).send({ error: "custom_event_not_found" });
      }

      const notification = await eventsDb
        .selectFrom("vault_notifications")
        .select([
          "id", "is_enabled", "mention_type", "notification_type",
          "next_notification", "last_notification", "auto_disabled_at",
        ])
        .where("custom_event_id", "=", id)
        .executeTakeFirst();

      return {
        id: row.id,
        name: row.name,
        iconUrl: row.icon_url,
        firstOccurrence: row.first_occurrence,
        recurrenceType: row.recurrence_type,
        recurrenceInterval: row.recurrence_interval,
        reminderOffsets: row.reminder_offsets ? (JSON.parse(row.reminder_offsets) as number[]) : [],
        channelId: row.channel_id,
        createdBy: row.created_by,
        createdAt: normalizeStoredUtcTimestamp(row.created_at),
        materializedNotification: notification
          ? {
              id: notification.id,
              isEnabled: Boolean(notification.is_enabled),
              mentionType: notification.mention_type,
              notificationType: notification.notification_type,
              nextNotification: notification.next_notification,
              lastNotification: notification.last_notification,
              autoDisabledAt: notification.auto_disabled_at,
            }
          : null,
      };
    },
  );

  fastify.post<{
    Params: { guildId: string };
    Body: {
      name: string;
      iconUrl?: string | null;
      date: string;
      hour: number;
      minute: number;
      recurrenceType: string;
      recurrenceInterval: number;
      channelId: string;
      channelName?: string | null;
      notificationType: number;
      customTimes?: number[];
      mentionType: string;
      message?: string;
    };
  }>(
    "/admin/guilds/:guildId/custom-events",
    { schema: { params: guildIdParam, body: customEventBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const { guildId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }
      const {
        name, iconUrl, date, hour, minute, recurrenceType, recurrenceInterval,
        channelId, channelName, notificationType, customTimes, mentionType, message,
      } = request.body;

      if (message !== undefined && hasReservedMessagePrefix(message)) {
        return reply.code(400).send({ error: "message_reserved_prefix" });
      }

      const firstOccurrenceIso = localizedIsoString(date, hour, minute, "UTC");
      const offsets = reminderOffsetsFor(notificationType, customTimes);
      const reminderOffsetsJson = JSON.stringify([...offsets].sort((a, b) => b - a));
      const now = new Date().toISOString();

      const result = await eventsDb
        .insertInto("custom_events")
        .values({
          guild_id: guildId,
          name,
          icon_url: iconUrl ?? null,
          first_occurrence: firstOccurrenceIso,
          recurrence_type: recurrenceType,
          recurrence_interval: recurrenceInterval,
          reminder_offsets: reminderOffsetsJson,
          channel_id: channelId,
          created_by: ctx.discordId,
          created_at: now,
        })
        .executeTakeFirst();
      const newId = Number(result.insertId);

      await materializeCustomEventNotification({
        guildId,
        customEventId: newId,
        name,
        firstOccurrenceIso,
        recurrenceType,
        recurrenceInterval,
        channelId,
        channelName: channelName ?? null,
        createdBy: ctx.discordId,
        notificationType,
        customTimes,
        mentionType,
        message: message?.trim() || DEFAULT_CUSTOM_EVENT_MESSAGE,
      });

      await logAppAction({
        actorId: ctx.discordId,
        guildId,
        action: "custom_event_created",
        resourceType: "custom_event",
        resourceId: String(newId),
        detail: name,
      });

      return reply.code(201).send({ ok: true, id: newId });
    },
  );

  fastify.patch<{
    Params: { guildId: string; id: number };
    Body: {
      name: string;
      iconUrl?: string | null;
      date: string;
      hour: number;
      minute: number;
      recurrenceType: string;
      recurrenceInterval: number;
      channelId: string;
      channelName?: string | null;
      notificationType: number;
      customTimes?: number[];
      mentionType: string;
      message?: string;
    };
  }>(
    "/admin/guilds/:guildId/custom-events/:id",
    { schema: { params: customEventParams, body: customEventBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const { guildId, id } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const existing = await eventsDb
        .selectFrom("custom_events")
        .select("id")
        .where("id", "=", id)
        .where("guild_id", "=", guildId)
        .executeTakeFirst();
      if (!existing) {
        return reply.code(404).send({ error: "custom_event_not_found" });
      }

      const {
        name, iconUrl, date, hour, minute, recurrenceType, recurrenceInterval,
        channelId, channelName, notificationType, customTimes, mentionType, message,
      } = request.body;

      if (message !== undefined && hasReservedMessagePrefix(message)) {
        return reply.code(400).send({ error: "message_reserved_prefix" });
      }

      const firstOccurrenceIso = localizedIsoString(date, hour, minute, "UTC");
      const offsets = reminderOffsetsFor(notificationType, customTimes);
      const reminderOffsetsJson = JSON.stringify([...offsets].sort((a, b) => b - a));

      await eventsDb
        .updateTable("custom_events")
        .set({
          name,
          icon_url: iconUrl ?? null,
          first_occurrence: firstOccurrenceIso,
          recurrence_type: recurrenceType,
          recurrence_interval: recurrenceInterval,
          reminder_offsets: reminderOffsetsJson,
          channel_id: channelId,
        })
        .where("id", "=", id)
        .execute();

      await materializeCustomEventNotification({
        guildId,
        customEventId: id,
        name,
        firstOccurrenceIso,
        recurrenceType,
        recurrenceInterval,
        channelId,
        channelName: channelName ?? null,
        createdBy: ctx.discordId,
        notificationType,
        customTimes,
        mentionType,
        message: message?.trim() || DEFAULT_CUSTOM_EVENT_MESSAGE,
      });

      await logAppAction({
        actorId: ctx.discordId,
        guildId,
        action: "custom_event_updated",
        resourceType: "custom_event",
        resourceId: String(id),
        detail: name,
      });

      return { ok: true };
    },
  );

  fastify.delete<{ Params: { guildId: string; id: number } }>(
    "/admin/guilds/:guildId/custom-events/:id",
    { schema: { params: customEventParams }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const { guildId, id } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const existing = await eventsDb
        .selectFrom("custom_events")
        .select(["id", "name"])
        .where("id", "=", id)
        .where("guild_id", "=", guildId)
        .executeTakeFirst();
      if (!existing) {
        return reply.code(404).send({ error: "custom_event_not_found" });
      }

      const linked = await eventsDb
        .selectFrom("vault_notifications")
        .select("id")
        .where("custom_event_id", "=", id)
        .execute();
      for (const row of linked) {
        await deleteNotificationRow(row.id);
      }

      await eventsDb.deleteFrom("custom_events").where("id", "=", id).execute();

      await logAppAction({
        actorId: ctx.discordId,
        guildId,
        action: "custom_event_deleted",
        resourceType: "custom_event",
        resourceId: String(id),
        detail: existing.name,
      });

      return { ok: true };
    },
  );
}
