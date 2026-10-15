/**
 * End-to-end tests for GET/PUT /api/electro-calculator: a real Fastify
 * instance with the real cookie/session/CSRF plugins and the real route,
 * against a throwaway webapp.sqlite in a temp directory (never the real
 * db/). Auth is exercised for real too -- a session row is created with
 * auth/session.ts and presented as the same signed cookie a browser would
 * send. Env vars and fixture files must exist before db/connections.ts is
 * imported (it opens every file once at import time), hence the dynamic
 * imports in beforeAll -- same approach as auth/permissions.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

const BOT_DB_FILES = [
  "users", "vault_data", "capitol_war", "alliance", "settings", "changes",
  "giftcode", "id_channel", "pimpmybot", "events",
];

let tmpDir: string;
let app: FastifyInstance;
let connections: typeof import("../db/connections.js");
let sessionMod: typeof import("../auth/session.js");
let ELECTRO_BUILDINGS: readonly string[];

const levelsAt = (level: number, overrides: Record<string, number> = {}) => ({
  ...Object.fromEntries(ELECTRO_BUILDINGS.map((n) => [n, level])),
  ...overrides,
});

/** A signed-in browser: its session cookie plus a fresh CSRF secret cookie/token pair. */
async function signIn(discordId: string) {
  const session = await sessionMod.createSession(discordId, {
    access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "Bearer", scope: "identify",
  } as never);
  const sessionCookie = `pcb_session=${app.signCookie(session.id)}`;
  const csrfRes = await app.inject({ method: "GET", url: "/test/csrf", headers: { cookie: sessionCookie } });
  const csrfCookies = ([] as string[]).concat(csrfRes.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]);
  const cookie = [sessionCookie, ...csrfCookies].join("; ");
  return { cookie, csrf: csrfRes.json().token as string };
}

function put(user: { cookie: string; csrf: string }, body: unknown, withCsrf = true) {
  return app.inject({
    method: "PUT",
    url: "/api/electro-calculator",
    headers: { cookie: user.cookie, ...(withCsrf ? { "x-csrf-token": user.csrf } : {}) },
    payload: body as object,
  });
}

function get(cookie?: string) {
  return app.inject({ method: "GET", url: "/api/electro-calculator", headers: cookie ? { cookie } : {} });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "electro-calc-test-"));
  const webappDataDir = join(tmpDir, "webapp-data");
  mkdirSync(webappDataDir);
  for (const name of BOT_DB_FILES) new Database(join(tmpDir, `${name}.sqlite`)).close();

  process.env.BOT_DB_DIR = tmpDir;
  process.env.WEBAPP_DB_DIR = webappDataDir;
  process.env.DISCORD_CLIENT_ID = "test-client-id";
  process.env.DISCORD_CLIENT_SECRET = "test-client-secret";
  process.env.DISCORD_BOT_TOKEN = "test-bot-token";
  process.env.DISCORD_REDIRECT_URI = "http://localhost/api/auth/callback";
  process.env.SESSION_SECRET = "test-session-secret-well-over-32-chars-long";

  connections = await import("../db/connections.js");
  connections.initWebappSchema();
  sessionMod = await import("../auth/session.js");
  ({ ELECTRO_BUILDINGS } = await import("../electroCalculator.js"));

  const Fastify = (await import("fastify")).default;
  const cookiePlugin = (await import("../plugins/cookie.js")).default;
  const sessionPlugin = (await import("../plugins/session.js")).default;
  const csrfPlugin = (await import("../plugins/csrf.js")).default;
  const electroRoutes = (await import("./electroCalculator.js")).default;

  app = Fastify();
  await app.register(cookiePlugin);
  await app.register(sessionPlugin);
  await app.register(csrfPlugin);
  app.get("/test/csrf", async (_req, reply) => ({ token: reply.generateCsrf() }));
  await app.register(electroRoutes, { prefix: "/api" });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await connections?.closeAllConnections();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("/api/electro-calculator", () => {
  it("rejects signed-out requests", async () => {
    expect((await get()).statusCode).toBe(401);
    // A PUT with no session must not reach the database either.
    const res = await app.inject({ method: "PUT", url: "/api/electro-calculator", payload: { currentLevels: levelsAt(40) } });
    expect(res.statusCode).toBe(401);
  });

  it("returns null when nothing has been saved yet", async () => {
    const user = await signIn("100000000000000001");
    const res = await get(user.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ currentLevels: null, updatedAt: null });
  });

  it("requires a CSRF token to save", async () => {
    const user = await signIn("100000000000000002");
    const res = await put(user, { currentLevels: levelsAt(40) }, false);
    expect(res.statusCode).toBe(403);
    expect((await get(user.cookie)).json().currentLevels).toBeNull();
  });

  it("saves and then returns the same levels", async () => {
    const user = await signIn("100000000000000003");
    const levels = levelsAt(45, { "Chief's Office": 50, Hospital: 31 });
    const saved = await put(user, { currentLevels: levels });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().currentLevels).toEqual(levels);

    const res = await get(user.cookie);
    expect(res.json().currentLevels).toEqual(levels);
    expect(typeof res.json().updatedAt).toBe("string");
  });

  it("overwrites on a second save (one row per user)", async () => {
    const user = await signIn("100000000000000004");
    await put(user, { currentLevels: levelsAt(40) });
    await put(user, { currentLevels: levelsAt(55) });
    expect((await get(user.cookie)).json().currentLevels).toEqual(levelsAt(55));
    const rows = await connections.webappDb
      .selectFrom("electro_calculator_state")
      .select("discord_id")
      .where("discord_id", "=", "100000000000000004")
      .execute();
    expect(rows).toHaveLength(1);
  });

  it("keeps each user's levels separate, including near-identical 64-bit Discord ids", async () => {
    // These two ids differ only in the last digit -- they would collide if
    // either were ever squeezed through a JS float.
    const a = await signIn("123456789012345678");
    const b = await signIn("123456789012345679");
    await put(a, { currentLevels: levelsAt(33) });
    await put(b, { currentLevels: levelsAt(52) });
    expect((await get(a.cookie)).json().currentLevels).toEqual(levelsAt(33));
    expect((await get(b.cookie)).json().currentLevels).toEqual(levelsAt(52));
  });

  it("rejects invalid bodies without changing what's saved", async () => {
    const user = await signIn("100000000000000005");
    await put(user, { currentLevels: levelsAt(41) });

    const [first, second] = ELECTRO_BUILDINGS;
    const { [first as string]: _omitted, ...missingOne } = levelsAt(40);
    const bad: unknown[] = [
      { currentLevels: levelsAt(40, { [first as string]: 56 }) }, // above max
      { currentLevels: levelsAt(40, { [second as string]: 29 }) }, // below min
      { currentLevels: levelsAt(40, { [first as string]: 40.5 }) }, // not an integer
      { currentLevels: levelsAt(40, { [first as string]: "forty-five" as unknown as number }) }, // wrong type
      { currentLevels: missingOne }, // a building missing
      { currentLevels: [40, 40, 40, 40, 40, 40, 40] }, // wrong shape
      { levels: levelsAt(40) }, // wrong key
      {}, // empty
    ];
    for (const body of bad) {
      const res = await put(user, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await get(user.cookie)).json().currentLevels).toEqual(levelsAt(41));
  });

  it("ignores unknown buildings instead of storing them (Fastify strips extra properties)", async () => {
    const user = await signIn("100000000000000009");
    const res = await put(user, { currentLevels: { ...levelsAt(40), "Mystery Building": 55 } });
    expect(res.statusCode).toBe(200);
    expect((await get(user.cookie)).json().currentLevels).toEqual(levelsAt(40));
  });

  it("stores numeric strings as real integers (Fastify's default coercion)", async () => {
    const user = await signIn("100000000000000008");
    const res = await put(user, { currentLevels: levelsAt(40, { "Chief's Office": "45" as unknown as number }) });
    expect(res.statusCode).toBe(200);
    expect((await get(user.cookie)).json().currentLevels).toEqual(levelsAt(40, { "Chief's Office": 45 }));
  });

  it("never fails to load a damaged or outdated saved row", async () => {
    const corrupted = await signIn("100000000000000006");
    await connections.webappDb
      .insertInto("electro_calculator_state")
      .values({ discord_id: "100000000000000006", current_levels: "{definitely not json", updated_at: "2026-01-01T00:00:00.000Z" })
      .execute();
    expect((await get(corrupted.cookie)).json()).toEqual({ currentLevels: null, updatedAt: null });

    const outdated = await signIn("100000000000000007");
    await connections.webappDb
      .insertInto("electro_calculator_state")
      .values({ discord_id: "100000000000000007", current_levels: JSON.stringify({ "Chief's Office": 48 }), updated_at: "2026-01-01T00:00:00.000Z" })
      .execute();
    expect((await get(outdated.cookie)).json().currentLevels).toEqual(levelsAt(30, { "Chief's Office": 48 }));
  });
});
