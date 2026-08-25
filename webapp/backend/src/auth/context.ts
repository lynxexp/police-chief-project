/**
 * Resolves a session into "what can this person actually do" -- tier,
 * owner/global flags, and (for the Server-tier guild-scoping case) which
 * guild is currently active. Used by GET /api/auth/me and by every
 * admin-route preHandler (see routes/admin.ts, Stage C/D) so there is
 * exactly one place that turns "a discordId" into "a tier."
 *
 * Deliberately re-resolves everything live on every call -- nothing here
 * is cached beyond permissions.ts's own 5-second admin-table cache. See
 * the plan doc's "Auth" section for why the session itself never stores
 * the tier.
 */
import { allianceDb, usersDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";
import {
  getTier,
  isOwner as checkIsOwner,
  getAdminAllianceIds,
  TIER_SERVER,
  type Tier,
} from "./permissions.js";
import type { SessionRecord } from "./session.js";
import { getValidAccessToken } from "./session.js";
import { fetchDiscordGuilds, type DiscordGuild } from "./oauth.js";

export async function guildIdsWithAlliances(): Promise<Set<string>> {
  const rows = await allianceDb
    .selectFrom("alliance_list")
    .select(snowflake("discord_server_id").as("discord_server_id"))
    .where("discord_server_id", "is not", null)
    .execute();
  return new Set(
    rows.map((r) => r.discord_server_id).filter((id): id is string => id !== null),
  );
}

/** The live, current guilds a Server-tier admin can pick from: guilds
 * they actually belong to (via their stored OAuth token) intersected
 * with guilds that have an alliance registered at all. Shared by
 * resolveAuthContext (which only needs the count, to decide
 * needsGuildSelection) and GET /api/auth/guilds (which needs id+name for
 * the picker UI) so the intersection logic lives in exactly one place. */
export async function selectableGuilds(session: SessionRecord): Promise<DiscordGuild[]> {
  const [withAlliances, accessToken] = await Promise.all([
    guildIdsWithAlliances(),
    getValidAccessToken(session.id),
  ]);
  const userGuilds = await fetchDiscordGuilds(accessToken);
  return userGuilds.filter((g) => withAlliances.has(g.id));
}

export interface AuthContext {
  discordId: string;
  tier: Tier;
  isOwner: boolean;
  isGlobal: boolean;
  activeGuildId: string | null;
  /** True when this is a Server-tier admin who belongs to more than one
   * guild that has an alliance on it, and hasn't picked one yet -- the
   * frontend should route them to the guild-selection screen before
   * showing any admin page. Always false for member-only users and for
   * Owner/Global/Alliance tiers (guild-independent). */
  needsGuildSelection: boolean;
  availableGuildIds: string[];
}

export async function resolveAuthContext(session: SessionRecord): Promise<AuthContext> {
  const tier = await getTier(session.discordId);
  const owner = await checkIsOwner(session.discordId);
  const isGlobal = tier === "global" || owner;

  let needsGuildSelection = false;
  let availableGuildIds: string[] = [];

  if (tier === TIER_SERVER && session.activeGuildId === null) {
    // Server-tier has no adminserver rows -- its accessible alliances are
    // "whatever's on the current guild," and a web session has no guild
    // context handed to it for free the way a Discord interaction does.
    // If the caller belongs to (and can administer) more than one such
    // guild, the frontend needs to ask which one (GET /api/auth/guilds
    // powers that picker -- see routes/auth.ts).
    const guilds = await selectableGuilds(session);
    availableGuildIds = guilds.map((g) => g.id);
    needsGuildSelection = availableGuildIds.length > 1;
  }

  return {
    discordId: session.discordId,
    tier,
    isOwner: owner,
    isGlobal,
    activeGuildId: session.activeGuildId,
    needsGuildSelection,
    availableGuildIds,
  };
}

/** The guild_id to use for get_admin_alliance_ids-style calls: the
 * session's active guild if set, else 0 (matches the bot's own "no
 * guild" convention for DM-context interactions -- an Alliance/Global/
 * Owner tier never actually needs this value, only Server tier does, and
 * Server tier can't proceed past resolveAuthContext's needsGuildSelection
 * gate without one being set). */
export function effectiveGuildId(ctx: AuthContext): string {
  return ctx.activeGuildId ?? "0";
}

export async function accessibleAllianceIds(ctx: AuthContext): Promise<number[] | "all"> {
  if (ctx.isGlobal) return "all";
  const { allianceIds } = await getAdminAllianceIds(ctx.discordId, effectiveGuildId(ctx));
  return allianceIds;
}

/**
 * Member-view access check: per the plan doc's "alliance-open" data
 * model, member performance data (roster, trends, leaderboards) is
 * visible to any member of that alliance, not just to admins managing
 * it -- so this is broader than accessibleAllianceIds/canManageAlliance.
 * Grants access if the caller can *manage* the alliance (any admin tier
 * with reach here), OR if they're simply a member of it themselves (has
 * at least one linked fid with this alliance id, active or not -- see
 * _linked_fids_for's lack of an is_active filter, which this mirrors).
 */
export async function canViewAlliance(ctx: AuthContext, allianceId: number): Promise<boolean> {
  const ids = await accessibleAllianceIds(ctx);
  if (ids === "all" || ids.includes(allianceId)) return true;

  const row = await usersDb
    .selectFrom("users")
    .select("fid")
    .where("discord_id", "=", ctx.discordId)
    .where("alliance", "=", String(allianceId))
    .executeTakeFirst();
  return Boolean(row);
}

/**
 * Guild-wide settings access (Notifications, Theming, ID channel scan
 * config, Bot ops) -- NOT the same as canManageAlliance. getAdminAllianceIds
 * does not filter an Alliance-tier admin's assigned alliances by guild (only
 * the Server-tier fallback branch does), so naively reusing it would let an
 * Alliance-tier admin on Guild A reach guild-wide config for an unrelated
 * Guild B. Per the Phase 2 plan doc: restrict guild-wide settings to Server
 * tier and above -- an Alliance-tier admin's scope is one alliance's data,
 * not server-wide config. Purely synchronous: everything needed is already
 * on ctx (a Server-tier admin's scope IS their activeGuildId, once set).
 */
export function canManageGuild(ctx: AuthContext, guildId: string): boolean {
  if (ctx.isGlobal) return true;
  return ctx.tier === TIER_SERVER && ctx.activeGuildId === guildId;
}

// Re-exported for routes that need to fetch the live guild list for the
// guild-selection screen (uses the caller's OAuth token, not alliance_list).
export { fetchDiscordGuilds };
