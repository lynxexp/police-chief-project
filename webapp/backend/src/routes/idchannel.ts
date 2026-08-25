/**
 * ID channel scanning + self-registration settings -- Phase 2. Three
 * independent scopes, each with its own gate:
 *  - register_settings: a single bot-wide row (settings.sqlite), no
 *    guild/alliance concept at all -- Owner/Global only.
 *  - id_channel_settings: per-guild scan config (id_channel.sqlite) --
 *    guild-wide, uses the new canManageGuild (Server tier and above).
 *  - id_channels: which channels are registered per alliance -- carries
 *    its own alliance_id, so uses the existing canManageAlliance (any
 *    tier with reach to that specific alliance, same as channel setup).
 */
import type { FastifyInstance } from "fastify";
import { settingsDb, idChannelDb, allianceDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";
import { canManageAlliance } from "../auth/permissions.js";
import { resolveAuthContext, canManageGuild, effectiveGuildId } from "../auth/context.js";

const allianceIdParam = {
  type: "object",
  required: ["allianceId"],
  properties: { allianceId: { type: "integer" } },
} as const;

const guildIdParam = {
  type: "object",
  required: ["guildId"],
  properties: { guildId: { type: "string", pattern: "^[0-9]+$" } },
} as const;

const idChannelParams = {
  type: "object",
  required: ["allianceId", "channelId"],
  properties: {
    allianceId: { type: "integer" },
    channelId: { type: "string", pattern: "^[0-9]+$" },
  },
} as const;

const registerSettingsBody = {
  type: "object",
  required: ["enabled"],
  properties: { enabled: { type: "boolean" } },
} as const;

const idChannelSettingsBody = {
  type: "object",
  properties: {
    scanEnabled: { type: "boolean" },
    scanLimit: { type: "integer", minimum: 1 },
    deleteAfter: { type: "integer", minimum: 0 },
    respondToInvalid: { type: "boolean" },
  },
} as const;

const addIdChannelBody = {
  type: "object",
  required: ["channelId"],
  properties: { channelId: { type: "string", pattern: "^[0-9]+$" } },
} as const;

export default async function idChannelRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get("/admin/register-settings", async (request, reply) => {
    const ctx = await resolveAuthContext(request.session!);
    if (!ctx.isGlobal) {
      return reply.code(403).send({ error: "global_admin_required" });
    }
    const row = await settingsDb.selectFrom("register_settings").select("enabled").executeTakeFirst();
    return { enabled: Boolean(row?.enabled) };
  });

  fastify.patch<{ Body: { enabled: boolean } }>(
    "/admin/register-settings",
    { schema: { body: registerSettingsBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }
      const { enabled } = request.body;

      const existing = await settingsDb.selectFrom("register_settings").select("enabled").executeTakeFirst();
      if (existing) {
        await settingsDb.updateTable("register_settings").set({ enabled: enabled ? 1 : 0 }).execute();
      } else {
        await settingsDb.insertInto("register_settings").values({ enabled: enabled ? 1 : 0 }).execute();
      }
      return { ok: true };
    },
  );

  fastify.get<{ Params: { guildId: string } }>(
    "/admin/guilds/:guildId/id-channel-settings",
    { schema: { params: guildIdParam } },
    async (request, reply) => {
      const { guildId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const row = await idChannelDb
        .selectFrom("id_channel_settings")
        .select(["scan_enabled", "scan_limit", "delete_after", "respond_to_invalid"])
        .where("guild_id", "=", guildId)
        .executeTakeFirst();
      return {
        scanEnabled: row ? Boolean(row.scan_enabled) : true,
        scanLimit: row?.scan_limit ?? 50,
        deleteAfter: row?.delete_after ?? 10,
        respondToInvalid: row ? Boolean(row.respond_to_invalid) : false,
      };
    },
  );

  fastify.patch<{
    Params: { guildId: string };
    Body: { scanEnabled?: boolean; scanLimit?: number; deleteAfter?: number; respondToInvalid?: boolean };
  }>(
    "/admin/guilds/:guildId/id-channel-settings",
    { schema: { params: guildIdParam, body: idChannelSettingsBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const { guildId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!canManageGuild(ctx, guildId)) {
        return reply.code(403).send({ error: "not_guild_admin" });
      }

      const body = request.body;
      const patch: Record<string, number> = {};
      if ("scanEnabled" in body) patch.scan_enabled = body.scanEnabled ? 1 : 0;
      if ("scanLimit" in body && body.scanLimit !== undefined) patch.scan_limit = body.scanLimit;
      if ("deleteAfter" in body && body.deleteAfter !== undefined) patch.delete_after = body.deleteAfter;
      if ("respondToInvalid" in body) patch.respond_to_invalid = body.respondToInvalid ? 1 : 0;
      if (Object.keys(patch).length === 0) {
        return reply.code(400).send({ error: "no_fields_to_update" });
      }

      const existing = await idChannelDb
        .selectFrom("id_channel_settings")
        .select("guild_id")
        .where("guild_id", "=", guildId)
        .executeTakeFirst();
      if (existing) {
        await idChannelDb
          .updateTable("id_channel_settings")
          .set(patch)
          .where("guild_id", "=", guildId)
          .execute();
      } else {
        await idChannelDb
          .insertInto("id_channel_settings")
          .values({ guild_id: guildId, ...patch })
          .execute();
      }
      return { ok: true };
    },
  );

  fastify.get<{ Params: { allianceId: number } }>(
    "/admin/alliances/:allianceId/id-channels",
    { schema: { params: allianceIdParam } },
    async (request, reply) => {
      const { allianceId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }

      const rows = await idChannelDb
        .selectFrom("id_channels")
        .select([snowflake("channel_id").as("channel_id"), "created_at", snowflake("created_by").as("created_by")])
        .where("alliance_id", "=", allianceId)
        .execute();
      return rows.map((r) => ({
        channelId: r.channel_id,
        createdAt: r.created_at,
        createdBy: r.created_by,
      }));
    },
  );

  fastify.post<{ Params: { allianceId: number }; Body: { channelId: string } }>(
    "/admin/alliances/:allianceId/id-channels",
    { schema: { params: allianceIdParam, body: addIdChannelBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const { allianceId } = request.params;
      const { channelId } = request.body;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }

      const alliance = await allianceDb
        .selectFrom("alliance_list")
        .select(snowflake("discord_server_id").as("discord_server_id"))
        .where("alliance_id", "=", allianceId)
        .executeTakeFirst();
      if (!alliance?.discord_server_id) {
        return reply.code(404).send({ error: "alliance_has_no_guild" });
      }

      const existing = await idChannelDb
        .selectFrom("id_channels")
        .select("channel_id")
        .where("guild_id", "=", alliance.discord_server_id)
        .where("channel_id", "=", channelId)
        .executeTakeFirst();
      if (existing) {
        return reply.code(409).send({ error: "channel_already_registered" });
      }

      await idChannelDb
        .insertInto("id_channels")
        .values({
          guild_id: alliance.discord_server_id,
          alliance_id: allianceId,
          channel_id: channelId,
          created_at: new Date().toISOString(),
          created_by: ctx.discordId,
        })
        .execute();
      return reply.code(201).send({ ok: true });
    },
  );

  fastify.delete<{ Params: { allianceId: number; channelId: string } }>(
    "/admin/alliances/:allianceId/id-channels/:channelId",
    { schema: { params: idChannelParams }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const { allianceId, channelId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }

      await idChannelDb
        .deleteFrom("id_channels")
        .where("alliance_id", "=", allianceId)
        .where("channel_id", "=", channelId)
        .execute();
      return { ok: true };
    },
  );
}
