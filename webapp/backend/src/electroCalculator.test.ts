import { describe, expect, it } from "vitest";
import {
  ELECTRO_BUILDINGS,
  ELECTRO_MAX_LEVEL,
  ELECTRO_MIN_LEVEL,
  normalizeElectroLevels,
  parseStoredElectroLevels,
} from "./electroCalculator.js";

const allAt = (level: number) => Object.fromEntries(ELECTRO_BUILDINGS.map((n) => [n, level]));

describe("normalizeElectroLevels", () => {
  it("keeps a complete, valid map unchanged", () => {
    const input = { ...allAt(45), "Chief's Office": 50, Hospital: 31 };
    expect(normalizeElectroLevels(input)).toEqual(input);
  });

  it("returns null for anything that isn't a plain object", () => {
    expect(normalizeElectroLevels(null)).toBeNull();
    expect(normalizeElectroLevels(undefined)).toBeNull();
    expect(normalizeElectroLevels("45")).toBeNull();
    expect(normalizeElectroLevels(45)).toBeNull();
    expect(normalizeElectroLevels([45, 45, 45])).toBeNull();
  });

  it("clamps out-of-range levels into [30, 55]", () => {
    const out = normalizeElectroLevels({ ...allAt(40), "Chief's Office": 99, Hospital: 3 });
    expect(out?.["Chief's Office"]).toBe(ELECTRO_MAX_LEVEL);
    expect(out?.Hospital).toBe(ELECTRO_MIN_LEVEL);
  });

  it("truncates fractional levels and falls back for non-numbers", () => {
    const out = normalizeElectroLevels({
      ...allAt(40),
      "Guard Academy": 44.9,
      "Biker Academy": "50",
      "Marksman Academy": Number.NaN,
      "Dispatch Center": Infinity,
    });
    expect(out?.["Guard Academy"]).toBe(44);
    expect(out?.["Biker Academy"]).toBe(ELECTRO_MIN_LEVEL);
    expect(out?.["Marksman Academy"]).toBe(ELECTRO_MIN_LEVEL);
    expect(out?.["Dispatch Center"]).toBe(ELECTRO_MIN_LEVEL);
  });

  it("fills buildings missing from an older save with the minimum level and drops unknown keys", () => {
    const out = normalizeElectroLevels({ "Chief's Office": 47, "Some Future Building": 40 });
    expect(Object.keys(out ?? {}).sort()).toEqual([...ELECTRO_BUILDINGS].sort());
    expect(out?.["Chief's Office"]).toBe(47);
    expect(out?.Hospital).toBe(ELECTRO_MIN_LEVEL);
  });
});

describe("parseStoredElectroLevels", () => {
  it("round-trips JSON text", () => {
    const levels = { ...allAt(35), "Command Center": 55 };
    expect(parseStoredElectroLevels(JSON.stringify(levels))).toEqual(levels);
  });

  it("treats missing, empty, malformed or non-object text as nothing saved", () => {
    expect(parseStoredElectroLevels(undefined)).toBeNull();
    expect(parseStoredElectroLevels(null)).toBeNull();
    expect(parseStoredElectroLevels("")).toBeNull();
    expect(parseStoredElectroLevels("{not json")).toBeNull();
    expect(parseStoredElectroLevels("[1,2,3]")).toBeNull();
    expect(parseStoredElectroLevels("42")).toBeNull();
  });
});
