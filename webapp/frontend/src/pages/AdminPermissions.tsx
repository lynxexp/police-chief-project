import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useOutletContext } from "react-router-dom";
import Layout from "../components/Layout";
import {
  getAdminPermissions,
  addAdmin,
  setAdminTier,
  removeAdmin,
  transferOwnership,
  type AdminListEntry,
  type AuthContext,
  type Tier,
} from "../api/client";
import { Card, ErrorState, LoadingRows, SectionHeading, StatTile, buttonPrimary, buttonSecondary } from "../components/ui";

const SETTABLE_TIERS: Tier[] = ["global", "server", "alliance"];

function parseAllianceIds(raw: string): number[] | undefined {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  return ids.length > 0 ? ids : undefined;
}

/** Mirrors the Discord "Permissions" menu's admin list, plus its writes
 * (add/set-tier/remove/transfer-owner) -- gated to global admins
 * server-side (see routes/admin.ts), so a non-global admin hitting this
 * page directly gets 403s from the queries/mutations, not a working UI. */
export default function AdminPermissions() {
  const ctx = useOutletContext<AuthContext>();
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-permissions"],
    queryFn: getAdminPermissions,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-permissions"] });

  const [newDiscordId, setNewDiscordId] = useState("");
  const [newTier, setNewTier] = useState<Tier>("server");
  const [newAllianceIds, setNewAllianceIds] = useState("");

  const addMutation = useMutation({
    mutationFn: () => addAdmin(newDiscordId, newTier, parseAllianceIds(newAllianceIds)),
    onSuccess: () => {
      invalidate();
      setNewDiscordId("");
      setNewAllianceIds("");
    },
  });

  const removeMutation = useMutation({ mutationFn: (id: string) => removeAdmin(id), onSuccess: invalidate });
  const transferMutation = useMutation({ mutationFn: (id: string) => transferOwnership(id), onSuccess: invalidate });

  const counts = {
    owner: data?.admins.filter((a) => a.isOwner).length ?? 0,
    global: data?.admins.filter((a) => a.tier === "global" && !a.isOwner).length ?? 0,
    server: data?.admins.filter((a) => a.tier === "server").length ?? 0,
    alliance: data?.admins.filter((a) => a.tier === "alliance").length ?? 0,
  };

  return (
    <Layout
      title="Admins"
      backTo={{ to: "/admin", label: "Admin" }}
      actions={
        <Link to="/admin/permissions/audit-log" className={buttonSecondary}>
          View audit log →
        </Link>
      }
    >
      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-card border border-gold-border bg-gold-tint p-4">
            <p className="font-mono text-[10px] tracking-eyebrow text-gold-ink uppercase">Owner</p>
            <p className="font-display text-[28px] font-bold text-ink">{counts.owner}</p>
          </div>
          <StatTile label="Global" figure={counts.global} />
          <StatTile label="Server" figure={counts.server} />
          <StatTile label="Alliance" figure={counts.alliance} />
        </div>
      )}

      <Card className="max-w-lg">
        <SectionHeading>Add admin</SectionHeading>
        <div className="flex flex-col gap-2.5">
          <input
            placeholder="Discord user ID"
            value={newDiscordId}
            onChange={(e) => setNewDiscordId(e.target.value)}
            className="w-full rounded-control border border-line bg-surface-sunken px-3 py-1.5 font-mono text-sm text-ink"
          />
          <select
            value={newTier}
            onChange={(e) => setNewTier(e.target.value as Tier)}
            className="w-full rounded-control border border-line bg-surface-sunken px-3 py-1.5 text-sm text-ink"
          >
            {SETTABLE_TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {newTier === "alliance" && (
            <input
              placeholder="Alliance IDs, comma-separated"
              value={newAllianceIds}
              onChange={(e) => setNewAllianceIds(e.target.value)}
              className="w-full rounded-control border border-line bg-surface-sunken px-3 py-1.5 text-sm text-ink"
            />
          )}
          <div>
            <button onClick={() => addMutation.mutate()} disabled={addMutation.isPending || !/^\d+$/.test(newDiscordId)} className={buttonPrimary}>
              Add
            </button>
            {addMutation.isError && <p className="mt-1.5 text-xs text-down-ink">{(addMutation.error as Error).message}</p>}
          </div>
        </div>
      </Card>

      {isLoading && <LoadingRows rows={4} />}
      {error && <ErrorState message="Couldn't load the admin list." onRetry={refetch} />}

      {data && (
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-header text-left font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                <th className="px-4 py-2 font-medium">Admin</th>
                <th className="px-4 py-2 font-medium">Tier</th>
                <th className="px-4 py-2 font-medium">Scope</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-hairline">
              {data.admins.map((a, i) => (
                <AdminRow
                  key={a.id}
                  admin={a}
                  zebra={i % 2 === 1}
                  isSelf={a.id === ctx.discordId}
                  viewerIsOwner={ctx.isOwner}
                  onRemove={() => {
                    if (window.confirm(`Remove admin ${a.name ?? a.id}? This cannot be undone.`)) {
                      removeMutation.mutate(a.id);
                    }
                  }}
                  onTransferOwnership={() => {
                    if (window.confirm(`Transfer bot ownership to ${a.name ?? a.id}? You will become a regular Global admin.`)) {
                      transferMutation.mutate(a.id);
                    }
                  }}
                  onSetTier={(tier, allianceIds) => setAdminTier(a.id, tier, allianceIds)}
                  onSetTierSuccess={invalidate}
                  busy={removeMutation.isPending || transferMutation.isPending}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
}

function AdminRow({
  admin,
  zebra,
  isSelf,
  viewerIsOwner,
  onRemove,
  onTransferOwnership,
  onSetTier,
  onSetTierSuccess,
  busy,
}: {
  admin: AdminListEntry;
  zebra: boolean;
  isSelf: boolean;
  viewerIsOwner: boolean;
  onRemove: () => void;
  onTransferOwnership: () => void;
  onSetTier: (tier: Tier, allianceIds?: number[]) => Promise<{ ok: true }>;
  onSetTierSuccess: () => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [tier, setTier] = useState<Tier>(admin.tier === "owner" ? "global" : admin.tier);
  const [allianceIds, setAllianceIds] = useState("");

  const setTierMutation = useMutation({
    mutationFn: () => onSetTier(tier, parseAllianceIds(allianceIds)),
    onSuccess: () => {
      onSetTierSuccess();
      setEditing(false);
    },
  });

  const smallButton = `${buttonSecondary} px-2 py-1 text-xs`;

  return (
    <>
      <tr className={zebra ? "bg-surface-panel-alt" : undefined}>
        <td className="px-4 py-2">
          <span className="text-ink">{admin.name ?? "—"}</span> <span className="font-mono text-xs text-ink-faint">{admin.id}</span>
          {admin.isOwner && (
            <span className="ml-2 rounded-pill border border-gold-border bg-gold-tint px-1.5 py-0.5 font-mono text-[10px] font-bold text-gold-ink uppercase">
              owner
            </span>
          )}
        </td>
        <td className="px-4 py-2 text-ink-secondary capitalize">{admin.tier}</td>
        <td className="px-4 py-2 text-ink-secondary">{admin.tier === "alliance" ? `${admin.allianceCount} alliance(s)` : "—"}</td>
        <td className="px-4 py-2">
          {isSelf && admin.isOwner ? (
            <span className="text-xs text-ink-faint">You — can't demote yourself</span>
          ) : (
            !admin.isOwner && (
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setEditing((v) => !v)} disabled={busy} className={smallButton}>
                  Change tier
                </button>
                <button onClick={onRemove} disabled={busy} className={smallButton}>
                  Remove
                </button>
                {viewerIsOwner && admin.tier === "global" && (
                  <button onClick={onTransferOwnership} disabled={busy} className="rounded-control border border-gold-border px-2 py-1 text-xs text-gold-ink hover:bg-gold-tint disabled:opacity-50">
                    Make owner
                  </button>
                )}
              </div>
            )
          )}
        </td>
      </tr>
      {editing && (
        <tr className="bg-surface-panel-alt">
          <td colSpan={4} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value as Tier)}
                className="rounded-control border border-line bg-surface-sunken px-2 py-1 text-ink"
              >
                {SETTABLE_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {tier === "alliance" && (
                <input
                  placeholder="Alliance IDs, comma-separated"
                  value={allianceIds}
                  onChange={(e) => setAllianceIds(e.target.value)}
                  className="rounded-control border border-line bg-surface-sunken px-2 py-1 text-ink"
                />
              )}
              <button
                onClick={() => setTierMutation.mutate()}
                disabled={setTierMutation.isPending}
                className="rounded-control bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] px-3 py-1 font-bold text-on-gold disabled:opacity-40"
              >
                Save
              </button>
              <button onClick={() => setEditing(false)} className="text-ink-muted hover:text-ink-secondary">
                Cancel
              </button>
              {setTierMutation.isError && <span className="text-down-ink">{(setTierMutation.error as Error).message}</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
