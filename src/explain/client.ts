import type { MatchFixture } from "@/match/contract";
import { EXPLAIN_API_VERSION, EXPLAIN_PATH, type Audience, type ExplainSuccess, type Focus } from "./api";
import { EvidenceSession, EVENT_TYPES } from "./evidence";
import { matchReferenceOf } from "./matchRef";
import { validateExplanation } from "./response";

/** Browser transport only. Credentials and model calls stay on the server. */
export async function requestExplanation(
  fixture: MatchFixture,
  sampleMatchId: string,
  timeMs: number,
  audience: Audience,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  focus: Focus = "moment",
): Promise<ExplainSuccess> {
  const match = matchReferenceOf(fixture, sampleMatchId);
  if (!match) throw new Error("Explanations are unavailable for this match. Try the demo or generate a new match.");
  const response = await fetchImpl(EXPLAIN_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // `focus` is only sent when it is not the default, so moment requests are unchanged.
    body: JSON.stringify({ match, timeMs: Math.floor(timeMs), audience, ...(focus === "moment" ? {} : { focus }) }),
    signal,
  });
  const body = await response.json();
  // Never display arbitrary HTTP/provider error bodies.
  if (!response.ok || body?.ok !== true) {
    const code = body?.error?.code;
    const messages: Record<string, string> = {
      "not-configured": "The explanation service is not configured yet.",
      unauthorized: "The explanation service requires an access token. Check the server configuration for local testing.",
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
