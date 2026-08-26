/**
 * Shared embed-message helpers -- originally lived only in
 * routes/notifications.ts (Stage 7e), extracted so routes/customEvents.ts
 * can reuse the exact same encoding when a custom event's message is an
 * embed.
 */
import { eventsDb } from "../db/connections.js";

// vault_notification_embeds columns -- see EmbedEditorView's per-field
// modals in cogs/notification_system.py for these exact max lengths and
// the http(s)-only URL guard on image/thumbnail.
export const embedSchema = {
  type: "object",
  properties: {
    title: { type: ["string", "null"], maxLength: 256 },
    description: { type: ["string", "null"], maxLength: 4000 },
    color: { type: ["integer", "null"], minimum: 0, maximum: 16777215 },
    imageUrl: { type: ["string", "null"], pattern: "^https?://" },
    thumbnailUrl: { type: ["string", "null"], pattern: "^https?://" },
    footer: { type: ["string", "null"], maxLength: 2048 },
    author: { type: ["string", "null"], maxLength: 256 },
    mentionMessage: { type: ["string", "null"], maxLength: 2000 },
  },
} as const;

export interface EmbedInput {
  title?: string | null;
  description?: string | null;
  color?: number | null;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  footer?: string | null;
  author?: string | null;
  mentionMessage?: string | null;
}

/** Builds the stored `description` column value for either message
 * kind -- mirrors save_notification()/update_notification() exactly:
 * plain text stored as-is; embed mode stores the "EMBED_MESSAGE:<title>"
 * sentinel, falling back to the literal string "true" when the embed
 * has no title (matching `embed_data.get("title", "true")`). The real
 * embed content lives in vault_notification_embeds -- see
 * writeEmbedRow() below. */
export function buildDescription(
  messageKind: "plain" | "embed" | undefined,
  description: string | undefined,
  embed: EmbedInput | undefined,
): string {
  if (messageKind === "embed") {
    return `EMBED_MESSAGE:${embed?.title || "true"}`;
  }
  return description!;
}

/** Delete-then-insert, matching update_notification()'s
 * `DELETE FROM vault_notification_embeds WHERE notification_id = ?`
 * followed by a fresh save_notification_embed() call -- safe to call
 * unconditionally on create too (the delete is just a no-op there). */
export async function writeEmbedRow(notificationId: number, embed: EmbedInput): Promise<void> {
  await eventsDb.deleteFrom("vault_notification_embeds").where("notification_id", "=", notificationId).execute();
  await eventsDb
    .insertInto("vault_notification_embeds")
    .values({
      notification_id: notificationId,
      title: embed.title ?? null,
      description: embed.description ?? null,
      color: embed.color ?? null,
      image_url: embed.imageUrl ?? null,
      thumbnail_url: embed.thumbnailUrl ?? null,
      footer: embed.footer ?? null,
      author: embed.author ?? null,
      mention_message: embed.mentionMessage ?? null,
    })
    .execute();
}
