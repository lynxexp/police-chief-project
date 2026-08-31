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

const fieldClass = "mt-1 w-full rounded-control border border-line bg-surface-sunken px-3 py-1.5 text-sm text-ink";

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
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className="mb-1 block text-xs text-ink-muted">Title</span>
          <input value={draft.title} onChange={(e) => set("title", e.target.value)} placeholder="%i %n at %e starts in %t!" maxLength={256} className={fieldClass} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-muted">Description</span>
          <textarea
            value={draft.description}
            onChange={(e) => set("description", e.target.value)}
            rows={3}
            placeholder="Get ready for Vault Trap! Only %t remaining."
            maxLength={4000}
            className={fieldClass}
          />
        </label>
        <p className="-mt-1 font-mono text-[11px] text-ink-faint">Placeholders: %t %n %e %d %i</p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className="mb-1 block text-xs text-ink-muted">Color</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(draft.colorHex) ? draft.colorHex : DEFAULT_COLOR_HEX}
                onChange={(e) => set("colorHex", e.target.value)}
                className="h-[34px] w-[34px] rounded-control border border-line"
              />
              <input value={draft.colorHex} onChange={(e) => set("colorHex", e.target.value)} placeholder="#5865F2" maxLength={7} className={`${fieldClass} mt-0 font-mono`} />
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-ink-muted">Footer</span>
            <input value={draft.footer} onChange={(e) => set("footer", e.target.value)} maxLength={2048} className={fieldClass} />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs text-ink-muted">Author</span>
          <input value={draft.author} onChange={(e) => set("author", e.target.value)} maxLength={256} className={fieldClass} />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-ink-muted">Image URL (optional)</span>
          <input value={draft.imageUrl} onChange={(e) => set("imageUrl", e.target.value)} placeholder="https://example.com/image.png" maxLength={1000} className={fieldClass} />
          {!isValidImageUrl(draft.imageUrl) && <p className="mt-1 text-xs text-down-ink">Must start with http:// or https://</p>}
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-ink-muted">Thumbnail URL (optional)</span>
          <input value={draft.thumbnailUrl} onChange={(e) => set("thumbnailUrl", e.target.value)} placeholder="https://example.com/thumbnail.png" maxLength={1000} className={fieldClass} />
          {!isValidImageUrl(draft.thumbnailUrl) && <p className="mt-1 text-xs text-down-ink">Must start with http:// or https://</p>}
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-ink-muted">Mention message (optional)</span>
          <input value={draft.mentionMessage} onChange={(e) => set("mentionMessage", e.target.value)} placeholder="Hey {tag}, time!" maxLength={2000} className={fieldClass} />
          <p className="mt-1 text-xs text-ink-faint">
            Sent as a separate plain message above the embed. {"{tag}"} (or @tag) is replaced with the configured mention.
          </p>
        </label>
      </div>

      <div className="lg:sticky lg:top-4 lg:h-fit">
        <p className="mb-1.5 font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">Preview</p>
        <DiscordEmbedPreview embed={embedDraftToInput(draft)} sample={sample ?? defaultPlaceholderSample()} />
      </div>
    </div>
  );
}
