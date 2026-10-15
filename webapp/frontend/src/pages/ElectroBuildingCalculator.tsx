import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Layout from "../components/Layout";
import { getElectroCalculatorLevels, saveElectroCalculatorLevels, type AuthContext } from "../api/client";
import { BUILDING_NAMES, MIN_LEVEL, MAX_LEVEL, LEGACY_MAX_LEVEL } from "../data/electroBuildingCosts";
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
// bounded range like this (30-55): the OS numeric keyboard covers most of
// the screen just to nudge a value by one, and native spinner arrows are
// tiny, inconsistent across mobile browsers, and easy to mis-tap. +/-
// buttons sized for a thumb (44px, Apple's touch-target guidance) cover
// the common "bump it up a bit" case without opening a keyboard at all;
// the field itself stays directly editable (type="text" + inputMode="numeric"
// for a numeric-only keypad, not type="number", so there's no inconsistent
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
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control border border-line text-lg leading-none text-ink-secondary hover:bg-white/[.04] disabled:opacity-30"
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
        className="w-12 shrink-0 rounded-control border border-line bg-surface-sunken px-1 py-2 text-center font-mono text-sm text-ink"
      />
      <button
        type="button"
        onClick={() => onStep(1)}
        disabled={value >= max}
        aria-label="Increase"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control border border-line text-lg leading-none text-ink-secondary hover:bg-white/[.04] disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}

/** Member-facing, no alliance scoping -- building costs are a fixed game
 * mechanic, not alliance data, so this needs no backend route at all;
 * everything here runs client-side against the static tables in
 * data/electroBuildingCosts.ts. See that file's header for the data's source
 * and the levels 30-55 (Electro 1-5) scope. */
export default function ElectroBuildingCalculator() {
  const [currentLevels, setCurrentLevels] = useState<Record<string, number>>(() =>
    Object.fromEntries(BUILDING_NAMES.map((n) => [n, MIN_LEVEL])),
  );
  const [goalLevels, setGoalLevels] = useState<Record<string, number>>(() =>
    Object.fromEntries(BUILDING_NAMES.map((n) => [n, MIN_LEVEL])),
  );

  // --- Saved "current" levels (signed-in members only) ----------------------
  // The page is public; when the visitor happens to be signed in, their
  // current levels are loaded on arrival and saved automatically as they
  // change, so they can come back and resume. Goals are deliberately not
  // saved -- they're a per-visit planning choice that starts from the
  // current levels each time. Signed-out visitors see no difference except
  // a hint that signing in enables this.
  const auth = useOutletContext<AuthContext | null | undefined>();
  const signedIn = Boolean(auth);
  // "pending": still loading what was saved. "ready": loaded (or nothing
  // saved yet) and auto-save is on. "failed": couldn't load, so saving is
  // switched off for this visit -- otherwise an auto-save of the defaults
  // could overwrite levels that are really still sitting on the server.
  const [saveStatus, setSaveStatus] = useState<"pending" | "ready" | "failed">("pending");
  const [saveProgress, setSaveProgress] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const savedQuery = useQuery({
    queryKey: ["electro-calculator", auth?.discordId],
    queryFn: getElectroCalculatorLevels,
    enabled: signedIn,
    // Load once per visit: a refetch on window focus must never swap the
    // page's levels out from under someone who is mid-edit.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    gcTime: 0,
  });

  const latestLevels = useRef(currentLevels);
  latestLevels.current = currentLevels;
  // True from the moment the user changes a current level until that
  // change has been sent -- the only thing that ever triggers a save, so
  // loading the saved levels (which also changes currentLevels) never
  // writes anything back.
  const unsavedChanges = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canSave = useRef(false);
  canSave.current = signedIn && saveStatus === "ready";

  useEffect(() => {
    if (!signedIn || saveStatus !== "pending" || savedQuery.isFetching) return;
    if (savedQuery.isError) {
      setSaveStatus("failed");
      return;
    }
    if (!savedQuery.isSuccess) return;
    const saved = savedQuery.data.currentLevels;
    if (saved) {
      const merged = Object.fromEntries(
        BUILDING_NAMES.map((n) => [n, Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, saved[n] ?? MIN_LEVEL))]),
      );
      setCurrentLevels(merged);
      // Goals start at (not below) the current levels, same as when a
      // current level is raised by hand.
      setGoalLevels(merged);
      // What's on screen is now exactly what's saved; edits made while a
      // failed load was being retried are replaced by it.
      unsavedChanges.current = false;
    }
    setSaveStatus("ready");
  }, [signedIn, saveStatus, savedQuery.isFetching, savedQuery.isError, savedQuery.isSuccess, savedQuery.data]);

  const flushSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (!unsavedChanges.current || !canSave.current) return;
    // Cleared before sending, so an edit made while the request is in
    // flight marks the page dirty again and gets its own save.
    unsavedChanges.current = false;
    setSaveProgress("saving");
    try {
      await saveElectroCalculatorLevels(latestLevels.current);
      setSaveProgress(unsavedChanges.current ? "saving" : "saved");
    } catch {
      unsavedChanges.current = true;
      setSaveProgress("error");
    }
  }, []);

  // Save shortly after the last edit (the +/- buttons can fire many times
  // in a row), and immediately if the tab is hidden or the page is left.
  useEffect(() => {
    if (!unsavedChanges.current || !canSave.current) return;
    saveTimer.current = setTimeout(() => void flushSave(), 700);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [currentLevels, saveStatus, flushSave]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flushSave();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      void flushSave();
    };
  }, [flushSave]);

  function retryLoadingSaved() {
    setSaveStatus("pending");
    void savedQuery.refetch();
  }

  function setCurrent(name: string, level: number) {
    unsavedChanges.current = true;
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
    unsavedChanges.current = true;
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

  // Hide the level controls while a signed-in visitor's saved levels are
  // still loading, so nothing can be edited (and then overwritten by the
  // load, or worse, saved over it) in that window.
  const showInputs = !(signedIn && saveStatus === "pending");

  const { requiredLevels, notes } = useMemo(
    () => resolveRequiredLevels(currentLevels, goalLevels),
    [currentLevels, goalLevels],
  );

  const explicitGoalBuildings = BUILDING_NAMES.filter((n) => goalLevels[n] > currentLevels[n]);
  const buildingsNeedingWork = BUILDING_NAMES.filter((n) => requiredLevels[n] > currentLevels[n]);

  // Which building's own goal is the reason a non-explicit building got
  // pulled up -- read off the same notes resolveRequiredLevels already
  // produced, not a second pass over the raw data.
  function pulledUpBy(name: string): string | null {
    const note = notes.find((n) => n.tracked && n.building === name && n.fromBuilding !== name);
    return note ? note.fromBuilding : null;
  }

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

  // Levels past 45 (Electro 4 and 5) only exist for States that have the
  // Electro Level 5 update unlocked -- warn when the plan depends on them.
  const needsElectro5Update = BUILDING_NAMES.some((n) => requiredLevels[n] > LEGACY_MAX_LEVEL);

  const untrackedNotes = notes.filter((n) => !n.tracked && explicitGoalOrRequiredPulledThis(n.fromBuilding));

  function explicitGoalOrRequiredPulledThis(fromBuilding: string): boolean {
    return buildingsNeedingWork.includes(fromBuilding);
  }

  return (
    <Layout title="Electro Building Calculator">
      <p className="text-sm text-ink-muted">
        Covers the 7 Electro buildings at levels 30–55 (Electro Levels 1–5) — Chief's Office, Guard Academy, Biker
        Academy, Marksman Academy, Dispatch Center, Command Center, and Hospital. Set each building's current level,
        then raise the{" "}
        <strong className="text-ink-secondary">Goal</strong> for whichever one(s) you're planning to upgrade — if
        that requires another building to be higher than it currently is, this adds that building's own upgrade
        cost in automatically and calls it out below.
      </p>

      <Card>
        <SectionHeading>Your buildings</SectionHeading>

        {!signedIn && (
          <p className="mb-3 text-xs text-ink-faint">
            <Link to="/login" className="text-ink-secondary underline">
              Sign in with Discord
            </Link>{" "}
            to save your current levels and pick up where you left off.
          </p>
        )}
        {signedIn && saveStatus === "pending" && (
          <p className="text-sm text-ink-muted">Loading your saved levels…</p>
        )}
        {signedIn && saveStatus === "failed" && (
          <p className="mb-3 text-xs text-ink-muted">
            Couldn't load your saved levels, so changes won't be saved this visit.{" "}
            <button type="button" onClick={retryLoadingSaved} className="text-ink-secondary underline">
              Try again
            </button>
          </p>
        )}
        {signedIn && saveStatus === "ready" && (
          <p className="mb-3 text-xs text-ink-faint" aria-live="polite">
            Your current levels are saved to your account automatically
            {saveProgress === "saving" && " — saving…"}
            {saveProgress === "saved" && " — saved ✓"}
            {saveProgress === "error" && (
              <>
                {" — "}
                <span className="text-down-ink">couldn't save.</span>{" "}
                <button type="button" onClick={() => void flushSave()} className="text-ink-secondary underline">
                  Retry
                </button>
              </>
            )}
            .
          </p>
        )}

        {showInputs && (<>
        {/* Below sm: a stepper control per building needs more width than a
            3-column table leaves it on a phone (confirmed -- the table
            version overflowed horizontally at 375px). Stacked cards give
            each building's Current/Goal controls the full row width instead. */}
        <div className="flex flex-col gap-3 sm:hidden">
          {BUILDING_NAMES.map((name) => {
            const hasGoal = goalLevels[name] > currentLevels[name];
            return (
              <div
                key={name}
                className={`rounded-card border p-3 ${hasGoal ? "border-gold-border bg-gold-tint" : "border-line"}`}
              >
                <div className="mb-2 font-sans text-sm font-semibold text-ink">{name}</div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-ink-muted">Current</span>
                  <LevelInput value={currentLevels[name]} min={MIN_LEVEL} max={MAX_LEVEL} onStep={(d) => stepCurrent(name, d)} onSetAbsolute={(v) => setCurrent(name, v)} />
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-xs text-ink-muted">Goal</span>
                  <LevelInput value={goalLevels[name]} min={currentLevels[name]} max={MAX_LEVEL} onStep={(d) => stepGoal(name, d)} onSetAbsolute={(v) => setGoal(name, v)} />
                </div>
              </div>
            );
          })}
        </div>

        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                <th className="py-1.5 pr-3 font-medium">Building</th>
                <th className="py-1.5 pr-3 font-medium">Current</th>
                <th className="py-1.5 font-medium">Goal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-hairline">
              {BUILDING_NAMES.map((name) => {
                const hasGoal = goalLevels[name] > currentLevels[name];
                return (
                  <tr key={name} className={hasGoal ? "border-l-[3px] border-[#C9A227] bg-gold-tint" : undefined}>
                    <td className="py-2 pr-3 text-ink">{name}</td>
                    <td className="py-2 pr-3">
                      <LevelInput value={currentLevels[name]} min={MIN_LEVEL} max={MAX_LEVEL} onStep={(d) => stepCurrent(name, d)} onSetAbsolute={(v) => setCurrent(name, v)} />
                    </td>
                    <td className="py-2">
                      <LevelInput value={goalLevels[name]} min={currentLevels[name]} max={MAX_LEVEL} onStep={(d) => stepGoal(name, d)} onSetAbsolute={(v) => setGoal(name, v)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>)}
      </Card>

      {perBuilding.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-muted">Raise a Goal above a building's Current level to see what it costs.</p>
        </Card>
      ) : (
        <>
          <Card>
            <SectionHeading>Total resources needed</SectionHeading>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {RESOURCE_LABELS.map(({ key, label, icon }) => (
                <div key={key} className="rounded-card border border-line bg-surface-sunken p-3 text-center">
                  <p className="font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                    {icon} {label}
                  </p>
                  <p className="mt-1 font-display text-lg font-bold text-ink">{compact(grandTotal[key])}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-ink-faint">Estimated build time (no speedups): {formatDuration(grandTotal.seconds)}</p>
          </Card>

          <Card>
            <SectionHeading>By building</SectionHeading>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
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
                <tbody className="divide-y divide-line-hairline">
                  {perBuilding.map((b, i) => {
                    const pulledBy = !b.isExplicitGoal ? pulledUpBy(b.name) : null;
                    return (
                      <tr key={b.name} className={i % 2 === 1 ? "bg-surface-panel-alt" : undefined}>
                        <td className="py-2 pr-3">
                          <span className="text-ink">{b.name}</span>
                          {pulledBy && <p className="text-xs text-ink-faint">pulled up by {pulledBy}'s goal</p>}
                        </td>
                        <td className="py-2 pr-3 font-mono text-ink-muted">
                          {b.from} → {b.to}
                        </td>
                        {RESOURCE_LABELS.map(({ key }) => (
                          <td key={key} className="py-2 pr-3 text-right font-mono text-ink-secondary">
                            {compact(b.total[key])}
                          </td>
                        ))}
                        <td className="py-2">
                          {b.isExplicitGoal ? <Badge variant="warning">Your goal</Badge> : <Badge variant="info">Required</Badge>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-line-strong">
                    <td className="py-2 pr-3 font-semibold text-ink" colSpan={2}>
                      Total
                    </td>
                    {RESOURCE_LABELS.map(({ key }) => (
                      <td key={key} className="py-2 pr-3 text-right font-mono font-semibold text-ink">
                        {compact(grandTotal[key])}
                      </td>
                    ))}
                    <td className="py-2" />
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          {needsElectro5Update && (
            <Card>
              <SectionHeading>Electro Level 4–5 (levels 46–55)</SectionHeading>
              <p className="text-sm text-ink-muted">
                Levels above 45 are part of the Electro Level 5 update, which unlocks State by State (the game client
                checks that your State has been open at least 154 days). If your State doesn't have it yet, these
                levels aren't available to you. Chief's Office 46–50 needs Dispatch Center 45 and Marksman Academy 45;
                51–55 needs Dispatch Center 50 and Biker Academy 50. The Academies, Hospital and Dispatch Center need
                the Chief's Office at 50 (for 46–50) or 55 (for 51–55), and the Command Center needs both the
                Chief's Office and Dispatch Center there.
              </p>
            </Card>
          )}

          {untrackedNotes.length > 0 && (
            <Card>
              <SectionHeading>Also required (not tracked here)</SectionHeading>
              <ul className="flex flex-col gap-1 text-sm text-ink-muted">
                {untrackedNotes.map((n, i) => (
                  <li key={i}>
                    {n.fromBuilding} {n.fromLevel} needs{" "}
                    <strong className="text-ink">
                      {n.building} {n.level}
                    </strong>{" "}
                    — not one of the 7 Electro buildings, so its cost isn't calculated here.
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
