/**
 * The only thing on this Docker network with access to the Docker socket
 * besides Watchtower itself. Deliberately does exactly one thing: change
 * the `police-chief-watchtower` container's mode (off / monitor / apply)
 * by recreating it with different environment variables.
 *
 * Why this exists at all: env vars can't be changed on a running
 * container -- there is no live "reload config" for Watchtower, so
 * flipping WATCHTOWER_MONITOR_ONLY genuinely requires stop+remove+create+
 * start via the Docker Engine API. Something has to hold the socket to
 * do that.
 *
 * Why there's no docker-socket-proxy in front of this (unlike a typical
 * "minimize the blast radius" setup): checked tecnativa/docker-socket-
 * proxy's actual haproxy ACLs directly -- it has no rule for POST
 * /containers/create or DELETE /containers/{id} at all, under any
 * combination of its env flags; both always hit its final catch-all deny.
 * Since recreation is exactly what this service needs to do, the proxy
 * can't sit in front of it for this job. The real boundary is this file:
 * one hardcoded target container name (never taken from a request), one
 * capability (change its env and recreate it, nothing else), and a
 * bearer token gating the only endpoint that acts. Read it end to end
 * before trusting it -- it's short on purpose.
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import Docker from "dockerode";

const TARGET_NAME = "police-chief-watchtower";
const STATE_DIR = "/data";
const STATE_FILE = `${STATE_DIR}/mode.json`;
const VALID_MODES = new Set(["off", "monitor", "apply"]);
const PORT = 8090;

const TOKEN = process.env.WATCHTOWER_CONTROL_TOKEN;
if (!TOKEN) {
  console.error("WATCHTOWER_CONTROL_TOKEN is not set -- refusing to start with no auth.");
  process.exit(1);
}

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

function readPersistedMode() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (VALID_MODES.has(parsed.mode)) return parsed.mode;
  } catch {
    // No file yet, or it's corrupt -- fall through to the default below.
  }
  return "apply";
}

function persistMode(mode) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ mode }));
}

/**
 * Stop + remove + recreate + start the target container with
 * WATCHTOWER_MONITOR_ONLY added/removed to match the requested mode.
 * Skips the recreate entirely if the container's env already matches
 * (e.g. switching "monitor" -> "monitor" again, or resuming from "off"
 * with no mode change) -- only "off" and a genuine env change ever
 * touch the container at all.
 */
async function applyMode(mode) {
  const container = docker.getContainer(TARGET_NAME);
  let info;
  try {
    info = await container.inspect();
  } catch (e) {
    if (e.statusCode === 404) {
      throw new Error(
        `Container "${TARGET_NAME}" doesn't exist -- has the watchtower service ` +
          `been started at least once (docker compose up -d watchtower)?`,
      );
    }
    throw e;
  }

  if (mode === "off") {
    if (info.State.Running) await container.stop();
    persistMode(mode);
    return;
  }

  const wantMonitorOnly = mode === "monitor";
  const currentEnv = info.Config.Env || [];
  const hasMonitorOnly = currentEnv.includes("WATCHTOWER_MONITOR_ONLY=true");

  if (hasMonitorOnly === wantMonitorOnly) {
    if (!info.State.Running) await container.start();
    persistMode(mode);
    return;
  }

  const newEnv = currentEnv.filter((e) => !e.startsWith("WATCHTOWER_MONITOR_ONLY="));
  if (wantMonitorOnly) newEnv.push("WATCHTOWER_MONITOR_ONLY=true");

  // Docker's create-request shape and inspect's Config/HostConfig response
  // are deliberately symmetric (this exact recreate-with-changes pattern is
  // a well-established use of that symmetry) -- carrying over every
  // Config field that can meaningfully vary, not just the ones this
  // deployment happens to set today, so a future docker-compose.yml
  // change to this service (a custom command, extra exposed port, a
  // different working dir) still round-trips correctly instead of
  // silently reverting to the image's own defaults on the next mode change.
  const createOptions = {
    name: TARGET_NAME,
    Image: info.Config.Image,
    Env: newEnv,
    Labels: info.Config.Labels,
    Cmd: info.Config.Cmd,
    Entrypoint: info.Config.Entrypoint,
    WorkingDir: info.Config.WorkingDir,
    ExposedPorts: info.Config.ExposedPorts,
    HostConfig: info.HostConfig,
  };

  if (info.State.Running) {
    await container.stop();
  }
  await container.remove();
  const recreated = await docker.createContainer(createOptions);
  await recreated.start();
  persistMode(mode);
}

// Serializes applyMode calls -- recreating a container while another
// recreate is in flight (two rapid clicks, or the startup reconcile
// overlapping a request) isn't safe to run concurrently.
let queue = Promise.resolve();
function applyModeSerialized(mode) {
  const result = queue.then(() => applyMode(mode));
  queue = result.catch(() => {});
  return result;
}

function tokenMatches(header) {
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(TOKEN);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

const server = http.createServer((req, res) => {
  if (!tokenMatches(req.headers["authorization"])) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if (req.method === "GET" && req.url === "/mode") {
    docker
      .getContainer(TARGET_NAME)
      .inspect()
      .then((info) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            mode: readPersistedMode(),
            running: info.State.Running,
          }),
        );
      })
      .catch((e) => {
        res.writeHead(e.statusCode === 404 ? 404 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  if (req.method === "POST" && req.url === "/mode") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024) req.destroy(); // trivial oversized-body guard
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      if (!VALID_MODES.has(parsed.mode)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_mode", validModes: [...VALID_MODES] }));
        return;
      }
      applyModeSerialized(parsed.mode)
        .then(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, mode: parsed.mode }));
        })
        .catch((e) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        });
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

// Reconcile once at startup: a plain `docker compose up -d` recreates
// every container from docker-compose.yml's own defaults, silently
// undoing whatever mode was last chosen through this API. Re-applying
// the persisted mode here (idempotent -- a no-op if it already matches)
// is what makes that survive a redeploy instead of quietly reverting.
applyModeSerialized(readPersistedMode()).catch((e) => {
  console.error("Startup reconcile failed:", e.message);
});

server.listen(PORT, () => {
  console.log(`watchtower-control listening on :${PORT}, target=${TARGET_NAME}`);
});
