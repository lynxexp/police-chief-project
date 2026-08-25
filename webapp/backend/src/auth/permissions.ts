/**
 * Line-by-line TypeScript port of cogs/permission_handler.py's
 * PermissionManager. Every function here must produce identical results
 * to its Python counterpart given the same database state -- this is the
 * one piece of logic that MUST agree between the bot and the web app,
 * since both are now valid places to check "can this user do X."
 *
 * Deliberately NOT a class with static methods (unlike the Python
 * version) -- there's no reason to carry that around in a language with
 * plain module-level functions; the public API is otherwise a 1:1
 * mirror, including the same in-memory admin-table cache and 5-second
 * TTL the Python side uses (permission_handler.py:36-52), so a
 * permission change made via Discord takes effect on the web within the
 * same bound it already takes effect in Discord.
 */
import { settingsDb, allianceDb, usersDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";

export const TIER_OWNER = "owner" as const;
export const TIER_GLOBAL = "global" as const;
export const TIER_SERVER = "server" as const;
export const TIER_ALLIANCE = "alliance" as const;
export const TIER_NONE = "none" as const;

export type Tier =
  | typeof TIER_OWNER
  | typeof TIER_GLOBAL
  | typeof TIER_SERVER
  | typeof TIER_ALLIANCE
  | typeof TIER_NONE;

const ADMIN_CACHE_TTL_MS = 5_000;
let adminCache: Map<string, boolean> | null = null; // id -> is_initial
let adminCacheAt = 0;

async function adminMap(): Promise<Map<string, boolean>> {
  const now = Date.now();
  if (adminCache === null || now - adminCacheAt > ADMIN_CACHE_TTL_MS) {
    const rows = await settingsDb
      .selectFrom("admin")
      .select([snowflake("id").as("id"), "is_initial"])
      .execute();
    adminCache = new Map(rows.map((r) => [r.id!, Boolean(r.is_initial)]));
    adminCacheAt = now;
  }
  return adminCache;
}

/** Test-only escape hatch -- forces the next adminMap() call to re-query. */
export function _invalidateAdminCacheForTests(): void {
  adminCache = null;
  adminCacheAt = 0;
}

export interface IsAdminResult {
  isAdmin: boolean;
  isGlobal: boolean;
}

export async function isAdmin(userId: string): Promise<IsAdminResult> {
  const map = await adminMap();
  if (!map.has(userId)) return { isAdmin: false, isGlobal: false };
  return { isAdmin: true, isGlobal: map.get(userId) === true };
}

export interface AdminAllianceIdsResult {
  allianceIds: number[];
  isGlobal: boolean;
}

/** Empty allianceIds + isGlobal=true means "all alliances", matching the
 * Python return convention exactly (`([], True)`). */
export async function getAdminAllianceIds(
  userId: string,
  guildId: string,
): Promise<AdminAllianceIdsResult> {
  const { isAdmin: admin, isGlobal } = await isAdmin(userId);
  if (!admin) return { allianceIds: [], isGlobal: false };
  if (isGlobal) return { allianceIds: [], isGlobal: true };

  const assignedRows = await settingsDb
    .selectFrom("adminserver")
    .select("alliances_id")
    .where("admin", "=", userId)
    .execute();
  const assigned = assignedRows.map((r) => r.alliances_id);

  if (assigned.length > 0) {
    return { allianceIds: assigned, isGlobal: false };
  }

  const serverRows = await allianceDb
    .selectFrom("alliance_list")
    .select("alliance_id")
    .where("discord_server_id", "=", guildId)
    .execute();
  return { allianceIds: serverRows.map((r) => r.alliance_id), isGlobal: false };
}

export interface AllianceOption {
  allianceId: number;
  name: string | null;
}

export interface AdminAlliancesResult {
  alliances: AllianceOption[];
  isGlobal: boolean;
}

export async function getAdminAlliances(
  userId: string,
  guildId: string,
): Promise<AdminAlliancesResult> {
  const { isAdmin: admin, isGlobal } = await isAdmin(userId);
  if (!admin) return { alliances: [], isGlobal: false };

  if (isGlobal) {
    const rows = await allianceDb
      .selectFrom("alliance_list")
      .select(["alliance_id", "name"])
      .orderBy("name")
      .execute();
    return {
      alliances: rows.map((r) => ({ allianceId: r.alliance_id, name: r.name })),
      isGlobal: true,
    };
  }

  const assignedRows = await settingsDb
    .selectFrom("adminserver")
    .select("alliances_id")
    .where("admin", "=", userId)
    .execute();
  const assignedIds = assignedRows.map((r) => r.alliances_id);

  if (assignedIds.length > 0) {
    const rows = await allianceDb
      .selectFrom("alliance_list")
      .select(["alliance_id", "name"])
      .where("alliance_id", "in", assignedIds)
      .orderBy("name")
      .execute();
    return {
      alliances: rows.map((r) => ({ allianceId: r.alliance_id, name: r.name })),
      isGlobal: false,
    };
  }

  const rows = await allianceDb
    .selectFrom("alliance_list")
    .select(["alliance_id", "name"])
    .where("discord_server_id", "=", guildId)
    .orderBy("name")
    .execute();
  return {
    alliances: rows.map((r) => ({ allianceId: r.alliance_id, name: r.name })),
    isGlobal: false,
  };
}

/** Pure predicate: is this user an admin (any tier) with access to this
 * specific alliance -- Alliance Admin tier or higher for that alliance.
 * The one shared "can manage this alliance" check, mirroring
 * permission_handler.py:156-174 exactly. */
export async function canManageAlliance(
  userId: string,
  guildId: string,
  allianceId: number,
): Promise<boolean> {
  const { isAdmin: admin, isGlobal } = await isAdmin(userId);
  if (isGlobal) return true;
  if (admin) {
    const { allianceIds } = await getAdminAllianceIds(userId, guildId);
    return allianceIds.includes(allianceId);
  }
  return false;
}

export interface AdminUserRow {
  fid: number;
  nickname: string | null;
  alliance: string | null;
}

export async function getAdminUsers(
  userId: string,
  guildId: string,
): Promise<AdminUserRow[]> {
  const { isAdmin: admin, isGlobal } = await isAdmin(userId);
  if (!admin) return [];

  if (isGlobal) {
    const rows = await usersDb
      .selectFrom("users")
      .select(["fid", "nickname", "alliance"])
      .execute();
    return sortByNicknameLower(rows);
  }

  const { allianceIds } = await getAdminAllianceIds(userId, guildId);
  if (allianceIds.length === 0) return [];

  const rows = await usersDb
    .selectFrom("users")
    .select(["fid", "nickname", "alliance"])
    .where("alliance", "in", allianceIds.map(String))
    .execute();
  return sortByNicknameLower(rows);
}

function sortByNicknameLower<T extends { nickname: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    (a.nickname ?? "").toLowerCase().localeCompare((b.nickname ?? "").toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// Owner / tier helpers
// ---------------------------------------------------------------------------

export async function listAlliances(): Promise<AllianceOption[]> {
  const rows = await allianceDb
    .selectFrom("alliance_list")
    .select(["alliance_id", "name"])
    .orderBy((eb) => eb.fn("LOWER", ["name"]))
    .execute();
  return rows.map((r) => ({ allianceId: r.alliance_id, name: r.name }));
}

export async function getAdminAllianceAssignments(userId: string): Promise<number[]> {
  const rows = await settingsDb
    .selectFrom("adminserver")
    .select("alliances_id")
    .where("admin", "=", userId)
    .execute();
  return rows.map((r) => r.alliances_id);
}

export async function isOwner(userId: string): Promise<boolean> {
  const row = await settingsDb
    .selectFrom("admin")
    .select("is_owner")
    .where("id", "=", userId)
    .executeTakeFirst();
  return Boolean(row?.is_owner);
}

export async function getOwnerId(): Promise<string | null> {
  const row = await settingsDb
    .selectFrom("admin")
    .select(snowflake("id").as("id"))
    .where("is_owner", "=", 1)
    .executeTakeFirst();
  return row ? row.id : null;
}

export async function countGlobals(): Promise<number> {
  const row = await settingsDb
    .selectFrom("admin")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("is_initial", "=", 1)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export interface AdminListEntry {
  id: string;
  tier: Tier;
  isInitial: boolean;
  isOwner: boolean;
  allianceCount: number;
}

export async function listAdmins(): Promise<AdminListEntry[]> {
  const rows = await settingsDb
    .selectFrom("admin as a")
    .select((eb) => [
      snowflake("a.id").as("id"),
      "a.is_initial",
      "a.is_owner",
      eb
        .selectFrom("adminserver as s")
        .select((e2) => e2.fn.countAll<number>().as("count"))
        .whereRef("s.admin", "=", "a.id")
        .as("alliance_count"),
    ])
    // a.id is now a TEXT expression (via CAST), not the raw column -- order
    // by the underlying column via a subquery-free ref would need the raw
    // name, but since is_owner/is_initial already fully determine sort
    // order among realistic admin counts, ordering by the cast alias is
    // fine (lexicographic on equal-length numeric strings sorts the same
    // as numeric order; Discord snowflakes are monotonically increasing
    // length-stable within the id space this app will ever see).
    .orderBy("a.is_owner", "desc")
    .orderBy("a.is_initial", "desc")
    .orderBy("id", "asc")
    .execute();

  return rows.map((r) => {
    const allianceCount = Number(r.alliance_count ?? 0);
    let tier: Tier;
    if (r.is_owner) tier = TIER_OWNER;
    else if (r.is_initial) tier = TIER_GLOBAL;
    else if (allianceCount) tier = TIER_ALLIANCE;
    else tier = TIER_SERVER;
    return {
      id: r.id!,
      tier,
      isInitial: Boolean(r.is_initial),
      isOwner: Boolean(r.is_owner),
      allianceCount,
    };
  });
}

export async function getTier(userId: string): Promise<Tier> {
  const row = await settingsDb
    .selectFrom("admin as a")
    .select((eb) => [
      "a.is_initial",
      "a.is_owner",
      eb
        .selectFrom("adminserver as s")
        .select((e2) => e2.fn.countAll<number>().as("count"))
        .whereRef("s.admin", "=", "a.id")
        .as("alliance_count"),
    ])
    .where("a.id", "=", userId)
    .executeTakeFirst();

  if (!row) return TIER_NONE;
  if (row.is_owner) return TIER_OWNER;
  if (row.is_initial) return TIER_GLOBAL;
  return Number(row.alliance_count ?? 0) > 0 ? TIER_ALLIANCE : TIER_SERVER;
}

export class PermissionError extends Error {}

export interface AddAdminOptions {
  tier: Tier;
  allianceIds?: number[];
}

/** Insert a new admin. If no owner exists yet (brand-new install), the
 * first admin auto-becomes owner regardless of the requested tier -- the
 * bot/app can't be useful without one. Mirrors
 * permission_handler.py:316-348 exactly, including that edge case. */
export async function addAdmin(userId: string, opts: AddAdminOptions): Promise<void> {
  const { tier, allianceIds } = opts;
  const validTiers: readonly Tier[] = [TIER_OWNER, TIER_GLOBAL, TIER_SERVER, TIER_ALLIANCE];
  if (!validTiers.includes(tier)) {
    throw new PermissionError(`Unknown tier: ${tier}`);
  }
  if (tier === TIER_ALLIANCE && (!allianceIds || allianceIds.length === 0)) {
    throw new PermissionError("Alliance tier requires at least one alliance_id");
  }

  await settingsDb.transaction().execute(async (trx) => {
    const countRow = await trx
      .selectFrom("admin")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    const totalAdmins = Number(countRow.count);

    const isInitialFlag = tier === TIER_OWNER || tier === TIER_GLOBAL;
    let isOwnerFlag = tier === TIER_OWNER || totalAdmins === 0;
    const finalIsInitial = isOwnerFlag ? true : isInitialFlag;

    await trx
      .insertInto("admin")
      .values({
        id: userId,
        is_initial: finalIsInitial ? 1 : 0,
        is_owner: isOwnerFlag ? 1 : 0,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          is_initial: finalIsInitial ? 1 : 0,
          is_owner: isOwnerFlag ? 1 : 0,
        }),
      )
      .execute();

    if (tier === TIER_ALLIANCE) {
      for (const aid of allianceIds ?? []) {
        await trx
          .insertInto("adminserver")
          .values({ admin: userId, alliances_id: aid })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    }
  });

  _invalidateAdminCacheForTests();
}

export interface SetTierOptions {
  allianceIds?: number[];
}

/** Change an existing admin's tier. Owner tier is never settable here --
 * use transferOwner instead. Mirrors permission_handler.py:350-378. */
export async function setTier(
  userId: string,
  tier: Tier,
  opts: SetTierOptions = {},
): Promise<void> {
  if (tier === TIER_OWNER) {
    throw new PermissionError("Use transferOwner() to change the bot owner");
  }
  const validTiers: readonly Tier[] = [TIER_GLOBAL, TIER_SERVER, TIER_ALLIANCE];
  if (!validTiers.includes(tier)) {
    throw new PermissionError(`Unknown tier: ${tier}`);
  }
  const allianceIds = opts.allianceIds;
  if (tier === TIER_ALLIANCE && (!allianceIds || allianceIds.length === 0)) {
    throw new PermissionError("Alliance tier requires at least one alliance_id");
  }

  await settingsDb.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("admin")
      .select("is_owner")
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!row) {
      throw new PermissionError(`User ${userId} is not an admin`);
    }
    if (row.is_owner) {
      throw new PermissionError("Cannot demote the bot owner; transfer ownership first");
    }

    await trx
      .updateTable("admin")
      .set({ is_initial: tier === TIER_GLOBAL ? 1 : 0 })
      .where("id", "=", userId)
      .execute();

    await trx.deleteFrom("adminserver").where("admin", "=", userId).execute();

    if (tier === TIER_ALLIANCE) {
      for (const aid of allianceIds ?? []) {
        await trx
          .insertInto("adminserver")
          .values({ admin: userId, alliances_id: aid })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    }
  });

  _invalidateAdminCacheForTests();
}

/** Delete an admin and all their alliance assignments. Owner is guarded.
 * Mirrors permission_handler.py:380-392. */
export async function removeAdmin(userId: string): Promise<void> {
  await settingsDb.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("admin")
      .select("is_owner")
      .where("id", "=", userId)
      .executeTakeFirst();
    if (row?.is_owner) {
      throw new PermissionError("Cannot remove the bot owner; transfer ownership first");
    }
    await trx.deleteFrom("adminserver").where("admin", "=", userId).execute();
    await trx.deleteFrom("admin").where("id", "=", userId).execute();
  });

  _invalidateAdminCacheForTests();
}

/** Atomic "first global admin to claim wins" flow. Mirrors
 * permission_handler.py:394-411. */
export async function claimOwner(userId: string): Promise<boolean> {
  return settingsDb.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom("admin")
      .select("id")
      .where("is_owner", "=", 1)
      .executeTakeFirst();
    if (existing) return false;

    const result = await trx
      .updateTable("admin")
      .set({ is_owner: 1, is_initial: 1 })
      .where("id", "=", userId)
      .where("is_initial", "=", 1)
      .executeTakeFirst();

    const changed = Number(result.numUpdatedRows) > 0;
    if (changed) _invalidateAdminCacheForTests();
    return changed;
  });
}

/** Move the is_owner flag atomically. Both must be admins; the recipient
 * must already be Global tier. Mirrors permission_handler.py:413-431. */
export async function transferOwner(fromUserId: string, toUserId: string): Promise<void> {
  await settingsDb.transaction().execute(async (trx) => {
    const fromRow = await trx
      .selectFrom("admin")
      .select("is_owner")
      .where("id", "=", fromUserId)
      .executeTakeFirst();
    if (!fromRow?.is_owner) {
      throw new PermissionError("Source user is not the current owner");
    }

    const toRow = await trx
      .selectFrom("admin")
      .select("is_initial")
      .where("id", "=", toUserId)
      .executeTakeFirst();
    if (!toRow) {
      throw new PermissionError("Target user is not an admin");
    }
    if (!toRow.is_initial) {
      throw new PermissionError("Target user must be Global tier before receiving ownership");
    }

    await trx.updateTable("admin").set({ is_owner: 0 }).where("id", "=", fromUserId).execute();
    await trx.updateTable("admin").set({ is_owner: 1 }).where("id", "=", toUserId).execute();
  });

  _invalidateAdminCacheForTests();
}

/** Human-readable admin state for the audit log. Mirrors
 * permission_handler.py:433-452. */
export async function describeState(userId: string): Promise<string> {
  const row = await settingsDb
    .selectFrom("admin")
    .select(["is_initial", "is_owner"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!row) return "Not an admin";

  const allianceRows = await settingsDb
    .selectFrom("adminserver")
    .select("alliances_id")
    .where("admin", "=", userId)
    .orderBy("alliances_id")
    .execute();

  if (row.is_owner) return "Bot Owner";
  if (row.is_initial) return "Global Admin";
  if (allianceRows.length > 0) {
    const count = allianceRows.length;
    return `Alliance Admin (${count} alliance${count !== 1 ? "s" : ""})`;
  }
  return "Server Admin";
}

/** Append a row to permission_audit_log. Never throws -- a logging
 * failure must not fail the mutation it's describing, matching
 * permission_handler.py:454-470's broad try/except. */
export async function logChange(
  actorId: string,
  action: string,
  targetId: string,
  beforeState: string | null,
  afterState: string | null,
): Promise<void> {
  try {
    await settingsDb
      .insertInto("permission_audit_log")
      .values({
        actor_id: actorId,
        action,
        target_id: targetId,
        before_state: beforeState,
        after_state: afterState,
        timestamp: new Date().toISOString(),
      })
      .execute();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to write permission audit log:", err);
  }
}

export interface AuditLogRow {
  actorId: string;
  action: string;
  targetId: string;
  beforeState: string | null;
  afterState: string | null;
  timestamp: string;
}

export interface AuditLogPage {
  rows: AuditLogRow[];
  total: number;
}

export async function getAuditLogPage(
  offset = 0,
  limit = 10,
): Promise<AuditLogPage> {
  const totalRow = await settingsDb
    .selectFrom("permission_audit_log")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  const total = Number(totalRow.count);

  const rows = await settingsDb
    .selectFrom("permission_audit_log")
    .select([
      snowflake("actor_id").as("actor_id"),
      "action",
      snowflake("target_id").as("target_id"),
      "before_state",
      "after_state",
      "timestamp",
    ])
    .orderBy("id", "desc")
    .limit(limit)
    .offset(offset)
    .execute();

  return {
    total,
    rows: rows.map((r) => ({
      actorId: r.actor_id!,
      action: r.action,
      targetId: r.target_id!,
      beforeState: r.before_state,
      afterState: r.after_state,
      timestamp: r.timestamp,
    })),
  };
}
