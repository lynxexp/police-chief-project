import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { X } from "lucide-react";
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
import { Card, ErrorState, LoadingState, Toggle, buttonPrimary, buttonSecondary } from "../components/ui";

const FIELDS: { key: keyof AllianceSettings; label: string }[] = [
  { key: "channelId", label: "Main channel" },
  { key: "redemptionChannelId", label: "Gift redemption channel" },
  { key: "vaultScoreChannel", label: "Vault Trap score channel" },
  { key: "capitolScoreChannel", label: "Capitol War score channel" },
];

function ChannelSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  options: { id: string; name: string }[];
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-ink-secondary">{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full rounded-control border border-line bg-surface-sunken px-3 py-2 text-sm text-ink"
      >
        <option value="" className="text-ink-disabled">
          Not set
        </option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            #{c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function SavedTag({ show }: { show: boolean }) {
  if (!show) return null;
  return <span className="ml-3 font-mono text-xs text-up-ink">SAVED</span>;
}

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-alliance-settings", allianceId] }),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-alliance-gift-channel", allianceId] }),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-alliance-id-channels", allianceId] }),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-guild-scan-settings", guildId] }),
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
    <Layout title="Channel setup" backTo={{ to: `/admin/alliances/${allianceId}/members`, label: "Members" }}>
      {(settingsQuery.isLoading || channelsQuery.isLoading) && <LoadingState />}
      {(settingsQuery.error || channelsQuery.error) && (
        <ErrorState message="Couldn't load channel settings." onRetry={() => { settingsQuery.refetch(); channelsQuery.refetch(); }} />
      )}

      {draft && channelsQuery.data && (
        <div className="flex max-w-xl flex-col gap-4">
          {/* Panel 1: Alliance channels */}
          <Card>
            <p className="mb-1 font-display text-[17px] font-semibold tracking-heading text-ink uppercase">Alliance channels</p>
            <p className="mb-4 text-xs text-ink-faint">Saves these four together.</p>
            <div className="flex flex-col gap-3">
              {FIELDS.map(({ key, label }) => (
                <ChannelSelect
                  key={key}
                  label={label}
                  value={draft[key]}
                  onChange={(v) => setDraft({ ...draft, [key]: v })}
                  options={channelsQuery.data!}
                />
              ))}
            </div>
            <div className="mt-4 flex items-center">
              <button onClick={() => saveMutation.mutate(draft)} disabled={saveMutation.isPending} className={buttonPrimary}>
                Save
              </button>
              <SavedTag show={saveMutation.isSuccess} />
              {saveMutation.isError && <span className="ml-3 text-xs text-down-ink">Couldn't save.</span>}
            </div>
          </Card>

          {/* Panel 2: Gift code announcements */}
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <p className="font-display text-[17px] font-semibold tracking-heading text-ink uppercase">Gift code announcements</p>
              <span className="font-mono text-[10px] tracking-pill text-gold-ink uppercase">Separate setting</span>
            </div>
            <ChannelSelect label="Announcement channel" value={giftChannelDraft} onChange={setGiftChannelDraft} options={channelsQuery.data} />
            <div className="mt-4 flex items-center">
              <button onClick={() => saveGiftChannelMutation.mutate(giftChannelDraft)} disabled={saveGiftChannelMutation.isPending} className={buttonPrimary}>
                Save
              </button>
              <SavedTag show={saveGiftChannelMutation.isSuccess} />
            </div>
          </Card>

          {/* Panel 3: ID channels & scanning */}
          <Card>
            <p className="mb-1 font-display text-[17px] font-semibold tracking-heading text-ink uppercase">ID channels &amp; scanning</p>
            <p className="mb-4 font-mono text-[11px] font-semibold text-down-ink uppercase">Server-wide — affects all alliances</p>

            {idChannelsQuery.data && idChannelsQuery.data.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {idChannelsQuery.data.map((c) => {
                  const channel = channelsQuery.data!.find((ch) => ch.id === c.channelId);
                  return (
                    <span key={c.channelId} className="flex items-center gap-1.5 rounded-pill border border-line-strong px-2.5 py-1 font-mono text-xs text-ink-secondary">
                      #{channel?.name ?? c.channelId}
                      <button
                        onClick={() => removeIdChannelMutation.mutate(c.channelId)}
                        disabled={removeIdChannelMutation.isPending}
                        aria-label={`Remove #${channel?.name ?? c.channelId}`}
                        className="text-ink-faint hover:text-down-ink"
                      >
                        <X size={12} strokeWidth={2} aria-hidden="true" />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            <div className="flex gap-2">
              <select
                value={newIdChannel}
                onChange={(e) => setNewIdChannel(e.target.value)}
                className="flex-1 rounded-control border border-dashed border-line-strong bg-surface-sunken px-3 py-2 text-sm text-ink"
              >
                <option value="">+ add channel</option>
                {channelsQuery.data
                  .filter((c) => !idChannelsQuery.data?.some((ic) => ic.channelId === c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
              </select>
              <button onClick={() => addIdChannelMutation.mutate(newIdChannel)} disabled={!newIdChannel || addIdChannelMutation.isPending} className={buttonSecondary}>
                Add
              </button>
            </div>

            {scanDraft && (
              <div className="mt-4 flex flex-col gap-3 border-t border-line-hairline pt-4">
                <label className="flex items-center justify-between">
                  <span className="text-sm text-ink-secondary">Scan enabled</span>
                  <Toggle checked={scanDraft.scanEnabled} onChange={(v) => setScanDraft({ ...scanDraft, scanEnabled: v })} label="Scan enabled" />
                </label>
                <label className="flex items-center justify-between">
                  <span className="text-sm text-ink-secondary">Respond to invalid IDs</span>
                  <Toggle checked={scanDraft.respondToInvalid} onChange={(v) => setScanDraft({ ...scanDraft, respondToInvalid: v })} label="Respond to invalid IDs" />
                </label>
                <label className="flex items-center justify-between gap-3">
                  <span className="text-sm text-ink-secondary">Scan limit</span>
                  <input
                    type="number"
                    min={1}
                    value={scanDraft.scanLimit}
                    onChange={(e) => setScanDraft({ ...scanDraft, scanLimit: Number(e.target.value) })}
                    className="w-24 rounded-control border border-line bg-surface-sunken px-2 py-1.5 text-sm text-ink"
                  />
                </label>
                <label className="flex items-center justify-between gap-3">
                  <span className="text-sm text-ink-secondary">Delete after (s)</span>
                  <input
                    type="number"
                    min={0}
                    value={scanDraft.deleteAfter}
                    onChange={(e) => setScanDraft({ ...scanDraft, deleteAfter: Number(e.target.value) })}
                    className="w-24 rounded-control border border-line bg-surface-sunken px-2 py-1.5 text-sm text-ink"
                  />
                </label>
                <div className="flex items-center">
                  <button onClick={() => saveScanSettingsMutation.mutate(scanDraft)} disabled={saveScanSettingsMutation.isPending} className={buttonPrimary}>
                    Save
                  </button>
                  <SavedTag show={saveScanSettingsMutation.isSuccess} />
                </div>
              </div>
            )}
          </Card>

          {/* Panel 4: Theme */}
          {guildThemeQuery.data && themesQuery.data && (
            <Card>
              <div className="mb-4 flex items-center justify-between">
                <p className="font-display text-[17px] font-semibold tracking-heading text-ink uppercase">Theme</p>
                <Link to="/admin/themes" className="font-sans text-sm text-gold-ink hover:text-text">
                  Manage themes
                </Link>
              </div>
              <label className="block">
                <select
                  value={guildThemeQuery.data.themeName ?? ""}
                  onChange={(e) => setGuildThemeMutation.mutate(e.target.value || null)}
                  disabled={setGuildThemeMutation.isPending}
                  className="w-full rounded-control border border-line bg-surface-sunken px-3 py-2 text-sm text-ink"
                >
                  <option value="">Use global default</option>
                  {themesQuery.data.map((t) => (
                    <option key={t.themeName} value={t.themeName}>
                      {t.themeName}
                    </option>
                  ))}
                </select>
              </label>
              <SavedTag show={setGuildThemeMutation.isSuccess} />
            </Card>
          )}
        </div>
      )}
    </Layout>
  );
}
