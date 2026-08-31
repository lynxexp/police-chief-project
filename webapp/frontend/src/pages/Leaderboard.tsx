import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import {
  getVaultLeaderboard,
  getCapitolLeaderboard,
  getAllianceVaultTraps,
  getOwnProfile,
  type VaultLeaderboardEntry,
  type CapitolLeaderboardEntry,
} from "../api/client";
import { ErrorState, LoadingRows, Pill, RankShield } from "../components/ui";

type Kind = "vault" | "capitol";

function formatNumber(n: number): string {
  return Math.round(n).toLocaleString();
}

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

  const { data, isLoading, error, refetch } = useQuery<VaultLeaderboardEntry[] | CapitolLeaderboardEntry[]>({
    queryKey: ["leaderboard", allianceId, kind, trap],
    queryFn: () => (kind === "vault" ? getVaultLeaderboard(allianceId, { trap }) : getCapitolLeaderboard(allianceId)),
  });

  // Reused (same query key as Profile) purely to know which rows are "you".
  const ownProfile = useQuery({ queryKey: ["profile"], queryFn: getOwnProfile });
  const ownFids = new Set((ownProfile.data ?? []).map((e) => e.fid));

  const podium = (data ?? []).slice(0, 3);
  const rest = (data ?? []).slice(3);

  return (
    <Layout
      title={kind === "vault" ? "Vault Trap leaderboard" : "Capitol War leaderboard"}
      backTo={{ to: `/alliance/${allianceId}`, label: "Alliance overview" }}
      actions={
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1 rounded-pill border border-line bg-surface-sunken p-1">
              <Link
                to={`/alliance/${allianceId}/leaderboard/vault`}
                className={`rounded-pill px-3 py-1.5 font-mono text-[11px] tracking-pill uppercase ${
                  kind === "vault" ? "bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] font-bold text-on-gold" : "text-ink-muted"
                }`}
              >
                Vault
              </Link>
              <Link
                to={`/alliance/${allianceId}/leaderboard/capitol`}
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
          </div>
        }
      >
      {isLoading && <LoadingRows rows={6} />}
      {error && <ErrorState message="Couldn't load the leaderboard." onRetry={refetch} />}

      {data && data.length === 0 && <p className="text-sm text-ink-muted">No hunts logged here yet.</p>}

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
                {kind === "vault"
                  ? `${formatNumber((entry as VaultLeaderboardEntry).totalDamage)} · ${(entry as VaultLeaderboardEntry).hunts} hunts`
                  : `${formatNumber((entry as CapitolLeaderboardEntry).totalPoints)} · ${(entry as CapitolLeaderboardEntry).events} events`}
              </span>
            </div>
          ))}
        </div>
      )}

      {rest.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-card border border-line sm:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-header text-left font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                  <th className="px-4 py-2 font-medium">Rank</th>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 text-right font-medium">Total {kind === "vault" ? "damage" : "points"}</th>
                  <th className="px-4 py-2 text-right font-medium">{kind === "vault" ? "Hunts" : "Events"}</th>
                  <th className="px-4 py-2 text-right font-medium">Average</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-hairline">
                {rest.map((row, i) => {
                  const you = ownFids.has(row.fid);
                  return (
                    <tr
                      key={row.fid}
                      className={you ? "border-l-[3px] border-[#C9A227] bg-gold-tint" : i % 2 === 1 ? "bg-surface-panel-alt" : undefined}
                    >
                      <td className="px-4 py-2 font-mono text-ink-muted">{String(row.rank).padStart(2, "0")}</td>
                      <td className="px-4 py-2">
                        <Link to={`/alliance/${allianceId}/members/${row.fid}`} className="text-ink hover:text-gold-ink">
                          {row.nickname ?? `fid ${row.fid}`}
                        </Link>
                        {you && (
                          <span className="ml-2 rounded-pill bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-on-gold">
                            YOU
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-ink-secondary">
                        {formatNumber(kind === "vault" ? (row as VaultLeaderboardEntry).totalDamage : (row as CapitolLeaderboardEntry).totalPoints)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-ink-secondary">
                        {kind === "vault" ? (row as VaultLeaderboardEntry).hunts : (row as CapitolLeaderboardEntry).events}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-ink-secondary">
                        {formatNumber(kind === "vault" ? (row as VaultLeaderboardEntry).avgDamage : (row as CapitolLeaderboardEntry).avgPoints)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="flex flex-col gap-2 sm:hidden">
            {rest.map((row) => {
              const you = ownFids.has(row.fid);
              return (
                <Link
                  key={row.fid}
                  to={`/alliance/${allianceId}/members/${row.fid}`}
                  className={`flex min-h-[48px] items-center gap-3 rounded-card border p-3.5 ${
                    you ? "border-gold-border bg-gold-tint" : "border-line bg-surface-panel"
                  }`}
                >
                  {you ? (
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-block border border-dashed border-gold-border font-mono text-xs text-gold-ink">
                      {String(row.rank).padStart(2, "0")}
                    </span>
                  ) : (
                    <span className="w-10 shrink-0 text-center font-mono text-xs text-ink-muted">
                      {String(row.rank).padStart(2, "0")}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">
                      {row.nickname ?? `fid ${row.fid}`}
                      {you && <span className="ml-1.5 font-mono text-[10px] text-gold-ink">YOU</span>}
                    </p>
                    <p className="font-mono text-xs text-ink-muted">
                      {kind === "vault" ? `${(row as VaultLeaderboardEntry).hunts} hunts` : `${(row as CapitolLeaderboardEntry).events} events`}
                    </p>
                  </div>
                  <span className="shrink-0 text-right font-mono text-sm text-ink-secondary">
                    {formatNumber(kind === "vault" ? (row as VaultLeaderboardEntry).totalDamage : (row as CapitolLeaderboardEntry).totalPoints)}
                  </span>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </Layout>
  );
}
