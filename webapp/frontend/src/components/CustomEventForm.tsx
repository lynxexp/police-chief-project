import type { AllianceChannel, CustomEventDetail, CustomEventInput } from "../api/client";

const NOTIFICATION_TYPES: { value: number; label: string }[] = [
  { value: 1, label: "30, 10, 5 min before + at time" },
  { value: 2, label: "10, 5 min before + at time" },
  { value: 3, label: "5 min before + at time" },
  { value: 4, label: "5 min before only" },
  { value: 5, label: "At the time only" },
  { value: 6, label: "Custom times" },
];

export type MentionKind = "none" | "everyone" | "role" | "member";

export interface CustomEventDraft {
  name: string;
  iconUrl: string;
  date: string;
  time: string;
  recurrenceType: string;
  recurrenceInterval: number;
  channelId: string;
  notificationType: number;
  customTimesText: string;
  mentionKind: MentionKind;
  mentionId: string;
  message: string;
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
    channelId: "",
    notificationType: 3,
    customTimesText: "30, 10, 5, 0",
    mentionKind: "none",
    mentionId: "",
    message: "",
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
    channelId: e.channelId,
    notificationType: e.materializedNotification?.notificationType ?? 3,
    customTimesText: e.reminderOffsets.length > 0 ? e.reminderOffsets.join(", ") : "30, 10, 5, 0",
    mentionKind,
    mentionId,
    message: "",
  };
}

export function draftToInput(draft: CustomEventDraft, channelName: string | null): CustomEventInput {
  const [hourStr, minuteStr] = draft.time.split(":");
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
    name: draft.name.trim(),
    iconUrl: draft.iconUrl.trim() || null,
    date: draft.date,
    hour: Number(hourStr),
    minute: Number(minuteStr),
    recurrenceType: draft.recurrenceType,
    recurrenceInterval: draft.recurrenceInterval,
    channelId: draft.channelId,
    channelName,
    notificationType: draft.notificationType,
    customTimes,
    mentionType,
    message: draft.message.trim() || undefined,
  };
}

export function isDraftValid(draft: CustomEventDraft): boolean {
  if (!draft.name.trim() || !draft.channelId) return false;
  if (draft.mentionKind === "role" || draft.mentionKind === "member") {
    if (!draft.mentionId.trim()) return false;
  }
  if (draft.notificationType === 6) {
    const times = draft.customTimesText.split(",").map((t) => parseInt(t.trim(), 10));
    if (times.length === 0 || times.some((n) => Number.isNaN(n))) return false;
  }
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
        <label className="mb-1 block text-xs text-slate-400">Name</label>
        <input
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-slate-400">Icon (single emoji, optional)</label>
        <input
          value={draft.iconUrl}
          onChange={(e) => set("iconUrl", e.target.value)}
          placeholder="📅"
          maxLength={50}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-slate-400">Channel</label>
        <select
          value={draft.channelId}
          onChange={(e) => set("channelId", e.target.value)}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
        >
          <option value="">— select a channel —</option>
          {channels?.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-slate-400">First occurrence date (UTC)</label>
          <input
            type="date"
            value={draft.date}
            onChange={(e) => set("date", e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-400">Time (UTC)</label>
          <input
            type="time"
            value={draft.time}
            onChange={(e) => set("time", e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-slate-400">Repeats</label>
          <select
            value={draft.recurrenceType}
            onChange={(e) => set("recurrenceType", e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-400">
            Every N {draft.recurrenceType === "daily" ? "days" : draft.recurrenceType === "weekly" ? "weeks" : "months"}
          </label>
          <input
            type="number"
            min={1}
            value={draft.recurrenceInterval}
            onChange={(e) => set("recurrenceInterval", Number(e.target.value))}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs text-slate-400">Reminder offsets</label>
        <select
          value={draft.notificationType}
          onChange={(e) => set("notificationType", Number(e.target.value))}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
        >
          {NOTIFICATION_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {draft.notificationType === 6 && (
          <input
            value={draft.customTimesText}
            onChange={(e) => set("customTimesText", e.target.value)}
            placeholder="30, 10, 5, 0"
            className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
          />
        )}
      </div>

      <div>
        <label className="mb-1 block text-xs text-slate-400">Mention</label>
        <div className="flex gap-2">
          <select
            value={draft.mentionKind}
            onChange={(e) => set("mentionKind", e.target.value as MentionKind)}
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
              onChange={(e) => set("mentionId", e.target.value)}
              placeholder={draft.mentionKind === "role" ? "Role ID" : "Member ID"}
              className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
            />
          )}
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs text-slate-400">Message (optional)</label>
        <textarea
          value={draft.message}
          onChange={(e) => set("message", e.target.value)}
          rows={2}
          placeholder="%i **%n** starts in %t!"
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
        />
        <p className="mt-1 text-xs text-slate-500">
          Defaults to "%i **%n** starts in %t!" if left blank. Placeholders like %t/%n/%e/%d/%i and{" "}
          {"{tag}"} are substituted when the bot sends this.
        </p>
      </div>
    </div>
  );
}
