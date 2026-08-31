import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { Download } from "lucide-react";
import Layout from "../components/Layout";
import {
  getMemberVaultTrend,
  getMemberCapitolTrend,
  getMemberHistory,
  getAllianceMembers,
  getVaultAttendance,
  type VaultTrendPoint,
  type MemberHistory,
} from "../api/client";
import { Card, ErrorState, LoadingState, Portrait, StatTile, buttonSecondary } from "../components/ui";
import { personalBest } from "../hooks/engagement";

function toCsvValue(value: string | number | null): string {
  const str = value === null ? "" : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(headers: string[], rows: (string | number | null)[][]): string {
  return [headers, ...rows].map((row) => row.map(toCsvValue).join(",")).join("\r\n");
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Flattens the four separate change logs into one CSV-friendly list, tagged
 * by change type so they can be exported as a single file. */
function buildHistoryCsv(history: MemberHistory): string {
  const rows: (string | number | null)[][] = [];
  for (const c of history.nicknameChanges) rows.push(["Nickname", c.oldValue, c.newValue, c.changeDate]);
  for (const c of history.chiefOfficeChanges) rows.push(["Chief Office", c.oldValue, c.newValue, c.changeDate]);
  for (const c of history.powerChanges) rows.push(["Power", c.oldValue, c.newValue, c.changeDate]);
  for (const c of history.combatPowerChanges) rows.push(["Combat Power", c.oldValue, c.newValue, c.changeDate]);
  rows.sort((a, b) => String(a[3]).localeCompare(String(b[3])));
  return buildCsv(["Type", "Old Value", "New Value", "Date"], rows);
}

/** Members typically only run one trap, but pivot by trapNumber anyway
 * (rather than assuming) so a member who has hunts in both shows two
 * clearly separate lines instead of one chart mixing two different
 * competitions' damage together. */
function splitVaultTrendByTrap(points: VaultTrendPoint[]) {
  const traps = [...new Set(points.map((p) => p.trapNumber))].sort((a, b) => a - b);
  const dates = [...new Set(points.map((p) => p.date))].sort();
  const rows = dates.map((date) => {
    const row: Record<string, string | number> = { date };
    for (const p of points) {
      if (p.date === date) row[`trap_${p.trapNumber}`] = p.damage;
    }
    return row;
  });
  return { traps, rows };
}

/** power_changes/combat_power_changes are each a bare (old, new,
 * change_date) log -- this takes the "new" value at each change as the
 * running series, merged onto one chart by date. */
function buildPowerSeries(history: MemberHistory | undefined) {
  if (!history) return [];
  const rows: Record<string, string | number>[] = [];
  const byDate = new Map<string, Record<string, string | number>>();
  const upsert = (date: string, key: string, value: number) => {
    let row = byDate.get(date);
    if (!row) {
      row = { date };
      byDate.set(date, row);
      rows.push(row);
    }
    row[key] = value;
  };
  for (const c of history.powerChanges) upsert(c.changeDate, "power", c.newValue);
  for (const c of history.combatPowerChanges) upsert(c.changeDate, "combatPower", c.newValue);
  return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function compact(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(n);
}

export default function MemberDetail() {
  const { allianceId: allianceIdParam, fid: fidParam } = useParams<{
    allianceId: string;
    fid: string;
  }>();
  const allianceId = Number(allianceIdParam);
  const fid = Number(fidParam);

  const roster = useQuery({ queryKey: ["alliance-members", allianceId], queryFn: () => getAllianceMembers(allianceId) });
  const vaultTrend = useQuery({
    queryKey: ["member-vault-trend", allianceId, fid],
    queryFn: () => getMemberVaultTrend(allianceId, fid),
  });
  const capitolTrend = useQuery({
    queryKey: ["member-capitol-trend", allianceId, fid],
    queryFn: () => getMemberCapitolTrend(allianceId, fid),
  });
  const history = useQuery({
    queryKey: ["member-history", allianceId, fid],
    queryFn: () => getMemberHistory(allianceId, fid),
  });
  const attendance = useQuery({
    queryKey: ["alliance-vault-attendance-overall", allianceId],
    queryFn: () => getVaultAttendance(allianceId),
  });

  const member = roster.data?.find((m) => m.fid === fid);
  const attendanceEntry = attendance.data?.members.find((m) => m.fid === fid);
  const vaultSplit = vaultTrend.data ? splitVaultTrendByTrap(vaultTrend.data) : null;
  const powerSeries = buildPowerSeries(history.data);

  const vaultSessions = useMemo(
    () => (vaultTrend.data ?? []).map((p) => ({ date: p.date, value: p.damage })),
    [vaultTrend.data],
  );
  const pb = personalBest(vaultSessions);
  const latestRank = vaultTrend.data && vaultTrend.data.length > 0 ? vaultTrend.data[vaultTrend.data.length - 1].rank : null;

  function handleExportHistory() {
    if (!history.data) return;
    const csv = buildHistoryCsv(history.data);
    const dateStr = new Date().toISOString().slice(0, 10);
    downloadCsv(`member-${fid}-history-${dateStr}.csv`, csv);
  }

  return (
    <Layout title={member?.nickname ?? `Member ${fid}`} backTo={{ to: `/alliance/${allianceId}`, label: "Alliance overview" }} hideHeader>
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="overflow-hidden rounded-card border border-gold-border">
          <div className="flex items-center justify-between bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] px-4 py-2 font-mono text-[11px] font-bold tracking-pill text-on-gold uppercase">
            <span>Service record</span>
            <span>FID {fid}</span>
          </div>
          <div className="flex gap-4 bg-surface-panel p-[18px]">
            <Portrait size="record" alt={member?.nickname ?? `Member ${fid}`} />
            <div className="min-w-0 flex-1">
              {roster.isLoading ? (
                <LoadingState />
              ) : (
                <>
                  <h1 className="truncate font-display text-[34px] leading-none font-bold text-ink">
                    {member?.nickname ?? `Member ${fid}`}
                  </h1>
                  <p className="mt-1 text-[13px] text-ink-muted">Chief's Office {member?.chiefOfficeLv ?? "—"}</p>
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <StatTile label="Power" figure={member ? compact(member.power ?? 0) : "—"} />
                    <StatTile label="Combat power" figure={member ? compact(member.combatPower ?? 0) : "—"} />
                    <StatTile label="Vault rank" figure={latestRank ?? "—"} />
                    <StatTile
                      label="Turnout"
                      figure={attendanceEntry ? `${Math.round(attendanceEntry.attendanceRate * 100)}%` : "—"}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {pb.isPersonalBest && (
            <Card className="border-up-fill">
              <p className="font-mono text-[10px] tracking-eyebrow text-up-ink uppercase">Personal best</p>
              <p className="mt-1 font-display text-2xl font-bold text-ink">{compact(pb.best ?? 0)}</p>
              {pb.previousBest !== null && <p className="font-mono text-xs text-ink-muted">prev {compact(pb.previousBest)}</p>}
            </Card>
          )}
          <Card>
            <p className="mb-2 font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">Export</p>
            <button onClick={handleExportHistory} disabled={!history.data} className={`${buttonSecondary} w-full`}>
              <Download size={16} strokeWidth={1.75} className="mr-1.5" aria-hidden="true" />
              Activity history CSV
            </button>
          </Card>
        </div>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Card>
          <p className="mb-3 font-display text-[17px] font-semibold tracking-heading text-ink uppercase">Vault Trap damage</p>
          {vaultTrend.isLoading && <LoadingState />}
          {vaultTrend.error && <ErrorState message="Couldn't load vault history." onRetry={vaultTrend.refetch} />}
          {vaultSplit && vaultSplit.rows.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={vaultSplit.rows}>
                <CartesianGrid stroke="var(--border-hairline)" strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke="var(--text-faint)" tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
                <YAxis stroke="var(--text-faint)" tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
                <Tooltip contentStyle={{ background: "var(--surface-sunken)", border: "1px solid var(--border)" }} />
                {vaultSplit.traps.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
                {pb.best !== null && (
                  <ReferenceLine
                    y={pb.best}
                    stroke="var(--up-fill)"
                    strokeDasharray="4 4"
                    label={{ value: "PB", position: "insideTopLeft", fill: "var(--up-ink)", fontSize: 11 }}
                  />
                )}
                {vaultSplit.traps.map((trap, i) => (
                  <Line
                    key={trap}
                    type="monotone"
                    dataKey={`trap_${trap}`}
                    name={`Vault ${trap}`}
                    stroke={i === 0 ? "var(--info-ink)" : "var(--gold-ink)"}
                    dot={{ r: 3 }}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            vaultTrend.data && <p className="text-sm text-ink-muted">No vault hunts recorded.</p>
          )}
        </Card>

        <Card>
          <p className="mb-3 font-display text-[17px] font-semibold tracking-heading text-ink uppercase">Power history</p>
          {history.isLoading && <LoadingState />}
          {history.error && <ErrorState message="Couldn't load history." onRetry={history.refetch} />}
          {powerSeries.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={powerSeries}>
                <CartesianGrid stroke="var(--border-hairline)" strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke="var(--text-faint)" tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }} />
                <YAxis stroke="var(--text-faint)" tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
                <Tooltip contentStyle={{ background: "var(--surface-sunken)", border: "1px solid var(--border)" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="power" name="Power" stroke="var(--info-ink)" dot={{ r: 3 }} connectNulls />
                <Line type="monotone" dataKey="combatPower" name="Combat power" stroke="var(--accent-purple)" dot={{ r: 3 }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            history.data && <p className="text-sm text-ink-muted">No power history recorded.</p>
          )}
        </Card>

        <Card>
          <p className="mb-3 font-display text-[17px] font-semibold tracking-heading text-ink uppercase">Capitol War points</p>
          {capitolTrend.isLoading && <LoadingState />}
          {capitolTrend.error && <ErrorState message="Couldn't load Capitol War history." onRetry={capitolTrend.refetch} />}
          {capitolTrend.data && capitolTrend.data.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={capitolTrend.data}>
                <CartesianGrid stroke="var(--border-hairline)" strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke="var(--text-faint)" tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
                <YAxis stroke="var(--text-faint)" tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
                <Tooltip contentStyle={{ background: "var(--surface-sunken)", border: "1px solid var(--border)" }} />
                <Line type="monotone" dataKey="points" stroke="var(--up-fill)" dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            capitolTrend.data && <p className="text-sm text-ink-muted">No Capitol War events recorded.</p>
          )}
        </Card>

        <Card>
          <p className="mb-3 font-display text-[17px] font-semibold tracking-heading text-ink uppercase">Activity history</p>
          {history.data && (
            <div className="space-y-2 text-sm">
              {history.data.nicknameChanges.length === 0 && history.data.chiefOfficeChanges.length === 0 ? (
                <p className="text-ink-muted">No nickname or rank changes recorded.</p>
              ) : (
                <>
                  {history.data.nicknameChanges.map((c, i) => (
                    <div key={`nick-${i}`} className="flex justify-between border-b border-line-hairline pb-2 text-ink-secondary">
                      <span>
                        {c.oldValue ?? "—"} → <span className="text-ink">{c.newValue ?? "—"}</span>
                      </span>
                      <span className="font-mono text-ink-faint">{c.changeDate}</span>
                    </div>
                  ))}
                  {history.data.chiefOfficeChanges.map((c, i) => (
                    <div key={`co-${i}`} className="flex justify-between border-b border-line-hairline pb-2 text-ink-secondary">
                      <span>
                        Chief office lv {c.oldValue ?? "—"} → <span className="text-ink">{c.newValue ?? "—"}</span>
                        {c.newValue !== null && c.oldValue !== null && c.newValue > c.oldValue && (
                          <span className="ml-1.5 text-up-ink">▲</span>
                        )}
                      </span>
                      <span className="font-mono text-ink-faint">{c.changeDate}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </Card>
      </div>
    </Layout>
  );
}
