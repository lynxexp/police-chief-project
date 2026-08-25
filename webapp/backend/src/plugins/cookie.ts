import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import { config } from "../config.js";

/** One signing secret for both cookies this app sets (see auth/cookies.ts)
 * -- reusing sessionSecret rather than minting a second env var, since
 * both cookies protect the same trust boundary (this app's own auth
 * flow). */
export default fp(async (fastify) => {
  await fastify.register(cookie, {
    secret: config.sessionSecret,
  });
});
