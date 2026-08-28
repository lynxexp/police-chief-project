/**
 * Electro-tier (levels 31-45) upgrade costs for the 7 "Electro buildings" --
 * Chief's Office, Guard Academy, Biker Academy, Marksman Academy, Dispatch
 * Center, Command Center, and Hospital. Sourced from
 * https://www.policechiefguides.com/data/electro-building-upgrade-costs
 * (cross-checked against that page's own "total Electro Cores to max"
 * figures per building, which match summing this file's tiers exactly).
 *
 * Costs are genuinely flat across 5-level bands (31-35, 36-40, 41-45) in
 * the source data, not an approximation -- every level within a band
 * costs identically and shares the same prerequisite requirement, so
 * each building is stored as 3 tiers rather than 15 individual rows.
 *
 * Levels 1-30 (pre-Electro) aren't included -- a different dataset
 * (Building Construction Times) covers those; this calculator only
 * supports building levels 30 and up for now.
 *
 * A requirement's `building` is sometimes NOT one of these 7 (e.g. Chief's
 * Office 31-35 requires Research Center 30) -- those are surfaced as
 * informational notes in the calculator rather than checked/resolved,
 * since this dataset doesn't track that building's own levels.
 */

export interface Requirement {
  building: string;
  level: number;
}

export interface CostTier {
  fromLevel: number;
  toLevel: number;
  cash: string;
  ammo: string;
  electricity: string;
  gas: string;
  electroCores: number;
  time: string;
  requirements: Requirement[];
}

export interface BuildingData {
  name: string;
  tiers: CostTier[];
}

export const MIN_LEVEL = 30;
export const MAX_LEVEL = 45;

// Shared by Guard/Biker/Marksman Academy -- identical costs and
// requirements across all three in the source data.
const ACADEMY_TIERS: CostTier[] = [
  {
    fromLevel: 31,
    toLevel: 35,
    cash: "23M",
    ammo: "23M",
    electricity: "4.7M",
    gas: "1.1M",
    electroCores: 59,
    time: "1d 1h 12m",
    requirements: [{ building: "Chief's Office", level: 35 }],
  },
  {
    fromLevel: 36,
    toLevel: 40,
    cash: "25M",
    ammo: "25M",
    electricity: "5M",
    gas: "1.2M",
    electroCores: 71,
    time: "1d 8h 24m",
    requirements: [{ building: "Chief's Office", level: 40 }],
  },
  {
    fromLevel: 41,
    toLevel: 45,
    cash: "27M",
    ammo: "27M",
    electricity: "5.5M",
    gas: "1.3M",
    electroCores: 107,
    time: "1d 15h 36m",
    requirements: [{ building: "Chief's Office", level: 45 }],
  },
];

export const BUILDINGS: BuildingData[] = [
  {
    name: "Chief's Office",
    tiers: [
      {
        fromLevel: 31,
        toLevel: 35,
        cash: "67M",
        ammo: "67M",
        electricity: "13M",
        gas: "3.3M",
        electroCores: 132,
        time: "7d",
        requirements: [
          { building: "Dispatch Center", level: 30 },
          { building: "Research Center", level: 30 },
        ],
      },
      {
        fromLevel: 36,
        toLevel: 40,
        cash: "72M",
        ammo: "72M",
        electricity: "14M",
        gas: "3.6M",
        electroCores: 158,
        time: "9d",
        requirements: [
          { building: "Dispatch Center", level: 35 },
          { building: "Biker Academy", level: 35 },
        ],
      },
      {
        fromLevel: 41,
        toLevel: 45,
        cash: "79M",
        ammo: "79M",
        electricity: "15M",
        gas: "3.9M",
        electroCores: 238,
        time: "11d",
        requirements: [
          { building: "Dispatch Center", level: 40 },
          { building: "Guard Academy", level: 40 },
        ],
      },
    ],
  },
  { name: "Guard Academy", tiers: ACADEMY_TIERS },
  { name: "Biker Academy", tiers: ACADEMY_TIERS },
  { name: "Marksman Academy", tiers: ACADEMY_TIERS },
  {
    name: "Dispatch Center",
    tiers: [
      {
        fromLevel: 31,
        toLevel: 35,
        cash: "13M",
        ammo: "13M",
        electricity: "2.7M",
        gas: "670,000",
        electroCores: 33,
        time: "4d 14h 52m",
        requirements: [{ building: "Chief's Office", level: 35 }],
      },
      {
        fromLevel: 36,
        toLevel: 40,
        cash: "14M",
        ammo: "14M",
        electricity: "2.9M",
        gas: "720,000",
        electroCores: 39,
        time: "5d 22h 33m",
        requirements: [{ building: "Chief's Office", level: 40 }],
      },
      {
        fromLevel: 41,
        toLevel: 45,
        cash: "15M",
        ammo: "15M",
        electricity: "3.1M",
        gas: "790,000",
        electroCores: 59,
        time: "7d 6h 14m",
        requirements: [{ building: "Chief's Office", level: 45 }],
      },
    ],
  },
  {
    name: "Command Center",
    tiers: [
      {
        fromLevel: 31,
        toLevel: 35,
        cash: "20M",
        ammo: "20M",
        electricity: "4M",
        gas: "1M",
        electroCores: 26,
        time: "20h 9m 30s",
        requirements: [
          { building: "Chief's Office", level: 35 },
          { building: "Dispatch Center", level: 35 },
        ],
      },
      {
        fromLevel: 36,
        toLevel: 40,
        cash: "21M",
        ammo: "21M",
        electricity: "4.3M",
        gas: "1M",
        electroCores: 31,
        time: "1d 1h 55m",
        requirements: [
          { building: "Chief's Office", level: 40 },
          { building: "Dispatch Center", level: 40 },
        ],
      },
      {
        fromLevel: 41,
        toLevel: 45,
        cash: "23M",
        ammo: "23M",
        electricity: "4.7M",
        gas: "1.1M",
        electroCores: 47,
        time: "1d 7h 40m",
        requirements: [
          { building: "Chief's Office", level: 45 },
          { building: "Dispatch Center", level: 45 },
        ],
      },
    ],
  },
  {
    name: "Hospital",
    tiers: [
      {
        fromLevel: 31,
        toLevel: 35,
        cash: "16M",
        ammo: "16M",
        electricity: "3.3M",
        gas: "840,000",
        electroCores: 26,
        time: "23h 31m",
        requirements: [
          { building: "Chief's Office", level: 35 },
          { building: "Dispatch Center", level: 35 },
        ],
      },
      {
        fromLevel: 36,
        toLevel: 40,
        cash: "18M",
        ammo: "18M",
        electricity: "3.6M",
        gas: "900,000",
        electroCores: 31,
        time: "1d 6h 14m",
        requirements: [
          { building: "Chief's Office", level: 40 },
          { building: "Dispatch Center", level: 40 },
        ],
      },
      {
        fromLevel: 41,
        toLevel: 45,
        cash: "19M",
        ammo: "19M",
        electricity: "3.9M",
        gas: "990,000",
        electroCores: 47,
        time: "1d 12h 57m",
        requirements: [
          { building: "Chief's Office", level: 45 },
          { building: "Dispatch Center", level: 45 },
        ],
      },
    ],
  },
];

export const BUILDING_NAMES = BUILDINGS.map((b) => b.name);

/** "23M" -> 23_000_000, "670,000" -> 670_000, "132" -> 132. */
export function parseAmount(raw: string): number {
  const cleaned = raw.replace(/,/g, "").trim();
  const match = cleaned.match(/^([\d.]+)\s*([kKmMbB]?)$/);
  if (!match) return 0;
  const [, numStr, suffix] = match;
  const num = parseFloat(numStr);
  switch (suffix.toLowerCase()) {
    case "k":
      return Math.round(num * 1_000);
    case "m":
      return Math.round(num * 1_000_000);
    case "b":
      return Math.round(num * 1_000_000_000);
    default:
      return Math.round(num);
  }
}

/** "1d 1h 12m" / "20h 9m 30s" / "7d" -> total seconds. */
export function parseDuration(raw: string): number {
  const re = /(\d+)\s*(d|h|m|s)/g;
  const unitSeconds: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0;
  let match;
  while ((match = re.exec(raw)) !== null) {
    total += Number(match[1]) * unitSeconds[match[2]];
  }
  return total;
}

export function getBuilding(name: string): BuildingData | undefined {
  return BUILDINGS.find((b) => b.name === name);
}

/** The single tier covering this level, or undefined if out of [31, 45]. */
export function getTierForLevel(building: BuildingData, level: number): CostTier | undefined {
  return building.tiers.find((t) => level >= t.fromLevel && level <= t.toLevel);
}
