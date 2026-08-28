import { BUILDINGS, BUILDING_NAMES, getBuilding, getTierForLevel, parseAmount, parseDuration } from "./electroBuildingCosts";

export interface ResourceTotal {
  cash: number;
  ammo: number;
  electricity: number;
  gas: number;
  electroCores: number;
  seconds: number;
}

const EMPTY_TOTAL: ResourceTotal = { cash: 0, ammo: 0, electricity: 0, gas: 0, electroCores: 0, seconds: 0 };

function addTotal(a: ResourceTotal, b: ResourceTotal): ResourceTotal {
  return {
    cash: a.cash + b.cash,
    ammo: a.ammo + b.ammo,
    electricity: a.electricity + b.electricity,
    gas: a.gas + b.gas,
    electroCores: a.electroCores + b.electroCores,
    seconds: a.seconds + b.seconds,
  };
}

/** Sum of every level from (fromLevel+1) through toLevel, inclusive.
 * Returns EMPTY_TOTAL if toLevel <= fromLevel (nothing to upgrade). */
export function costForRange(buildingName: string, fromLevel: number, toLevel: number): ResourceTotal {
  const building = getBuilding(buildingName);
  if (!building || toLevel <= fromLevel) return EMPTY_TOTAL;

  let total = EMPTY_TOTAL;
  for (let level = fromLevel + 1; level <= toLevel; level++) {
    const tier = getTierForLevel(building, level);
    if (!tier) continue; // level outside the 31-45 dataset
    total = addTotal(total, {
      cash: parseAmount(tier.cash),
      ammo: parseAmount(tier.ammo),
      electricity: parseAmount(tier.electricity),
      gas: parseAmount(tier.gas),
      electroCores: tier.electroCores,
      seconds: parseDuration(tier.time),
    });
  }
  return total;
}

export interface RequirementNote {
  /** The requiring building + level that produced this note (e.g. "Chief's Office 40" needs "Guard Academy 40"). */
  fromBuilding: string;
  fromLevel: number;
  building: string;
  level: number;
  /** False when `building` isn't one of the 7 tracked buildings (e.g. Research Center) -- can't be resolved automatically. */
  tracked: boolean;
}

export interface ResolveResult {
  /** building name -> minimum level needed to satisfy every explicit goal and every prerequisite chain those goals pull in. */
  requiredLevels: Record<string, number>;
  /** Every requirement encountered while resolving, tracked or not, for display ("also needs X, currently satisfied" or "not tracked"). */
  notes: RequirementNote[];
}

/**
 * Given where every tracked building currently stands and which ones the
 * user actually wants to raise (and to what), returns the full transitive
 * closure of levels every building must reach -- including buildings the
 * user didn't ask about, if something on their wishlist needs them higher
 * than they currently are. Fixed-point iteration: levels only ever go up
 * and are capped at 45, so this always terminates.
 */
export function resolveRequiredLevels(
  currentLevels: Record<string, number>,
  goals: Record<string, number>,
): ResolveResult {
  const required: Record<string, number> = { ...currentLevels };
  for (const name of BUILDING_NAMES) {
    required[name] = Math.max(required[name] ?? currentLevels[name] ?? 30, goals[name] ?? 0);
  }

  const notes: RequirementNote[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const building of BUILDINGS) {
      const target = required[building.name];
      const current = currentLevels[building.name] ?? 30;
      for (let level = current + 1; level <= target; level++) {
        const tier = getTierForLevel(building, level);
        if (!tier) continue;
        for (const req of tier.requirements) {
          const tracked = BUILDING_NAMES.includes(req.building);
          // Only record each distinct note once (same requiring level can
          // repeat across the tier's levels, which all carry the same reqs).
          const alreadyNoted = notes.some(
            (n) => n.fromBuilding === building.name && n.building === req.building && n.level === req.level,
          );
          if (!alreadyNoted) {
            notes.push({ fromBuilding: building.name, fromLevel: level, building: req.building, level: req.level, tracked });
          }
          if (tracked && (required[req.building] ?? 30) < req.level) {
            required[req.building] = req.level;
            changed = true;
          }
        }
      }
    }
  }

  return { requiredLevels: required, notes };
}
