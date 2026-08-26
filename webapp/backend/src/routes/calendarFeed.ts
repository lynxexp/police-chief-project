/**
 * Subscribable per-alliance calendar feed (.ics), plus the token
 * issuance/regeneration endpoints that power the member Calendar page's
 * "Subscribe on your device" section. Separate route file from
 * routes/calendar.ts because auth here is token-based, not session-cookie
 * based -- a calendar app (Google/Apple/Outlook) refetches the subscribed
 * URL on its own schedule with no cookie support, so it authenticates via
 * a long-lived per-user token in the query string instead (see
 * auth/calendarFeedToken.ts's doc comment).
 */
import type { FastifyInstance } from "fastify";
import { allianceDb } from "../db/connections.js";
import { snowflake } from "../db/snowflake.js";
import { resolveAuthContext, canViewAlliance, type AuthContext } from "../auth/context.js";
import type { SessionRecord } from "../auth/session.js";
import { getOrCreateFeedToken, regenerateFeedToken, discordIdForFeedToken } from "../auth/calendarFeedToken.js";
import { computeCalendarEvents } from "./calendar.js";

const allianceIdParam = {
  type: "object",
  required: ["allianceId"],
  properties: { allianceId: { type: "integer" } },
} as const;

const feedQuerystring = {
  type: "object",
  required: ["token"],
  properties: { token: { type: "string" } },
} as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// A subscribed calendar app polls this URL on its own schedule and has no
// concept of "the range currently on screen" the way the interactive
// Calendar page does -- so the feed always serves the same fixed window,
// wide enough to cover any device's default lookahead. Matches
// routes/calendar.ts's own MAX_RANGE_DAYS cap for the forward side; no
// past events are included at all (see buildIcs's doc comment).
const FEED_LOOKAHEAD_DAYS = 120;

// A subscribed calendar's job is upcoming reminders, not history -- past
// occurrences are already visible on the interactive Calendar page, and
// including them here would just mean every refresh re-adds a growing
// pile of already-happened events to the device's calendar.
function feedWindow(): { start: Date; end: Date } {
  const now = new Date();
  return {
    start: new Date(now.getTime() - MS_PER_DAY),
    end: new Date(now.getTime() + FEED_LOOKAHEAD_DAYS * MS_PER_DAY),
  };
}

function icsEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// RFC 5545 requires folding content lines longer than 75 octets, by
// inserting CRLF followed by a single leading space before the
// continuation. Splitting on a fixed char count rather than octet count
// is an approximation (fine here since names/descriptions are expected
// to stay in the Basic Multilingual Plane), but stay comfortably under
// the limit to leave room for the rare multi-byte character.
function foldLine(line: string): string {
  const LIMIT = 70;
  if (line.length <= LIMIT) return line;
  let result = line.slice(0, LIMIT);
  let rest = line.slice(LIMIT);
  while (rest.length > 0) {
    const chunk = rest.slice(0, LIMIT - 1);
    result += "\r\n " + chunk;
    rest = rest.slice(chunk.length);
  }
  return result;
}

function formatUtcStamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// A default alert on every event -- a subscribed calendar is generally
// treated as read-only by the device, so there's no later opportunity for
// the member to add their own per-event reminder the way they could on an
// event they created directly. 30 minutes mirrors the bot's own
// notification_type=1 default lead time.
const DEFAULT_ALARM_LEAD_MINUTES = 30;

function buildIcs(allianceName: string, events: { id: string; time: string; name: string; eventType: string | null }[]): string {
  const nowStamp = formatUtcStamp(new Date().toISOString());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Police Chief Bot//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(allianceName)} Events`,
    // Hints to clients that poll on their own schedule (Apple Calendar
    // honors this) how often it's worth re-fetching -- this feed's
    // content only changes as often as reminders/custom events do.
    "X-PUBLISHED-TTL:PT6H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
  ];

  for (const event of events) {
    const dtstart = formatUtcStamp(event.time);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.id}@police-chief-bot`,
      `DTSTAMP:${nowStamp}`,
      `DTSTART:${dtstart}`,
      `SUMMARY:${icsEscape(event.name)}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${icsEscape(event.name)}`,
      `TRIGGER:-PT${DEFAULT_ALARM_LEAD_MINUTES}M`,
      "END:VALARM",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Builds a session-shaped object for resolveAuthContext/canViewAlliance
 * to reuse the exact same authorization logic a real cookie session
 * would go through, given only a discordId resolved from a feed token.
 * activeGuildId is set to the target alliance's own guild (rather than
 * left null) so a Server-tier admin's guild-scoped check resolves the
 * same way it would if they'd already picked this guild in a real
 * session -- leaving it null would instead route into
 * resolveAuthContext's live-Discord-API guild-selection path, which
 * needs a real stored OAuth token this synthesized session doesn't have. */
function syntheticSession(discordId: string, guildId: string | null): SessionRecord {
  return { id: "feed-token", discordId, activeGuildId: guildId, createdAt: new Date(), expiresAt: new Date() };
}

export default async function calendarFeedRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/member/calendar-feed-token", { preHandler: fastify.requireAuth }, async (request) => {
    const ctx = await resolveAuthContext(request.session!);
    const token = await getOrCreateFeedToken(ctx.discordId);
    return { token };
  });

  fastify.post(
    "/member/calendar-feed-token/regenerate",
    { preHandler: [fastify.requireAuth, fastify.csrfProtection] },
    async (request) => {
      const ctx = await resolveAuthContext(request.session!);
      const token = await regenerateFeedToken(ctx.discordId);
      return { token };
    },
  );

  // No requireAuth hook -- this route is fetched by external calendar
  // apps with no cookie jar at all. Authorization is entirely via the
  // token query param, checked below.
  fastify.get<{ Params: { allianceId: number }; Querystring: { token: string } }>(
    "/alliance/:allianceId/calendar.ics",
    { schema: { params: allianceIdParam, querystring: feedQuerystring } },
    async (request, reply) => {
      const { allianceId } = request.params;
      const discordId = await discordIdForFeedToken(request.query.token);
      if (!discordId) {
        return reply.code(401).send({ error: "invalid_token" });
      }

      const alliance = await allianceDb
        .selectFrom("alliance_list")
        .select(["name", snowflake("discord_server_id").as("discord_server_id")])
        .where("alliance_id", "=", allianceId)
        .executeTakeFirst();
      if (!alliance) {
        return reply.code(404).send({ error: "alliance_not_found" });
      }

      const ctx: AuthContext = await resolveAuthContext(syntheticSession(discordId, alliance.discord_server_id));
      if (!(await canViewAlliance(ctx, allianceId))) {
        return reply.code(403).send({ error: "not_alliance_member" });
      }

      const { start, end } = feedWindow();
      const { events } = await computeCalendarEvents(allianceId, start, end);
      const ics = buildIcs(alliance.name ?? "Alliance", events.filter((e) => !e.isPast));

      reply.header("Content-Type", "text/calendar; charset=utf-8");
      reply.header("Content-Disposition", `inline; filename="calendar.ics"`);
      return ics;
    },
  );
}
