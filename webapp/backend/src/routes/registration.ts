/**
 * Self-service in-game ID registration for a signed-in Discord user with
 * no linked characters yet -- the web equivalent of /register
 * (cogs/alliance_registration.py) for someone visiting the dashboard for
 * the first time. Ports the two outcomes that matter for a brand-new web
 * session: creating a fresh row, or claiming one that already exists in
 * `users` but has no Discord account attached yet (an admin add, or a
 * leftover from before this person ever registered).
 *
 * Deliberately NOT ported -- none of these make sense without a live
 * Discord interaction/guild context:
 *  - Auto-created "Registered"/alliance-tag roles.
 *  - The "this fid is already yours on a different server -- move it
 *    here?" prompt (a web session has no "current server" the way a
 *    slash command run inside a guild does -- this always registers the
 *    way a DM /register would, with discord_server_id left NULL).
 *  - Best-effort auto-linking of historical unmatched Vault Trap /
 *    Capitol War OCR rows by name match -- that name-matching logic
 *    lives entirely in the in-process VaultTrack/CapitolWar cogs.
 */
import type { FastifyInstance } from "fastify";
import { usersDb, allianceDb, settingsDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";

const MAX_STATE = 99999;
const MAX_CHIEF_OFFICE_LEVEL = 45;

const registerBody = {
  type: "object",
  required: ["fid", "allianceId", "name"],
  properties: {
    fid: { type: "integer", minimum: 1 },
    allianceId: { type: "integer" },
    name: { type: "string", minLength: 1, maxLength: 100 },
    state: { type: "integer", minimum: 1, maximum: MAX_STATE },
    level: { type: "integer", minimum: 0, maximum: MAX_CHIEF_OFFICE_LEVEL },
  },
} as const;

export default async function registrationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  // Open to any signed-in Discord user (not admin-gated) -- same reach
  // as /register's own alliance autocomplete, which pulls from the same
  // table with no permission check.
  fastify.get("/register/alliances", async () => {
    const rows = await allianceDb
      .selectFrom("alliance_list")
      .select(["alliance_id", "name", "tag"])
      .orderBy("name")
      .execute();
    return rows.map((r) => ({ id: r.alliance_id, name: r.name, tag: r.tag }));
  });

  fastify.post<{
    Body: { fid: number; allianceId: number; name: string; state?: number; level?: number };
  }>(
    "/register",
    { schema: { body: registerBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const discordId = request.session!.discordId;
      const { fid, allianceId, name, state, level } = request.body;

      const settingsRow = await settingsDb
        .selectFrom("register_settings")
        .select("enabled")
        .executeTakeFirst();
      if (!Boolean(settingsRow?.enabled)) {
        return reply.code(403).send({ error: "registration_disabled" });
      }

      const alliance = await allianceDb
        .selectFrom("alliance_list")
        .select(["alliance_id", "kid", "state_locked"])
        .where("alliance_id", "=", allianceId)
        .executeTakeFirst();
      if (!alliance) {
        return reply.code(400).send({ error: "alliance_not_found" });
      }

      const existing = await usersDb
        .selectFrom("users")
        .select(["fid", "is_active", snowflake("discord_id").as("discord_id")])
        .where("fid", "=", fid)
        .executeTakeFirst();

      if (existing) {
        if (existing.discord_id !== null && existing.discord_id !== discordId) {
          return reply.code(409).send({ error: "fid_already_registered" });
        }
        if (existing.discord_id === discordId) {
          // Already theirs (re-submitting the same form, or a race with
          // another tab) -- idempotent no-op, matches /register's own
          // "already registered to you" branch.
          return { ok: true, action: "already_linked" as const };
        }
        // Unclaimed row (admin-added, or pre-dates any registration) --
        // mirrors _attach_discord_to_existing: attach + reactivate.
        await usersDb
          .updateTable("users")
          .set({
            discord_id: discordId,
            discord_server_id: null,
            discord_id_updated_at: new Date().toISOString(),
            is_active: 1,
            deactivated_at: null,
          })
          .where("fid", "=", fid)
          .execute();
        return { ok: true, action: "linked" as const };
      }

      // Brand-new fid -- resolve its home state the same way /register
      // does: an explicitly typed state wins, else fall back to the
      // alliance's own bound home state (and require one be typed if the
      // alliance doesn't have one on file yet).
      let kid: number;
      if (state !== undefined) {
        kid = state;
      } else if (alliance.kid !== null) {
        kid = alliance.kid;
      } else {
        return reply.code(400).send({ error: "state_required" });
      }

      // State-lock gate (state_lock_reason): only blocks when the
      // alliance is explicitly locked to a bound home state and this
      // kid doesn't match it.
      if (alliance.state_locked && alliance.kid !== null && kid !== alliance.kid) {
        return reply.code(400).send({ error: "state_locked", requiredState: alliance.kid });
      }

      await usersDb
        .insertInto("users")
        .values({
          fid,
          nickname: name,
          chief_office_lv: level ?? 0,
          kid,
          alliance: String(allianceId),
          discord_id: discordId,
          discord_server_id: null,
          discord_id_updated_at: new Date().toISOString(),
          is_active: 1,
        })
        .execute();
      return { ok: true, action: "registered" as const };
    },
  );
}
