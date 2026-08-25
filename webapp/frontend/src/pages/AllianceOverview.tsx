import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
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
  getAllianceMembers,
  getAllianceVaultTraps,
  getAllianceVaultTrend,
  getAllianceCapitolTrend,
  type AllianceVaultTrendPoint,
} from "../api/client";

const chartTheme = {
  grid: "#1e293b",
  axis: "#64748b",
  line: "#818cf8",
  tooltipBg: "#0f172a",
  tooltipBorder: "#334155",
};

// One color per trap line -- cycles if an alliance somehow has more than
// two traps, but in practice this is always Vault 1 / Vault 2.
const TRAP_COLORS = ["#818cf8", "#34d399", "#f472b6", "#fbbf24"];

// e.g. 3250000000 -> "3.25B", 500000000 -> "500M" -- raw totals here run
// into the billions and are unreadable without this on axes/tooltips.
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
  const { allianceId: allianceIdParam } = useParams<{ allianceId: string }>();
  const allianceId = Number(allianceIdParam);

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

  const vaultChartRows = vaultTrendByTrap.data ? mergeVaultSeriesByDate(vaultTrendByTrap.data) : [];

  return (
    <Layout title="Alliance overview" backTo={{ to: "/", label: "Your profile" }}>
      <section className="mb-8 flex gap-3">
        <Link
          to={`/alliance/${allianceId}/leaderboard/vault`}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          Vault leaderboard →
        </Link>
        <Link
          to={`/alliance/${allianceId}/leaderboard/capitol`}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          Capitol leaderboard →
        </Link>
        <Link
          to={`/alliance/${allianceId}/attendance/vault`}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          Vault attendance →
        </Link>
        <Link
          to={`/alliance/${allianceId}/attendance/capitol`}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          Capitol attendance →
        </Link>
        <Link
          to={`/alliance/${allianceId}/calendar`}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          Event calendar →
        </Link>
      </section>

      <section className="mb-8 grid gap-6 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <h2 className="mb-3 text-sm font-medium text-slate-300">
            Vault Trap total damage
          </h2>
          {vaultChartRows.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={vaultChartRows}>
                <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke={chartTheme.axis} tick={{ fontSize: 11 }} />
                <YAxis stroke={chartTheme.axis} tick={{ fontSize: 11 }} tickFormatter={formatCompactNumber} width={48} />
                <Tooltip
                  contentStyle={{
                    background: chartTheme.tooltipBg,
                    border: `1px solid ${chartTheme.tooltipBorder}`,
                  }}
                  formatter={(value) => formatCompactNumber(Number(value))}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {vaultTraps.data?.map((trap, i) => (
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
            <p className="text-sm text-slate-500">No vault hunts recorded yet.</p>
          )}
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <h2 className="mb-3 text-sm font-medium text-slate-300">
            Capitol War total points
          </h2>
          {capitolTrend.data && capitolTrend.data.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={capitolTrend.data}>
                <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke={chartTheme.axis} tick={{ fontSize: 11 }} />
                <YAxis stroke={chartTheme.axis} tick={{ fontSize: 11 }} tickFormatter={formatCompactNumber} width={48} />
                <Tooltip
                  contentStyle={{
                    background: chartTheme.tooltipBg,
                    border: `1px solid ${chartTheme.tooltipBorder}`,
                  }}
                  formatter={(value) => formatCompactNumber(Number(value))}
                />
                <Line type="monotone" dataKey="totalPoints" stroke={chartTheme.line} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-slate-500">No Capitol War events recorded yet.</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-slate-300">Roster</h2>
        {members.isLoading && <p className="text-slate-400">Loading…</p>}
        {members.error && <p className="text-red-400">Couldn't load the roster.</p>}
        {members.data && (
          <div className="overflow-hidden rounded-lg border border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 text-left text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Chief office lv</th>
                  <th className="px-4 py-2 font-medium">Power</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {members.data.map((m) => (
                  <tr key={m.fid} className="hover:bg-slate-900/60">
                    <td className="px-4 py-2">
                      <Link
                        to={`/alliance/${allianceId}/members/${m.fid}`}
                        className="text-indigo-400 hover:text-indigo-300"
                      >
                        {m.nickname ?? `fid ${m.fid}`}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-slate-300">{m.chiefOfficeLv ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-300">{m.power ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Layout>
  );
}
