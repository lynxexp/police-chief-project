/**
 * Custom events -- Phase 2, Stage 7d. The admin-configured calendar
 * cogs/notification_event_types.py's docstring describes ("Police Chief
 * has no verified event schedule data... a DB-backed, admin-configured
 * custom-event calendar instead"). Guild-scoped (canManageGuild, Server
 * tier+), same as routes/notifications.ts.
 *
 * A custom_events row is the source of truth. When notificationsEnabled is
 * true, it's also NOT independently meaningful without its "materialized"
 * vault_notifications row -- the actual reminder that fires on schedule.
 * Every create/edit here re-materializes that row exactly the way
 * notification_wizard.py's save_custom_event() does: delete whatever was
 * previously materialized for this event, then (if enabled) insert a fresh
 * notification_type=6 row with a CUSTOM_TIMES:-encoded description,
 * repeat_minutes derived from recurrence_type (daily/weekly -> a literal
 * minutes interval; monthly -> the -2 sentinel, advanced via
 * calculateNextOccurrence() same as the bot's own
 * _next_monthly_custom_event_time()). This is the ONLY place
 * notification_type 6 / repeat_minutes -2 get set -- the basic
 * notification CRUD in routes/notifications.ts deliberately excludes
 * both, matching the source (a custom event's materialized reminder
 * isn't independently editable via the basic modal flow there either).
 *
 * notificationsEnabled=false means a calendar-only event: no channel, no
 * reminders, nothing materialized. See notifications/customEventMaterialize.ts
 * and routes/calendar.ts (which computes such an event's occurrences
 * directly from its recurrence fields, since there's no notification
 * trail to derive them from).
 *
 * A "Templates" concept (reusable content linked to an event) briefly
 * existed here and was removed -- it turned out to make the relationship
 * between events and their content more confusing, not less, especially
 * once it behaved differently here than it did for basic notifications.
 * Content is inline-only again, same as before that existed.
 */
import type { FastifyInstance } from "fastify";
import { eventsDb, allianceDb, vaultDataDb, capitolWarDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";
import { resolveAuthContext, canManageGuild } from "../auth/context.js";
import { fetchDiscordUserById } from "../auth/oauth.js";
import { calculateNextOccurrence } from "../notifications/nextOccurrence.js";
import { decodeDescription } from "../notifications/description.js";
import { localizedIsoString, toUtcIsoString, normalizeStoredUtcTimestamp } from "../notifications/timezone.js";
import { deleteNotificationRow } from "../notifications/deleteNotification.js";
import { embedSchema, type EmbedInput } from "../notifications/embed.js";
import {
  materializeCustomEventNotification,
  reminderOffsetsFor,
} from "../notifications/customEventMaterialize.js";
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
    "name", "date", "hour", "minute", "recurrenceType", "recurrenceInterval", "notificationsEnabled",
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
    // Off = calendar-only event -- everything below is ignored/unneeded.
    notificationsEnabled: { type: "boolean" },
    channelId: { type: "string", pattern: "^[0-9]+$" },
    channelName: { type: ["string", "null"] },
    mentionType: { type: "string", pattern: MENTION_TYPE_PATTERN },
    // 1-5 = preset reminder offsets; 6 = customTimes (required then).
    notificationType: { type: ["integer", "null"], minimum: 1, maximum: 6 },
    customTimes: customTimesSchema,
    messageKind: { type: "string", enum: ["plain", "embed"] },
    // Defaults to the wizard's own template ("%i **%n** starts in %t!")
    // when omitted -- see DEFAULT_CUSTOM_EVENT_MESSAGE.
    message: { type: "string", maxLength: 500 },
    embed: embedSchema,
  },
  allOf: [
    // Guarded with `required: ["notificationType"]` so an absent
    // notificationType doesn't vacuously match `properties.notificationType.const`
    // -- JSON Schema treats a missing property as satisfying any
    // `properties` constraint on it, same gotcha routes/notifications.ts's
    // messageKind check already guards against.
    { if: { required: ["notificationType"], properties: { notificationType: { const: 6 } } }, then: { required: ["customTimes"] } },
    {
      // notificationsEnabled is in the top-level `required`, so it's
      // always present -- no vacuous-match risk here.
      if: { properties: { notificationsEnabled: { const: true } } },
      then: {
        required: ["channelId", "mentionType", "notificationType"],
        allOf: [
          {
            if: { required: ["messageKind"], properties: { messageKind: { const: "embed" } } },
            then: { required: ["embed"] },
          },
        ],
      },
    },
  ],
} as const;

interface CustomEventBody {
  name: string;
  iconUrl?: string | null;
  date: string;
  hour: number;
  minute: number;
  recurrenceType: string;
  recurrenceInterval: number;
  notificationsEnabled: boolean;
  channelId?: string;
  channelName?: string | null;
  mentionType?: string;
  notificationType?: number;
  customTimes?: number[];
  messageKind?: "plain" | "embed";
  message?: string;
  embed?: EmbedInput;
}

/** The materialized description is always CUSTOM_TIMES:-encoded here, so
 * an admin-typed plain message containing one of the OTHER reserved
 * sentinels would get misread by decodeDescription() -- see
 * notifications/description.ts's doc comment on PLAIN_MESSAGE:. Only
 * applies to the inline plain-message path; an inline embed title isn't
 * checked, matching routes/notifications.ts. */
function hasReservedMessagePrefix(message: string): boolean {
  return message.startsWith("PLAIN_MESSAGE:") || message.includes("EMBED_MESSAGE:") || message.startsWith("CUSTOM_TIMES:");
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
          snowflake("created_by").as("created_by"), "created_at", "notifications_enabled",
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
          notificationsEnabled: r.notifications_enabled === null ? true : Boolean(r.notifications_enabled),
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
          snowflake("created_by").as("created_by"), "created_at", "notifications_enabled",
        ])
        .where("id", "=", id)
        .where("guild_id", "=", guildId)
        .executeTakeFirst();
      if (!row) {
        return reply.code(404).send({ error: "custom_event_not_found" });
      }

      const creator = row.created_by ? await fetchDiscordUserById(row.created_by) : null;
      const createdByName = creator?.global_name ?? creator?.username ?? null;

      const notification = await eventsDb
        .selectFrom("vault_notifications")
        .select([
          "id", "is_enabled", "mention_type", "notification_type", "description",
          "next_notification", "last_notification", "auto_disabled_at",
        ])
        .where("custom_event_id", "=", id)
        .executeTakeFirst();

      let messageKind: "plain" | "embed" | null = null;
      let message: string | null = null;
      let embed: EmbedInput | null = null;
      if (notification) {
        const decoded = decodeDescription(notification.description);
        if (decoded.kind === "embed") {
          messageKind = "embed";
          const embedRow = await eventsDb
            .selectFrom("vault_notification_embeds")
            .select(["title", "description", "color", "image_url", "thumbnail_url", "footer", "author", "mention_message"])
            .where("notification_id", "=", notification.id)
            .executeTakeFirst();
          embed = embedRow
            ? {
                title: embedRow.title,
                description: embedRow.description,
                color: embedRow.color,
                imageUrl: embedRow.image_url,
                thumbnailUrl: embedRow.thumbnail_url,
                footer: embedRow.footer,
                author: embedRow.author,
                mentionMessage: embedRow.mention_message,
              }
            : null;
        } else {
          messageKind = "plain";
          message = decoded.text;
        }
      }

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
        createdByName,
        createdAt: normalizeStoredUtcTimestamp(row.created_at),
        notificationsEnabled: row.notifications_enabled === null ? true : Boolean(row.notifications_enabled),
        messageKind,
        message,
        embed,
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
    Body: CustomEventBody;
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
        name, iconUrl, date, hour, minute, recurrenceType, recurrenceInterval, notificationsEnabled,
        channelId, channelName, notificationType, customTimes, mentionType, messageKind, message, embed,
      } = request.body;

      if (notificationsEnabled && messageKind !== "embed" && message !== undefined && hasReservedMessagePrefix(message)) {
        return reply.code(400).send({ error: "message_reserved_prefix" });
      }

      const firstOccurrenceIso = localizedIsoString(date, hour, minute, "UTC");
      const offsets = notificationsEnabled ? reminderOffsetsFor(notificationType ?? 0, customTimes) : [];
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
          channel_id: notificationsEnabled ? channelId! : null,
          created_by: ctx.discordId,
          created_at: now,
          notifications_enabled: notificationsEnabled ? 1 : 0,
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
        notificationsEnabled,
        channelId,
        channelName: channelName ?? null,
        createdBy: ctx.discordId,
        mentionType,
        notificationType,
        customTimes,
        messageKind,
        message,
        embed,
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
    Body: CustomEventBody;
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
        name, iconUrl, date, hour, minute, recurrenceType, recurrenceInterval, notificationsEnabled,
        channelId, channelName, notificationType, customTimes, mentionType, messageKind, message, embed,
      } = request.body;

      if (notificationsEnabled && messageKind !== "embed" && message !== undefined && hasReservedMessagePrefix(message)) {
        return reply.code(400).send({ error: "message_reserved_prefix" });
      }

      const firstOccurrenceIso = localizedIsoString(date, hour, minute, "UTC");
      const offsets = notificationsEnabled ? reminderOffsetsFor(notificationType ?? 0, customTimes) : [];
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
          channel_id: notificationsEnabled ? channelId! : null,
          notifications_enabled: notificationsEnabled ? 1 : 0,
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
        notificationsEnabled,
        channelId,
        channelName: channelName ?? null,
        createdBy: ctx.discordId,
        mentionType,
        notificationType,
        customTimes,
        messageKind,
        message,
        embed,
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
