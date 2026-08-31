import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Download } from "lucide-react";
import Layout from "../components/Layout";
import { getVaultAttendance, getCapitolAttendance, getAllianceVaultTraps, type AttendanceMember } from "../api/client";
import { AttendanceBlock, Badge, ErrorState, LoadingRows, Pill, RankShield, StatTile, buttonSecondary } from "../components/ui";
import { attendanceBlocks, streak } from "../hooks/engagement";

type Kind = "vault" | "capitol";

function toCsvValue(value: string | number): string {
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(headers: string[], rows: (string | number)[][]): string {
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

export default function Attendance() {
  const { allianceId: allianceIdParam, kind: kindParam } = useParams<{
    allianceId: string;
    kind: string;
  }>();
  const allianceId = Number(allianceIdParam);
  const kind: Kind = kindParam === "capitol" ? "capitol" : "vault";

  // undefined = "Overall" (combined across traps) -- same tab pattern as
  // the vault leaderboard split.
  const [trap, setTrap] = useState<number | undefined>(undefined);

  const vaultTraps = useQuery({
    queryKey: ["alliance-vault-traps", allianceId],
    queryFn: () => getAllianceVaultTraps(allianceId),
    enabled: kind === "vault",
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["attendance", allianceId, kind, trap],
    queryFn: () => (kind === "vault" ? getVaultAttendance(allianceId, trap) : getCapitolAttendance(allianceId)),
  });

  function handleExport() {
    if (!data) return;
    const rows = data.members.map((m) => [
      m.nickname ?? `fid ${m.fid}`,
      `${m.attended} / ${data.totalSessions}`,
      `${Math.round(m.attendanceRate * 100)}%`,
    ]);
    const csv = buildCsv(["Name", "Attended", "Rate"], rows);
    const trapLabel = kind === "vault" ? (trap === undefined ? "vault-overall" : `vault${trap}`) : "capitol";
    const dateStr = new Date().toISOString().slice(0, 10);
    downloadCsv(`attendance-${trapLabel}-${dateStr}.csv`, csv);
  }

  const allianceWideTurnout =
    data && data.members.length ? data.members.reduce((sum, m) => sum + m.attendanceRate, 0) / data.members.length : null;
  const perfectCount = data ? data.members.filter((m) => m.attendanceRate === 1 && data.totalSessions > 0).length : 0;
  const needsNudgeCount = data ? data.members.filter((m) => m.attendanceRate < 0.5).length : 0;

  function memberChip(m: AttendanceMember) {
    if (data && data.totalSessions === 0) return null;
    const s = streak(m.sessions);
    if (s.count >= 3) return <Badge variant="success">{s.count}× STREAK</Badge>;
    if (m.attendanceRate < 0.5) return <Badge variant="danger">NEEDS A NUDGE</Badge>;
    return null;
  }

  return (
    <Layout
      title={kind === "vault" ? "Vault Trap attendance" : "Capitol War attendance"}
      backTo={{ to: `/alliance/${allianceId}`, label: "Alliance overview" }}
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-pill border border-line bg-surface-sunken p-1">
            <Link
              to={`/alliance/${allianceId}/attendance/vault`}
              className={`rounded-pill px-3 py-1.5 font-mono text-[11px] tracking-pill uppercase ${
                kind === "vault" ? "bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] font-bold text-on-gold" : "text-ink-muted"
              }`}
            >
              Vault
            </Link>
            <Link
              to={`/alliance/${allianceId}/attendance/capitol`}
              className={`rounded-pill px-3 py-1.5 font-mono text-[11px] tracking-pill uppercase ${
                kind === "capitol" ? "bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] font-bold text-on-gold" : "text-ink-muted"
              }`}
            >
              Capitol War
            </Link>
          </div>
          {kind === "vault" && vaultTraps.data && vaultTraps.data.length > 1 && (
            <div className="flex gap-1.5">
              <Pill active={trap === undefined} onClick={() => setTrap(undefined)}>
                Overall
              </Pill>
              {vaultTraps.data.map((t) => (
                <Pill key={t} active={trap === t} onClick={() => setTrap(t)}>
                  Vault {t}
                </Pill>
              ))}
            </div>
          )}
          {data && (
            <button onClick={handleExport} className={buttonSecondary}>
              <Download size={16} strokeWidth={1.75} className="mr-1.5" aria-hidden="true" />
              Export CSV
            </button>
          )}
        </div>
      }
    >
      {isLoading && <LoadingRows rows={6} />}
      {error && <ErrorState message="Couldn't load attendance." onRetry={refetch} />}

      {data && data.totalSessions === 0 && (
        <p className="rounded-card border border-dashed border-line-strong px-4 py-8 text-center text-sm text-ink-muted">
          No {kind === "vault" ? "hunts" : "events"} logged{trap !== undefined ? ` for Vault ${trap}` : ""} yet.
        </p>
      )}

      {data && data.totalSessions > 0 && (
        <div className="flex flex-col gap-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile
              label="Alliance turnout"
              figure={allianceWideTurnout !== null ? `${Math.round(allianceWideTurnout * 100)}%` : "—"}
            />
            <StatTile label="Perfect record" figure={perfectCount} inverted />
            <div className={`flex flex-col gap-2 rounded-card border p-4 ${needsNudgeCount > 0 ? "border-down-border bg-down-tint" : "border-line bg-surface-panel"}`}>
              <p className="font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">Needs a nudge (&lt;50%)</p>
              <p className={`font-display text-[32px] leading-none font-bold ${needsNudgeCount > 0 ? "text-down-ink" : "text-ink"}`}>
                {needsNudgeCount}
              </p>
            </div>
          </div>

          <p className="text-right font-mono text-[11px] text-ink-faint uppercase">
            {data.totalSessions} {kind === "vault" ? "hunt" : "event"}
            {data.totalSessions === 1 ? "" : "s"} logged
          </p>

          {/* Desktop: per-hunt block row */}
          <div className="hidden overflow-x-auto rounded-card border border-line sm:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-header text-left font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                  <th className="px-3 py-2 font-medium">Rank</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Sessions</th>
                  <th className="px-3 py-2 text-right font-medium">Attended</th>
                  <th className="px-3 py-2 text-right font-medium">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-hairline">
                {data.members.map((m, i) => {
                  const blocks = attendanceBlocks(m.sessions);
                  return (
                    <tr key={m.fid} className={i % 2 === 1 ? "bg-surface-panel-alt" : undefined}>
                      <td className="px-3 py-2">{i < 3 ? <RankShield rank={i + 1} size={28} /> : <span className="font-mono text-ink-muted">{String(i + 1).padStart(2, "0")}</span>}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Link to={`/alliance/${allianceId}/members/${m.fid}`} className="text-ink hover:text-gold-ink">
                            {m.nickname ?? `fid ${m.fid}`}
                          </Link>
                          {memberChip(m)}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-[2px]">
                          {blocks.map((state, bi) => (
                            <AttendanceBlock key={bi} state={state} />
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-ink-secondary">
                        {m.attended} / {data.totalSessions}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-ink-secondary">{Math.round(m.attendanceRate * 100)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile: per-member cards */}
          <div className="flex flex-col gap-2 sm:hidden">
            {data.members.map((m) => {
              const blocks = attendanceBlocks(m.sessions);
              return (
                <div key={m.fid} className="rounded-card border border-line bg-surface-panel p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <Link to={`/alliance/${allianceId}/members/${m.fid}`} className="truncate text-sm font-medium text-ink hover:text-gold-ink">
                      {m.nickname ?? `fid ${m.fid}`}
                    </Link>
                    <span className="shrink-0 font-mono text-sm text-ink-secondary">
                      {m.attended}/{data.totalSessions} · {Math.round(m.attendanceRate * 100)}%
                    </span>
                  </div>
                  {memberChip(m) && <div className="mt-1.5">{memberChip(m)}</div>}
                  <div className="mt-2 flex gap-[3px]">
                    {blocks.map((state, bi) => (
                      <span key={bi} className="h-2 w-3.5 flex-none rounded-block" style={{ background: state === "attended" ? "var(--up-fill)" : state === "streak-break" ? "var(--down-fill)" : "var(--miss)" }} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Layout>
  );
}
