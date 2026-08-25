/**
 * Decodes vault_notifications.description's overloaded encoding for
 * display -- see the plan doc's "description column overloading" note.
 * Mirrors the parsing actually used at read/display time in the Python
 * source (cogs/notification_system.py's _format_paused_line() and the
 * desc_preview logic in check_notifications()), NOT the send-path
 * notification_times extraction (which additionally gates on
 * notification_type == 6 -- irrelevant here since we only ever read).
 *
 * There is a THIRD sentinel beyond CUSTOM_TIMES:/EMBED_MESSAGE::
 * "PLAIN_MESSAGE:<text>", written by the "Plain Message" button in
 * MessageTypeView (cogs/notification_system.py's plain_message() at
 * ~line 2415) and stripped at send time (process_notification, ~line
 * 1306-1313) after any CUSTOM_TIMES: unwrapping and before EMBED_MESSAGE
 * would ever apply (the two never coexist -- EMBED_MESSAGE always
 * overwrites the whole description). Ported here so a notification
 * created via that Discord button doesn't display its literal
 * "PLAIN_MESSAGE:" prefix on the web.
 *
 * The web app never writes CUSTOM_TIMES:/EMBED_MESSAGE: directly; routes
 * that create/edit a notification (Stage 7c+) must assemble those the
 * same way save_notification()/update_notification() do, server-side
 * only. PLAIN_MESSAGE: is never written by the web at all -- it's a
 * purely legacy/Discord-side wrapper with no functional difference from
 * unwrapped plain text once stripped, so there's nothing for the web to
 * produce; hasReservedDescriptionPrefix() in routes/notifications.ts
 * rejects an admin typing it manually, same as the other two sentinels.
 */

export interface DecodedDescription {
  /** "plain" = ordinary text. "customTimes" = notification_type 6's
   * "CUSTOM_TIMES:30,10,5|<message>" encoding. "embed" = the
   * "EMBED_MESSAGE:<title>" sentinel -- the real content lives in the
   * linked vault_notification_embeds row, not in this string. */
  kind: "plain" | "customTimes" | "embed";
  /** The human-readable message text, with any CUSTOM_TIMES/EMBED_MESSAGE
   * prefix stripped. For kind "embed" this is empty unless the embed
   * notification also carries CUSTOM_TIMES (both prefixes can combine). */
  text: string;
  /** Minutes-before values in the order they were stored, or null when
   * the description carries no CUSTOM_TIMES prefix. */
  customTimes: number[] | null;
  /** The embed's title (may be the literal sentinel "true" when the
   * embed had no title -- see save_notification()'s `embed_data.get("title", "true")`),
   * or null when kind isn't "embed". */
  embedTitle: string | null;
}

function parseCustomTimes(timesStr: string): number[] {
  const parts = timesStr.includes(",") ? timesStr.split(",") : timesStr.split("-");
  return parts.map((t) => parseInt(t.trim(), 10));
}

/** JS's `String.split(sep, limit)` is NOT equivalent to Python's
 * `str.split(sep, maxsplit)` for limit/maxsplit > 0: JS computes the
 * full split and truncates the resulting array, silently dropping
 * everything past the Nth separator; Python stops splitting after N
 * separators and keeps the true remainder intact in the last element.
 * A message that itself contains a "|" would get truncated by the
 * naive `s.split("|", 2)[1]` this file used to use. This mirrors
 * Python's `s.split(sep, 1)` semantics exactly. */
function splitOnFirst(s: string, sep: string): [string, string | null] {
  const idx = s.indexOf(sep);
  if (idx === -1) return [s, null];
  return [s.slice(0, idx), s.slice(idx + sep.length)];
}

export function decodeDescription(raw: string): DecodedDescription {
  let description = raw;
  let customTimes: number[] | null = null;

  if (description.startsWith("CUSTOM_TIMES:")) {
    const [timesStr, afterPipe] = splitOnFirst(description.slice("CUSTOM_TIMES:".length), "|");
    customTimes = parseCustomTimes(timesStr);
    description = afterPipe ?? "";
  }

  if (description.includes("EMBED_MESSAGE:")) {
    const embedTitle = description.split("EMBED_MESSAGE:")[1] ?? "true";
    return { kind: "embed", text: "", customTimes, embedTitle };
  }

  if (description.startsWith("PLAIN_MESSAGE:")) {
    description = description.slice("PLAIN_MESSAGE:".length);
  }

  if (customTimes) {
    return { kind: "customTimes", text: description, customTimes, embedTitle: null };
  }
  return { kind: "plain", text: description, customTimes: null, embedTitle: null };
}

/**
 * Builds the "CUSTOM_TIMES:30-10-5-0|<message>" encoding -- mirrors
 * notification_wizard.py's save_custom_event() exactly: dash-joined
 * (not comma-joined; decodeDescription() above accepts either, but the
 * source only ever writes dashes), offsets sorted descending. Used when
 * materializing a custom_events row into its linked vault_notifications
 * row (Stage 7d) -- see routes/customEvents.ts.
 */
export function encodeCustomTimesDescription(offsets: number[], message: string): string {
  const sorted = [...offsets].sort((a, b) => b - a);
  return `CUSTOM_TIMES:${sorted.join("-")}|${message}`;
}
