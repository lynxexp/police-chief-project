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
import { Card, ErrorState, LoadingState, SectionHeading } from "../components/ui";

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
  const { data, isLoading, error } = useQuery({
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

  const removeMutation = useMutation({
    mutationFn: (id: string) => removeAdmin(id),
    onSuccess: invalidate,
  });

  const transferMutation = useMutation({
    mutationFn: (id: string) => transferOwnership(id),
    onSuccess: invalidate,
  });

  return (
    <Layout title="Admins" backTo={{ to: "/admin", label: "Admin" }}>
      <div className="mb-6">
        <Link
          to="/admin/permissions/audit-log"
          className="text-sm text-indigo-400 hover:text-indigo-300"
        >
          View audit log →
        </Link>
      </div>

      <Card className="mb-8 max-w-lg">
        <SectionHeading>Add admin</SectionHeading>
        <div className="space-y-2">
          <input
            placeholder="Discord user ID"
            value={newDiscordId}
            onChange={(e) => setNewDiscordId(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
          />
          <select
            value={newTier}
            onChange={(e) => setNewTier(e.target.value as Tier)}
            className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
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
              className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
            />
          )}
          <button
            onClick={() => addMutation.mutate()}
            disabled={addMutation.isPending || !/^\d+$/.test(newDiscordId)}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            Add
          </button>
          {addMutation.isError && (
            <p className="text-xs text-red-400">
              {(addMutation.error as Error).message}
            </p>
          )}
        </div>
      </Card>

      {isLoading && <LoadingState />}
      {error && <ErrorState message="Couldn't load the admin list." />}

      {data && (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-left text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">Admin</th>
                <th className="px-4 py-2 font-medium">Tier</th>
                <th className="px-4 py-2 font-medium">Alliances</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {data.admins.map((a) => (
                <AdminRow
                  key={a.id}
                  admin={a}
                  viewerIsOwner={ctx.isOwner}
                  onRemove={() => {
                    if (window.confirm(`Remove admin ${a.name ?? a.id}? This cannot be undone.`)) {
                      removeMutation.mutate(a.id);
                    }
                  }}
                  onTransferOwnership={() => {
                    if (
                      window.confirm(
                        `Transfer bot ownership to ${a.name ?? a.id}? You will become a regular Global admin.`,
                      )
                    ) {
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
  viewerIsOwner,
  onRemove,
  onTransferOwnership,
  onSetTier,
  onSetTierSuccess,
  busy,
}: {
  admin: AdminListEntry;
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

  return (
    <>
      <tr className="hover:bg-slate-900/60">
        <td className="px-4 py-2">
          {admin.name ?? admin.id}
          {admin.isOwner && (
            <span className="ml-2 rounded bg-amber-900/40 px-2 py-0.5 text-xs text-amber-300">
              owner
            </span>
          )}
        </td>
        <td className="px-4 py-2 capitalize text-slate-300">{admin.tier}</td>
        <td className="px-4 py-2 text-slate-300">
          {admin.tier === "alliance" ? admin.allianceCount : "—"}
        </td>
        <td className="px-4 py-2">
          {!admin.isOwner && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setEditing((v) => !v)}
                disabled={busy}
                className="rounded border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-50"
              >
                Change tier
              </button>
              <button
                onClick={onRemove}
                disabled={busy}
                className="rounded border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-50"
              >
                Remove
              </button>
              {viewerIsOwner && admin.tier === "global" && (
                <button
                  onClick={onTransferOwnership}
                  disabled={busy}
                  className="rounded border border-amber-800 px-2 py-1 text-xs text-amber-300 hover:bg-amber-900/30 disabled:opacity-50"
                >
                  Make owner
                </button>
              )}
            </div>
          )}
        </td>
      </tr>
      {editing && (
        <tr className="bg-slate-900/40">
          <td colSpan={4} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value as Tier)}
                className="rounded border border-slate-700 bg-slate-950 px-2 py-1"
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
                  className="rounded border border-slate-700 bg-slate-950 px-2 py-1"
                />
              )}
              <button
                onClick={() => setTierMutation.mutate()}
                disabled={setTierMutation.isPending}
                className="rounded bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
              >
                Save
              </button>
              <button onClick={() => setEditing(false)} className="text-slate-400 hover:text-slate-200">
                Cancel
              </button>
              {setTierMutation.isError && (
                <span className="text-red-400">{(setTierMutation.error as Error).message}</span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
