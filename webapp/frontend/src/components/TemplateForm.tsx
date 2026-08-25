import type { TemplateDetail, TemplateInput } from "../api/client";
import RepeatIntervalInput from "./RepeatIntervalInput";
import EmbedFieldsForm, {
  defaultEmbedDraft,
  embedDraftToInput,
  isEmbedDraftValid,
  type EmbedDraft,
} from "./EmbedFieldsForm";

const NOTIFICATION_TYPES: { value: number; label: string }[] = [
  { value: 0, label: "Not set" },
  { value: 1, label: "30, 10, 5 min before + at time" },
  { value: 2, label: "10, 5 min before + at time" },
  { value: 3, label: "5 min before + at time" },
  { value: 4, label: "5 min before only" },
  { value: 5, label: "At the time only" },
  { value: 6, label: "Custom times" },
];

const WEEKDAYS: { value: number; label: string }[] = [
  { value: 0, label: "Mon" },
  { value: 1, label: "Tue" },
  { value: 2, label: "Wed" },
  { value: 3, label: "Thu" },
  { value: 4, label: "Fri" },
  { value: 5, label: "Sat" },
  { value: 6, label: "Sun" },
];

type RepeatMode = "none" | "interval" | "fixed_days";

export interface TemplateDraft {
  templateName: string;
  eventType: string;
  description: string;
  notificationType: number;
  customTimesText: string;
  repeatMode: RepeatMode;
  repeatMinutes: number;
  repeatDays: number[];
  embed: EmbedDraft;
}

export function defaultTemplateDraft(): TemplateDraft {
  return {
    templateName: "",
    eventType: "",
    description: "",
    notificationType: 0,
    customTimesText: "30, 10, 5, 0",
    repeatMode: "none",
    repeatMinutes: 60,
    repeatDays: [],
    embed: defaultEmbedDraft(),
  };
}

export function draftFromTemplate(t: TemplateDetail): TemplateDraft {
  const repeatMode: RepeatMode = t.repeatConfig?.type ?? "none";
  return {
    templateName: t.templateName,
    eventType: t.eventType ?? "",
    description: t.description ?? "",
    notificationType: t.notificationType ?? 0,
    customTimesText: t.customTimes && t.customTimes.length > 0 ? t.customTimes.join(", ") : "30, 10, 5, 0",
    repeatMode,
    repeatMinutes: repeatMode === "interval" ? (t.repeatConfig?.minutes ?? 60) : 60,
    repeatDays: repeatMode === "fixed_days" ? (t.repeatConfig?.days ?? []) : [],
    embed: {
      title: t.embedTitle ?? "",
      description: t.embedDescription ?? "",
      colorHex: t.embedColor !== null ? `#${t.embedColor.toString(16).padStart(6, "0")}` : "#5865f2",
      imageUrl: t.embedImageUrl ?? "",
      thumbnailUrl: t.embedThumbnailUrl ?? "",
      footer: t.footer ?? "",
      author: t.author ?? "",
      mentionMessage: t.mentionMessage ?? "",
    },
  };
}

export function draftToTemplateInput(draft: TemplateDraft): TemplateInput {
  const embedInput = embedDraftToInput(draft.embed);
  const customTimes =
    draft.notificationType === 6
      ? draft.customTimesText
          .split(",")
          .map((t) => parseInt(t.trim(), 10))
          .filter((n) => !Number.isNaN(n))
      : undefined;
  const repeatConfig =
    draft.repeatMode === "interval"
      ? { type: "interval" as const, minutes: draft.repeatMinutes }
      : draft.repeatMode === "fixed_days"
        ? { type: "fixed_days" as const, days: draft.repeatDays }
        : null;
  return {
    templateName: draft.templateName.trim(),
    eventType: draft.eventType.trim() || null,
    description: draft.description.trim() || null,
    notificationType: draft.notificationType || null,
    customTimes,
    repeatConfig,
    embedTitle: embedInput.title,
    embedDescription: embedInput.description,
    embedColor: embedInput.color,
    embedImageUrl: embedInput.imageUrl,
    embedThumbnailUrl: embedInput.thumbnailUrl,
    footer: embedInput.footer,
    author: embedInput.author,
    mentionMessage: embedInput.mentionMessage,
  };
}

export function isTemplateDraftValid(draft: TemplateDraft): boolean {
  if (!draft.templateName.trim()) return false;
  if (!isEmbedDraftValid(draft.embed)) return false;
  if (draft.notificationType === 6) {
    const times = draft.customTimesText.split(",").map((t) => parseInt(t.trim(), 10));
    if (times.length === 0 || times.some((n) => Number.isNaN(n))) return false;
  }
  if (draft.repeatMode === "fixed_days" && draft.repeatDays.length === 0) return false;
  if (draft.repeatMode === "interval" && draft.repeatMinutes <= 0) return false;
  return true;
}

export default function TemplateForm({
  draft,
  onChange,
}: {
  draft: TemplateDraft;
  onChange: (draft: TemplateDraft) => void;
}) {
  const set = <K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]) => onChange({ ...draft, [key]: value });

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs text-slate-400">Template name</label>
        <input
          value={draft.templateName}
          onChange={(e) => set("templateName", e.target.value)}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-slate-400">Event name (optional)</label>
        <input
          value={draft.eventType}
          onChange={(e) => set("eventType", e.target.value)}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-slate-400">Description (optional)</label>
        <input
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="Shown in the templates list, not sent to Discord"
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
        />
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
        <label className="mb-1 block text-xs text-slate-400">Repeat</label>
        <select
          value={draft.repeatMode}
          onChange={(e) => set("repeatMode", e.target.value as RepeatMode)}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
        >
          <option value="none">Not set</option>
          <option value="interval">Custom interval</option>
          <option value="fixed_days">Specific weekdays</option>
        </select>
        {draft.repeatMode === "interval" && (
          <RepeatIntervalInput
            totalMinutes={draft.repeatMinutes}
            onChange={(minutes) => set("repeatMinutes", minutes)}
          />
        )}
        {draft.repeatMode === "fixed_days" && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() =>
                  set(
                    "repeatDays",
                    draft.repeatDays.includes(d.value)
                      ? draft.repeatDays.filter((x) => x !== d.value)
                      : [...draft.repeatDays, d.value],
                  )
                }
                className={`rounded-md border px-2.5 py-1 text-xs ${
                  draft.repeatDays.includes(d.value)
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

      <div className="border-t border-slate-800 pt-3">
        <div className="mb-2 text-xs font-medium text-slate-400">Embed content</div>
        <EmbedFieldsForm draft={draft.embed} onChange={(embed) => set("embed", embed)} />
      </div>
    </div>
  );
}
