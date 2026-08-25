/**
 * Admin views -- alliances list + member roster (read + Stage D writes:
 * deactivate/reactivate/discord-link), channel setup, and permissions
 * (list/add/set-tier/remove/transfer-owner + audit log).
 *
 * Every route re-resolves the caller's tier live (resolveAuthContext) and
 * gates on it exactly the way the Discord UI does -- see
 * cogs/bot_main_menu.py's show_alliance_management (tier !== none) and
 * show_permissions ("Only global administrators can access permissions
 * management", i.e. isGlobal) -- so a demoted admin loses web access on
 * the same ~5s cache window as they lose it in Discord.
 *
 * Every mutation here attaches fastify.csrfProtection (see plugins/csrf.ts)
 * -- explicitly per-route, not plugin-wide, so it doesn't also gate the
 * GET routes living alongside them in this same file.
 */
import type { FastifyInstance } from "fastify";
import { usersDb, allianceDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";
import {
  getAdminAlliances,
  canManageAlliance,
  listAdmins,
  getOwnerId,
  getAuditLogPage,
  addAdmin,
  setTier,
  removeAdmin,
  transferOwner,
  describeState,
  logChange,
  countGlobals,
  PermissionError,
  TIER_NONE,
  TIER_OWNER,
  TIER_GLOBAL,
  TIER_SERVER,
  TIER_ALLIANCE,
  type Tier,
} from "../auth/permissions.js";
import { resolveAuthContext, effectiveGuildId, type AuthContext } from "../auth/context.js";
import { fetchDiscordUserById, fetchGuildChannels } from "../auth/oauth.js";
import { getAppAuditLogPage } from "../audit.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by this plugin's own preHandler once tier !== none is
     * confirmed -- scoped to routes registered on this plugin instance,
     * not global (see plugins/session.ts for the always-global
     * request.session by contrast). */
    authContext?: AuthContext;
  }
}

const allianceIdParam = {
  type: "object",
  required: ["allianceId"],
  properties: { allianceId: { type: "integer" } },
} as const;

const auditLogQuerystring = {
  type: "object",
  properties: {
    offset: { type: "integer", minimum: 0, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
  },
} as const;

const memberFidParams = {
  type: "object",
  required: ["allianceId", "fid"],
  properties: {
    allianceId: { type: "integer" },
    fid: { type: "integer" },
  },
} as const;

// Discord snowflakes (user/guild/channel ids) are always represented as
// digit strings across this API, never JSON numbers -- see db/schema.ts's
// Snowflake doc comment for why a JSON/JS number silently corrupts them.
const snowflakeString = { type: "string", pattern: "^[0-9]+$" } as const;
const nullableSnowflakeString = {
  anyOf: [{ type: "string", pattern: "^[0-9]+$" }, { type: "null" }],
} as const;

const discordLinkBody = {
  type: "object",
  required: ["discordId", "serverId"],
  properties: {
    discordId: snowflakeString,
    serverId: snowflakeString,
  },
} as const;

const channelSettingsBody = {
  type: "object",
  properties: {
    channelId: nullableSnowflakeString,
    redemptionChannelId: nullableSnowflakeString,
    vaultScoreChannel: nullableSnowflakeString,
    capitolScoreChannel: nullableSnowflakeString,
  },
} as const;

const settableTiers: readonly Tier[] = [TIER_GLOBAL, TIER_SERVER, TIER_ALLIANCE];

const addAdminBody = {
  type: "object",
  required: ["discordId", "tier"],
  properties: {
    discordId: snowflakeString,
    tier: { type: "string", enum: settableTiers as unknown as string[] },
    allianceIds: { type: "array", items: { type: "integer" } },
  },
} as const;

const setTierBody = {
  type: "object",
  required: ["tier"],
  properties: {
    tier: { type: "string", enum: settableTiers as unknown as string[] },
    allianceIds: { type: "array", items: { type: "integer" } },
  },
} as const;

const targetIdParam = {
  type: "object",
  required: ["id"],
  properties: { id: snowflakeString },
} as const;

const transferOwnerBody = {
  type: "object",
  required: ["targetId"],
  properties: { targetId: snowflakeString },
} as const;

/** Resolves display names for a batch of Discord ids, deduped, via the
 * bot token -- best-effort, never throws (see fetchDiscordUserById). */
async function resolveNames(discordIds: string[]): Promise<Map<string, string | null>> {
  const uniqueIds = [...new Set(discordIds)];
  const users = await Promise.all(uniqueIds.map((id) => fetchDiscordUserById(id)));
  return new Map(uniqueIds.map((id, i) => [id, users[i]?.global_name ?? users[i]?.username ?? null]));
}

export default async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.addHook("preHandler", async (request, reply) => {
    const ctx = await resolveAuthContext(request.session!);
    if (ctx.tier === TIER_NONE) {
      return reply.code(403).send({ error: "not_an_admin" });
    }
    request.authContext = ctx;
  });

  fastify.get("/admin/alliances", async (request) => {
    const ctx = request.authContext!;
    const { alliances } = await getAdminAlliances(ctx.discordId, effectiveGuildId(ctx));
    return alliances;
  });

  fastify.get<{ Params: { allianceId: number }; Querystring: { activeOnly?: string } }>(
    "/admin/alliances/:allianceId/members",
    { schema: { params: allianceIdParam } },
    async (request, reply) => {
      const ctx = request.authContext!;
      const { allianceId } = request.params;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }

      let query = usersDb
        .selectFrom("users")
        .select([
          "fid",
          "nickname",
          "chief_office_lv",
          "kid",
          "power",
          "combat_power",
          snowflake("discord_id").as("discord_id"),
          snowflake("discord_server_id").as("discord_server_id"),
          "is_active",
          "deactivated_at",
        ])
        .where("alliance", "=", String(allianceId));
      if (request.query.activeOnly === "true") {
        query = query.where("is_active", "=", 1);
      }

      const rows = await query.orderBy("nickname").execute();
      return rows.map((r) => ({
        fid: r.fid,
        nickname: r.nickname,
        chiefOfficeLv: r.chief_office_lv,
        kid: r.kid,
        power: r.power,
        combatPower: r.combat_power,
        discordId: r.discord_id,
        discordServerId: r.discord_server_id,
        isActive: Boolean(r.is_active),
        deactivatedAt: r.deactivated_at,
      }));
    },
  );

  fastify.patch<{ Params: { allianceId: number; fid: number } }>(
    "/admin/alliances/:allianceId/members/:fid/deactivate",
    { schema: { params: memberFidParams }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = request.authContext!;
      const { allianceId, fid } = request.params;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }
      if (!(await memberBelongsToAlliance(fid, allianceId))) {
        return reply.code(404).send({ error: "member_not_found" });
      }

      // Mirrors alliance_member_operations.py's bulk/single deactivate:
      // UPDATE users SET is_active = 0, deactivated_at = ? WHERE fid = ?
      await usersDb
        .updateTable("users")
        .set({ is_active: 0, deactivated_at: new Date().toISOString() })
        .where("fid", "=", fid)
        .execute();
      return { ok: true };
    },
  );

  fastify.patch<{ Params: { allianceId: number; fid: number } }>(
    "/admin/alliances/:allianceId/members/:fid/reactivate",
    { schema: { params: memberFidParams }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = request.authContext!;
      const { allianceId, fid } = request.params;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }
      if (!(await memberBelongsToAlliance(fid, allianceId))) {
        return reply.code(404).send({ error: "member_not_found" });
      }

      // Mirrors reactivate_member (alliance_member_edit.py): no-op if
      // already active, otherwise clears is_active/deactivated_at.
      await usersDb
        .updateTable("users")
        .set({ is_active: 1, deactivated_at: null })
        .where("fid", "=", fid)
        .where("is_active", "=", 0)
        .execute();
      return { ok: true };
    },
  );

  fastify.patch<{ Params: { allianceId: number; fid: number }; Body: { discordId: string; serverId: string } }>(
    "/admin/alliances/:allianceId/members/:fid/discord-link",
    { schema: { params: memberFidParams, body: discordLinkBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = request.authContext!;
      const { allianceId, fid } = request.params;
      const { discordId, serverId } = request.body;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }
      if (!(await memberBelongsToAlliance(fid, allianceId))) {
        return reply.code(404).send({ error: "member_not_found" });
      }

      // Mirrors _attach_discord_to_existing (alliance_registration.py):
      // linking also reactivates -- a member being (re-)linked is the
      // same "re-added" signal a self-registration would send.
      await usersDb
        .updateTable("users")
        .set({
          discord_id: discordId,
          discord_server_id: serverId,
          discord_id_updated_at: new Date().toISOString(),
          is_active: 1,
          deactivated_at: null,
        })
        .where("fid", "=", fid)
        .execute();
      return { ok: true };
    },
  );

  fastify.delete<{ Params: { allianceId: number; fid: number } }>(
    "/admin/alliances/:allianceId/members/:fid/discord-link",
    { schema: { params: memberFidParams }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = request.authContext!;
      const { allianceId, fid } = request.params;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }
      if (!(await memberBelongsToAlliance(fid, allianceId))) {
        return reply.code(404).send({ error: "member_not_found" });
      }

      // Mirrors _detach_discord -- unlinking does NOT touch is_active.
      await usersDb
        .updateTable("users")
        .set({
          discord_id: null,
          discord_server_id: null,
          discord_id_updated_at: new Date().toISOString(),
        })
        .where("fid", "=", fid)
        .execute();
      return { ok: true };
    },
  );

  fastify.get<{ Params: { allianceId: number } }>(
    "/admin/alliances/:allianceId/settings",
    { schema: { params: allianceIdParam } },
    async (request, reply) => {
      const ctx = request.authContext!;
      const { allianceId } = request.params;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }

      const row = await allianceDb
        .selectFrom("alliancesettings")
        .select([
          snowflake("channel_id").as("channel_id"),
          snowflake("redemption_channel_id").as("redemption_channel_id"),
          snowflake("vault_score_channel").as("vault_score_channel"),
          snowflake("capitol_score_channel").as("capitol_score_channel"),
        ])
        .where("alliance_id", "=", allianceId)
        .executeTakeFirst();
      return {
        channelId: row?.channel_id ?? null,
        redemptionChannelId: row?.redemption_channel_id ?? null,
        vaultScoreChannel: row?.vault_score_channel ?? null,
        capitolScoreChannel: row?.capitol_score_channel ?? null,
      };
    },
  );

  fastify.patch<{
    Params: { allianceId: number };
    Body: {
      channelId?: string | null;
      redemptionChannelId?: string | null;
      vaultScoreChannel?: string | null;
      capitolScoreChannel?: string | null;
    };
  }>(
    "/admin/alliances/:allianceId/settings",
    {
      schema: { params: allianceIdParam, body: channelSettingsBody },
      preHandler: fastify.csrfProtection,
    },
    async (request, reply) => {
      const ctx = request.authContext!;
      const { allianceId } = request.params;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }

      const body = request.body;
      const patch: Record<string, string | null> = {};
      if ("channelId" in body) patch.channel_id = body.channelId ?? null;
      if ("redemptionChannelId" in body) patch.redemption_channel_id = body.redemptionChannelId ?? null;
      if ("vaultScoreChannel" in body) patch.vault_score_channel = body.vaultScoreChannel ?? null;
      if ("capitolScoreChannel" in body) patch.capitol_score_channel = body.capitolScoreChannel ?? null;
      if (Object.keys(patch).length === 0) {
        return reply.code(400).send({ error: "no_fields_to_update" });
      }

      const existing = await allianceDb
        .selectFrom("alliancesettings")
        .select("alliance_id")
        .where("alliance_id", "=", allianceId)
        .executeTakeFirst();
      if (existing) {
        await allianceDb
          .updateTable("alliancesettings")
          .set(patch)
          .where("alliance_id", "=", allianceId)
          .execute();
      } else {
        await allianceDb
          .insertInto("alliancesettings")
          .values({ alliance_id: allianceId, ...patch })
          .execute();
      }
      return { ok: true };
    },
  );

  fastify.get<{ Params: { allianceId: number } }>(
    "/admin/alliances/:allianceId/channels",
    { schema: { params: allianceIdParam } },
    async (request, reply) => {
      const ctx = request.authContext!;
      const { allianceId } = request.params;
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

      // Text channels only (type 0) -- the only kind these *_channel
      // settings ever point at.
      const channels = await fetchGuildChannels(alliance.discord_server_id);
      return channels.filter((c) => c.type === 0).map((c) => ({ id: c.id, name: c.name }));
    },
  );

  fastify.get<{ Params: { allianceId: number } }>(
    "/admin/alliances/:allianceId/guild",
    { schema: { params: allianceIdParam } },
    async (request, reply) => {
      const ctx = request.authContext!;
      const { allianceId } = request.params;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }

      // Small, reusable "what guild is this alliance on" lookup -- needed
      // by any guild-scoped admin UI (e.g. ID channel scan settings,
      // canManageGuild-gated) that only has an allianceId to start from.
      const alliance = await allianceDb
        .selectFrom("alliance_list")
        .select(snowflake("discord_server_id").as("discord_server_id"))
        .where("alliance_id", "=", allianceId)
        .executeTakeFirst();
      return { guildId: alliance?.discord_server_id ?? null };
    },
  );

  fastify.get("/admin/permissions", async (request, reply) => {
    const ctx = request.authContext!;
    if (!ctx.isGlobal) {
      return reply.code(403).send({ error: "global_admin_required" });
    }

    const [admins, ownerId] = await Promise.all([listAdmins(), getOwnerId()]);
    const names = await resolveNames(admins.map((a) => a.id));

    return {
      ownerId,
      admins: admins.map((a) => ({ ...a, name: names.get(a.id) ?? null })),
    };
  });

  fastify.get<{ Querystring: { offset?: number; limit?: number } }>(
    "/admin/permissions/audit-log",
    { schema: { querystring: auditLogQuerystring } },
    async (request, reply) => {
      const ctx = request.authContext!;
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }

      const { offset = 0, limit = 10 } = request.query;
      const { rows, total } = await getAuditLogPage(offset, limit);
      const names = await resolveNames(rows.flatMap((r) => [r.actorId, r.targetId]));

      return {
        total,
        rows: rows.map((r) => ({
          ...r,
          actorName: names.get(r.actorId) ?? null,
          targetName: names.get(r.targetId) ?? null,
        })),
      };
    },
  );

  fastify.get<{ Querystring: { offset?: number; limit?: number } }>(
    "/admin/audit-log",
    { schema: { querystring: auditLogQuerystring } },
    async (request, reply) => {
      const ctx = request.authContext!;
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }

      const { offset = 0, limit = 10 } = request.query;
      const { rows, total } = await getAppAuditLogPage(offset, limit);
      const names = await resolveNames(rows.map((r) => r.actorId));

      return {
        total,
        rows: rows.map((r) => ({ ...r, actorName: names.get(r.actorId) ?? null })),
      };
    },
  );

  // -------------------------------------------------------------------
  // Permissions writes -- highest blast radius in this app (a mistake
  // here can lock out admin access entirely), so every guard from the
  // Discord UI (bot_main_menu.py's AdminContextView/TransferOwnerView) is
  // replicated here rather than trusting permissions.ts's own guards
  // alone: self-removal-would-zero-globals is a UI-layer check in Python
  // (not inside PermissionManager.remove_admin), so it has to be
  // reimplemented at this same layer here too.
  // -------------------------------------------------------------------

  fastify.post<{ Body: { discordId: string; tier: Tier; allianceIds?: number[] } }>(
    "/admin/permissions",
    { schema: { body: addAdminBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = request.authContext!;
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }
      const { discordId, tier, allianceIds } = request.body;

      const before = await describeState(discordId);
      try {
        await addAdmin(discordId, { tier, allianceIds });
      } catch (err) {
        if (err instanceof PermissionError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
      await logChange(ctx.discordId, "add_admin", discordId, before, await describeState(discordId));
      return { ok: true };
    },
  );

  fastify.patch<{ Params: { id: string }; Body: { tier: Tier; allianceIds?: number[] } }>(
    "/admin/permissions/:id",
    { schema: { params: targetIdParam, body: setTierBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = request.authContext!;
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }
      const { id } = request.params;
      const { tier, allianceIds } = request.body;

      const before = await describeState(id);
      try {
        await setTier(id, tier, { allianceIds });
      } catch (err) {
        if (err instanceof PermissionError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
      await logChange(ctx.discordId, "set_tier", id, before, await describeState(id));
      return { ok: true };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/admin/permissions/:id",
    { schema: { params: targetIdParam }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = request.authContext!;
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }
      const { id } = request.params;

      // Self-removal guard mirrors bot_main_menu.py's _on_remove exactly:
      // only blocks removing YOURSELF when it would leave zero Global
      // admins -- removing a DIFFERENT global admin down to zero is not
      // guarded in the original app either, so this doesn't add a new
      // restriction beyond what Discord already allows.
      if (id === ctx.discordId) {
        const [tier, globals] = await Promise.all([
          resolveAuthContext(request.session!).then((c) => c.tier),
          countGlobals(),
        ]);
        if ((tier === TIER_OWNER || tier === TIER_GLOBAL) && globals <= 1) {
          return reply.code(400).send({
            error: "last_global_admin",
            message: "You're the last Global admin; promote someone else to Global before removing yourself.",
          });
        }
      }

      const before = await describeState(id);
      try {
        await removeAdmin(id);
      } catch (err) {
        if (err instanceof PermissionError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
      await logChange(ctx.discordId, "remove_admin", id, before, "removed");
      return { ok: true };
    },
  );

  fastify.post<{ Body: { targetId: string } }>(
    "/admin/permissions/transfer-owner",
    { schema: { body: transferOwnerBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = request.authContext!;
      if (!ctx.isOwner) {
        return reply.code(403).send({ error: "owner_required" });
      }
      const { targetId } = request.body;

      const before = await describeState(targetId);
      try {
        await transferOwner(ctx.discordId, targetId);
      } catch (err) {
        if (err instanceof PermissionError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
      await logChange(ctx.discordId, "transfer_owner", targetId, before, await describeState(targetId));
      return { ok: true };
    },
  );
}

async function memberBelongsToAlliance(fid: number, allianceId: number): Promise<boolean> {
  const row = await usersDb
    .selectFrom("users")
    .select("fid")
    .where("fid", "=", fid)
    .where("alliance", "=", String(allianceId))
    .executeTakeFirst();
  return Boolean(row);
}
