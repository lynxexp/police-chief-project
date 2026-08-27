import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import Layout from "../components/Layout";
import {
  getAdminAllianceMembers,
  deactivateMember,
  reactivateMember,
  linkMemberDiscord,
  unlinkMemberDiscord,
  type AdminMember,
} from "../api/client";
import { Badge, ErrorState, LoadingState } from "../components/ui";

/** Admin-level roster -- shows fields member-facing views don't (Discord
 * link status, kingdom id, deactivation state) and the writes that act
 * on them: deactivate/reactivate, link/unlink Discord. */
export default function AdminMembers() {
  const { allianceId: allianceIdParam } = useParams<{ allianceId: string }>();
  const allianceId = Number(allianceIdParam);
  const [activeOnly, setActiveOnly] = useState(false);
  const [linkingFid, setLinkingFid] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [registrationFilter, setRegistrationFilter] = useState<"all" | "registered" | "unregistered">("all");

  const queryClient = useQueryClient();
  const queryKey = ["admin-alliance-members", allianceId, activeOnly];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => getAdminAllianceMembers(allianceId, activeOnly),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  // Count against the currently loaded set (respects the Active-only
  // toggle above) so "X of Y" always matches what's actually on screen
  // before the search box narrows it further.
  const registeredCount = (data ?? []).filter((m) => m.discordId).length;

  const filtered = (data ?? []).filter((m) => {
    if (registrationFilter === "registered" && !m.discordId) return false;
    if (registrationFilter === "unregistered" && m.discordId) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    if (/^\d+$/.test(q) && String(m.fid).includes(q)) return true;
    return m.nickname?.toLowerCase().includes(q) ?? false;
  });

  const deactivateMutation = useMutation({
    mutationFn: (fid: number) => deactivateMember(allianceId, fid),
    onSuccess: invalidate,
  });
  const reactivateMutation = useMutation({
    mutationFn: (fid: number) => reactivateMember(allianceId, fid),
    onSuccess: invalidate,
  });
  const unlinkMutation = useMutation({
    mutationFn: (fid: number) => unlinkMemberDiscord(allianceId, fid),
    onSuccess: invalidate,
  });
  const linkMutation = useMutation({
    mutationFn: ({ fid, discordId, serverId }: { fid: number; discordId: string; serverId: string }) =>
      linkMemberDiscord(allianceId, fid, discordId, serverId),
    onSuccess: () => {
      invalidate();
      setLinkingFid(null);
    },
  });

  return (
    <Layout title="Alliance members" backTo={{ to: "/admin", label: "Admin" }}>
      <label className="mb-4 flex items-center gap-2 text-sm text-slate-400">
        <input
          type="checkbox"
          checked={activeOnly}
          onChange={(e) => setActiveOnly(e.target.checked)}
          className="rounded border-slate-700 bg-slate-900"
        />
        Active members only
      </label>

      {isLoading && <LoadingState />}
      {error && <ErrorState message="Couldn't load members." />}

      {data && (
        <>
          <p className="mb-3 text-sm text-slate-400">
            <span className="font-medium text-slate-200">{registeredCount}</span> of{" "}
            <span className="font-medium text-slate-200">{data.length}</span> registered
          </p>
          <div className="mb-3 flex flex-wrap gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or fid…"
              className="w-full max-w-sm rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
            />
            <select
              value={registrationFilter}
              onChange={(e) =>
                setRegistrationFilter(e.target.value as "all" | "registered" | "unregistered")
              }
              className="rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
            >
              <option value="all">All members</option>
              <option value="registered">Registered only</option>
              <option value="unregistered">Not registered</option>
            </select>
          </div>
          {filtered.length === 0 && data.length > 0 && (
            <p className="mb-3 text-sm text-slate-500">
              No members match{search.trim() ? ` "${search}"` : " this filter"}.
            </p>
          )}
          {data.length === 0 && (
            <p className="mb-3 text-sm text-slate-500">No members found.</p>
          )}
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-left text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">fid</th>
                <th className="px-4 py-2 font-medium">Kingdom</th>
                <th className="px-4 py-2 font-medium">Chief office lv</th>
                <th className="px-4 py-2 font-medium">Discord</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filtered.map((m) => (
                <MemberRow
                  key={m.fid}
                  member={m}
                  isLinking={linkingFid === m.fid}
                  onStartLink={() => setLinkingFid(m.fid)}
                  onCancelLink={() => setLinkingFid(null)}
                  onSubmitLink={(discordId, serverId) =>
                    linkMutation.mutate({ fid: m.fid, discordId, serverId })
                  }
                  onUnlink={() => unlinkMutation.mutate(m.fid)}
                  onDeactivate={() => deactivateMutation.mutate(m.fid)}
                  onReactivate={() => reactivateMutation.mutate(m.fid)}
                  busy={
                    deactivateMutation.isPending ||
                    reactivateMutation.isPending ||
                    unlinkMutation.isPending ||
                    linkMutation.isPending
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </Layout>
  );
}

function MemberRow({
  member,
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

  return (
    <>
      <tr className="hover:bg-slate-900/60">
        <td className="px-4 py-2">{member.nickname ?? "—"}</td>
        <td className="px-4 py-2 text-slate-400">{member.fid}</td>
        <td className="px-4 py-2 text-slate-300">{member.kid ?? "—"}</td>
        <td className="px-4 py-2 text-slate-300">{member.chiefOfficeLv ?? "—"}</td>
        <td className="px-4 py-2 text-slate-300">
          {member.discordId ? `linked (${member.discordId})` : "not linked"}
        </td>
        <td className="px-4 py-2">
          <Badge variant={member.isActive ? "success" : "neutral"}>
            {member.isActive ? "active" : "inactive"}
          </Badge>
        </td>
        <td className="px-4 py-2">
          <div className="flex flex-wrap gap-2">
            {member.isActive ? (
              <button
                onClick={onDeactivate}
                disabled={busy}
                className="rounded border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-50"
              >
                Deactivate
              </button>
            ) : (
              <button
                onClick={onReactivate}
                disabled={busy}
                className="rounded border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-50"
              >
                Reactivate
              </button>
            )}
            {member.discordId ? (
              <button
                onClick={onUnlink}
                disabled={busy}
                className="rounded border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-50"
              >
                Unlink Discord
              </button>
            ) : (
              <button
                onClick={onStartLink}
                disabled={busy}
                className="rounded border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-50"
              >
                Link Discord…
              </button>
            )}
          </div>
        </td>
      </tr>
      {isLinking && (
        <tr className="bg-slate-900/40">
          <td colSpan={7} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <input
                placeholder="Discord user ID"
                value={discordId}
                onChange={(e) => setDiscordId(e.target.value)}
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
              />
              <input
                placeholder="Discord server ID"
                value={serverId}
                onChange={(e) => setServerId(e.target.value)}
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
              />
              <button
                onClick={() => onSubmitLink(discordId, serverId)}
                disabled={!/^\d+$/.test(discordId) || !/^\d+$/.test(serverId)}
                className="rounded bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
              >
                Save
              </button>
              <button onClick={onCancelLink} className="text-slate-400 hover:text-slate-200">
                Cancel
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
