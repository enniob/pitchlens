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
 *     claim, a player the claim's cited events do not involve or name
 *   - an event (goal, shot result, offside, foul, save, ...) that is not in the
 *     claim's cited evidence (facts and interpretation alike) or, for the
 *     headline and explanation, in any supplied evidence. Only the headline
 *     and explanation may mention a goal the score shows but the evidence
 *     window no longer contains.
 *   - wording too long or too dense for the requested audience
 *
 * Limitations get the time, score and player checks, but not the event ones.
 *
 * They are heuristics: passing them does not prove the text is supported, and
 * the word lists are deliberately narrow so that ordinary football language
 * ("a shot on goal", "the corner of the box") is not rejected.
 */
import type { Score } from "@/match/contract";
import type { Audience, Focus } from "./api";
import type { ContextEvent, MatchContext } from "./context";
import type { Claim, ExplanationResponse } from "./response";

/** Wording limits per audience, stricter than the contract's own limits. */
export const AUDIENCE_LIMITS: Record<Audience, { explanation: number; facts: number; interpretation: number }> = {
  casual: { explanation: 600, facts: 4, interpretation: 2 },
  analyst: { explanation: 1_200, facts: 8, interpretation: 5 },
};

/**
 * Words that state a particular kind of event happened, and the evidence that
 * supports them. Facts and interpretation are checked alike; the lookaheads keep
 * tactical terms ("offside trap", "penalty area", "corner of the box") from
 * counting as events.
 */
const EVENT_WORDS: { label: string; pattern: RegExp; supports: (e: ContextEvent) => boolean }[] = [
  { label: "a shot", pattern: /\b(shots?|shoots|shooting)\b/i, supports: (e) => e.type === "shot" },
  {
    label: "a goal",
    pattern: /\b(scores|scored|scoring|equali[sz](es|ed|er|ing))\b|\b(opening|winning|first|second|third)\s+goal\b|\bgoal\s+(for|by)\b/i,
    supports: (e) => e.type === "goal",
  },
  {
    // A shot's result, which is unknown until its goal or shot-result event is revealed.
    label: "a shot result",
    pattern:
      /\b(into the (net|goal)|in the net|went in|goes in|crossed the (goal ?)?line|beat the (keeper|goalkeeper)|(on|off) target|went wide|goes wide|wide of the (post|goal|target)|over the bar|hit the (post|bar|crossbar|woodwork))\b/i,
    supports: (e) => e.type === "goal" || e.type === "shot-result" || e.type === "deflection" || (e.type === "shot" && e.outcome !== "pending"),
  },
  { label: "an offside", pattern: /\b(flagged\s+)?offside\b(?!\s+(line|trap|position))/i, supports: (e) => e.type === "offside" },
  { label: "a foul", pattern: /\bfoul(ed|s)?\b/i, supports: (e) => e.type === "foul" || e.type === "free-kick" || e.type === "penalty" },
  { label: "a penalty", pattern: /\bpenalty\b(?!\s+(area|box|spot))/i, supports: (e) => e.type === "penalty" },
  { label: "a corner", pattern: /\bcorner(\s+kick)?s?\b(?!\s+(of|flag))/i, supports: (e) => e.type === "corner" },
  { label: "a throw-in", pattern: /\bthrow-?ins?\b/i, supports: (e) => e.type === "throw-in" },
  {
    label: "a save",
    pattern: /\b(saves|saved|parried|parries)\b|\b(a|the)\s+save\b/i,
    supports: (e) => (e.type === "shot-result" && e.outcome === "saved") || e.type === "deflection",
  },
];

// Not a shirt number followed by an initial, as event descriptions name players ("#6 S. Okafor").
const TIME = /(?<![#\d.])(\d+(?:\.\d+)?)\s*(ms|s|secs?|[sS]econds?)\b/g;
const MINUTE = /\b(\d+)(?:st|nd|rd|th)?\s+minute\b/gi;
// Two numbers joined by a dash, but not part of a formation such as 4-3-3.
const SCORE = /(?<![\d.\-–])(\d{1,2})\s?[–-]\s?(\d{1,2})(?![\d\-–])/g;
const NUMBER = /#(\d{1,3})\b/g;

interface Scope {
  events: ContextEvent[];
  snapshotTimes?: number[];
  /** Players the text may name. */
  players: Set<string>;
}

/** Issues with the response's wording; empty when every check passes. */
export function checkGrounding(response: ExplanationResponse, context: MatchContext, audience: Audience, focus: Focus = "moment"): string[] {
  const issues: string[] = [];
  const scores = focus === "match" ? scoreProgression(context) : [context.score];
  const limits = AUDIENCE_LIMITS[audience];
  if (response.explanation.length > limits.explanation)
    issues.push(`explanation is longer than ${limits.explanation} characters for the ${audience} audience`);
  if (response.facts.length > limits.facts) issues.push(`more than ${limits.facts} facts for the ${audience} audience`);
  if (response.interpretation.length > limits.interpretation)
    issues.push(`more than ${limits.interpretation} interpretation claims for the ${audience} audience`);

  const allPlayers = new Set(context.players.map((p) => p.id));
  const everything: Scope = { events: context.events, players: allPlayers, snapshotTimes: context.snapshots.map((s) => s.t) };
  const eventById = new Map(context.events.map((e) => [e.id, e]));
  const scopeOf = (claim: Claim): Scope => {
    const events = claim.evidence.flatMap((r) => (r.kind === "event" && eventById.has(r.id) ? [eventById.get(r.id)!] : []));
    // A snapshot shows every player; an event involves its player and recipient, or the whole team for a formation change.
    const snapshotTimes = claim.evidence.flatMap((r) => r.kind === "snapshot" ? [r.t] : []);
    if (snapshotTimes.length) return { events, players: allPlayers, snapshotTimes };
    const players = new Set<string>();
    for (const e of events) {
      if (e.playerId) players.add(e.playerId);
      if (e.recipientId) players.add(e.recipientId);
      if (e.type === "formation-change") for (const p of context.players) if (p.teamId === e.teamId) players.add(p.id);
      // The recorded description can name another player ("... wins the ball from #8 F. Lindqvist").
      for (const p of context.players) if (e.description.includes(p.name)) players.add(p.id);
    }
    return { events, players };
  };

  check(issues, "headline", response.headline, everything, context, scores, "all");
  check(issues, "explanation", response.explanation, everything, context, scores, "all");
  response.facts.forEach((c, i) => check(issues, `facts[${i}]`, c.text, scopeOf(c), context, scores, "all"));
  response.interpretation.forEach((c, i) => check(issues, `interpretation[${i}]`, c.text, scopeOf(c), context, scores, "all"));
  // Limitations say what is unknown ("whether the shot was saved"), so event wording is not checked there.
  response.limitations.forEach((l, i) => check(issues, `limitations[${i}]`, l, everything, context, scores, "none"));
  return issues;
}

/**
 * Every score the match passed through, from 0–0 to the score at the selected
 * time, rebuilt from the goal events in the evidence. A full-time summary may
 * mention any of them ("made it 1–0"). If a goal is missing from the evidence
 * the progression cannot be rebuilt, so only the current score is allowed.
 */
function scoreProgression(context: MatchContext): Score[] {
  const side = new Map(context.teams.map((t) => [t.id, t.side]));
  const scores: Score[] = [{ home: 0, away: 0 }];
  for (const e of context.events) {
    if (e.type !== "goal") continue;
    const last = scores.at(-1)!;
    scores.push(side.get(e.teamId) === "home" ? { home: last.home + 1, away: last.away } : { home: last.home, away: last.away + 1 });
  }
  const final = scores.at(-1)!;
  return final.home === context.score.home && final.away === context.score.away ? scores : [context.score];
}

function check(issues: string[], where: string, text: string, scope: Scope, context: MatchContext, scores: Score[], events: "all" | "none"): void {
  const selected = context.time.selectedMs;
  // Measurements define fixed screen thirds, not player-relative left/right
  // zones. A model must not invent that mapping from near-central coordinates.
  if (events !== "none" && /\b(?:left|right)[ -](?:side(?:d)?|half[ -]?space)\b/i.test(text))
    issues.push(`${where} uses a left/right zone label not defined by the supplied measurements; use a measured channel or omit the geography`);

  // Explicit clock/minute prose needs the same future boundary as seconds.
  // Requiring "at" avoids confusing scorelines or unrelated ratios with clocks.
  for (const m of text.matchAll(/\bat\s+(\d{1,3}):([0-5]\d)(?:\.(\d+))?\b/gi)) {
    const ms = (Number(m[1]) * 60 + Number(`${m[2]}.${m[3] ?? "0"}`)) * 1000;
    const tolerance = 500 / 10 ** (m[3]?.length ?? 0);
    const known = [...scope.events.flatMap((e) => e.startT === undefined ? [e.t] : [e.t, e.startT]), ...(scope.snapshotTimes ?? [])];
    const rounded = known.some((t) => t <= selected && Math.abs(t - ms) <= tolerance);
    if (ms > selected + 50 && !rounded) issues.push(`${where} mentions ${m[0]}, after the selected time`);
  }
  for (const m of text.matchAll(/\bminute\s+(\d+)\b/gi)) {
    if ((Number(m[1]) - 1) * 60_000 > selected) issues.push(`${where} mentions ${m[0]}, after the selected time`);
  }

  for (const m of text.matchAll(TIME)) {
    const ms = m[2]!.toLowerCase() === "ms" ? Number(m[1]) : Number(m[1]) * 1000;
    const prefix = text.slice(Math.max(0, m.index! - 60), m.index).toLowerCase();
    const suffix = text.slice(m.index! + m[0].length, m.index! + m[0].length + 15).toLowerCase();
    const duration = !/\bat\s+$/.test(prefix) && (/(?:took|takes|lasted|lasting|within|over|in|for|after|last|previous|duration(?: of)?|elapsed(?: time)?|approximately|about|roughly)\s+(?:(?:approximately|about|roughly|only|just)\s+)?$/.test(prefix) || /^\s+(?:later|earlier|apart|elapsed|after|before)\b/.test(suffix));
    const times = [...scope.events.flatMap((e) => e.startT !== undefined ? [e.t, e.startT] : [e.t]), ...(scope.snapshotTimes ?? [])];
    const decimals = m[1]!.split(".")[1]?.length ?? 0;
    const tolerance = m[2]!.toLowerCase() === "ms" ? 1 : 500 / 10 ** decimals;
    const roundedKnownTime = !duration && ms <= selected + tolerance && times.some((t) => t <= selected && Math.abs(t - ms) <= tolerance);
    if (ms > selected + 50 && !roundedKnownTime) issues.push(`${where} mentions ${m[0].trim()}, after the selected time (${selected / 1000} s)`);
    if (where.startsWith("facts[") || where.startsWith("interpretation[")) {
      if (duration) {
        // Whole-second prose may round by half a second; decimal times must
        // agree to their stated precision. Both endpoints must be cited.
        const citedIds = new Set(scope.events.map((e) => e.id));
        const windowClaim = /(?:last|previous)\s+$/.test(prefix);
        const measuredWindow = windowClaim && context.measurements?.patterns.some((p) => p.kind === "activity-change" && p.eventIds.length > 0 && p.eventIds.every((id) => citedIds.has(id)) && p.values.windowMs === ms);
        if (windowClaim ? !measuredWindow : !times.some((a) => times.some((b) => a !== b && Math.abs(Math.abs(a - b) - ms) <= tolerance)))
          issues.push(`${where} gives the duration ${m[0].trim()}, which is not supported by two cited time endpoints`);
      } else if (!times.some((t) => Math.abs(t - ms) <= tolerance)) {
        issues.push(`${where} gives the time ${m[0].trim()}, which matches nothing it cites`);
      }
    }
  }
  for (const m of text.matchAll(MINUTE)) {
    if ((Number(m[1]) - 1) * 60_000 > selected) issues.push(`${where} mentions the ${m[0].trim()}, after the selected time`);
  }

  const { home, away } = context.score;
  for (const m of text.matchAll(SCORE)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (!scores.some((s) => (a === s.home && b === s.away) || (a === s.away && b === s.home)))
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
  for (const w of EVENT_WORDS) {
    if (events === "none") continue;
    const m = text.match(w.pattern);
    if (!m || scope.events.some(w.supports)) continue;
    // The score shows a goal happened, even one before the evidence window that
    // cannot be cited, but only the headline and explanation may rely on it.
    // Facts and interpretation must cite the goal itself.
    if (w.label === "a goal" && summary && home + away > 0) continue;
    issues.push(`${where} says "${m[0]}", but the evidence it ${summary ? "has" : "cites"} contains no ${w.label.replace(/^an? /, "")}`);
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
