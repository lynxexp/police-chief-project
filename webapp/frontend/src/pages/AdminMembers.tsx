import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOutletContext, useParams } from "react-router-dom";
import { Search } from "lucide-react";
import Layout from "../components/Layout";
import {
  getAdminAllianceMembers,
  deactivateMember,
  reactivateMember,
  linkMemberDiscord,
  unlinkMemberDiscord,
  type AdminMember,
  type AuthContext,
} from "../api/client";
import { ErrorState, LoadingRows, Pill, buttonPrimary, buttonSecondary } from "../components/ui";

const TIER_LABELS: Record<AuthContext["tier"], string> = {
  owner: "Owner",
  global: "Global admin",
  server: "Server admin",
  alliance: "Alliance admin",
  none: "Member",
};

type MemberFilter = "all" | "active" | "inactive" | "noDiscord";

/** Admin-level roster -- shows fields member-facing views don't (Discord
 * link status, kingdom id, deactivation state) and the writes that act
 * on them: deactivate/reactivate, link/unlink Discord. */
export default function AdminMembers() {
  const ctx = useOutletContext<AuthContext>();
  const { allianceId: allianceIdParam } = useParams<{ allianceId: string }>();
  const allianceId = Number(allianceIdParam);
  const [filter, setFilter] = useState<MemberFilter>("all");
  const [linkingFid, setLinkingFid] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const queryClient = useQueryClient();
  // Always fetch the full roster (not server-side active-only) -- the
  // filter pills need all three counts visible at once, which a
  // server-side active/inactive split alone can't give.
  const queryKey = ["admin-alliance-members", allianceId, true];
  const { data, isLoading, error, refetch } = useQuery({
    queryKey,
    queryFn: () => getAdminAllianceMembers(allianceId, true),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const activeCount = (data ?? []).filter((m) => m.isActive).length;
  const inactiveCount = (data ?? []).filter((m) => !m.isActive).length;
  const noDiscordCount = (data ?? []).filter((m) => !m.discordId).length;

  const filtered = (data ?? []).filter((m) => {
    if (filter === "active" && !m.isActive) return false;
    if (filter === "inactive" && m.isActive) return false;
    if (filter === "noDiscord" && m.discordId) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    if (/^\d+$/.test(q) && String(m.fid).includes(q)) return true;
    return m.nickname?.toLowerCase().includes(q) ?? false;
  });

  const deactivateMutation = useMutation({ mutationFn: (fid: number) => deactivateMember(allianceId, fid), onSuccess: invalidate });
  const reactivateMutation = useMutation({ mutationFn: (fid: number) => reactivateMember(allianceId, fid), onSuccess: invalidate });
  const unlinkMutation = useMutation({ mutationFn: (fid: number) => unlinkMemberDiscord(allianceId, fid), onSuccess: invalidate });
  const linkMutation = useMutation({
    mutationFn: ({ fid, discordId, serverId }: { fid: number; discordId: string; serverId: string }) =>
      linkMemberDiscord(allianceId, fid, discordId, serverId),
    onSuccess: () => {
      invalidate();
      setLinkingFid(null);
    },
  });
  const busy = deactivateMutation.isPending || reactivateMutation.isPending || unlinkMutation.isPending || linkMutation.isPending;

  return (
    <Layout
      title="Alliance members"
      backTo={{ to: "/admin", label: "Admin" }}
      eyebrow={
        <span className="flex items-center gap-2">
          <span className="rounded-pill bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] px-2 py-0.5 font-mono text-[10px] font-bold tracking-pill text-on-gold uppercase">
            {TIER_LABELS[ctx.tier]}
          </span>
        </span>
      }
    >
      {isLoading && <LoadingRows rows={6} />}
      {error && <ErrorState message="Couldn't load members." onRetry={refetch} />}

      {data && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative max-w-sm flex-1">
              <Search size={16} strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or fid…"
                className="w-full rounded-control border border-line bg-surface-sunken py-2 pr-3 pl-9 text-sm text-ink"
              />
            </div>
            <Pill active={filter === "all"} onClick={() => setFilter("all")}>
              All {data.length}
            </Pill>
            <Pill active={filter === "active"} onClick={() => setFilter("active")}>
              Active {activeCount}
            </Pill>
            <Pill active={filter === "inactive"} onClick={() => setFilter("inactive")}>
              Inactive {inactiveCount}
            </Pill>
            <button
              onClick={() => setFilter(filter === "noDiscord" ? "all" : "noDiscord")}
              className={`rounded-pill px-3 py-2 font-mono text-[11px] tracking-pill uppercase ${
                filter === "noDiscord" ? "border border-down-border bg-down-tint text-down-ink" : "border border-down-border/50 text-down-ink/80 hover:bg-down-tint"
              }`}
            >
              No Discord {noDiscordCount}
            </button>
          </div>

          {filtered.length === 0 && <p className="text-sm text-ink-muted">No members match{search.trim() ? ` "${search}"` : " this filter"}.</p>}

          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-card border border-line sm:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-header text-left font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Chief office lv</th>
                  <th className="px-4 py-2 font-medium">Kingdom</th>
                  <th className="px-4 py-2 font-medium">Discord</th>
                  <th className="px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-hairline">
                {filtered.map((m, i) => (
                  <MemberRow
                    key={m.fid}
                    member={m}
                    zebra={i % 2 === 1}
                    isLinking={linkingFid === m.fid}
                    onStartLink={() => setLinkingFid(m.fid)}
                    onCancelLink={() => setLinkingFid(null)}
                    onSubmitLink={(discordId, serverId) => linkMutation.mutate({ fid: m.fid, discordId, serverId })}
                    onUnlink={() => unlinkMutation.mutate(m.fid)}
                    onDeactivate={() => deactivateMutation.mutate(m.fid)}
                    onReactivate={() => reactivateMutation.mutate(m.fid)}
                    busy={busy}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-2 sm:hidden">
            {filtered.map((m) => (
              <div key={m.fid} className={`rounded-card border border-line p-3.5 ${!m.isActive ? "text-ink-faint" : "bg-surface-panel"}`}>
                <div className="flex items-center justify-between">
                  <span className={`text-sm font-medium ${m.isActive ? "text-ink" : ""}`}>{m.nickname ?? "—"}</span>
                  <span className={`flex items-center gap-1 font-mono text-xs ${m.discordId ? "text-up-ink" : "text-down-ink"}`}>
                    {m.discordId ? "● linked" : "○ not linked"}
                  </span>
                </div>
                <p className="mt-0.5 font-mono text-xs text-ink-muted">fid {m.fid} · CO {m.chiefOfficeLv ?? "—"}</p>
                <div className="mt-2 flex gap-2">
                  {m.isActive ? (
                    <button onClick={() => deactivateMutation.mutate(m.fid)} disabled={busy} className={`${buttonSecondary} min-h-11 flex-1`}>
                      Deactivate
                    </button>
                  ) : (
                    <button onClick={() => reactivateMutation.mutate(m.fid)} disabled={busy} className={`${buttonSecondary} min-h-11 flex-1`}>
                      Reactivate
                    </button>
                  )}
                  {m.discordId ? (
                    <button onClick={() => unlinkMutation.mutate(m.fid)} disabled={busy} className={`${buttonSecondary} min-h-11 flex-1`}>
                      Unlink
                    </button>
                  ) : (
                    <button onClick={() => setLinkingFid(m.fid)} disabled={busy} className={`${buttonPrimary} min-h-11 flex-1`}>
                      Link Discord…
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Layout>
  );
}

function MemberRow({
  member,
  zebra,
  isLinking,
  onStartLink,
  onCancelLink,
  onSubmitLink,
  onUnlink,
  onDeactivate,
  onReactivate,
  busy,
}: {
  member: AdminMember;
  zebra: boolean;
  isLinking: boolean;
  onStartLink: () => void;
  onCancelLink: () => void;
  onSubmitLink: (discordId: string, serverId: string) => void;
  onUnlink: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  busy: boolean;
}) {
  const [discordId, setDiscordId] = useState("");
  const [serverId, setServerId] = useState("");
  const smallButton = "rounded-control border border-line-strong px-2 py-1 text-xs text-ink-secondary hover:bg-white/[.03] disabled:opacity-50";

  return (
    <>
      <tr className={`${zebra ? "bg-surface-panel-alt" : ""} ${!member.isActive ? "text-ink-faint" : ""}`}>
        <td className="px-4 py-2">{member.nickname ?? "—"}</td>
        <td className="px-4 py-2 font-mono text-ink-secondary">{member.chiefOfficeLv ?? "—"}</td>
        <td className="px-4 py-2 font-mono text-ink-secondary">{member.kid ?? "—"}</td>
        <td className="px-4 py-2">
          <span className={`flex items-center gap-1 font-mono text-xs ${member.discordId ? "text-up-ink" : "text-down-ink"}`}>
            {member.discordId ? `● linked (${member.discordId})` : "○ not linked"}
          </span>
        </td>
        <td className="px-4 py-2">
          <div className="flex flex-wrap gap-2">
            {member.isActive ? (
              <button onClick={onDeactivate} disabled={busy} className={smallButton}>
                Deactivate
              </button>
            ) : (
              <button onClick={onReactivate} disabled={busy} className={smallButton}>
                Reactivate
              </button>
            )}
            {member.discordId ? (
              <button onClick={onUnlink} disabled={busy} className={smallButton}>
                Unlink Discord
              </button>
            ) : (
              <button
                onClick={onStartLink}
                disabled={busy}
                className="rounded-control bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] px-2 py-1 text-xs font-bold text-on-gold disabled:opacity-50"
              >
                Link Discord…
              </button>
            )}
          </div>
        </td>
      </tr>
      {isLinking && (
        <tr className="bg-surface-panel-alt">
          <td colSpan={5} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <input
                placeholder="Discord user ID"
                value={discordId}
                onChange={(e) => setDiscordId(e.target.value)}
                className="rounded-control border border-line bg-surface-sunken px-2 py-1.5 font-mono text-ink"
              />
              <input
                placeholder="Discord server ID"
                value={serverId}
                onChange={(e) => setServerId(e.target.value)}
                className="rounded-control border border-line bg-surface-sunken px-2 py-1.5 font-mono text-ink"
              />
              <button
                onClick={() => onSubmitLink(discordId, serverId)}
                disabled={!/^\d+$/.test(discordId) || !/^\d+$/.test(serverId)}
                className="rounded-control bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] px-3 py-1.5 font-bold text-on-gold disabled:opacity-40"
              >
                Save
              </button>
              <button onClick={onCancelLink} className="text-ink-muted hover:text-ink-secondary">
                Cancel
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
