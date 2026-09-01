import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import {
  getAdminVaultHunt,
  updateVaultHunt,
  deleteVaultHunt,
  addVaultHuntPlayer,
  updateVaultHuntPlayer,
  deleteVaultHuntPlayer,
  getAdminAllianceMembers,
  type AdminVaultHuntPlayer,
} from "../api/client";
import { Card, EditableNumberCell, ErrorState, LoadingState, buttonDanger, buttonPrimary, buttonSecondary } from "../components/ui";

const fieldClass = "mt-1 w-full rounded-control border border-line bg-surface-sunken px-3 py-1.5 text-sm text-ink";
const UNMATCHED = "unmatched";

function PlayerRow({
  player,
  rosterOptions,
  onSaveDamage,
  onSaveRank,
  onReassign,
  onRemove,
  disabled,
}: {
  player: AdminVaultHuntPlayer;
  rosterOptions: { fid: number; nickname: string | null }[];
  onSaveDamage: (v: number) => void;
  onSaveRank: (v: number | null) => void;
  onReassign: (fid: number | null) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <tr className="border-b border-line-hairline last:border-b-0">
      <td className="px-4 py-2">
        <select
          value={player.fid !== null ? String(player.fid) : UNMATCHED}
          onChange={(e) => onReassign(e.target.value === UNMATCHED ? null : Number(e.target.value))}
          disabled={disabled}
          className={fieldClass}
        >
          <option value={UNMATCHED}>{player.name ?? "(unmatched)"} — unmatched</option>
          {rosterOptions.map((m) => (
            <option key={m.fid} value={m.fid}>
              {m.nickname ?? `FID ${m.fid}`}
            </option>
          ))}
        </select>
      </td>
      <td className="px-4 py-2">
        <EditableNumberCell value={player.damage} min={0} disabled={disabled} onSave={onSaveDamage} />
      </td>
      <td className="px-4 py-2">
        <EditableNumberCell value={player.rank} min={1} disabled={disabled} onSave={onSaveRank} />
      </td>
      <td className="px-4 py-2">
        <button onClick={onRemove} disabled={disabled} className={buttonSecondary}>
          Remove
        </button>
      </td>
    </tr>
  );
}

function AddPlayerForm({
  rosterOptions,
  onAdd,
  disabled,
}: {
  rosterOptions: { fid: number; nickname: string | null }[];
  onAdd: (input: { fid?: number; name?: string; damage: number; rank?: number | null }) => void;
  disabled: boolean;
}) {
  const [fid, setFid] = useState("");
  const [name, setName] = useState("");
  const [damage, setDamage] = useState("");
  const [rank, setRank] = useState("");

  const canAdd = damage.trim() !== "" && (fid !== "" || name.trim() !== "");

  return (
    <div className="grid grid-cols-1 gap-2 border-t border-line-hairline p-4 sm:grid-cols-[2fr_1fr_1fr_auto]">
      <select value={fid} onChange={(e) => setFid(e.target.value)} className={fieldClass}>
        <option value="">Type a name instead…</option>
        {rosterOptions.map((m) => (
          <option key={m.fid} value={m.fid}>
            {m.nickname ?? `FID ${m.fid}`}
          </option>
        ))}
      </select>
      {fid === "" && (
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (not in roster)"
          className={fieldClass}
        />
      )}
      <input value={damage} onChange={(e) => setDamage(e.target.value)} type="number" min={0} placeholder="Damage" className={fieldClass} />
      <input value={rank} onChange={(e) => setRank(e.target.value)} type="number" min={1} placeholder="Rank (optional)" className={fieldClass} />
      <button
        onClick={() => {
          onAdd({
            fid: fid !== "" ? Number(fid) : undefined,
            name: fid === "" ? name.trim() : undefined,
            damage: Number(damage),
            rank: rank.trim() !== "" ? Number(rank) : null,
          });
          setFid("");
          setName("");
          setDamage("");
          setRank("");
        }}
        disabled={disabled || !canAdd}
        className={buttonPrimary}
      >
        + Add player
      </button>
    </div>
  );
}

export default function AdminVaultHuntDetail() {
  const { allianceId: allianceIdParam, huntId: huntIdParam } = useParams<{ allianceId: string; huntId: string }>();
  const allianceId = Number(allianceIdParam);
  const huntId = Number(huntIdParam);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const huntQuery = useQuery({
    queryKey: ["admin-vault-hunt", allianceId, huntId],
    queryFn: () => getAdminVaultHunt(allianceId, huntId),
  });
  const membersQuery = useQuery({
    queryKey: ["admin-alliance-members", allianceId, true],
    queryFn: () => getAdminAllianceMembers(allianceId, true),
  });
  const rosterOptions = (membersQuery.data ?? []).map((m) => ({ fid: m.fid, nickname: m.nickname }));

  const [date, setDate] = useState("");
  const [trapNumber, setTrapNumber] = useState("");
  const [rallies, setRallies] = useState("");
  const [totalDamage, setTotalDamage] = useState("");
  const [metaLoaded, setMetaLoaded] = useState(false);
  useEffect(() => {
    if (huntQuery.data && !metaLoaded) {
      setDate(huntQuery.data.date);
      setTrapNumber(String(huntQuery.data.trapNumber));
      setRallies(huntQuery.data.rallies !== null ? String(huntQuery.data.rallies) : "");
      setTotalDamage(huntQuery.data.totalDamage !== null ? String(huntQuery.data.totalDamage) : "");
      setMetaLoaded(true);
    }
  }, [huntQuery.data, metaLoaded]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-vault-hunt", allianceId, huntId] });
  const invalidateList = () => queryClient.invalidateQueries({ queryKey: ["admin-vault-hunts", allianceId] });

  const saveMetaMutation = useMutation({
    mutationFn: () =>
      updateVaultHunt(allianceId, huntId, {
        date,
        trapNumber: Number(trapNumber),
        rallies: rallies.trim() !== "" ? Number(rallies) : null,
        totalDamage: totalDamage.trim() !== "" ? Number(totalDamage) : null,
      }),
    onSuccess: () => {
      invalidate();
      invalidateList();
    },
  });

  const deleteHuntMutation = useMutation({
    mutationFn: () => deleteVaultHunt(allianceId, huntId),
    onSuccess: () => {
      invalidateList();
      navigate(`/admin/alliances/${allianceId}/vault-hunts`);
    },
  });

  const addPlayerMutation = useMutation({
    mutationFn: (input: { fid?: number; name?: string; damage: number; rank?: number | null }) =>
      addVaultHuntPlayer(allianceId, huntId, input),
    onSuccess: () => {
      invalidate();
      invalidateList();
    },
  });
  const editPlayerMutation = useMutation({
    mutationFn: ({ rowId, edits }: { rowId: number; edits: { fid?: number | null; damage?: number; rank?: number | null } }) =>
      updateVaultHuntPlayer(allianceId, huntId, rowId, edits),
    onSuccess: invalidate,
  });
  const removePlayerMutation = useMutation({
    mutationFn: (rowId: number) => deleteVaultHuntPlayer(allianceId, huntId, rowId),
    onSuccess: () => {
      invalidate();
      invalidateList();
    },
  });

  const busy =
    saveMetaMutation.isPending ||
    deleteHuntMutation.isPending ||
    addPlayerMutation.isPending ||
    editPlayerMutation.isPending ||
    removePlayerMutation.isPending;

  return (
    <Layout title="Vault Trap record" backTo={{ to: `/admin/alliances/${allianceId}/vault-hunts`, label: "Vault Trap records" }}>
      {huntQuery.isLoading && <LoadingState />}
      {huntQuery.error && <ErrorState message="Couldn't load this vault hunt." onRetry={huntQuery.refetch} />}

      {huntQuery.data && (
        <div className="flex flex-col gap-4">
          <Card>
            <p className="mb-3 font-display text-[15px] font-semibold tracking-heading text-ink uppercase">Hunt details</p>
            <div className="grid gap-3 sm:grid-cols-4">
              <label className="block">
                <span className="text-xs text-ink-muted">Date</span>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldClass} />
              </label>
              <label className="block">
                <span className="text-xs text-ink-muted">Trap</span>
                <input
                  type="number"
                  min={1}
                  value={trapNumber}
                  onChange={(e) => setTrapNumber(e.target.value)}
                  className={fieldClass}
                />
              </label>
              <label className="block">
                <span className="text-xs text-ink-muted">Rallies</span>
                <input type="number" min={0} value={rallies} onChange={(e) => setRallies(e.target.value)} className={fieldClass} />
              </label>
              <label className="block">
                <span className="text-xs text-ink-muted">Total damage</span>
                <input
                  type="number"
                  min={0}
                  value={totalDamage}
                  onChange={(e) => setTotalDamage(e.target.value)}
                  className={fieldClass}
                />
              </label>
            </div>
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={() => saveMetaMutation.mutate()}
                disabled={busy || date.trim() === "" || trapNumber.trim() === ""}
                className={buttonPrimary}
              >
                Save changes
              </button>
              <button
                onClick={() => {
                  if (confirm("Delete this vault hunt and all its player records? This cannot be undone.")) {
                    deleteHuntMutation.mutate();
                  }
                }}
                disabled={busy}
                className={buttonDanger}
              >
                Delete hunt
              </button>
              {saveMetaMutation.isError && (
                <span className="text-xs text-down-ink">{(saveMetaMutation.error as Error).message}</span>
              )}
            </div>
          </Card>

          <Card className="p-0">
            <p className="border-b border-line-hairline px-4 py-3 font-display text-[15px] font-semibold tracking-heading text-ink uppercase">
              Players ({huntQuery.data.players.length})
            </p>
            {huntQuery.data.players.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-header text-left font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                    <th className="px-4 py-2 font-medium">Member</th>
                    <th className="px-4 py-2 font-medium">Damage</th>
                    <th className="px-4 py-2 font-medium">Rank</th>
                    <th className="px-4 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {huntQuery.data.players.map((p) => (
                    <PlayerRow
                      key={p.id}
                      player={p}
                      rosterOptions={rosterOptions}
                      disabled={busy}
                      onSaveDamage={(v) => editPlayerMutation.mutate({ rowId: p.id, edits: { damage: v } })}
                      onSaveRank={(v) => editPlayerMutation.mutate({ rowId: p.id, edits: { rank: v } })}
                      onReassign={(fid) => editPlayerMutation.mutate({ rowId: p.id, edits: { fid } })}
                      onRemove={() => {
                        if (confirm(`Remove ${p.name ?? "this player"} from this hunt?`)) removePlayerMutation.mutate(p.id);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            )}
            <AddPlayerForm rosterOptions={rosterOptions} disabled={busy} onAdd={(input) => addPlayerMutation.mutate(input)} />
          </Card>
        </div>
      )}
    </Layout>
  );
}
