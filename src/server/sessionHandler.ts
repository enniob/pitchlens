/**
 * `/api/session`: exchanges the judge access code for a signed session
 * cookie (POST), reports the session state (GET) and ends it (DELETE). The
 * rules for the cookie itself are in ./accessSession. Kept apart from the
 * Next.js route so tests can call it with a plain `Request`.
 */
import {
  clearedSessionCookieHeader,
  issueSession,
  MAX_ACCESS_CODE_LENGTH,
  secretsMatch,
  sessionConfig,
  sessionCookieHeader,
  sessionStatus,
  type AccessEnv,
  type SessionStatus,
} from "./accessSession";
import { RequestGuard } from "./guard";
import { BodyReadError, readLimitedBody } from "./requestBody";
import { requestOrigin } from "./requestOrigin";

export const SESSION_MAX_BODY_BYTES = 1_024;
export const SESSION_BODY_TIMEOUT_MS = 5_000;
/** Code attempts are scarce: a guessing client meets these long before the code space matters. */
export const SESSION_GUARD_LIMITS = { perClient: 5, global: 20, concurrent: 2 } as const;
/**
 * Every attempt shares one key. Forwarded-for headers can be forged, and a
 * forged address per request would otherwise buy a fresh allowance.
 */
const ATTEMPT_KEY = "unknown";

export type SessionErrorCode =
  | "unauthorized"
  | "not-configured"
  | "forbidden-origin"
  | "unsupported-media-type"
  | "payload-too-large"
  | "timeout"
  | "invalid-request"
  | "rate-limited"
  | "busy";

const STATUS: Record<SessionErrorCode, number> = {
  unauthorized: 401,
  "not-configured": 503,
  "forbidden-origin": 403,
  "unsupported-media-type": 415,
  "payload-too-large": 413,
  timeout: 408,
  "invalid-request": 400,
  "rate-limited": 429,
  busy: 503,
};

export interface SessionFailure {
  ok: false;
  error: { code: SessionErrorCode; message: string; retryAfterMs?: number };
}

/** One line per mutation, for operators: never the submitted code, cookie or secret. */
export interface SessionLogRecord {
  event: "session";
  action: "login" | "logout";
  status: number;
  error?: SessionErrorCode;
}

export interface SessionDeps {
  env: AccessEnv;
  guard: RequestGuard;
  now: () => number;
  readBody: (request: Request, limit: number, timeoutMs: number) => Promise<string>;
  log: (record: SessionLogRecord) => void;
}

export function defaultSessionDeps(): SessionDeps {
  return {
    env: process.env,
    guard: new RequestGuard(SESSION_GUARD_LIMITS),
    now: Date.now,
    readBody: readLimitedBody,
    log: (record) => console.info(JSON.stringify(record)),
  };
}

function json(body: SessionStatus | SessionFailure, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
  });
}

function failure(code: SessionErrorCode, message: string, retryAfterMs?: number, extra: Record<string, string> = {}): Response {
  const headers = retryAfterMs === undefined ? extra : { ...extra, "retry-after": String(Math.ceil(retryAfterMs / 1000)) };
  return json({ ok: false, error: { code, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } }, STATUS[code], headers);
}

/** Mutations must come from this exact origin; a missing Origin header is refused too. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === requestOrigin(request);
}

const BODY_ERRORS: Record<BodyReadError["code"], string> = {
  "payload-too-large": `The request is larger than ${SESSION_MAX_BODY_BYTES} bytes.`,
  timeout: "The request body took too long to arrive.",
  "invalid-request": "The request body could not be read.",
};

export function handleSessionGet(request: Request, deps: SessionDeps): Response {
  return json(sessionStatus(request, deps.env, deps.now()), 200);
}

export async function handleSessionPost(request: Request, deps: SessionDeps): Promise<Response> {
  const record: SessionLogRecord = { event: "session", action: "login", status: 0 };
  const done = (response: Response, error?: SessionErrorCode): Response => {
    Object.assign(record, { status: response.status, ...(error ? { error } : {}) });
    deps.log(record);
    return response;
  };
  const fail = (code: SessionErrorCode, message: string, retryAfterMs?: number) => done(failure(code, message, retryAfterMs), code);

  if (!sameOrigin(request)) return fail("forbidden-origin", "Requests from this site are not allowed.");
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return fail("unsupported-media-type", "Send the request as application/json.");
  const config = sessionConfig(deps.env);
  if (!config.ok) return fail("not-configured", "Access codes are not set up on this server.");

  // Admitted before the body is read, so slow or oversized attempts still count.
  const admission = deps.guard.admit(ATTEMPT_KEY);
  if (!admission.ok)
    return admission.code === "busy"
      ? fail("busy", "The service is busy. Try again in a moment.", admission.retryAfterMs)
      : fail("rate-limited", "Too many access attempts. Try again shortly.", admission.retryAfterMs);
  try {
    let text: string;
    try {
      text = await deps.readBody(request, SESSION_MAX_BODY_BYTES, SESSION_BODY_TIMEOUT_MS);
    } catch (e) {
      const code = e instanceof BodyReadError ? e.code : "invalid-request";
      return fail(code, BODY_ERRORS[code]);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail("invalid-request", "The request is not valid JSON.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("invalid-request", "The request must be a JSON object.");
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "code") return fail("invalid-request", "The request must contain only code.");
    const code = (body as { code: unknown }).code;
    if (typeof code !== "string" || code.length === 0 || code.length > MAX_ACCESS_CODE_LENGTH)
      return fail("invalid-request", `code must be a string of 1–${MAX_ACCESS_CODE_LENGTH} characters.`);
    if (!secretsMatch(code, config.code)) return fail("unauthorized", "That access code is not valid.");

    const session = issueSession(config.secret, deps.now());
    const status: SessionStatus = { ok: true, required: true, authenticated: true, expiresAt: session.expiresAt, available: true };
    return done(json(status, 200, { "set-cookie": sessionCookieHeader(session.value, request, deps.env) }));
  } finally {
    admission.release();
  }
}

export function handleSessionDelete(request: Request, deps: SessionDeps): Response {
  const record: SessionLogRecord = { event: "session", action: "logout", status: 0 };
  let response: Response;
  if (!sameOrigin(request)) {
    response = failure("forbidden-origin", "Requests from this site are not allowed.");
    record.error = "forbidden-origin";
  } else {
    const config = sessionConfig(deps.env);
    const status: SessionStatus = { ok: true, required: true, authenticated: false, available: config.ok };
    response = json(status, 200, { "set-cookie": clearedSessionCookieHeader(request, deps.env) });
  }
  record.status = response.status;
  deps.log(record);
  return response;
}
