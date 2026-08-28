import { useMemo, useState } from "react";
import Layout from "../components/Layout";
import { BUILDING_NAMES, MIN_LEVEL, MAX_LEVEL } from "../data/electroBuildingCosts";
import { costForRange, resolveRequiredLevels, type ResourceTotal } from "../data/electroBuildingCalculator";
import { Badge, Card, SectionHeading } from "../components/ui";

const compactFormatter = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
function compact(n: number): string {
  return n === 0 ? "0" : compactFormatter.format(n);
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0m";
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

const RESOURCE_LABELS: { key: keyof ResourceTotal; label: string; icon: string }[] = [
  { key: "cash", label: "Cash", icon: "💵" },
  { key: "ammo", label: "Ammo", icon: "🔫" },
  { key: "electricity", label: "Electricity", icon: "⚡" },
  { key: "gas", label: "Gas", icon: "⛽" },
  { key: "electroCores", label: "Electro Cores", icon: "🔷" },
];

// Plain number inputs are genuinely hard to use on a phone for a small,
// bounded range like this (30-45): the OS numeric keyboard covers most of
// the screen just to nudge a value by one, and native spinner arrows are
// tiny, inconsistent across mobile browsers, and easy to mis-tap. +/-
// buttons sized for a thumb (h-9 w-9, comfortably within Apple's 44px/CSS
// px touch-target guidance once padding's counted) cover the common
// "bump it up a bit" case without opening a keyboard at all; the field
// itself stays directly editable (type="text" + inputMode="numeric" for
// a numeric-only keypad, not type="number", so there's no inconsistent
// native spinner UI to fight with across browsers).
function LevelInput({
  value,
  onStep,
  onSetAbsolute,
  min,
  max,
}: {
  value: number;
  /** Relative change from a +/- tap. Resolved against the PARENT's latest
   * state via a functional setState update, not against this component's
   * `value` prop -- a rapid run of taps fires several onClick handlers
   * before React re-renders this component with a fresh `value`, so any
   * handler that computed `value + delta` itself would have every one of
   * those taps read the same stale number and only net one step instead of
   * several (confirmed via scripted rapid clicks during mobile QA). */
  onStep: (delta: number) => void;
  /** Absolute value from typing directly into the field. No staleness risk
   * here -- it's computed from the input's own current text, not a prop. */
  onSetAbsolute: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onStep(-1)}
        disabled={value <= min}
        aria-label="Decrease"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-slate-700 text-lg leading-none text-slate-300 hover:bg-slate-800 disabled:opacity-30"
      >
        −
      </button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={value}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "");
          if (!digits) return;
          const n = Number(digits);
          if (Number.isNaN(n)) return;
          onSetAbsolute(Math.max(min, Math.min(max, n)));
        }}
        className="w-11 shrink-0 rounded border border-slate-700 bg-slate-950 px-1 py-1.5 text-center text-sm"
      />
      <button
        type="button"
        onClick={() => onStep(1)}
        disabled={value >= max}
        aria-label="Increase"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-slate-700 text-lg leading-none text-slate-300 hover:bg-slate-800 disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}

/** Member-facing, no alliance scoping -- building costs are a fixed game
 * mechanic, not alliance data, so this needs no backend route at all;
 * everything here runs client-side against the static tables in
 * data/buildingCosts.ts. See that file's header for the data's source
 * and the levels 30-45 (Electro tier) scope. */
export default function ElectroBuildingCalculator() {
  const [currentLevels, setCurrentLevels] = useState<Record<string, number>>(() =>
    Object.fromEntries(BUILDING_NAMES.map((n) => [n, MIN_LEVEL])),
  );
  const [goalLevels, setGoalLevels] = useState<Record<string, number>>(() =>
    Object.fromEntries(BUILDING_NAMES.map((n) => [n, MIN_LEVEL])),
  );

  function setCurrent(name: string, level: number) {
    setCurrentLevels((prev) => ({ ...prev, [name]: level }));
    // Keep the goal from silently sitting below the new current level --
    // nudge it up to match rather than leaving a goal that would compute
    // to "nothing to upgrade" the moment current level passes it.
    setGoalLevels((prev) => (prev[name] < level ? { ...prev, [name]: level } : prev));
  }

  function setGoal(name: string, level: number) {
    setGoalLevels((prev) => ({ ...prev, [name]: Math.max(level, currentLevels[name]) }));
  }

  // Stepper (+/-) variants of the above, resolving the new value entirely
  // inside a functional setState update rather than from a component prop
  // -- see LevelInput's onStep doc comment for why that distinction matters
  // under rapid taps.
  function stepCurrent(name: string, delta: number) {
    setCurrentLevels((prev) => {
      const next = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, prev[name] + delta));
      setGoalLevels((prevGoal) => (prevGoal[name] < next ? { ...prevGoal, [name]: next } : prevGoal));
      return { ...prev, [name]: next };
    });
  }

  function stepGoal(name: string, delta: number) {
    setGoalLevels((prev) => {
      const next = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, prev[name] + delta));
      return { ...prev, [name]: Math.max(next, currentLevels[name]) };
    });
  }

  const { requiredLevels, notes } = useMemo(
    () => resolveRequiredLevels(currentLevels, goalLevels),
    [currentLevels, goalLevels],
  );

  const explicitGoalBuildings = BUILDING_NAMES.filter((n) => goalLevels[n] > currentLevels[n]);
  const buildingsNeedingWork = BUILDING_NAMES.filter((n) => requiredLevels[n] > currentLevels[n]);

  const perBuilding = buildingsNeedingWork.map((name) => ({
    name,
    from: currentLevels[name],
    to: requiredLevels[name],
    isExplicitGoal: explicitGoalBuildings.includes(name),
    total: costForRange(name, currentLevels[name], requiredLevels[name]),
  }));

  const grandTotal: ResourceTotal = perBuilding.reduce(
    (acc, b) => ({
      cash: acc.cash + b.total.cash,
      ammo: acc.ammo + b.total.ammo,
      electricity: acc.electricity + b.total.electricity,
      gas: acc.gas + b.total.gas,
      electroCores: acc.electroCores + b.total.electroCores,
      seconds: acc.seconds + b.total.seconds,
    }),
    { cash: 0, ammo: 0, electricity: 0, gas: 0, electroCores: 0, seconds: 0 },
  );

  const untrackedNotes = notes.filter(
    (n) => !n.tracked && explicitGoalOrRequiredPulledThis(n.fromBuilding),
  );

  function explicitGoalOrRequiredPulledThis(fromBuilding: string): boolean {
    return buildingsNeedingWork.includes(fromBuilding);
  }

  return (
    <Layout title="Electro Building Calculator">
      <p className="mb-4 text-sm text-slate-400">
        Covers the 7 Electro buildings at levels 30–45 — Chief's Office, Guard Academy, Biker
        Academy, Marksman Academy, Dispatch Center, Command Center, and Hospital. Set each
        building's current level, then raise the <strong>Goal</strong> for whichever one(s)
        you're planning to upgrade — if that requires another building to be higher than it
        currently is, this adds that building's own upgrade cost in automatically and calls it
        out below.
      </p>

      <Card className="mb-6">
        <SectionHeading>Your buildings</SectionHeading>

        {/* Below sm: a stepper control per building needs more width than a
            3-column table leaves it on a phone (confirmed -- the table
            version overflowed horizontally at 375px). Stacked cards give
            each building's Current/Goal controls the full row width instead. */}
        <div className="flex flex-col gap-3 sm:hidden">
          {BUILDING_NAMES.map((name) => (
            <div key={name} className="rounded border border-slate-800 p-3">
              <div className="mb-2 font-medium text-slate-200">{name}</div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-slate-400">Current</span>
                <LevelInput
                  value={currentLevels[name]}
                  min={MIN_LEVEL}
                  max={MAX_LEVEL}
                  onStep={(d) => stepCurrent(name, d)}
                  onSetAbsolute={(v) => setCurrent(name, v)}
                />
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-xs text-slate-400">Goal</span>
                <LevelInput
                  value={goalLevels[name]}
                  min={currentLevels[name]}
                  max={MAX_LEVEL}
                  onStep={(d) => stepGoal(name, d)}
                  onSetAbsolute={(v) => setGoal(name, v)}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-400">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Building</th>
                <th className="py-1.5 pr-3 font-medium">Current</th>
                <th className="py-1.5 font-medium">Goal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {BUILDING_NAMES.map((name) => (
                <tr key={name}>
                  <td className="py-2 pr-3 text-slate-200">{name}</td>
                  <td className="py-2 pr-3">
                    <LevelInput
                      value={currentLevels[name]}
                      min={MIN_LEVEL}
                      max={MAX_LEVEL}
                      onStep={(d) => stepCurrent(name, d)}
                      onSetAbsolute={(v) => setCurrent(name, v)}
                    />
                  </td>
                  <td className="py-2">
                    <LevelInput
                      value={goalLevels[name]}
                      min={currentLevels[name]}
                      max={MAX_LEVEL}
                      onStep={(d) => stepGoal(name, d)}
                      onSetAbsolute={(v) => setGoal(name, v)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {perBuilding.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-400">
            Raise a Goal above a building's Current level to see what it costs.
          </p>
        </Card>
      ) : (
        <>
          <Card className="mb-6">
            <SectionHeading>Total resources needed</SectionHeading>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {RESOURCE_LABELS.map(({ key, label, icon }) => (
                <div key={key} className="rounded border border-slate-800 bg-slate-950/50 p-3 text-center">
                  <div className="text-xs text-slate-500">
                    {icon} {label}
                  </div>
                  <div className="mt-1 font-mono text-lg text-slate-100">{compact(grandTotal[key])}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Estimated build time (no speedups): {formatDuration(grandTotal.seconds)}
            </p>
          </Card>

          <Card className="mb-6">
            <SectionHeading>By building</SectionHeading>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-slate-400">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">Building</th>
                    <th className="py-1.5 pr-3 font-medium">Levels</th>
                    {RESOURCE_LABELS.map(({ key, label }) => (
                      <th key={key} className="py-1.5 pr-3 text-right font-medium">
                        {label}
                      </th>
                    ))}
                    <th className="py-1.5 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {perBuilding.map((b) => (
                    <tr key={b.name}>
                      <td className="py-2 pr-3 text-slate-200">{b.name}</td>
                      <td className="py-2 pr-3 font-mono text-slate-400">
                        {b.from} → {b.to}
                      </td>
                      {RESOURCE_LABELS.map(({ key }) => (
                        <td key={key} className="py-2 pr-3 text-right font-mono text-slate-300">
                          {compact(b.total[key])}
                        </td>
                      ))}
                      <td className="py-2">
                        {b.isExplicitGoal ? (
                          <Badge variant="info">Your goal</Badge>
                        ) : (
                          <Badge variant="warning">Required</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-700">
                    <td className="py-2 pr-3 font-medium text-slate-200" colSpan={2}>
                      Total
                    </td>
                    {RESOURCE_LABELS.map(({ key }) => (
                      <td key={key} className="py-2 pr-3 text-right font-mono font-medium text-slate-100">
                        {compact(grandTotal[key])}
                      </td>
                    ))}
                    <td className="py-2" />
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          {untrackedNotes.length > 0 && (
            <Card>
              <SectionHeading>Also required (not tracked here)</SectionHeading>
              <ul className="space-y-1 text-sm text-slate-400">
                {untrackedNotes.map((n, i) => (
                  <li key={i}>
                    {n.fromBuilding} {n.fromLevel} needs <strong className="text-slate-200">{n.building} {n.level}</strong> —
                    not one of the 7 Electro buildings, so its cost isn't calculated here.
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </Layout>
  );
}
