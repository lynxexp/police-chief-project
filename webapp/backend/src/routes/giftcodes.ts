/**
 * Gift codes -- Phase 2. The member-facing "current codes" list plus
 * admin management of the code list and each alliance's announcement
 * channel. Deliberately does NOT trigger a live Discord announcement --
 * the bot's own `announce_new_code()` fires synchronously from its
 * Discord command handler, there's no DB-polling loop watching
 * `gift_codes` the way Notifications has one. A web-added code updates
 * the table; announcing it still requires the bot's own /addcode command
 * for now (see the Phase 2 plan doc's Architecture decisions).
 *
 * Code management (add/deactivate/edit) is Global/Owner-only: a code
 * isn't scoped to one alliance, it fans out to every alliance's
 * configured channel, so there's no natural "which alliance admin" scope
 * for it the way channel-setup or member management has. The per-alliance
 * announcement-channel mapping IS alliance-scoped and uses the existing
 * canManageAlliance check, same as Stage D's channel setup.
 */
import type { FastifyInstance } from "fastify";
import { giftcodeDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";
import { canManageAlliance } from "../auth/permissions.js";
import { resolveAuthContext, effectiveGuildId } from "../auth/context.js";
import { logAppAction } from "../audit.js";

const allianceIdParam = {
  type: "object",
  required: ["allianceId"],
  properties: { allianceId: { type: "integer" } },
} as const;

const giftcodeParam = {
  type: "object",
  required: ["code"],
  properties: { code: { type: "string", minLength: 1 } },
} as const;

const addCodeBody = {
  type: "object",
  required: ["giftcode"],
  properties: {
    giftcode: { type: "string", minLength: 1, maxLength: 64 },
    note: { type: ["string", "null"] },
    expiryDate: { type: ["string", "null"] },
  },
} as const;

const updateCodeBody = {
  type: "object",
  properties: {
    note: { type: ["string", "null"] },
    expiryDate: { type: ["string", "null"] },
    isActive: { type: "boolean" },
  },
} as const;

const channelBody = {
  type: "object",
  required: ["channelId"],
  properties: {
    channelId: { anyOf: [{ type: "string", pattern: "^[0-9]+$" }, { type: "null" }] },
  },
} as const;

export default async function giftCodeRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get("/gift-codes", async () => {
    // Mirrors gift_views.py's active-codes query exactly: is_active=1 AND
    // (no expiry set OR expiry hasn't passed yet). expiry_date is a plain
    // "YYYY-MM-DD" date (no time component, see gift_views.py's
    // `date.fromisoformat(...).isoformat()`), so string comparison against
    // today's UTC date sorts correctly the same way SQLite's date('now')
    // does on the Python side.
    const today = new Date().toISOString().slice(0, 10);
    const rows = await giftcodeDb
      .selectFrom("gift_codes")
      .select(["giftcode", "date", "note", "expiry_date"])
      .where("is_active", "=", 1)
      .where((eb) => eb.or([eb("expiry_date", "is", null), eb("expiry_date", "=", ""), eb("expiry_date", ">=", today)]))
      .orderBy("date", "desc")
      .execute();
    return rows.map((r) => ({
      giftcode: r.giftcode,
      date: r.date,
      note: r.note,
      expiryDate: r.expiry_date,
    }));
  });

  fastify.get("/admin/gift-codes", async (request, reply) => {
    const ctx = await resolveAuthContext(request.session!);
    if (!ctx.isGlobal) {
      return reply.code(403).send({ error: "global_admin_required" });
    }

    const rows = await giftcodeDb
      .selectFrom("gift_codes")
      .select(["giftcode", "date", snowflake("created_by").as("created_by"), "note", "expiry_date", "is_active"])
      .orderBy("date", "desc")
      .execute();
    return rows.map((r) => ({
      giftcode: r.giftcode,
      date: r.date,
      createdBy: r.created_by,
      note: r.note,
      expiryDate: r.expiry_date,
      isActive: Boolean(r.is_active),
    }));
  });

  fastify.post<{ Body: { giftcode: string; note?: string | null; expiryDate?: string | null } }>(
    "/admin/gift-codes",
    { schema: { body: addCodeBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }
      const { giftcode, note, expiryDate } = request.body;

      const existing = await giftcodeDb
        .selectFrom("gift_codes")
        .select("giftcode")
        .where("giftcode", "=", giftcode)
        .executeTakeFirst();
      if (existing) {
        return reply.code(409).send({ error: "code_already_exists" });
      }

      await giftcodeDb
        .insertInto("gift_codes")
        .values({
          giftcode,
          date: new Date().toISOString(),
          note: note ?? null,
          expiry_date: expiryDate ?? null,
          is_active: 1,
          created_by: ctx.discordId,
        })
        .execute();

      await logAppAction({
        actorId: ctx.discordId,
        guildId: null,
        action: "gift_code_created",
        resourceType: "gift_code",
        resourceId: giftcode,
        detail: note ?? undefined,
      });

      return reply.code(201).send({ ok: true });
    },
  );

  fastify.patch<{
    Params: { code: string };
    Body: { note?: string | null; expiryDate?: string | null; isActive?: boolean };
  }>(
    "/admin/gift-codes/:code",
    { schema: { params: giftcodeParam, body: updateCodeBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isGlobal) {
        return reply.code(403).send({ error: "global_admin_required" });
      }
      const { code } = request.params;
      const body = request.body;

      const patch: Record<string, string | number | null> = {};
      if ("note" in body) patch.note = body.note ?? null;
      if ("expiryDate" in body) patch.expiry_date = body.expiryDate ?? null;
      if ("isActive" in body) patch.is_active = body.isActive ? 1 : 0;
      if (Object.keys(patch).length === 0) {
        return reply.code(400).send({ error: "no_fields_to_update" });
      }

      const result = await giftcodeDb
        .updateTable("gift_codes")
        .set(patch)
        .where("giftcode", "=", code)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        return reply.code(404).send({ error: "code_not_found" });
      }

      const action = "isActive" in body ? (body.isActive ? "gift_code_enabled" : "gift_code_disabled") : "gift_code_updated";
      await logAppAction({
        actorId: ctx.discordId,
        guildId: null,
        action,
        resourceType: "gift_code",
        resourceId: code,
        detail: "note" in body ? (body.note ?? undefined) : undefined,
      });

      return { ok: true };
    },
  );

  fastify.get<{ Params: { allianceId: number } }>(
    "/admin/alliances/:allianceId/gift-channel",
    { schema: { params: allianceIdParam } },
    async (request, reply) => {
      const { allianceId } = request.params;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }

      const row = await giftcodeDb
        .selectFrom("giftcode_channel")
        .select(snowflake("channel_id").as("channel_id"))
        .where("alliance_id", "=", allianceId)
        .executeTakeFirst();
      return { channelId: row?.channel_id ?? null };
    },
  );

  fastify.patch<{ Params: { allianceId: number }; Body: { channelId: string | null } }>(
    "/admin/alliances/:allianceId/gift-channel",
    { schema: { params: allianceIdParam, body: channelBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const { allianceId } = request.params;
      const { channelId } = request.body;
      const ctx = await resolveAuthContext(request.session!);
      if (!(await canManageAlliance(ctx.discordId, effectiveGuildId(ctx), allianceId))) {
        return reply.code(403).send({ error: "not_alliance_admin" });
      }

      const existing = await giftcodeDb
        .selectFrom("giftcode_channel")
        .select("alliance_id")
        .where("alliance_id", "=", allianceId)
        .executeTakeFirst();
      if (existing) {
        await giftcodeDb
          .updateTable("giftcode_channel")
          .set({ channel_id: channelId })
          .where("alliance_id", "=", allianceId)
          .execute();
      } else {
        await giftcodeDb
          .insertInto("giftcode_channel")
          .values({ alliance_id: allianceId, channel_id: channelId })
          .execute();
      }
      return { ok: true };
    },
  );
}
