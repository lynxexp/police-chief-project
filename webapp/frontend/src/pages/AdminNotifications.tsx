import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import {
  getAllianceGuild,
  getGuildNotifications,
  getVaultTrapSettings,
  type NotificationSummary,
} from "../api/client";
import { describeRepeatMinutes } from "../notifications/repeatInterval";
import { formatUtcAndLocal } from "../utils/time";
import { Badge, Card, EmptyState, ErrorState, LoadingState } from "../components/ui";

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
          <Link
            to={`/admin/alliances/${allianceId}/notifications/new`}
            className="inline-block rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            + New notification
          </Link>
        )
      }
    >
      {guildQuery.isLoading && <LoadingState />}
      {guildQuery.data && !guildId && (
        <p className="text-slate-400">This alliance has no linked Discord server.</p>
      )}

      {trapSettingsQuery.data && (
        <Card className="mb-6 text-sm text-slate-300">
          <div className="mb-2 font-medium text-slate-200">Vault Trap message settings</div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-slate-400">
            <span>
              Delete previous messages:{" "}
              <span className="text-slate-200">
                {trapSettingsQuery.data.deleteMessagesEnabled ? "Yes" : "No"}
              </span>
            </span>
            <span>
              Delete delay:{" "}
              <span className="text-slate-200">
                {trapSettingsQuery.data.defaultDeleteDelayMinutes} min
              </span>
            </span>
            <span>
              Show daily reset on schedule board:{" "}
              <span className="text-slate-200">
                {trapSettingsQuery.data.showDailyResetOnSchedule ? "Yes" : "No"}
              </span>
            </span>
          </div>
        </Card>
      )}

      {notificationsQuery.isLoading && <LoadingState label="Loading notifications…" />}
      {notificationsQuery.error && <ErrorState message="Couldn't load notifications." />}
      {notificationsQuery.data && notificationsQuery.data.length === 0 && (
        <EmptyState icon="🔔">No notifications configured for this server.</EmptyState>
      )}

      {notificationsQuery.data && notificationsQuery.data.length > 0 && (
        <>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by event type, description, or channel…"
            className="mb-3 w-full max-w-sm rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
          />
          <label className="mb-4 flex items-center gap-2 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={enabledOnly}
              onChange={(e) => setEnabledOnly(e.target.checked)}
              className="rounded border-slate-700 bg-slate-900"
            />
            Enabled only
          </label>
          {filteredNotifications.length === 0 && (
            <p className="mb-3 text-sm text-slate-500">No results match "{search}".</p>
          )}
          <div className="space-y-2">
          {filteredNotifications.map((n) => (
            <Link
              key={n.id}
              to={`/admin/alliances/${allianceId}/notifications/${n.id}`}
              className="block rounded-lg border border-slate-800 bg-slate-900 p-4 hover:border-slate-700"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-medium">
                  <span>{n.eventIcon}</span>
                  <span>{n.eventType ?? "Custom"}</span>
                  <span className="text-slate-500">
                    {String(n.hour).padStart(2, "0")}:{String(n.minute).padStart(2, "0")} ({n.timezone})
                  </span>
                </div>
                <Badge variant={n.isEnabled ? "success" : "neutral"}>
                  {n.isEnabled ? "Enabled" : "Disabled"}
                </Badge>
              </div>
              <div className="mt-1 text-sm text-slate-400">{descriptionPreview(n)}</div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                <span>#{n.channelName ?? n.channelId}</span>
                <span>{repeatLabel(n)}</span>
                <span>{mentionLabel(n.mentionType)}</span>
                {n.nextNotification && <span>Next: {formatUtcAndLocal(n.nextNotification)}</span>}
                {n.autoDisabledAt && (
                  <span className="text-amber-400">Auto-disabled {formatUtcAndLocal(n.autoDisabledAt)}</span>
                )}
              </div>
            </Link>
          ))}
          </div>
        </>
      )}
    </Layout>
  );
}
