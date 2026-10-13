/**
 * `POST /api/explain`: checks and admits a request, resolves the match,
 * runs the analyst workflow and answers with the contract in
 * src/explain/api.ts. Kept apart from the Next.js route so tests can call it
 * with a plain `Request` and a fake model client.
 */
import {
  AUDIENCES,
  EXPLAIN_API_VERSION,
  FOCUSES,
  EXPLAIN_ERRORS,
  type Audience,
  type ExplainErrorCode,
  type ExplainFailure,
  type ExplainSuccess,
  type Focus,
} from "@/explain/api";
import { parseMatchReference, type MatchReference } from "@/explain/matchRef";
import { explainMoment, WORKFLOW_LIMITS, type WorkflowLimits } from "./analyst";
import { FoundryClient, foundryConfigFromEnv, ModelError, type ModelClient, type FoundryConfig } from "./foundry";
import { AnswerCache, RequestGuard } from "./guard";
import { resolveMatch } from "./resolveMatch";
import { authorizeExplanation } from "./accessSession";
import { BodyReadError, readLimitedBody } from "./requestBody";
import { UsageBudget, usageConfig } from "./usageBudget";
import { requestOrigin } from "./requestOrigin";

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
  focus?: Focus;
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
  ingress?: RequestGuard;
  budget?: UsageBudget;
}

const state = new WeakMap<ExplainDeps, { ingress: RequestGuard; budget: UsageBudget }>();
function protections(deps: ExplainDeps) {
  let value = state.get(deps);
  if (!value) {
    value = { ingress: deps.ingress ?? new RequestGuard({ perClient: 60, global: 240, concurrent: 16 }), budget: deps.budget ?? new UsageBudget() };
    state.set(deps, value);
  }
  return value;
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
  if (deps.env.PITCHLENS_EXPLANATIONS_DISABLED === "1") return fail("explanations-disabled", "AI explanations are temporarily disabled.");
  const access = authorizeExplanation(request, deps.env);
  if (!access.ok) return fail(access.code, access.code === "unauthorized" ? "Unlock AI explanations with your access code." : "Explanation access is not configured on this server.");
  const origin = request.headers.get("origin");
  if (origin) {
    const allowed = new Set([requestOrigin(request), ...(deps.env.PITCHLENS_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean)]);
    if (!allowed.has(origin)) return fail("forbidden-origin", "Requests from this site are not allowed.");
  }
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return fail("unsupported-media-type", "Send the request as application/json.");

  const protection = protections(deps);
  const incoming = protection.ingress.admit(access.identity);
  if (!incoming.ok) return fail(incoming.code, "Too many requests. Try again shortly.", incoming.retryAfterMs);
  try {
  let text: string;
  try { text = await readLimitedBody(request, MAX_BODY_BYTES); }
  catch (error) {
    if (error instanceof BodyReadError) return fail(error.code, error.code === "timeout" ? "The request body took too long or was cancelled." : error.code === "payload-too-large" ? `The request is larger than ${MAX_BODY_BYTES} bytes.` : "The request body could not be read.");
    return fail("invalid-request", "The request body could not be read.");
  }
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
    if (!["requestId", "match", "timeMs", "audience", "focus"].includes(key)) return fail("invalid-request", `Unexpected field ${key}.`);
  const ref = parseMatchReference(body.match);
  if (!ref.ok) return fail("invalid-request", ref.error);
  const reference: MatchReference = ref.reference;
  if (typeof body.timeMs !== "number" || !Number.isFinite(body.timeMs) || body.timeMs < 0)
    return fail("invalid-request", "timeMs must be a number of milliseconds, 0 or more.");
  if (!(AUDIENCES as readonly unknown[]).includes(body.audience)) return fail("invalid-request", `audience must be one of ${AUDIENCES.join(", ")}.`);
  const audience = body.audience as Audience;
  if (body.focus !== undefined && !(FOCUSES as readonly unknown[]).includes(body.focus))
    return fail("invalid-request", `focus must be one of ${FOCUSES.join(", ")}.`);
  const focus: Focus = (body.focus as Focus | undefined) ?? "moment";
  const timeMs = Math.floor(body.timeMs);
  Object.assign(record, { matchId: reference.matchId, timeMs, audience, focus });

  const config = foundryConfigFromEnv(deps.env);
  if (!config.ok) return fail("not-configured", "Explanations are not set up on this server.");
  const usage = usageConfig(deps.env);
  if (!usage) return fail("not-configured", "Explanation usage limits are not configured correctly.");

  const { baseUrl, deployment, verifierDeployment, structuredOutput, reasoningEffort, temperature } = config.config;
  // Model settings affect the answer. Never reuse a result from an older
  // deployment or reasoning mode, and never put credentials in cache keys.
  const cacheKey = JSON.stringify([reference, timeMs, audience, focus,
    { baseUrl, deployment, verifierDeployment, structuredOutput, reasoningEffort, temperature }, deps.limits ?? null]);
  const cached = deps.cache.get(cacheKey);
  if (cached) {
    Object.assign(record, { status: 200, cached: true, outcome: cached.verification.outcome });
    deps.log(record);
    return json({ ...cached, requestId, cached: true }, 200);
  }

  const admission = deps.guard.admit(access.identity);
  if (!admission.ok)
    return admission.code === "busy"
      ? fail("busy", "The service is busy. Try again in a moment.", admission.retryAfterMs)
      : fail("rate-limited", "Too many explanation requests. Try again shortly.", admission.retryAfterMs);

  let reservation: { settle: (charged?: number) => void } | undefined;
  try {
    const resolved = resolveMatch(reference);
    if (!resolved.ok) return fail("unknown-match", resolved.error);
    if (timeMs > resolved.fixture.durationMs)
      return fail("invalid-request", `timeMs is after the end of the match (${resolved.fixture.durationMs} ms).`);
    // Enforced here, not only in the viewer: a summary describes the whole match, so it is only given at full time.
    if (focus === "match" && timeMs !== resolved.fixture.durationMs)
      return fail("invalid-request", `A match summary is only available at full time (timeMs ${resolved.fixture.durationMs}).`);

    const allowed = protection.budget.reserve(access.identity, access.expiresAt, deps.limits?.totalTokens ?? WORKFLOW_LIMITS.totalTokens, usage.dailyTokens, usage.sessionExplanations);
    if (!allowed.ok) return fail(allowed.code, allowed.code === "budget-exhausted" ? "The explanation service has reached its daily usage allowance." : allowed.code === "session-quota-exhausted" ? "This session has used its explanation allowance." : "This session already has an explanation running.", allowed.retryAfterMs);
    reservation = allowed;
    const result = await explainMoment({
      fixture: resolved.fixture,
      timeMs,
      audience,
      focus,
      client: deps.createClient(config.config),
      signal: request.signal,
      limits: deps.limits,
    });
    reservation.settle(result.trace.chargedTokens);
    const answer: Omit<ExplainSuccess, "requestId" | "cached"> = {
      apiVersion: EXPLAIN_API_VERSION,
      ok: true,
      matchId: resolved.fixture.matchId,
      timeMs: result.explanation.timeMs,
      audience,
      focus,
      explanation: result.explanation,
      ...(result.recordedSummary ? { recordedSummary: result.recordedSummary } : {}),
      verification: result.verification,
      trace: result.trace,
    };
    // A failed model answer should be retryable, not sticky for ten minutes.
    if (answer.verification.outcome !== "fallback") deps.cache.set(cacheKey, answer);
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
    reservation?.settle();
    admission.release();
  }
  } finally {
    incoming.release();
  }
}
