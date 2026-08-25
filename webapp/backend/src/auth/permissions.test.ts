/**
 * Unit tests for the PermissionManager port. Every function here MUST
 * agree with cogs/permission_handler.py given the same DB state (see
 * permissions.ts's own doc comment) -- these tests exercise that
 * against real SQLite files (not mocks), schema-matched to main.py's
 * and cogs/bot_operations.py's actual CREATE TABLE statements, so a
 * schema drift between this file and the bot would surface here too.
 *
 * Runs against a throwaway temp directory, never the real db/ -- see
 * beforeAll. Config/db module state is process-wide (config.ts reads
 * env vars once at import time, db/connections.ts opens its files once
 * at import time), so everything under test is imported dynamically
 * AFTER the env vars and fixture files are in place, and this whole
 * suite necessarily runs as a single process against one fixture set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

let tmpDir: string;
let perm: typeof import("./permissions.js");
let connections: typeof import("../db/connections.js");
let settingsRaw: Database.Database;
let allianceRaw: Database.Database;
let usersRaw: Database.Database;

function createSettingsDb(path: string) {
  const db = new Database(path);
  // Exact DDL from cogs/bot_operations.py's setup_database().
  db.exec(`
    CREATE TABLE admin (
      id INTEGER PRIMARY KEY,
      is_initial INTEGER DEFAULT 0,
      is_owner INTEGER DEFAULT 0
    );
    CREATE TABLE adminserver (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin INTEGER NOT NULL,
      alliances_id INTEGER NOT NULL,
      UNIQUE(admin, alliances_id)
    );
    CREATE TABLE permission_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      before_state TEXT,
      after_state TEXT,
      timestamp TEXT NOT NULL
    );
  `);
  return db;
}

function createAllianceDb(path: string) {
  const db = new Database(path);
  // Exact DDL from main.py's alliance_list setup, plus the minimal
  // alliancesettings shape (unused by permissions.ts, but connections.ts
  // types the whole AllianceDb against one Kysely instance).
  db.exec(`
    CREATE TABLE alliance_list (
      alliance_id INTEGER PRIMARY KEY,
      name TEXT,
      discord_server_id INTEGER,
      kid INTEGER,
      multistate INTEGER DEFAULT 0,
      state_locked INTEGER DEFAULT 0,
      tag TEXT
    );
    CREATE TABLE alliancesettings (
      alliance_id INTEGER PRIMARY KEY,
      channel_id INTEGER,
      interval INTEGER,
      auto_remove_on_transfer INTEGER DEFAULT 0,
      id_post_info_message INTEGER DEFAULT 0,
      id_pin_info_message INTEGER DEFAULT 1,
      ocr_upload_admin_only INTEGER DEFAULT 0,
      silent_notifications INTEGER DEFAULT 0,
      redemption_channel_id INTEGER,
      vault_score_channel INTEGER,
      capitol_score_channel INTEGER
    );
  `);
  return db;
}

function createUsersDb(path: string) {
  const db = new Database(path);
  // Exact DDL from main.py's users table (base columns + the
  // subsequently-added ones, per the _users_columns_to_add migration list).
  db.exec(`
    CREATE TABLE users (
      fid INTEGER PRIMARY KEY,
      nickname TEXT,
      chief_office_lv INTEGER,
      kid INTEGER,
      alliance TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      deactivated_at TEXT,
      power INTEGER,
      power_updated_at TEXT,
      combat_power INTEGER,
      combat_power_updated_at TEXT,
      discord_id INTEGER,
      discord_server_id INTEGER,
      discord_id_updated_at TEXT,
      state_mismatch_at TEXT
    );
  `);
  return db;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcb-webapp-test-"));
  const webappDataDir = join(tmpDir, "webapp-data");
  mkdirSync(webappDataDir);

  settingsRaw = createSettingsDb(join(tmpDir, "settings.sqlite"));
  allianceRaw = createAllianceDb(join(tmpDir, "alliance.sqlite"));
  usersRaw = createUsersDb(join(tmpDir, "users.sqlite"));
  // db/connections.ts opens every bot db file unconditionally at import
  // time -- these just need to exist as valid SQLite files, permissions.ts
  // never touches them.
  new Database(join(tmpDir, "vault_data.sqlite")).close();
  new Database(join(tmpDir, "capitol_war.sqlite")).close();
  new Database(join(tmpDir, "changes.sqlite")).close();
  new Database(join(tmpDir, "giftcode.sqlite")).close();
  new Database(join(tmpDir, "id_channel.sqlite")).close();
  new Database(join(tmpDir, "pimpmybot.sqlite")).close();
  new Database(join(tmpDir, "events.sqlite")).close();

  process.env.BOT_DB_DIR = tmpDir;
  process.env.WEBAPP_DB_DIR = webappDataDir;
  process.env.DISCORD_CLIENT_ID = "test-client-id";
  process.env.DISCORD_CLIENT_SECRET = "test-client-secret";
  process.env.DISCORD_BOT_TOKEN = "test-bot-token";
  process.env.DISCORD_REDIRECT_URI = "http://localhost/api/auth/callback";
  process.env.SESSION_SECRET = "test-session-secret-well-over-32-chars-long";

  perm = await import("./permissions.js");
  connections = await import("../db/connections.js");
});

afterAll(async () => {
  // db/connections.ts opens its own long-lived handles to these same
  // files as a side effect of the dynamic import above -- close those
  // too, or Windows keeps the temp dir locked and rmSync EPERMs.
  await connections.closeAllConnections();
  settingsRaw.close();
  allianceRaw.close();
  usersRaw.close();
  try {
    // Best-effort: on Windows, something outside this process (AV,
    // search indexer) can hold a transient lock on files under %TEMP%
    // well past every handle this test opened being closed. That's an
    // OS/environment quirk, not a correctness issue with the code under
    // test -- don't fail an otherwise fully-passing suite over a leaked
    // temp dir the OS will clean up on its own.
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    console.warn(`Could not remove test temp dir ${tmpDir}:`, err);
  }
});

beforeEach(() => {
  settingsRaw.exec("DELETE FROM admin; DELETE FROM adminserver; DELETE FROM permission_audit_log;");
  allianceRaw.exec("DELETE FROM alliance_list; DELETE FROM alliancesettings;");
  usersRaw.exec("DELETE FROM users;");
  perm._invalidateAdminCacheForTests();
});

const OWNER = "1";
const GLOBAL = "2";
const ALLIANCE_ADMIN = "3";
const SERVER_ADMIN = "4";
const REGULAR_USER = "5";
const GUILD_A = "100";
const GUILD_B = "200";

function seedAdmin(id: string, opts: { isInitial?: boolean; isOwner?: boolean } = {}) {
  settingsRaw
    .prepare("INSERT INTO admin (id, is_initial, is_owner) VALUES (?, ?, ?)")
    .run(id, opts.isInitial ? 1 : 0, opts.isOwner ? 1 : 0);
}
function seedAdminServer(admin: string, allianceId: number) {
  settingsRaw.prepare("INSERT INTO adminserver (admin, alliances_id) VALUES (?, ?)").run(admin, allianceId);
}
function seedAlliance(id: number, name: string, guildId: string | null) {
  allianceRaw
    .prepare("INSERT INTO alliance_list (alliance_id, name, discord_server_id) VALUES (?, ?, ?)")
    .run(id, name, guildId);
}

describe("getTier", () => {
  it("returns none for an id with no admin row", async () => {
    expect(await perm.getTier(REGULAR_USER)).toBe(perm.TIER_NONE);
  });

  it("returns owner when is_owner=1", async () => {
    seedAdmin(OWNER, { isOwner: true, isInitial: true });
    expect(await perm.getTier(OWNER)).toBe(perm.TIER_OWNER);
  });

  it("returns global when is_initial=1 and not owner", async () => {
    seedAdmin(GLOBAL, { isInitial: true });
    expect(await perm.getTier(GLOBAL)).toBe(perm.TIER_GLOBAL);
  });

  it("returns alliance when the admin has adminserver rows", async () => {
    seedAdmin(ALLIANCE_ADMIN);
    seedAdminServer(ALLIANCE_ADMIN, 1);
    expect(await perm.getTier(ALLIANCE_ADMIN)).toBe(perm.TIER_ALLIANCE);
  });

  it("returns server when the admin has no adminserver rows and isn't global/owner", async () => {
    seedAdmin(SERVER_ADMIN);
    expect(await perm.getTier(SERVER_ADMIN)).toBe(perm.TIER_SERVER);
  });

  it("owner outranks having adminserver rows (is_owner checked before alliance count)", async () => {
    seedAdmin(OWNER, { isOwner: true, isInitial: true });
    seedAdminServer(OWNER, 1);
    expect(await perm.getTier(OWNER)).toBe(perm.TIER_OWNER);
  });
});

describe("isOwner / getOwnerId / countGlobals", () => {
  it("isOwner is false for non-owners, true for the owner", async () => {
    seedAdmin(GLOBAL, { isInitial: true });
    seedAdmin(OWNER, { isOwner: true, isInitial: true });
    expect(await perm.isOwner(GLOBAL)).toBe(false);
    expect(await perm.isOwner(OWNER)).toBe(true);
  });

  it("getOwnerId returns null when unclaimed, the exact id once claimed", async () => {
    expect(await perm.getOwnerId()).toBeNull();
    seedAdmin(OWNER, { isOwner: true, isInitial: true });
    expect(await perm.getOwnerId()).toBe(OWNER);
  });

  it("countGlobals counts is_initial rows regardless of owner status", async () => {
    seedAdmin(OWNER, { isOwner: true, isInitial: true });
    seedAdmin(GLOBAL, { isInitial: true });
    seedAdmin(SERVER_ADMIN); // is_initial=0, shouldn't count
    expect(await perm.countGlobals()).toBe(2);
  });
});

describe("getAdminAllianceIds", () => {
  it("non-admin gets no alliances", async () => {
    const { allianceIds, isGlobal } = await perm.getAdminAllianceIds(REGULAR_USER, GUILD_A);
    expect(allianceIds).toEqual([]);
    expect(isGlobal).toBe(false);
  });

  it("global/owner gets isGlobal=true and an empty list (means 'all')", async () => {
    seedAdmin(GLOBAL, { isInitial: true });
    const result = await perm.getAdminAllianceIds(GLOBAL, GUILD_A);
    expect(result.isGlobal).toBe(true);
    expect(result.allianceIds).toEqual([]);
  });

  it("alliance admin gets exactly their assigned ids, ignoring guildId", async () => {
    seedAdmin(ALLIANCE_ADMIN);
    seedAdminServer(ALLIANCE_ADMIN, 1);
    seedAdminServer(ALLIANCE_ADMIN, 2);
    const { allianceIds, isGlobal } = await perm.getAdminAllianceIds(ALLIANCE_ADMIN, GUILD_A);
    expect(isGlobal).toBe(false);
    expect(allianceIds.sort()).toEqual([1, 2]);
  });

  it("server admin gets every alliance on the current guild, and only that guild", async () => {
    seedAdmin(SERVER_ADMIN);
    seedAlliance(1, "Apex", GUILD_A);
    seedAlliance(2, "Nova", GUILD_A);
    seedAlliance(3, "Other Guild", GUILD_B);
    const { allianceIds } = await perm.getAdminAllianceIds(SERVER_ADMIN, GUILD_A);
    expect(allianceIds.sort()).toEqual([1, 2]);
  });

  it("server admin gets nothing for a guild with no alliances", async () => {
    seedAdmin(SERVER_ADMIN);
    seedAlliance(1, "Apex", GUILD_A);
    const { allianceIds } = await perm.getAdminAllianceIds(SERVER_ADMIN, GUILD_B);
    expect(allianceIds).toEqual([]);
  });
});

describe("canManageAlliance", () => {
  it("global can manage any alliance", async () => {
    seedAdmin(GLOBAL, { isInitial: true });
    expect(await perm.canManageAlliance(GLOBAL, GUILD_A, 999)).toBe(true);
  });

  it("alliance admin can only manage their assigned alliances", async () => {
    seedAdmin(ALLIANCE_ADMIN);
    seedAdminServer(ALLIANCE_ADMIN, 1);
    expect(await perm.canManageAlliance(ALLIANCE_ADMIN, GUILD_A, 1)).toBe(true);
    expect(await perm.canManageAlliance(ALLIANCE_ADMIN, GUILD_A, 2)).toBe(false);
  });

  it("server admin can only manage alliances on their guild", async () => {
    seedAdmin(SERVER_ADMIN);
    seedAlliance(1, "Apex", GUILD_A);
    seedAlliance(2, "Other", GUILD_B);
    expect(await perm.canManageAlliance(SERVER_ADMIN, GUILD_A, 1)).toBe(true);
    expect(await perm.canManageAlliance(SERVER_ADMIN, GUILD_A, 2)).toBe(false);
  });

  it("a non-admin can never manage any alliance", async () => {
    expect(await perm.canManageAlliance(REGULAR_USER, GUILD_A, 1)).toBe(false);
  });
});

describe("addAdmin", () => {
  it("the first admin ever added becomes owner regardless of requested tier", async () => {
    await perm.addAdmin(SERVER_ADMIN, { tier: perm.TIER_SERVER });
    expect(await perm.getTier(SERVER_ADMIN)).toBe(perm.TIER_OWNER);
  });

  it("subsequent admins get the tier they were assigned, not owner", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    await perm.addAdmin(SERVER_ADMIN, { tier: perm.TIER_SERVER });
    expect(await perm.getTier(SERVER_ADMIN)).toBe(perm.TIER_SERVER);
  });

  it("alliance tier requires at least one allianceId", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER }); // avoid the first-admin-is-owner edge case
    await expect(perm.addAdmin(ALLIANCE_ADMIN, { tier: perm.TIER_ALLIANCE })).rejects.toThrow(
      perm.PermissionError,
    );
  });

  it("rejects an unknown tier", async () => {
    // @ts-expect-error -- deliberately invalid input
    await expect(perm.addAdmin(REGULAR_USER, { tier: "wizard" })).rejects.toThrow(perm.PermissionError);
  });
});

describe("setTier", () => {
  it("cannot set tier to owner (must use transferOwner)", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    await perm.addAdmin(GLOBAL, { tier: perm.TIER_GLOBAL });
    await expect(perm.setTier(GLOBAL, perm.TIER_OWNER)).rejects.toThrow(perm.PermissionError);
  });

  it("cannot demote the owner via setTier", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    await expect(perm.setTier(OWNER, perm.TIER_SERVER)).rejects.toThrow(perm.PermissionError);
  });

  it("switching away from alliance tier clears the old adminserver rows", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    await perm.addAdmin(ALLIANCE_ADMIN, { tier: perm.TIER_ALLIANCE, allianceIds: [1, 2] });
    await perm.setTier(ALLIANCE_ADMIN, perm.TIER_GLOBAL);
    expect(await perm.getTier(ALLIANCE_ADMIN)).toBe(perm.TIER_GLOBAL);
    expect(await perm.getAdminAllianceAssignments(ALLIANCE_ADMIN)).toEqual([]);
  });

  it("throws for a user who isn't an admin at all", async () => {
    await expect(perm.setTier(REGULAR_USER, perm.TIER_SERVER)).rejects.toThrow(perm.PermissionError);
  });
});

describe("removeAdmin", () => {
  it("cannot remove the owner", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    await expect(perm.removeAdmin(OWNER)).rejects.toThrow(perm.PermissionError);
  });

  it("removes the admin row and their adminserver assignments", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    await perm.addAdmin(ALLIANCE_ADMIN, { tier: perm.TIER_ALLIANCE, allianceIds: [1] });
    await perm.removeAdmin(ALLIANCE_ADMIN);
    expect(await perm.getTier(ALLIANCE_ADMIN)).toBe(perm.TIER_NONE);
    expect(await perm.getAdminAllianceAssignments(ALLIANCE_ADMIN)).toEqual([]);
  });
});

describe("claimOwner", () => {
  it("a global admin can claim ownership when unclaimed", async () => {
    seedAdmin(GLOBAL, { isInitial: true });
    expect(await perm.claimOwner(GLOBAL)).toBe(true);
    expect(await perm.isOwner(GLOBAL)).toBe(true);
  });

  it("fails once an owner already exists", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    seedAdmin(GLOBAL, { isInitial: true });
    expect(await perm.claimOwner(GLOBAL)).toBe(false);
  });

  it("fails for a non-global admin (must be is_initial=1)", async () => {
    seedAdmin(SERVER_ADMIN);
    expect(await perm.claimOwner(SERVER_ADMIN)).toBe(false);
  });
});

describe("transferOwner", () => {
  it("moves is_owner from the current owner to a global-tier recipient", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    await perm.addAdmin(GLOBAL, { tier: perm.TIER_GLOBAL });
    await perm.transferOwner(OWNER, GLOBAL);
    expect(await perm.getTier(OWNER)).toBe(perm.TIER_GLOBAL);
    expect(await perm.getTier(GLOBAL)).toBe(perm.TIER_OWNER);
  });

  it("rejects when fromUserId isn't the current owner", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    await perm.addAdmin(GLOBAL, { tier: perm.TIER_GLOBAL });
    await expect(perm.transferOwner(GLOBAL, OWNER)).rejects.toThrow(perm.PermissionError);
  });

  it("rejects when the recipient isn't Global tier yet", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    await perm.addAdmin(SERVER_ADMIN, { tier: perm.TIER_SERVER });
    await expect(perm.transferOwner(OWNER, SERVER_ADMIN)).rejects.toThrow(perm.PermissionError);
  });

  it("rejects a recipient who isn't an admin at all", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    await expect(perm.transferOwner(OWNER, REGULAR_USER)).rejects.toThrow(perm.PermissionError);
  });
});

describe("describeState", () => {
  it("owner -> 'Bot Owner'", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    expect(await perm.describeState(OWNER)).toBe("Bot Owner");
  });

  it("global -> 'Global Admin'", async () => {
    // Seed a pre-existing owner first so GLOBAL doesn't hit the
    // first-admin-auto-becomes-owner rule and land on the wrong tier.
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    await perm.addAdmin(GLOBAL, { tier: perm.TIER_GLOBAL });
    expect(await perm.describeState(GLOBAL)).toBe("Global Admin");
  });

  it("server -> 'Server Admin'", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    await perm.addAdmin(SERVER_ADMIN, { tier: perm.TIER_SERVER });
    expect(await perm.describeState(SERVER_ADMIN)).toBe("Server Admin");
  });

  it("reports alliance admin with a pluralized alliance count", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    await perm.addAdmin(ALLIANCE_ADMIN, { tier: perm.TIER_ALLIANCE, allianceIds: [1, 2] });
    expect(await perm.describeState(ALLIANCE_ADMIN)).toBe("Alliance Admin (2 alliances)");
  });

  it("reports a single alliance without the plural s", async () => {
    await perm.addAdmin(OWNER, { tier: perm.TIER_OWNER });
    await perm.addAdmin(ALLIANCE_ADMIN, { tier: perm.TIER_ALLIANCE, allianceIds: [1] });
    expect(await perm.describeState(ALLIANCE_ADMIN)).toBe("Alliance Admin (1 alliance)");
  });

  it("reports a non-admin plainly", async () => {
    expect(await perm.describeState(REGULAR_USER)).toBe("Not an admin");
  });
});

describe("logChange / getAuditLogPage", () => {
  it("records a row and reads it back with all fields intact", async () => {
    await perm.logChange(OWNER, "add_admin", GLOBAL, "Not an admin", "Global Admin");
    const { rows, total } = await perm.getAuditLogPage();
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({
      actorId: OWNER,
      action: "add_admin",
      targetId: GLOBAL,
      beforeState: "Not an admin",
      afterState: "Global Admin",
    });
  });

  it("orders newest first and paginates with offset/limit", async () => {
    for (let i = 0; i < 5; i++) {
      await perm.logChange(OWNER, `action_${i}`, GLOBAL, null, null);
    }
    const page1 = await perm.getAuditLogPage(0, 2);
    const page2 = await perm.getAuditLogPage(2, 2);
    expect(page1.total).toBe(5);
    expect(page1.rows.map((r) => r.action)).toEqual(["action_4", "action_3"]);
    expect(page2.rows.map((r) => r.action)).toEqual(["action_2", "action_1"]);
  });
});

describe("listAdmins", () => {
  it("classifies each row's tier and orders owner, then global, then the rest", async () => {
    await perm.addAdmin(SERVER_ADMIN, { tier: perm.TIER_SERVER }); // becomes owner (first ever)
    await perm.addAdmin(GLOBAL, { tier: perm.TIER_GLOBAL });
    await perm.addAdmin(ALLIANCE_ADMIN, { tier: perm.TIER_ALLIANCE, allianceIds: [1] });

    const admins = await perm.listAdmins();
    expect(admins.map((a) => a.tier)).toEqual([perm.TIER_OWNER, perm.TIER_GLOBAL, perm.TIER_ALLIANCE]);
    expect(admins.find((a) => a.id === ALLIANCE_ADMIN)?.allianceCount).toBe(1);
  });
});
