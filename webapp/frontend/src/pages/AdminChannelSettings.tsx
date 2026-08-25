import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import {
  getAllianceSettings,
  getAllianceChannels,
  updateAllianceSettings,
  getAllianceGiftChannel,
  updateAllianceGiftChannel,
  getAllianceGuild,
  getAllianceIdChannels,
  addAllianceIdChannel,
  removeAllianceIdChannel,
  getIdChannelSettings,
  updateIdChannelSettings,
  getThemes,
  getGuildTheme,
  updateGuildTheme,
  type AllianceSettings,
  type IdChannelScanSettings,
} from "../api/client";

const FIELDS: { key: keyof AllianceSettings; label: string }[] = [
  { key: "channelId", label: "Main channel" },
  { key: "redemptionChannelId", label: "Gift redemption channel" },
  { key: "vaultScoreChannel", label: "Vault Trap score channel" },
  { key: "capitolScoreChannel", label: "Capitol War score channel" },
];

export default function AdminChannelSettings() {
  const { allianceId: allianceIdParam } = useParams<{ allianceId: string }>();
  const allianceId = Number(allianceIdParam);
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ["admin-alliance-settings", allianceId],
    queryFn: () => getAllianceSettings(allianceId),
  });
  const channelsQuery = useQuery({
    queryKey: ["admin-alliance-channels", allianceId],
    queryFn: () => getAllianceChannels(allianceId),
  });

  const [draft, setDraft] = useState<AllianceSettings | null>(null);
  useEffect(() => {
    if (settingsQuery.data) setDraft(settingsQuery.data);
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (patch: Partial<AllianceSettings>) => updateAllianceSettings(allianceId, patch),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["admin-alliance-settings", allianceId] }),
  });

  // Separate resource (db/giftcode.sqlite's giftcode_channel, not
  // alliance.sqlite's alliancesettings) -- its own query/mutation/save
  // button rather than folding into `draft` above.
  const giftChannelQuery = useQuery({
    queryKey: ["admin-alliance-gift-channel", allianceId],
    queryFn: () => getAllianceGiftChannel(allianceId),
  });
  const [giftChannelDraft, setGiftChannelDraft] = useState<string | null>(null);
  useEffect(() => {
    if (giftChannelQuery.data) setGiftChannelDraft(giftChannelQuery.data.channelId);
  }, [giftChannelQuery.data]);
  const saveGiftChannelMutation = useMutation({
    mutationFn: (channelId: string | null) => updateAllianceGiftChannel(allianceId, channelId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["admin-alliance-gift-channel", allianceId] }),
  });

  // ID channels -- per-alliance list, any admin with reach to this
  // alliance (canManageAlliance).
  const idChannelsQuery = useQuery({
    queryKey: ["admin-alliance-id-channels", allianceId],
    queryFn: () => getAllianceIdChannels(allianceId),
  });
  const [newIdChannel, setNewIdChannel] = useState("");
  const addIdChannelMutation = useMutation({
    mutationFn: (channelId: string) => addAllianceIdChannel(allianceId, channelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-alliance-id-channels", allianceId] });
      setNewIdChannel("");
    },
  });
  const removeIdChannelMutation = useMutation({
    mutationFn: (channelId: string) => removeAllianceIdChannel(allianceId, channelId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["admin-alliance-id-channels", allianceId] }),
  });

  // Scan settings are per-GUILD, not per-alliance (canManageGuild,
  // Server tier+) -- resolve this alliance's guild first.
  const guildQuery = useQuery({
    queryKey: ["admin-alliance-guild", allianceId],
    queryFn: () => getAllianceGuild(allianceId),
  });
  const guildId = guildQuery.data?.guildId ?? null;
  const scanSettingsQuery = useQuery({
    queryKey: ["admin-guild-scan-settings", guildId],
    queryFn: () => getIdChannelSettings(guildId!),
    enabled: !!guildId,
  });
  const [scanDraft, setScanDraft] = useState<IdChannelScanSettings | null>(null);
  useEffect(() => {
    if (scanSettingsQuery.data) setScanDraft(scanSettingsQuery.data);
  }, [scanSettingsQuery.data]);
  const saveScanSettingsMutation = useMutation({
    mutationFn: (patch: Partial<IdChannelScanSettings>) => updateIdChannelSettings(guildId!, patch),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["admin-guild-scan-settings", guildId] }),
  });

  // Which theme this guild uses -- also per-guild (canManageGuild).
  const themesQuery = useQuery({ queryKey: ["admin-themes"], queryFn: getThemes });
  const guildThemeQuery = useQuery({
    queryKey: ["admin-guild-theme", guildId],
    queryFn: () => getGuildTheme(guildId!),
    enabled: !!guildId,
  });
  const setGuildThemeMutation = useMutation({
    mutationFn: (themeName: string | null) => updateGuildTheme(guildId!, themeName),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-guild-theme", guildId] }),
  });

  return (
    <Layout
      title="Channel setup"
      backTo={{ to: `/admin/alliances/${allianceId}/members`, label: "Members" }}
    >
      {(settingsQuery.isLoading || channelsQuery.isLoading) && (
        <p className="text-slate-400">Loading…</p>
      )}
      {(settingsQuery.error || channelsQuery.error) && (
        <p className="text-red-400">Couldn't load channel settings.</p>
      )}

      {draft && channelsQuery.data && (
        <div className="max-w-md space-y-4">
          {FIELDS.map(({ key, label }) => (
            <div key={key}>
              <label className="mb-1 block text-sm text-slate-400">{label}</label>
              <select
                value={draft[key] ?? ""}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value || null })}
                className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
              >
                <option value="">— none —</option>
                {channelsQuery.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
            </div>
          ))}

          <button
            onClick={() => saveMutation.mutate(draft)}
            disabled={saveMutation.isPending}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Save
          </button>
          {saveMutation.isSuccess && <span className="ml-3 text-sm text-emerald-400">Saved.</span>}
          {saveMutation.isError && (
            <span className="ml-3 text-sm text-red-400">Couldn't save settings.</span>
          )}

          <div className="border-t border-slate-800 pt-4">
            <label className="mb-1 block text-sm text-slate-400">
              Gift code announcement channel
            </label>
            <select
              value={giftChannelDraft ?? ""}
              onChange={(e) => setGiftChannelDraft(e.target.value || null)}
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
            >
              <option value="">— none —</option>
              {channelsQuery.data.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => saveGiftChannelMutation.mutate(giftChannelDraft)}
              disabled={saveGiftChannelMutation.isPending}
              className="mt-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              Save
            </button>
            {saveGiftChannelMutation.isSuccess && (
              <span className="ml-3 text-sm text-emerald-400">Saved.</span>
            )}
          </div>

          <div className="border-t border-slate-800 pt-4">
            <label className="mb-1 block text-sm text-slate-400">ID channels</label>
            {idChannelsQuery.data && idChannelsQuery.data.length > 0 && (
              <ul className="mb-2 space-y-1 text-sm">
                {idChannelsQuery.data.map((c) => {
                  const channel = channelsQuery.data.find((ch) => ch.id === c.channelId);
                  return (
                    <li key={c.channelId} className="flex items-center justify-between">
                      <span>#{channel?.name ?? c.channelId}</span>
                      <button
                        onClick={() => removeIdChannelMutation.mutate(c.channelId)}
                        disabled={removeIdChannelMutation.isPending}
                        className="text-xs text-slate-500 hover:text-red-400"
                      >
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex gap-2">
              <select
                value={newIdChannel}
                onChange={(e) => setNewIdChannel(e.target.value)}
                className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
              >
                <option value="">— select a channel —</option>
                {channelsQuery.data
                  .filter((c) => !idChannelsQuery.data?.some((ic) => ic.channelId === c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
              </select>
              <button
                onClick={() => addIdChannelMutation.mutate(newIdChannel)}
                disabled={!newIdChannel || addIdChannelMutation.isPending}
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>

          {scanDraft && (
            <div className="border-t border-slate-800 pt-4">
              <label className="mb-2 block text-sm text-slate-400">
                ID channel scan settings (server-wide)
              </label>
              <div className="space-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={scanDraft.scanEnabled}
                    onChange={(e) => setScanDraft({ ...scanDraft, scanEnabled: e.target.checked })}
                    className="rounded border-slate-700 bg-slate-950"
                  />
                  Scan enabled
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={scanDraft.respondToInvalid}
                    onChange={(e) =>
                      setScanDraft({ ...scanDraft, respondToInvalid: e.target.checked })
                    }
                    className="rounded border-slate-700 bg-slate-950"
                  />
                  Respond to invalid IDs
                </label>
                <div className="flex items-center gap-2">
                  <label className="w-32 text-slate-400">Scan limit</label>
                  <input
                    type="number"
                    min={1}
                    value={scanDraft.scanLimit}
                    onChange={(e) => setScanDraft({ ...scanDraft, scanLimit: Number(e.target.value) })}
                    className="w-24 rounded-md border border-slate-700 bg-slate-900 px-2 py-1"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="w-32 text-slate-400">Delete after (s)</label>
                  <input
                    type="number"
                    min={0}
                    value={scanDraft.deleteAfter}
                    onChange={(e) => setScanDraft({ ...scanDraft, deleteAfter: Number(e.target.value) })}
                    className="w-24 rounded-md border border-slate-700 bg-slate-900 px-2 py-1"
                  />
                </div>
              </div>
              <button
                onClick={() => saveScanSettingsMutation.mutate(scanDraft)}
                disabled={saveScanSettingsMutation.isPending}
                className="mt-3 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Save
              </button>
              {saveScanSettingsMutation.isSuccess && (
                <span className="ml-3 text-sm text-emerald-400">Saved.</span>
              )}
            </div>
          )}

          {guildThemeQuery.data && themesQuery.data && (
            <div className="border-t border-slate-800 pt-4">
              <label className="mb-1 block text-sm text-slate-400">
                Theme (server-wide) —{" "}
                <Link to="/admin/themes" className="text-indigo-400 hover:text-indigo-300">
                  manage themes
                </Link>
              </label>
              <select
                value={guildThemeQuery.data.themeName ?? ""}
                onChange={(e) => setGuildThemeMutation.mutate(e.target.value || null)}
                disabled={setGuildThemeMutation.isPending}
                className="w-full max-w-xs rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
              >
                <option value="">— use global default —</option>
                {themesQuery.data.map((t) => (
                  <option key={t.themeName} value={t.themeName}>
                    {t.themeName}
                  </option>
                ))}
              </select>
              {setGuildThemeMutation.isSuccess && (
                <span className="ml-3 text-sm text-emerald-400">Saved.</span>
              )}
            </div>
          )}

          <div className="border-t border-slate-800 pt-4">
            <Link
              to={`/admin/alliances/${allianceId}/notifications`}
              className="text-sm text-indigo-400 hover:text-indigo-300"
            >
              Notifications (server-wide) →
            </Link>
          </div>
        </div>
      )}
    </Layout>
  );
}
