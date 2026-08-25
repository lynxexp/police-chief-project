/**
 * Theming ("Pimp My Bot") -- Phase 2 full editor. Theme CRUD (create/
 * edit/delete, global default) is Owner/Global-only: pimpsettings has no
 * guild concept at all, a theme is a bot-wide named preset, not a
 * per-guild resource. The ONLY guild-scoped piece is server_themes
 * (which theme a given guild uses), gated by the new canManageGuild
 * (Server tier and above) -- matches the plan doc's guild-wide-settings
 * decision.
 */
import type { FastifyInstance } from "fastify";
import { pimpmybotDb } from "../db/connections.js";
import { resolveAuthContext, canManageGuild } from "../auth/context.js";
import { EDITABLE_THEME_COLUMNS } from "../theming/icons.js";
import { logAppAction } from "../audit.js";

const themeNameParam = {
  type: "object",
  required: ["themeName"],
  properties: { themeName: { type: "string", minLength: 1 } },
} as const;

const guildIdParam = {
  type: "object",
  required: ["guildId"],
  properties: { guildId: { type: "string", pattern: "^[0-9]+$" } },
} as const;

const createThemeBody = {
  type: "object",
  required: ["themeName"],
  properties: {
    themeName: { type: "string", minLength: 1, maxLength: 64 },
    themeDescription: { type: "string" },
  },
} as const;

// Deliberately loose schema (additionalProperties: true) -- the REAL
// safety check is EDITABLE_THEME_COLUMNS below, validated per-key before
// touching SQL. AJV can't easily express "any of these ~150 known keys."
const patchThemeBody = { type: "object" } as const;

const guildThemeBody = {
  type: "object",
  required: ["themeName"],
  properties: { themeName: { type: ["string", "null"] } },
} as const;

export default async function themingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get("/admin/themes", async (request, reply) => {
    const ctx = await resolveAuthContext(request.session!);
    if (!ctx.isGlobal) {
      return reply.code(403).send({ error: "global_admin_required" });
    }
    const rows = await pimpmybotDb
      .selectFrom("pimpsettings")
      .select(["themeName", "themeCreator", "themeDescription", "is_active", "createdAt"])
      .orderBy("themeName", "asc")
      .execute();
    return rows.map((r) => ({
      themeName: r.themeName,
      themeCreator: r.themeCreator,
      themeDescription: r.themeDescription,
      isActive: Boolean(r.is_active),
      createdAt: r.createdAt,
    }));
  });

  fastify.get<{ Params: { themeName: string } }>(
    "/admin/themes/:themeName",
    { schema: { params: themeNameParam } },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }
      const row = await pimpmybotDb
        .selectFrom("pimpsettings")
        .selectAll()
        .where("themeName", "=", request.params.themeName)
        .executeTakeFirst();
      if (!row) {
        return reply.code(404).send({ error: "theme_not_found" });
      }
      return row;
    },
  );

  fastify.post<{ Body: { themeName: string; themeDescription?: string } }>(
    "/admin/themes",
    { schema: { body: createThemeBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }
      const { themeName, themeDescription } = request.body;

      const existing = await pimpmybotDb
        .selectFrom("pimpsettings")
        .select("themeName")
        .where("themeName", "=", themeName)
        .executeTakeFirst();
      if (existing) {
        return reply.code(409).send({ error: "theme_already_exists" });
      }

      // Clone the live "default" theme row rather than a hardcoded
      // static snapshot -- mirrors create_theme_with_metadata()'s
      // copy-then-override behavior, and stays correct even if
      // "default"'s own values are ever edited.
      const base = await pimpmybotDb
        .selectFrom("pimpsettings")
        .selectAll()
        .where("themeName", "=", "default")
        .executeTakeFirst();
      if (!base) {
        return reply.code(500).send({ error: "default_theme_missing" });
      }

      const { id: _id, ...baseFields } = base;
      await pimpmybotDb
        .insertInto("pimpsettings")
        .values({
          ...baseFields,
          themeName,
          themeCreator: ctx.discordId,
          themeDescription: themeDescription ?? "",
          createdAt: new Date().toISOString(),
          is_active: 0,
          created_guild_id: null,
        })
        .execute();

      await logAppAction({
        actorId: ctx.discordId,
        guildId: null,
        action: "theme_created",
        resourceType: "theme",
        resourceId: themeName,
        detail: themeDescription || undefined,
      });

      return reply.code(201).send({ ok: true });
    },
  );

  fastify.patch<{ Params: { themeName: string }; Body: Record<string, unknown> }>(
    "/admin/themes/:themeName",
    { schema: { params: themeNameParam, body: patchThemeBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }
      const { themeName } = request.params;
      const body = request.body;

      const patch: Record<string, string | number | null> = {};
      for (const [key, value] of Object.entries(body)) {
        if (!EDITABLE_THEME_COLUMNS.has(key)) {
          return reply.code(400).send({ error: "unknown_field", field: key });
        }
        if (key.startsWith("dividerLength")) {
          if (typeof value !== "number") {
            return reply.code(400).send({ error: "invalid_field_type", field: key });
          }
          patch[key] = value;
        } else if (key.startsWith("dividerCodeBlock")) {
          patch[key] = value ? 1 : 0;
        } else {
          if (value !== null && typeof value !== "string") {
            return reply.code(400).send({ error: "invalid_field_type", field: key });
          }
          patch[key] = value;
        }
      }
      if (Object.keys(patch).length === 0) {
        return reply.code(400).send({ error: "no_fields_to_update" });
      }

      const result = await pimpmybotDb
        .updateTable("pimpsettings")
        .set(patch)
        .where("themeName", "=", themeName)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        return reply.code(404).send({ error: "theme_not_found" });
      }

      await logAppAction({
        actorId: ctx.discordId,
        guildId: null,
        action: "theme_updated",
        resourceType: "theme",
        resourceId: themeName,
        detail: `${Object.keys(patch).length} field(s) updated`,
      });

      return { ok: true };
    },
  );

  fastify.delete<{ Params: { themeName: string } }>(
    "/admin/themes/:themeName",
    { schema: { params: themeNameParam }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }
      const { themeName } = request.params;

      if (themeName === "default") {
        return reply.code(400).send({ error: "cannot_delete_default_theme" });
      }
      const row = await pimpmybotDb
        .selectFrom("pimpsettings")
        .select("is_active")
        .where("themeName", "=", themeName)
        .executeTakeFirst();
      if (!row) {
        return reply.code(404).send({ error: "theme_not_found" });
      }
      if (row.is_active) {
        return reply.code(400).send({ error: "cannot_delete_active_theme" });
      }

      await pimpmybotDb.deleteFrom("pimpsettings").where("themeName", "=", themeName).execute();
      // Guilds pointing at a deleted theme fall back to the global
      // default -- clean up their now-dangling server_themes rows too.
      await pimpmybotDb.deleteFrom("server_themes").where("theme_name", "=", themeName).execute();

      await logAppAction({
        actorId: ctx.discordId,
        guildId: null,
        action: "theme_deleted",
        resourceType: "theme",
        resourceId: themeName,
      });

      return { ok: true };
    },
  );

  fastify.post<{ Params: { themeName: string } }>(
    "/admin/themes/:themeName/set-active",
    { schema: { params: themeNameParam }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }
      const { themeName } = request.params;

      const row = await pimpmybotDb
        .selectFrom("pimpsettings")
        .select("themeName")
        .where("themeName", "=", themeName)
        .executeTakeFirst();
      if (!row) {
        return reply.code(404).send({ error: "theme_not_found" });
      }

      await pimpmybotDb.transaction().execute(async (trx) => {
        await trx.updateTable("pimpsettings").set({ is_active: 0 }).execute();
        await trx
          .updateTable("pimpsettings")
          .set({ is_active: 1 })
          .where("themeName", "=", themeName)
          .execute();
      });

      await logAppAction({
        actorId: ctx.discordId,
        guildId: null,
        action: "theme_set_active",
        resourceType: "theme",
        resourceId: themeName,
        detail: "set as global default theme",
      });

      return { ok: true };
    },
  );

  fastify.get<{ Params: { guildId: string } }>(
    "/admin/guilds/:guildId/theme",
    { schema: { params: guildIdParam } },
    async (request, reply) => {
      const { guildId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }
      const row = await pimpmybotDb
        .selectFrom("server_themes")
        .select("theme_name")
        .where("guild_id", "=", guildId)
        .executeTakeFirst();
      return { themeName: row?.theme_name ?? null };
    },
  );

  fastify.patch<{ Params: { guildId: string }; Body: { themeName: string | null } }>(
    "/admin/guilds/:guildId/theme",
    { schema: { params: guildIdParam, body: guildThemeBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const { guildId } = request.params;
      const { themeName } = request.body;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      if (themeName === null) {
        await pimpmybotDb.deleteFrom("server_themes").where("guild_id", "=", guildId).execute();

        await logAppAction({
          actorId: ctx.discordId,
          guildId,
          action: "theme_set_active",
          resourceType: "theme",
          resourceId: null,
          detail: "reverted to global default theme",
        });

        return { ok: true };
      }

      const theme = await pimpmybotDb
        .selectFrom("pimpsettings")
        .select("themeName")
        .where("themeName", "=", themeName)
        .executeTakeFirst();
      if (!theme) {
        return reply.code(404).send({ error: "theme_not_found" });
      }

      const existing = await pimpmybotDb
        .selectFrom("server_themes")
        .select("guild_id")
        .where("guild_id", "=", guildId)
        .executeTakeFirst();
      if (existing) {
        await pimpmybotDb
          .updateTable("server_themes")
          .set({ theme_name: themeName })
          .where("guild_id", "=", guildId)
          .execute();
      } else {
        await pimpmybotDb.insertInto("server_themes").values({ guild_id: guildId, theme_name: themeName }).execute();
      }

      await logAppAction({
        actorId: ctx.discordId,
        guildId,
        action: "theme_set_active",
        resourceType: "theme",
        resourceId: themeName,
        detail: "set as this guild's active theme",
      });

      return { ok: true };
    },
  );
}
