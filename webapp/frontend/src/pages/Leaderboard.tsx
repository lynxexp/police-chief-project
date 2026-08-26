import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import {
  getVaultLeaderboard,
  getCapitolLeaderboard,
  getAllianceVaultTraps,
  type VaultLeaderboardEntry,
  type CapitolLeaderboardEntry,
} from "../api/client";
import { ErrorState, LoadingState } from "../components/ui";

type Kind = "vault" | "capitol";

export default function Leaderboard() {
  const { allianceId: allianceIdParam, kind: kindParam } = useParams<{
    allianceId: string;
    kind: string;
  }>();
  const allianceId = Number(allianceIdParam);
  const kind: Kind = kindParam === "capitol" ? "capitol" : "vault";

  // undefined = "Overall" (combined across traps). Players typically only
  // run Vault 1 or Vault 2, not both, so the combined ranking mixes two
  // largely separate rosters -- these tabs let you view each on its own.
  const [trap, setTrap] = useState<number | undefined>(undefined);

  const vaultTraps = useQuery({
    queryKey: ["alliance-vault-traps", allianceId],
    queryFn: () => getAllianceVaultTraps(allianceId),
    enabled: kind === "vault",
  });

  const { data, isLoading, error } = useQuery<VaultLeaderboardEntry[] | CapitolLeaderboardEntry[]>({
    queryKey: ["leaderboard", allianceId, kind, trap],
    queryFn: () =>
      kind === "vault"
        ? getVaultLeaderboard(allianceId, { trap })
        : getCapitolLeaderboard(allianceId),
  });

  return (
    <Layout
      title={kind === "vault" ? "Vault Trap leaderboard" : "Capitol War leaderboard"}
      backTo={{ to: `/alliance/${allianceId}`, label: "Alliance overview" }}
    >
      <div className="mb-4 flex gap-3 text-sm">
        <Link
          to={`/alliance/${allianceId}/leaderboard/vault`}
          className={kind === "vault" ? "font-medium text-indigo-400" : "text-slate-400 hover:text-slate-200"}
        >
          Vault
        </Link>
        <Link
          to={`/alliance/${allianceId}/leaderboard/capitol`}
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

      {isLoading && <LoadingState />}
      {error && <ErrorState message="Couldn't load the leaderboard." />}

      {data && (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-left text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">
                  Total {kind === "vault" ? "damage" : "points"}
                </th>
                <th className="px-4 py-2 font-medium">
                  {kind === "vault" ? "Hunts" : "Events"}
                </th>
                <th className="px-4 py-2 font-medium">Average</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {kind === "vault"
                ? (data as VaultLeaderboardEntry[]).map((row) => (
                    <tr key={row.fid} className="hover:bg-slate-900/60">
                      <td className="px-4 py-2 text-slate-400">{row.rank}</td>
                      <td className="px-4 py-2">
                        <Link
                          to={`/alliance/${allianceId}/members/${row.fid}`}
                          className="text-indigo-400 hover:text-indigo-300"
                        >
                          {row.nickname ?? `fid ${row.fid}`}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-slate-300">
                        {row.totalDamage.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-slate-300">{row.hunts}</td>
                      <td className="px-4 py-2 text-slate-300">
                        {Math.round(row.avgDamage).toLocaleString()}
                      </td>
                    </tr>
                  ))
                : (data as CapitolLeaderboardEntry[]).map((row) => (
                    <tr key={row.fid} className="hover:bg-slate-900/60">
                      <td className="px-4 py-2 text-slate-400">{row.rank}</td>
                      <td className="px-4 py-2">
                        <Link
                          to={`/alliance/${allianceId}/members/${row.fid}`}
                          className="text-indigo-400 hover:text-indigo-300"
                        >
                          {row.nickname ?? `fid ${row.fid}`}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-slate-300">
                        {row.totalPoints.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-slate-300">{row.events}</td>
                      <td className="px-4 py-2 text-slate-300">
                        {Math.round(row.avgPoints).toLocaleString()}
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
}
