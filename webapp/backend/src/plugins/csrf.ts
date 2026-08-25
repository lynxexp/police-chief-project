import fp from "fastify-plugin";
import csrfProtection from "@fastify/csrf-protection";
import { config } from "../config.js";

/** Double-submit CSRF protection for /api/admin/* mutations (see the plan
 * doc's security section). Registers `fastify.csrfProtection` as an
 * attachable preHandler -- NOT applied globally, since that would also
 * gate the GET routes sitting alongside the writes in routes/admin.ts.
 * Each write route attaches it explicitly.
 *
 * The secret lives in its own signed cookie (separate from the session
 * cookie); the derived token is handed to the client via
 * GET /api/auth/me and echoed back on writes in the X-CSRF-Token header
 * (the library's default getToken already checks that header name). */
export default fp(async (fastify) => {
  await fastify.register(csrfProtection, {
    cookieOpts: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.trustProxy || config.isProduction,
      signed: true,
      path: "/",
    },
  });
});
