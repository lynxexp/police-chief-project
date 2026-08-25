/**
 * Notification templates -- Phase 2, Stage 7f.
 *
 * Investigated the Python source (cogs/notification_templates.py) before
 * building this: there is NO create path anywhere in the bot.
 * `_populate_default_templates()` and `_sync_default_templates()` are
 * both explicit no-ops ("Police Chief has no global event registry...
 * ships with zero pre-filled events"), `reset_template_to_default()`
 * always returns False, and the only write method is `update_template()`,
 * which edits an EXISTING row's embed fields. The table starts empty and
 * has no way to ever gain a row via the bot -- the Discord "Event
 * Templates" browser is permanently unreachable in production. The
 * preview UI's claim that "This template will be automatically applied
 * by the Setup Wizard" is also dead: notification_wizard.py never reads
 * this table at all.
 *
 * Per explicit user decision, this is built as full CRUD on the web
 * (create/list/edit/delete) rather than a strict port -- the web becomes
 * the actual way this table gets populated and used, including a real
 * "apply to notification form" flow that the bot itself never had.
 *
 * No guild_id column exists on this table -- templates are bot-wide, not
 * per-guild, matching Theming's precedent (pimpsettings also has no
 * guild concept). Gated Owner/Global only for the same reason theme CRUD
 * is: this is bot-wide configuration, not a per-guild resource.
 *
 * is_global historically meant "still matches system defaults,
 * unmodified" for a bot that HAD defaults to diverge from. Police Chief
 * never has any, so every template that exists here is inherently
 * admin-authored -- this column is written as 0 unconditionally (mirrors
 * update_template()'s own behavior) and not exposed as a user-facing
 * toggle; it has no meaningful value to set here.
 *
 * embed_color is stored as TEXT (a decimal string), not INTEGER, unlike
 * vault_notification_embeds.color -- see TemplatePreviewView's
 * `int(template["embed_color"])` cast at render time. default_times and
 * repeat_config are both JSON-encoded TEXT, in the exact shapes
 * TemplatePreviewView.show_preview() already parses
 * (`{"type": "interval", "minutes": N}` / `{"type": "fixed_days", "days": [...]}`).
 */
import type { FastifyInstance } from "fastify";
import { eventsDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";
import { resolveAuthContext } from "../auth/context.js";
import { normalizeStoredUtcTimestamp } from "../notifications/timezone.js";
import { logAppAction } from "../audit.js";

const templateIdParam = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer" } },
} as const;

const repeatConfigSchema = {
  type: "object",
  required: ["type"],
  properties: {
    type: { type: "string", enum: ["interval", "fixed_days"] },
    minutes: { type: "integer", minimum: 1 },
    days: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, minItems: 1, maxItems: 7, uniqueItems: true },
  },
  allOf: [
    { if: { properties: { type: { const: "interval" } } }, then: { required: ["minutes"] } },
    { if: { properties: { type: { const: "fixed_days" } } }, then: { required: ["days"] } },
  ],
} as const;

const templateBody = {
  type: "object",
  required: ["templateName"],
  properties: {
    templateName: { type: "string", minLength: 1, maxLength: 100 },
    eventType: { type: ["string", "null"], maxLength: 100 },
    description: { type: ["string", "null"], maxLength: 1000 },
    // 1-5 = preset reminder offsets; 6 = customTimes (required then).
    notificationType: { type: ["integer", "null"], minimum: 1, maximum: 6 },
    customTimes: { type: "array", items: { type: "integer", minimum: 0 }, minItems: 1, maxItems: 20 },
    repeatConfig: { anyOf: [repeatConfigSchema, { type: "null" }] },
    embedTitle: { type: ["string", "null"], maxLength: 256 },
    embedDescription: { type: ["string", "null"], maxLength: 4000 },
    embedColor: { type: ["integer", "null"], minimum: 0, maximum: 16777215 },
    embedImageUrl: { type: ["string", "null"], maxLength: 512, pattern: "^https?://" },
    embedThumbnailUrl: { type: ["string", "null"], maxLength: 512, pattern: "^https?://" },
    footer: { type: ["string", "null"], maxLength: 2048 },
    author: { type: ["string", "null"], maxLength: 256 },
    mentionMessage: { type: ["string", "null"], maxLength: 2000 },
  },
  if: { properties: { notificationType: { const: 6 } } },
  then: { required: ["customTimes"] },
} as const;

interface TemplateBody {
  templateName: string;
  eventType?: string | null;
  description?: string | null;
  notificationType?: number | null;
  customTimes?: number[];
  repeatConfig?: { type: "interval" | "fixed_days"; minutes?: number; days?: number[] } | null;
  embedTitle?: string | null;
  embedDescription?: string | null;
  embedColor?: number | null;
  embedImageUrl?: string | null;
  embedThumbnailUrl?: string | null;
  footer?: string | null;
  author?: string | null;
  mentionMessage?: string | null;
}

function toRow(body: TemplateBody, createdBy: string) {
  return {
    template_name: body.templateName,
    event_type: body.eventType ?? null,
    description: body.description ?? null,
    notification_type: body.notificationType ?? null,
    default_times: body.notificationType === 6 && body.customTimes ? JSON.stringify(body.customTimes) : null,
    repeat_config: body.repeatConfig ? JSON.stringify(body.repeatConfig) : null,
    embed_title: body.embedTitle ?? null,
    embed_description: body.embedDescription ?? null,
    embed_color: body.embedColor !== undefined && body.embedColor !== null ? String(body.embedColor) : null,
    embed_image_url: body.embedImageUrl ?? null,
    embed_thumbnail_url: body.embedThumbnailUrl ?? null,
    footer: body.footer ?? null,
    author: body.author ?? null,
    mention_message: body.mentionMessage ?? null,
    // Every web-created/edited template is inherently admin-authored --
    // see this file's doc comment on is_global.
    is_global: 0,
    created_by: createdBy,
  };
}

export default async function templateRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get("/admin/templates", async (request, reply) => {
    const ctx = await resolveAuthContext(request.session!);
    if (!ctx.isGlobal) {
      return reply.code(403).send({ error: "global_admin_required" });
    }

    const rows = await eventsDb
      .selectFrom("notification_templates")
      .select([
        "template_id", "template_name", "event_type", "description", "notification_type",
        "embed_title", snowflake("created_by").as("created_by"), "created_at",
      ])
      .orderBy("template_name", "asc")
      .execute();

    return rows.map((r) => ({
      templateId: r.template_id,
      templateName: r.template_name,
      eventType: r.event_type,
      description: r.description,
      notificationType: r.notification_type,
      embedTitle: r.embed_title,
      createdBy: r.created_by,
      createdAt: normalizeStoredUtcTimestamp(r.created_at),
    }));
  });

  fastify.get<{ Params: { id: number } }>(
    "/admin/templates/:id",
    { schema: { params: templateIdParam } },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }

      const row = await eventsDb
        .selectFrom("notification_templates")
        .select([
          "template_id", "template_name", "event_type", "description", "notification_type",
          "default_times", "repeat_config", "embed_title", "embed_description", "embed_color",
          "embed_image_url", "embed_thumbnail_url", "footer", "author", "mention_message",
          snowflake("created_by").as("created_by"), "created_at",
        ])
        .where("template_id", "=", request.params.id)
        .executeTakeFirst();
      if (!row) {
        return reply.code(404).send({ error: "template_not_found" });
      }

      return {
        templateId: row.template_id,
        templateName: row.template_name,
        eventType: row.event_type,
        description: row.description,
        notificationType: row.notification_type,
        customTimes: row.default_times ? (JSON.parse(row.default_times) as number[]) : null,
        repeatConfig: row.repeat_config ? JSON.parse(row.repeat_config) : null,
        embedTitle: row.embed_title,
        embedDescription: row.embed_description,
        embedColor: row.embed_color ? parseInt(row.embed_color, 10) : null,
        embedImageUrl: row.embed_image_url,
        embedThumbnailUrl: row.embed_thumbnail_url,
        footer: row.footer,
        author: row.author,
        mentionMessage: row.mention_message,
        createdBy: row.created_by,
        createdAt: normalizeStoredUtcTimestamp(row.created_at),
      };
    },
  );

  fastify.post<{ Body: TemplateBody }>(
    "/admin/templates",
    { schema: { body: templateBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }

      const result = await eventsDb
        .insertInto("notification_templates")
        .values(toRow(request.body, ctx.discordId))
        .executeTakeFirst();
      const newId = Number(result.insertId);

      await logAppAction({
        actorId: ctx.discordId,
        guildId: null,
        action: "template_created",
        resourceType: "template",
        resourceId: String(newId),
        detail: request.body.templateName,
      });

      return reply.code(201).send({ ok: true, id: newId });
    },
  );

  fastify.patch<{ Params: { id: number }; Body: TemplateBody }>(
    "/admin/templates/:id",
    { schema: { params: templateIdParam, body: templateBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }

      const result = await eventsDb
        .updateTable("notification_templates")
        .set(toRow(request.body, ctx.discordId))
        .where("template_id", "=", request.params.id)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        return reply.code(404).send({ error: "template_not_found" });
      }

      await logAppAction({
        actorId: ctx.discordId,
        guildId: null,
        action: "template_updated",
        resourceType: "template",
        resourceId: String(request.params.id),
        detail: request.body.templateName,
      });

      return { ok: true };
    },
  );

  fastify.delete<{ Params: { id: number } }>(
    "/admin/templates/:id",
    { schema: { params: templateIdParam }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }

      const result = await eventsDb
        .deleteFrom("notification_templates")
        .where("template_id", "=", request.params.id)
        .executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) {
        return reply.code(404).send({ error: "template_not_found" });
      }

      await logAppAction({
        actorId: ctx.discordId,
        guildId: null,
        action: "template_deleted",
        resourceType: "template",
        resourceId: String(request.params.id),
      });

      return { ok: true };
    },
  );
}
