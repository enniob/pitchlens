/**
 * "Explain this moment": deterministic checks of an explanation's wording
 * against the evidence, run after `validateExplanation` has accepted its
 * structure and citations.
 *
 * `validateExplanation` proves every citation points at real evidence, but not
 * that the text says what the evidence shows. These checks catch the common
 * ways a model's text can go beyond its evidence, using only string matching:
 *
 *   - a time later than the selected time ("at 12.4 s" when paused at 9 s)
 *   - a score other than the score at the selected time
 *   - a shirt number or player surname that is not in the roster, or, in a
 *     claim, a player the claim's cited events do not involve
 *   - an event (goal, offside, foul, save, ...) that is not in the claim's cited
 *     evidence or, for the headline and explanation, in any supplied evidence
 *   - wording too long or too dense for the requested audience
 *
 * Limitations get the time, score and player checks, but not the event ones.
 *
 * They are heuristics: passing them does not prove the text is supported, and
 * the word lists are deliberately narrow so that ordinary football language
 * ("a shot on goal", "the corner of the box") is not rejected.
 */
import type { Audience } from "./api";
import type { ContextEvent, MatchContext } from "./context";
import type { Claim, ExplanationResponse } from "./response";

/** Wording limits per audience, stricter than the contract's own limits. */
export const AUDIENCE_LIMITS: Record<Audience, { explanation: number; facts: number; interpretation: number }> = {
  casual: { explanation: 600, facts: 4, interpretation: 2 },
  analyst: { explanation: 1_200, facts: 8, interpretation: 5 },
};

/** Words that state a particular kind of event happened, and the evidence that supports them. */
const EVENT_WORDS: { label: string; pattern: RegExp; supports: (e: ContextEvent) => boolean; inInterpretation: boolean }[] = [
  {
    label: "a goal",
    pattern: /\b(scores|scored|scoring|equali[sz](es|ed|er|ing))\b|\b(opening|winning|first|second|third)\s+goal\b|\bgoal\s+(for|by)\b/i,
    supports: (e) => e.type === "goal",
    inInterpretation: true,
  },
  { label: "an offside", pattern: /\b(flagged\s+)?offside\b(?!\s+(line|trap|position))/i, supports: (e) => e.type === "offside", inInterpretation: false },
  { label: "a foul", pattern: /\bfoul(ed|s)?\b/i, supports: (e) => e.type === "foul" || e.type === "free-kick" || e.type === "penalty", inInterpretation: false },
  { label: "a penalty", pattern: /\bpenalty\b(?!\s+(area|box|spot))/i, supports: (e) => e.type === "penalty", inInterpretation: false },
  { label: "a corner", pattern: /\bcorner(\s+kick)?s?\b(?!\s+(of|flag))/i, supports: (e) => e.type === "corner", inInterpretation: false },
  { label: "a throw-in", pattern: /\bthrow-?ins?\b/i, supports: (e) => e.type === "throw-in", inInterpretation: false },
  {
    label: "a save",
    pattern: /\b(saves|saved|parried|parries)\b|\b(a|the)\s+save\b/i,
    supports: (e) => (e.type === "shot-result" && e.outcome === "saved") || e.type === "deflection",
    inInterpretation: false,
  },
];

const TIME = /(\d+(?:\.\d+)?)\s*(ms|s|secs?|seconds?)\b/gi;
const MINUTE = /\b(\d+)(?:st|nd|rd|th)?\s+minute\b/gi;
// Two numbers joined by a dash, but not part of a formation such as 4-3-3.
const SCORE = /(?<![\d.\-–])(\d{1,2})\s?[–-]\s?(\d{1,2})(?![\d\-–])/g;
const NUMBER = /#(\d{1,3})\b/g;

interface Scope {
  events: ContextEvent[];
  /** Players the text may name. */
  players: Set<string>;
}

/** Issues with the response's wording; empty when every check passes. */
export function checkGrounding(response: ExplanationResponse, context: MatchContext, audience: Audience): string[] {
  const issues: string[] = [];
  const limits = AUDIENCE_LIMITS[audience];
  if (response.explanation.length > limits.explanation)
    issues.push(`explanation is longer than ${limits.explanation} characters for the ${audience} audience`);
  if (response.facts.length > limits.facts) issues.push(`more than ${limits.facts} facts for the ${audience} audience`);
  if (response.interpretation.length > limits.interpretation)
    issues.push(`more than ${limits.interpretation} interpretation claims for the ${audience} audience`);

  const allPlayers = new Set(context.players.map((p) => p.id));
  const everything: Scope = { events: context.events, players: allPlayers };
  const eventById = new Map(context.events.map((e) => [e.id, e]));
  const scopeOf = (claim: Claim): Scope => {
    const events = claim.evidence.flatMap((r) => (r.kind === "event" && eventById.has(r.id) ? [eventById.get(r.id)!] : []));
    // A snapshot shows every player; an event involves its player and recipient, or the whole team for a formation change.
    if (claim.evidence.some((r) => r.kind === "snapshot")) return { events, players: allPlayers };
    const players = new Set<string>();
    for (const e of events) {
      if (e.playerId) players.add(e.playerId);
      if (e.recipientId) players.add(e.recipientId);
      if (e.type === "formation-change") for (const p of context.players) if (p.teamId === e.teamId) players.add(p.id);
    }
    return { events, players };
  };

  check(issues, "headline", response.headline, everything, context, "all");
  check(issues, "explanation", response.explanation, everything, context, "all");
  response.facts.forEach((c, i) => check(issues, `facts[${i}]`, c.text, scopeOf(c), context, "all"));
  response.interpretation.forEach((c, i) => check(issues, `interpretation[${i}]`, c.text, scopeOf(c), context, "interpretation"));
  // Limitations say what is unknown ("whether the shot was saved"), so event wording is not checked there.
  response.limitations.forEach((l, i) => check(issues, `limitations[${i}]`, l, everything, context, "none"));
  return issues;
}

function check(issues: string[], where: string, text: string, scope: Scope, context: MatchContext, events: "all" | "interpretation" | "none"): void {
  const selected = context.time.selectedMs;

  for (const m of text.matchAll(TIME)) {
    const ms = m[2]!.toLowerCase() === "ms" ? Number(m[1]) : Number(m[1]) * 1000;
    if (ms > selected + 50) issues.push(`${where} mentions ${m[0].trim()}, after the selected time (${selected / 1000} s)`);
  }
  for (const m of text.matchAll(MINUTE)) {
    if ((Number(m[1]) - 1) * 60_000 > selected) issues.push(`${where} mentions the ${m[0].trim()}, after the selected time`);
  }

  const { home, away } = context.score;
  for (const m of text.matchAll(SCORE)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (!((a === home && b === away) || (a === away && b === home)))
      issues.push(`${where} mentions the score ${m[0]}, but it is ${home}–${away} at the selected time`);
  }

  for (const m of text.matchAll(NUMBER)) {
    const n = Number(m[1]);
    const withNumber = context.players.filter((p) => p.number === n);
    if (withNumber.length === 0) issues.push(`${where} mentions #${n}, which no player wears`);
    else if (!withNumber.some((p) => scope.players.has(p.id))) issues.push(`${where} mentions #${n}, who is not in the evidence it cites`);
  }
  for (const p of context.players) {
    const surname = p.name.split(/\s+/).pop()!;
    if (surname.length < 3 || !new RegExp(`\\b${escape(surname)}\\b`).test(text)) continue;
    // Another player with the same surname in scope also counts.
    const same = context.players.filter((q) => q.name.split(/\s+/).pop() === surname);
    if (!same.some((q) => scope.players.has(q.id))) issues.push(`${where} names ${surname}, who is not in the evidence it cites`);
  }

  const summary = where === "headline" || where === "explanation";
  // A goal before the evidence window still counts in the score, but cannot be cited.
  const uncitableGoal = home + away > 0 && !context.events.some((e) => e.type === "goal");
  for (const w of EVENT_WORDS) {
    if (events === "none" || (events === "interpretation" && !w.inInterpretation)) continue;
    const m = text.match(w.pattern);
    if (!m || scope.events.some(w.supports)) continue;
    if (w.label === "a goal" && (uncitableGoal || (summary && home + away > 0))) continue;
    issues.push(`${where} says "${m[0]}", but the evidence it ${summary ? "has" : "cites"} contains no ${w.label.replace(/^an? /, "")}`);
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
