/**
 * Full CRUD over persisted Vault Trap hunts -- lets an alliance admin fix
 * up a record after the fact (wrong date, a missed or duplicated player,
 * a mis-OCR'd damage number) straight from the dashboard, without
 * needing Discord's OCR-repair UI.
 *
 * Mirrors cogs/vault_track.py's own record editor: same delete order
 * (vault_player_damage rows before their vault_hunts row -- FK cascade
 * is off, see the bot's own delete handler), and total_damage/rallies
 * stay independently-editable hunt-level fields rather than something
 * recomputed from the player rows -- the bot's editor doesn't recompute
 * them either, since not every screenshot captures every participant.
 *
 * rank is whatever in-game leaderboard position the source screenshot
 * showed (or null for a manually-added row with no such position) --
 * this app never recomputes it from damage ordering, matching how
 * member.ts's own reads of this column already treat it as opaque,
 * stored data.
 */
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { vaultDataDb, usersDb } from "../db/connections.js";
import { resolveAuthContext, effectiveGuildId } from "../auth/context.js";
import { canManageAlliance } from "../auth/permissions.js";

const allianceIdParam = {
  type: "object",
  required: ["allianceId"],
  properties: { allianceId: { type: "integer" } },
} as const;

const huntParams = {
  type: "object",
  required: ["allianceId", "huntId"],
  properties: { allianceId: { type: "integer" }, huntId: { type: "integer" } },
} as const;

const rowParams = {
  type: "object",
  required: ["allianceId", "huntId", "rowId"],
  properties: {
    allianceId: { type: "integer" },
    huntId: { type: "integer" },
    rowId: { type: "integer" },
  },
} as const;

const huntListQuerystring = {
  type: "object",
  properties: {
    trap: { type: "integer" },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    offset: { type: "integer", minimum: 0 },
  },
} as const;

const nullableInt = { anyOf: [{ type: "integer" }, { type: "null" }] } as const;

const huntEditBody = {
  type: "object",
  minProperties: 1,
  properties: {
    date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    trapNumber: { type: "integer", minimum: 1 },
    rallies: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
    totalDamage: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
  },
} as const;

const playerAddBody = {
  type: "object",
  required: ["damage"],
  properties: {
    fid: { type: "integer" },
    name: { type: "string", minLength: 1, maxLength: 100 },
    damage: { type: "integer", minimum: 0 },
    rank: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
  },
} as const;

const playerEditBody = {
  type: "object",
  minProperties: 1,
  properties: {
    fid: nullableInt,
    damage: { type: "integer", minimum: 0 },
    rank: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
  },
} as const;

async function huntBelongsToAlliance(huntId: number, allianceId: number): Promise<boolean> {
  const row = await vaultDataDb
    .selectFrom("vault_hunts")
    .select("id")
    .where("id", "=", huntId)
    .where("alliance_id", "=", allianceId)
    .executeTakeFirst();
  return Boolean(row);
}

export default async function vaultAdminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get<{ Params: { allianceId: number }; Querystring: { trap?: number; limit?: number; offset?: number } }>(
    "/admin/alliances/:allianceId/vault-hunts",
    { schema: { params: allianceIdParam, querystring: huntListQuerystring } },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      const { allianceId } = request.params;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }
      const { trap, limit = 50, offset = 0 } = request.query;

      let listQuery = vaultDataDb
        .selectFrom("vault_hunts as h")
        .leftJoin("vault_player_damage as p", "p.hunt_id", "h.id")
        .select([
          "h.id",
          "h.date",
          "h.trap_number",
          "h.rallies",
          "h.total_damage",
          "h.event_time",
          sql<number>`COUNT(p.id)`.as("playerCount"),
        ])
        .where("h.alliance_id", "=", allianceId)
        .groupBy("h.id")
        .orderBy("h.date", "desc")
        .orderBy("h.id", "desc")
        .limit(limit)
        .offset(offset);
      let countQuery = vaultDataDb
        .selectFrom("vault_hunts")
        .select(sql<number>`COUNT(*)`.as("count"))
        .where("alliance_id", "=", allianceId);
      if (trap !== undefined) {
        listQuery = listQuery.where("h.trap_number", "=", trap);
        countQuery = countQuery.where("trap_number", "=", trap);
      }

      const [rows, totalRow] = await Promise.all([listQuery.execute(), countQuery.executeTakeFirst()]);
      return {
        total: Number(totalRow?.count ?? 0),
        hunts: rows.map((r) => ({
          id: r.id,
          date: r.date,
          trapNumber: r.trap_number,
          rallies: r.rallies,
          totalDamage: r.total_damage,
          eventTime: r.event_time,
          playerCount: Number(r.playerCount),
        })),
      };
    },
  );

  fastify.get<{ Params: { allianceId: number; huntId: number } }>(
    "/admin/alliances/:allianceId/vault-hunts/:huntId",
    { schema: { params: huntParams } },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      const { allianceId, huntId } = request.params;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }

      const hunt = await vaultDataDb
        .selectFrom("vault_hunts")
        .select(["id", "date", "trap_number", "rallies", "total_damage", "event_time"])
        .where("id", "=", huntId)
        .where("alliance_id", "=", allianceId)
        .executeTakeFirst();
      if (!hunt) {
        return reply.code(404).send({ error: "hunt_not_found" });
      }

      const players = await vaultDataDb
        .selectFrom("vault_player_damage")
        .select(["id", "fid", "raw_name", "resolved_nickname", "damage", "rank", "match_score"])
        .where("hunt_id", "=", huntId)
        .orderBy("damage", "desc")
        .execute();

      return {
        id: hunt.id,
        date: hunt.date,
        trapNumber: hunt.trap_number,
        rallies: hunt.rallies,
        totalDamage: hunt.total_damage,
        eventTime: hunt.event_time,
        players: players.map((p) => ({
          id: p.id,
          fid: p.fid,
          name: p.resolved_nickname ?? p.raw_name,
          damage: p.damage,
          rank: p.rank,
          matchScore: p.match_score,
        })),
      };
    },
  );

  fastify.patch<{
    Params: { allianceId: number; huntId: number };
    Body: { date?: string; trapNumber?: number; rallies?: number | null; totalDamage?: number | null };
  }>(
    "/admin/alliances/:allianceId/vault-hunts/:huntId",
    { schema: { params: huntParams, body: huntEditBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      const { allianceId, huntId } = request.params;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }
      if (!(await huntBelongsToAlliance(huntId, allianceId))) {
        return reply.code(404).send({ error: "hunt_not_found" });
      }

      const { date, trapNumber, rallies, totalDamage } = request.body;
      const updates: { date?: string; trap_number?: number; rallies?: number | null; total_damage?: number | null } = {};
      if (date !== undefined) updates.date = date;
      if (trapNumber !== undefined) updates.trap_number = trapNumber;
      if (rallies !== undefined) updates.rallies = rallies;
      if (totalDamage !== undefined) updates.total_damage = totalDamage;

      await vaultDataDb.updateTable("vault_hunts").set(updates).where("id", "=", huntId).execute();
      return { ok: true };
    },
  );

  fastify.delete<{ Params: { allianceId: number; huntId: number } }>(
    "/admin/alliances/:allianceId/vault-hunts/:huntId",
    { schema: { params: huntParams }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      const { allianceId, huntId } = request.params;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }
      if (!(await huntBelongsToAlliance(huntId, allianceId))) {
        return reply.code(404).send({ error: "hunt_not_found" });
      }

      // FK cascade is off (matches cogs/vault_track.py's own delete flow)
      // -- clear child rows before the parent.
      await vaultDataDb.deleteFrom("vault_player_damage").where("hunt_id", "=", huntId).execute();
      await vaultDataDb.deleteFrom("vault_hunts").where("id", "=", huntId).execute();
      return { ok: true };
    },
  );

  fastify.post<{
    Params: { allianceId: number; huntId: number };
    Body: { fid?: number; name?: string; damage: number; rank?: number | null };
  }>(
    "/admin/alliances/:allianceId/vault-hunts/:huntId/players",
    { schema: { params: huntParams, body: playerAddBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      const { allianceId, huntId } = request.params;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }
      if (!(await huntBelongsToAlliance(huntId, allianceId))) {
        return reply.code(404).send({ error: "hunt_not_found" });
      }

      const { fid, name, damage, rank } = request.body;
      if (fid === undefined && !name) {
        return reply.code(400).send({ error: "fid_or_name_required" });
      }

      let resolvedNickname: string | null = name ?? null;
      if (fid !== undefined) {
        const member = await usersDb
          .selectFrom("users")
          .select("nickname")
          .where("fid", "=", fid)
          .where("alliance", "=", String(allianceId))
          .executeTakeFirst();
        if (!member) {
          return reply.code(400).send({ error: "fid_not_in_alliance" });
        }
        resolvedNickname = member.nickname ?? resolvedNickname;
      }

      const result = await vaultDataDb
        .insertInto("vault_player_damage")
        .values({
          hunt_id: huntId,
          fid: fid ?? null,
          raw_name: name ?? resolvedNickname,
          resolved_nickname: resolvedNickname,
          damage,
          rank: rank ?? null,
          // 100 marks this as a confident, manually-picked match rather
          // than an OCR fuzzy-match score -- mirrors the bot's own editor
          // treating a manually-assigned fid as fully confident.
          match_score: fid !== undefined ? 100 : null,
        })
        .executeTakeFirst();

      return { ok: true, id: Number(result.insertId) };
    },
  );

  fastify.patch<{
    Params: { allianceId: number; huntId: number; rowId: number };
    Body: { fid?: number | null; damage?: number; rank?: number | null };
  }>(
    "/admin/alliances/:allianceId/vault-hunts/:huntId/players/:rowId",
    { schema: { params: rowParams, body: playerEditBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      const { allianceId, huntId, rowId } = request.params;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }
      if (!(await huntBelongsToAlliance(huntId, allianceId))) {
        return reply.code(404).send({ error: "hunt_not_found" });
      }
      const row = await vaultDataDb
        .selectFrom("vault_player_damage")
        .select("id")
        .where("id", "=", rowId)
        .where("hunt_id", "=", huntId)
        .executeTakeFirst();
      if (!row) {
        return reply.code(404).send({ error: "row_not_found" });
      }

      const { fid, damage, rank } = request.body;
      const updates: {
        fid?: number | null;
        resolved_nickname?: string | null;
        match_score?: number | null;
        damage?: number;
        rank?: number | null;
      } = {};

      if (fid !== undefined) {
        if (fid === null) {
          updates.fid = null;
          updates.resolved_nickname = null;
          updates.match_score = null;
        } else {
          const member = await usersDb
            .selectFrom("users")
            .select("nickname")
            .where("fid", "=", fid)
            .where("alliance", "=", String(allianceId))
            .executeTakeFirst();
          if (!member) {
            return reply.code(400).send({ error: "fid_not_in_alliance" });
          }
          updates.fid = fid;
          updates.resolved_nickname = member.nickname;
          updates.match_score = 100;
        }
      }
      if (damage !== undefined) updates.damage = damage;
      if (rank !== undefined) updates.rank = rank;

      await vaultDataDb.updateTable("vault_player_damage").set(updates).where("id", "=", rowId).execute();
      return { ok: true };
    },
  );

  fastify.delete<{ Params: { allianceId: number; huntId: number; rowId: number } }>(
    "/admin/alliances/:allianceId/vault-hunts/:huntId/players/:rowId",
    { schema: { params: rowParams }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      const { allianceId, huntId, rowId } = request.params;
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }
      if (!(await huntBelongsToAlliance(huntId, allianceId))) {
        return reply.code(404).send({ error: "hunt_not_found" });
      }

      await vaultDataDb.deleteFrom("vault_player_damage").where("id", "=", rowId).where("hunt_id", "=", huntId).execute();
      return { ok: true };
    },
  );
}
