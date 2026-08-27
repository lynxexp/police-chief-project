/**
 * Opens every SQLite file this app touches: the bot's own db/*.sqlite
 * files (read-mostly, read+write only where Phase 1's admin routes need
 * it) plus a brand-new webapp.sqlite this app owns outright.
 *
 * Ground rules (see the plan doc's "Architecture decisions" section):
 *  - This file NEVER issues CREATE TABLE / ALTER TABLE against any of the
 *    bot's files. Python remains the sole schema authority for those.
 *  - Every connection gets the same WAL + busy_timeout pragmas the bot's
 *    own sqlite3.connect(path, timeout=30.0) calls already use, so the
 *    two processes don't collide on locks.
 *  - assertBotSchemaIntact() is a startup guard, not a migration: if an
 *    expected table/column is missing, this process refuses to start
 *    rather than risk operating against a bot version it doesn't match.
 */
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import type {
  AllianceDb,
  CapitolWarDb,
  ChangesDb,
  EventsDb,
  GiftCodeDb,
  IdChannelDb,
  PimpMyBotDb,
  SettingsDb,
  UsersDb,
  VaultDataDb,
  WebappDb,
} from "./schema.js";

const BUSY_TIMEOUT_MS = 30_000;

function openBotDb(filename: string): Database.Database {
  const path = join(config.botDbDir, filename);
  if (!existsSync(path)) {
    throw new Error(
      `Expected bot database file not found: ${path}\n` +
        `Is BOT_DB_DIR set correctly, and has the Discord bot been started ` +
        `at least once (it creates these files on first run)?`,
    );
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // better-sqlite3 defaults this to ON, unlike Python's sqlite3 (which
  // defaults OFF, and the bot never overrides it -- confirmed zero
  // `PRAGMA foreign_keys` anywhere in cogs/*.py). Must match: at least
  // three tables in the wild carry a stale FK from before this bot was
  // renamed (events.sqlite's notification_history/notification_days/
  // wizard_notifications all still say `REFERENCES bear_notifications`,
  // a table that hasn't existed since before "Vault Trap" replaced
  // "Bear Trap" -- CREATE TABLE IF NOT EXISTS never re-runs against an
  // already-existing table, so the old schema text just stuck). With
  // enforcement left ON, ANY write touching one of those three tables
  // -- even just a DELETE FROM notification_days -- throws "no such
  // table: main.bear_notifications" instead of the write the Python
  // bot itself performs without issue.
  db.pragma("foreign_keys = OFF");
  return db;
}

function openWebappDb(): Database.Database {
  if (!existsSync(config.webappDbDir)) {
    mkdirSync(config.webappDbDir, { recursive: true });
  }
  const path = join(config.webappDbDir, "webapp.sqlite");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

const usersRaw = openBotDb("users.sqlite");
const vaultDataRaw = openBotDb("vault_data.sqlite");
const capitolWarRaw = openBotDb("capitol_war.sqlite");
const allianceRaw = openBotDb("alliance.sqlite");
const settingsRaw = openBotDb("settings.sqlite");
const changesRaw = openBotDb("changes.sqlite");
const giftcodeRaw = openBotDb("giftcode.sqlite");
const idChannelRaw = openBotDb("id_channel.sqlite");
const pimpmybotRaw = openBotDb("pimpmybot.sqlite");
const eventsRaw = openBotDb("events.sqlite");
const webappRaw = openWebappDb();

export const usersDb = new Kysely<UsersDb>({
  dialect: new SqliteDialect({ database: usersRaw }),
});
export const vaultDataDb = new Kysely<VaultDataDb>({
  dialect: new SqliteDialect({ database: vaultDataRaw }),
});
export const capitolWarDb = new Kysely<CapitolWarDb>({
  dialect: new SqliteDialect({ database: capitolWarRaw }),
});
export const allianceDb = new Kysely<AllianceDb>({
  dialect: new SqliteDialect({ database: allianceRaw }),
});
export const settingsDb = new Kysely<SettingsDb>({
  dialect: new SqliteDialect({ database: settingsRaw }),
});
export const changesDb = new Kysely<ChangesDb>({
  dialect: new SqliteDialect({ database: changesRaw }),
});
export const giftcodeDb = new Kysely<GiftCodeDb>({
  dialect: new SqliteDialect({ database: giftcodeRaw }),
});
export const idChannelDb = new Kysely<IdChannelDb>({
  dialect: new SqliteDialect({ database: idChannelRaw }),
});
export const pimpmybotDb = new Kysely<PimpMyBotDb>({
  dialect: new SqliteDialect({ database: pimpmybotRaw }),
});
export const eventsDb = new Kysely<EventsDb>({
  dialect: new SqliteDialect({ database: eventsRaw }),
});
export const webappDb = new Kysely<WebappDb>({
  dialect: new SqliteDialect({ database: webappRaw }),
});

/**
 * The one table this app is allowed to CREATE -- its own. Idempotent
 * (IF NOT EXISTS), scoped entirely to webapp.sqlite, never touches a bot
 * file.
 */
export function initWebappSchema(): void {
  webappRaw.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      discord_id INTEGER NOT NULL,
      active_guild_id INTEGER,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_discord_id ON sessions(discord_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS app_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER NOT NULL,
      guild_id INTEGER,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_app_audit_log_created_at ON app_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_app_audit_log_guild_id ON app_audit_log(guild_id);

    CREATE TABLE IF NOT EXISTS calendar_feed_tokens (
      discord_id INTEGER PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_feed_tokens_token ON calendar_feed_tokens(token);
  `);
}

interface ExpectedTable {
  db: Database.Database;
  file: string;
  table: string;
  columns: string[];
  // True for tables the bot only CREATE TABLE IF NOT EXISTS's lazily, on
  // first real use of a specific feature (e.g. the first-ever power change
  // recorded, or the first time self-registration is toggled) -- not
  // unconditionally at cog load. A fresh install, or simply an alliance
  // that's never touched that one feature, legitimately never has these
  // tables, and that's not a version mismatch worth refusing to start
  // over. Column checks below still run normally once the table exists.
  optional?: boolean;
}

/** One entry per table this app actually queries -- not every column in
 * every bot table, just the ones this app's routes depend on. Extend this
 * list as later stages add more columns/tables to the API surface. */
const EXPECTED: ExpectedTable[] = [
  {
    db: usersRaw,
    file: "users.sqlite",
    table: "users",
    columns: [
      "fid", "nickname", "chief_office_lv", "kid", "alliance", "is_active",
      "deactivated_at", "power", "combat_power", "discord_id",
      "discord_server_id",
    ],
  },
  {
    db: vaultDataRaw,
    file: "vault_data.sqlite",
    table: "vault_hunts",
    columns: ["id", "alliance_id", "date", "trap_number", "rallies", "total_damage", "event_time"],
  },
  {
    db: vaultDataRaw,
    file: "vault_data.sqlite",
    table: "vault_player_damage",
    columns: ["id", "hunt_id", "fid", "raw_name", "resolved_nickname", "damage", "rank"],
  },
  {
    db: capitolWarRaw,
    file: "capitol_war.sqlite",
    table: "capitol_war_events",
    columns: ["id", "alliance_id", "date", "event_time"],
  },
  {
    db: capitolWarRaw,
    file: "capitol_war.sqlite",
    table: "capitol_war_points",
    columns: ["id", "event_id", "fid", "raw_name", "resolved_nickname", "points", "rank"],
  },
  {
    db: allianceRaw,
    file: "alliance.sqlite",
    table: "alliance_list",
    columns: ["alliance_id", "name", "discord_server_id", "kid", "tag"],
  },
  {
    db: allianceRaw,
    file: "alliance.sqlite",
    table: "alliancesettings",
    columns: [
      "alliance_id", "channel_id", "redemption_channel_id",
      "vault_score_channel", "capitol_score_channel",
    ],
  },
  {
    db: settingsRaw,
    file: "settings.sqlite",
    table: "admin",
    columns: ["id", "is_initial", "is_owner"],
  },
  {
    db: settingsRaw,
    file: "settings.sqlite",
    table: "adminserver",
    columns: ["id", "admin", "alliances_id"],
  },
  {
    db: settingsRaw,
    file: "settings.sqlite",
    table: "permission_audit_log",
    columns: ["id", "actor_id", "action", "target_id", "before_state", "after_state", "timestamp"],
  },
  {
    db: changesRaw,
    file: "changes.sqlite",
    table: "nickname_changes",
    columns: ["id", "fid", "old_nickname", "new_nickname", "change_date"],
  },
  {
    db: changesRaw,
    file: "changes.sqlite",
    table: "chief_office_changes",
    columns: ["id", "fid", "old_chief_office_lv", "new_chief_office_lv", "change_date"],
  },
  {
    db: changesRaw,
    file: "changes.sqlite",
    table: "power_changes",
    columns: ["id", "fid", "old_power", "new_power", "change_date"],
    optional: true, // only created once the first power change is ever recorded
  },
  {
    db: changesRaw,
    file: "changes.sqlite",
    table: "combat_power_changes",
    columns: ["id", "fid", "old_combat_power", "new_combat_power", "change_date"],
    optional: true, // only created once the first combat power change is ever recorded
  },
  {
    db: giftcodeRaw,
    file: "giftcode.sqlite",
    table: "gift_codes",
    columns: ["giftcode", "date", "note", "expiry_date", "is_active", "created_by", "announced_by_bot"],
  },
  {
    db: giftcodeRaw,
    file: "giftcode.sqlite",
    table: "giftcode_channel",
    columns: ["alliance_id", "channel_id"],
  },
  {
    db: settingsRaw,
    file: "settings.sqlite",
    table: "register_settings",
    columns: ["enabled"],
    optional: true, // only created once self-registration is toggled at least once
  },
  {
    db: idChannelRaw,
    file: "id_channel.sqlite",
    table: "id_channels",
    columns: ["guild_id", "alliance_id", "channel_id", "created_at", "created_by"],
  },
  {
    db: idChannelRaw,
    file: "id_channel.sqlite",
    table: "id_channel_settings",
    columns: ["guild_id", "scan_enabled", "scan_limit", "delete_after", "respond_to_invalid"],
  },
  {
    db: pimpmybotRaw,
    file: "pimpmybot.sqlite",
    table: "pimpsettings",
    // Representative sample, not all ~163 columns -- this guard is a
    // version-mismatch sanity check, not exhaustive coverage. A handful
    // of icon columns across different eras (original + a "Other"-bucket
    // one added later) plus every metadata/divider/color column.
    columns: [
      "id", "themeName", "themeCreator", "is_active", "themeDescription", "createdAt",
      "created_guild_id", "dividerStart1", "dividerPattern1", "dividerEnd1", "dividerLength1",
      "dividerCodeBlock1", "emColorString1", "headerColor1", "allianceIcon", "giftIcon",
      "vaultTrapIcon", "svsIcon",
    ],
  },
  {
    db: pimpmybotRaw,
    file: "pimpmybot.sqlite",
    table: "server_themes",
    columns: ["guild_id", "theme_name"],
  },
  {
    db: eventsRaw,
    file: "events.sqlite",
    table: "vault_notifications",
    columns: [
      "id", "guild_id", "channel_id", "hour", "minute", "timezone", "description",
      "notification_type", "mention_type", "repeat_enabled", "repeat_minutes",
      "is_enabled", "created_by", "next_notification", "event_type", "custom_event_id",
    ],
  },
  {
    db: eventsRaw,
    file: "events.sqlite",
    table: "notification_history",
    columns: ["id", "notification_id", "notification_time", "sent_at"],
  },
  {
    db: eventsRaw,
    file: "events.sqlite",
    table: "vault_notification_embeds",
    columns: ["id", "notification_id", "title", "description", "color", "mention_message"],
  },
  {
    db: eventsRaw,
    file: "events.sqlite",
    table: "notification_days",
    columns: ["notification_id", "weekday"],
  },
  {
    db: eventsRaw,
    file: "events.sqlite",
    table: "custom_events",
    columns: [
      "id", "guild_id", "name", "icon_url", "first_occurrence", "recurrence_type",
      "recurrence_interval", "reminder_offsets", "channel_id", "created_by", "created_at",
      "notifications_enabled",
    ],
  },
  {
    db: eventsRaw,
    file: "events.sqlite",
    table: "vault_trap_settings",
    columns: ["guild_id", "delete_messages_enabled", "default_delete_delay_minutes", "show_daily_reset_on_schedule"],
  },
  {
    db: eventsRaw,
    file: "events.sqlite",
    table: "notification_schedule_boards",
    columns: ["id", "guild_id", "channel_id", "message_id", "board_type", "max_events"],
  },
];

/**
 * Startup guard: confirm every table/column this app's routes rely on
 * actually exists in the bot's current database files. Throws (never
 * silently continues) if anything's missing -- the caller (server.ts)
 * should let this crash the process rather than start against a bot
 * version it doesn't match.
 */
export function assertBotSchemaIntact(): void {
  const problems: string[] = [];

  for (const expected of EXPECTED) {
    const row = expected.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(expected.table) as { name: string } | undefined;

    if (!row) {
      if (!expected.optional) {
        problems.push(`${expected.file}: table "${expected.table}" does not exist`);
      }
      continue;
    }

    const columns = expected.db
      .prepare(`PRAGMA table_info(${expected.table})`)
      .all() as { name: string }[];
    const present = new Set(columns.map((c) => c.name));

    for (const col of expected.columns) {
      if (!present.has(col)) {
        problems.push(
          `${expected.file}: table "${expected.table}" is missing column "${col}"`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      "Bot database schema check failed -- refusing to start.\n" +
        "This usually means BOT_DB_DIR points at a database created by a " +
        "different/older bot version than this webapp expects.\n\n" +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}

/**
 * Closes every raw better-sqlite3 handle directly, NOT via the Kysely
 * wrappers' own `.destroy()`. Kysely's SqliteDriver only opens its
 * internal reference to the database on the first query it ever runs
 * (lazy `init()`) -- for any of these files a request handler never
 * happened to query in this process's lifetime, `driver.destroy()`'s
 * `this.#db?.close()` is a silent no-op, and the raw OS-level file
 * handle opened eagerly by openBotDb()/openWebappDb() at module load
 * stays open indefinitely. Confirmed via restore testing: db-dev-copy
 * files that no route had queried yet stayed locked (blocking the
 * restore's file replace with EPERM) even after this function returned,
 * while the two files an admin-auth check + audit-log write DID touch
 * closed correctly. Closing the raw handles here is correct regardless
 * of whether Kysely ever initialized its own reference to them. */
export async function closeAllConnections(): Promise<void> {
  for (const raw of [
    usersRaw, vaultDataRaw, capitolWarRaw, allianceRaw, settingsRaw,
    changesRaw, giftcodeRaw, idChannelRaw, pimpmybotRaw, eventsRaw, webappRaw,
  ]) {
    raw.close();
  }
}
