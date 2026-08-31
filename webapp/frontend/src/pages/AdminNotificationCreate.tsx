import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { getAllianceGuild, getAllianceChannels, createNotification } from "../api/client";
import RepeatIntervalInput from "../components/RepeatIntervalInput";
import EmbedFieldsForm, { defaultEmbedDraft, embedDraftToInput, isEmbedDraftValid } from "../components/EmbedFieldsForm";
import { defaultPlaceholderSample } from "../components/DiscordEmbedPreview";
import { Pill, SectionHeading, buttonPrimary } from "../components/ui";

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

const fieldClass = "mt-1 w-full rounded-control border border-line bg-surface-sunken px-3 py-2 text-sm text-ink";

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

  const mentionType = mentionKind === "role" ? `role_${mentionId}` : mentionKind === "member" ? `member_${mentionId}` : mentionKind;

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
    <Layout title="New notification" backTo={{ to: `/admin/alliances/${allianceId}/notifications`, label: "Notifications" }}>
      {guildQuery.data && !guildId && <p className="text-sm text-ink-muted">This alliance has no linked Discord server.</p>}

      {guildId && (
        <div className="flex max-w-2xl flex-col gap-5">
          <div className="flex flex-col gap-3">
            <SectionHeading>Where &amp; when</SectionHeading>
            <label className="block">
              <span className="text-sm text-ink-secondary">Channel</span>
              <select value={channelId} onChange={(e) => setChannelId(e.target.value)} className={fieldClass}>
                <option value="">Not set</option>
                {channelsQuery.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm text-ink-secondary">Event name (optional)</span>
              <input value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="Custom" className={fieldClass} />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm text-ink-secondary">Date</span>
                <input type="date" min={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} className={fieldClass} />
              </label>
              <label className="block">
                <span className="text-sm text-ink-secondary">Time</span>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={fieldClass} />
              </label>
            </div>

            <label className="block">
              <span className="text-sm text-ink-secondary">Timezone</span>
              <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="UTC, Europe/Istanbul, America/New_York..." className={fieldClass} />
            </label>
          </div>

          <div className="flex flex-col gap-3 border-t border-line-hairline pt-4">
            <SectionHeading>Schedule</SectionHeading>
            <div>
              <span className="mb-1.5 block text-sm text-ink-secondary">Reminder offsets</span>
              <div className="flex flex-wrap gap-1.5">
                {NOTIFICATION_TYPES.map((t) => (
                  <Pill key={t.value} active={notificationType === t.value} onClick={() => setNotificationType(t.value)}>
                    {t.label}
                  </Pill>
                ))}
              </div>
            </div>

            <div>
              <span className="mb-1 block text-sm text-ink-secondary">Mention</span>
              <div className="flex gap-2">
                <select value={mentionKind} onChange={(e) => setMentionKind(e.target.value as MentionKind)} className={`${fieldClass} mt-0 max-w-[10rem]`}>
                  <option value="none">No mention</option>
                  <option value="everyone">@everyone</option>
                  <option value="role">Role</option>
                  <option value="member">Member</option>
                </select>
                {(mentionKind === "role" || mentionKind === "member") && (
                  <input
                    value={mentionId}
                    onChange={(e) => setMentionId(e.target.value)}
                    placeholder={mentionKind === "role" ? "Role ID" : "Member (Discord) ID"}
                    className={`${fieldClass} mt-0 flex-1`}
                  />
                )}
              </div>
            </div>

            <div>
              <span className="mb-1.5 block text-sm text-ink-secondary">Repeat</span>
              <div className="flex gap-1.5">
                <Pill active={repeatMode === "none"} onClick={() => setRepeatMode("none")}>
                  One-time
                </Pill>
                <Pill active={repeatMode === "minutes"} onClick={() => setRepeatMode("minutes")}>
                  Custom interval
                </Pill>
                <Pill active={repeatMode === "weekdays"} onClick={() => setRepeatMode("weekdays")}>
                  Specific weekdays
                </Pill>
              </div>
              {repeatMode === "minutes" && <RepeatIntervalInput totalMinutes={repeatMinutes} onChange={setRepeatMinutes} />}
              {repeatMode === "weekdays" && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((d) => (
                    <Pill key={d.value} active={weekdays.includes(d.value)} onClick={() => toggleWeekday(d.value)}>
                      {d.label}
                    </Pill>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-line-hairline pt-4">
            <SectionHeading>Message</SectionHeading>
            <div className="flex gap-1.5">
              <Pill active={messageKind === "plain"} onClick={() => setMessageKind("plain")}>
                Plain text
              </Pill>
              <Pill active={messageKind === "embed"} onClick={() => setMessageKind("embed")}>
                Embed
              </Pill>
            </div>

            {messageKind === "plain" ? (
              <label className="block">
                <span className="text-sm text-ink-secondary">Message</span>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="%n starts in %t!" className={fieldClass} />
                <p className="mt-1 font-mono text-[11px] text-ink-faint">%t %n %e %d %i and {"{tag}"} are substituted when the bot sends this.</p>
              </label>
            ) : (
              <EmbedFieldsForm
                draft={embedDraft}
                onChange={setEmbedDraft}
                sample={defaultPlaceholderSample({
                  eventName: eventType.trim() || "Event",
                  eventTime: time,
                  eventDate: new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }),
                })}
              />
            )}
          </div>

          <div>
            <button onClick={() => createMutation.mutate()} disabled={!canSubmit} className={buttonPrimary}>
              Create notification
            </button>
            {createMutation.isError && <p className="mt-1.5 text-sm text-down-ink">{(createMutation.error as Error).message}</p>}
          </div>
        </div>
      )}
    </Layout>
  );
}
