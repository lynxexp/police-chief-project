import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import {
  assertBotSchemaIntact,
  initWebappSchema,
  closeAllConnections,
} from "./db/connections.js";
import { pruneExpiredSessions } from "./auth/session.js";
import cookiePlugin from "./plugins/cookie.js";
import securityPlugin from "./plugins/security.js";
import sessionPlugin from "./plugins/session.js";
import csrfPlugin from "./plugins/csrf.js";
import staticPlugin from "./plugins/static.js";
import authRoutes from "./routes/auth.js";
import memberRoutes from "./routes/member.js";
import registrationRoutes from "./routes/registration.js";
import calendarRoutes from "./routes/calendar.js";
import calendarFeedRoutes from "./routes/calendarFeed.js";
import adminRoutes from "./routes/admin.js";
import giftCodeRoutes from "./routes/giftcodes.js";
import idChannelRoutes from "./routes/idchannel.js";
import backupRoutes from "./routes/backups.js";
import themingRoutes from "./routes/theming.js";
import notificationRoutes from "./routes/notifications.js";
import customEventRoutes from "./routes/customEvents.js";
import scheduleBoardRoutes from "./routes/scheduleBoards.js";
import systemHealthRoutes from "./routes/systemHealth.js";

async function main(): Promise<void> {
  // Refuse to start against a bot database version this app doesn't
  // understand, rather than fail confusingly on the first mismatched
  // query -- see db/connections.ts's doc comment.
  assertBotSchemaIntact();
  initWebappSchema();

  const fastify = Fastify({
    logger: true,
    trustProxy: config.trustProxy,
  });

  await fastify.register(cookiePlugin);
  await fastify.register(securityPlugin);
  await fastify.register(sessionPlugin);
  await fastify.register(csrfPlugin);
  // Restore-zip upload only (routes/backups.ts) -- 500MB matches the bot's
  // own /restore attachment cap (cogs/bot_backup.py).
  await fastify.register(multipart, {
    limits: { fileSize: 500 * 1024 * 1024, files: 1 },
  });
  await fastify.register(authRoutes, { prefix: "/api/auth" });
  await fastify.register(memberRoutes, { prefix: "/api" });
  await fastify.register(registrationRoutes, { prefix: "/api" });
  await fastify.register(calendarRoutes, { prefix: "/api" });
  await fastify.register(calendarFeedRoutes, { prefix: "/api" });
  await fastify.register(adminRoutes, { prefix: "/api" });
  await fastify.register(giftCodeRoutes, { prefix: "/api" });
  await fastify.register(idChannelRoutes, { prefix: "/api" });
  await fastify.register(backupRoutes, { prefix: "/api" });
  await fastify.register(themingRoutes, { prefix: "/api" });
  await fastify.register(notificationRoutes, { prefix: "/api" });
  await fastify.register(customEventRoutes, { prefix: "/api" });
  await fastify.register(scheduleBoardRoutes, { prefix: "/api" });
  await fastify.register(systemHealthRoutes, { prefix: "/api" });
  // Registered last: its SPA-fallback 404 handler must not shadow any
  // /api/* route registered above it.
  await fastify.register(staticPlugin);

  fastify.get("/api/health", async () => ({ ok: true }));

  const deleted = await pruneExpiredSessions();
  if (deleted > 0) {
    fastify.log.info(`Pruned ${deleted} expired session(s) on startup.`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    fastify.log.info(`Received ${signal}, shutting down.`);
    await fastify.close();
    await closeAllConnections();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await fastify.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
