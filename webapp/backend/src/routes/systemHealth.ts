/**
 * Web mirror of the Discord bot's /health dashboard (cogs/bot_health.py) --
 * Owner-only, same tier as Backups. Two distinct concerns sharing one
 * cross-process bridge:
 *
 * - Status (GET /admin/system/status): the bot computes every health
 *   check itself and writes a JSON snapshot into health_snapshot every
 *   30s (status_snapshot_loop). This app only ever reads and re-serves
 *   that blob -- there is no TypeScript reimplementation of any health
 *   check, so the two surfaces can never silently disagree about what
 *   "healthy" means.
 * - Commands (POST /admin/system/commands): there is no direct network/IPC
 *   between this process and the bot at all (same "SQLite is the only
 *   channel" architecture docker-compose.yml calls out for the two
 *   containers) -- this route INSERTs a pending row into bot_commands and
 *   polls it; the bot's command_poll_loop picks it up, runs the same
 *   method the Discord button calls, and writes the result back.
 *
 * Both tables are owned and created by the Python bot (bot_health.py's
 * _setup_database()), not by this app -- on a fresh install where the bot
 * has never started even once, neither table exists yet. That's handled
 * as a normal "not ready" response here, not a startup-time hard failure
 * (see db/connections.ts's EXPECTED[] doc comment for why this deliberately
 * is NOT added there: a health dashboard being unavailable before the bot's
 * first run is expected, not a schema mismatch worth refusing to boot over).
 */
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { settingsDb } from "../db/connections.js";
import { resolveAuthContext } from "../auth/context.js";
import { logAppAction } from "../audit.js";
import { config } from "../config.js";

const ALLOWED_COMMANDS = [
  "run_cleanup",
  "reload_cogs",
  "clear_queue",
  "restart",
  "check_updates",
  "run_update",
] as const;
type BotCommand = (typeof ALLOWED_COMMANDS)[number];

const commandBody = {
  type: "object",
  required: ["command"],
  properties: { command: { type: "string", enum: [...ALLOWED_COMMANDS] } },
} as const;

async function tableExists(name: string): Promise<boolean> {
  const result = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}
  `.execute(settingsDb);
  return result.rows.length > 0;
}

// The bot polls bot_commands every 2s; this bounds how long a request waits
// for it to finish before giving up and telling the client to check back,
// rather than holding the connection open indefinitely. run_cleanup in
// particular can run well past 25s (DB checkpoints + log archival + a pip
// check) -- confirmed by timing it directly -- so this is generous on
// purpose rather than tuned to the fastest command.
const COMMAND_POLL_TIMEOUT_MS = 45_000;
const COMMAND_POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function systemHealthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get("/admin/system/status", async (request, reply) => {
    const ctx = await resolveAuthContext(request.session!);
    if (!ctx.isOwner) {
      return reply.code(403).send({ error: "owner_required" });
    }

    if (!(await tableExists("health_snapshot"))) {
      return reply.code(503).send({
        error: "not_ready",
        message: "No status yet -- the Discord bot needs to have started at least once.",
      });
    }

    const row = await settingsDb
      .selectFrom("health_snapshot")
      .select(["snapshot_json", "updated_at"])
      .where("id", "=", 1)
      .executeTakeFirst();
    if (!row) {
      return reply.code(503).send({
        error: "not_ready",
        message: "No status yet -- the Discord bot needs to have started at least once.",
      });
    }

    let snapshot: unknown;
    try {
      snapshot = JSON.parse(row.snapshot_json);
    } catch {
      return reply.code(502).send({ error: "corrupt_snapshot" });
    }
    return { snapshot, updatedAt: row.updated_at };
  });

  fastify.patch<{ Body: { enabled: boolean } }>(
    "/admin/system/update-check",
    {
      schema: { body: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } } },
      preHandler: fastify.csrfProtection,
    },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isOwner) {
        return reply.code(403).send({ error: "owner_required" });
      }
      if (!(await tableExists("health_config"))) {
        return reply.code(503).send({ error: "not_ready" });
      }

      await settingsDb
        .updateTable("health_config")
        .set({ update_check_enabled: request.body.enabled ? 1 : 0 })
        .where("id", "=", 1)
        .execute();

      await logAppAction({
        actorId: ctx.discordId,
        action: "update_check_toggled",
        resourceType: "system_settings",
        detail: request.body.enabled ? "enabled" : "disabled",
      });

      return { ok: true, enabled: request.body.enabled };
    },
  );

  fastify.post<{ Body: { command: BotCommand } }>(
    "/admin/system/commands",
    { schema: { body: commandBody }, preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isOwner) {
        return reply.code(403).send({ error: "owner_required" });
      }
      if (!(await tableExists("bot_commands"))) {
        return reply.code(503).send({
          error: "not_ready",
          message: "The Discord bot needs to have started at least once.",
        });
      }

      const { command } = request.body;
      const result = await settingsDb
        .insertInto("bot_commands")
        .values({
          command,
          requested_by: ctx.discordId,
          requested_at: new Date().toISOString(),
          status: "pending",
        })
        .executeTakeFirst();
      const commandId = Number(result.insertId);

      await logAppAction({
        actorId: ctx.discordId,
        action: "bot_command_requested",
        resourceType: "bot_command",
        resourceId: String(commandId),
        detail: command,
      });

      // Poll for completion server-side rather than pushing polling logic
      // onto the frontend -- every one of these actions normally finishes
      // in well under this window (command_poll_loop checks every 2s).
      const deadline = Date.now() + COMMAND_POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const row = await settingsDb
          .selectFrom("bot_commands")
          .select(["status", "result"])
          .where("id", "=", commandId)
          .executeTakeFirst();
        if (row && row.status !== "pending" && row.status !== "running") {
          let parsed: unknown = null;
          if (row.result) {
            try {
              parsed = JSON.parse(row.result);
            } catch {
              parsed = row.result;
            }
          }
          return { status: row.status, result: parsed };
        }
        await sleep(COMMAND_POLL_INTERVAL_MS);
      }
      // Still running (restart never gets here, its process exits first) --
      // not a failure, just slower than usual; the dashboard's next status
      // poll will reflect it once done.
      return reply.code(202).send({ status: "pending" });
    },
  );

  // Proxies to the watchtower-control sidecar (docker/docker-compose.yml)
  // -- this process never touches the Docker socket itself, same "one
  // narrow, auditable thing holds that access" boundary described in
  // docker/watchtower-control/server.js's own header comment. Not part
  // of the bot_commands queue above: this doesn't go through the bot at
  // all, since Watchtower is a third container the bot has no more
  // access to than this webapp does.
  const WATCHTOWER_MODES = ["off", "monitor", "apply"] as const;
  type WatchtowerMode = (typeof WATCHTOWER_MODES)[number];

  function watchtowerConfigured(): boolean {
    return Boolean(config.watchtowerControl.url && config.watchtowerControl.token);
  }

  fastify.get("/admin/system/watchtower-mode", async (request, reply) => {
    const ctx = await resolveAuthContext(request.session!);
    if (!ctx.isOwner) {
      return reply.code(403).send({ error: "owner_required" });
    }
    if (!watchtowerConfigured()) {
      return { configured: false };
    }
    try {
      const res = await fetch(`${config.watchtowerControl.url}/mode`, {
        headers: { Authorization: `Bearer ${config.watchtowerControl.token}` },
      });
      const body = (await res.json()) as { mode?: WatchtowerMode; running?: boolean; error?: string };
      if (!res.ok) {
        return reply.code(502).send({ configured: true, error: body.error ?? "watchtower_control_error" });
      }
      return { configured: true, mode: body.mode, running: body.running };
    } catch (e) {
      return reply.code(502).send({
        configured: true,
        error: e instanceof Error ? e.message : "watchtower_control_unreachable",
      });
    }
  });

  fastify.post<{ Body: { mode: WatchtowerMode } }>(
    "/admin/system/watchtower-mode",
    {
      schema: { body: { type: "object", required: ["mode"], properties: { mode: { type: "string", enum: [...WATCHTOWER_MODES] } } } },
      preHandler: fastify.csrfProtection,
    },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isOwner) {
        return reply.code(403).send({ error: "owner_required" });
      }
      if (!watchtowerConfigured()) {
        return reply.code(503).send({ error: "not_configured" });
      }
      try {
        const res = await fetch(`${config.watchtowerControl.url}/mode`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.watchtowerControl.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ mode: request.body.mode }),
        });
        const body = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok) {
          return reply.code(502).send({ error: body.error ?? "watchtower_control_error" });
        }
        await logAppAction({
          actorId: ctx.discordId,
          action: "watchtower_mode_changed",
          resourceType: "system_settings",
          detail: request.body.mode,
        });
        return { ok: true, mode: request.body.mode };
      } catch (e) {
        return reply.code(502).send({
          error: e instanceof Error ? e.message : "watchtower_control_unreachable",
        });
      }
    },
  );
}
