import type { AllianceChannel, CustomEventDetail, CustomEventInput } from "../api/client";
import EmbedFieldsForm, {
  defaultEmbedDraft,
  embedDraftFromNotificationEmbed,
  embedDraftToInput,
  isEmbedDraftValid,
  type EmbedDraft,
} from "./EmbedFieldsForm";
import { defaultPlaceholderSample } from "./DiscordEmbedPreview";

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
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs text-slate-400">
          Name
          <input
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
          />
        </label>
      </div>

      <div>
        <label className="mb-1 block text-xs text-slate-400">
          Icon (single emoji, optional)
          <input
            value={draft.iconUrl}
            onChange={(e) => set("iconUrl", e.target.value)}
            placeholder="📅"
            maxLength={50}
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
          />
        </label>
      </div>

      <div className="border-t border-slate-800 pt-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600">Schedule</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-slate-400">
              First occurrence date (UTC)
              <input
                type="date"
                value={draft.date}
                onChange={(e) => set("date", e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
              />
            </label>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">
              Time (UTC)
              <input
                type="time"
                value={draft.time}
                onChange={(e) => set("time", e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
              />
            </label>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-slate-400">
              Repeats
              <select
                value={draft.recurrenceType}
                onChange={(e) => set("recurrenceType", e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">
              Every N {draft.recurrenceType === "daily" ? "days" : draft.recurrenceType === "weekly" ? "weeks" : "months"}
              <input
                type="number"
                min={1}
                value={draft.recurrenceInterval}
                onChange={(e) => set("recurrenceInterval", Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
              />
            </label>
          </div>
        </div>
      </div>

      <div className="border-t border-slate-800 pt-3">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={draft.notificationsEnabled}
            onChange={(e) => set("notificationsEnabled", e.target.checked)}
            className="rounded border-slate-700 bg-slate-950"
          />
          Post Discord notifications for this event
        </label>
        <p className="mt-1 text-xs text-slate-500">
          {draft.notificationsEnabled
            ? "Set the channel, mention, reminder times, and message below."
            : "Off -- this event is calendar-only. It still shows up on the member calendar, but nothing gets posted to Discord."}
        </p>
      </div>

      {draft.notificationsEnabled && (
        <div className="space-y-3 border-t border-slate-800 pt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">Discord settings</div>

          <div>
            <label className="mb-1 block text-xs text-slate-400">
              Channel
              <select
                value={draft.channelId}
                onChange={(e) => set("channelId", e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
              >
                <option value="">— select a channel —</option>
                {channels?.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div>
            <span className="mb-1 block text-xs text-slate-400">Mention</span>
            <div className="flex gap-2">
              <label className="sr-only" htmlFor="custom-event-mention-kind">
                Mention type
              </label>
              <select
                id="custom-event-mention-kind"
                value={draft.mentionKind}
                onChange={(e) => set("mentionKind", e.target.value as MentionKind)}
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
              >
                <option value="none">No mention</option>
                <option value="everyone">@everyone</option>
                <option value="role">Role</option>
                <option value="member">Member</option>
              </select>
              {(draft.mentionKind === "role" || draft.mentionKind === "member") && (
                <label className="sr-only" htmlFor="custom-event-mention-id">
                  {draft.mentionKind === "role" ? "Role ID" : "Member ID"}
                </label>
              )}
              {(draft.mentionKind === "role" || draft.mentionKind === "member") && (
                <input
                  id="custom-event-mention-id"
                  value={draft.mentionId}
                  onChange={(e) => set("mentionId", e.target.value)}
                  placeholder={draft.mentionKind === "role" ? "Role ID" : "Member ID"}
                  className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
                />
              )}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-slate-400">
              Reminder offsets
              <select
                value={draft.notificationType}
                onChange={(e) => set("notificationType", Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
              >
                {NOTIFICATION_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            {draft.notificationType === 6 && (
              <label className="mt-2 block">
                <span className="sr-only">Custom reminder times, minutes before</span>
                <input
                  value={draft.customTimesText}
                  onChange={(e) => set("customTimesText", e.target.value)}
                  placeholder="30, 10, 5, 0"
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
                />
              </label>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs text-slate-400">
              Message type
              <select
                value={draft.messageKind}
                onChange={(e) => set("messageKind", e.target.value as MessageKind)}
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
              >
                <option value="plain">Plain text</option>
                <option value="embed">Embed</option>
              </select>
            </label>
          </div>

          {draft.messageKind === "plain" ? (
            <div>
              <label className="mb-1 block text-xs text-slate-400">
                Message (optional)
                <textarea
                  value={draft.message}
                  onChange={(e) => set("message", e.target.value)}
                  rows={2}
                  placeholder="%i **%n** starts in %t!"
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
                />
              </label>
              <p className="mt-1 text-xs text-slate-500">
                Defaults to "%i **%n** starts in %t!" if left blank. Placeholders like %t/%n/%e/%d/%i and{" "}
                {"{tag}"} are substituted when the bot sends this.
              </p>
            </div>
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
  );
}
