/**
 * Serves the built frontend (webapp/frontend/dist) once it exists, so
 * production is one process/one port with no CORS needed (see the plan
 * doc's frontend architecture note). A no-op until Stage B builds the
 * frontend -- Stage A is API-only and this guard lets server.ts register
 * the plugin unconditionally without failing to boot in the meantime.
 */
import fp from "fastify-plugin";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export default fp(async (fastify) => {
  const frontendDist = resolve(process.cwd(), "..", "frontend", "dist");
  if (!existsSync(frontendDist)) {
    fastify.log.info(
      `No built frontend at ${frontendDist} -- running API-only (expected until the frontend is built).`,
    );
    return;
  }

  // wildcard (default true) is what actually serves /assets/*.js etc --
  // without it this plugin registers no file-serving route at all, and
  // every request (including real built assets) falls through to the
  // setNotFoundHandler below and gets index.html back with the wrong
  // MIME type.
  await fastify.register(fastifyStatic, {
    root: frontendDist,
  });

  // SPA fallback: any non-/api route that isn't a real static file serves
  // index.html so client-side routing (React Router) works on refresh.
  fastify.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.sendFile("index.html");
  });
});
