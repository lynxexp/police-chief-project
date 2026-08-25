/**
 * Discord OAuth2 Authorization Code + PKCE flow. Reuses the SAME Discord
 * Application the bot token belongs to (see docs/webapp-setup.md) --
 * this is a second credential (Client ID/Secret) on that one application,
 * not a separate Discord app.
 */
import { randomBytes, createHash } from "node:crypto";
import { config } from "../config.js";

const DISCORD_API = "https://discord.com/api/v10";

export interface PkceState {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

function base64url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generatePkce(): PkceState {
  const state = base64url(randomBytes(24));
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  return { state, codeVerifier, codeChallenge };
}

export function buildAuthorizeUrl(pkce: PkceState): string {
  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: config.discord.redirectUri,
    response_type: "code",
    scope: "identify guilds",
    state: pkce.state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.discord.clientId,
    client_secret: config.discord.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.discord.redirectUri,
    code_verifier: codeVerifier,
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as DiscordTokenResponse;
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.discord.clientId,
    client_secret: config.discord.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as DiscordTokenResponse;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Discord /users/@me failed (${res.status})`);
  }
  return (await res.json()) as DiscordUser;
}

export interface DiscordGuild {
  id: string;
  name: string;
}

/** The caller's mutual guilds -- used only to resolve Server-tier's
 * "which guild" ambiguity (see auth/permissions.ts's guild-scoping note
 * and routes/auth.ts's /guilds endpoint). Requires the `guilds` scope. */
export async function fetchDiscordGuilds(accessToken: string): Promise<DiscordGuild[]> {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Discord /users/@me/guilds failed (${res.status})`);
  }
  return (await res.json()) as DiscordGuild[];
}

/** Bot-token-authenticated channel list for a guild -- used by the admin
 * channel-setup picker (OAuth's `guilds` scope doesn't expose channels).
 * Read-only; the bot token is only ever used here and in
 * fetchDiscordUserById below, never for anything write-capable. */
export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

export async function fetchGuildChannels(guildId: string): Promise<DiscordChannel[]> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${config.discord.botToken}` },
  });
  if (!res.ok) {
    throw new Error(`Discord /guilds/${guildId}/channels failed (${res.status})`);
  }
  return (await res.json()) as DiscordChannel[];
}

/** Bot-token-authenticated public profile lookup by id -- used to show
 * display names in the admin/permissions UI (list of admins, audit log
 * actor/target), mirroring what bot_main_menu.py's _resolve_user_name
 * does via the gateway cache. Returns null (never throws) on a lookup
 * failure -- a missing/unresolvable name shouldn't break the whole page,
 * the UI just falls back to showing the raw id. */
export async function fetchDiscordUserById(discordId: string): Promise<DiscordUser | null> {
  const res = await fetch(`${DISCORD_API}/users/${discordId}`, {
    headers: { Authorization: `Bot ${config.discord.botToken}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as DiscordUser;
}
