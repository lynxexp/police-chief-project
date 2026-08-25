/**
 * The two cookies this app sets, and nothing else. Centralized here so
 * both routes/auth.ts (which sets/clears them) and plugins/session.ts
 * (which reads them on every request) agree on names/options -- a
 * mismatch between "how a cookie was set" and "how it's read" is a
 * classic source of silent auth bugs.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";

export const SESSION_COOKIE = "pcb_session";
export const PKCE_COOKIE = "pcb_oauth_pkce";

/** PKCE state only needs to survive the redirect to Discord and back --
 * a few minutes, generously. */
const PKCE_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // matches session.ts's absolute cap

/** Secure requires either a real TLS connection or (once a reverse proxy
 * is in front of this app) TRUST_PROXY=true so X-Forwarded-Proto is
 * honored -- see config.ts's trustProxy doc comment. Never Secure while
 * running plain HTTP locally, or the cookie silently never gets sent. */
function secureFlag(): boolean {
  return config.trustProxy || config.isProduction;
}

export function setPkceCookie(reply: FastifyReply, value: string): void {
  reply.setCookie(PKCE_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureFlag(),
    signed: true,
    path: "/api/auth",
    maxAge: PKCE_COOKIE_MAX_AGE_SECONDS,
  });
}

export function readPkceCookie(request: FastifyRequest): string | null {
  const raw = request.cookies[PKCE_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

export function clearPkceCookie(reply: FastifyReply): void {
  reply.clearCookie(PKCE_COOKIE, { path: "/api/auth" });
}

export function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureFlag(),
    signed: true,
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
}

export function readSessionCookie(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}
