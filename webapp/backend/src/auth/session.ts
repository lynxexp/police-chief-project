/**
 * webapp.sqlite-backed session store. Deliberately hand-written and small
 * rather than pulling in a generic session-store package -- the schema is
 * one table (see db/schema.ts SessionsTable / db/connections.ts
 * initWebappSchema), and the only two ways a session is ever consulted
 * are "look up by id" and "create a fresh one on login."
 *
 * The session intentionally stores ONLY discordId (+ optional
 * activeGuildId for the Server-tier guild-selection flow) for
 * AUTHORIZATION purposes -- never a cached permission tier. See
 * auth/permissions.ts and the plan doc's "Auth" section for why: tier is
 * re-resolved live on every request via the same 5s admin-table cache
 * the Python bot already uses, so a demotion takes effect almost
 * immediately instead of lingering for the life of the session.
 *
 * It ALSO stores the Discord OAuth access/refresh token pair -- not for
 * authorization (never trusted for that), only so GET /api/auth/guilds
 * can re-derive the caller's live Discord guild membership later,
 * without forcing a re-login every time the Server-tier guild-selection
 * screen needs it.
 */
import { randomBytes } from "node:crypto";
import { webappDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";
import { refreshAccessToken, type DiscordTokenResponse } from "./oauth.js";

const SESSION_ID_BYTES = 32;
const IDLE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days sliding
const ABSOLUTE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days hard cap
const TOKEN_REFRESH_SKEW_MS = 60 * 1000; // refresh a bit before actual expiry

export interface SessionRecord {
  id: string;
  discordId: string;
  activeGuildId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

function newSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString("base64url");
}

export async function createSession(
  discordId: string,
  tokens: DiscordTokenResponse,
): Promise<SessionRecord> {
  const id = newSessionId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + IDLE_EXPIRY_MS);
  const tokenExpiresAt = new Date(now.getTime() + tokens.expires_in * 1000);

  await webappDb
    .insertInto("sessions")
    .values({
      id,
      discord_id: discordId,
      active_guild_id: null,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: tokenExpiresAt.toISOString(),
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .execute();

  return { id, discordId, activeGuildId: null, createdAt: now, expiresAt };
}

/**
 * Look up a session by id. Returns null if missing or expired (and
 * opportunistically deletes it if expired, rather than leaving dead rows
 * around indefinitely). On success, slides the idle expiry forward
 * (capped at the absolute expiry from creation) so an active user never
 * gets logged out mid-session.
 */
export async function getSession(id: string): Promise<SessionRecord | null> {
  const row = await webappDb
    .selectFrom("sessions")
    .select([
      "id",
      snowflake("discord_id").as("discord_id"),
      snowflake("active_guild_id").as("active_guild_id"),
      "created_at",
      "expires_at",
    ])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;

  const now = new Date();
  const expiresAt = new Date(row.expires_at);
  if (expiresAt <= now) {
    await webappDb.deleteFrom("sessions").where("id", "=", id).execute();
    return null;
  }

  const createdAt = new Date(row.created_at);
  const absoluteCap = new Date(createdAt.getTime() + ABSOLUTE_EXPIRY_MS);
  const slidExpiry = new Date(
    Math.min(now.getTime() + IDLE_EXPIRY_MS, absoluteCap.getTime()),
  );
  if (slidExpiry.getTime() !== expiresAt.getTime()) {
    await webappDb
      .updateTable("sessions")
      .set({ expires_at: slidExpiry.toISOString() })
      .where("id", "=", id)
      .execute();
  }

  return {
    id: row.id,
    discordId: row.discord_id!, // NOT NULL column; CAST(x AS TEXT) is only nullable in the type
    activeGuildId: row.active_guild_id,
    createdAt,
    expiresAt: slidExpiry,
  };
}

/**
 * Returns a live Discord access token for this session, transparently
 * refreshing (and persisting the new pair) if the stored one has expired
 * or is about to. Only called from the guild-selection flow -- never on
 * the hot path of every request.
 */
export async function getValidAccessToken(sessionId: string): Promise<string> {
  const row = await webappDb
    .selectFrom("sessions")
    .select(["access_token", "refresh_token", "token_expires_at"])
    .where("id", "=", sessionId)
    .executeTakeFirst();
  if (!row) {
    throw new Error(`getValidAccessToken: no session ${sessionId}`);
  }

  const expiresAt = new Date(row.token_expires_at).getTime();
  if (Date.now() < expiresAt - TOKEN_REFRESH_SKEW_MS) {
    return row.access_token;
  }

  const refreshed = await refreshAccessToken(row.refresh_token);
  const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
  await webappDb
    .updateTable("sessions")
    .set({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      token_expires_at: newExpiresAt.toISOString(),
    })
    .where("id", "=", sessionId)
    .execute();

  return refreshed.access_token;
}

export async function setActiveGuild(id: string, guildId: string | null): Promise<void> {
  await webappDb
    .updateTable("sessions")
    .set({ active_guild_id: guildId })
    .where("id", "=", id)
    .execute();
}

export async function destroySession(id: string): Promise<void> {
  await webappDb.deleteFrom("sessions").where("id", "=", id).execute();
}

/** Called periodically (or opportunistically on login) to purge expired
 * rows so the table doesn't grow unbounded. Cheap enough to run on every
 * login given the expected scale of this app. */
export async function pruneExpiredSessions(): Promise<number> {
  const result = await webappDb
    .deleteFrom("sessions")
    .where("expires_at", "<=", new Date().toISOString())
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
