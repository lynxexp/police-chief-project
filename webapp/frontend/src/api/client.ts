/**
 * Typed fetch wrapper for the Fastify API (see webapp/backend/src/routes/auth.ts).
 * Same-origin in both dev (Vite proxy, see vite.config.ts) and prod
 * (Fastify serves this build directly) -- no CORS handling needed, but
 * `credentials: "include"` is still required so the httpOnly session
 * cookie rides along on every request.
 */

export type Tier = "owner" | "global" | "server" | "alliance" | "none";

/**
 * Discord snowflakes (user/guild/channel ids) are always strings here,
 * never numbers -- they're 64-bit and routinely exceed
 * Number.MAX_SAFE_INTEGER, so a JS/JSON number would silently corrupt
 * them (see the backend's db/schema.ts Snowflake doc comment). Never
 * call Number()/parseInt() on one of these fields.
 */
export interface AuthContext {
  discordId: string;
  tier: Tier;
  isOwner: boolean;
  isGlobal: boolean;
  activeGuildId: string | null;
  needsGuildSelection: boolean;
  availableGuildIds: string[];
  csrfToken: string;
}

export interface GuildOption {
  id: string;
  name: string;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Set whenever getMe() succeeds -- attached to every mutating request
 * (see plugins/csrf.ts on the backend) so /api/admin/* writes don't need
 * every call site to thread the token through manually. */
let csrfToken: string | null = null;

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  const headers: Record<string, string> = {};
  // Only set Content-Type when there's actually a body -- Fastify rejects
  // an empty body sent with application/json (400
  // FST_ERR_CTP_EMPTY_JSON_BODY), which every no-body POST here (logout,
  // etc.) would otherwise hit.
  if (init?.body) headers["Content-Type"] = "application/json";
  if (MUTATING_METHODS.has(method) && csrfToken) headers["x-csrf-token"] = csrfToken;

  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers,
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `request to ${path} failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const LOGIN_URL = "/api/auth/login";

/** Returns null (rather than throwing) on a 401 -- "not logged in" is a
 * normal, expected outcome here, not an error case callers should have
 * to catch. */
export async function getMe(): Promise<AuthContext | null> {
  try {
    const ctx = await request<AuthContext>("/auth/me");
    csrfToken = ctx.csrfToken;
    return ctx;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function getGuilds(): Promise<GuildOption[]> {
  return request<GuildOption[]>("/auth/guilds");
}

export function setActiveGuild(guildId: string): Promise<AuthContext> {
  return request<AuthContext>("/auth/active-guild", {
    method: "POST",
    body: JSON.stringify({ guildId }),
  });
}

export function logout(): Promise<void> {
  return request<void>("/auth/logout", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Member views (see routes/member.ts) -- alliance-open: any of these can be
// called for any allianceId/fid the caller belongs to or administers, not
// just their own.
// ---------------------------------------------------------------------------

export interface OwnProfileEntry {
  fid: number;
  nickname: string | null;
  allianceId: number | null;
  allianceName: string | null;
  chiefOfficeLv: number | null;
  power: number | null;
  combatPower: number | null;
  isActive: boolean;
}

export interface RosterMember {
  fid: number;
  nickname: string | null;
  chiefOfficeLv: number | null;
  power: number | null;
  combatPower: number | null;
  isActive: boolean;
}

export interface VaultTrendPoint {
  date: string;
  trapNumber: number;
  damage: number;
  rank: number | null;
}

export interface CapitolTrendPoint {
  date: string;
  points: number;
  rank: number | null;
}

export interface HistoryEntry<T> {
  oldValue: T;
  newValue: T;
  changeDate: string;
}

export interface MemberHistory {
  nicknameChanges: HistoryEntry<string | null>[];
  chiefOfficeChanges: HistoryEntry<number | null>[];
  powerChanges: HistoryEntry<number>[];
  combatPowerChanges: HistoryEntry<number>[];
}

export interface AllianceVaultTrendPoint {
  date: string;
  totalDamage: number;
  hunts: number;
  avgDamage: number;
}

export interface AllianceCapitolTrendPoint {
  date: string;
  totalPoints: number;
}

export interface VaultLeaderboardEntry {
  rank: number;
  fid: number;
  nickname: string | null;
  totalDamage: number;
  hunts: number;
  avgDamage: number;
}

export interface CapitolLeaderboardEntry {
  rank: number;
  fid: number;
  nickname: string | null;
  totalPoints: number;
  events: number;
  avgPoints: number;
}

export interface AttendanceMember {
  fid: number;
  nickname: string | null;
  attended: number;
  attendanceRate: number;
}

export interface AttendanceResponse {
  totalSessions: number;
  members: AttendanceMember[];
}

export function getOwnProfile(): Promise<OwnProfileEntry[]> {
  return request<OwnProfileEntry[]>("/member/profile");
}

export function getAllianceMembers(allianceId: number, includeInactive = false): Promise<RosterMember[]> {
  const qs = includeInactive ? "?includeInactive=true" : "";
  return request<RosterMember[]>(`/alliance/${allianceId}/members${qs}`);
}

export function getMemberVaultTrend(allianceId: number, fid: number): Promise<VaultTrendPoint[]> {
  return request<VaultTrendPoint[]>(`/alliance/${allianceId}/members/${fid}/vault-trend`);
}

export function getMemberCapitolTrend(allianceId: number, fid: number): Promise<CapitolTrendPoint[]> {
  return request<CapitolTrendPoint[]>(`/alliance/${allianceId}/members/${fid}/capitol-trend`);
}

export function getMemberHistory(allianceId: number, fid: number): Promise<MemberHistory> {
  return request<MemberHistory>(`/alliance/${allianceId}/members/${fid}/history`);
}

/** Distinct Vault Trap numbers this alliance has hunts for (typically
 * [1, 2]) -- drives the "Vault 1 / Vault 2" split everywhere below,
 * without hardcoding how many traps exist. */
export function getAllianceVaultTraps(allianceId: number): Promise<number[]> {
  return request<number[]>(`/alliance/${allianceId}/vault-traps`);
}

export function getAllianceVaultTrend(allianceId: number, trap?: number): Promise<AllianceVaultTrendPoint[]> {
  const qs = trap !== undefined ? `?trap=${trap}` : "";
  return request<AllianceVaultTrendPoint[]>(`/alliance/${allianceId}/vault-trend${qs}`);
}

export function getAllianceCapitolTrend(allianceId: number): Promise<AllianceCapitolTrendPoint[]> {
  return request<AllianceCapitolTrendPoint[]>(`/alliance/${allianceId}/capitol-trend`);
}

export function getVaultLeaderboard(
  allianceId: number,
  range?: { from?: string; to?: string; trap?: number },
): Promise<VaultLeaderboardEntry[]> {
  const qs = buildRangeQuery(range);
  return request<VaultLeaderboardEntry[]>(`/alliance/${allianceId}/leaderboard/vault${qs}`);
}

export function getCapitolLeaderboard(
  allianceId: number,
  range?: { from?: string; to?: string },
): Promise<CapitolLeaderboardEntry[]> {
  const qs = buildRangeQuery(range);
  return request<CapitolLeaderboardEntry[]>(`/alliance/${allianceId}/leaderboard/capitol${qs}`);
}

/** "Attended" = has a damage row for that hunt -- derived from the same
 * data as the trend/leaderboard endpoints, not the bot's separate
 * present/absent-marking attendance system (see the Phase 2 plan). */
export function getVaultAttendance(allianceId: number, trap?: number): Promise<AttendanceResponse> {
  const qs = trap !== undefined ? `?trap=${trap}` : "";
  return request<AttendanceResponse>(`/alliance/${allianceId}/vault-attendance${qs}`);
}

export function getCapitolAttendance(allianceId: number): Promise<AttendanceResponse> {
  return request<AttendanceResponse>(`/alliance/${allianceId}/capitol-attendance`);
}

// ---------------------------------------------------------------------------
// Calendar (new feature, not a port) -- alliance-open like the roster
// above: any member of the alliance, or an admin with reach to it, can
// view it (canViewAlliance), not just guild admins. Sourced from
// custom_events' recurring definitions and any other notification with
// a real schedule, plus notification_history for past occurrences.
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  id: string;
  time: string;
  isPast: boolean;
  icon: string;
  name: string;
  eventType: string | null;
  channelId: string | null;
}

export interface CalendarResponse {
  guildId: string | null;
  events: CalendarEvent[];
}

export function getAllianceCalendar(allianceId: number, rangeStart: string, rangeEnd: string): Promise<CalendarResponse> {
  return request(`/alliance/${allianceId}/calendar?rangeStart=${rangeStart}&rangeEnd=${rangeEnd}`);
}

function buildRangeQuery(range?: { from?: string; to?: string; trap?: number }): string {
  if (!range) return "";
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  if (range.trap !== undefined) params.set("trap", String(range.trap));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// ---------------------------------------------------------------------------
// Admin views (see routes/admin.ts) -- Stage C, read-only. Every route 403s
// server-side for a non-admin or an admin without reach to the target
// alliance, so these calls fail closed even if a page is reached directly.
// ---------------------------------------------------------------------------

export interface AdminAllianceOption {
  allianceId: number;
  name: string | null;
}

export interface AdminMember {
  fid: number;
  nickname: string | null;
  chiefOfficeLv: number | null;
  kid: number | null;
  power: number | null;
  combatPower: number | null;
  discordId: string | null;
  discordServerId: string | null;
  isActive: boolean;
  deactivatedAt: string | null;
}

export interface AdminListEntry {
  id: string;
  tier: Tier;
  isInitial: boolean;
  isOwner: boolean;
  allianceCount: number;
  name: string | null;
}

export interface AdminPermissionsResponse {
  ownerId: string | null;
  admins: AdminListEntry[];
}

export interface AuditLogRow {
  actorId: string;
  action: string;
  targetId: string;
  beforeState: string | null;
  afterState: string | null;
  timestamp: string;
  actorName: string | null;
  targetName: string | null;
}

export interface AuditLogPage {
  total: number;
  rows: AuditLogRow[];
}

export function getAdminAlliances(): Promise<AdminAllianceOption[]> {
  return request<AdminAllianceOption[]>("/admin/alliances");
}

export function getAdminAllianceMembers(allianceId: number, activeOnly = false): Promise<AdminMember[]> {
  const qs = activeOnly ? "?activeOnly=true" : "";
  return request<AdminMember[]>(`/admin/alliances/${allianceId}/members${qs}`);
}

export function getAdminPermissions(): Promise<AdminPermissionsResponse> {
  return request<AdminPermissionsResponse>("/admin/permissions");
}

export function getAuditLog(offset = 0, limit = 10): Promise<AuditLogPage> {
  return request<AuditLogPage>(`/admin/permissions/audit-log?offset=${offset}&limit=${limit}`);
}

export interface AppAuditLogRow {
  actorId: string;
  guildId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  detail: string | null;
  createdAt: string;
  actorName: string | null;
}

export interface AppAuditLogPage {
  total: number;
  rows: AppAuditLogRow[];
}

export function getAppAuditLog(offset = 0, limit = 10): Promise<AppAuditLogPage> {
  return request<AppAuditLogPage>(`/admin/audit-log?offset=${offset}&limit=${limit}`);
}

// ---------------------------------------------------------------------------
// Admin writes -- Stage D. Every call needs the CSRF token already set by a
// prior getMe() (see the module-level csrfToken var above); ProtectedRoute
// guarantees that ran before any of these pages can render.
// ---------------------------------------------------------------------------

export function deactivateMember(allianceId: number, fid: number): Promise<{ ok: true }> {
  return request(`/admin/alliances/${allianceId}/members/${fid}/deactivate`, { method: "PATCH" });
}

export function reactivateMember(allianceId: number, fid: number): Promise<{ ok: true }> {
  return request(`/admin/alliances/${allianceId}/members/${fid}/reactivate`, { method: "PATCH" });
}

export function linkMemberDiscord(
  allianceId: number,
  fid: number,
  discordId: string,
  serverId: string,
): Promise<{ ok: true }> {
  return request(`/admin/alliances/${allianceId}/members/${fid}/discord-link`, {
    method: "PATCH",
    body: JSON.stringify({ discordId, serverId }),
  });
}

export function unlinkMemberDiscord(allianceId: number, fid: number): Promise<{ ok: true }> {
  return request(`/admin/alliances/${allianceId}/members/${fid}/discord-link`, { method: "DELETE" });
}

export interface AllianceSettings {
  channelId: string | null;
  redemptionChannelId: string | null;
  vaultScoreChannel: string | null;
  capitolScoreChannel: string | null;
}

export interface AllianceChannel {
  id: string;
  name: string;
}

export function getAllianceSettings(allianceId: number): Promise<AllianceSettings> {
  return request<AllianceSettings>(`/admin/alliances/${allianceId}/settings`);
}

export function updateAllianceSettings(
  allianceId: number,
  patch: Partial<AllianceSettings>,
): Promise<{ ok: true }> {
  return request(`/admin/alliances/${allianceId}/settings`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function getAllianceChannels(allianceId: number): Promise<AllianceChannel[]> {
  return request<AllianceChannel[]>(`/admin/alliances/${allianceId}/channels`);
}

export function addAdmin(
  discordId: string,
  tier: Tier,
  allianceIds?: number[],
): Promise<{ ok: true }> {
  return request("/admin/permissions", {
    method: "POST",
    body: JSON.stringify({ discordId, tier, allianceIds }),
  });
}

export function setAdminTier(
  id: string,
  tier: Tier,
  allianceIds?: number[],
): Promise<{ ok: true }> {
  return request(`/admin/permissions/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ tier, allianceIds }),
  });
}

export function removeAdmin(id: string): Promise<{ ok: true }> {
  return request(`/admin/permissions/${id}`, { method: "DELETE" });
}

export function transferOwnership(targetId: string): Promise<{ ok: true }> {
  return request("/admin/permissions/transfer-owner", {
    method: "POST",
    body: JSON.stringify({ targetId }),
  });
}

// ---------------------------------------------------------------------------
// Gift codes (see routes/giftcodes.ts). Adding a new code gets announced to
// Discord by the bot's own polling loop within about a minute; editing an
// existing one is DB-only -- see that file's doc comment.
// ---------------------------------------------------------------------------

export interface GiftCode {
  giftcode: string;
  date: string | null;
  note: string | null;
  expiryDate: string | null;
}

export interface AdminGiftCode extends GiftCode {
  createdBy: string | null;
  isActive: boolean;
}

export function getGiftCodes(): Promise<GiftCode[]> {
  return request<GiftCode[]>("/gift-codes");
}

export function getAdminGiftCodes(): Promise<AdminGiftCode[]> {
  return request<AdminGiftCode[]>("/admin/gift-codes");
}

export function addGiftCode(
  giftcode: string,
  note?: string | null,
  expiryDate?: string | null,
): Promise<{ ok: true }> {
  return request("/admin/gift-codes", {
    method: "POST",
    body: JSON.stringify({ giftcode, note, expiryDate }),
  });
}

export function updateGiftCode(
  giftcode: string,
  patch: { note?: string | null; expiryDate?: string | null; isActive?: boolean },
): Promise<{ ok: true }> {
  return request(`/admin/gift-codes/${encodeURIComponent(giftcode)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function getAllianceGiftChannel(allianceId: number): Promise<{ channelId: string | null }> {
  return request(`/admin/alliances/${allianceId}/gift-channel`);
}

export function updateAllianceGiftChannel(allianceId: number, channelId: string | null): Promise<{ ok: true }> {
  return request(`/admin/alliances/${allianceId}/gift-channel`, {
    method: "PATCH",
    body: JSON.stringify({ channelId }),
  });
}

// ---------------------------------------------------------------------------
// ID channel / self-registration (see routes/idchannel.ts). Three
// independent scopes: register_settings is bot-wide (Owner/Global only),
// id-channel-settings is per-guild (Server tier+), id-channels is
// per-alliance (any admin with reach to that alliance).
// ---------------------------------------------------------------------------

export function getAllianceGuild(allianceId: number): Promise<{ guildId: string | null }> {
  return request(`/admin/alliances/${allianceId}/guild`);
}

export function getRegisterSettings(): Promise<{ enabled: boolean }> {
  return request("/admin/register-settings");
}

export function updateRegisterSettings(enabled: boolean): Promise<{ ok: true }> {
  return request("/admin/register-settings", { method: "PATCH", body: JSON.stringify({ enabled }) });
}

export interface IdChannelScanSettings {
  scanEnabled: boolean;
  scanLimit: number;
  deleteAfter: number;
  respondToInvalid: boolean;
}

export function getIdChannelSettings(guildId: string): Promise<IdChannelScanSettings> {
  return request(`/admin/guilds/${guildId}/id-channel-settings`);
}

export function updateIdChannelSettings(
  guildId: string,
  patch: Partial<IdChannelScanSettings>,
): Promise<{ ok: true }> {
  return request(`/admin/guilds/${guildId}/id-channel-settings`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export interface IdChannel {
  channelId: string;
  createdAt: string | null;
  createdBy: string | null;
}

export function getAllianceIdChannels(allianceId: number): Promise<IdChannel[]> {
  return request(`/admin/alliances/${allianceId}/id-channels`);
}

export function addAllianceIdChannel(allianceId: number, channelId: string): Promise<{ ok: true }> {
  return request(`/admin/alliances/${allianceId}/id-channels`, {
    method: "POST",
    body: JSON.stringify({ channelId }),
  });
}

export function removeAllianceIdChannel(allianceId: number, channelId: string): Promise<{ ok: true }> {
  return request(`/admin/alliances/${allianceId}/id-channels/${channelId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Bot operations (see routes/backups.ts) -- backup creation + listing only,
// Owner-only. No restore endpoint exists, deliberately.
// ---------------------------------------------------------------------------

export interface BackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export function getBackups(): Promise<BackupFile[]> {
  return request<BackupFile[]>("/admin/backups");
}

export function createBackup(): Promise<{ ok: true; filename: string }> {
  return request("/admin/backups", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Theming (see routes/theming.ts). Theme CRUD is Owner/Global-only; which
// theme a guild uses (server_themes) is canManageGuild (Server tier+).
// ---------------------------------------------------------------------------

export interface ThemeSummary {
  themeName: string;
  themeCreator: string | null;
  themeDescription: string;
  isActive: boolean;
  createdAt: string;
}

/** Full theme row -- ~150 icon fields plus dividers/colors/metadata, all
 * indexed dynamically by the editor form, so this stays a loose index
 * signature rather than naming every field (mirrors the backend's own
 * pragmatic choice for the same table). */
export interface ThemeDetail {
  [column: string]: string | number | null;
}

export function getThemes(): Promise<ThemeSummary[]> {
  return request<ThemeSummary[]>("/admin/themes");
}

export function getTheme(themeName: string): Promise<ThemeDetail> {
  return request<ThemeDetail>(`/admin/themes/${encodeURIComponent(themeName)}`);
}

export function createTheme(themeName: string, themeDescription?: string): Promise<{ ok: true }> {
  return request("/admin/themes", {
    method: "POST",
    body: JSON.stringify({ themeName, themeDescription }),
  });
}

export function updateTheme(
  themeName: string,
  patch: Record<string, string | number | boolean | null>,
): Promise<{ ok: true }> {
  return request(`/admin/themes/${encodeURIComponent(themeName)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteTheme(themeName: string): Promise<{ ok: true }> {
  return request(`/admin/themes/${encodeURIComponent(themeName)}`, { method: "DELETE" });
}

export function setActiveTheme(themeName: string): Promise<{ ok: true }> {
  return request(`/admin/themes/${encodeURIComponent(themeName)}/set-active`, { method: "POST" });
}

export function getGuildTheme(guildId: string): Promise<{ themeName: string | null }> {
  return request(`/admin/guilds/${guildId}/theme`);
}

export function updateGuildTheme(guildId: string, themeName: string | null): Promise<{ ok: true }> {
  return request(`/admin/guilds/${guildId}/theme`, {
    method: "PATCH",
    body: JSON.stringify({ themeName }),
  });
}

// ---------------------------------------------------------------------------
// Notifications (see routes/notifications.ts) -- Stage 7b, read-only.
// Guild-scoped (canManageGuild, Server tier+). description's overloaded
// encoding is already decoded server-side into descriptionKind/descriptionText/
// customTimes -- never re-parse a raw description string here.
// ---------------------------------------------------------------------------

export type DescriptionKind = "plain" | "customTimes" | "embed";

export interface NotificationSummary {
  id: number;
  channelId: string;
  channelName: string | null;
  hour: number;
  minute: number;
  timezone: string;
  descriptionKind: DescriptionKind;
  descriptionText: string;
  customTimes: number[] | null;
  notificationType: number;
  mentionType: string;
  repeatEnabled: boolean;
  repeatMinutes: number | null;
  isEnabled: boolean;
  eventType: string | null;
  eventIcon: string;
  customEventId: number | null;
  createdBy: string;
  createdAt: string | null;
  lastNotification: string | null;
  nextNotification: string | null;
  autoDisabledAt: string | null;
}

export interface NotificationEmbed {
  title: string | null;
  description: string | null;
  color: number | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  footer: string | null;
  author: string | null;
  mentionMessage: string | null;
}

export interface NotificationCustomEvent {
  id: number;
  name: string | null;
  iconUrl: string | null;
  firstOccurrence: string | null;
  recurrenceType: string | null;
  recurrenceInterval: number | null;
}

export interface NotificationDetail {
  id: number;
  channelId: string;
  channelName: string | null;
  hour: number;
  minute: number;
  timezone: string;
  descriptionKind: DescriptionKind;
  descriptionText: string;
  customTimes: number[] | null;
  notificationType: number;
  mentionType: string;
  repeatEnabled: boolean;
  repeatMinutes: number | null;
  isEnabled: boolean;
  eventType: string | null;
  customEventId: number | null;
  wizardBatchId: string | null;
  instanceIdentifier: string | null;
  customDeleteDelayMinutes: number | null;
  createdBy: string;
  createdAt: string | null;
  lastNotification: string | null;
  nextNotification: string | null;
  autoDisabledAt: string | null;
  /** Python .weekday() integers (Monday=0 ... Sunday=6), only meaningful
   * when repeatMinutes === -1. */
  weekdays: number[];
  embed: NotificationEmbed | null;
  customEvent: NotificationCustomEvent | null;
}

export interface NotificationHistoryEntry {
  id: number;
  notificationTime: number;
  sentAt: string | null;
  messageId: string | null;
  channelId: string | null;
  scheduledDeleteAt: string | null;
  deletedAt: string | null;
}

export interface NotificationHistoryPage {
  rows: NotificationHistoryEntry[];
  hasMore: boolean;
}

export interface VaultTrapSettings {
  deleteMessagesEnabled: boolean;
  defaultDeleteDelayMinutes: number;
  showDailyResetOnSchedule: boolean;
}

export function getGuildNotifications(guildId: string): Promise<NotificationSummary[]> {
  return request(`/admin/guilds/${guildId}/notifications`);
}

export function getNotification(guildId: string, id: number): Promise<NotificationDetail> {
  return request(`/admin/guilds/${guildId}/notifications/${id}`);
}

export function getNotificationHistory(
  guildId: string,
  id: number,
  page?: { limit?: number; offset?: number },
): Promise<NotificationHistoryPage> {
  const params = new URLSearchParams();
  if (page?.limit !== undefined) params.set("limit", String(page.limit));
  if (page?.offset !== undefined) params.set("offset", String(page.offset));
  const qs = params.toString();
  return request(`/admin/guilds/${guildId}/notifications/${id}/history${qs ? `?${qs}` : ""}`);
}

export function getVaultTrapSettings(guildId: string): Promise<VaultTrapSettings> {
  return request(`/admin/guilds/${guildId}/vault-trap-settings`);
}

// ---------------------------------------------------------------------------
// Notification CRUD (Stage 7c basic + 7d weekday repeat + 7e embeds).
// notificationType 1-5, repeatMinutes 0 (no repeat), a positive
// literal-minutes interval, or -1 (specific weekdays -- requires
// `weekdays`, Python .weekday() ints, Monday=0..Sunday=6). Monthly
// custom-event repeat (-2) and notification_type 6 (custom times) are
// exclusively set via custom events (see CustomEvent* below) -- not
// settable here, matching the source (a custom event's materialized
// reminder isn't independently editable via the basic form there either).
// messageKind "embed" (default "plain") replaces `description` with an
// `embed` object -- the backend assembles the EMBED_MESSAGE: sentinel,
// never send that encoding as raw description text. Channel is immutable
// after creation -- the backend's update_notification port has no
// channel_id parameter either.
// ---------------------------------------------------------------------------

export interface CreateNotificationInput {
  channelId: string;
  channelName?: string | null;
  date: string;
  hour: number;
  minute: number;
  timezone: string;
  messageKind?: "plain" | "embed";
  description?: string;
  embed?: NotificationEmbed;
  notificationType: number;
  mentionType: string;
  repeatMinutes: number;
  weekdays?: number[];
  eventType?: string | null;
}

export interface EditNotificationInput {
  hour: number;
  minute: number;
  timezone: string;
  messageKind?: "plain" | "embed";
  description?: string;
  embed?: NotificationEmbed;
  notificationType: number;
  mentionType: string;
  repeatMinutes: number;
  weekdays?: number[];
  eventType?: string | null;
}

export function createNotification(guildId: string, input: CreateNotificationInput): Promise<{ ok: true; id: number }> {
  return request(`/admin/guilds/${guildId}/notifications`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateNotification(guildId: string, id: number, input: EditNotificationInput): Promise<{ ok: true }> {
  return request(`/admin/guilds/${guildId}/notifications/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function setNotificationEnabled(guildId: string, id: number, enabled: boolean): Promise<{ ok: true }> {
  return request(`/admin/guilds/${guildId}/notifications/${id}/enabled`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export function deleteNotification(guildId: string, id: number): Promise<{ ok: true }> {
  return request(`/admin/guilds/${guildId}/notifications/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Custom events (Stage 7d) -- an admin-configured recurring event
// calendar. Creating/editing one auto-materializes (delete + recreate)
// its own linked notification (notificationType 6, CUSTOM_TIMES-encoded,
// repeatMinutes derived from recurrenceType -- -2/"monthly" advances via
// the same calculateNextOccurrence() date math ported for Stage 7a).
// Unlike basic notifications, the channel IS editable here -- editing
// re-materializes the linked notification against the new channel.
// ---------------------------------------------------------------------------

export interface CustomEventSummary {
  id: number;
  name: string | null;
  iconUrl: string | null;
  firstOccurrence: string | null;
  recurrenceType: string | null;
  recurrenceInterval: number | null;
  reminderOffsets: number[];
  channelId: string;
  createdBy: string;
  createdAt: string | null;
  nextOccurrence: string | null;
}

export interface CustomEventMaterializedNotification {
  id: number;
  isEnabled: boolean;
  mentionType: string;
  notificationType: number;
  nextNotification: string | null;
  lastNotification: string | null;
  autoDisabledAt: string | null;
}

export interface CustomEventDetail extends Omit<CustomEventSummary, "nextOccurrence"> {
  materializedNotification: CustomEventMaterializedNotification | null;
}

export interface CustomEventInput {
  name: string;
  iconUrl?: string | null;
  date: string;
  hour: number;
  minute: number;
  recurrenceType: string;
  recurrenceInterval: number;
  channelId: string;
  channelName?: string | null;
  notificationType: number;
  customTimes?: number[];
  mentionType: string;
  message?: string;
}

export function getCustomEvents(guildId: string): Promise<CustomEventSummary[]> {
  return request(`/admin/guilds/${guildId}/custom-events`);
}

export interface CustomEventSuggestions {
  guildId: string | null;
  missing: string[];
}

export function getCustomEventSuggestions(allianceId: number): Promise<CustomEventSuggestions> {
  return request(`/admin/alliances/${allianceId}/custom-event-suggestions`);
}

export function getCustomEvent(guildId: string, id: number): Promise<CustomEventDetail> {
  return request(`/admin/guilds/${guildId}/custom-events/${id}`);
}

export function createCustomEvent(guildId: string, input: CustomEventInput): Promise<{ ok: true; id: number }> {
  return request(`/admin/guilds/${guildId}/custom-events`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateCustomEvent(guildId: string, id: number, input: CustomEventInput): Promise<{ ok: true }> {
  return request(`/admin/guilds/${guildId}/custom-events/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteCustomEvent(guildId: string, id: number): Promise<{ ok: true }> {
  return request(`/admin/guilds/${guildId}/custom-events/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Notification templates (Stage 7f) -- bot-wide (no guild concept),
// Owner/Global only, matching Theming's precedent. Built as full CRUD on
// the web by deliberate choice: the bot itself has no way to ever create
// a template row (see routes/templates.ts's doc comment) -- the web is
// the actual way this table gets populated and used.
// ---------------------------------------------------------------------------

export interface TemplateRepeatConfig {
  type: "interval" | "fixed_days";
  minutes?: number;
  days?: number[];
}

export interface TemplateSummary {
  templateId: number;
  templateName: string;
  eventType: string | null;
  description: string | null;
  notificationType: number | null;
  embedTitle: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export interface TemplateDetail extends TemplateSummary {
  customTimes: number[] | null;
  repeatConfig: TemplateRepeatConfig | null;
  embedDescription: string | null;
  embedColor: number | null;
  embedImageUrl: string | null;
  embedThumbnailUrl: string | null;
  footer: string | null;
  author: string | null;
  mentionMessage: string | null;
}

export interface TemplateInput {
  templateName: string;
  eventType?: string | null;
  description?: string | null;
  notificationType?: number | null;
  customTimes?: number[];
  repeatConfig?: TemplateRepeatConfig | null;
  embedTitle?: string | null;
  embedDescription?: string | null;
  embedColor?: number | null;
  embedImageUrl?: string | null;
  embedThumbnailUrl?: string | null;
  footer?: string | null;
  author?: string | null;
  mentionMessage?: string | null;
}

export function getTemplates(): Promise<TemplateSummary[]> {
  return request("/admin/templates");
}

export function getTemplate(id: number): Promise<TemplateDetail> {
  return request(`/admin/templates/${id}`);
}

export function createTemplate(input: TemplateInput): Promise<{ ok: true; id: number }> {
  return request("/admin/templates", { method: "POST", body: JSON.stringify(input) });
}

export function updateTemplate(id: number, input: TemplateInput): Promise<{ ok: true }> {
  return request(`/admin/templates/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteTemplate(id: number): Promise<{ ok: true }> {
  return request(`/admin/templates/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Schedule boards (Stage 7g) -- read-only by deliberate choice. Every
// board mutation (create/edit/move/delete) requires synchronously
// posting/pinning/editing/deleting a real Discord message, which this
// webapp has no mechanism for (see routes/scheduleBoards.ts). Board
// management stays exclusively in Discord; the web offers a read-only
// list of existing board configuration plus a live bucketed-preview
// tool that computes the same imminent/soon/upcoming/this-week/
// next-week/later grouping a real board's embed would.
// ---------------------------------------------------------------------------

export interface ScheduleBoard {
  id: number;
  channelId: string;
  boardType: string;
  targetChannelId: string | null;
  maxEvents: number;
  showDisabled: boolean;
  autoPin: boolean;
  timezone: string;
  timezoneDisplay: string;
  filterName: string | null;
  filterTimeRange: number | null;
  showRepeatingEvents: boolean;
  useUserTimezone: boolean;
  hideDailyReset: boolean;
  createdBy: string | null;
  createdAt: string | null;
  lastUpdated: string | null;
}

export interface SchedulePreviewEvent {
  timeLabel: string;
  icon: string;
  name: string;
  channelId: string | null;
  isEnabled: boolean;
}

export interface SchedulePreviewDayGroup {
  date: string;
  events: SchedulePreviewEvent[];
}

export type ScheduleBucketKey = "imminent" | "soon" | "upcoming" | "thisWeek" | "nextWeek" | "later";

export interface SchedulePreviewResult {
  isEmpty: boolean;
  totalEvents: number;
  totalPages: number;
  page: number;
  color: number;
  timezoneDisplay: string;
  boardType: string;
  sections: Record<ScheduleBucketKey, SchedulePreviewDayGroup[]>;
  lastUpdated: string;
}

export interface SchedulePreviewParams {
  boardType?: "server" | "channel";
  targetChannelId?: string;
  maxEvents?: number;
  showDisabled?: boolean;
  filterName?: string;
  filterTimeRangeHours?: number;
  showRepeatingEvents?: boolean;
  timezone?: string;
  useUserTimezone?: boolean;
  hideDailyReset?: boolean;
  page?: number;
}

export function getScheduleBoards(guildId: string): Promise<ScheduleBoard[]> {
  return request(`/admin/guilds/${guildId}/schedule-boards`);
}

export function getSchedulePreview(guildId: string, params: SchedulePreviewParams): Promise<SchedulePreviewResult> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") qs.set(key, String(value));
  }
  const query = qs.toString();
  return request(`/admin/guilds/${guildId}/schedule-preview${query ? `?${query}` : ""}`);
}
