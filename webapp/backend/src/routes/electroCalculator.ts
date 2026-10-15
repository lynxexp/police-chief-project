/**
 * Per-user saved state for the Electro Building Calculator: the "current"
 * level of each Electro building, so a signed-in member can come back and
 * resume where they left off. Only the current levels are stored -- goals
 * are a per-session planning choice and start from the current levels
 * again each visit.
 *
 * The calculator page itself is public (no login, see the frontend's
 * OptionalAuthRoute); these endpoints are the signed-in-only extra. A
 * signed-out visitor never reaches them -- the page just doesn't offer
 * saving. One row per Discord user, in this app's own webapp.sqlite.
 */
import type { FastifyInstance } from "fastify";
import { webappDb } from "../db/connections.js";
import {
  ELECTRO_BUILDINGS,
  ELECTRO_MAX_LEVEL,
  ELECTRO_MIN_LEVEL,
  normalizeElectroLevels,
  parseStoredElectroLevels,
  type ElectroLevels,
} from "../electroCalculator.js";

const levelSchema = { type: "integer", minimum: ELECTRO_MIN_LEVEL, maximum: ELECTRO_MAX_LEVEL } as const;

const saveBody = {
  type: "object",
  required: ["currentLevels"],
  additionalProperties: false,
  properties: {
    currentLevels: {
      type: "object",
      required: [...ELECTRO_BUILDINGS],
      additionalProperties: false,
      properties: Object.fromEntries(ELECTRO_BUILDINGS.map((name) => [name, levelSchema])),
    },
  },
} as const;

export default async function electroCalculatorRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  // `currentLevels` is null when this user has never saved anything.
  fastify.get("/electro-calculator", async (request) => {
    const discordId = request.session!.discordId;
    const row = await webappDb
      .selectFrom("electro_calculator_state")
      .select(["current_levels", "updated_at"])
      .where("discord_id", "=", discordId)
      .executeTakeFirst();
    const currentLevels = parseStoredElectroLevels(row?.current_levels);
    return {
      currentLevels,
      updatedAt: currentLevels ? (row?.updated_at ?? null) : null,
    };
  });

  fastify.put<{ Body: { currentLevels: ElectroLevels } }>(
    "/electro-calculator",
    {
      schema: { body: saveBody },
      preHandler: fastify.csrfProtection,
      // The page saves a moment after each edit; this leaves plenty of
      // room for rapid +/- tapping without letting one session hammer
      // the database.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const discordId = request.session!.discordId;
      const levels = normalizeElectroLevels(request.body.currentLevels);
      if (!levels) {
        return reply.code(400).send({ error: "invalid_levels" });
      }
      const updatedAt = new Date().toISOString();
      const currentLevels = JSON.stringify(levels);
      await webappDb
        .insertInto("electro_calculator_state")
        .values({ discord_id: discordId, current_levels: currentLevels, updated_at: updatedAt })
        .onConflict((oc) =>
          oc.column("discord_id").doUpdateSet({ current_levels: currentLevels, updated_at: updatedAt }),
        )
        .execute();
      return { currentLevels: levels, updatedAt };
    },
  );
}
