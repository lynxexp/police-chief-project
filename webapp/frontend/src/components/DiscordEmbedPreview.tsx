/**
 * Renders a Discord-style embed card, mirroring
 * cogs/notification_system.py's EmbedEditorView.update_embed() exactly:
 * same sample placeholder values, same substitution list (%t/{time},
 * %n, %e, %d, %i for title/description/footer/author; mentionMessage
 * additionally substitutes @tag/{tag} -- see the Python source's
 * check_mention_placeholder_misuse doc comment, both spellings work).
 *
 * Per the Phase 2 plan doc's "shared <DiscordEmbedPreview>" decision --
 * built for the notification embed builder first (Stage 7e); `fields`
 * support added for Stage 8's theming icon preview
 * (cogs/pimp_my_bot_preview.py's 5 example pages use embed fields
 * heavily), which is the general-purpose reuse the plan doc called for.
 */

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface EmbedPreviewData {
  title?: string | null;
  description?: string | null;
  color?: number | null;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  footer?: string | null;
  author?: string | null;
  mentionMessage?: string | null;
  fields?: EmbedField[];
}

export interface PlaceholderSample {
  eventName: string;
  eventIcon: string;
  eventTime: string;
  eventDate: string;
  timeRemaining: string;
  mentionText: string;
}

export function defaultPlaceholderSample(overrides: Partial<PlaceholderSample> = {}): PlaceholderSample {
  return {
    eventName: "Event",
    eventIcon: "📅",
    eventTime: "00:00",
    eventDate: "Dec 06",
    timeRemaining: "30 minutes",
    mentionText: "@here",
    ...overrides,
  };
}

/** Mirrors EmbedEditorView.update_embed()'s replace_variables() -- does
 * NOT touch @tag/{tag}, that's mention-message-only (see below). */
function substitutePlaceholders(text: string, sample: PlaceholderSample): string {
  return text
    .replaceAll("%t", sample.timeRemaining)
    .replaceAll("{time}", sample.timeRemaining)
    .replaceAll("%n", sample.eventName)
    .replaceAll("%e", sample.eventTime)
    .replaceAll("%d", sample.eventDate)
    .replaceAll("%i", sample.eventIcon);
}

/** Mirrors the actual send path's mention_message handling (lines
 * ~1256-1268 of notification_system.py): tag placeholders substituted
 * IN ADDITION to the standard ones, and prepended with the mention if
 * neither placeholder was used. */
function substituteMentionMessage(text: string, sample: PlaceholderSample): string {
  let result = text;
  if (result.includes("@tag") || result.includes("{tag}")) {
    result = result.replaceAll("@tag", sample.mentionText).replaceAll("{tag}", sample.mentionText);
  } else {
    result = `${sample.mentionText} ${result}`;
  }
  return substitutePlaceholders(result, sample);
}

const DEFAULT_COLOR = 0x5865f2; // Discord's blurple -- closest to discord.Color.blue() for preview purposes

export default function DiscordEmbedPreview({
  embed,
  sample,
  applyPlaceholders = true,
}: {
  embed: EmbedPreviewData;
  sample?: PlaceholderSample;
  /** Read-only display of a real (already-sent) embed doesn't need
   * placeholder substitution -- the stored text is what it is. */
  applyPlaceholders?: boolean;
}) {
  const s = sample ?? defaultPlaceholderSample();
  const render = (text: string | null | undefined) =>
    !text ? null : applyPlaceholders ? substitutePlaceholders(text, s) : text;
  const mentionPreview = embed.mentionMessage
    ? applyPlaceholders
      ? substituteMentionMessage(embed.mentionMessage, s)
      : embed.mentionMessage
    : null;
  const color = embed.color ?? DEFAULT_COLOR;
  const hexColor = `#${color.toString(16).padStart(6, "0")}`;

  return (
    <div className="max-w-lg">
      {mentionPreview && <div className="mb-1 text-sm text-slate-300">{mentionPreview}</div>}
      <div className="flex rounded-md bg-[#2b2d31] text-sm text-[#dbdee1]" style={{ fontFamily: "inherit" }}>
        <div className="w-1 shrink-0 rounded-l-md" style={{ backgroundColor: hexColor }} />
        <div className="flex min-w-0 flex-1 gap-3 p-3">
          <div className="min-w-0 flex-1">
            {render(embed.author) && <div className="mb-1 text-xs font-medium text-[#dbdee1]">{render(embed.author)}</div>}
            {render(embed.title) && <div className="mb-1 font-semibold text-white">{render(embed.title)}</div>}
            {render(embed.description) && (
              <div className="whitespace-pre-wrap text-[#dbdee1]">{render(embed.description)}</div>
            )}
            {embed.fields && embed.fields.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                {embed.fields.map((field, i) => (
                  <div key={i} className={field.inline ? "min-w-[30%] flex-1" : "w-full"}>
                    <div className="mb-0.5 font-semibold text-white">{render(field.name)}</div>
                    <div className="whitespace-pre-wrap text-[#dbdee1]">{render(field.value)}</div>
                  </div>
                ))}
              </div>
            )}
            {embed.imageUrl && (
              <img src={embed.imageUrl} alt="" className="mt-2 max-h-64 max-w-full rounded" />
            )}
            {render(embed.footer) && <div className="mt-2 text-xs text-[#949ba4]">{render(embed.footer)}</div>}
          </div>
          {embed.thumbnailUrl && (
            <img src={embed.thumbnailUrl} alt="" className="h-20 w-20 shrink-0 rounded object-cover" />
          )}
        </div>
      </div>
    </div>
  );
}
