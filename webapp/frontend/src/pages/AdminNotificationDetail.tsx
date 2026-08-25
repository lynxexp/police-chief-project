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
import EmbedFieldsForm, {
  defaultEmbedDraft,
  embedDraftFromNotificationEmbed,
  embedDraftToInput,
  isEmbedDraftValid,
  type EmbedDraft,
} from "../components/EmbedFieldsForm";

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
  const repeatMode: RepeatMode =
    n.repeatMinutes === -1 ? "weekdays" : (n.repeatMinutes ?? 0) > 0 ? "minutes" : "none";
  const messageKind: MessageKind = n.descriptionKind === "embed" ? "embed" : "plain";
  return {
    hour: n.hour,
    minute: n.minute,
    timezone: n.timezone,
    messageKind,
    description: n.descriptionKind === "plain" ? n.descriptionText : "",
    embed: messageKind === "embed" ? embedDraftFromNotificationEmbed(n.embed) : defaultEmbedDraft(),
    notificationType: EDITABLE_NOTIFICATION_TYPES.includes(n.notificationType as 1 | 2 | 3 | 4 | 5)
      ? n.notificationType
      : 3,
    mentionKind,
    mentionId,
    repeatMode,
    repeatMinutes: repeatMode === "minutes" ? n.repeatMinutes! : 60,
    weekdays: repeatMode === "weekdays" ? n.weekdays : [],
    eventType: n.eventType ?? "",
  };
}

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
        draft!.mentionKind === "role"
          ? `role_${draft!.mentionId}`
          : draft!.mentionKind === "member"
            ? `member_${draft!.mentionId}`
            : draft!.mentionKind;
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
    <Layout
      title="Notification detail"
      backTo={{ to: `/admin/alliances/${allianceId}/notifications`, label: "Notifications" }}
    >
      {notificationQuery.isLoading && <p className="text-slate-400">Loading…</p>}
      {notificationQuery.error && <p className="text-red-400">Couldn't load this notification.</p>}

      {n && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setDraft(draftFromNotification(n));
                setEditing((v) => !v);
              }}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
            >
              {editing ? "Cancel edit" : "Edit"}
            </button>
            <button
              onClick={() => toggleMutation.mutate()}
              disabled={toggleMutation.isPending}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
            >
              {n.isEnabled ? "Disable" : "Enable"}
            </button>
            <button
              onClick={() => {
                if (confirm("Delete this notification? This cannot be undone.")) deleteMutation.mutate();
              }}
              disabled={deleteMutation.isPending}
              className="rounded-md border border-red-900 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950 disabled:opacity-50"
            >
              Delete
            </button>
          </div>

          {editing && draft && (
            <div className="rounded-lg border border-indigo-900 bg-slate-900 p-4">
              <div className="mb-3 font-medium text-slate-200">Edit notification</div>
              {needsDowngradeWarning && (
                <p className="mb-3 rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
                  This notification uses a repeat mode or message type this editor doesn't support (a
                  custom-event link or custom times). Saving here will convert it to a plain notification
                  and drop that configuration -- edit the linked custom event instead if this was created
                  that way.
                </p>
              )}
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Event name (optional)</label>
                  <input
                    value={draft.eventType}
                    onChange={(e) => setDraft({ ...draft, eventType: e.target.value })}
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">Hour (0-23)</label>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={draft.hour}
                      onChange={(e) => setDraft({ ...draft, hour: Number(e.target.value) })}
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">Minute (0-59)</label>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={draft.minute}
                      onChange={(e) => setDraft({ ...draft, minute: Number(e.target.value) })}
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Timezone</label>
                  <input
                    value={draft.timezone}
                    onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Reminder offsets</label>
                  <select
                    value={draft.notificationType}
                    onChange={(e) => setDraft({ ...draft, notificationType: Number(e.target.value) })}
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
                  >
                    {Object.entries(NOTIFICATION_TYPE_OFFSETS)
                      .filter(([v]) => EDITABLE_NOTIFICATION_TYPES.includes(Number(v) as 1 | 2 | 3 | 4 | 5))
                      .map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Mention</label>
                  <div className="flex gap-2">
                    <select
                      value={draft.mentionKind}
                      onChange={(e) => setDraft({ ...draft, mentionKind: e.target.value as EditDraft["mentionKind"] })}
                      className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
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
                        className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
                      />
                    )}
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Repeat</label>
                  <select
                    value={draft.repeatMode}
                    onChange={(e) => setDraft({ ...draft, repeatMode: e.target.value as RepeatMode })}
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
                  >
                    <option value="none">One-time</option>
                    <option value="minutes">Custom interval</option>
                    <option value="weekdays">Specific weekdays</option>
                  </select>
                  {draft.repeatMode === "minutes" && (
                    <RepeatIntervalInput
                      totalMinutes={draft.repeatMinutes}
                      onChange={(minutes) => setDraft({ ...draft, repeatMinutes: minutes })}
                    />
                  )}
                  {draft.repeatMode === "weekdays" && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {WEEKDAYS.map((d) => (
                        <button
                          key={d.value}
                          type="button"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              weekdays: draft.weekdays.includes(d.value)
                                ? draft.weekdays.filter((x) => x !== d.value)
                                : [...draft.weekdays, d.value],
                            })
                          }
                          className={`rounded-md border px-2.5 py-1 text-xs ${
                            draft.weekdays.includes(d.value)
                              ? "border-indigo-500 bg-indigo-600 text-white"
                              : "border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800"
                          }`}
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Message type</label>
                  <select
                    value={draft.messageKind}
                    onChange={(e) => setDraft({ ...draft, messageKind: e.target.value as MessageKind })}
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
                  >
                    <option value="plain">Plain text</option>
                    <option value="embed">Embed</option>
                  </select>
                </div>
                {draft.messageKind === "plain" ? (
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">Message</label>
                    <textarea
                      value={draft.description}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                      rows={4}
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
                    />
                  </div>
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
                <button
                  onClick={() => saveMutation.mutate()}
                  disabled={
                    saveMutation.isPending ||
                    !draft.timezone.trim() ||
                    (draft.messageKind === "plain" ? !draft.description.trim() : !isEmbedDraftValid(draft.embed)) ||
                    (draft.repeatMode === "weekdays" && draft.weekdays.length === 0) ||
                    (draft.repeatMode === "minutes" && draft.repeatMinutes <= 0)
                  }
                  className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  Save changes
                </button>
                {saveMutation.isError && (
                  <p className="text-sm text-red-400">{(saveMutation.error as Error).message}</p>
                )}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-medium">{n.eventType ?? "Custom"}</div>
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  n.isEnabled ? "bg-emerald-950 text-emerald-400" : "bg-slate-800 text-slate-400"
                }`}
              >
                {n.isEnabled ? "Enabled" : "Disabled"}
              </span>
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">Time</dt>
                <dd>
                  {String(n.hour).padStart(2, "0")}:{String(n.minute).padStart(2, "0")} ({n.timezone})
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Channel</dt>
                <dd>#{n.channelName ?? n.channelId}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Reminder offsets</dt>
                <dd>{NOTIFICATION_TYPE_OFFSETS[n.notificationType] ?? `Type ${n.notificationType}`}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Mention</dt>
                <dd>{mentionLabel(n.mentionType)}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-slate-500">Repeat</dt>
                <dd>{repeatDescription(n)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Next fire</dt>
                <dd>{n.nextNotification ? new Date(n.nextNotification).toLocaleString() : "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Last fired</dt>
                <dd>{n.lastNotification ? new Date(n.lastNotification).toLocaleString() : "—"}</dd>
              </div>
              {n.autoDisabledAt && (
                <div className="sm:col-span-2">
                  <dt className="text-amber-400">Auto-disabled</dt>
                  <dd className="text-amber-400">{new Date(n.autoDisabledAt).toLocaleString()}</dd>
                </div>
              )}
              <div>
                <dt className="text-slate-500">Created by</dt>
                <dd>{n.createdBy}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Created at</dt>
                <dd>{n.createdAt ? new Date(n.createdAt).toLocaleString() : "—"}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="mb-2 font-medium text-slate-200">Message</div>
            {n.descriptionKind === "embed" && n.embed ? (
              <DiscordEmbedPreview embed={n.embed} applyPlaceholders={false} />
            ) : (
              <p className="whitespace-pre-wrap text-sm text-slate-300">{n.descriptionText || "(empty)"}</p>
            )}
            {n.customTimes && (
              <div className="mt-2 text-xs text-slate-500">
                Custom times: {n.customTimes.join(", ")} min before
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="mb-2 font-medium text-slate-200">Sent history</div>
            {historyQuery.isLoading && <p className="text-sm text-slate-400">Loading…</p>}
            {historyQuery.error && <p className="text-sm text-red-400">Couldn't load history.</p>}
            {historyQuery.data && historyQuery.data.rows.length === 0 && (
              <p className="text-sm text-slate-400">No sends recorded yet.</p>
            )}
            {historyQuery.data && historyQuery.data.rows.length > 0 && (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-slate-500">
                      <tr>
                        <th className="pb-1 pr-4">Sent at</th>
                        <th className="pb-1 pr-4">Offset</th>
                        <th className="pb-1 pr-4">Deleted</th>
                      </tr>
                    </thead>
                    <tbody className="text-slate-300">
                      {historyQuery.data.rows.map((h) => (
                        <tr key={h.id} className="border-t border-slate-800">
                          <td className="py-1 pr-4">{h.sentAt ? new Date(h.sentAt).toLocaleString() : "—"}</td>
                          <td className="py-1 pr-4">{h.notificationTime} min before</td>
                          <td className="py-1 pr-4">{h.deletedAt ? new Date(h.deletedAt).toLocaleString() : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex items-center gap-3 text-xs">
                  <button
                    onClick={() => setHistoryOffset(Math.max(0, historyOffset - HISTORY_PAGE_SIZE))}
                    disabled={historyOffset === 0}
                    className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-40"
                  >
                    Newer
                  </button>
                  <button
                    onClick={() => setHistoryOffset(historyOffset + HISTORY_PAGE_SIZE)}
                    disabled={!historyQuery.data.hasMore}
                    className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-40"
                  >
                    Older
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}
