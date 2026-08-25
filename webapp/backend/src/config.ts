/**
 * Sole place process.env is read. Everything else imports typed values from
 * here instead of touching process.env directly, so a missing/malformed env
 * var fails loudly at startup rather than surfacing as an undefined-is-not-
 * a-function error deep in a request handler.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Local dev convenience only -- production (Docker Compose) sets real env
// vars directly, matching the bot's own "no .env in prod" convention (see
// docker/docker-compose.yml). This loader is deliberately tiny (no
// dependency) since it only needs to run before anything else touches
// process.env.
function loadDotEnvIfPresent(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf-8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnvIfPresent();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Set it in your ` +
        `environment or a webapp/backend/.env file (see .env.example).`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

const resolvedBotDbDir = optional("BOT_DB_DIR", resolve(process.cwd(), "..", "..", "db"));

export const config = {
  port: Number(optional("PORT", "3000")),

  // Path to the bot's db/ folder. Defaults to the repo-root-relative path
  // that works when running `npm run dev` from webapp/backend/ locally
  // against a checked-out copy of the bot; in Docker this is always
  // /app/db (see webapp/Dockerfile + docker-compose.yml).
  botDbDir: resolvedBotDbDir,
  webappDbDir: optional("WEBAPP_DB_DIR", resolve(process.cwd(), "db")),

  // Sibling of botDbDir by default -- matches the bot's own convention
  // (backups/ sits next to db/, see cogs/bot_backup.py) so a web-triggered
  // backup lands in the same place the bot's own backups do.
  backupsDir: optional("BACKUPS_DIR", resolve(resolvedBotDbDir, "..", "backups")),

  discord: {
    clientId: required("DISCORD_CLIENT_ID"),
    clientSecret: required("DISCORD_CLIENT_SECRET"),
    // The bot token -- reused read-only here, only for the Bot REST API's
    // GET /guilds/{id}/channels call (channel picker for admin channel
    // setup). Never used for gateway/websocket access from this process.
    botToken: required("DISCORD_BOT_TOKEN"),
    redirectUri: required("DISCORD_REDIRECT_URI"),
  },

  sessionSecret: required("SESSION_SECRET"),

  // Gates whether X-Forwarded-Proto is trusted to decide the session
  // cookie's Secure flag and the scheme used when constructing URLs.
  // Stays false until a reverse proxy (Caddy) is actually in front of this
  // app -- see docs/webapp-deployment.md for the exact flip-over steps.
  trustProxy: bool("TRUST_PROXY", false),

  isProduction: optional("NODE_ENV", "development") === "production",
};

export type Config = typeof config;
