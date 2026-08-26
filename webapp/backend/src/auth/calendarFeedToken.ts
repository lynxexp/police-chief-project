/**
 * Per-user tokens for the subscribable .ics calendar feed (see
 * routes/calendarFeed.ts). One token per Discord user, not per alliance --
 * matches the interactive calendar page's own access model (log in once,
 * browse any alliance canViewAlliance grants you). The token exists
 * because a calendar app (Google/Apple/Outlook) refetches its subscribed
 * URL on its own schedule with no cookie support at all, so it can't use
 * the normal session-cookie auth every other route relies on.
 */
import { randomBytes } from "node:crypto";
import { webappDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";

function newToken(): string {
  // 32 bytes -> 43 base64url chars -- long enough that guessing one is
  // infeasible, short enough to sit comfortably in a URL a user might
  // copy/paste into a calendar app's "subscribe by URL" field.
  return randomBytes(32).toString("base64url");
}

/** Returns this user's existing feed token, minting one on first call. */
export async function getOrCreateFeedToken(discordId: string): Promise<string> {
  const existing = await webappDb
    .selectFrom("calendar_feed_tokens")
    .select("token")
    .where("discord_id", "=", discordId)
    .executeTakeFirst();
  if (existing) return existing.token;

  const token = newToken();
  await webappDb
    .insertInto("calendar_feed_tokens")
    .values({ discord_id: discordId, token, created_at: new Date().toISOString() })
    .execute();
  return token;
}

/** Replaces this user's token with a fresh one -- the old URL stops
 * working immediately, for when a subscribe link has leaked or a device
 * it was on is no longer trusted. */
export async function regenerateFeedToken(discordId: string): Promise<string> {
  const token = newToken();
  await webappDb
    .insertInto("calendar_feed_tokens")
    .values({ discord_id: discordId, token, created_at: new Date().toISOString() })
    .onConflict((oc) => oc.column("discord_id").doUpdateSet({ token, created_at: new Date().toISOString() }))
    .execute();
  return token;
}

/** Reverse lookup for the feed route itself: which user does this token
 * belong to, if any. Returns null for an unknown/revoked token rather
 * than throwing, so the caller can respond with a plain 401/404. */
export async function discordIdForFeedToken(token: string): Promise<string | null> {
  if (!token) return null;
  const row = await webappDb
    .selectFrom("calendar_feed_tokens")
    .select(snowflake("discord_id").as("discord_id"))
    .where("token", "=", token)
    .executeTakeFirst();
  return row?.discord_id ?? null;
}
