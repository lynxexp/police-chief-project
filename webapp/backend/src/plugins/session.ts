/**
 * Attaches the caller's session (if any) to every request, and exposes a
 * `requireAuth` preHandler that routes needing a logged-in user can
 * attach in their route options. Deliberately does NOT resolve the full
 * AuthContext (tier, etc.) on every request -- that's an extra handful of
 * queries (see auth/context.ts), so routes that actually need tier info
 * call resolveAuthContext themselves once they know they need it, rather
 * than paying that cost on routes that don't (e.g. GET /api/auth/me is
 * the only Stage A route that needs it).
 */
import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { readSessionCookie, clearSessionCookie } from "../auth/cookies.js";
import { getSession, type SessionRecord } from "../auth/session.js";

declare module "fastify" {
  interface FastifyRequest {
    session: SessionRecord | null;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>;
  }
}

export default fp(async (fastify) => {
  fastify.decorateRequest("session", null);

  fastify.addHook("onRequest", async (request) => {
    const sessionId = readSessionCookie(request);
    if (!sessionId) {
      request.session = null;
      return;
    }
    request.session = await getSession(sessionId);
  });

  fastify.decorate(
    "requireAuth",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        clearSessionCookie(reply);
        return reply.code(401).send({ error: "not_authenticated" });
      }
    },
  );
});
