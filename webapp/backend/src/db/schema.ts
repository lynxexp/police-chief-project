/**
 * Kysely table type definitions, hand-transcribed from the bot's own
 * CREATE TABLE / ALTER TABLE statements (see main.py, cogs/vault_track.py,
 * cogs/capitol_war.py, cogs/permission_handler.py, cogs/bot_operations.py).
 *
 * These are read/write TYPES only -- this file never issues DDL. The
 * Python bot is the sole schema authority (see db/connections.ts's
 * startup column-existence check, which is the actual enforcement of
 * that rule, not just a comment).
 *
 * Grouped by which physical .sqlite file each table lives in, since each
 * gets its own better-sqlite3 connection (see db/connections.ts).
 */
import type { Generated } from "kysely";

/** SQLite has no boolean type -- these columns are stored as a raw 0/1
 * INTEGER, and better-sqlite3 returns them as plain JS numbers. Typed as
 * `number` (not a Kysely ColumnType<boolean, ...> wrapper) so `.where("x",
 * "=", 1)` and friends stay simple on both the read and write side --
 * convert to a JS boolean explicitly in application code with
 * `Boolean(row.x)` where one is wanted. */
type SqliteBoolean = number;

/**
 * A Discord snowflake (user/guild/channel id) stored in an INTEGER
 * column. Typed as `string`, NOT `number` -- snowflakes are 64-bit and
 * routinely exceed Number.MAX_SAFE_INTEGER (2^53), so round-tripping one
 * through a JS `number` silently corrupts it (confirmed: a real test
 * value came back off by 41). SQLite's INTEGER affinity converts a bound
 * numeric string to an exact 64-bit int on write, and every read site in
 * this codebase casts these columns back to TEXT (see db/snowflake.ts)
 * so the driver never has to materialize a lossy float. Application code
 * must never call Number()/parseInt() on a value typed Snowflake --
 * compare and bind it as a string throughout. */
type Snowflake = string;

// ---------------------------------------------------------------------------
// db/users.sqlite
// ---------------------------------------------------------------------------

export interface UsersTable {
  fid: number;
  nickname: string | null;
  chief_office_lv: number | null;
  kid: number | null;
  /** Stores the numeric alliance_id (declared TEXT, but every read/write in
   * the Python bot treats it as an id -- see plan doc / cogs/alliance_registration.py
   * _insert_new_user, cogs/alliance_member_operations.py's many
   * `WHERE alliance = ?` call sites bound with an alliance_id). */
  alliance: string | null;
  is_active: SqliteBoolean;
  deactivated_at: string | null;
  power: number | null;
  power_updated_at: string | null;
  combat_power: number | null;
  combat_power_updated_at: string | null;
  discord_id: Snowflake | null;
  discord_server_id: Snowflake | null;
  discord_id_updated_at: string | null;
  state_mismatch_at: string | null;
}

export interface UsersDb {
  users: UsersTable;
}

// ---------------------------------------------------------------------------
// db/vault_data.sqlite
// ---------------------------------------------------------------------------

export interface VaultHuntsTable {
  id: Generated<number>;
  alliance_id: number;
  date: string;
  trap_number: number;
  rallies: number | null;
  total_damage: number | null;
  event_time: string | null;
}

export interface VaultPlayerDamageTable {
  id: Generated<number>;
  hunt_id: number;
  fid: number | null;
  raw_name: string | null;
  resolved_nickname: string | null;
  damage: number;
  rank: number | null;
  match_score: number | null;
}

export interface VaultDataDb {
  vault_hunts: VaultHuntsTable;
  vault_player_damage: VaultPlayerDamageTable;
}

// ---------------------------------------------------------------------------
// db/capitol_war.sqlite
// ---------------------------------------------------------------------------

export interface CapitolWarEventsTable {
  id: Generated<number>;
  alliance_id: number;
  date: string;
  event_time: string | null;
}

export interface CapitolWarPointsTable {
  id: Generated<number>;
  event_id: number;
  fid: number | null;
  raw_name: string | null;
  resolved_nickname: string | null;
  points: number;
  rank: number | null;
  match_score: number | null;
}

export interface CapitolWarDb {
  capitol_war_events: CapitolWarEventsTable;
  capitol_war_points: CapitolWarPointsTable;
}

// ---------------------------------------------------------------------------
// db/alliance.sqlite
// ---------------------------------------------------------------------------

export interface AllianceListTable {
  alliance_id: number;
  name: string | null;
  discord_server_id: Snowflake | null;
  kid: number | null;
  multistate: SqliteBoolean;
  state_locked: SqliteBoolean;
  tag: string | null;
}

export interface AllianceSettingsTable {
  alliance_id: number;
  channel_id: Snowflake | null;
  interval: number | null;
  /** All five booleans below have a SQL-level DEFAULT (see main.py's
   * ALTER TABLE guards), so they're optional on insert -- Generated<>
   * reflects that to Kysely, not that SQLite auto-increments them. */
  auto_remove_on_transfer: Generated<SqliteBoolean>;
  id_post_info_message: Generated<SqliteBoolean>;
  id_pin_info_message: Generated<SqliteBoolean>;
  ocr_upload_admin_only: Generated<SqliteBoolean>;
  silent_notifications: Generated<SqliteBoolean>;
  redemption_channel_id: Snowflake | null;
  vault_score_channel: Snowflake | null;
  capitol_score_channel: Snowflake | null;
}

export interface AllianceDb {
  alliance_list: AllianceListTable;
  alliancesettings: AllianceSettingsTable;
}

// ---------------------------------------------------------------------------
// db/settings.sqlite -- the permission-tier tables
// ---------------------------------------------------------------------------

export interface AdminTable {
  id: Snowflake;
  is_initial: SqliteBoolean;
  is_owner: SqliteBoolean;
}

export interface AdminServerTable {
  id: Generated<number>;
  admin: Snowflake;
  alliances_id: number;
}

export interface PermissionAuditLogTable {
  id: Generated<number>;
  actor_id: Snowflake;
  action: string;
  target_id: Snowflake;
  before_state: string | null;
  after_state: string | null;
  timestamp: string;
}

/** Single global row (no PK, no guild/alliance scoping at all -- see
 * cogs/alliance_registration.py), toggling whether self-registration
 * (/register) is available bot-wide. */
export interface RegisterSettingsTable {
  enabled: SqliteBoolean | null;
}

export interface SettingsDb {
  admin: AdminTable;
  adminserver: AdminServerTable;
  permission_audit_log: PermissionAuditLogTable;
  register_settings: RegisterSettingsTable;
}

// ---------------------------------------------------------------------------
// db/changes.sqlite -- Phase 2 "alliance history" (nickname / Chief's
// Office level / power / combat power over time). Every table here is
// the same shape: (fid, old_value, new_value, change_date), read via a
// plain WHERE fid = ? ORDER BY change_date DESC -- see
// cogs/alliance_history.py and cogs/alliance_power_changes.py.
// ---------------------------------------------------------------------------

export interface NicknameChangeTable {
  id: Generated<number>;
  fid: number;
  old_nickname: string | null;
  new_nickname: string | null;
  change_date: string;
}

export interface ChiefOfficeChangeTable {
  id: Generated<number>;
  fid: number;
  old_chief_office_lv: number | null;
  new_chief_office_lv: number | null;
  change_date: string;
}

export interface PowerChangeTable {
  id: Generated<number>;
  fid: number;
  old_power: number;
  new_power: number;
  change_date: string;
}

export interface CombatPowerChangeTable {
  id: Generated<number>;
  fid: number;
  old_combat_power: number;
  new_combat_power: number;
  change_date: string;
}

export interface ChangesDb {
  nickname_changes: NicknameChangeTable;
  chief_office_changes: ChiefOfficeChangeTable;
  power_changes: PowerChangeTable;
  combat_power_changes: CombatPowerChangeTable;
}

// ---------------------------------------------------------------------------
// db/giftcode.sqlite -- Phase 2 "gift codes". Also has `user_giftcodes`,
// `giftcodecontrol`, and a `scan_history` column on giftcode_channel --
// all three confirmed dead (zero reads/writes anywhere in the Python
// source outside their own DDL, except giftcodecontrol's display-only
// "Gift System: Active/Inactive" status line in bot_startup.py). Not
// ported -- no functional behavior depends on them.
// ---------------------------------------------------------------------------

export interface GiftCodeTable {
  giftcode: string;
  date: string | null;
  note: string | null;
  expiry_date: string | null;
  is_active: Generated<SqliteBoolean>;
  created_by: Snowflake | null;
  /** Defaults to 1 (see gift_operations.py's ALTER TABLE comment) for every
   * pre-existing row and every Discord-added row (which announces
   * synchronously). This app's own INSERT explicitly writes 0 so the bot's
   * check_web_added_codes_loop() picks it up and posts the announcement. */
  announced_by_bot: Generated<SqliteBoolean>;
}

export interface GiftCodeChannelTable {
  alliance_id: number;
  channel_id: Snowflake | null;
}

export interface GiftCodeDb {
  gift_codes: GiftCodeTable;
  giftcode_channel: GiftCodeChannelTable;
}

// ---------------------------------------------------------------------------
// db/id_channel.sqlite -- Phase 2 "ID channel / self-registration". Only
// place this table actually lives (confirmed: alliance.sqlite has just
// alliance_list + alliancesettings, no id_channels copy there despite an
// ALTER TABLE guard for it existing in main.py too -- same file, not a
// second copy). register_settings lives in settings.sqlite instead (see
// SettingsDb above) -- it's bot-wide, not guild-scoped like these two.
// ---------------------------------------------------------------------------

export interface IdChannelTable {
  guild_id: Snowflake | null;
  alliance_id: number | null;
  channel_id: Snowflake | null;
  created_at: string | null;
  created_by: Snowflake | null;
  info_message_id: Snowflake | null;
}

export interface IdChannelSettingsTable {
  guild_id: Snowflake;
  scan_enabled: Generated<SqliteBoolean>;
  scan_limit: Generated<number>;
  delete_after: Generated<number>;
  respond_to_invalid: Generated<SqliteBoolean>;
}

export interface IdChannelDb {
  id_channels: IdChannelTable;
  id_channel_settings: IdChannelSettingsTable;
}

// ---------------------------------------------------------------------------
// db/pimpmybot.sqlite -- Phase 2 "theming". pimpsettings has ~150 icon
// TEXT columns (generated from the live schema via PRAGMA table_info, not
// hand-counted -- see theming/icons.ts's ICON_CATEGORIES for the grouped,
// human-readable list the editor UI actually uses). themeCreator holds
// either a real Discord snowflake (as text-affinity-stored int) or the
// literal string "System" for the seed "default" theme -- NOT always a
// valid snowflake, so typed as plain string, not Snowflake.
// ---------------------------------------------------------------------------

export interface PimpSettingsTable {
  id: Generated<number>;
  themeName: string;
  themeCreator: string | null;
  dividerStart1: string | null;
  dividerPattern1: string | null;
  dividerEnd1: string | null;
  dividerLength1: Generated<number>;
  dividerCodeBlock1: Generated<SqliteBoolean>;
  dividerStart2: string | null;
  dividerPattern2: string | null;
  dividerEnd2: string | null;
  dividerLength2: Generated<number>;
  dividerCodeBlock2: Generated<SqliteBoolean>;
  dividerStart3: string | null;
  dividerPattern3: string | null;
  dividerEnd3: string | null;
  dividerLength3: Generated<number>;
  dividerCodeBlock3: Generated<SqliteBoolean>;
  emColorString1: string | null;
  emColorString2: string | null;
  emColorString3: string | null;
  emColorString4: string | null;
  headerColor1: string | null;
  headerColor2: string | null;
  is_active: Generated<SqliteBoolean>;
  themeDescription: Generated<string>;
  createdAt: Generated<string>;
  created_guild_id: Snowflake | null;
  allianceOldIcon: string | null; avatarOldIcon: string | null; stoveOldIcon: string | null; stateOldIcon: string | null;
  allianceIcon: string | null; avatarIcon: string | null; stoveIcon: string | null; stateIcon: string | null;
  listIcon: string | null; fidIcon: string | null; timeIcon: string | null; homeIcon: string | null;
  num1Icon: string | null; num2Icon: string | null; num3Icon: string | null; num4Icon: string | null;
  num5Icon: string | null; num10Icon: string | null; newIcon: string | null; pinIcon: string | null;
  saveIcon: string | null; robotIcon: string | null; crossIcon: string | null; heartIcon: string | null;
  shieldIcon: string | null; targetIcon: string | null; redeemIcon: string | null; membersIcon: string | null;
  averageIcon: string | null; messageIcon: string | null; supportIcon: string | null; foundryIcon: string | null;
  announceIcon: string | null; ministerIcon: string | null; researchIcon: string | null; trainingIcon: string | null;
  crazyJoeIcon: string | null; calendarIcon: string | null; editListIcon: string | null; settingsIcon: string | null;
  hourglassIcon: string | null; messageNoIcon: string | null; blankListIcon: string | null; alarmClockIcon: string | null;
  magnifyingIcon: string | null; frostdragonIcon: string | null; canyonClashIcon: string | null; constructionIcon: string | null;
  castleBattleIcon: string | null; giftIcon: string | null; giftsIcon: string | null; giftAddIcon: string | null;
  giftAlarmIcon: string | null; gifAlertIcon: string | null; giftCheckIcon: string | null; giftTotalIcon: string | null;
  giftDeleteIcon: string | null; giftHashtagIcon: string | null; giftSettingsIcon: string | null; processingIcon: string | null;
  verifiedIcon: string | null; questionIcon: string | null; transferIcon: string | null; multiplyIcon: string | null;
  divideIcon: string | null; deniedIcon: string | null; deleteIcon: string | null; exportIcon: string | null;
  importIcon: string | null; retryIcon: string | null; totalIcon: string | null; infoIcon: string | null;
  warnIcon: string | null; addIcon: string | null; prevIcon: string | null; nextIcon: string | null;
  backIcon: string | null; forwardIcon: string | null; minusIcon: string | null; chartIcon: string | null;
  documentIcon: string | null; eyeIcon: string | null; globeIcon: string | null; wizardIcon: string | null;
  muteIcon: string | null; shutdownZzzIcon: string | null; shutdownDoorIcon: string | null; shutdownHandIcon: string | null;
  shutdownMoonIcon: string | null; shutdownPlugIcon: string | null; shutdownStopIcon: string | null; shutdownClapperIcon: string | null;
  shutdownSparkleIcon: string | null; startupGiftIcon: string | null; startupBoxingIcon: string | null; startupRocketIcon: string | null;
  startupLockIcon: string | null; startupFireIcon: string | null; startupSwordsIcon: string | null; startupIceIcon: string | null;
  startupCashIcon: string | null; medalIcon: string | null; checkIcon: string | null; circleIcon: string | null;
  userIcon: string | null; trashIcon: string | null; refreshIcon: string | null; levelIcon: string | null;
  lockIcon: string | null; cleanIcon: string | null; archiveIcon: string | null; upIcon: string | null;
  downIcon: string | null; crownIcon: string | null; linkIcon: string | null; chatIcon: string | null;
  bellIcon: string | null; boltIcon: string | null; locationIcon: string | null; testIcon: string | null;
  packageIcon: string | null; ticketIcon: string | null; fireIcon: string | null; searchIcon: string | null;
  paletteIcon: string | null; eyesIcon: string | null; copyIcon: string | null; starIcon: string | null;
  fortressBattleIcon: string | null; frostfireMineIcon: string | null; svsIcon: string | null; mercenaryIcon: string | null;
  dailyResetIcon: string | null; chiefOfficeIcon: string | null; vaultTrapIcon: string | null;
}

export interface ServerThemeTable {
  guild_id: Snowflake;
  theme_name: string;
}

export interface PimpMyBotDb {
  pimpsettings: PimpSettingsTable;
  server_themes: ServerThemeTable;
}

// ---------------------------------------------------------------------------
// db/events.sqlite -- Phase 2 "notifications", full port. All 10 tables
// added in one pass (schema confirmed against the live dev-copy via
// PRAGMA table_info) even though routes land incrementally across the
// plan doc's 7a-7g sub-stages, to avoid re-touching this file repeatedly.
// ---------------------------------------------------------------------------

export interface VaultNotificationTable {
  id: Generated<number>;
  guild_id: Snowflake;
  channel_id: Snowflake;
  hour: number;
  minute: number;
  timezone: string;
  /** Overloaded: plain text, OR "CUSTOM_TIMES:30,10,5,0|<message>", OR
   * "EMBED_MESSAGE:<title>" (redirects the sender to the linked
   * vault_notification_embeds row instead). The backend is the only
   * place allowed to assemble/parse this -- see routes/notifications.ts. */
  description: string;
  notification_type: number;
  mention_type: string;
  repeat_enabled: Generated<SqliteBoolean>;
  /** Discriminated sentinel, not a plain interval: >0 = literal-minutes
   * repeat; 0 = no repeat (re-arms same-time-tomorrow if missed); -1 =
   * specific weekdays (via notification_days); -2 = calendar-month
   * custom event (via custom_events.recurrence_interval). */
  repeat_minutes: Generated<number | null>;
  is_enabled: Generated<SqliteBoolean>;
  created_at: Generated<string | null>;
  created_by: Snowflake;
  last_notification: string | null;
  next_notification: string | null;
  event_type: string | null;
  wizard_batch_id: string | null;
  instance_identifier: string | null;
  auto_disabled_at: string | null;
  custom_event_id: number | null;
  custom_delete_delay_minutes: number | null;
  channel_name: string | null;
}

export interface NotificationHistoryTable {
  id: Generated<number>;
  notification_id: number;
  notification_time: number;
  sent_at: Generated<string | null>;
  message_id: Snowflake | null;
  channel_id: Snowflake | null;
  scheduled_delete_at: string | null;
  deleted_at: string | null;
}

export interface VaultNotificationEmbedTable {
  id: Generated<number>;
  notification_id: number;
  title: string | null;
  description: string | null;
  color: number | null;
  image_url: string | null;
  thumbnail_url: string | null;
  footer: string | null;
  author: string | null;
  mention_message: string | null;
  created_at: Generated<string | null>;
}

export interface NotificationDayTable {
  notification_id: number | null;
  weekday: string | null;
}

export interface EventReferenceOverrideTable {
  guild_id: Snowflake | null;
  event_type: string | null;
  reference_date: string | null;
}

export interface CustomEventTable {
  id: Generated<number>;
  guild_id: Snowflake | null;
  name: string | null;
  icon_url: string | null;
  first_occurrence: string | null;
  /** One of "daily" | "weekly" | "monthly" -- see
   * cogs/notification_event_types.py's RECURRENCE_TYPES. */
  recurrence_type: string | null;
  recurrence_interval: number | null;
  /** JSON-encoded array of minutes-before, sorted descending, e.g.
   * "[10,5,0]" -- see cogs/notification_wizard.py's reminder_offsets. */
  reminder_offsets: string | null;
  channel_id: Snowflake | null;
  created_by: Snowflake | null;
  created_at: string | null;
}

export interface VaultTrapSettingsTable {
  guild_id: Snowflake;
  delete_messages_enabled: Generated<SqliteBoolean>;
  default_delete_delay_minutes: Generated<number>;
  show_daily_reset_on_schedule: Generated<SqliteBoolean>;
}

export interface NotificationScheduleBoardTable {
  id: Generated<number>;
  guild_id: Snowflake;
  channel_id: Snowflake;
  message_id: Snowflake;
  board_type: string;
  target_channel_id: Snowflake | null;
  max_events: Generated<number>;
  show_disabled: Generated<SqliteBoolean>;
  auto_pin: Generated<SqliteBoolean>;
  timezone: Generated<string>;
  filter_name: string | null;
  filter_time_range: number | null;
  created_at: Generated<string | null>;
  created_by: Snowflake;
  last_updated: string | null;
  show_repeating_events: Generated<SqliteBoolean>;
  use_user_timezone: Generated<SqliteBoolean>;
  hide_daily_reset: Generated<SqliteBoolean>;
}

export interface NotificationTemplateTable {
  template_id: Generated<number>;
  template_name: string;
  event_type: string | null;
  description: string | null;
  notification_type: number | null;
  default_times: string | null;
  embed_title: string | null;
  embed_description: string | null;
  embed_color: string | null;
  embed_image_url: string | null;
  embed_thumbnail_url: string | null;
  repeat_config: string | null;
  is_global: Generated<SqliteBoolean>;
  created_by: Snowflake | null;
  created_at: Generated<string | null>;
  mention_message: string | null;
  footer: string | null;
  author: string | null;
}

export interface WizardNotificationTable {
  notification_id: number;
  guild_id: Snowflake;
  event_type: string;
  created_by_wizard: Generated<SqliteBoolean>;
  wizard_run_id: string | null;
}

export interface EventsDb {
  vault_notifications: VaultNotificationTable;
  notification_history: NotificationHistoryTable;
  vault_notification_embeds: VaultNotificationEmbedTable;
  notification_days: NotificationDayTable;
  event_reference_overrides: EventReferenceOverrideTable;
  custom_events: CustomEventTable;
  vault_trap_settings: VaultTrapSettingsTable;
  notification_schedule_boards: NotificationScheduleBoardTable;
  notification_templates: NotificationTemplateTable;
  wizard_notifications: WizardNotificationTable;
}

// ---------------------------------------------------------------------------
// webapp/backend/db/webapp.sqlite -- owned entirely by this app, the ONE
// file this codebase is allowed to CREATE TABLE against (see
// db/connections.ts's initWebappSchema).
// ---------------------------------------------------------------------------

export interface SessionsTable {
  id: string;
  discord_id: Snowflake;
  active_guild_id: Snowflake | null;
  /** Discord OAuth access/refresh tokens, needed to re-derive the
   * caller's live guild membership for the Server-tier guild-selection
   * screen (GET /api/auth/guilds) without forcing a re-login. Stored
   * plaintext in webapp.sqlite -- consistent with the security bar the
   * rest of this file already accepts (see session ids), but a good
   * candidate for at-rest encryption in a later hardening pass. Never
   * sent to the client or logged. */
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  created_at: string;
  expires_at: string;
}

/** General-purpose activity log for this app's own mutating routes
 * (notifications, custom events, templates, theming, backups, gift
 * codes) -- deliberately separate from the bot's own
 * `permission_audit_log` (settings.sqlite), which is a Python-owned
 * table with grant/revoke-shaped semantics (before/after permission
 * state) that this app only reads, never extends. */
export interface AppAuditLogTable {
  id: Generated<number>;
  actor_id: Snowflake;
  guild_id: Snowflake | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  detail: string | null;
  created_at: string;
}

export interface WebappDb {
  sessions: SessionsTable;
  app_audit_log: AppAuditLogTable;
}
