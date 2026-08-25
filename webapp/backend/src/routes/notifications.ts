/**
 * Notifications -- Phase 2, Stages 7b (read-only views), 7c (basic
 * create/edit/delete CRUD), 7d (weekday repeat mode), and 7e (embed
 * builder). Guild-scoped (vault_notifications has no alliance concept),
 * so every route here gates on canManageGuild rather than
 * canManageAlliance -- see the plan doc's "New canManageGuild
 * permission helper" decision.
 *
 * 7c's plain-text-only, notification_type 1-5, repeat_minutes 0/>0
 * restrictions are now lifted for weekday repeat (-1, Stage 7d) via
 * this file's create/edit routes, and for embeds (Stage 7e) via
 * `messageKind: "embed"` + a separate `embed` object -- the backend
 * assembles the "EMBED_MESSAGE:<title>" sentinel server-side, matching
 * the plan's "routes accept clean separate fields... build the encoded
 * column server-side" decision; the raw column is never exposed as a
 * free-text field. Monthly custom-event repeat (-2) and notification_type
 * 6 (custom times) are NOT settable here -- those are exclusively
 * materialized by the custom_events CRUD in routes/customEvents.ts,
 * matching save_custom_event()'s auto-materialize-the-linked-notification
 * model in the Python source (a custom event's linked reminder isn't
 * independently editable via the basic notification form there either).
 * Channel is immutable after creation -- update_notification() in the
 * Python source has no channel_id parameter at all, so editing one means
 * delete + recreate.
 */
import type { FastifyInstance } from "fastify";
import { eventsDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";
import { resolveAuthContext, canManageGuild } from "../auth/context.js";
import { decodeDescription } from "../notifications/description.js";
import {
  isValidTimezone,
  isPastDateInTimezone,
  localizedIsoString,
  replaceHourMinute,
  normalizeStoredUtcTimestamp,
} from "../notifications/timezone.js";
import { parseWeekdayRows, encodeWeekdays } from "../notifications/weekdays.js";
import { deleteNotificationRow } from "../notifications/deleteNotification.js";
import { logAppAction } from "../audit.js";

const guildIdParam = {
  type: "object",
  required: ["guildId"],
  properties: { guildId: { type: "string", pattern: "^[0-9]+$" } },
} as const;

const notificationParams = {
  type: "object",
  required: ["guildId", "id"],
  properties: {
    guildId: { type: "string", pattern: "^[0-9]+$" },
    id: { type: "integer" },
  },
} as const;

const historyQuerystring = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 200 },
    offset: { type: "integer", minimum: 0 },
  },
} as const;

// mention_type is one of a small closed set of shapes -- see
// mentionLabel() in the frontend client and _resolve_send_channel-
// adjacent mention handling in cogs/notification_system.py.
const MENTION_TYPE_PATTERN = "^(none|everyone|role_[0-9]+|member_[0-9]+)$";

// notification_days stores Python .weekday() integers (Monday=0 ...
// Sunday=6) -- see notifications/weekdays.ts.
const weekdaysSchema = {
  type: "array",
  items: { type: "integer", minimum: 0, maximum: 6 },
  minItems: 1,
  maxItems: 7,
  uniqueItems: true,
} as const;

// vault_notification_embeds columns -- see EmbedEditorView's per-field
// modals in cogs/notification_system.py for these exact max lengths and
// the http(s)-only URL guard on image/thumbnail.
const embedSchema = {
  type: "object",
  properties: {
    title: { type: ["string", "null"], maxLength: 256 },
    description: { type: ["string", "null"], maxLength: 4000 },
    color: { type: ["integer", "null"], minimum: 0, maximum: 16777215 },
    imageUrl: { type: ["string", "null"], pattern: "^https?://" },
    thumbnailUrl: { type: ["string", "null"], pattern: "^https?://" },
    footer: { type: ["string", "null"], maxLength: 2048 },
    author: { type: ["string", "null"], maxLength: 256 },
    mentionMessage: { type: ["string", "null"], maxLength: 2000 },
  },
} as const;

const createNotificationBody = {
  type: "object",
  required: ["channelId", "date", "hour", "minute", "timezone", "notificationType", "mentionType", "repeatMinutes"],
  properties: {
    channelId: { type: "string", pattern: "^[0-9]+$" },
    channelName: { type: ["string", "null"] },
    date: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
    hour: { type: "integer", minimum: 0, maximum: 23 },
    minute: { type: "integer", minimum: 0, maximum: 59 },
    timezone: { type: "string", minLength: 1, maxLength: 50 },
    // "plain" (default when omitted) uses `description`; "embed" uses
    // `embed` instead -- see the if/then below. Handler additionally
    // enforces non-empty `description` for the plain path (AJV's
    // draft-07 if/then can't cleanly express "required XOR minLength"
    // across two branches without duplicating the property schema).
    messageKind: { type: "string", enum: ["plain", "embed"] },
    description: { type: "string", maxLength: 2000 },
    embed: embedSchema,
    // 6 (custom times) is exclusively materialized by custom_events --
    // not settable directly here, see routes/customEvents.ts.
    notificationType: { type: "integer", minimum: 1, maximum: 5 },
    mentionType: { type: "string", pattern: MENTION_TYPE_PATTERN },
    // 0 = no repeat; >0 = repeat every N minutes; -1 = specific weekdays
    // (requires `weekdays`). -2 (custom event) is exclusively set by
    // custom_events materialization, never directly here.
    repeatMinutes: { type: "integer", minimum: -1 },
    weekdays: weekdaysSchema,
    eventType: { type: ["string", "null"], maxLength: 100 },
  },
  allOf: [
    { if: { properties: { repeatMinutes: { const: -1 } } }, then: { required: ["weekdays"] } },
    {
      // Guarded with `required: ["messageKind"]` so an absent
      // messageKind (older clients, or a plain-mode request that omits
      // it) doesn't vacuously match `properties.messageKind.const` --
      // JSON Schema treats a missing property as satisfying any
      // `properties` constraint on it.
      if: { required: ["messageKind"], properties: { messageKind: { const: "embed" } } },
      then: { required: ["embed"] },
      else: { required: ["description"] },
    },
  ],
} as const;

const editNotificationBody = {
  type: "object",
  required: ["hour", "minute", "timezone", "notificationType", "mentionType", "repeatMinutes"],
  properties: {
    hour: { type: "integer", minimum: 0, maximum: 23 },
    minute: { type: "integer", minimum: 0, maximum: 59 },
    timezone: { type: "string", minLength: 1, maxLength: 50 },
    messageKind: { type: "string", enum: ["plain", "embed"] },
    description: { type: "string", maxLength: 2000 },
    embed: embedSchema,
    notificationType: { type: "integer", minimum: 1, maximum: 5 },
    mentionType: { type: "string", pattern: MENTION_TYPE_PATTERN },
    repeatMinutes: { type: "integer", minimum: -1 },
    weekdays: weekdaysSchema,
    eventType: { type: ["string", "null"], maxLength: 100 },
  },
  allOf: [
    { if: { properties: { repeatMinutes: { const: -1 } } }, then: { required: ["weekdays"] } },
    {
      if: { required: ["messageKind"], properties: { messageKind: { const: "embed" } } },
      then: { required: ["embed"] },
      else: { required: ["description"] },
    },
  ],
} as const;

const enabledBody = {
  type: "object",
  required: ["enabled"],
  properties: { enabled: { type: "boolean" } },
} as const;

/** Plain-mode description can never carry the CUSTOM_TIMES:/EMBED_MESSAGE:/
 * PLAIN_MESSAGE: sentinels -- the first two are reserved for the encoded
 * paths this file (embed, via `messageKind: "embed"`) and custom_events
 * (custom times) build server-side; PLAIN_MESSAGE: is a legacy
 * Discord-side wrapper the web never has a reason to write (see
 * notifications/description.ts's doc comment). An admin typing one of
 * these manually here would otherwise silently produce a notification
 * the decoder misreads. */
function hasReservedDescriptionPrefix(description: string): boolean {
  return (
    description.startsWith("CUSTOM_TIMES:") ||
    description.includes("EMBED_MESSAGE:") ||
    description.startsWith("PLAIN_MESSAGE:")
  );
}

interface EmbedInput {
  title?: string | null;
  description?: string | null;
  color?: number | null;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  footer?: string | null;
  author?: string | null;
  mentionMessage?: string | null;
}

/** Builds the stored `description` column value for either message
 * kind -- mirrors save_notification()/update_notification() exactly:
 * plain text stored as-is; embed mode stores the "EMBED_MESSAGE:<title>"
 * sentinel, falling back to the literal string "true" when the embed
 * has no title (matching `embed_data.get("title", "true")`). The real
 * embed content lives in vault_notification_embeds -- see
 * writeEmbedRow() below. */
function buildDescription(
  messageKind: "plain" | "embed" | undefined,
  description: string | undefined,
  embed: EmbedInput | undefined,
): string {
  if (messageKind === "embed") {
    return `EMBED_MESSAGE:${embed?.title || "true"}`;
  }
  return description!;
}

/** Delete-then-insert, matching update_notification()'s
 * `DELETE FROM vault_notification_embeds WHERE notification_id = ?`
 * followed by a fresh save_notification_embed() call -- safe to call
 * unconditionally on create too (the delete is just a no-op there). */
async function writeEmbedRow(notificationId: number, embed: EmbedInput): Promise<void> {
  await eventsDb.deleteFrom("vault_notification_embeds").where("notification_id", "=", notificationId).execute();
  await eventsDb
    .insertInto("vault_notification_embeds")
    .values({
      notification_id: notificationId,
      title: embed.title ?? null,
      description: embed.description ?? null,
      color: embed.color ?? null,
      image_url: embed.imageUrl ?? null,
      thumbnail_url: embed.thumbnailUrl ?? null,
      footer: embed.footer ?? null,
      author: embed.author ?? null,
      mention_message: embed.mentionMessage ?? null,
    })
    .execute();
}

/** Mirrors cogs/notification_event_types.py's _looks_like_emoji -- an
 * admin-typed icon is only safe to render directly (vs. falling back to
 * a generic calendar icon) if it's short and not a pasted image URL. */
function looksLikeEmoji(value: string | null): boolean {
  if (!value) return false;
  if (value.startsWith("http://") || value.startsWith("https://")) return false;
  return value.length <= 8;
}

const DEFAULT_EVENT_ICON = "📅";

export default async function notificationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get<{ Params: { guildId: string } }>(
    "/admin/guilds/:guildId/notifications",
    { schema: { params: guildIdParam } },
    async (request, reply) => {
      const { guildId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const rows = await eventsDb
        .selectFrom("vault_notifications")
        .leftJoin("custom_events", (join) =>
          join
            .onRef("custom_events.guild_id", "=", "vault_notifications.guild_id")
            .onRef("custom_events.name", "=", "vault_notifications.event_type"),
        )
        .select([
          "vault_notifications.id",
          snowflake("vault_notifications.channel_id").as("channel_id"),
          "vault_notifications.channel_name",
          "vault_notifications.hour",
          "vault_notifications.minute",
          "vault_notifications.timezone",
          "vault_notifications.description",
          "vault_notifications.notification_type",
          "vault_notifications.mention_type",
          "vault_notifications.repeat_enabled",
          "vault_notifications.repeat_minutes",
          "vault_notifications.is_enabled",
          "vault_notifications.event_type",
          "vault_notifications.custom_event_id",
          snowflake("vault_notifications.created_by").as("created_by"),
          "vault_notifications.created_at",
          "vault_notifications.last_notification",
          "vault_notifications.next_notification",
          "vault_notifications.auto_disabled_at",
          "custom_events.icon_url",
        ])
        .where("vault_notifications.guild_id", "=", guildId)
        .orderBy("vault_notifications.is_enabled", "desc")
        .orderBy("vault_notifications.next_notification", "asc")
        .execute();

      return rows.map((r) => {
        const decoded = decodeDescription(r.description);
        return {
          id: r.id,
          channelId: r.channel_id,
          channelName: r.channel_name,
          hour: r.hour,
          minute: r.minute,
          timezone: r.timezone,
          descriptionKind: decoded.kind,
          descriptionText: decoded.text,
          customTimes: decoded.customTimes,
          notificationType: r.notification_type,
          mentionType: r.mention_type,
          repeatEnabled: Boolean(r.repeat_enabled),
          repeatMinutes: r.repeat_minutes,
          isEnabled: Boolean(r.is_enabled),
          eventType: r.event_type,
          eventIcon: looksLikeEmoji(r.icon_url) ? r.icon_url : DEFAULT_EVENT_ICON,
          customEventId: r.custom_event_id,
          createdBy: r.created_by,
          createdAt: normalizeStoredUtcTimestamp(r.created_at),
          lastNotification: r.last_notification,
          nextNotification: r.next_notification,
          autoDisabledAt: r.auto_disabled_at,
        };
      });
    },
  );

  fastify.get<{ Params: { guildId: string; id: number } }>(
    "/admin/guilds/:guildId/notifications/:id",
    { schema: { params: notificationParams } },
    async (request, reply) => {
      const { guildId, id } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const row = await eventsDb
        .selectFrom("vault_notifications")
        .select([
          "id",
          snowflake("channel_id").as("channel_id"),
          "channel_name",
          "hour",
          "minute",
          "timezone",
          "description",
          "notification_type",
          "mention_type",
          "repeat_enabled",
          "repeat_minutes",
          "is_enabled",
          "event_type",
          "custom_event_id",
          "wizard_batch_id",
          "instance_identifier",
          "custom_delete_delay_minutes",
          snowflake("created_by").as("created_by"),
          "created_at",
          "last_notification",
          "next_notification",
          "auto_disabled_at",
        ])
        .where("id", "=", id)
        .where("guild_id", "=", guildId)
        .executeTakeFirst();
      if (!row) {
        return reply.code(404).send({ error: "notification_not_found" });
      }

      const decoded = decodeDescription(row.description);

      const [weekdays, embed, customEvent] = await Promise.all([
        row.repeat_minutes === -1
          ? eventsDb
              .selectFrom("notification_days")
              .select("weekday")
              .where("notification_id", "=", id)
              .execute()
          : Promise.resolve([]),
        decoded.kind === "embed"
          ? eventsDb
              .selectFrom("vault_notification_embeds")
              .selectAll()
              .where("notification_id", "=", id)
              .executeTakeFirst()
          : Promise.resolve(null),
        row.custom_event_id !== null
          ? eventsDb
              .selectFrom("custom_events")
              .select(["id", "name", "icon_url", "first_occurrence", "recurrence_type", "recurrence_interval"])
              .where("id", "=", row.custom_event_id)
              .executeTakeFirst()
          : Promise.resolve(null),
      ]);

      return {
        id: row.id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        hour: row.hour,
        minute: row.minute,
        timezone: row.timezone,
        descriptionKind: decoded.kind,
        descriptionText: decoded.text,
        customTimes: decoded.customTimes,
        notificationType: row.notification_type,
        mentionType: row.mention_type,
        repeatEnabled: Boolean(row.repeat_enabled),
        repeatMinutes: row.repeat_minutes,
        isEnabled: Boolean(row.is_enabled),
        eventType: row.event_type,
        customEventId: row.custom_event_id,
        wizardBatchId: row.wizard_batch_id,
        instanceIdentifier: row.instance_identifier,
        customDeleteDelayMinutes: row.custom_delete_delay_minutes,
        createdBy: row.created_by,
        createdAt: normalizeStoredUtcTimestamp(row.created_at),
        lastNotification: row.last_notification,
        nextNotification: row.next_notification,
        autoDisabledAt: row.auto_disabled_at,
        weekdays: parseWeekdayRows(weekdays),
        embed: embed
          ? {
              title: embed.title,
              description: embed.description,
              color: embed.color,
              imageUrl: embed.image_url,
              thumbnailUrl: embed.thumbnail_url,
              footer: embed.footer,
              author: embed.author,
              mentionMessage: embed.mention_message,
            }
          : null,
        customEvent: customEvent
          ? {
              id: customEvent.id,
              name: customEvent.name,
              iconUrl: customEvent.icon_url,
              firstOccurrence: customEvent.first_occurrence,
              recurrenceType: customEvent.recurrence_type,
              recurrenceInterval: customEvent.recurrence_interval,
            }
          : null,
      };
    },
  );

  fastify.get<{ Params: { guildId: string; id: number }; Querystring: { limit?: number; offset?: number } }>(
    "/admin/guilds/:guildId/notifications/:id/history",
    { schema: { params: notificationParams, querystring: historyQuerystring } },
    async (request, reply) => {
      const { guildId, id } = request.params;
      const limit = request.query.limit ?? 50;
      const offset = request.query.offset ?? 0;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const notification = await eventsDb
        .selectFrom("vault_notifications")
        .select("id")
        .where("id", "=", id)
        .where("guild_id", "=", guildId)
        .executeTakeFirst();
      if (!notification) {
        return reply.code(404).send({ error: "notification_not_found" });
      }

      const rows = await eventsDb
        .selectFrom("notification_history")
        .select([
          "id",
          "notification_time",
          "sent_at",
          snowflake("message_id").as("message_id"),
          snowflake("channel_id").as("channel_id"),
          "scheduled_delete_at",
          "deleted_at",
        ])
        .where("notification_id", "=", id)
        .orderBy("sent_at", "desc")
        .limit(limit + 1)
        .offset(offset)
        .execute();

      const hasMore = rows.length > limit;
      return {
        rows: rows.slice(0, limit).map((r) => ({
          id: r.id,
          notificationTime: r.notification_time,
          sentAt: normalizeStoredUtcTimestamp(r.sent_at),
          messageId: r.message_id,
          channelId: r.channel_id,
          scheduledDeleteAt: r.scheduled_delete_at,
          deletedAt: r.deleted_at,
        })),
        hasMore,
      };
    },
  );

  fastify.get<{ Params: { guildId: string } }>(
    "/admin/guilds/:guildId/vault-trap-settings",
    { schema: { params: guildIdParam } },
    async (request, reply) => {
      const { guildId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const row = await eventsDb
        .selectFrom("vault_trap_settings")
        .select(["delete_messages_enabled", "default_delete_delay_minutes", "show_daily_reset_on_schedule"])
        .where("guild_id", "=", guildId)
        .executeTakeFirst();

      // Defaults mirror the CREATE TABLE column defaults in
      // notification_system.py -- a guild with zero notifications yet
      // has no row at all (the INSERT OR IGNORE seed only runs for
      // guild_ids already present in vault_notifications).
      return {
        deleteMessagesEnabled: row ? Boolean(row.delete_messages_enabled) : true,
        defaultDeleteDelayMinutes: row?.default_delete_delay_minutes ?? 60,
        showDailyResetOnSchedule: row ? Boolean(row.show_daily_reset_on_schedule) : false,
      };
    },
  );

  fastify.post<{
    Params: { guildId: string };
    Body: {
      channelId: string;
      channelName?: string | null;
      date: string;
      hour: number;
      minute: number;
      timezone: string;
      messageKind?: "plain" | "embed";
      description?: string;
      embed?: EmbedInput;
      notificationType: number;
      mentionType: string;
      repeatMinutes: number;
      weekdays?: number[];
      eventType?: string | null;
    };
  }>(
    "/admin/guilds/:guildId/notifications",
    { schema: { params: guildIdParam, body: createNotificationBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const { guildId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }
      const {
        channelId, channelName, date, hour, minute, timezone, messageKind, description, embed,
        notificationType, mentionType, repeatMinutes, weekdays, eventType,
      } = request.body;

      if (messageKind !== "embed" && !description?.trim()) {
        return reply.code(400).send({ error: "description_required" });
      }
      if (description !== undefined && hasReservedDescriptionPrefix(description)) {
        return reply.code(400).send({ error: "description_reserved_prefix" });
      }
      if (!isValidTimezone(timezone)) {
        return reply.code(400).send({ error: "invalid_timezone" });
      }
      if (isPastDateInTimezone(date, timezone)) {
        return reply.code(400).send({ error: "date_in_past" });
      }

      const nextNotification = localizedIsoString(date, hour, minute, timezone);
      // repeat_enabled is derived from repeat_minutes, matching
      // update_notification()'s `1 if repeat_minutes != 0 else 0` --
      // kept consistent between create and edit rather than exposing a
      // separate, redundant checkbox.
      const repeatEnabled = repeatMinutes !== 0;

      const result = await eventsDb
        .insertInto("vault_notifications")
        .values({
          guild_id: guildId,
          channel_id: channelId,
          channel_name: channelName ?? null,
          hour,
          minute,
          timezone,
          description: buildDescription(messageKind, description, embed),
          notification_type: notificationType,
          mention_type: mentionType,
          repeat_enabled: repeatEnabled ? 1 : 0,
          repeat_minutes: repeatMinutes,
          created_by: ctx.discordId,
          next_notification: nextNotification,
          event_type: eventType ?? null,
        })
        .executeTakeFirst();
      const newId = Number(result.insertId);

      // Schema's if/then already guarantees `weekdays` is present and
      // non-empty when repeatMinutes === -1.
      if (repeatMinutes === -1) {
        await eventsDb
          .insertInto("notification_days")
          .values({ notification_id: newId, weekday: encodeWeekdays(weekdays!) })
          .execute();
      }

      // Schema's if/then already guarantees `embed` is present when
      // messageKind === "embed".
      if (messageKind === "embed") {
        await writeEmbedRow(newId, embed!);
      }

      await logAppAction({
        actorId: ctx.discordId,
        guildId,
        action: "notification_created",
        resourceType: "notification",
        resourceId: String(newId),
        detail: eventType ?? undefined,
      });

      return reply.code(201).send({ ok: true, id: newId });
    },
  );

  fastify.patch<{
    Params: { guildId: string; id: number };
    Body: {
      hour: number;
      minute: number;
      timezone: string;
      messageKind?: "plain" | "embed";
      description?: string;
      embed?: EmbedInput;
      notificationType: number;
      mentionType: string;
      repeatMinutes: number;
      weekdays?: number[];
      eventType?: string | null;
    };
  }>(
    "/admin/guilds/:guildId/notifications/:id",
    { schema: { params: notificationParams, body: editNotificationBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const { guildId, id } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const existing = await eventsDb
        .selectFrom("vault_notifications")
        .select(["id", "next_notification"])
        .where("id", "=", id)
        .where("guild_id", "=", guildId)
        .executeTakeFirst();
      if (!existing) {
        return reply.code(404).send({ error: "notification_not_found" });
      }

      const {
        hour, minute, timezone, messageKind, description, embed,
        notificationType, mentionType, repeatMinutes, weekdays, eventType,
      } = request.body;

      if (messageKind !== "embed" && !description?.trim()) {
        return reply.code(400).send({ error: "description_required" });
      }
      if (description !== undefined && hasReservedDescriptionPrefix(description)) {
        return reply.code(400).send({ error: "description_reserved_prefix" });
      }
      if (!isValidTimezone(timezone)) {
        return reply.code(400).send({ error: "invalid_timezone" });
      }

      // Keep the existing date, swap only hour/minute -- mirrors
      // update_notification()'s no-start_date fallback branch exactly,
      // offset quirk included (see timezone.ts's replaceHourMinute doc
      // comment). Only falls back to computing fresh (using the NEW
      // timezone, matching the Python `else` branch) if there's
      // somehow no prior value to inherit from.
      const nextNotification = existing.next_notification
        ? replaceHourMinute(existing.next_notification, hour, minute)
        : localizedIsoString(new Date().toISOString().slice(0, 10), hour, minute, timezone);
      const repeatEnabled = repeatMinutes !== 0;

      await eventsDb
        .updateTable("vault_notifications")
        .set({
          hour,
          minute,
          timezone,
          description: buildDescription(messageKind, description, embed),
          notification_type: notificationType,
          mention_type: mentionType,
          repeat_enabled: repeatEnabled ? 1 : 0,
          repeat_minutes: repeatMinutes,
          event_type: eventType ?? null,
          next_notification: nextNotification,
        })
        .where("id", "=", id)
        .execute();

      // Mirrors update_notification()'s exact branching: entering/staying
      // in weekday mode replaces the day row; leaving it (or never being
      // in it) just clears any stale one. Schema's if/then already
      // guarantees `weekdays` is present when repeatMinutes === -1.
      await eventsDb.deleteFrom("notification_days").where("notification_id", "=", id).execute();
      if (repeatMinutes === -1) {
        await eventsDb
          .insertInto("notification_days")
          .values({ notification_id: id, weekday: encodeWeekdays(weekdays!) })
          .execute();
      }

      // Unlike update_notification() (which leaves a stale embed row
      // behind when editing away from embed mode without passing
      // embed_data -- a real gap in the source), clean it up here: it
      // can never be read again once the description no longer carries
      // "EMBED_MESSAGE:", so there's no user-visible behavior to
      // preserve by leaving it, only orphaned data. Schema's if/then
      // already guarantees `embed` is present when messageKind === "embed".
      if (messageKind === "embed") {
        await writeEmbedRow(id, embed!);
      } else {
        await eventsDb.deleteFrom("vault_notification_embeds").where("notification_id", "=", id).execute();
      }

      await logAppAction({
        actorId: ctx.discordId,
        guildId,
        action: "notification_updated",
        resourceType: "notification",
        resourceId: String(id),
        detail: eventType ?? undefined,
      });

      return { ok: true };
    },
  );

  fastify.patch<{ Params: { guildId: string; id: number }; Body: { enabled: boolean } }>(
    "/admin/guilds/:guildId/notifications/:id/enabled",
    { schema: { params: notificationParams, body: enabledBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const { guildId, id } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const result = await eventsDb
        .updateTable("vault_notifications")
        .set({ is_enabled: request.body.enabled ? 1 : 0 })
        .where("id", "=", id)
        .where("guild_id", "=", guildId)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        return reply.code(404).send({ error: "notification_not_found" });
      }

      await logAppAction({
        actorId: ctx.discordId,
        guildId,
        action: request.body.enabled ? "notification_enabled" : "notification_disabled",
        resourceType: "notification",
        resourceId: String(id),
      });

      return { ok: true };
    },
  );

  fastify.delete<{ Params: { guildId: string; id: number } }>(
    "/admin/guilds/:guildId/notifications/:id",
    { schema: { params: notificationParams }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const { guildId, id } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const existing = await eventsDb
        .selectFrom("vault_notifications")
        .select("id")
        .where("id", "=", id)
        .where("guild_id", "=", guildId)
        .executeTakeFirst();
      if (!existing) {
        return reply.code(404).send({ error: "notification_not_found" });
      }

      await deleteNotificationRow(id);

      await logAppAction({
        actorId: ctx.discordId,
        guildId,
        action: "notification_deleted",
        resourceType: "notification",
        resourceId: String(id),
      });

      return { ok: true };
    },
  );
}
