import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizeExplanation,
  issueSession,
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionStatus,
  verifySession,
  type SessionStatus,
} from "@/server/accessSession";
import { RequestGuard } from "@/server/guard";
import { BodyReadError, readLimitedBody } from "@/server/requestBody";
import {
  handleSessionDelete,
  handleSessionGet,
  handleSessionPost,
  SESSION_GUARD_LIMITS,
  type SessionDeps,
  type SessionFailure,
  type SessionLogRecord,
} from "@/server/sessionHandler";

const CODE = "judge-code-0123456789";
const SECRET = "s".repeat(16) + "e".repeat(16) + "-session-secret";
const TOKEN = "service-token-for-tests";
const ENV = { PITCHLENS_JUDGE_ACCESS_CODE: CODE, PITCHLENS_SESSION_SECRET: SECRET };
const ORIGIN = "https://pitchlens.example";
const URL_ = `${ORIGIN}/api/session`;
const NOW = 1_800_000_000_000;

function setup(env: Record<string, string | undefined> = ENV, overrides: Partial<SessionDeps> = {}) {
  const logs: SessionLogRecord[] = [];
  const deps: SessionDeps = {
    env,
    guard: new RequestGuard(SESSION_GUARD_LIMITS, () => NOW),
    now: () => NOW,
    readBody: readLimitedBody,
    log: (r) => logs.push(r),
    ...overrides,
  };
  return { deps, logs };
}

const login = (payload: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

const explainWith = (headers: Record<string, string>) => new Request(`${ORIGIN}/api/explain`, { method: "POST", headers });
const cookieValue = (setCookie: string) => setCookie.split(";")[0]!.slice(SESSION_COOKIE.length + 1);
const sign = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("base64url");

describe("session cookie", () => {
  it("round-trips an issued session with a random id and absolute expiry", () => {
    const a = issueSession(SECRET, NOW);
    const b = issueSession(SECRET, NOW);
    expect(a.value).not.toBe(b.value);
    expect(a.expiresAt).toBe(NOW + SESSION_TTL_SECONDS * 1000);
    const checked = verifySession(a.value, SECRET, NOW + 1_000);
    expect(checked).toMatchObject({ ok: true, expiresAt: a.expiresAt });
  });

  it("rejects tampering, another secret and malformed values", () => {
    const { value } = issueSession(SECRET, NOW);
    const [v, id, exp, sig = ""] = value.split(".");
    const flipped = sig[0] === "A" ? "B" + sig.slice(1) : "A" + sig.slice(1);
    expect(verifySession(`${v}.${id}.${exp}.${flipped}`, SECRET, NOW).ok).toBe(false);
    expect(verifySession(`${v}.${id}.${Number(exp) + 60}.${sig}`, SECRET, NOW).ok).toBe(false);
    expect(verifySession(`${v}.${"x".repeat(22)}.${exp}.${sig}`, SECRET, NOW).ok).toBe(false);
    expect(verifySession(value, "another-secret-of-at-least-32-chars!", NOW).ok).toBe(false);
    for (const bad of ["", "v1", `v2.${id}.${exp}.${sig}`, `${value}.extra`, `${value}${"A".repeat(200)}`, value.replace(".", "..")])
      expect(verifySession(bad, SECRET, NOW).ok).toBe(false);
  });

  it("rejects expired sessions and correctly signed expiries beyond one TTL", () => {
    const { value, expiresAt } = issueSession(SECRET, NOW);
    expect(verifySession(value, SECRET, expiresAt - 1).ok).toBe(true);
    expect(verifySession(value, SECRET, expiresAt).ok).toBe(false);
    const id = "a".repeat(22);
    const far = Math.floor(NOW / 1000) + SESSION_TTL_SECONDS + 60;
    const payload = `v1.${id}.${far}`;
    expect(verifySession(`${payload}.${sign(payload)}`, SECRET, NOW).ok).toBe(false);
  });

  it("parses cookie headers strictly and refuses shadowed or oversized ones", () => {
    expect(readCookie("a=1; pitchlens_session=abc; b=2", SESSION_COOKIE)).toBe("abc");
    expect(readCookie("pitchlens_session=abc; pitchlens_session=def", SESSION_COOKIE)).toBeNull();
    expect(readCookie("xpitchlens_session=abc", SESSION_COOKIE)).toBeNull();
    expect(readCookie(`pitchlens_session=abc; ${"x=1; ".repeat(100)}`, SESSION_COOKIE)).toBeNull();
    expect(readCookie(`pitchlens_session=${"a".repeat(9_000)}`, SESSION_COOKIE)).toBeNull();
    expect(readCookie(null, SESSION_COOKIE)).toBeNull();
  });
});

describe("authorizeExplanation", () => {
  const cookie = () => `${SESSION_COOKIE}=${issueSession(SECRET, NOW).value}`;

  it("accepts a valid judge session cookie", () => {
    const result = authorizeExplanation(explainWith({ cookie: cookie() }), ENV, NOW);
    expect(result).toMatchObject({ ok: true, expiresAt: NOW + SESSION_TTL_SECONDS * 1000 });
    if (result.ok) expect(result.identity).toMatch(/^judge:[A-Za-z0-9_-]{22}$/);
  });

  it("refuses missing, tampered and expired cookies", () => {
    expect(authorizeExplanation(explainWith({}), ENV, NOW)).toEqual({ ok: false, code: "unauthorized" });
    expect(authorizeExplanation(explainWith({ cookie: cookie() + "x" }), ENV, NOW)).toEqual({ ok: false, code: "unauthorized" });
    expect(authorizeExplanation(explainWith({ cookie: cookie() }), ENV, NOW + SESSION_TTL_SECONDS * 1000)).toEqual({ ok: false, code: "unauthorized" });
  });

  it("accepts the legacy service bearer token, and only an exact match", () => {
    const env = { ...ENV, PITCHLENS_EXPLAIN_ACCESS_TOKEN: TOKEN };
    expect(authorizeExplanation(explainWith({ authorization: `Bearer ${TOKEN}` }), env, NOW)).toMatchObject({ ok: true, identity: "service" });
    expect(authorizeExplanation(explainWith({ authorization: `Bearer ${TOKEN}x` }), env, NOW)).toEqual({ ok: false, code: "unauthorized" });
    expect(authorizeExplanation(explainWith({ authorization: `Basic ${TOKEN}` }), env, NOW)).toEqual({ ok: false, code: "unauthorized" });
    // With no session settings, only the bearer gets in.
    const tokenOnly = { PITCHLENS_EXPLAIN_ACCESS_TOKEN: TOKEN };
    expect(authorizeExplanation(explainWith({ authorization: `Bearer ${TOKEN}` }), tokenOnly, NOW)).toMatchObject({ ok: true, identity: "service" });
    expect(authorizeExplanation(explainWith({}), tokenOnly, NOW)).toEqual({ ok: false, code: "unauthorized" });
  });

  it("fails closed when session settings are missing or too weak", () => {
    for (const env of [{}, { PITCHLENS_JUDGE_ACCESS_CODE: CODE }, { PITCHLENS_SESSION_SECRET: SECRET }, { ...ENV, PITCHLENS_JUDGE_ACCESS_CODE: "short-code" }, { ...ENV, PITCHLENS_SESSION_SECRET: "too-short-secret" }])
      expect(authorizeExplanation(explainWith({ cookie: cookie() }), env, NOW)).toEqual({ ok: false, code: "not-configured" });
  });

  it("allows explicit local mode only outside production", () => {
    expect(authorizeExplanation(explainWith({}), { PITCHLENS_ACCESS_MODE: "local", NODE_ENV: "development" }, NOW)).toMatchObject({ ok: true, identity: "local" });
    expect(authorizeExplanation(explainWith({}), { PITCHLENS_ACCESS_MODE: "local", NODE_ENV: "production" }, NOW)).toEqual({ ok: false, code: "not-configured" });
    expect(authorizeExplanation(explainWith({ cookie: cookie() }), { ...ENV, PITCHLENS_ACCESS_MODE: "local", NODE_ENV: "production" }, NOW)).toEqual({ ok: false, code: "not-configured" });
    expect(authorizeExplanation(explainWith({}), { ...ENV, PITCHLENS_ACCESS_MODE: "open" }, NOW)).toEqual({ ok: false, code: "not-configured" });
    expect(sessionStatus(explainWith({}), { PITCHLENS_ACCESS_MODE: "local", NODE_ENV: "production" }, NOW)).toEqual({ ok: true, required: true, authenticated: false, available: false });
  });
});

describe("/api/session", () => {
  it("issues a hardened cookie for the right code, which then authorizes explanations", async () => {
    const { deps, logs } = setup();
    const res = await handleSessionPost(login({ code: CODE }), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionStatus;
    expect(body).toEqual({ ok: true, required: true, authenticated: true, expiresAt: NOW + SESSION_TTL_SECONDS * 1000, available: true });
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.`));
    for (const flag of ["Path=/api", `Max-Age=${SESSION_TTL_SECONDS}`, "HttpOnly", "SameSite=Strict", "Secure"]) expect(setCookie).toContain(flag);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const auth = authorizeExplanation(explainWith({ cookie: `${SESSION_COOKIE}=${cookieValue(setCookie)}` }), ENV, NOW);
    expect(auth.ok).toBe(true);
    // Neither the response body nor the log carries a credential.
    const text = JSON.stringify(body) + JSON.stringify(logs);
    for (const secret of [CODE, SECRET, cookieValue(setCookie)]) expect(text).not.toContain(secret);
    expect(logs).toEqual([{ event: "session", action: "login", status: 200 }]);

    const status = handleSessionGet(new Request(URL_, { headers: { cookie: `${SESSION_COOKIE}=${cookieValue(setCookie)}` } }), deps);
    expect(await status.json()).toEqual(body);
  });

  it("sets Secure only for production or HTTPS", async () => {
    const http = (await handleSessionPost(new Request("http://localhost:3000/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ code: CODE }),
    }), setup().deps)).headers.get("set-cookie")!;
    expect(http).not.toContain("Secure");
    const prod = (await handleSessionPost(new Request("http://localhost:3000/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ code: CODE }),
    }), setup({ ...ENV, NODE_ENV: "production" }).deps)).headers.get("set-cookie")!;
    expect(prod).toContain("Secure");
  });

  it("refuses a wrong code without issuing a cookie", async () => {
    const { deps, logs } = setup();
    const res = await handleSessionPost(login({ code: CODE + "x" }), deps);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(((await res.json()) as SessionFailure).error.code).toBe("unauthorized");
    expect(JSON.stringify(logs)).not.toContain(CODE);
  });

  it("limits code attempts whatever forwarded address a client claims", async () => {
    const { deps } = setup();
    const statuses: number[] = [];
    for (let i = 0; i < SESSION_GUARD_LIMITS.perClient + 2; i++)
      statuses.push((await handleSessionPost(login({ code: `wrong-${i}` }, { "x-forwarded-for": `10.0.0.${i}` }), deps)).status);
    expect(statuses.slice(0, SESSION_GUARD_LIMITS.perClient)).toEqual(Array(SESSION_GUARD_LIMITS.perClient).fill(401));
    const limited = await handleSessionPost(login({ code: CODE }), deps);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(limited.headers.get("set-cookie")).toBeNull();
  });

  it("releases its concurrency slot after every attempt", async () => {
    const { deps } = setup(ENV, { guard: new RequestGuard({ perClient: 100, global: 100, concurrent: 1 }, () => NOW) });
    await handleSessionPost(login({ code: "wrong" }), deps);
    await handleSessionPost(login("{"), deps);
    expect((await handleSessionPost(login({ code: CODE }), deps)).status).toBe(200);
  });

  it("accepts exactly {code: string}", async () => {
    const { deps } = setup(ENV, { guard: new RequestGuard({ perClient: 100, global: 100 }, () => NOW) });
    for (const payload of [{ code: CODE, extra: 1 }, {}, { code: 123 }, { code: "" }, { code: "x".repeat(300) }, [CODE], "null", "{"]) {
      const res = await handleSessionPost(login(payload), deps);
      expect(res.status).toBe(400);
      expect(((await res.json()) as SessionFailure).error.code).toBe("invalid-request");
    }
    expect((await handleSessionPost(login({ code: CODE }, { "content-type": "text/plain" }), deps)).status).toBe(415);
  });

  it("refuses oversized bodies", async () => {
    const { deps } = setup();
    const res = await handleSessionPost(login({ code: CODE, pad: "x".repeat(2_000) }), deps);
    expect(res.status).toBe(413);
  });

  it("refuses cross-origin or origin-less mutations", async () => {
    const { deps } = setup();
    for (const origin of ["https://evil.example", "http://pitchlens.example", "null"]) {
      expect((await handleSessionPost(login({ code: CODE }, { origin }), deps)).status).toBe(403);
      expect(handleSessionDelete(new Request(URL_, { method: "DELETE", headers: { origin } }), deps).status).toBe(403);
    }
    const noOrigin = new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: CODE }) });
    expect((await handleSessionPost(noOrigin, deps)).status).toBe(403);
  });

  it("accepts the browser origin when Next uses an internal hostname", async () => {
    const { deps } = setup();
    const request = new Request("https://internal.example/api/session", {
      method: "POST", headers: { "content-type": "application/json", host: "pitchlens.example", origin: ORIGIN },
      body: JSON.stringify({ code: CODE }),
    });
    expect((await handleSessionPost(request, deps)).status).toBe(200);
  });

  it("fails closed when access codes are not configured", async () => {
    const { deps } = setup({ PITCHLENS_JUDGE_ACCESS_CODE: CODE });
    const res = await handleSessionPost(login({ code: CODE }), deps);
    expect(res.status).toBe(503);
    expect(((await res.json()) as SessionFailure).error.code).toBe("not-configured");
    expect(await handleSessionGet(new Request(URL_), deps).json()).toEqual({ ok: true, required: true, authenticated: false, available: false });
  });

  it("times out a body that never finishes and releases the slot", async () => {
    const { deps } = setup(ENV, {
      guard: new RequestGuard({ perClient: 100, global: 100, concurrent: 1 }, () => NOW),
      readBody: (request, limit) => readLimitedBody(request, limit, 20),
    });
    const stalled = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode('{"code":')) });
    const req = new Request(URL_, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: stalled, duplex: "half" } as RequestInit);
    const res = await Promise.race([handleSessionPost(req, deps), new Promise<null>((r) => setTimeout(() => r(null), 1_000))]);
    expect(res?.status, "the body read never timed out").toBe(408);
    expect((await handleSessionPost(login({ code: CODE }), deps)).status).toBe(200);
  });

  it("maps body read failures and releases the slot", async () => {
    for (const [code, status] of [["timeout", 408], ["payload-too-large", 413], ["invalid-request", 400]] as const) {
      const { deps } = setup(ENV, {
        guard: new RequestGuard({ perClient: 100, global: 100, concurrent: 1 }, () => NOW),
        readBody: async () => { throw new BodyReadError(code); },
      });
      const res = await handleSessionPost(login({ code: CODE }), deps);
      expect(res.status).toBe(status);
      expect(((await res.json()) as SessionFailure).error.code).toBe(code);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(deps.guard.admit("unknown").ok).toBe(true);
    }
  });

  it("stops reading when the client aborts", async () => {
    const { deps } = setup();
    const controller = new AbortController();
    const stalled = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode('{"code":')) });
    const req = new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: stalled,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit);
    const pending = handleSessionPost(req, deps);
    setTimeout(() => controller.abort(), 10);
    const res = await pending;
    expect(res.status).toBe(408);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("clears the cookie on DELETE", async () => {
    const { deps } = setup();
    const res = handleSessionDelete(new Request(URL_, { method: "DELETE", headers: { origin: ORIGIN } }), deps);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    for (const flag of ["Path=/api", "Max-Age=0", "HttpOnly", "SameSite=Strict"]) expect(setCookie).toContain(flag);
    expect(await res.json()).toEqual({ ok: true, required: true, authenticated: false, available: true });
  });

  it("reports local mode as not requiring a session", async () => {
    const { deps } = setup({ PITCHLENS_ACCESS_MODE: "local", NODE_ENV: "test" });
    expect(await handleSessionGet(new Request(URL_), deps).json()).toEqual({ ok: true, required: false, authenticated: true, available: true });
  });
});
