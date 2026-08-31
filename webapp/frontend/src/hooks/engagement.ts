/**
 * Derived engagement data. Nothing here is new global state — every value
 * is computed from data the app already fetches, so the medals, arrows,
 * streaks and personal bests light up everywhere at once.
 *
 * Sessions are always chronological, oldest first.
 */

export type AttendanceState = "attended" | "missed" | "streak-break";

export interface Session {
  /** ISO date of the logged session. */
  date: string;
  /** Score for the member in that session; null = did not participate. */
  value: number | null;
}

/* --------------------------------------------------------------- deltas ---
   Last session vs the mean of the ones before it. Comparing to the single
   previous session made the arrows flip on noise.
   ------------------------------------------------------------------------ */

export function deltaVsLast(sessions: Session[]): number | null {
  const scored = sessions.filter((s): s is Session & { value: number } => s.value !== null);
  if (scored.length < 2) return null;
  const latest = scored[scored.length - 1].value;
  const prior = scored.slice(0, -1);
  const mean = prior.reduce((a, s) => a + s.value, 0) / prior.length;
  if (mean === 0) return null;
  return ((latest - mean) / mean) * 100;
}

/* -------------------------------------------------------- personal best ---
   Returns the previous max too, for the "prev 52.9M" line in the banner.
   ------------------------------------------------------------------------ */

export interface PersonalBest {
  isPersonalBest: boolean;
  best: number | null;
  previousBest: number | null;
  /** Index of the best session, for the dashed line + dot on the chart. */
  bestIndex: number;
}

export function personalBest(sessions: Session[]): PersonalBest {
  const scored = sessions
    .map((s, i) => ({ value: s.value, i }))
    .filter((s): s is { value: number; i: number } => s.value !== null);
  if (!scored.length) return { isPersonalBest: false, best: null, previousBest: null, bestIndex: -1 };

  const sorted = [...scored].sort((a, b) => b.value - a.value);
  const best = sorted[0];
  const latest = scored[scored.length - 1];
  const previousBest = sorted.find((s) => s.i !== best.i)?.value ?? null;

  return {
    isPersonalBest: latest.i === best.i && scored.length > 1 && latest.value > (previousBest ?? -Infinity),
    best: best.value,
    previousBest,
    bestIndex: best.i,
  };
}

/* -------------------------------------------------------------- streaks ---
   The trailing run of attended sessions, plus the index of the miss that
   broke it so the attendance grid can colour that one block red.
   ------------------------------------------------------------------------ */

export interface Streak {
  count: number;
  /** Index of the miss that ended the previous streak, or -1. */
  brokenAt: number;
}

export function streak(sessions: Session[]): Streak {
  let count = 0;
  let i = sessions.length - 1;
  for (; i >= 0; i--) {
    if (sessions[i].value === null) break;
    count++;
  }
  return { count, brokenAt: i };
}

/** `('attended' | 'missed' | 'streak-break')[]`, one per logged session. */
export function attendanceBlocks(sessions: Session[]): AttendanceState[] {
  const { brokenAt } = streak(sessions);
  return sessions.map((s, i) => {
    if (s.value !== null) return "attended";
    return i === brokenAt ? "streak-break" : "missed";
  });
}

export function attendanceRate(sessions: Session[]): number {
  if (!sessions.length) return 0;
  return (sessions.filter((s) => s.value !== null).length / sessions.length) * 100;
}

/* ------------------------------------------------------------ rank flash ---
   pcPop + pcRowFlash fire once per mount when a member's rank improved
   since the last load. Guard it, or the countdown tick makes the table
   twitch on every re-render.
   ------------------------------------------------------------------------ */

const RANK_KEY = "pc:lastRanks";

export function improvedRanks(boardId: string, ranks: Record<string, number>): Set<string> {
  const improved = new Set<string>();
  try {
    const raw = sessionStorage.getItem(RANK_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, Record<string, number>>) : {};
    const previous = all[boardId] ?? {};
    for (const [fid, rank] of Object.entries(ranks)) {
      const was = previous[fid];
      if (typeof was === "number" && rank < was) improved.add(fid);
    }
    all[boardId] = ranks;
    sessionStorage.setItem(RANK_KEY, JSON.stringify(all));
  } catch {
    /* private mode / quota — the flash is decorative, so fail silently */
  }
  return improved;
}
