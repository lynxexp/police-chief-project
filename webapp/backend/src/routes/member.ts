/**
 * Read-only member-facing views: own profile, alliance roster, per-member
 * and alliance-wide trend charts, and leaderboards. Per the plan doc's
 * "alliance-open" data model, everything scoped to an alliance is visible
 * to ANY member of that alliance (or any admin with reach there) -- not
 * just to the member the data belongs to. See auth/context.ts's
 * canViewAlliance for the one shared check enforcing that boundary.
 *
 * Query patterns are deliberately faithful to their Python counterparts
 * where an equivalent already exists in the bot (roster's `alliance`
 * bound as a string, capitol's per-event SUM/LEFT JOIN aggregate -- see
 * cogs/vault_track.py's get_alliance_roster and cogs/capitol_war.py's
 * per-event alliance total). Vault has no existing alliance-wide
 * aggregate in the bot (it only ever reads per-hunt totals); the
 * per-date GROUP BY here is a new aggregate built for this view, not a
 * port of anything.
 */
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { usersDb, vaultDataDb, capitolWarDb, allianceDb, changesDb } from "../db/connections.js";
import { resolveAuthContext, canViewAlliance } from "../auth/context.js";

// power_changes / combat_power_changes are lazily created (see
// connections.ts's EXPECTED optional flag) -- the bot only ever
// CREATE TABLE IF NOT EXISTS's them on the first change it actually
// records, so a fresh install or an alliance that's never had one yet
// legitimately doesn't have the table. Treat that as "no history",
// not an error; anything else still surfaces normally.
async function selectOrEmpty<T>(promise: Promise<T[]>): Promise<T[]> {
  try {
    return await promise;
  } catch (e) {
    if (e instanceof Error && /no such table/i.test(e.message)) return [];
    throw e;
  }
}

const allianceIdParam = {
  type: "object",
  required: ["allianceId"],
  properties: { allianceId: { type: "integer" } },
} as const;

const allianceMemberParams = {
  type: "object",
  required: ["allianceId", "fid"],
  properties: {
    allianceId: { type: "integer" },
    fid: { type: "integer" },
  },
} as const;

const rangeQuerystring = {
  type: "object",
  properties: {
    from: { type: "string" },
    to: { type: "string" },
  },
} as const;

const vaultTrendQuerystring = {
  type: "object",
  properties: {
    trap: { type: "integer" },
  },
} as const;

const vaultLeaderboardQuerystring = {
  type: "object",
  properties: {
    from: { type: "string" },
    to: { type: "string" },
    trap: { type: "integer" },
  },
} as const;

export default async function memberRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get("/member/profile", async (request) => {
    const rows = await usersDb
      .selectFrom("users")
      .select([
        "fid",
        "nickname",
        "alliance",
        "chief_office_lv",
        "power",
        "combat_power",
        "is_active",
      ])
      .where("discord_id", "=", request.session!.discordId)
      .orderBy(sql`nickname COLLATE NOCASE`)
      .execute();

    const allianceIds = [...new Set(rows.map((r) => r.alliance).filter((a): a is string => a !== null))]
      .map(Number);
    const alliances = allianceIds.length
      ? await allianceDb
          .selectFrom("alliance_list")
          .select(["alliance_id", "name"])
          .where("alliance_id", "in", allianceIds)
          .execute()
      : [];
    const allianceById = new Map(alliances.map((a) => [a.alliance_id, a.name]));

    return rows.map((r) => ({
      fid: r.fid,
      nickname: r.nickname,
      allianceId: r.alliance !== null ? Number(r.alliance) : null,
      allianceName: r.alliance !== null ? (allianceById.get(Number(r.alliance)) ?? null) : null,
      chiefOfficeLv: r.chief_office_lv,
      power: r.power,
      combatPower: r.combat_power,
      isActive: Boolean(r.is_active),
    }));
  });

  fastify.get<{ Params: { allianceId: number }; Querystring: { includeInactive?: string } }>(
    "/alliance/:allianceId/members",
    { schema: { params: allianceIdParam } },
    async (request, reply) => {
      const { allianceId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canViewAlliance(ctx, allianceId))) {
        return reply.code(403).send({ error: "not_alliance_member" });
      }

      let query = usersDb
        .selectFrom("users")
        .select(["fid", "nickname", "chief_office_lv", "power", "combat_power", "is_active"])
        .where("alliance", "=", String(allianceId));
      if (request.query.includeInactive !== "true") {
        query = query.where("is_active", "=", 1);
      }

      const rows = await query.orderBy(sql`nickname COLLATE NOCASE`).execute();
      return rows.map((r) => ({
        fid: r.fid,
        nickname: r.nickname,
        chiefOfficeLv: r.chief_office_lv,
        power: r.power,
        combatPower: r.combat_power,
        isActive: Boolean(r.is_active),
      }));
    },
  );

  fastify.get<{ Params: { allianceId: number; fid: number } }>(
    "/alliance/:allianceId/members/:fid/vault-trend",
    { schema: { params: allianceMemberParams } },
    async (request, reply) => {
      const { allianceId, fid } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canViewAlliance(ctx, allianceId))) {
        return reply.code(403).send({ error: "not_alliance_member" });
      }
      if (!(await memberBelongsToAlliance(fid, allianceId))) {
        return reply.code(404).send({ error: "member_not_found" });
      }

      const rows = await vaultDataDb
        .selectFrom("vault_hunts as bh")
        .innerJoin("vault_player_damage as bpd", "bpd.hunt_id", "bh.id")
        .select(["bh.date", "bh.trap_number", "bpd.damage", "bpd.rank"])
        .where("bh.alliance_id", "=", allianceId)
        .where("bpd.fid", "=", fid)
        .orderBy("bh.date", "asc")
        .execute();

      return rows.map((r) => ({
        date: r.date,
        trapNumber: r.trap_number,
        damage: r.damage,
        rank: r.rank,
      }));
    },
  );

  fastify.get<{ Params: { allianceId: number; fid: number } }>(
    "/alliance/:allianceId/members/:fid/capitol-trend",
    { schema: { params: allianceMemberParams } },
    async (request, reply) => {
      const { allianceId, fid } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canViewAlliance(ctx, allianceId))) {
        return reply.code(403).send({ error: "not_alliance_member" });
      }
      if (!(await memberBelongsToAlliance(fid, allianceId))) {
        return reply.code(404).send({ error: "member_not_found" });
      }

      const rows = await capitolWarDb
        .selectFrom("capitol_war_events as cwe")
        .innerJoin("capitol_war_points as cwp", "cwp.event_id", "cwe.id")
        .select(["cwe.date", "cwp.points", "cwp.rank"])
        .where("cwe.alliance_id", "=", allianceId)
        .where("cwp.fid", "=", fid)
        .orderBy("cwe.date", "asc")
        .execute();

      return rows.map((r) => ({ date: r.date, points: r.points, rank: r.rank }));
    },
  );

  fastify.get<{ Params: { allianceId: number; fid: number } }>(
    "/alliance/:allianceId/members/:fid/history",
    { schema: { params: allianceMemberParams } },
    async (request, reply) => {
      const { allianceId, fid } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canViewAlliance(ctx, allianceId))) {
        return reply.code(403).send({ error: "not_alliance_member" });
      }
      if (!(await memberBelongsToAlliance(fid, allianceId))) {
        return reply.code(404).send({ error: "member_not_found" });
      }

      // Mirrors cogs/alliance_history.py / alliance_power_changes.py's
      // read pattern exactly: a plain WHERE fid = ? ORDER BY change_date
      // DESC per history type, no joins, no computed diffs stored.
      const [nicknameChanges, chiefOfficeChanges, powerChanges, combatPowerChanges] = await Promise.all([
        changesDb
          .selectFrom("nickname_changes")
          .select(["old_nickname", "new_nickname", "change_date"])
          .where("fid", "=", fid)
          .orderBy("change_date", "desc")
          .execute(),
        changesDb
          .selectFrom("chief_office_changes")
          .select(["old_chief_office_lv", "new_chief_office_lv", "change_date"])
          .where("fid", "=", fid)
          .orderBy("change_date", "desc")
          .execute(),
        selectOrEmpty(
          changesDb
            .selectFrom("power_changes")
            .select(["old_power", "new_power", "change_date"])
            .where("fid", "=", fid)
            .orderBy("change_date", "desc")
            .execute(),
        ),
        selectOrEmpty(
          changesDb
            .selectFrom("combat_power_changes")
            .select(["old_combat_power", "new_combat_power", "change_date"])
            .where("fid", "=", fid)
            .orderBy("change_date", "desc")
            .execute(),
        ),
      ]);

      return {
        nicknameChanges: nicknameChanges.map((r) => ({
          oldValue: r.old_nickname,
          newValue: r.new_nickname,
          changeDate: r.change_date,
        })),
        chiefOfficeChanges: chiefOfficeChanges.map((r) => ({
          oldValue: r.old_chief_office_lv,
          newValue: r.new_chief_office_lv,
          changeDate: r.change_date,
        })),
        powerChanges: powerChanges.map((r) => ({
          oldValue: r.old_power,
          newValue: r.new_power,
          changeDate: r.change_date,
        })),
        combatPowerChanges: combatPowerChanges.map((r) => ({
          oldValue: r.old_combat_power,
          newValue: r.new_combat_power,
          changeDate: r.change_date,
        })),
      };
    },
  );

  fastify.get<{ Params: { allianceId: number } }>(
    "/alliance/:allianceId/vault-traps",
    { schema: { params: allianceIdParam } },
    async (request, reply) => {
      const { allianceId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canViewAlliance(ctx, allianceId))) {
        return reply.code(403).send({ error: "not_alliance_member" });
      }

      // Distinct trap numbers this alliance actually has hunts for --
      // drives the "Vault 1 / Vault 2" split in the UI without hardcoding
      // how many traps exist (players typically only run one trap or the
      // other, so a blended total/leaderboard across both isn't a
      // meaningful comparison -- see the trend/leaderboard endpoints
      // below for the per-trap filter this powers).
      const rows = await vaultDataDb
        .selectFrom("vault_hunts")
        .select("trap_number")
        .distinct()
        .where("alliance_id", "=", allianceId)
        .orderBy("trap_number", "asc")
        .execute();
      return rows.map((r) => r.trap_number);
    },
  );

  fastify.get<{ Params: { allianceId: number }; Querystring: { trap?: number } }>(
    "/alliance/:allianceId/vault-trend",
    { schema: { params: allianceIdParam, querystring: vaultTrendQuerystring } },
    async (request, reply) => {
      const { allianceId } = request.params;
      const { trap } = request.query;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canViewAlliance(ctx, allianceId))) {
        return reply.code(403).send({ error: "not_alliance_member" });
      }

      // No existing bot query aggregates across traps for a date -- this
      // sums vault_hunts.total_damage (already a per-hunt snapshot, not
      // read-time-summed from vault_player_damage) grouped by date.
      // Optional ?trap= restricts to one trap number so "Vault 1" and
      // "Vault 2" trends can be viewed (and compared) separately, rather
      // than blended into one line across two mostly-disjoint rosters.
      let query = vaultDataDb
        .selectFrom("vault_hunts")
        .select([
          "date",
          sql<number>`COALESCE(SUM(total_damage), 0)`.as("totalDamage"),
          sql<number>`COUNT(*)`.as("hunts"),
        ])
        .where("alliance_id", "=", allianceId)
        .groupBy("date")
        .orderBy("date", "asc");
      if (trap !== undefined) query = query.where("trap_number", "=", trap);

      const rows = await query.execute();
      return rows.map((r) => ({
        date: r.date,
        totalDamage: r.totalDamage,
        hunts: r.hunts,
        avgDamage: r.hunts > 0 ? r.totalDamage / r.hunts : 0,
      }));
    },
  );

  fastify.get<{ Params: { allianceId: number } }>(
    "/alliance/:allianceId/capitol-trend",
    { schema: { params: allianceIdParam } },
    async (request, reply) => {
      const { allianceId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canViewAlliance(ctx, allianceId))) {
        return reply.code(403).send({ error: "not_alliance_member" });
      }

      // Mirrors cogs/capitol_war.py's per-event alliance-total query
      // exactly (SUM/LEFT JOIN grouped by event id, not date).
      const rows = await capitolWarDb
        .selectFrom("capitol_war_events as e")
        .leftJoin("capitol_war_points as p", "p.event_id", "e.id")
        .select(["e.id", "e.date", sql<number>`COALESCE(SUM(p.points), 0)`.as("totalPoints")])
        .where("e.alliance_id", "=", allianceId)
        .groupBy("e.id")
        .orderBy("e.date", "asc")
        .execute();

      return rows.map((r) => ({ date: r.date, totalPoints: r.totalPoints }));
    },
  );

  fastify.get<{ Params: { allianceId: number }; Querystring: { from?: string; to?: string; trap?: number } }>(
    "/alliance/:allianceId/leaderboard/vault",
    { schema: { params: allianceIdParam, querystring: vaultLeaderboardQuerystring } },
    async (request, reply) => {
      const { allianceId } = request.params;
      const { from, to, trap } = request.query;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canViewAlliance(ctx, allianceId))) {
        return reply.code(403).send({ error: "not_alliance_member" });
      }

      // Optional ?trap= scopes the ranking to one trap number -- players
      // typically only run Vault 1 or Vault 2, not both, so a combined
      // ranking mixes two largely non-overlapping rosters; "Overall"
      // (no trap filter) stays available as its own view.
      let query = vaultDataDb
        .selectFrom("vault_hunts as bh")
        .innerJoin("vault_player_damage as bpd", "bpd.hunt_id", "bh.id")
        .select([
          "bpd.fid",
          sql<string | null>`MAX(bpd.resolved_nickname)`.as("nickname"),
          sql<number>`SUM(bpd.damage)`.as("totalDamage"),
          sql<number>`COUNT(*)`.as("hunts"),
        ])
        .where("bh.alliance_id", "=", allianceId)
        .where("bpd.fid", "is not", null)
        .groupBy("bpd.fid")
        .orderBy(sql`SUM(bpd.damage)`, "desc");
      if (from) query = query.where("bh.date", ">=", from);
      if (to) query = query.where("bh.date", "<=", to);
      if (trap !== undefined) query = query.where("bh.trap_number", "=", trap);

      const rows = await query.execute();
      return rows.map((r, i) => ({
        rank: i + 1,
        fid: r.fid,
        nickname: r.nickname,
        totalDamage: r.totalDamage,
        hunts: r.hunts,
        avgDamage: r.hunts > 0 ? r.totalDamage / r.hunts : 0,
      }));
    },
  );

  fastify.get<{ Params: { allianceId: number }; Querystring: { from?: string; to?: string } }>(
    "/alliance/:allianceId/leaderboard/capitol",
    { schema: { params: allianceIdParam, querystring: rangeQuerystring } },
    async (request, reply) => {
      const { allianceId } = request.params;
      const { from, to } = request.query;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canViewAlliance(ctx, allianceId))) {
        return reply.code(403).send({ error: "not_alliance_member" });
      }

      let query = capitolWarDb
        .selectFrom("capitol_war_events as e")
        .innerJoin("capitol_war_points as p", "p.event_id", "e.id")
        .select([
          "p.fid",
          sql<string | null>`MAX(p.resolved_nickname)`.as("nickname"),
          sql<number>`SUM(p.points)`.as("totalPoints"),
          sql<number>`COUNT(*)`.as("events"),
        ])
        .where("e.alliance_id", "=", allianceId)
        .where("p.fid", "is not", null)
        .groupBy("p.fid")
        .orderBy(sql`SUM(p.points)`, "desc");
      if (from) query = query.where("e.date", ">=", from);
      if (to) query = query.where("e.date", "<=", to);

      const rows = await query.execute();
      return rows.map((r, i) => ({
        rank: i + 1,
        fid: r.fid,
        nickname: r.nickname,
        totalPoints: r.totalPoints,
        events: r.events,
        avgPoints: r.events > 0 ? r.totalPoints / r.events : 0,
      }));
    },
  );

  fastify.get<{ Params: { allianceId: number }; Querystring: { trap?: number } }>(
    "/alliance/:allianceId/vault-attendance",
    { schema: { params: allianceIdParam, querystring: vaultTrendQuerystring } },
    async (request, reply) => {
      const { allianceId } = request.params;
      const { trap } = request.query;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canViewAlliance(ctx, allianceId))) {
        return reply.code(403).send({ error: "not_alliance_member" });
      }

      // Deliberately derived from the same vault_hunts/vault_player_damage
      // data the trend/leaderboard endpoints already use -- not the bot's
      // separate attendance.py present/absent-marking subsystem (see the
      // Phase 2 plan doc's Attendance stage). "Attended" = has a damage
      // row for that hunt. Starts from the roster (not vault_player_damage,
      // unlike the leaderboard) so a member who never showed up still
      // appears with attended=0 -- the whole point of an attendance view
      // is surfacing who ISN'T participating, not just ranking who is.
      let sessionsQuery = vaultDataDb
        .selectFrom("vault_hunts")
        .select(sql<number>`COUNT(*)`.as("totalSessions"))
        .where("alliance_id", "=", allianceId);
      if (trap !== undefined) sessionsQuery = sessionsQuery.where("trap_number", "=", trap);
      const { totalSessions } = await sessionsQuery.executeTakeFirstOrThrow();

      const roster = await usersDb
        .selectFrom("users")
        .select(["fid", "nickname"])
        .where("alliance", "=", String(allianceId))
        .where("is_active", "=", 1)
        .execute();

      let attendedQuery = vaultDataDb
        .selectFrom("vault_hunts as bh")
        .innerJoin("vault_player_damage as bpd", "bpd.hunt_id", "bh.id")
        .select(["bpd.fid", sql<number>`COUNT(*)`.as("attended")])
        .where("bh.alliance_id", "=", allianceId)
        .where("bpd.fid", "is not", null)
        .groupBy("bpd.fid");
      if (trap !== undefined) attendedQuery = attendedQuery.where("bh.trap_number", "=", trap);
      const attendedRows = await attendedQuery.execute();
      const attendedByFid = new Map(attendedRows.map((r) => [r.fid, r.attended]));

      const members = roster
        .map((m) => {
          const attended = attendedByFid.get(m.fid) ?? 0;
          return {
            fid: m.fid,
            nickname: m.nickname,
            attended,
            attendanceRate: totalSessions > 0 ? attended / totalSessions : 0,
          };
        })
        .sort((a, b) => b.attended - a.attended);

      return { totalSessions, members };
    },
  );

  fastify.get<{ Params: { allianceId: number } }>(
    "/alliance/:allianceId/capitol-attendance",
    { schema: { params: allianceIdParam } },
    async (request, reply) => {
      const { allianceId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canViewAlliance(ctx, allianceId))) {
        return reply.code(403).send({ error: "not_alliance_member" });
      }

      const { totalSessions } = await capitolWarDb
        .selectFrom("capitol_war_events")
        .select(sql<number>`COUNT(*)`.as("totalSessions"))
        .where("alliance_id", "=", allianceId)
        .executeTakeFirstOrThrow();

      const roster = await usersDb
        .selectFrom("users")
        .select(["fid", "nickname"])
        .where("alliance", "=", String(allianceId))
        .where("is_active", "=", 1)
        .execute();

      const attendedRows = await capitolWarDb
        .selectFrom("capitol_war_events as e")
        .innerJoin("capitol_war_points as p", "p.event_id", "e.id")
        .select(["p.fid", sql<number>`COUNT(*)`.as("attended")])
        .where("e.alliance_id", "=", allianceId)
        .where("p.fid", "is not", null)
        .groupBy("p.fid")
        .execute();
      const attendedByFid = new Map(attendedRows.map((r) => [r.fid, r.attended]));

      const members = roster
        .map((m) => {
          const attended = attendedByFid.get(m.fid) ?? 0;
          return {
            fid: m.fid,
            nickname: m.nickname,
            attended,
            attendanceRate: totalSessions > 0 ? attended / totalSessions : 0,
          };
        })
        .sort((a, b) => b.attended - a.attended);

      return { totalSessions, members };
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
