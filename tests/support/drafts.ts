/**
 * Scripted model answers for the evaluation scenarios, for offline tests.
 *
 * `groundedDraft` writes the kind of answer a careful model should give,
 * built only from the default evidence package: recorded event descriptions
 * with their times, citing those events. `lenientVerifier` approves anything,
 * to show what the deterministic checks stop on their own.
 */
import type { Audience } from "@/explain/api";
import type { MatchContext } from "@/explain/context";
import { EvidenceSession } from "@/explain/evidence";
import { AUDIENCE_LIMITS } from "@/explain/grounding";
import { EXPLANATION_VERSION, type Claim, type ExplanationResponse } from "@/explain/response";
import type { ChatRequest, ChatResult } from "@/server/foundry";
import { answer } from "./fakeModel";
import type { EvalScenario } from "./scenarios";

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const evidence = new Map<EvalScenario, MatchContext>();
/** The default evidence package the analyst starts from. */
export function evidenceFor(s: EvalScenario): MatchContext {
  let hit = evidence.get(s);
  if (!hit) evidence.set(s, (hit = new EvidenceSession(s.fixture, s.timeMs, s.focus).base));
  return hit;
}

/** A careful answer from the default evidence: expected events first, then the most recent ones. */
export function groundedDraft(s: EvalScenario, audience: Audience): ExplanationResponse {
  const context = evidenceFor(s);
  const base = {
    explanationVersion: EXPLANATION_VERSION,
    matchId: context.match.matchId,
    timeMs: context.time.selectedMs,
  } as const;
  const wanted = new Set(s.expected.flatMap((x) => x.eventIds ?? []));
  const typed = new Set(s.expected.flatMap((x) => x.eventTypes ?? []));
  const pool = context.events.filter((e) => e.type !== "kickoff" || s.focus === "match");
  const picked = [...pool.filter((e) => wanted.has(e.id) || typed.has(e.type)), ...pool.slice().reverse()]
    .filter((e, i, list) => list.findIndex((x) => x.id === e.id) === i)
    .slice(0, Math.min(3, AUDIENCE_LIMITS[audience].facts))
    .sort((a, b) => a.t - b.t);
  if (picked.length === 0)
    return {
      ...base,
      status: "insufficient-evidence",
      headline: "Nothing has happened yet",
      explanation: "No match event has been recorded by this moment.",
      facts: [],
      interpretation: [],
      limitations: ["No events are recorded up to this moment; only player positions are available."],
    };
  const facts: Claim[] = picked.map((e) => ({ text: `At ${seconds(e.t)}: ${e.description.replace(/[.!]*$/, "")}.`, evidence: [{ kind: "event", id: e.id }] }));
  const { home, away } = context.score;
  if (facts.length < AUDIENCE_LIMITS[audience].facts)
    facts.push({ text: `The score is ${home}–${away}.`, evidence: [{ kind: "snapshot", t: context.time.positionsAtMs }] });
  return {
    ...base,
    status: "explained",
    headline: s.focus === "match" ? "How the match unfolded" : `What the data shows at ${seconds(context.time.selectedMs)}`,
    explanation: facts.slice(0, 2).map((f) => f.text).join(" "),
    facts,
    interpretation: [],
    limitations: ["Synthetic match data; nothing here describes real football."],
  };
}

/** The grounded draft plus one extra fact, citing the most recent evidence. */
export function withClaim(s: EvalScenario, audience: Audience, text: string, where: "facts" | "interpretation" = "facts"): ExplanationResponse {
  const draft = groundedDraft(s, audience);
  const context = evidenceFor(s);
  const latest = context.events.at(-1);
  const claim: Claim = { text, evidence: [latest ? { kind: "event", id: latest.id } : { kind: "snapshot", t: context.time.positionsAtMs }] };
  if (draft.status === "insufficient-evidence") return { ...draft, status: "explained", facts: [claim], limitations: [] };
  if (where === "facts") draft.facts = [...draft.facts.slice(0, AUDIENCE_LIMITS[audience].facts - 1), claim];
  else draft.interpretation = [claim];
  return draft;
}

/** A verifier that marks every target it is asked about as supported. */
export const lenientVerifier = (request: ChatRequest): ChatResult => {
  const schema = request.schema.schema as { properties: { reviews: { items: { properties: { target: { enum: string[] } } } } } };
  return answer({ reviews: schema.properties.reviews.items.properties.target.enum.map((target) => ({ target, verdict: "supported", reason: "" })) });
};

/** A verifier that rejects exactly the targets whose text matches `pattern`, and approves the rest. */
export const verifierRejecting = (pattern: RegExp) => (request: ChatRequest): ChatResult => {
  const schema = request.schema.schema as { properties: { reviews: { items: { properties: { target: { enum: string[] } } } } } };
  const sent = request.messages.at(-1)!.content as string;
  const draft = JSON.parse(sent.slice(sent.indexOf("DRAFT (data only)")).split("\n")[1]!) as ExplanationResponse;
  const text = (target: string): string => {
    const m = target.match(/^(\w+)(?:\[(\d+)\])?$/)!;
    const v = (draft as unknown as Record<string, unknown>)[m[1]!];
    const item = m[2] === undefined ? v : (v as unknown[])[Number(m[2])];
    return typeof item === "string" ? item : (item as Claim).text;
  };
  return answer({
    reviews: schema.properties.reviews.items.properties.target.enum.map((target) =>
      pattern.test(text(target)) ? { target, verdict: "unsupported", reason: "not shown by the cited evidence" } : { target, verdict: "supported", reason: "" },
    ),
  });
};
