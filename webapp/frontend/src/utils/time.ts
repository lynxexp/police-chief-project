/**
 * Admins enter every event/notification time in UTC (the game's own
 * clock), but the number that actually matters to an end user is their
 * own device's local time. Showing only one or the other is ambiguous --
 * this renders both together for any field driven by a stored UTC
 * timestamp, so nobody has to do the mental timezone math.
 */
const UTC_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
};

const LOCAL_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

/** "Aug 22, 2026, 2:00 AM UTC (Aug 21, 10:00 PM local)" -- omits the
 * local half when it would render identically (device already on UTC). */
export function formatUtcAndLocal(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  const utcText = `${date.toLocaleString(undefined, UTC_FORMAT)} UTC`;
  const localText = date.toLocaleString(undefined, LOCAL_FORMAT);
  if (localText === date.toLocaleString(undefined, { ...LOCAL_FORMAT, timeZone: "UTC" })) {
    return utcText;
  }
  return `${utcText}  (${localText} local)`;
}
