/**
 * Login/callback/logout + the "who am I" and guild-selection endpoints.
 * Every other route group (member/admin, Stage B+) depends on this one
 * existing first -- see the plan doc's phased build order.
 */
import type { FastifyInstance } from "fastify";
import {
  generatePkce,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchDiscordUser,
} from "../auth/oauth.js";
import { createSession, destroySession, setActiveGuild } from "../auth/session.js";
import {
  setPkceCookie,
  readPkceCookie,
  clearPkceCookie,
  setSessionCookie,
  readSessionCookie,
  clearSessionCookie,
} from "../auth/cookies.js";
import {
  resolveAuthContext,
  selectableGuilds,
  guildIdsWithAlliances,
} from "../auth/context.js";

/** Signed cookie payload is "state:codeVerifier" -- both are already
 * base64url (no ":" possible in either), so a plain split is safe and
 * avoids pulling in a JSON dependency for two strings. */
function packPkce(state: string, codeVerifier: string): string {
  return `${state}:${codeVerifier}`;
}
function unpackPkce(packed: string): { state: string; codeVerifier: string } | null {
  const i = packed.indexOf(":");
  if (i === -1) return null;
  return { state: packed.slice(0, i), codeVerifier: packed.slice(i + 1) };
}

export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      const pkce = generatePkce();
      setPkceCookie(reply, packPkce(pkce.state, pkce.codeVerifier));
      return reply.redirect(buildAuthorizeUrl(pkce));
    },
  );

  fastify.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/callback",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          properties: {
            code: { type: "string" },
            state: { type: "string" },
            error: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { code, state, error } = request.query;
      const packed = readPkceCookie(request);
      clearPkceCookie(reply);

      if (error) {
        return reply.code(400).send({ error: `discord_oauth_${error}` });
      }
      if (!code || !state || !packed) {
        return reply.code(400).send({ error: "missing_oauth_params" });
      }
      const pkce = unpackPkce(packed);
      if (!pkce || pkce.state !== state) {
        return reply.code(400).send({ error: "state_mismatch" });
      }

      const tokens = await exchangeCodeForToken(code, pkce.codeVerifier);
      const discordUser = await fetchDiscordUser(tokens.access_token);
      // Discord ids are 64-bit snowflakes -- keep the exact string Discord
      // gave us, never Number() it (see db/schema.ts's Snowflake doc
      // comment for why that silently corrupts large ids).
      const session = await createSession(discordUser.id, tokens);
      setSessionCookie(reply, session.id);
      return reply.redirect("/");
    },
  );

  fastify.post("/logout", async (request, reply) => {
    const sessionId = readSessionCookie(request);
    if (sessionId) {
      await destroySession(sessionId);
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  fastify.get(
    "/me",
    { preHandler: fastify.requireAuth },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      // Handed to the client for every /api/admin/* mutation (see
      // plugins/csrf.ts) -- generated per-session, not per-request, so
      // fetching /me repeatedly doesn't rotate the token out from under
      // an in-flight form.
      const csrfToken = await reply.generateCsrf();
      return { ...ctx, csrfToken };
    },
  );

  fastify.get(
    "/guilds",
    { preHandler: fastify.requireAuth },
    async (request, _reply) => {
      const guilds = await selectableGuilds(request.session!);
      return guilds.map((g) => ({ id: g.id, name: g.name }));
    },
  );

  fastify.post<{ Body: { guildId: string } }>(
    "/active-guild",
    {
      preHandler: [fastify.requireAuth, fastify.csrfProtection],
      schema: {
        body: {
          type: "object",
          required: ["guildId"],
          // A Discord snowflake -- kept as a string end-to-end, never
          // parsed as a number (see db/schema.ts's Snowflake doc comment).
          properties: { guildId: { type: "string", pattern: "^[0-9]+$" } },
        },
      },
    },
    async (request, reply) => {
      const { guildId } = request.body;
      const withAlliances = await guildIdsWithAlliances();
      if (!withAlliances.has(guildId)) {
        return reply.code(400).send({ error: "unknown_guild" });
      }
      const guilds = await selectableGuilds(request.session!);
      if (!guilds.some((g) => g.id === guildId)) {
        return reply.code(403).send({ error: "not_a_member_of_guild" });
      }

      await setActiveGuild(request.session!.id, guildId);
      return resolveAuthContext({ ...request.session!, activeGuildId: guildId });
    },
  );
}
