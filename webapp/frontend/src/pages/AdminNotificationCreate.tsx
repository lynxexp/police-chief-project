import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { getAllianceGuild, getAllianceChannels, createNotification } from "../api/client";
import RepeatIntervalInput from "../components/RepeatIntervalInput";
import EmbedFieldsForm, {
  defaultEmbedDraft,
  embedDraftToInput,
  isEmbedDraftValid,
} from "../components/EmbedFieldsForm";
import { defaultPlaceholderSample } from "../components/DiscordEmbedPreview";
import { buttonPrimary } from "../components/ui";

const NOTIFICATION_TYPES: { value: number; label: string }[] = [
  { value: 1, label: "30, 10, 5 min before + at time" },
  { value: 2, label: "10, 5 min before + at time" },
  { value: 3, label: "5 min before + at time" },
  { value: 4, label: "5 min before only" },
  { value: 5, label: "At the time only" },
];

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

type MentionKind = "none" | "everyone" | "role" | "member";
type RepeatMode = "none" | "minutes" | "weekdays";
type MessageKind = "plain" | "embed";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function AdminNotificationCreate() {
  const { allianceId: allianceIdParam } = useParams<{ allianceId: string }>();
  const allianceId = Number(allianceIdParam);
  const navigate = useNavigate();

  const guildQuery = useQuery({
    queryKey: ["admin-alliance-guild", allianceId],
    queryFn: () => getAllianceGuild(allianceId),
  });
  const guildId = guildQuery.data?.guildId ?? null;

  const channelsQuery = useQuery({
    queryKey: ["admin-alliance-channels", allianceId],
    queryFn: () => getAllianceChannels(allianceId),
  });

  const [channelId, setChannelId] = useState("");
  const [eventType, setEventType] = useState("");
  const [date, setDate] = useState(todayIso());
  const [time, setTime] = useState("09:00");
  const [timezone, setTimezone] = useState("UTC");
  const [messageKind, setMessageKind] = useState<MessageKind>("plain");
  const [description, setDescription] = useState("");
  const [embedDraft, setEmbedDraft] = useState(defaultEmbedDraft());
  const [notificationType, setNotificationType] = useState(3);
  const [mentionKind, setMentionKind] = useState<MentionKind>("none");
  const [mentionId, setMentionId] = useState("");
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("none");
  const [repeatMinutes, setRepeatMinutes] = useState(60);
  const [weekdays, setWeekdays] = useState<number[]>([]);

  const mentionType =
    mentionKind === "role"
      ? `role_${mentionId}`
      : mentionKind === "member"
        ? `member_${mentionId}`
        : mentionKind;

  const toggleWeekday = (day: number) => {
    setWeekdays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  };

  const createMutation = useMutation({
    mutationFn: () => {
      const [hourStr, minuteStr] = time.split(":");
      const channel = channelsQuery.data?.find((c) => c.id === channelId);
      return createNotification(guildId!, {
        channelId,
        channelName: channel?.name ?? null,
        date,
        hour: Number(hourStr),
        minute: Number(minuteStr),
        timezone,
        messageKind,
        description: messageKind === "plain" ? description : undefined,
        embed: messageKind === "embed" ? embedDraftToInput(embedDraft) : undefined,
        notificationType,
        mentionType,
        repeatMinutes: repeatMode === "minutes" ? repeatMinutes : repeatMode === "weekdays" ? -1 : 0,
        weekdays: repeatMode === "weekdays" ? weekdays : undefined,
        eventType: eventType.trim() || null,
      });
    },
    onSuccess: (result) => navigate(`/admin/alliances/${allianceId}/notifications/${result.id}`),
  });

  const canSubmit =
    !!guildId &&
    !!channelId &&
    !!timezone.trim() &&
    (messageKind === "plain" ? !!description.trim() : isEmbedDraftValid(embedDraft)) &&
    (mentionKind === "none" || mentionKind === "everyone" || !!mentionId.trim()) &&
    (repeatMode !== "weekdays" || weekdays.length > 0) &&
    (repeatMode !== "minutes" || repeatMinutes > 0) &&
    !createMutation.isPending;

  return (
    <Layout
      title="New notification"
      backTo={{ to: `/admin/alliances/${allianceId}/notifications`, label: "Notifications" }}
    >
      {guildQuery.data && !guildId && (
        <p className="text-slate-400">This alliance has no linked Discord server.</p>
      )}

      {guildId && (
        <div className="max-w-lg space-y-5">
          <div className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Where &amp; when
            </div>
            <div>
              <label className="mb-1 block text-sm text-slate-400">
                Channel
                <select
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                >
                  <option value="">— select a channel —</option>
                  {channelsQuery.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div>
              <label className="mb-1 block text-sm text-slate-400">
                Event name (optional)
                <input
                  value={eventType}
                  onChange={(e) => setEventType(e.target.value)}
                  placeholder="Custom"
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm text-slate-400">
                  Date
                  <input
                    type="date"
                    min={todayIso()}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                  />
                </label>
              </div>
              <div>
                <label className="mb-1 block text-sm text-slate-400">
                  Time
                  <input
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                  />
                </label>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm text-slate-400">
                Timezone
                <input
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="UTC, Europe/Istanbul, America/New_York..."
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                />
              </label>
            </div>
          </div>

          <div className="space-y-3 border-t border-slate-800 pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">Schedule</div>
            <div>
              <label className="mb-1 block text-sm text-slate-400">
                Reminder offsets
                <select
                  value={notificationType}
                  onChange={(e) => setNotificationType(Number(e.target.value))}
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                >
                  {NOTIFICATION_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div>
              <span className="mb-1 block text-sm text-slate-400">Mention</span>
              <div className="flex gap-2">
                <label className="sr-only" htmlFor="notification-mention-kind">
                  Mention type
                </label>
                <select
                  id="notification-mention-kind"
                  value={mentionKind}
                  onChange={(e) => setMentionKind(e.target.value as MentionKind)}
                  className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                >
                  <option value="none">No mention</option>
                  <option value="everyone">@everyone</option>
                  <option value="role">Role</option>
                  <option value="member">Member</option>
                </select>
                {(mentionKind === "role" || mentionKind === "member") && (
                  <label className="flex-1">
                    <span className="sr-only">{mentionKind === "role" ? "Role ID" : "Member Discord ID"}</span>
                    <input
                      value={mentionId}
                      onChange={(e) => setMentionId(e.target.value)}
                      placeholder={mentionKind === "role" ? "Role ID" : "Member (Discord) ID"}
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                    />
                  </label>
                )}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm text-slate-400">
                Repeat
                <select
                  value={repeatMode}
                  onChange={(e) => setRepeatMode(e.target.value as RepeatMode)}
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                >
                  <option value="none">One-time</option>
                  <option value="minutes">Custom interval</option>
                  <option value="weekdays">Specific weekdays</option>
                </select>
              </label>
              {repeatMode === "minutes" && (
                <RepeatIntervalInput totalMinutes={repeatMinutes} onChange={setRepeatMinutes} />
              )}
              {repeatMode === "weekdays" && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((d) => (
                    <button
                      key={d.value}
                      type="button"
                      onClick={() => toggleWeekday(d.value)}
                      aria-pressed={weekdays.includes(d.value)}
                      className={`rounded-md border px-2.5 py-1 text-xs ${
                        weekdays.includes(d.value)
                          ? "border-indigo-500 bg-indigo-600 text-white"
                          : "border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-3 border-t border-slate-800 pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">Message</div>
            <div>
              <label className="mb-1 block text-sm text-slate-400">
                Message type
                <select
                  value={messageKind}
                  onChange={(e) => setMessageKind(e.target.value as MessageKind)}
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                >
                  <option value="plain">Plain text</option>
                  <option value="embed">Embed</option>
                </select>
              </label>
            </div>

            {messageKind === "plain" ? (
              <div>
                <label className="mb-1 block text-sm text-slate-400">
                  Message
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={4}
                    placeholder="%n starts in %t!"
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                  />
                </label>
                <p className="mt-1 text-xs text-slate-500">
                  Placeholders like %t/%n/%e/%d/%i and {"{tag}"} are substituted when the bot sends this.
                </p>
              </div>
            ) : (
              <EmbedFieldsForm
                draft={embedDraft}
                onChange={setEmbedDraft}
                sample={defaultPlaceholderSample({
                  eventName: eventType.trim() || "Event",
                  eventTime: time,
                  eventDate: new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC",
                  }),
                })}
              />
            )}
          </div>

          <button onClick={() => createMutation.mutate()} disabled={!canSubmit} className={buttonPrimary}>
            Create notification
          </button>
          {createMutation.isError && (
            <p className="text-sm text-red-400">{(createMutation.error as Error).message}</p>
          )}
        </div>
      )}
    </Layout>
  );
}
