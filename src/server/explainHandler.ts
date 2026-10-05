/**
 * `POST /api/explain`: checks and admits a request, resolves the match,
 * runs the analyst workflow and answers with the contract in
 * src/explain/api.ts. Kept apart from the Next.js route so tests can call it
 * with a plain `Request` and a fake model client.
 */
import {
  AUDIENCES,
  EXPLAIN_API_VERSION,
  EXPLAIN_ERRORS,
  type Audience,
  type ExplainErrorCode,
  type ExplainFailure,
  type ExplainSuccess,
} from "@/explain/api";
import { parseMatchReference, type MatchReference } from "@/explain/matchRef";
import { explainMoment, type WorkflowLimits } from "./analyst";
import { FoundryClient, foundryConfigFromEnv, ModelError, type ModelClient, type FoundryConfig } from "./foundry";
import { AnswerCache, clientKey, RequestGuard, sameSecret } from "./guard";
import { resolveMatch } from "./resolveMatch";

/** Largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 4_096;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** One line per request, for operators: no prompts, model text, request bodies or credentials. */
export interface ExplainLogRecord {
  event: "explain";
  requestId: string;
  status: number;
  matchId?: string;
  timeMs?: number;
  audience?: Audience;
  cached?: boolean;
  outcome?: ExplainSuccess["verification"]["outcome"];
  error?: ExplainErrorCode;
  trace?: ExplainSuccess["trace"];
}

export interface ExplainDeps {
  env: Record<string, string | undefined>;
  /** Builds the model client from the configuration; tests pass a fake. */
  createClient: (config: FoundryConfig) => ModelClient;
  guard: RequestGuard;
  cache: AnswerCache<Omit<ExplainSuccess, "requestId" | "cached">>;
  log: (record: ExplainLogRecord) => void;
  limits?: Partial<WorkflowLimits>;
}

export function defaultDeps(): ExplainDeps {
  return {
    env: process.env,
    createClient: (config) => new FoundryClient(config),
    guard: new RequestGuard(),
    cache: new AnswerCache(),
    log: (record) => console.info(JSON.stringify(record)),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function json(body: ExplainSuccess | ExplainFailure, status: number, retryAfterMs?: number): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-request-id": body.requestId,
  };
  if (retryAfterMs !== undefined) headers["retry-after"] = String(Math.ceil(retryAfterMs / 1000));
  return new Response(JSON.stringify(body), { status, headers });
}

/** Reads at most `limit` bytes of the body; null when it is larger. */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function handleExplain(request: Request, deps: ExplainDeps): Promise<Response> {
  let requestId: string = crypto.randomUUID();
  const record: ExplainLogRecord = { event: "explain", requestId, status: 0 };

  const fail = (code: ExplainErrorCode, message: string, retryAfterMs?: number): Response => {
    const { status, retryable } = EXPLAIN_ERRORS[code];
    Object.assign(record, { requestId, status, error: code });
    deps.log(record);
    return json(
      { apiVersion: EXPLAIN_API_VERSION, ok: false, requestId, error: { code, message, retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } },
      status,
      retryAfterMs,
    );
  };

  // Access and origin checks come first, before the body is read.
  const token = deps.env.PITCHLENS_EXPLAIN_ACCESS_TOKEN?.trim();
  if (token) {
    const given = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
    if (!sameSecret(given, token)) return fail("unauthorized", "This service needs an access token.");
  }
  const origin = request.headers.get("origin");
  if (origin) {
    const allowed = new Set([new URL(request.url).origin, ...(deps.env.PITCHLENS_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean)]);
    if (!allowed.has(origin)) return fail("forbidden-origin", "Requests from this site are not allowed.");
  }
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return fail("unsupported-media-type", "Send the request as application/json.");

  const text = await readLimited(request, MAX_BODY_BYTES);
  if (text === null) return fail("payload-too-large", `The request is larger than ${MAX_BODY_BYTES} bytes.`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail("invalid-request", "The request is not valid JSON.");
  }
  if (!isObject(body)) return fail("invalid-request", "The request must be a JSON object.");
  if (body.requestId !== undefined) {
    if (typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId))
      return fail("invalid-request", "requestId must be 8–64 letters, digits, '_' or '-'.");
    requestId = body.requestId;
    record.requestId = requestId;
  }
  for (const key of Object.keys(body))
    if (!["requestId", "match", "timeMs", "audience"].includes(key)) return fail("invalid-request", `Unexpected field ${key}.`);
  const ref = parseMatchReference(body.match);
  if (!ref.ok) return fail("invalid-request", ref.error);
  const reference: MatchReference = ref.reference;
  if (typeof body.timeMs !== "number" || !Number.isFinite(body.timeMs) || body.timeMs < 0)
    return fail("invalid-request", "timeMs must be a number of milliseconds, 0 or more.");
  if (!(AUDIENCES as readonly unknown[]).includes(body.audience)) return fail("invalid-request", `audience must be one of ${AUDIENCES.join(", ")}.`);
  const audience = body.audience as Audience;
  const timeMs = Math.floor(body.timeMs);
  Object.assign(record, { matchId: reference.matchId, timeMs, audience });

  const config = foundryConfigFromEnv(deps.env);
  if (!config.ok) return fail("not-configured", "Explanations are not set up on this server.");

  const cacheKey = JSON.stringify([reference, timeMs, audience]);
  const cached = deps.cache.get(cacheKey);
  if (cached) {
    Object.assign(record, { status: 200, cached: true, outcome: cached.verification.outcome });
    deps.log(record);
    return json({ ...cached, requestId, cached: true }, 200);
  }

  const admission = deps.guard.admit(clientKey(request.headers));
  if (!admission.ok)
    return admission.code === "busy"
      ? fail("busy", "The service is busy. Try again in a moment.", admission.retryAfterMs)
      : fail("rate-limited", "Too many explanation requests. Try again shortly.", admission.retryAfterMs);

  try {
    const resolved = resolveMatch(reference);
    if (!resolved.ok) return fail("unknown-match", resolved.error);
    if (timeMs > resolved.fixture.durationMs)
      return fail("invalid-request", `timeMs is after the end of the match (${resolved.fixture.durationMs} ms).`);

    const result = await explainMoment({
      fixture: resolved.fixture,
      timeMs,
      audience,
      client: deps.createClient(config.config),
      signal: request.signal,
      limits: deps.limits,
    });
    const answer: Omit<ExplainSuccess, "requestId" | "cached"> = {
      apiVersion: EXPLAIN_API_VERSION,
      ok: true,
      matchId: resolved.fixture.matchId,
      timeMs: result.explanation.timeMs,
      audience,
      explanation: result.explanation,
      verification: result.verification,
      trace: result.trace,
    };
    deps.cache.set(cacheKey, answer);
    Object.assign(record, { status: 200, cached: false, outcome: result.verification.outcome, trace: result.trace });
    deps.log(record);
    return json({ ...answer, requestId, cached: false }, 200);
  } catch (e) {
    if (e instanceof ModelError) {
      if (e.code === "timeout") return fail("timeout", "The explanation took too long. Try again.");
      if (e.code === "rate-limited") return fail("upstream-rate-limited", "The model service is busy. Try again shortly.", e.retryAfterMs ?? 10_000);
      return fail("upstream-error", "The model service failed. Try again later.");
    }
    return fail("internal-error", "Something went wrong while explaining this moment.");
  } finally {
    admission.release();
  }
}
