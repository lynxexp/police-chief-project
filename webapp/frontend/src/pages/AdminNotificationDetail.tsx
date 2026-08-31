import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import {
  getAllianceGuild,
  getNotification,
  getNotificationHistory,
  updateNotification,
  setNotificationEnabled,
  deleteNotification,
  type NotificationDetail,
} from "../api/client";
import DiscordEmbedPreview, { defaultPlaceholderSample } from "../components/DiscordEmbedPreview";
import RepeatIntervalInput from "../components/RepeatIntervalInput";
import { describeRepeatMinutes } from "../notifications/repeatInterval";
import { formatUtcAndLocal } from "../utils/time";
import EmbedFieldsForm, {
  defaultEmbedDraft,
  embedDraftFromNotificationEmbed,
  embedDraftToInput,
  isEmbedDraftValid,
  type EmbedDraft,
} from "../components/EmbedFieldsForm";
import { Badge, Card, ErrorState, LoadingState, Pill, SectionHeading, Shield, buttonDanger, buttonPrimary, buttonSecondary } from "../components/ui";

const NOTIFICATION_TYPE_OFFSETS: Record<number, string> = {
  1: "30, 10, 5, 0 min before",
  2: "10, 5, 0 min before",
  3: "5, 0 min before",
  4: "5 min before",
  5: "At the time",
  6: "Custom times",
};

// Stage 7c/7d's edit form understands notificationType 1-5 and
// repeatMinutes 0/>0/-1 (weekday) -- matches the create form exactly.
// notificationType 6 and repeatMinutes -2 are custom-event-only.
const EDITABLE_NOTIFICATION_TYPES = [1, 2, 3, 4, 5] as const;

// notification_days stores Python .weekday() integers (Monday=0 ...
// Sunday=6) -- see backend's notifications/weekdays.ts.
const WEEKDAYS: { value: number; label: string }[] = [
  { value: 0, label: "Mon" },
  { value: 1, label: "Tue" },
  { value: 2, label: "Wed" },
  { value: 3, label: "Thu" },
  { value: 4, label: "Fri" },
  { value: 5, label: "Sat" },
  { value: 6, label: "Sun" },
];
const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function mentionLabel(mentionType: string): string {
  if (mentionType === "none") return "No mention";
  if (mentionType === "everyone") return "@everyone";
  if (mentionType.startsWith("role_")) return `Role ${mentionType.slice("role_".length)}`;
  if (mentionType.startsWith("member_")) return `Member ${mentionType.slice("member_".length)}`;
  return mentionType;
}

function repeatDescription(n: NotificationDetail): string {
  if (!n.repeatEnabled) return "One-time -- disables itself after firing.";
  if (n.repeatMinutes === null || n.repeatMinutes === 0) return "Re-arms for the same time tomorrow.";
  if (n.repeatMinutes === -1) {
    const names = n.weekdays.map((d) => WEEKDAY_NAMES[d] ?? `Day ${d}`);
    return `Repeats on: ${names.join(", ") || "(none set)"}`;
  }
  if (n.repeatMinutes === -2) {
    return n.customEvent
      ? `Follows custom event "${n.customEvent.name}" (${n.customEvent.recurrenceType}, every ${n.customEvent.recurrenceInterval})`
      : "Follows a custom event (details unavailable).";
  }
  if (n.repeatMinutes > 0) return `Repeats every ${describeRepeatMinutes(n.repeatMinutes)}.`;
  return "Unknown repeat configuration.";
}

const HISTORY_PAGE_SIZE = 25;

type RepeatMode = "none" | "minutes" | "weekdays";
type MessageKind = "plain" | "embed";

interface EditDraft {
  hour: number;
  minute: number;
  timezone: string;
  messageKind: MessageKind;
  description: string;
  embed: EmbedDraft;
  notificationType: number;
  mentionKind: "none" | "everyone" | "role" | "member";
  mentionId: string;
  repeatMode: RepeatMode;
  repeatMinutes: number;
  weekdays: number[];
  eventType: string;
}

function draftFromNotification(n: NotificationDetail): EditDraft {
  let mentionKind: EditDraft["mentionKind"] = "none";
  let mentionId = "";
  if (n.mentionType === "everyone") mentionKind = "everyone";
  else if (n.mentionType.startsWith("role_")) {
    mentionKind = "role";
    mentionId = n.mentionType.slice("role_".length);
  } else if (n.mentionType.startsWith("member_")) {
    mentionKind = "member";
    mentionId = n.mentionType.slice("member_".length);
  }
  const repeatMode: RepeatMode = n.repeatMinutes === -1 ? "weekdays" : (n.repeatMinutes ?? 0) > 0 ? "minutes" : "none";
  const messageKind: MessageKind = n.descriptionKind === "embed" ? "embed" : "plain";
  return {
    hour: n.hour,
    minute: n.minute,
    timezone: n.timezone,
    messageKind,
    description: n.descriptionKind === "plain" ? n.descriptionText : "",
    embed: messageKind === "embed" ? embedDraftFromNotificationEmbed(n.embed) : defaultEmbedDraft(),
    notificationType: EDITABLE_NOTIFICATION_TYPES.includes(n.notificationType as 1 | 2 | 3 | 4 | 5) ? n.notificationType : 3,
    mentionKind,
    mentionId,
    repeatMode,
    repeatMinutes: repeatMode === "minutes" ? n.repeatMinutes! : 60,
    weekdays: repeatMode === "weekdays" ? n.weekdays : [],
    eventType: n.eventType ?? "",
  };
}

function Fact({ label, tone, children }: { label: string; tone?: "gold"; children: React.ReactNode }) {
  return (
    <div>
      <dt className={`font-mono text-[10px] tracking-eyebrow uppercase ${tone === "gold" ? "text-gold-ink" : "text-ink-faint"}`}>{label}</dt>
      <dd className={`mt-0.5 ${tone === "gold" ? "text-gold-ink" : "text-ink-secondary"}`}>{children}</dd>
    </div>
  );
}

const fieldClass = "mt-1 w-full rounded-control border border-line bg-surface-sunken px-3 py-1.5 text-sm text-ink";

export default function AdminNotificationDetail() {
  const { allianceId: allianceIdParam, id: idParam } = useParams<{ allianceId: string; id: string }>();
  const allianceId = Number(allianceIdParam);
  const id = Number(idParam);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const guildQuery = useQuery({
    queryKey: ["admin-alliance-guild", allianceId],
    queryFn: () => getAllianceGuild(allianceId),
  });
  const guildId = guildQuery.data?.guildId ?? null;

  const notificationQuery = useQuery({
    queryKey: ["admin-guild-notification", guildId, id],
    queryFn: () => getNotification(guildId!, id),
    enabled: !!guildId,
  });

  const historyQuery = useQuery({
    queryKey: ["admin-guild-notification-history", guildId, id, historyOffset],
    queryFn: () => getNotificationHistory(guildId!, id, { limit: HISTORY_PAGE_SIZE, offset: historyOffset }),
    enabled: !!guildId,
  });

  const n = notificationQuery.data;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-guild-notification", guildId, id] });

  const saveMutation = useMutation({
    mutationFn: () => {
      const mentionType =
        draft!.mentionKind === "role" ? `role_${draft!.mentionId}` : draft!.mentionKind === "member" ? `member_${draft!.mentionId}` : draft!.mentionKind;
      return updateNotification(guildId!, id, {
        hour: draft!.hour,
        minute: draft!.minute,
        timezone: draft!.timezone,
        messageKind: draft!.messageKind,
        description: draft!.messageKind === "plain" ? draft!.description : undefined,
        embed: draft!.messageKind === "embed" ? embedDraftToInput(draft!.embed) : undefined,
        notificationType: draft!.notificationType,
        mentionType,
        repeatMinutes: draft!.repeatMode === "minutes" ? draft!.repeatMinutes : draft!.repeatMode === "weekdays" ? -1 : 0,
        weekdays: draft!.repeatMode === "weekdays" ? draft!.weekdays : undefined,
        eventType: draft!.eventType.trim() || null,
      });
    },
    onSuccess: () => {
      invalidate();
      setEditing(false);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: () => setNotificationEnabled(guildId!, id, !n!.isEnabled),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteNotification(guildId!, id),
    onSuccess: () => navigate(`/admin/alliances/${allianceId}/notifications`),
  });

  useEffect(() => {
    if (n && !editing) setDraft(draftFromNotification(n));
  }, [n, editing]);

  const needsDowngradeWarning = n && (n.descriptionKind === "customTimes" || n.repeatMinutes === -2);

  return (
    <Layout title="Notification detail" backTo={{ to: `/admin/alliances/${allianceId}/notifications`, label: "Notifications" }}>
      {notificationQuery.isLoading && <LoadingState />}
      {notificationQuery.error && <ErrorState message="Couldn't load this notification." onRetry={notificationQuery.refetch} />}

      {n && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setDraft(draftFromNotification(n));
                setEditing((v) => !v);
              }}
              className={buttonSecondary}
            >
              {editing ? "Cancel edit" : "Edit"}
            </button>
            <button onClick={() => toggleMutation.mutate()} disabled={toggleMutation.isPending} className={buttonSecondary}>
              {n.isEnabled ? "Disable" : "Enable"}
            </button>
            <button
              onClick={() => {
                if (confirm("Delete this notification? This cannot be undone.")) deleteMutation.mutate();
              }}
              disabled={deleteMutation.isPending}
              className={buttonDanger}
            >
              Delete
            </button>
          </div>

          {editing && draft && (
            <Card className="border-gold-border">
              <SectionHeading>Edit notification</SectionHeading>
              {needsDowngradeWarning && (
                <div className="mb-3 flex items-start gap-2.5 rounded-control border border-gold-border bg-gold-tint px-3 py-2.5">
                  <Shield size={32} tone="gold">
                    !
                  </Shield>
                  <p className="text-xs text-ink-secondary">
                    This notification uses a repeat mode or message type this editor doesn't support (a custom-event
                    link or custom times). Saving here will convert it to a plain notification and drop that
                    configuration -- edit the linked custom event instead if this was created that way.
                  </p>
                </div>
              )}
              <div className="flex flex-col gap-3">
                <label className="block">
                  <span className="text-xs text-ink-muted">Event name (optional)</span>
                  <input value={draft.eventType} onChange={(e) => setDraft({ ...draft, eventType: e.target.value })} className={fieldClass} />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs text-ink-muted">Hour (0-23)</span>
                    <input type="number" min={0} max={23} value={draft.hour} onChange={(e) => setDraft({ ...draft, hour: Number(e.target.value) })} className={fieldClass} />
                  </label>
                  <label className="block">
                    <span className="text-xs text-ink-muted">Minute (0-59)</span>
                    <input type="number" min={0} max={59} value={draft.minute} onChange={(e) => setDraft({ ...draft, minute: Number(e.target.value) })} className={fieldClass} />
                  </label>
                </div>
                <label className="block">
                  <span className="text-xs text-ink-muted">Timezone</span>
                  <input value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} className={fieldClass} />
                </label>
                <div>
                  <span className="mb-1.5 block text-xs text-ink-muted">Reminder offsets</span>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(NOTIFICATION_TYPE_OFFSETS)
                      .filter(([v]) => EDITABLE_NOTIFICATION_TYPES.includes(Number(v) as 1 | 2 | 3 | 4 | 5))
                      .map(([v, label]) => (
                        <Pill key={v} active={draft.notificationType === Number(v)} onClick={() => setDraft({ ...draft, notificationType: Number(v) })}>
                          {label}
                        </Pill>
                      ))}
                  </div>
                </div>
                <div>
                  <span className="mb-1 block text-xs text-ink-muted">Mention</span>
                  <div className="flex gap-2">
                    <select
                      value={draft.mentionKind}
                      onChange={(e) => setDraft({ ...draft, mentionKind: e.target.value as EditDraft["mentionKind"] })}
                      className={`${fieldClass} mt-0 max-w-[10rem]`}
                    >
                      <option value="none">No mention</option>
                      <option value="everyone">@everyone</option>
                      <option value="role">Role</option>
                      <option value="member">Member</option>
                    </select>
                    {(draft.mentionKind === "role" || draft.mentionKind === "member") && (
                      <input
                        value={draft.mentionId}
                        onChange={(e) => setDraft({ ...draft, mentionId: e.target.value })}
                        placeholder={draft.mentionKind === "role" ? "Role ID" : "Member ID"}
                        className={`${fieldClass} mt-0 flex-1`}
                      />
                    )}
                  </div>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs text-ink-muted">Repeat</span>
                  <div className="flex gap-1.5">
                    <Pill active={draft.repeatMode === "none"} onClick={() => setDraft({ ...draft, repeatMode: "none" })}>
                      One-time
                    </Pill>
                    <Pill active={draft.repeatMode === "minutes"} onClick={() => setDraft({ ...draft, repeatMode: "minutes" })}>
                      Custom interval
                    </Pill>
                    <Pill active={draft.repeatMode === "weekdays"} onClick={() => setDraft({ ...draft, repeatMode: "weekdays" })}>
                      Specific weekdays
                    </Pill>
                  </div>
                  {draft.repeatMode === "minutes" && (
                    <RepeatIntervalInput totalMinutes={draft.repeatMinutes} onChange={(minutes) => setDraft({ ...draft, repeatMinutes: minutes })} />
                  )}
                  {draft.repeatMode === "weekdays" && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {WEEKDAYS.map((d) => (
                        <Pill
                          key={d.value}
                          active={draft.weekdays.includes(d.value)}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              weekdays: draft.weekdays.includes(d.value) ? draft.weekdays.filter((x) => x !== d.value) : [...draft.weekdays, d.value],
                            })
                          }
                        >
                          {d.label}
                        </Pill>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <span className="mb-1.5 block text-xs text-ink-muted">Message type</span>
                  <div className="flex gap-1.5">
                    <Pill active={draft.messageKind === "plain"} onClick={() => setDraft({ ...draft, messageKind: "plain" })}>
                      Plain text
                    </Pill>
                    <Pill active={draft.messageKind === "embed"} onClick={() => setDraft({ ...draft, messageKind: "embed" })}>
                      Embed
                    </Pill>
                  </div>
                </div>
                {draft.messageKind === "plain" ? (
                  <label className="block">
                    <span className="text-xs text-ink-muted">Message</span>
                    <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={4} className={fieldClass} />
                  </label>
                ) : (
                  <EmbedFieldsForm
                    draft={draft.embed}
                    onChange={(embed) => setDraft({ ...draft, embed })}
                    sample={defaultPlaceholderSample({
                      eventName: draft.eventType.trim() || "Event",
                      eventTime: `${String(draft.hour).padStart(2, "0")}:${String(draft.minute).padStart(2, "0")}`,
                    })}
                  />
                )}
                <div>
                  <button
                    onClick={() => saveMutation.mutate()}
                    disabled={
                      saveMutation.isPending ||
                      !draft.timezone.trim() ||
                      (draft.messageKind === "plain" ? !draft.description.trim() : !isEmbedDraftValid(draft.embed)) ||
                      (draft.repeatMode === "weekdays" && draft.weekdays.length === 0) ||
                      (draft.repeatMode === "minutes" && draft.repeatMinutes <= 0)
                    }
                    className={buttonPrimary}
                  >
                    Save changes
                  </button>
                  {saveMutation.isError && <p className="mt-1.5 text-sm text-down-ink">{(saveMutation.error as Error).message}</p>}
                </div>
              </div>
            </Card>
          )}

          <div className="overflow-hidden rounded-card border border-gold-border">
            <div className="flex items-center justify-between bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] px-4 py-2 font-sans text-sm font-semibold text-on-gold">
              <span>{n.eventType ?? "Custom"}</span>
              <Badge variant={n.isEnabled ? "success" : "neutral"}>{n.isEnabled ? "Enabled" : "Disabled"}</Badge>
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 bg-surface-panel p-4 text-sm sm:grid-cols-2">
              <Fact label="Time">
                {String(n.hour).padStart(2, "0")}:{String(n.minute).padStart(2, "0")} ({n.timezone})
              </Fact>
              <Fact label="Channel">#{n.channelName ?? n.channelId}</Fact>
              <Fact label="Reminder offsets">{NOTIFICATION_TYPE_OFFSETS[n.notificationType] ?? `Type ${n.notificationType}`}</Fact>
              <Fact label="Mention">{mentionLabel(n.mentionType)}</Fact>
              <div className="sm:col-span-2">
                <Fact label="Repeat">{repeatDescription(n)}</Fact>
              </div>
              <Fact label="Next fire">{formatUtcAndLocal(n.nextNotification)}</Fact>
              <Fact label="Last fired">{formatUtcAndLocal(n.lastNotification)}</Fact>
              {n.autoDisabledAt && (
                <div className="sm:col-span-2">
                  <Fact label="Auto-disabled" tone="gold">
                    {formatUtcAndLocal(n.autoDisabledAt)}
                  </Fact>
                </div>
              )}
              <Fact label="Created by">{n.createdBy}</Fact>
              <Fact label="Created at">{n.createdAt ? new Date(n.createdAt).toLocaleString() : "—"}</Fact>
            </dl>
          </div>

          <Card>
            <SectionHeading>Message</SectionHeading>
            {n.descriptionKind === "embed" && n.embed ? (
              <DiscordEmbedPreview embed={n.embed} applyPlaceholders={false} />
            ) : (
              <p className="whitespace-pre-wrap text-sm text-ink-secondary">{n.descriptionText || "(empty)"}</p>
            )}
            {n.customTimes && <p className="mt-2 font-mono text-xs text-ink-faint">Custom times: {n.customTimes.join(", ")} min before</p>}
          </Card>

          <Card>
            <SectionHeading>Sent history</SectionHeading>
            {historyQuery.isLoading && <LoadingState />}
            {historyQuery.error && <ErrorState message="Couldn't load history." onRetry={historyQuery.refetch} />}
            {historyQuery.data && historyQuery.data.rows.length === 0 && <p className="text-sm text-ink-muted">No sends recorded yet.</p>}
            {historyQuery.data && historyQuery.data.rows.length > 0 && (
              <div className="flex flex-col gap-3">
                <div className="overflow-x-auto rounded-card border border-line">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="bg-surface-header font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                        <th className="px-3 py-2 font-medium">Sent at</th>
                        <th className="px-3 py-2 font-medium">Offset</th>
                        <th className="px-3 py-2 font-medium">Deleted</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-hairline">
                      {historyQuery.data.rows.map((h, i) => (
                        <tr key={h.id} className={i % 2 === 1 ? "bg-surface-panel-alt" : undefined}>
                          <td className="px-3 py-2 font-mono text-ink-secondary">{formatUtcAndLocal(h.sentAt)}</td>
                          <td className="px-3 py-2 font-mono text-ink-secondary">{h.notificationTime} min before</td>
                          <td className="px-3 py-2 font-mono text-ink-secondary">{formatUtcAndLocal(h.deletedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={() => setHistoryOffset(Math.max(0, historyOffset - HISTORY_PAGE_SIZE))} disabled={historyOffset === 0} className={buttonSecondary}>
                    Newer
                  </button>
                  <button onClick={() => setHistoryOffset(historyOffset + HISTORY_PAGE_SIZE)} disabled={!historyQuery.data.hasMore} className={buttonSecondary}>
                    Older
                  </button>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}
    </Layout>
  );
}
