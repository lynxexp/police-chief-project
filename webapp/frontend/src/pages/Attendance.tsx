import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { getVaultAttendance, getCapitolAttendance, getAllianceVaultTraps } from "../api/client";

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

  const { data, isLoading, error } = useQuery({
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

  return (
    <Layout
      title={kind === "vault" ? "Vault Trap attendance" : "Capitol War attendance"}
      backTo={{ to: `/alliance/${allianceId}`, label: "Alliance overview" }}
    >
      <div className="mb-4 flex gap-3 text-sm">
        <Link
          to={`/alliance/${allianceId}/attendance/vault`}
          className={kind === "vault" ? "font-medium text-indigo-400" : "text-slate-400 hover:text-slate-200"}
        >
          Vault
        </Link>
        <Link
          to={`/alliance/${allianceId}/attendance/capitol`}
          className={kind === "capitol" ? "font-medium text-indigo-400" : "text-slate-400 hover:text-slate-200"}
        >
          Capitol War
        </Link>
      </div>

      {kind === "vault" && vaultTraps.data && vaultTraps.data.length > 1 && (
        <div className="mb-4 flex gap-2 text-xs">
          <button
            onClick={() => setTrap(undefined)}
            className={`rounded-full px-3 py-1 ${
              trap === undefined
                ? "bg-indigo-600 text-white"
                : "border border-slate-700 text-slate-400 hover:bg-slate-800"
            }`}
          >
            Overall
          </button>
          {vaultTraps.data.map((t) => (
            <button
              key={t}
              onClick={() => setTrap(t)}
              className={`rounded-full px-3 py-1 ${
                trap === t
                  ? "bg-indigo-600 text-white"
                  : "border border-slate-700 text-slate-400 hover:bg-slate-800"
              }`}
            >
              Vault {t}
            </button>
          ))}
        </div>
      )}

      {isLoading && <p className="text-slate-400">Loading…</p>}
      {error && <p className="text-red-400">Couldn't load attendance.</p>}

      {data && (
        <>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm text-slate-400">
              <span className="font-medium text-slate-200">{data.totalSessions}</span>{" "}
              {kind === "vault" ? "hunt" : "event"}
              {data.totalSessions === 1 ? "" : "s"} logged
            </p>
            <button
              onClick={handleExport}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
            >
              Export CSV
            </button>
          </div>
          <div className="overflow-hidden rounded-lg border border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 text-left text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Attended</th>
                  <th className="px-4 py-2 font-medium">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {data.members.map((m) => (
                  <tr key={m.fid} className="hover:bg-slate-900/60">
                    <td className="px-4 py-2">
                      <Link
                        to={`/alliance/${allianceId}/members/${m.fid}`}
                        className="text-indigo-400 hover:text-indigo-300"
                      >
                        {m.nickname ?? `fid ${m.fid}`}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-slate-300">
                      {m.attended} / {data.totalSessions}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-800">
                          <div
                            className={`h-full ${m.attendanceRate === 0 ? "bg-slate-700" : "bg-emerald-500"}`}
                            style={{ width: `${Math.round(m.attendanceRate * 100)}%` }}
                          />
                        </div>
                        <span className="text-slate-400">{Math.round(m.attendanceRate * 100)}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Layout>
  );
}
