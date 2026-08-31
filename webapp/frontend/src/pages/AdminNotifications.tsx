import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Search } from "lucide-react";
import Layout from "../components/Layout";
import {
  getAllianceGuild,
  getGuildNotifications,
  getVaultTrapSettings,
  type NotificationSummary,
} from "../api/client";
import { describeRepeatMinutes } from "../notifications/repeatInterval";
import { formatUtcAndLocal } from "../utils/time";
import { Badge, Card, EmptyState, ErrorState, LoadingRows, buttonPrimary } from "../components/ui";

/** repeat_minutes is a discriminated sentinel, not a plain interval --
 * see the plan doc / backend's VaultNotificationTable doc comment. */
function repeatLabel(n: NotificationSummary): string {
  if (!n.repeatEnabled) return "One-time";
  if (n.repeatMinutes === null || n.repeatMinutes === 0) return "Daily (re-arms same time)";
  if (n.repeatMinutes === -1) return "Specific weekdays";
  if (n.repeatMinutes === -2) return "Custom event (monthly)";
  if (n.repeatMinutes > 0) return `Every ${describeRepeatMinutes(n.repeatMinutes)}`;
  return "Unknown";
}

function mentionLabel(mentionType: string): string {
  if (mentionType === "none") return "No mention";
  if (mentionType === "everyone") return "@everyone";
  if (mentionType.startsWith("role_")) return `Role ${mentionType.slice("role_".length)}`;
  if (mentionType.startsWith("member_")) return `Member ${mentionType.slice("member_".length)}`;
  return mentionType;
}

function descriptionPreview(n: NotificationSummary): string {
  if (n.descriptionKind === "embed") return "(Embed notification)";
  const text = n.descriptionText;
  return text.length > 60 ? `${text.slice(0, 60)}...` : text;
}

export default function AdminNotifications() {
  const { allianceId: allianceIdParam } = useParams<{ allianceId: string }>();
  const allianceId = Number(allianceIdParam);

  const guildQuery = useQuery({
    queryKey: ["admin-alliance-guild", allianceId],
    queryFn: () => getAllianceGuild(allianceId),
  });
  const guildId = guildQuery.data?.guildId ?? null;

  const notificationsQuery = useQuery({
    queryKey: ["admin-guild-notifications", guildId],
    queryFn: () => getGuildNotifications(guildId!),
    enabled: !!guildId,
  });
  const trapSettingsQuery = useQuery({
    queryKey: ["admin-guild-vault-trap-settings", guildId],
    queryFn: () => getVaultTrapSettings(guildId!),
    enabled: !!guildId,
  });

  const [search, setSearch] = useState("");
  const [enabledOnly, setEnabledOnly] = useState(false);

  const filteredNotifications = (notificationsQuery.data ?? []).filter((n) => {
    if (enabledOnly && !n.isEnabled) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      (n.eventType?.toLowerCase().includes(q) ?? false) ||
      n.descriptionText.toLowerCase().includes(q) ||
      (n.channelName?.toLowerCase().includes(q) ?? false)
    );
  });

  return (
    <Layout
      title="Notifications"
      backTo={{ to: `/admin/alliances/${allianceId}/settings`, label: "Channel setup" }}
      actions={
        guildId && (
          <Link to={`/admin/alliances/${allianceId}/notifications/new`} className={buttonPrimary}>
            + New notification
          </Link>
        )
      }
    >
      {guildQuery.isLoading && <LoadingRows rows={3} />}
      {guildQuery.data && !guildId && <p className="text-sm text-ink-muted">This alliance has no linked Discord server.</p>}

      {trapSettingsQuery.data && (
        <Card>
          <p className="mb-2 font-display text-[15px] font-semibold tracking-heading text-ink uppercase">Vault Trap message settings</p>
          <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-ink-muted">
            <span>Delete previous: <span className="text-ink-secondary">{trapSettingsQuery.data.deleteMessagesEnabled ? "Yes" : "No"}</span></span>
            <span>Delete delay: <span className="text-ink-secondary">{trapSettingsQuery.data.defaultDeleteDelayMinutes} min</span></span>
            <span>Daily reset on board: <span className="text-ink-secondary">{trapSettingsQuery.data.showDailyResetOnSchedule ? "Yes" : "No"}</span></span>
          </div>
        </Card>
      )}

      {notificationsQuery.isLoading && <LoadingRows rows={5} />}
      {notificationsQuery.error && <ErrorState message="Couldn't load notifications." onRetry={notificationsQuery.refetch} />}
      {notificationsQuery.data && notificationsQuery.data.length === 0 && <EmptyState>No notifications configured for this server.</EmptyState>}

      {notificationsQuery.data && notificationsQuery.data.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative max-w-sm flex-1">
              <Search size={16} strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by event type, description, or channel…"
                className="w-full rounded-control border border-line bg-surface-sunken py-2 pr-3 pl-9 text-sm text-ink"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-secondary">
              <input type="checkbox" checked={enabledOnly} onChange={(e) => setEnabledOnly(e.target.checked)} className="rounded border-line bg-surface-sunken" />
              Enabled only
            </label>
          </div>
          {filteredNotifications.length === 0 && <p className="text-sm text-ink-muted">No results match "{search}".</p>}

          <div className="flex flex-col gap-2">
            {filteredNotifications.map((n) => (
              <Link
                key={n.id}
                to={`/admin/alliances/${allianceId}/notifications/${n.id}`}
                className={`block rounded-card border border-line bg-surface-panel p-4 hover:border-line-strong ${n.autoDisabledAt ? "opacity-65" : ""}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-sans text-sm font-semibold text-ink">
                    <span aria-hidden="true">{n.eventIcon}</span>
                    <span>{n.eventType ?? "Custom"}</span>
                    <span className="font-mono text-xs text-ink-muted">
                      {String(n.hour).padStart(2, "0")}:{String(n.minute).padStart(2, "0")} ({n.timezone})
                    </span>
                    {n.customEventId !== null && <Badge variant="info">FROM CUSTOM EVENT</Badge>}
                  </div>
                  <Badge variant={n.isEnabled ? "success" : "neutral"}>{n.isEnabled ? "Enabled" : "Disabled"}</Badge>
                </div>
                <p className="mt-1 text-sm text-ink-secondary">{descriptionPreview(n)}</p>
                {n.customEventId !== null && <p className="mt-0.5 text-xs text-info-ink">Edit through Custom events</p>}
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-ink-faint">
                  <span>#{n.channelName ?? n.channelId}</span>
                  <span>{repeatLabel(n)}</span>
                  <span>{mentionLabel(n.mentionType)}</span>
                  {n.nextNotification && <span>Next: {formatUtcAndLocal(n.nextNotification)}</span>}
                  {n.autoDisabledAt && <span className="text-gold-ink">Auto-disabled {formatUtcAndLocal(n.autoDisabledAt)}</span>}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </Layout>
  );
}
