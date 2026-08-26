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
} from "recharts";
import Layout from "../components/Layout";
import {
  getMemberVaultTrend,
  getMemberCapitolTrend,
  getMemberHistory,
  type VaultTrendPoint,
  type MemberHistory,
} from "../api/client";
import { Card, ErrorState, SectionHeading, buttonSecondary } from "../components/ui";

const chartTheme = {
  grid: "#1e293b",
  axis: "#64748b",
  line: "#34d399",
  tooltipBg: "#0f172a",
  tooltipBorder: "#334155",
};

const TRAP_COLORS = ["#34d399", "#818cf8", "#f472b6", "#fbbf24"];

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

export default function MemberDetail() {
  const { allianceId: allianceIdParam, fid: fidParam } = useParams<{
    allianceId: string;
    fid: string;
  }>();
  const allianceId = Number(allianceIdParam);
  const fid = Number(fidParam);

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

  const vaultSplit = vaultTrend.data ? splitVaultTrendByTrap(vaultTrend.data) : null;
  const powerSeries = buildPowerSeries(history.data);

  function handleExportHistory() {
    if (!history.data) return;
    const csv = buildHistoryCsv(history.data);
    const dateStr = new Date().toISOString().slice(0, 10);
    downloadCsv(`member-${fid}-history-${dateStr}.csv`, csv);
  }

  return (
    <Layout
      title={`Member ${fid}`}
      backTo={{ to: `/alliance/${allianceId}`, label: "Alliance overview" }}
    >
      <section className="grid gap-6 sm:grid-cols-2">
        <Card>
          <SectionHeading>Vault Trap damage</SectionHeading>
          {vaultTrend.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
          {vaultTrend.error && <ErrorState message="Couldn't load vault history." />}
          {vaultSplit && vaultSplit.rows.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={vaultSplit.rows}>
                <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke={chartTheme.axis} tick={{ fontSize: 11 }} />
                <YAxis stroke={chartTheme.axis} tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    background: chartTheme.tooltipBg,
                    border: `1px solid ${chartTheme.tooltipBorder}`,
                  }}
                />
                {vaultSplit.traps.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
                {vaultSplit.traps.map((trap, i) => (
                  <Line
                    key={trap}
                    type="monotone"
                    dataKey={`trap_${trap}`}
                    name={`Vault ${trap}`}
                    stroke={TRAP_COLORS[i % TRAP_COLORS.length]}
                    dot={{ r: 3 }}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            vaultTrend.data && <p className="text-sm text-slate-500">No vault hunts recorded.</p>
          )}
        </Card>

        <Card>
          <SectionHeading>Capitol War points</SectionHeading>
          {capitolTrend.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
          {capitolTrend.error && <ErrorState message="Couldn't load Capitol War history." />}
          {capitolTrend.data && capitolTrend.data.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={capitolTrend.data}>
                <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke={chartTheme.axis} tick={{ fontSize: 11 }} />
                <YAxis stroke={chartTheme.axis} tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    background: chartTheme.tooltipBg,
                    border: `1px solid ${chartTheme.tooltipBorder}`,
                  }}
                />
                <Line type="monotone" dataKey="points" stroke={chartTheme.line} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            capitolTrend.data && (
              <p className="text-sm text-slate-500">No Capitol War events recorded.</p>
            )
          )}
        </Card>

        <Card>
          <SectionHeading>Power over time</SectionHeading>
          {history.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
          {history.error && <ErrorState message="Couldn't load history." />}
          {powerSeries.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={powerSeries}>
                <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke={chartTheme.axis} tick={{ fontSize: 10 }} />
                <YAxis stroke={chartTheme.axis} tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    background: chartTheme.tooltipBg,
                    border: `1px solid ${chartTheme.tooltipBorder}`,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="power" name="Power" stroke="#818cf8" dot={{ r: 3 }} connectNulls />
                <Line
                  type="monotone"
                  dataKey="combatPower"
                  name="Combat power"
                  stroke="#f472b6"
                  dot={{ r: 3 }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            history.data && <p className="text-sm text-slate-500">No power history recorded.</p>
          )}
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-300">Activity history</h2>
            {history.data && (
              <button onClick={handleExportHistory} className={buttonSecondary}>
                Export CSV
              </button>
            )}
          </div>
          {history.data && (
            <div className="space-y-3 text-sm">
              {history.data.nicknameChanges.length === 0 && history.data.chiefOfficeChanges.length === 0 ? (
                <p className="text-slate-500">No nickname or rank changes recorded.</p>
              ) : (
                <>
                  {history.data.nicknameChanges.map((c, i) => (
                    <div key={`nick-${i}`} className="flex justify-between text-slate-300">
                      <span>
                        {c.oldValue ?? "—"} → <span className="text-slate-100">{c.newValue ?? "—"}</span>
                      </span>
                      <span className="text-slate-500">{c.changeDate}</span>
                    </div>
                  ))}
                  {history.data.chiefOfficeChanges.map((c, i) => (
                    <div key={`co-${i}`} className="flex justify-between text-slate-300">
                      <span>
                        Chief office lv {c.oldValue ?? "—"} →{" "}
                        <span className="text-slate-100">{c.newValue ?? "—"}</span>
                      </span>
                      <span className="text-slate-500">{c.changeDate}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </Card>
      </section>
    </Layout>
  );
}
