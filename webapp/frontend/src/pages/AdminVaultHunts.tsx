import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { getAdminVaultHunts, getAllianceVaultTraps } from "../api/client";
import { EmptyState, ErrorState, LoadingRows, Pill, buttonSecondary } from "../components/ui";

const PAGE_SIZE = 25;

function formatCompact(n: number | null): string {
  if (n === null) return "—";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(n);
}

/** Full list of persisted Vault Trap hunts for this alliance, with a link
 * into each one to edit its header fields or its player roster (see
 * AdminVaultHuntDetail). Read-only here -- edits happen one hunt at a
 * time on the detail page. */
export default function AdminVaultHunts() {
  const { allianceId: allianceIdParam } = useParams<{ allianceId: string }>();
  const allianceId = Number(allianceIdParam);
  const [trap, setTrap] = useState<number | undefined>(undefined);
  const [offset, setOffset] = useState(0);

  const traps = useQuery({
    queryKey: ["alliance-vault-traps", allianceId],
    queryFn: () => getAllianceVaultTraps(allianceId),
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-vault-hunts", allianceId, trap, offset],
    queryFn: () => getAdminVaultHunts(allianceId, { trap, limit: PAGE_SIZE, offset }),
  });

  return (
    <Layout title="Vault Trap records" backTo={{ to: "/admin", label: "Admin" }}>
      {(traps.data?.length ?? 0) > 1 && (
        <div className="flex gap-1.5">
          <Pill
            active={trap === undefined}
            onClick={() => {
              setTrap(undefined);
              setOffset(0);
            }}
          >
            All traps
          </Pill>
          {traps.data?.map((t) => (
            <Pill
              key={t}
              active={trap === t}
              onClick={() => {
                setTrap(t);
                setOffset(0);
              }}
            >
              Vault {t}
            </Pill>
          ))}
        </div>
      )}

      {isLoading && <LoadingRows rows={6} />}
      {error && <ErrorState message="Couldn't load vault hunts." onRetry={refetch} />}
      {data && data.hunts.length === 0 && <EmptyState>No vault hunts recorded yet.</EmptyState>}

      {data && data.hunts.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="overflow-x-auto rounded-card border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-header text-left font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Trap</th>
                  <th className="px-4 py-2 font-medium">Rallies</th>
                  <th className="px-4 py-2 font-medium">Total damage</th>
                  <th className="px-4 py-2 font-medium">Players</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-hairline">
                {data.hunts.map((h, i) => (
                  <tr key={h.id} className={i % 2 === 1 ? "bg-surface-panel-alt" : ""}>
                    <td className="px-4 py-2">
                      <Link to={`/admin/alliances/${allianceId}/vault-hunts/${h.id}`} className="text-gold-ink hover:text-text">
                        {h.date}
                      </Link>
                    </td>
                    <td className="px-4 py-2 font-mono text-ink-secondary">{h.trapNumber}</td>
                    <td className="px-4 py-2 font-mono text-ink-secondary">{h.rallies ?? "—"}</td>
                    <td className="px-4 py-2 font-mono text-ink-secondary">{formatCompact(h.totalDamage)}</td>
                    <td className="px-4 py-2 font-mono text-ink-secondary">{h.playerCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.total > PAGE_SIZE && (
            <div className="flex items-center justify-between text-xs text-ink-muted">
              <span>
                {offset + 1}-{Math.min(offset + PAGE_SIZE, data.total)} of {data.total}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                  disabled={offset === 0}
                  className={buttonSecondary}
                >
                  Previous
                </button>
                <button
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                  disabled={offset + PAGE_SIZE >= data.total}
                  className={buttonSecondary}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Layout>
  );
}
