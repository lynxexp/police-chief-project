/**
 * Timezone handling for vault_notifications.timezone -- a free-text IANA
 * zone name (e.g. "UTC", "Europe/Istanbul"), validated in the Python
 * source via `pytz.timezone(name)` raising UnknownTimeZoneError (see
 * cogs/notification_system.py's TimeSelectModal.on_submit). Node's Intl
 * uses the same IANA tz database, so the same names validate here.
 *
 * save_notification() stores next_notification as
 * `tz.localize(naive_dt).isoformat()` -- the wall-clock date/time
 * exactly as entered, suffixed with that zone's UTC offset AT THAT
 * INSTANT (not converted to UTC). localizedIsoString reproduces that
 * exact string shape so downstream date math (calculate_next_occurrence,
 * process_notification's `datetime.fromisoformat(...)` comparisons)
 * keeps working unmodified.
 */

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (in minutes, UTC-relative, positive = ahead of UTC) of
 * `timeZone` at the instant `utcGuess` represents. */
function offsetMinutesAt(utcGuess: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(utcGuess);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return (asUtc - utcGuess.getTime()) / 60_000;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** Builds an ISO-8601 string for wall-clock `date` (YYYY-MM-DD) +
 * `hour`:`minute` as understood in `timeZone`, suffixed with that
 * zone's UTC offset -- e.g. "2026-08-26T09:30:00-04:00". Caller must
 * validate `timeZone` with isValidTimezone() first. */
export function localizedIsoString(date: string, hour: number, minute: number, timeZone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  // First guess treats the wall-clock time as UTC, then resolves the
  // real offset for that approximate instant and formats directly --
  // no second guess/iteration needed except right at a DST transition,
  // which pytz.localize() doesn't reliably disambiguate either.
  const guess = new Date(Date.UTC(year!, month! - 1, day!, hour, minute, 0));
  const offset = offsetMinutesAt(guess, timeZone);
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${date}T${hh}:${mm}:00${formatOffset(offset)}`;
}

/**
 * Swaps the hour/minute of an already-localized ISO string (e.g.
 * "2026-08-26T09:30:00-04:00") while keeping its date AND offset intact.
 * Mirrors `existing_datetime.replace(hour=, minute=, second=0,
 * microsecond=0)` in Python's update_notification() -- notably, this
 * does NOT recompute the offset for a newly-submitted timezone. That's
 * a real quirk of the source: editing hour/minute together with the
 * timezone field, without also re-picking the date, anchors the actual
 * fire instant to the OLD offset until the date is next touched. Ported
 * exactly rather than "fixed," per the plan's port-exactly policy for
 * schedule date math -- see routes/notifications.ts's PATCH handler. */
export function replaceHourMinute(isoWithOffset: string, hour: number, minute: number): string {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return isoWithOffset.replace(/T\d{2}:\d{2}:\d{2}/, `T${hh}:${mm}:00`);
}

/** Formats a UTC instant the way pytz's aware-UTC `.isoformat()` does --
 * "+00:00", not JS's default "Z" suffix -- so it round-trips through
 * datetime.fromisoformat() on the Python side unchanged. Used for
 * custom_events.first_occurrence and the notification rows materialized
 * from it, which are always UTC (see notification_wizard.py's
 * CustomEventDateTimeModal, title "First Occurrence (UTC)"). */
export function toUtcIsoString(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

/**
 * Formats a UTC Date as the same naive "YYYY-MM-DD HH:MM:SS" text SQLite's
 * bare `DEFAULT CURRENT_TIMESTAMP` columns use. Needed because comparing a
 * `.toISOString()` string (has a "T" and trailing "Z"/millis) against a
 * naive `sent_at` value with SQL `>=`/`<=` is a byte-wise TEXT comparison
 * -- "T" (0x54) sorts above " " (0x20), so any naive value sharing the
 * same calendar day as the ISO bound compares as "less than" it
 * regardless of actual time-of-day, silently dropping same-day rows from
 * a `>=` lower-bound filter. Format both sides the same way instead.
 */
export function toNaiveSqliteTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Normalizes a stored timestamp to an unambiguous, explicitly-UTC ISO
 * string. Several columns across events.sqlite rely on SQLite's bare
 * `DEFAULT CURRENT_TIMESTAMP` (vault_notifications.created_at,
 * notification_history.sent_at, custom_events.created_at) --
 * these come back as naive "YYYY-MM-DD HH:MM:SS" strings (space-
 * separated, no offset), and the Python source's own comment confirms
 * the intent: "sent_at is stored as UTC wall time - compare in UTC, not
 * the notification's timezone." That's fine as long as every reader
 * treats it as UTC, but `new Date(...)` on a suffix-less string is
 * parsed as LOCAL time by both Node and every browser engine (per the
 * ECMAScript Date Time String Format spec) -- silently wrong by the
 * viewer's UTC offset for anyone not literally in UTC. Columns written
 * by this webapp's own code (e.g. custom_events.created_at, via
 * `new Date().toISOString()`) already carry a real offset and pass
 * through unchanged -- this only patches the ones that don't.
 */
export function normalizeStoredUtcTimestamp(raw: string): string;
export function normalizeStoredUtcTimestamp(raw: string | null): string | null;
export function normalizeStoredUtcTimestamp(raw: string | null): string | null {
  if (raw === null) return null;
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw)) return raw; // already has an explicit offset
  return `${raw.replace(" ", "T")}Z`;
}

/** True if `date` (YYYY-MM-DD) is strictly before "today" as observed in
 * `timeZone` -- mirrors TimeSelectModal.on_submit's
 * `start_date.date() < now.date()` guard (date-only, not time-of-day). */
export function isPastDateInTimezone(date: string, timeZone: string): boolean {
  const todayInTz = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  return date < todayInTz;
}

/**
 * notification_schedule_boards.timezone accepts a wider format than
 * vault_notifications.timezone -- mirrors _get_timezone_object() exactly:
 * "UTC" verbatim, a fixed "UTC+05:30"-style offset (NOT a valid IANA
 * zone name, needs its own parsing), or anything else falls through to a
 * real IANA zone (including "Etc/GMT+N" -- already a valid IANA id, so
 * the generic Intl path below handles it with no special-casing needed,
 * unlike the Python source which routes it through the same pytz.timezone()
 * fallback branch anyway). Returns the offset in minutes for the given
 * instant, or 0 (UTC) if the string doesn't resolve to anything -- same
 * silent-fallback-to-UTC behavior as the Python source's try/except.
 */
export function scheduleTimezoneOffsetMinutes(tzString: string, at: Date): number {
  if (tzString === "UTC") return 0;
  if (tzString.startsWith("UTC+") || tzString.startsWith("UTC-")) {
    const sign = tzString[3] === "+" ? 1 : -1;
    const parts = tzString.slice(4).split(":");
    if (parts.length === 2) {
      const hours = parseInt(parts[0]!, 10);
      const minutes = parseInt(parts[1]!, 10);
      if (!Number.isNaN(hours) && !Number.isNaN(minutes)) {
        return sign * (hours * 60 + minutes);
      }
    }
    return 0;
  }
  try {
    return offsetMinutesAt(at, tzString);
  } catch {
    return 0;
  }
}

/**
 * Converts a stored timezone string to a friendly display form --
 * mirrors _format_timezone_display() exactly: "Etc/GMT-3" -> "UTC+3"
 * (Etc/GMT zones are sign-inverted from their common-sense meaning),
 * "UTC+05:30" -> "UTC+5:30" (drop the leading zero on hours), anything
 * else passed through unchanged.
 */
export function formatTimezoneDisplay(tzZone: string): string {
  if (tzZone === "UTC") return "UTC";
  if (tzZone.startsWith("UTC+") || tzZone.startsWith("UTC-")) {
    const sign = tzZone[3]!;
    const parts = tzZone.slice(4).split(":");
    if (parts.length === 2) {
      const hours = parseInt(parts[0]!, 10);
      const minutes = parseInt(parts[1]!, 10);
      if (!Number.isNaN(hours) && !Number.isNaN(minutes)) {
        return minutes === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${String(minutes).padStart(2, "0")}`;
      }
    }
    return tzZone;
  }
  if (tzZone.startsWith("Etc/GMT")) {
    const offset = parseInt(tzZone.slice("Etc/GMT".length), 10);
    if (!Number.isNaN(offset)) {
      const actual = -offset;
      return actual === 0 ? "UTC" : `UTC${actual > 0 ? "+" : ""}${actual}`;
    }
    return tzZone;
  }
  return tzZone;
}
