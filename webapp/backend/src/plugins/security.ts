import fp from "fastify-plugin";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

/** Baseline security headers + a global rate limit. Per-route limits
 * (tighter on /api/auth/login and /api/auth/callback, per the plan doc's
 * security section -- a hammered callback risks Discord throttling this
 * app's IP) are set with `config: { rateLimit: {...} }` on those routes
 * directly rather than here. */
export default fp(async (fastify) => {
  await fastify.register(helmet, {
    // This app serves its own built frontend (Stage A ships API-only;
    // static-serving lands once the frontend exists -- see
    // plugins/static.ts) and never embeds third-party scripts, so a
    // strict default-src is safe rather than aspirational.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https://cdn.discordapp.com"],
      },
    },
  });

  await fastify.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });
});
