import type { MatchFixture } from "@/match/contract";
import { EXPLAIN_API_VERSION, EXPLAIN_PATH, type Audience, type ExplainSuccess, type Focus } from "./api";
import { EvidenceSession, EVENT_TYPES } from "./evidence";
import { matchReferenceOf } from "./matchRef";
import { validateExplanation } from "./response";
import { recordedAccount } from "./recorded";

/** Waits without keeping a cancelled moment's retry alive. */
function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Longest provider cooldown applied to the shared queue; a longer one is left to an explicit retry. */
export const MAX_SHARED_COOLDOWN_MS = 60_000;

/**
 * Holds the shared queue for a provider cooldown, even one this request will
 * not retry, but never longer than MAX_SHARED_COOLDOWN_MS: an hour-long quota
 * wait must not freeze every later explanation behind "Queued".
 */
function shareCooldown(delayMs: number, onCooldown?: (delayMs: number) => void): void {
  onCooldown?.(Math.min(delayMs, MAX_SHARED_COOLDOWN_MS));
}

/** Honor the service cooldown; long waits are left to an explicit retry. */
function modelRetryDelay(response: Response, body: unknown): number {
  const ms = (body as { error?: { retryAfterMs?: unknown } })?.error?.retryAfterMs;
  const header = response.headers.get("retry-after");
  const headerMs = header === null ? 0 : Number.isFinite(Number(header))
    ? Number(header) * 1000 : Date.parse(header) - Date.now();
  return Math.max(1_000, typeof ms === "number" && Number.isFinite(ms) ? ms : 0,
    Number.isFinite(headerMs) ? headerMs : 0, ms === undefined && header === null ? 10_000 : 0);
}

/** Browser transport only. Credentials and model calls stay on the server. */
export async function requestExplanation(
  fixture: MatchFixture,
  sampleMatchId: string,
  timeMs: number,
  audience: Audience,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  focus: Focus = "moment",
  onCooldown?: (delayMs: number) => void,
): Promise<ExplainSuccess> {
  const match = matchReferenceOf(fixture, sampleMatchId);
  if (!match) throw new Error("Explanations are unavailable for this match. Try the demo or generate a new match.");
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    // `focus` is only sent when it is not the default, so moment requests are unchanged.
    body: JSON.stringify({ match, timeMs: Math.floor(timeMs), audience, ...(focus === "moment" ? {} : { focus }) }),
    signal,
  };
  signal.throwIfAborted();
  let response = await fetchImpl(EXPLAIN_PATH, init);
  let body = await response.json();
  // One retry for exhausted provider throttling retries, using exactly the same
  // request and scheduler slot. Access, quotas and evidence checks still apply.
  if ((!response.ok || body?.ok !== true) && body?.error?.code === "upstream-rate-limited") {
    const delayMs = modelRetryDelay(response, body);
    shareCooldown(delayMs, onCooldown);
    if (body.error.retryable !== false && delayMs <= MAX_SHARED_COOLDOWN_MS) {
      await waitForRetry(delayMs, signal);
      signal.throwIfAborted();
      response = await fetchImpl(EXPLAIN_PATH, init);
      body = await response.json();
      if ((!response.ok || body?.ok !== true) && body?.error?.code === "upstream-rate-limited")
        shareCooldown(modelRetryDelay(response, body), onCooldown);
    }
  }
  // Never display arbitrary HTTP/provider error bodies.
  if (!response.ok || body?.ok !== true) {
    const code = body?.error?.code;
    const messages: Record<string, string> = {
      "not-configured": "The explanation service is not configured yet.",
      unauthorized: "Unlock AI explanations using the access code above the match.",
      "explanations-disabled": "AI explanations are temporarily disabled. Playback is still available.",
      "budget-exhausted": "Today's AI explanation allowance has been reached. Playback is still available.",
      "session-quota-exhausted": "This session has used its AI explanation allowance.",
      "rate-limited": "Too many requests. Wait a minute before trying again.",
      busy: "The explanation service is busy. Try again shortly.",
      "upstream-rate-limited": "The model service is busy. Try again shortly.",
      timeout: "The explanation took too long. Please try again.",
      "unknown-match": "This match cannot be explained. Generate a new match and try again.",
    };
    throw new Error(messages[code] ?? "The explanation could not be loaded. Please try again.");
  }
  if (body.apiVersion !== EXPLAIN_API_VERSION || body.matchId !== fixture.matchId ||
      body.timeMs !== Math.floor(timeMs) || body.audience !== audience || (body.focus ?? "moment") !== focus)
    throw new Error("The explanation does not match the selected moment. Please try again.");

  // Repeat contract/cutoff checks before rendering, including evidence reachable
  // through the server's bounded tools. This does not prove the claims are true.
  const session = new EvidenceSession(fixture, timeMs, focus);
  // The recorded summary is optional: show it only when it is exactly what this
  // browser builds from its own evidence. Otherwise (an altered summary, or a
  // server on a different build) drop it and keep the checked fallback.
  if (body.recordedSummary !== undefined && (body.verification?.outcome !== "fallback" ||
      JSON.stringify(body.recordedSummary) !== JSON.stringify(recordedAccount(session.base, focus))))
    delete body.recordedSummary;
  for (const type of EVENT_TYPES) session.call("list_events", JSON.stringify({ types: [type] }));
  const explanation = body.explanation;
  for (const claim of [...(Array.isArray(explanation?.facts) ? explanation.facts : []),
    ...(Array.isArray(explanation?.interpretation) ? explanation.interpretation : [])]) {
    for (const ref of Array.isArray(claim?.evidence) ? claim.evidence : [])
      if (ref?.kind === "snapshot") session.call("get_positions", JSON.stringify({ atMs: ref.t }));
  }
  if (!validateExplanation(explanation, session.context()).ok)
    throw new Error("The explanation could not be checked against this moment. Please try again.");
  return body as ExplainSuccess;
}
