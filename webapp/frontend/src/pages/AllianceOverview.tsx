import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useOutletContext, useParams } from "react-router-dom";
import {
  ResponsiveContainer,
  LineChart,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  Area,
} from "recharts";
import Layout from "../components/Layout";
import {
  getAllianceInfo,
  getAllianceMembers,
  getAllianceVaultTraps,
  getAllianceVaultTrend,
  getAllianceCapitolTrend,
  getVaultLeaderboard,
  getVaultAttendance,
  getAllianceGoal,
  saveAllianceGoal,
  deleteAllianceGoal,
  type AllianceVaultTrendPoint,
  type AllianceGoal,
  type AllianceGoalInput,
  type AuthContext,
} from "../api/client";
import { Card, ErrorState, LoadingRows, PageHeader, Pill, ProgressTrack, RankShield, StatTile, Toggle, buttonPrimary, buttonSecondary } from "../components/ui";
import { deltaVsLast } from "../hooks/engagement";

const GOAL_METRIC_LABELS: Record<AllianceGoal["metric"], string> = {
  vault: "Vault damage",
  capitol: "Capitol points",
  turnout: "Turnout",
  perfect: "Perfect records",
};

function formatGoalNumber(metric: AllianceGoal["metric"], n: number): string {
  if (metric === "turnout") return `${n}%`;
  if (metric === "perfect") return String(n);
  return formatCompactNumber(n);
}

function AllianceGoalPanel({ allianceId, canEdit }: { allianceId: number; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { data: goal, isLoading } = useQuery({
    queryKey: ["alliance-goal", allianceId],
    queryFn: () => getAllianceGoal(allianceId),
  });
  const [editing, setEditing] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["alliance-goal", allianceId] });
  const deleteMutation = useMutation({
    mutationFn: () => deleteAllianceGoal(allianceId),
    onSuccess: invalidate,
  });

  if (isLoading) return null;
  // No goal row means no panel at all -- an empty track reads as a broken
  // feature, not "not configured yet".
  if (!goal && !canEdit) return null;

  if (!goal) {
    return (
      <Card>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-ink-muted">No alliance goal is set for this cycle yet.</p>
          <button onClick={() => setEditing(true)} className={buttonSecondary}>
            Set a goal
          </button>
        </div>
        {editing && <AllianceGoalEditor allianceId={allianceId} goal={null} onClose={() => setEditing(false)} onSaved={invalidate} />}
      </Card>
    );
  }

  const pct = Math.min(100, Math.round((goal.progress / goal.target) * 100));
  const elapsedFraction = (() => {
    const start = new Date(goal.windowStartsOn).getTime();
    const end = new Date(goal.windowEndsOn).getTime();
    const now = Date.now();
    if (end <= start) return 1;
    return Math.min(1, Math.max(0, (now - start) / (end - start)));
  })();
  const met = goal.progress >= goal.target;
  const onPace = !met && goal.progress / goal.target >= elapsedFraction;
  const tone = met ? "up" : onPace ? "gold" : "down";
  const toneInk = met ? "text-up-ink" : onPace ? "text-gold-ink" : "text-down-ink";

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-display text-[19px] font-semibold tracking-heading text-ink uppercase">{GOAL_METRIC_LABELS[goal.metric]} goal</p>
          <p className="mt-1 font-mono text-xs text-ink-muted">
            {formatGoalNumber(goal.metric, goal.progress)} of {formatGoalNumber(goal.metric, goal.target)}
            {" · "}
            {goal.cycleKind === "window" ? "fixed window" : goal.cycleKind === "monthly" ? "this month" : "last 7 days"}
            {goal.repeats ? " · repeats" : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <p className={`font-mono text-[22px] font-bold ${toneInk}`}>{pct}%</p>
          {canEdit && (
            <button onClick={() => setEditing(true)} className={buttonSecondary}>
              Edit
            </button>
          )}
        </div>
      </div>
      <div className="mt-3">
        <ProgressTrack pct={pct} tone={tone} />
      </div>
      {met && <p className="mt-2 text-xs text-up-ink">Goal met for this cycle.</p>}
      {canEdit && !editing && (
        <button
          onClick={() => {
            if (window.confirm("Remove this alliance goal?")) deleteMutation.mutate();
          }}
          disabled={deleteMutation.isPending}
          className="mt-3 text-xs text-ink-faint hover:text-down-ink"
        >
          Remove goal
        </button>
      )}
      {editing && <AllianceGoalEditor allianceId={allianceId} goal={goal} onClose={() => setEditing(false)} onSaved={invalidate} />}
    </Card>
  );
}

function AllianceGoalEditor({
  allianceId,
  goal,
  onClose,
  onSaved,
}: {
  allianceId: number;
  goal: AllianceGoal | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [metric, setMetric] = useState<AllianceGoal["metric"]>(goal?.metric ?? "vault");
  const [target, setTarget] = useState(goal?.target ?? 100);
  const [cycleKind, setCycleKind] = useState<AllianceGoal["cycleKind"]>(goal?.cycleKind ?? "monthly");
  const [startsOn, setStartsOn] = useState(goal?.startsOn ?? new Date().toISOString().slice(0, 10));
  const [endsOn, setEndsOn] = useState(goal?.endsOn ?? "");
  const [repeats, setRepeats] = useState(goal?.repeats ?? true);
  const [officersOnly, setOfficersOnly] = useState(goal?.visibility === "officers");

  const saveMutation = useMutation({
    mutationFn: () => {
      const input: AllianceGoalInput = {
        metric,
        target,
        cycleKind,
        startsOn,
        endsOn: cycleKind === "window" ? endsOn || null : null,
        repeats,
        visibility: officersOnly ? "officers" : "everyone",
      };
      return saveAllianceGoal(allianceId, input);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const fieldClass = "mt-1 w-full rounded-control border border-line bg-surface-sunken px-3 py-1.5 text-sm text-ink";

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-line-hairline pt-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-ink-muted">Metric</span>
          <select value={metric} onChange={(e) => setMetric(e.target.value as AllianceGoal["metric"])} className={fieldClass}>
            <option value="vault">Vault damage</option>
            <option value="capitol">Capitol points</option>
            <option value="turnout">Turnout %</option>
            <option value="perfect">Perfect records</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-ink-muted">Target</span>
          <input type="number" min={1} value={target} onChange={(e) => setTarget(Number(e.target.value))} className={fieldClass} />
        </label>
      </div>
      <div className="flex gap-1.5">
        {(["monthly", "rolling7", "window"] as const).map((k) => (
          <Pill key={k} active={cycleKind === k} onClick={() => setCycleKind(k)}>
            {k === "monthly" ? "This month" : k === "rolling7" ? "Rolling 7 days" : "Fixed window"}
          </Pill>
        ))}
      </div>
      {cycleKind === "window" && (
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-ink-muted">Starts on</span>
            <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} className={fieldClass} />
          </label>
          <label className="block">
            <span className="text-xs text-ink-muted">Ends on</span>
            <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} className={fieldClass} />
          </label>
        </div>
      )}
      <label className="flex items-center justify-between gap-2 text-sm text-ink-secondary">
        Roll target forward each cycle
        <Toggle checked={repeats} onChange={setRepeats} label="Repeats" />
      </label>
      <label className="flex items-center justify-between gap-2 text-sm text-ink-secondary">
        Officers only
        <Toggle checked={officersOnly} onChange={setOfficersOnly} label="Officers only" />
      </label>
      <div className="flex items-center gap-3">
        <button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || (cycleKind === "window" && (!startsOn || !endsOn))}
          className={buttonPrimary}
        >
          Save goal
        </button>
        <button onClick={onClose} className={buttonSecondary}>
          Cancel
        </button>
        {saveMutation.isError && <span className="text-xs text-down-ink">{(saveMutation.error as Error).message}</span>}
      </div>
    </div>
  );
}

const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 2,
});
function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(value);
}

/** Players typically only run Vault 1 OR Vault 2, not both -- see
 * routes/member.ts's vault-trend/vault-traps endpoints -- so this pivots
 * the per-trap series into one row per date with a totalDamage_<trap>
 * column each, and plots one line per trap rather than blending two
 * largely non-overlapping rosters into a single misleading total. */
function mergeVaultSeriesByDate(
  series: { trap: number; points: AllianceVaultTrendPoint[] }[],
): Record<string, string | number>[] {
  const dates = new Set<string>();
  for (const s of series) for (const p of s.points) dates.add(p.date);
  return [...dates].sort().map((date) => {
    const row: Record<string, string | number> = { date };
    for (const s of series) {
      const point = s.points.find((p) => p.date === date);
      if (point) row[`trap_${s.trap}`] = point.totalDamage;
    }
    return row;
  });
}

export default function AllianceOverview() {
  const ctx = useOutletContext<AuthContext>();
  const { allianceId: allianceIdParam } = useParams<{ allianceId: string }>();
  const allianceId = Number(allianceIdParam);
  const [leaderboardTrap, setLeaderboardTrap] = useState<number | undefined>(undefined);
  const canEditGoal = ctx.tier !== "none";

  const info = useQuery({ queryKey: ["alliance-info", allianceId], queryFn: () => getAllianceInfo(allianceId) });
  const members = useQuery({
    queryKey: ["alliance-members", allianceId],
    queryFn: () => getAllianceMembers(allianceId),
  });
  const vaultTraps = useQuery({
    queryKey: ["alliance-vault-traps", allianceId],
    queryFn: () => getAllianceVaultTraps(allianceId),
  });
  const vaultTrendByTrap = useQuery({
    queryKey: ["alliance-vault-trend-by-trap", allianceId, vaultTraps.data],
    queryFn: async () => {
      const traps = vaultTraps.data!;
      const points = await Promise.all(traps.map((trap) => getAllianceVaultTrend(allianceId, trap)));
      return traps.map((trap, i) => ({ trap, points: points[i] }));
    },
    enabled: !!vaultTraps.data && vaultTraps.data.length > 0,
  });
  const capitolTrend = useQuery({
    queryKey: ["alliance-capitol-trend", allianceId],
    queryFn: () => getAllianceCapitolTrend(allianceId),
  });
  const attendance = useQuery({
    queryKey: ["alliance-vault-attendance-overall", allianceId],
    queryFn: () => getVaultAttendance(allianceId),
  });
  const leaderboard = useQuery({
    queryKey: ["alliance-vault-leaderboard", allianceId, leaderboardTrap],
    queryFn: () => getVaultLeaderboard(allianceId, { trap: leaderboardTrap }),
  });

  const vaultChartRows = vaultTrendByTrap.data ? mergeVaultSeriesByDate(vaultTrendByTrap.data) : [];

  const vaultDamageDelta = useMemo(() => {
    if (!vaultChartRows.length) return { total: 0, delta: null as number | null };
    const totals = vaultChartRows.map((row) => ({
      date: String(row.date),
      value: Object.entries(row)
        .filter(([k]) => k.startsWith("trap_"))
        .reduce((sum, [, v]) => sum + Number(v), 0),
    }));
    return { total: totals[totals.length - 1].value, delta: deltaVsLast(totals) };
  }, [vaultChartRows]);

  const capitolDelta = useMemo(() => {
    const points = capitolTrend.data ?? [];
    if (!points.length) return { total: 0, delta: null as number | null };
    const sessions = points.map((p) => ({ date: p.date, value: p.totalPoints }));
    return { total: points[points.length - 1].totalPoints, delta: deltaVsLast(sessions) };
  }, [capitolTrend.data]);

  const alliancePower = useMemo(
    () => (members.data ?? []).reduce((sum, m) => sum + (m.power ?? 0), 0),
    [members.data],
  );

  const turnout = useMemo(() => {
    if (!attendance.data || !members.data) return null;
    const attended = attendance.data.members.filter((m) => m.attended > 0).length;
    return { attended, total: members.data.length };
  }, [attendance.data, members.data]);

  const podium = (leaderboard.data ?? []).slice(0, 3);
  const rest = (leaderboard.data ?? []).slice(3);

  return (
    <Layout title={info.data?.name ?? "Alliance overview"} backTo={{ to: "/", label: "Your profile" }} hideHeader>
      <div
        className="relative overflow-hidden rounded-frame border border-line p-[22px] lg:p-[26px]"
        style={{ background: "var(--hero-gradient)" }}
      >
        <div className="sweep" aria-hidden="true" />
        <PageHeader
          eyebrow={info.data ? `${info.data.memberCount} MEMBERS${info.data.state !== null ? ` · STATE ${info.data.state}` : ""}${info.data.tag ? ` · TAG ${info.data.tag}` : ""}` : undefined}
          title={info.data?.name ?? "Alliance overview"}
        />
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Vault damage"
          figure={formatCompactNumber(vaultDamageDelta.total)}
          delta={
            vaultDamageDelta.delta !== null ? (
              <span className={`text-xs font-semibold ${vaultDamageDelta.delta >= 0 ? "text-up-ink" : "text-down-ink"}`}>
                {vaultDamageDelta.delta >= 0 ? "▲" : "▼"} {Math.abs(Math.round(vaultDamageDelta.delta))}%
              </span>
            ) : undefined
          }
        />
        <StatTile
          label="Capitol points"
          figure={formatCompactNumber(capitolDelta.total)}
          delta={
            capitolDelta.delta !== null ? (
              <span className={`text-xs font-semibold ${capitolDelta.delta >= 0 ? "text-up-ink" : "text-down-ink"}`}>
                {capitolDelta.delta >= 0 ? "▲" : "▼"} {Math.abs(Math.round(capitolDelta.delta))}%
              </span>
            ) : undefined
          }
        />
        <StatTile label="Turnout" figure={turnout?.attended ?? "—"} denominator={turnout?.total} />
        <StatTile label="Alliance power" figure={formatCompactNumber(alliancePower)} inverted />
      </div>

      <div className="mt-5">
        <AllianceGoalPanel allianceId={allianceId} canEdit={canEditGoal} />
      </div>

      <div className="mt-5 grid gap-3.5 lg:grid-cols-[1.15fr_1fr]">
        <Card>
          <p className="mb-3 font-display text-[17px] font-semibold tracking-heading text-ink uppercase">
            Vault Trap total damage
          </p>
          {vaultChartRows.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={vaultChartRows}>
                <defs>
                  <linearGradient id="vaultFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--info-ink)" stopOpacity={0.12} />
                    <stop offset="100%" stopColor="var(--info-ink)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border-hairline)" strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke="var(--text-faint)" tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
                <YAxis
                  stroke="var(--text-faint)"
                  tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
                  tickFormatter={formatCompactNumber}
                  width={48}
                />
                <Tooltip
                  contentStyle={{ background: "var(--surface-sunken)", border: "1px solid var(--border)" }}
                  formatter={(value) => formatCompactNumber(Number(value))}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {vaultTraps.data?.map((trap, i) =>
                  i === 0 ? (
                    <Area
                      key={trap}
                      type="monotone"
                      dataKey={`trap_${trap}`}
                      name={`Vault ${trap}`}
                      stroke="var(--info-ink)"
                      fill="url(#vaultFill)"
                      dot={{ r: 3 }}
                      connectNulls
                    />
                  ) : (
                    <Line
                      key={trap}
                      type="monotone"
                      dataKey={`trap_${trap}`}
                      name={`Vault ${trap}`}
                      stroke="var(--gold-ink)"
                      dot={{ r: 3 }}
                      connectNulls
                    />
                  ),
                )}
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-ink-muted">No vault hunts recorded yet.</p>
          )}
        </Card>

        <Card>
          <p className="mb-3 font-display text-[17px] font-semibold tracking-heading text-ink uppercase">
            Top attendance
          </p>
          {attendance.data && attendance.data.members.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              {[...attendance.data.members]
                .sort((a, b) => b.attendanceRate - a.attendanceRate)
                .slice(0, 6)
                .map((m) => (
                  <div key={m.fid} className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <span className="truncate font-sans text-sm text-ink-secondary">{m.nickname ?? `FID ${m.fid}`}</span>
                    <span className="w-10 shrink-0 text-right font-mono text-xs text-ink-muted">
                      {Math.round(m.attendanceRate * 100)}%
                    </span>
                    <div className="col-span-2">
                      <ProgressTrack pct={m.attendanceRate * 100} tone={m.attendanceRate >= 0.8 ? "up" : "gold"} height={6} />
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <p className="text-sm text-ink-muted">No attendance data yet.</p>
          )}
          <p className="mt-3 border-t border-line-hairline pt-3 text-xs text-ink-faint">
            Ranked by vault attendance rate across all recorded hunts.
          </p>
        </Card>
      </div>

      {/* Capitol War trend kept as its own row -- the design's chart layout
          only specced one game mode's chart alongside the attendance
          panel above, but this alliance still tracks Capitol independently
          and dropping it would lose real, already-built functionality. */}
      <Card className="mt-5">
        <p className="mb-3 font-display text-[17px] font-semibold tracking-heading text-ink uppercase">
          Capitol War total points
        </p>
        {capitolTrend.data && capitolTrend.data.length > 0 ? (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={capitolTrend.data}>
              <CartesianGrid stroke="var(--border-hairline)" strokeDasharray="3 3" />
              <XAxis dataKey="date" stroke="var(--text-faint)" tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
              <YAxis
                stroke="var(--text-faint)"
                tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
                tickFormatter={formatCompactNumber}
                width={48}
              />
              <Tooltip
                contentStyle={{ background: "var(--surface-sunken)", border: "1px solid var(--border)" }}
                formatter={(value) => formatCompactNumber(Number(value))}
              />
              <Line type="monotone" dataKey="totalPoints" stroke="var(--accent-purple)" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-ink-muted">No Capitol War events recorded yet.</p>
        )}
      </Card>

      <Card className="mt-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="font-display text-[17px] font-semibold tracking-heading text-ink uppercase">Vault leaderboard</p>
          <div className="flex gap-1.5">
            <Pill active={leaderboardTrap === undefined} onClick={() => setLeaderboardTrap(undefined)}>
              Overall
            </Pill>
            {vaultTraps.data?.map((trap) => (
              <Pill key={trap} active={leaderboardTrap === trap} onClick={() => setLeaderboardTrap(trap)}>
                Vault {trap}
              </Pill>
            ))}
          </div>
        </div>

        {leaderboard.isLoading && <LoadingRows rows={5} />}
        {leaderboard.error && <ErrorState message="Couldn't load the leaderboard." onRetry={leaderboard.refetch} />}

        {podium.length > 0 && (
          <div className="mb-5 grid grid-cols-3 gap-3">
            {podium.map((entry) => (
              <div
                key={entry.fid}
                className={`flex flex-col items-center gap-2 rounded-card border p-3 text-center ${
                  entry.rank === 1 ? "border-gold-border bg-gold-tint" : entry.rank === 2 ? "border-[#3D4753]" : "border-[#5A4433]"
                }`}
              >
                <RankShield rank={entry.rank} size={44} />
                <span className="truncate font-sans text-sm font-medium text-ink">{entry.nickname ?? `FID ${entry.fid}`}</span>
                <span className="font-mono text-xs text-ink-muted">
                  {formatCompactNumber(entry.totalDamage)} · {entry.hunts} hunts
                </span>
              </div>
            ))}
          </div>
        )}

        {rest.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-header text-left font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                  <th className="px-4 py-2 font-medium">Rank</th>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 text-right font-medium">Total damage</th>
                  <th className="px-4 py-2 text-right font-medium">Hunts</th>
                  <th className="px-4 py-2 text-right font-medium">Avg damage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-hairline">
                {rest.map((entry, i) => (
                  <tr key={entry.fid} className={i % 2 === 1 ? "bg-surface-panel-alt" : undefined}>
                    <td className="px-4 py-2 font-mono text-ink-muted">{String(entry.rank).padStart(2, "0")}</td>
                    <td className="px-4 py-2">
                      <Link to={`/alliance/${allianceId}/members/${entry.fid}`} className="text-ink hover:text-gold-ink">
                        {entry.nickname ?? `FID ${entry.fid}`}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-ink-secondary">{formatCompactNumber(entry.totalDamage)}</td>
                    <td className="px-4 py-2 text-right font-mono text-ink-secondary">{entry.hunts}</td>
                    <td className="px-4 py-2 text-right font-mono text-ink-secondary">{formatCompactNumber(entry.avgDamage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="mt-5">
        <p className="mb-3 font-display text-[17px] font-semibold tracking-heading text-ink uppercase">Roster</p>
        {members.isLoading && <LoadingRows rows={5} />}
        {members.error && <ErrorState message="Couldn't load the roster." onRetry={members.refetch} />}
        {members.data && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-header text-left font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Chief office lv</th>
                  <th className="px-4 py-2 text-right font-medium">Power</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-hairline">
                {members.data.map((m, i) => (
                  <tr key={m.fid} className={i % 2 === 1 ? "bg-surface-panel-alt" : undefined}>
                    <td className="px-4 py-2">
                      <Link to={`/alliance/${allianceId}/members/${m.fid}`} className="text-ink hover:text-gold-ink">
                        {m.nickname ?? `fid ${m.fid}`}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-ink-secondary">{m.chiefOfficeLv ?? "—"}</td>
                    <td className="px-4 py-2 text-right font-mono text-ink-secondary">{m.power ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Layout>
  );
}
