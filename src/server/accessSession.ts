/**
 * Who may ask for explanations, which spend paid model calls.
 *
 * Three ways in, checked by `authorizeExplanation`:
 * - service: an `Authorization: Bearer` header matching the legacy
 *   PITCHLENS_EXPLAIN_ACCESS_TOKEN, for scripts and machine clients;
 * - judge session: a signed HttpOnly cookie issued by POST /api/session in
 *   exchange for PITCHLENS_JUDGE_ACCESS_CODE, signed with
 *   PITCHLENS_SESSION_SECRET and valid for SESSION_TTL_SECONDS;
 * - local: PITCHLENS_ACCESS_MODE=local, for development only. It is refused
 *   when NODE_ENV is production.
 *
 * Anything else fails closed. The session is stateless: the cookie carries a
 * random id and an absolute expiry, authenticated with HMAC-SHA256, so it
 * cannot be revoked server-side before it expires except by rotating the
 * secret. Nothing here logs or returns a credential.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type AccessEnv = Record<string, string | undefined>;

export const SESSION_COOKIE = "pitchlens_session";
export const SESSION_TTL_SECONDS = 1_800;
export const MIN_ACCESS_CODE_LENGTH = 16;
export const MIN_SESSION_SECRET_LENGTH = 32;
/** Longest access code read from a request; longer guesses are rejected unread. */
export const MAX_ACCESS_CODE_LENGTH = 256;

const COOKIE_VERSION = "v1";
/** `v1.<22-char id>.<10-digit expiry seconds>.<43-char signature>` */
const COOKIE_VALUE = /^v1\.([A-Za-z0-9_-]{22})\.([0-9]{10})\.([A-Za-z0-9_-]{43})$/;
const MAX_COOKIE_VALUE_LENGTH = 96;
const MAX_COOKIE_HEADER_LENGTH = 8_192;
const MAX_COOKIE_PAIRS = 64;
const MAX_AUTHORIZATION_LENGTH = 1_024;
const BEARER = /^Bearer ([\x21-\x7E]{1,512})$/;

export type Authorization =
  | { ok: true; identity: string; expiresAt: number }
  | { ok: false; code: "unauthorized" | "not-configured" };

/** What GET /api/session reports to the browser. Never contains a credential. */
export interface SessionStatus {
  ok: true;
  /** False only when local mode makes a session unnecessary. */
  required: boolean;
  authenticated: boolean;
  /** Epoch milliseconds at which the current session ends. */
  expiresAt?: number;
  /** Whether browser explanation access is available (including local mode). */
  available: boolean;
}

export type SessionConfig = { ok: true; code: string; secret: string } | { ok: false };

/** The judge session settings, or `ok: false` when either is missing or too short. */
export function sessionConfig(env: AccessEnv): SessionConfig {
  const code = env.PITCHLENS_JUDGE_ACCESS_CODE?.trim() ?? "";
  const secret = env.PITCHLENS_SESSION_SECRET?.trim() ?? "";
  if (code.length < MIN_ACCESS_CODE_LENGTH || code.length > MAX_ACCESS_CODE_LENGTH || secret.length < MIN_SESSION_SECRET_LENGTH)
    return { ok: false };
  return { ok: true, code, secret };
}

type AccessMode = "default" | "local" | "invalid";

/** Local mode is honoured only outside production; an unknown or forbidden mode fails closed. */
function accessMode(env: AccessEnv): AccessMode {
  const mode = env.PITCHLENS_ACCESS_MODE?.trim() ?? "";
  if (mode === "") return "default";
  if (mode === "local") return env.NODE_ENV === "production" ? "invalid" : "local";
  return "invalid";
}

// Secrets are compared as HMAC digests under a per-process key, so the
// comparison is constant-time and fixed-length whatever the input lengths.
const COMPARE_KEY = randomBytes(32);
const digest = (value: string) => createHmac("sha256", COMPARE_KEY).update(value, "utf8").digest();

/** Constant-time equality of two secrets. */
export function secretsMatch(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected)) && expected.length > 0;
}

function sign(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

/** A fresh session cookie value and its absolute expiry in epoch milliseconds. */
export function issueSession(secret: string, nowMs: number): { value: string; expiresAt: number } {
  const id = randomBytes(16).toString("base64url");
  const exp = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  const payload = `${COOKIE_VERSION}.${id}.${exp}`;
  return { value: `${payload}.${sign(secret, payload).toString("base64url")}`, expiresAt: exp * 1000 };
}

/**
 * Checks a session cookie value: exact shape, a valid signature, not expired,
 * and not expiring further ahead than one TTL (which no issued cookie can).
 */
export function verifySession(value: string, secret: string, nowMs: number): { ok: true; id: string; expiresAt: number } | { ok: false } {
  if (value.length > MAX_COOKIE_VALUE_LENGTH) return { ok: false };
  const m = COOKIE_VALUE.exec(value);
  if (!m) return { ok: false };
  const [, id = "", expText = "", sigText = ""] = m;
  const given = Buffer.from(sigText, "base64url");
  const expected = sign(secret, `${COOKIE_VERSION}.${id}.${expText}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };
  const expiresAt = Number(expText) * 1000;
  if (expiresAt <= nowMs || expiresAt > nowMs + SESSION_TTL_SECONDS * 1000) return { ok: false };
  return { ok: true, id, expiresAt };
}

/**
 * The value of one cookie from a Cookie header, or null when it is absent,
 * malformed, repeated (a shadowing cookie is treated as an attack) or the
 * header is unreasonably large.
 */
export function readCookie(header: string | null, name: string): string | null {
  if (!header || header.length > MAX_COOKIE_HEADER_LENGTH) return null;
  const pairs = header.split(";");
  if (pairs.length > MAX_COOKIE_PAIRS) return null;
  let found: string | null = null;
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0 || pair.slice(0, eq).trim() !== name) continue;
    if (found !== null) return null;
    found = pair.slice(eq + 1).trim();
  }
  return found;
}

function bearerToken(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header || header.length > MAX_AUTHORIZATION_LENGTH) return null;
  return BEARER.exec(header.trim())?.[1] ?? null;
}

/** The judge session carried by this request, if any. */
function cookieSession(request: Request, secret: string, nowMs: number) {
  const value = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  return value === null ? ({ ok: false } as const) : verifySession(value, secret, nowMs);
}

/**
 * Decides whether this request may spend model calls. Order: a valid
 * service bearer token, then local mode, then the judge session cookie.
 */
export function authorizeExplanation(request: Request, env: AccessEnv, nowMs: number = Date.now()): Authorization {
  const mode = accessMode(env);
  if (mode === "invalid") return { ok: false, code: "not-configured" };

  // Service and local access have no session, so expiresAt is a nominal one TTL ahead.
  const nominalExpiry = nowMs + SESSION_TTL_SECONDS * 1000;
  const serviceToken = env.PITCHLENS_EXPLAIN_ACCESS_TOKEN?.trim() ?? "";
  const bearer = bearerToken(request.headers);
  if (serviceToken && bearer !== null && secretsMatch(bearer, serviceToken)) return { ok: true, identity: "service", expiresAt: nominalExpiry };

  if (mode === "local") return { ok: true, identity: "local", expiresAt: nominalExpiry };

  const config = sessionConfig(env);
  if (!config.ok) return { ok: false, code: serviceToken ? "unauthorized" : "not-configured" };
  const session = cookieSession(request, config.secret, nowMs);
  if (!session.ok) return { ok: false, code: "unauthorized" };
  return { ok: true, identity: `judge:${session.id}`, expiresAt: session.expiresAt };
}

/** The browser-facing session state for this request. */
export function sessionStatus(request: Request, env: AccessEnv, nowMs: number = Date.now()): SessionStatus {
  const mode = accessMode(env);
  if (mode === "local") return { ok: true, required: false, authenticated: true, available: true };
  const config = sessionConfig(env);
  if (mode === "invalid" || !config.ok) return { ok: true, required: true, authenticated: false, available: false };
  const session = cookieSession(request, config.secret, nowMs);
  return session.ok
    ? { ok: true, required: true, authenticated: true, expiresAt: session.expiresAt, available: true }
    : { ok: true, required: true, authenticated: false, available: true };
}

/** Whether the session cookie must carry `Secure`: always in production, and on any HTTPS request. */
function secureCookie(request: Request, env: AccessEnv): boolean {
  return env.NODE_ENV === "production" || new URL(request.url).protocol === "https:";
}

/** The Set-Cookie header that stores a session. */
export function sessionCookieHeader(value: string, request: Request, env: AccessEnv): string {
  return [`${SESSION_COOKIE}=${value}`, "Path=/api", `Max-Age=${SESSION_TTL_SECONDS}`, "HttpOnly", "SameSite=Strict", ...(secureCookie(request, env) ? ["Secure"] : [])].join("; ");
}

/** The Set-Cookie header that removes the session. */
export function clearedSessionCookieHeader(request: Request, env: AccessEnv): string {
  return [`${SESSION_COOKIE}=`, "Path=/api", "Max-Age=0", "HttpOnly", "SameSite=Strict", ...(secureCookie(request, env) ? ["Secure"] : [])].join("; ");
}
