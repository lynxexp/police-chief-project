/**
 * Shared constants and normalization for the Electro Building Calculator's
 * saved "current levels" (see routes/electroCalculator.ts). Pure -- no
 * database or Fastify imports -- so it can be unit tested on its own.
 *
 * The building names and level range are duplicated from the frontend's
 * data/electroBuildingCosts.ts on purpose (the backend can't import from
 * the frontend package); keep the two in sync when a building or a new
 * Electro level is added. Names are the same display strings the frontend
 * uses as keys.
 */

export const ELECTRO_BUILDINGS = [
  "Chief's Office",
  "Guard Academy",
  "Biker Academy",
  "Marksman Academy",
  "Dispatch Center",
  "Command Center",
  "Hospital",
] as const;

/** Lowest level the calculator starts from (levels below this aren't
 * Electro-tier and aren't covered by the calculator). */
export const ELECTRO_MIN_LEVEL = 30;
/** Highest level in the cost data (Electro Level 5). */
export const ELECTRO_MAX_LEVEL = 55;

export type ElectroLevels = Record<string, number>;

/**
 * Turns whatever was stored (or sent) into a complete, in-range map of
 * building -> current level, or null when the input isn't an object at all.
 *
 * Deliberately forgiving rather than strict: a missing building (for
 * example one added to the calculator after this row was saved) falls back
 * to the minimum level, a non-integer or out-of-range value is clamped,
 * and unknown keys are dropped. That way an old or hand-edited row can
 * never make the page fail to load -- the worst case is that one building
 * restarts at 30.
 */
export function normalizeElectroLevels(input: unknown): ElectroLevels | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const raw = input as Record<string, unknown>;
  const out: ElectroLevels = {};
  for (const name of ELECTRO_BUILDINGS) {
    const value = raw[name];
    out[name] =
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(ELECTRO_MIN_LEVEL, Math.min(ELECTRO_MAX_LEVEL, Math.trunc(value)))
        : ELECTRO_MIN_LEVEL;
  }
  return out;
}

/** Parses the stored JSON text, returning null if it's missing or not
 * valid JSON/an object (callers treat that as "nothing saved"). */
export function parseStoredElectroLevels(text: string | null | undefined): ElectroLevels | null {
  if (!text) return null;
  try {
    return normalizeElectroLevels(JSON.parse(text));
  } catch {
    return null;
  }
}
