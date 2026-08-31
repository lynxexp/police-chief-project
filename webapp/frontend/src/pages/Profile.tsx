import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOutletContext, Link } from "react-router-dom";
import Layout from "../components/Layout";
import { getOwnProfile, type AuthContext, type OwnProfileEntry } from "../api/client";
import { EmptyState, ErrorState, LoadingRows, ProgressTrack, Shield } from "../components/ui";
import { attendanceRate, deltaVsLast, personalBest, streak } from "../hooks/engagement";

function compact(n: number | null): string {
  if (n === null) return "—";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(n);
}

/** One character's derived engagement bundle -- computed once per render
 * from its own recentVaultSessions, not stored anywhere. */
function useCharacterStats(entry: OwnProfileEntry) {
  return useMemo(() => {
    const pb = personalBest(entry.recentVaultSessions);
    const delta = deltaVsLast(entry.recentVaultSessions);
    const s = streak(entry.recentVaultSessions);
    const rate = attendanceRate(entry.recentVaultSessions);
    return { pb, delta, streak: s, turnoutPct: rate };
  }, [entry.recentVaultSessions]);
}

function CharacterCard({ entry, primary }: { entry: OwnProfileEntry; primary: boolean }) {
  const stats = useCharacterStats(entry);
  const turnoutTone =
    stats.turnoutPct >= 80 ? "text-up-ink" : stats.turnoutPct <= 50 ? "text-down-ink" : "text-ink";

  return (
    <div
      className={`overflow-hidden rounded-card border ${primary ? "border-gold-border" : "border-line"}`}
    >
      <div
        className={`flex items-center justify-between px-4 py-2 font-mono text-[11px] font-bold tracking-pill uppercase ${
          primary
            ? "bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] text-on-gold"
            : "bg-[#1D2833] text-ink-secondary"
        }`}
      >
        <span className="truncate">
          {entry.allianceName ?? "No alliance"}
          {entry.allianceTag ? ` [${entry.allianceTag}]` : ""}
        </span>
        <span className="shrink-0">FID {entry.fid}</span>
      </div>
      <div className="flex gap-4 bg-surface-panel p-[18px]">
        <div
          className="h-[92px] w-[76px] shrink-0 rounded-block border border-line-strong"
          style={{
            background: "repeating-linear-gradient(135deg, var(--portrait-stripe-a) 0 6px, var(--portrait-stripe-b) 6px 12px)",
          }}
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-2xl font-bold text-ink">
            {entry.nickname ?? `Character ${entry.fid}`}
          </h3>
          <p className="mt-0.5 text-[13px] text-ink-muted">
            Chief's Office {entry.chiefOfficeLv ?? "—"}
            {entry.state !== null ? ` · State ${entry.state}` : ""}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <div>
              <p className="font-mono text-[10px] tracking-[.12em] text-ink-faint uppercase">Power</p>
              <p className="font-display text-[22px] font-bold text-ink">{compact(entry.power)}</p>
            </div>
            <div>
              <p className="font-mono text-[10px] tracking-[.12em] text-ink-faint uppercase">Vault rank</p>
              <p className="font-display text-[22px] font-bold text-gold-ink">
                {entry.latestVaultRank ?? "—"}
              </p>
            </div>
            <div>
              <p className="font-mono text-[10px] tracking-[.12em] text-ink-faint uppercase">Turnout</p>
              <p className={`font-display text-[22px] font-bold ${turnoutTone}`}>
                {entry.recentVaultSessions.length ? `${Math.round(stats.turnoutPct)}%` : "—"}
              </p>
            </div>
          </div>
        </div>
      </div>
      {entry.allianceId !== null && (
        <div className="flex items-center justify-between border-t border-line-hairline bg-surface-panel px-4 py-2.5">
          <Link to={`/alliance/${entry.allianceId}`} className="font-sans text-sm font-medium text-gold-ink hover:text-text">
            View alliance →
          </Link>
          <span className="font-mono text-[11px] text-ink-faint">
            {entry.isActive ? "ACTIVE" : "INACTIVE"}
          </span>
        </div>
      )}
    </div>
  );
}

/** Personal-best banner for whichever linked character most recently set
 * one -- conditional, only rendered when personalBest() says so for at
 * least one character. */
function PersonalBestBanner({ entries }: { entries: OwnProfileEntry[] }) {
  const candidate = entries
    .map((e) => ({ e, pb: personalBest(e.recentVaultSessions), delta: deltaVsLast(e.recentVaultSessions) }))
    .find((c) => c.pb.isPersonalBest);
  if (!candidate) return null;

  const { e, pb, delta } = candidate;
  return (
    <div
      className="relative flex items-center gap-3.5 overflow-hidden rounded-card border border-up-fill p-4"
      style={{ background: "linear-gradient(135deg, #1F2A17, var(--surface-panel))" }}
    >
      <div className="sweep-pb sweep" aria-hidden="true" />
      <Shield size={44} tone="success">
        PB
      </Shield>
      <div className="relative min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-ink">
          New personal best on {e.nickname ?? `FID ${e.fid}`}
          {delta !== null ? ` — up ${Math.abs(Math.round(delta))}%` : ""}
        </p>
        <p className="font-mono text-xs text-ink-muted">
          {compact(pb.best)}
          {pb.previousBest !== null ? ` · prev ${compact(pb.previousBest)}` : ""}
        </p>
      </div>
      {e.allianceId !== null && (
        <Link
          to={`/alliance/${e.allianceId}/members/${e.fid}`}
          className="relative shrink-0 rounded-control border border-line-strong px-3 py-2 font-sans text-sm text-ink-secondary hover:bg-white/[.03]"
        >
          View record
        </Link>
      )}
    </div>
  );
}

function StreakCard({ entries }: { entries: OwnProfileEntry[] }) {
  // Best streak across every linked character -- one number is more
  // useful here than one card per character in an already-dense row.
  const best = entries.reduce(
    (acc, e) => {
      const s = streak(e.recentVaultSessions);
      return s.count > acc.count ? { count: s.count, sessions: e.recentVaultSessions } : acc;
    },
    { count: 0, sessions: [] as OwnProfileEntry["recentVaultSessions"] },
  );
  const blocks = best.sessions.slice(-6);

  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-surface-panel p-4">
      <p className="font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">Your streak</p>
      <p className="font-display text-[30px] leading-none font-bold text-ink">{best.count}</p>
      <p className="text-xs text-ink-muted">consecutive vault hunts attended</p>
      {blocks.length > 0 && (
        <div className="mt-1 flex gap-1">
          {blocks.map((b, i) => (
            <span
              key={i}
              className="h-[7px] flex-1 rounded-block"
              style={{ background: b.value !== null ? "var(--up-fill)" : "var(--down-fill)" }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Profile() {
  const ctx = useOutletContext<AuthContext>();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["profile"],
    queryFn: getOwnProfile,
  });

  const sortedByPrimary = data
    ? [...data].sort((a, b) => (b.power ?? 0) - (a.power ?? 0))
    : undefined;

  return (
    <Layout title="Your profile" eyebrow={`SIGNED IN AS ${ctx.discordId} · ${data?.length ?? 0} CHARACTERS LINKED`}>
      {isLoading && <LoadingRows rows={2} />}
      {error && <ErrorState message="Couldn't load your profile." onRetry={refetch} />}
      {data && data.length === 0 && (
        <EmptyState>
          No characters are linked to your Discord account yet. Use{" "}
          <code className="font-mono text-info-ink">/register</code> in Discord to link one.
        </EmptyState>
      )}

      {sortedByPrimary && sortedByPrimary.length > 0 && (
        <div className="flex flex-col gap-5">
          <PersonalBestBanner entries={sortedByPrimary} />

          <div className="grid gap-4 sm:grid-cols-2">
            {sortedByPrimary.map((entry, i) => (
              <CharacterCard key={entry.fid} entry={entry} primary={i === 0} />
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <StreakCard entries={sortedByPrimary} />
            <div className="flex flex-col gap-2 rounded-card border border-line bg-surface-panel p-4">
              <p className="font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">Vault turnout</p>
              <ProgressTrack pct={attendanceRate(sortedByPrimary[0].recentVaultSessions)} tone="up" height={10} />
              <p className="text-xs text-ink-muted">
                across your primary character's last {sortedByPrimary[0].recentVaultSessions.length} hunts
              </p>
            </div>
            <div className="flex flex-col gap-2 rounded-card border border-line bg-surface-panel p-4">
              <p className="font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">Gift codes</p>
              <Link to="/gift-codes" className="font-display text-lg font-bold text-gold-ink hover:text-text">
                View active codes →
              </Link>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
