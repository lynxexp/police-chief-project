import type { AllianceChannel, CustomEventDetail, CustomEventInput } from "../api/client";
import EmbedFieldsForm, {
  defaultEmbedDraft,
  embedDraftFromNotificationEmbed,
  embedDraftToInput,
  isEmbedDraftValid,
  type EmbedDraft,
} from "./EmbedFieldsForm";
import { defaultPlaceholderSample } from "./DiscordEmbedPreview";
import { Pill, SectionHeading, Toggle } from "./ui";

const NOTIFICATION_TYPES: { value: number; label: string }[] = [
  { value: 1, label: "30, 10, 5 min before + at time" },
  { value: 2, label: "10, 5 min before + at time" },
  { value: 3, label: "5 min before + at time" },
  { value: 4, label: "5 min before only" },
  { value: 5, label: "At the time only" },
  { value: 6, label: "Custom times" },
];

export type MentionKind = "none" | "everyone" | "role" | "member";
type MessageKind = "plain" | "embed";

export interface CustomEventDraft {
  name: string;
  iconUrl: string;
  date: string;
  time: string;
  recurrenceType: string;
  recurrenceInterval: number;
  /** Off = calendar-only event -- every field below is ignored/hidden. */
  notificationsEnabled: boolean;
  channelId: string;
  mentionKind: MentionKind;
  mentionId: string;
  notificationType: number;
  customTimesText: string;
  messageKind: MessageKind;
  message: string;
  embed: EmbedDraft;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function defaultCustomEventDraft(name = ""): CustomEventDraft {
  return {
    name,
    iconUrl: "",
    date: todayIso(),
    time: "18:00",
    recurrenceType: "monthly",
    recurrenceInterval: 1,
    notificationsEnabled: true,
    channelId: "",
    mentionKind: "none",
    mentionId: "",
    notificationType: 3,
    customTimesText: "30, 10, 5, 0",
    messageKind: "plain",
    message: "",
    embed: defaultEmbedDraft(),
  };
}

export function draftFromCustomEvent(e: CustomEventDetail): CustomEventDraft {
  let mentionKind: MentionKind = "none";
  let mentionId = "";
  const mentionType = e.materializedNotification?.mentionType ?? "none";
  if (mentionType === "everyone") mentionKind = "everyone";
  else if (mentionType.startsWith("role_")) {
    mentionKind = "role";
    mentionId = mentionType.slice("role_".length);
  } else if (mentionType.startsWith("member_")) {
    mentionKind = "member";
    mentionId = mentionType.slice("member_".length);
  }
  const [date, time] = (e.firstOccurrence ?? `${todayIso()}T18:00:00`).split("T");
  return {
    name: e.name ?? "",
    iconUrl: e.iconUrl ?? "",
    date: date!,
    time: time!.slice(0, 5),
    recurrenceType: e.recurrenceType ?? "monthly",
    recurrenceInterval: e.recurrenceInterval ?? 1,
    notificationsEnabled: e.notificationsEnabled,
    channelId: e.channelId ?? "",
    mentionKind,
    mentionId,
    notificationType: e.materializedNotification?.notificationType ?? 3,
    customTimesText: e.reminderOffsets.length > 0 ? e.reminderOffsets.join(", ") : "30, 10, 5, 0",
    messageKind: e.messageKind ?? "plain",
    message: e.messageKind === "plain" ? (e.message ?? "") : "",
    embed: e.messageKind === "embed" ? embedDraftFromNotificationEmbed(e.embed) : defaultEmbedDraft(),
  };
}

export function draftToInput(draft: CustomEventDraft, channelName: string | null): CustomEventInput {
  const [hourStr, minuteStr] = draft.time.split(":");

  const base: CustomEventInput = {
    name: draft.name.trim(),
    iconUrl: draft.iconUrl.trim() || null,
    date: draft.date,
    hour: Number(hourStr),
    minute: Number(minuteStr),
    recurrenceType: draft.recurrenceType,
    recurrenceInterval: draft.recurrenceInterval,
    notificationsEnabled: draft.notificationsEnabled,
  };

  if (!draft.notificationsEnabled) {
    return base;
  }

  const mentionType =
    draft.mentionKind === "role"
      ? `role_${draft.mentionId}`
      : draft.mentionKind === "member"
        ? `member_${draft.mentionId}`
        : draft.mentionKind;
  const customTimes =
    draft.notificationType === 6
      ? draft.customTimesText
          .split(",")
          .map((t) => parseInt(t.trim(), 10))
          .filter((n) => !Number.isNaN(n))
      : undefined;

  return {
    ...base,
    channelId: draft.channelId,
    channelName,
    mentionType,
    notificationType: draft.notificationType,
    customTimes,
    messageKind: draft.messageKind,
    message: draft.messageKind === "plain" ? draft.message.trim() || undefined : undefined,
    embed: draft.messageKind === "embed" ? embedDraftToInput(draft.embed) : undefined,
  };
}

export function isDraftValid(draft: CustomEventDraft): boolean {
  if (!draft.name.trim()) return false;
  if (!draft.notificationsEnabled) return true;
  if (!draft.channelId) return false;
  if (draft.mentionKind === "role" || draft.mentionKind === "member") {
    if (!draft.mentionId.trim()) return false;
  }
  if (draft.notificationType === 6) {
    const times = draft.customTimesText.split(",").map((t) => parseInt(t.trim(), 10));
    if (times.length === 0 || times.some((n) => Number.isNaN(n))) return false;
  }
  if (draft.messageKind === "embed" && !isEmbedDraftValid(draft.embed)) return false;
  return true;
}

/** Next 3 UTC occurrences from the draft's schedule -- a quick sanity
 * check while editing, not a guarantee (the real engine is
 * calculate_next_occurrence() on the bot side; monthly there is
 * calendar-aware, this approximates it the same simple way). */
function nextOccurrences(draft: CustomEventDraft, count = 3): Date[] {
  const [h, m] = draft.time.split(":").map(Number);
  const first = new Date(`${draft.date}T00:00:00Z`);
  first.setUTCHours(h || 0, m || 0, 0, 0);
  const out: Date[] = [];
  const step = (d: Date) => {
    const next = new Date(d);
    if (draft.recurrenceType === "daily") next.setUTCDate(next.getUTCDate() + draft.recurrenceInterval);
    else if (draft.recurrenceType === "weekly") next.setUTCDate(next.getUTCDate() + draft.recurrenceInterval * 7);
    else next.setUTCMonth(next.getUTCMonth() + draft.recurrenceInterval);
    return next;
  };
  let cur = first;
  for (let i = 0; i < count; i++) {
    out.push(cur);
    cur = step(cur);
  }
  return out;
}

const fieldClass = "w-full rounded-control border border-line bg-surface-sunken px-3 py-1.5 text-sm text-ink";

export default function CustomEventForm({
  draft,
  onChange,
  channels,
}: {
  draft: CustomEventDraft;
  onChange: (draft: CustomEventDraft) => void;
  channels: AllianceChannel[] | undefined;
}) {
  const set = <K extends keyof CustomEventDraft>(key: K, value: CustomEventDraft[K]) =>
    onChange({ ...draft, [key]: value });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <SectionHeading>Identity</SectionHeading>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-muted">Name</span>
          <input value={draft.name} onChange={(e) => set("name", e.target.value)} className={fieldClass} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-muted">Icon (single emoji, optional)</span>
          <input value={draft.iconUrl} onChange={(e) => set("iconUrl", e.target.value)} placeholder="📅" maxLength={50} className={fieldClass} />
        </label>
      </div>

      <div className="flex flex-col gap-3 border-t border-line-hairline pt-4">
        <SectionHeading>Recurrence</SectionHeading>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-ink-muted">First occurrence date (UTC)</span>
            <input type="date" value={draft.date} onChange={(e) => set("date", e.target.value)} className={fieldClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-ink-muted">Time (UTC)</span>
            <input type="time" value={draft.time} onChange={(e) => set("time", e.target.value)} className={fieldClass} />
          </label>
        </div>

        <div className="flex gap-1.5">
          {(["daily", "weekly", "monthly"] as const).map((r) => (
            <Pill key={r} active={draft.recurrenceType === r} onClick={() => set("recurrenceType", r)}>
              {r}
            </Pill>
          ))}
        </div>
        <label className="block max-w-xs">
          <span className="mb-1 block text-xs text-ink-muted">
            Every N {draft.recurrenceType === "daily" ? "days" : draft.recurrenceType === "weekly" ? "weeks" : "months"}
          </span>
          <input
            type="number"
            min={1}
            value={draft.recurrenceInterval}
            onChange={(e) => set("recurrenceInterval", Number(e.target.value))}
            className={fieldClass}
          />
        </label>

        {draft.date && (
          <div className="rounded-control border border-line-hairline bg-surface-sunken p-3">
            <p className="mb-1.5 font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">Next 3 occurrences</p>
            <div className="flex flex-col gap-0.5 font-mono text-sm text-gold-ink">
              {nextOccurrences(draft).map((d, i) => (
                <span key={i}>{d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</span>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-ink-faint">
              Approximate -- monthly here is calendar-aware, while a notification's own interval repeat approximates 30 days.
            </p>
          </div>
        )}
      </div>

      <div className="rounded-card border border-gold-border">
        <div className="flex items-center justify-between gap-3 bg-gold-tint px-4 py-3">
          <div>
            <p className="font-sans text-sm font-semibold text-ink">Post Discord notifications</p>
            <p className="text-xs text-ink-muted">
              {draft.notificationsEnabled ? "On — set the channel, mention, timing and message below." : "Off = calendar only, nothing posted to a channel."}
            </p>
          </div>
          <Toggle checked={draft.notificationsEnabled} onChange={(v) => set("notificationsEnabled", v)} label="Post Discord notifications" />
        </div>

        {draft.notificationsEnabled && (
          <div className="flex flex-col gap-3 p-4">
            <label className="block">
              <span className="mb-1 block text-xs text-ink-muted">Channel</span>
              <select value={draft.channelId} onChange={(e) => set("channelId", e.target.value)} className={fieldClass}>
                <option value="">Not set</option>
                {channels?.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <span className="mb-1 block text-xs text-ink-muted">Mention</span>
              <div className="flex gap-2">
                <select value={draft.mentionKind} onChange={(e) => set("mentionKind", e.target.value as MentionKind)} className={`${fieldClass} max-w-[10rem]`}>
                  <option value="none">No mention</option>
                  <option value="everyone">@everyone</option>
                  <option value="role">Role</option>
                  <option value="member">Member</option>
                </select>
                {(draft.mentionKind === "role" || draft.mentionKind === "member") && (
                  <input
                    value={draft.mentionId}
                    onChange={(e) => set("mentionId", e.target.value)}
                    placeholder={draft.mentionKind === "role" ? "Role ID" : "Member ID"}
                    className={fieldClass}
                  />
                )}
              </div>
            </div>

            <div>
              <span className="mb-1 block text-xs text-ink-muted">Reminder offsets</span>
              <div className="flex flex-wrap gap-1.5">
                {NOTIFICATION_TYPES.map((t) => (
                  <Pill key={t.value} active={draft.notificationType === t.value} onClick={() => set("notificationType", t.value)}>
                    {t.label}
                  </Pill>
                ))}
              </div>
              {draft.notificationType === 6 && (
                <input
                  value={draft.customTimesText}
                  onChange={(e) => set("customTimesText", e.target.value)}
                  placeholder="30, 10, 5, 0"
                  className={`${fieldClass} mt-2 font-mono`}
                />
              )}
            </div>

            <div>
              <span className="mb-1 block text-xs text-ink-muted">Message type</span>
              <div className="flex gap-1.5">
                <Pill active={draft.messageKind === "plain"} onClick={() => set("messageKind", "plain")}>
                  Plain text
                </Pill>
                <Pill active={draft.messageKind === "embed"} onClick={() => set("messageKind", "embed")}>
                  Embed
                </Pill>
              </div>
            </div>

            {draft.messageKind === "plain" ? (
              <label className="block">
                <span className="mb-1 block text-xs text-ink-muted">Message (optional)</span>
                <textarea
                  value={draft.message}
                  onChange={(e) => set("message", e.target.value)}
                  rows={2}
                  placeholder="%i **%n** starts in %t!"
                  className={fieldClass}
                />
                <p className="mt-1 font-mono text-[11px] text-ink-faint">
                  Defaults to "%i **%n** starts in %t!" if left blank. %t %n %e %d %i and {"{tag}"} are substituted when sent.
                </p>
              </label>
            ) : (
              <EmbedFieldsForm
                draft={draft.embed}
                onChange={(embed) => set("embed", embed)}
                sample={defaultPlaceholderSample({
                  eventName: draft.name.trim() || "Event",
                  eventTime: draft.time,
                  eventDate: new Date(`${draft.date}T00:00:00Z`).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC",
                  }),
                })}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
