import type { NotificationEmbed } from "../api/client";
import DiscordEmbedPreview, { defaultPlaceholderSample, type PlaceholderSample } from "./DiscordEmbedPreview";

export interface EmbedDraft {
  title: string;
  description: string;
  colorHex: string;
  imageUrl: string;
  thumbnailUrl: string;
  footer: string;
  author: string;
  mentionMessage: string;
}

const DEFAULT_COLOR_HEX = "#5865f2";

export function defaultEmbedDraft(): EmbedDraft {
  return {
    title: "%i %n starts in %t!",
    description: "",
    colorHex: DEFAULT_COLOR_HEX,
    imageUrl: "",
    thumbnailUrl: "",
    footer: "",
    author: "",
    mentionMessage: "",
  };
}

export function embedDraftFromNotificationEmbed(embed: NotificationEmbed | null): EmbedDraft {
  if (!embed) return defaultEmbedDraft();
  return {
    title: embed.title ?? "",
    description: embed.description ?? "",
    colorHex: embed.color !== null ? `#${embed.color.toString(16).padStart(6, "0")}` : DEFAULT_COLOR_HEX,
    imageUrl: embed.imageUrl ?? "",
    thumbnailUrl: embed.thumbnailUrl ?? "",
    footer: embed.footer ?? "",
    author: embed.author ?? "",
    mentionMessage: embed.mentionMessage ?? "",
  };
}

export function embedDraftToInput(draft: EmbedDraft): NotificationEmbed {
  const hex = draft.colorHex.trim().replace(/^#/, "");
  const color = /^[0-9a-fA-F]{1,6}$/.test(hex) ? parseInt(hex, 16) : null;
  return {
    title: draft.title.trim() || null,
    description: draft.description.trim() || null,
    color,
    imageUrl: draft.imageUrl.trim() || null,
    thumbnailUrl: draft.thumbnailUrl.trim() || null,
    footer: draft.footer.trim() || null,
    author: draft.author.trim() || null,
    mentionMessage: draft.mentionMessage.trim() || null,
  };
}

function isValidImageUrl(url: string): boolean {
  return url === "" || url.startsWith("http://") || url.startsWith("https://");
}

export function isEmbedDraftValid(draft: EmbedDraft): boolean {
  return isValidImageUrl(draft.imageUrl) && isValidImageUrl(draft.thumbnailUrl);
}

export default function EmbedFieldsForm({
  draft,
  onChange,
  sample,
}: {
  draft: EmbedDraft;
  onChange: (draft: EmbedDraft) => void;
  sample?: PlaceholderSample;
}) {
  const set = <K extends keyof EmbedDraft>(key: K, value: EmbedDraft[K]) => onChange({ ...draft, [key]: value });

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs text-slate-400">
          Title
          <input
            value={draft.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="%i %n at %e starts in %t!"
            maxLength={256}
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
          />
        </label>
      </div>
      <div>
        <label className="mb-1 block text-xs text-slate-400">
          Description
          <textarea
            value={draft.description}
            onChange={(e) => set("description", e.target.value)}
            rows={3}
            placeholder="Get ready for Vault Trap! Only %t remaining."
            maxLength={4000}
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className="mb-1 block text-xs text-slate-400">Color</span>
          <div className="flex items-center gap-2">
            <label>
              <span className="sr-only">Color swatch</span>
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(draft.colorHex) ? draft.colorHex : DEFAULT_COLOR_HEX}
                onChange={(e) => set("colorHex", e.target.value)}
                className="h-8 w-10 rounded border border-slate-700 bg-slate-950"
              />
            </label>
            <label className="flex-1">
              <span className="sr-only">Color hex code</span>
              <input
                value={draft.colorHex}
                onChange={(e) => set("colorHex", e.target.value)}
                placeholder="#5865F2"
                maxLength={7}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
              />
            </label>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-400">
            Footer
            <input
              value={draft.footer}
              onChange={(e) => set("footer", e.target.value)}
              maxLength={2048}
              className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
            />
          </label>
        </div>
      </div>
      <div>
        <label className="mb-1 block text-xs text-slate-400">
          Author
          <input
            value={draft.author}
            onChange={(e) => set("author", e.target.value)}
            maxLength={256}
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
          />
        </label>
      </div>
      <div>
        <label className="mb-1 block text-xs text-slate-400">
          Image URL (optional)
          <input
            value={draft.imageUrl}
            onChange={(e) => set("imageUrl", e.target.value)}
            placeholder="https://example.com/image.png"
            maxLength={1000}
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
          />
        </label>
        {!isValidImageUrl(draft.imageUrl) && (
          <p className="mt-1 text-xs text-red-400">Must start with http:// or https://</p>
        )}
      </div>
      <div>
        <label className="mb-1 block text-xs text-slate-400">
          Thumbnail URL (optional)
          <input
            value={draft.thumbnailUrl}
            onChange={(e) => set("thumbnailUrl", e.target.value)}
            placeholder="https://example.com/thumbnail.png"
            maxLength={1000}
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
          />
        </label>
        {!isValidImageUrl(draft.thumbnailUrl) && (
          <p className="mt-1 text-xs text-red-400">Must start with http:// or https://</p>
        )}
      </div>
      <div>
        <label className="mb-1 block text-xs text-slate-400">
          Mention message (optional)
          <input
            value={draft.mentionMessage}
            onChange={(e) => set("mentionMessage", e.target.value)}
            placeholder="Hey {tag}, time!"
            maxLength={2000}
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
          />
        </label>
        <p className="mt-1 text-xs text-slate-500">
          Sent as a separate plain message above the embed. {"{tag}"} (or @tag) is replaced with the
          configured mention.
        </p>
      </div>

      <div>
        <div className="mb-1 text-xs text-slate-400">Preview</div>
        <DiscordEmbedPreview embed={embedDraftToInput(draft)} sample={sample ?? defaultPlaceholderSample()} />
      </div>
    </div>
  );
}
