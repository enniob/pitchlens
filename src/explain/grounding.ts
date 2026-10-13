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
 *     window no longer contains. Negated wording ("no shots") names no event.
 *   - a duration between two named kinds of event ("the goal came 6.4 s after
 *     the turnover") that no such pair of events in its evidence spans
 *   - a pass called forward or backward against its recorded direction, or
 *     an event placed in a team's half where its recorded position is not
 *   - a left/right label for a side, half-space, touchline, flank or wing,
 *     which the measurements do not define
 *   - a count of filtered events of one type; the evidence gives only a total
 *   - wording too long or too dense for the requested audience
 *
 * Limitations get the time, score, player and filtered-count checks, but not
 * the event ones.
 *
 * They are heuristics: passing them does not prove the text is supported, and
 * the word lists are deliberately narrow so that ordinary football language
 * ("a shot on goal", "the corner of the box") is not rejected.
 */
import type { Score } from "@/match/contract";
import type { Audience, Focus } from "./api";
import type { ContextEvent, MatchContext } from "./context";
import type { Claim, ExplanationResponse } from "./response";
import { WRITTEN_TIME as TIME, writtenTimeMs, isElapsedTime as isDuration } from "./timeText";

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
  { label: "a penalty", pattern: /\bpenalty\b(?![\s-]+(?:areas?|box(?:es)?|spots?)\b)/i, supports: (e) => e.type === "penalty" },
  { label: "a corner", pattern: /\bcorner(\s+kick)?s?\b(?!\s+(of|flag))/i, supports: (e) => e.type === "corner" },
  { label: "a throw-in", pattern: /\bthrow-?ins?\b/i, supports: (e) => e.type === "throw-in" },
  {
    label: "a save",
    pattern: /\b(saves|saved|parried|parries)\b|\b(a|the)\s+save\b/i,
    supports: (e) => (e.type === "shot-result" && e.outcome === "saved") || e.type === "deflection",
  },
];

// Not a shirt number followed by an initial, as event descriptions name players ("#6 S. Okafor").
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
  if (events !== "none" && /\b(?:left|right)[ -](?:side(?:d)?|half[ -]?space|touchline|flank|wing)\b/i.test(text))
    issues.push(`${where} uses a left/right zone label not defined by the supplied measurements; use a measured channel or omit the geography`);
  // The evidence reports one total for filtered events of mixed types ("events of other types, such as ordinary passes").
  const filtered = text.match(FILTERED_COUNT);
  if (filtered) issues.push(`${where} says "${filtered[0]}", but the evidence gives only a total of filtered events of mixed types; say "${filtered[1]} other events" or omit the count`);
  if (events !== "none") {
    checkIntervals(issues, where, text, scope, context);
    checkGeography(issues, where, text, scope, context);
    checkPossession(issues, where, text, scope, context);
  }

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
    const ms = writtenTimeMs(m);
    if (!Number.isFinite(ms)) { issues.push(`${where} gives a malformed time ${m[0].trim()}`); continue; }
    const prefix = text.slice(Math.max(0, m.index! - 60), m.index).toLowerCase();
    const duration = isDuration(text, m);
    const times = [...scope.events.flatMap((e) => e.startT !== undefined ? [e.t, e.startT] : [e.t]), ...(scope.snapshotTimes ?? [])];
    const decimals = m[1]!.split(".")[1]?.length ?? 0;
    const tolerance = m[3]!.toLowerCase() === "ms" ? 1 : 500 / 10 ** decimals;
    const roundedKnownTime = !duration && ms <= selected + tolerance && times.some((t) => t <= selected && Math.abs(t - ms) <= tolerance);
    if (ms > selected + 50 && !roundedKnownTime) issues.push(`${where} mentions ${m[0].trim()}, after the selected time (${selected / 1000} s)`);
    if (where.startsWith("facts[") || where.startsWith("interpretation[")) {
      if (duration) {
        // Whole-second prose may round by half a second; decimal times must
        // agree to their stated precision. Both endpoints must be cited.
        const citedIds = new Set(scope.events.map((e) => e.id));
        const windowClaim = /(?:last|previous)\s+$/.test(prefix);
        const measuredWindow = windowClaim && context.measurements?.patterns.some((p) => p.kind === "activity-change" && p.eventIds.length > 0 && p.eventIds.every((id) => citedIds.has(id)) && p.values.windowMs === ms);
        // A possession spell's duration comes from every snapshot in it, not two cited times; the claim must cite the spell's own endpoints.
        const citedSnapshots = new Set(scope.snapshotTimes ?? []);
        const measuredSpell = context.measurements?.possessionSpells?.some((sp) => Math.abs(sp.durationMs - ms) <= tolerance &&
          sp.cite.every((ref) => ref.kind === "event" ? citedIds.has(ref.id) : citedSnapshots.has(ref.t)));
        if (!measuredSpell && (windowClaim ? !measuredWindow : !times.some((a) => times.some((b) => a !== b && Math.abs(Math.abs(a - b) - ms) <= tolerance))))
          issues.push(`${where} gives the duration ${m[0].trim()}, which is not supported by two cited time endpoints${windowClaim ? "" : durationHint(context, scope, ms, tolerance)}`);
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
    if (!m || scope.events.some(w.supports) || negated(text, m.index!)) continue;
    // The score shows a goal happened, even one before the evidence window that
    // cannot be cited, but only the headline and explanation may rely on it.
    // Facts and interpretation must cite the goal itself.
    if (w.label === "a goal" && summary && home + away > 0) continue;
    issues.push(`${where} says "${m[0]}", but the evidence it ${summary ? "has" : "cites"} contains no ${w.label.replace(/^an? /, "")}${summary ? "" : shotHint(w.label, scope, context)}`);
  }
}

/**
 * "No shots", "without a shot", "before any goal": the wording names a kind of
 * event without saying one happened. Whether the absence is shown is left to
 * the verifier, as for any other statement about the window.
 */
const negated = (text: string, index: number) =>
  /\b(?:no|not|without|zero|neither|nor|never|any)\s+(?:\w+\s+){0,2}$/i.test(text.slice(Math.max(0, index - 40), index));

const FILTERED_COUNT =
  /\b(\d+)\s+(?:ordinary\s+|other\s+|routine\s+)?(?:pass(?:es)?|turnovers?|throw-?ins?|tackles?|touches)\b[^.;]*?\b(?:filtered|omitted|left out|excluded|not (?:listed|shown|included))\b/i;

/**
 * Kinds of event a duration can be measured between, and the times each
 * event contributes. A goal counts at the moment it is recorded, not when the
 * shot was struck: "the goal came 6.4 s after the turnover" needs the goal.
 */
const ENDPOINTS: { kind: string; pattern: RegExp; times: (e: ContextEvent) => number[] }[] = [
  { kind: "goal", pattern: /\b(goal|scored|scores|scoring|net)\b/i, times: (e) => (e.type === "goal" ? [e.t] : []) },
  {
    kind: "shot",
    pattern: /\b(shot|shots|shoots|strike|struck)\b/i,
    times: (e) => (e.type === "shot" ? [e.t] : (e.type === "goal" || e.type === "shot-result") && e.startT !== undefined ? [e.startT] : []),
  },
  {
    kind: "turnover",
    pattern: /\b(turnover|(?:won|wins|winning|regain\w*|recover\w*) (?:the )?(?:ball|possession)|intercept\w*)\b/i,
    times: (e) => (e.type === "turnover" ? [e.t] : []),
  },
  { kind: "pass", pattern: /\bpass(es|ed)?\b/i, times: (e) => (e.type === "pass" ? (e.startT !== undefined ? [e.startT, e.t] : [e.t]) : []) },
  { kind: "kickoff", pattern: /\b(kick-?off|restart\w*)\b/i, times: (e) => (e.type === "kickoff" ? [e.t] : []) },
  { kind: "offside", pattern: /\boffside\b/i, times: (e) => (e.type === "offside" ? [e.t] : []) },
];

/**
 * A duration in a clause naming two or more kinds of event must be spanned by
 * a pair of those kinds in the evidence. Each duration is judged on its own
 * clause, bounded by commas, semicolons, "and", "while" and "then" and by
 * other times. A clause naming only one kind is left to the endpoint check.
 */
function checkIntervals(issues: string[], where: string, text: string, scope: Scope, context: MatchContext): void {
  for (const sentence of sentencesOf(text)) {
    const times = [...sentence.matchAll(TIME)];
    const breaks = [...sentence.matchAll(/,|;|\b(?:and|while|then)\b/gi)].map((b) => b.index!)
      .filter((b) => !times.some((m) => b > m.index! && b < m.index! + m[0].length));
    times.forEach((m, i) => {
      if (!isDuration(sentence, m)) return;
      const previous = i === 0 ? 0 : times[i - 1]!.index! + times[i - 1]![0].length;
      const next = i === times.length - 1 ? sentence.length : times[i + 1]!.index!;
      const from = Math.max(previous, ...breaks.filter((b) => b < m.index!));
      const to = Math.min(next, ...breaks.filter((b) => b > m.index!));
      const clause = sentence.slice(from, to);
      const kinds = ENDPOINTS.filter((k) => k.pattern.test(clause));
      if (kinds.length < 2) return;
      const ms = writtenTimeMs(m);
      const tolerance = m[3]!.toLowerCase() === "ms" ? 1 : 500 / 10 ** (m[2]?.length ?? 0);
      const at = (k: (typeof ENDPOINTS)[number]) => scope.events.filter((e) => e.t <= context.time.selectedMs).flatMap(k.times);
      const spanned = kinds.some((a, x) => kinds.some((b, y) => x < y && at(a).some((ta) => at(b).some((tb) => Math.abs(Math.abs(ta - tb) - ms) <= tolerance))));
      if (!spanned)
        issues.push(`${where} gives ${m[0].trim()} between a ${kinds.map((k) => k.kind).join(", ")}, but no such pair of events in the evidence it ${where === "headline" || where === "explanation" ? "has" : "cites"} is that far apart; state the interval between the events it is actually measured between`);
    });
  }
}

/** Sentences, without splitting after a player's initial ("S. Okafor"). */
const sentencesOf = (text: string) => text.split(/(?<!\b[A-Z]\.)(?<=[.!?;])\s+/);

/** Possession duration comes from sampled spells, never a convenient gap between events. */
function checkPossession(issues: string[], where: string, text: string, scope: Scope, context: MatchContext): void {
  const cited = new Set(scope.events.map((e) => e.id));
  const snapshots = new Set(scope.snapshotTimes ?? []);
  const claim = where.startsWith("facts[") || where.startsWith("interpretation[");
  for (const sentence of sentencesOf(text)) {
    if (!/\bpossession\b/i.test(sentence)) continue;
    const spellClaim = /\bpossession\s+(?:spell|run|sequence|that|lasting|lasted|for|began)|\bspell\b/i.test(sentence);
    if (!spellClaim && !/\b(?:ended|ending|stopped|halted|terminated)\b/i.test(sentence)) continue;
    // A supplied event can occur during a spell without being its end or cause.
    if (/\b(?:offside|goal|shot|foul|kickoff|kick-off)\b/i.test(sentence) && /\b(?:ended|ending|stopped|halted|terminated)\b/i.test(sentence))
      issues.push(`${where} attributes a possession spell's end to an event; the supplied spells do not establish event causes, so state the recorded event separately`);
    const spells = (context.measurements.possessionSpells ?? []).filter((sp) =>
      (!claim || sp.cite.every((r) => r.kind === "event" ? cited.has(r.id) : snapshots.has(r.t))) &&
      !context.teams.some((team) => team.id !== sp.teamId && [team.name, team.shortName, team.name.replace(/\s+\S+$/, "")].some((name) => name && sentence.includes(name))));
    if (/\b(?:ended|ending|stopped|halted|terminated)\b/i.test(sentence) && !/\b(?:not|never|hasn't|hadn't)\b/i.test(sentence) &&
      !spells.some((sp) => sp.end !== "ongoing"))
      issues.push(`${where} says a possession spell ended, but no cited spell records an end; describe the sampled spell without extending its boundary`);
    for (const m of sentence.matchAll(TIME)) {
      if (!isDuration(sentence, m)) continue;
      const ms = writtenTimeMs(m);
      const tolerance = m[3]!.toLowerCase() === "ms" ? 1 : 500 / 10 ** (m[2]?.length ?? 0);
      if (!spells.some((sp) => Math.abs(sp.durationMs - ms) <= tolerance))
        issues.push(`${where} gives a possession duration not supported by a cited possession spell; copy durationMs and cite the spell's cite list, or omit the duration`);
    }
  }
}

const HALF_LINE = 52.5;
/** Whether x is in the half a team defends, from the direction it attacks. */
const inOwnHalf = (attacksTowards: string | undefined, x: number) => (attacksTowards === "increasing-x" ? x < HALF_LINE : x > HALF_LINE);

/**
 * Directions and halves checked against recorded positions: a pass called
 * forward or backward, and play placed in a named team's half.
 */
function checkGeography(issues: string[], where: string, text: string, scope: Scope, context: MatchContext): void {
  const sign = new Map(context.teams.map((t) => [t.id, t.attacksTowards === "increasing-x" ? 1 : -1]));
  const claim = where.startsWith("facts[") || where.startsWith("interpretation[");
  const surname = new Map(context.players.map((p) => [p.id, p.name.split(/\s+/).pop()!]));
  const at = (id: string | undefined, sentence: string) => (id && surname.has(id) ? sentence.search(new RegExp(`\\b${escape(surname.get(id)!)}\\b`)) : -1);
  // A claim's passes are the ones it cites. The headline and explanation cite nothing, so a sentence
  // there is about the passes whose passer and then recipient it names ("Novak ... to Haddad").
  for (const sentence of claim ? [text] : sentencesOf(text)) {
    if (!/\bpass(es|ed)?\b/i.test(sentence)) continue;
    const passes = scope.events.filter((e) => e.type === "pass" && e.start && e.end && sign.has(e.teamId) && e.t <= context.time.selectedMs &&
      (claim || (at(e.playerId, sentence) >= 0 && at(e.playerId, sentence) < at(e.recipientId, sentence))));
    const gains = passes.map((e) => (e.end!.x - e.start!.x) * sign.get(e.teamId)!);
    if (gains.length === 0) continue;
    const whose = claim ? "the passes it cites" : "the pass it names";
    if (/\b(forward|upfield|progress\w*|advanc\w*)\b/i.test(sentence) && gains.every((g) => g < -1))
      issues.push(`${where} calls play forward, but ${whose} moved backward, away from the goal their team attacks`);
    if (/\b(backwards?|back pass)\b/i.test(sentence) && gains.every((g) => g > 1))
      issues.push(`${where} calls play backward, but ${whose} moved forward, towards the goal their team attacks`);
  }
  for (const sentence of sentencesOf(text)) {
    for (const team of context.teams) {
      // "Harbor City FC" is also "Harbor City"; "Northvale Rovers" also "Northvale".
      const names = [team.name, team.shortName, team.name.replace(/\s+\S+$/, "")].filter((n): n is string => Boolean(n)).map(escape);
      if (!new RegExp(`\\b(?:${names.join("|")})(?:'s|’s|s'|’)?\\s+(?:own\\s+)?half\\b`, "i").test(sentence)) continue;
      // The events the sentence is about: those of the kinds it names, or every event in scope.
      const kinds = ENDPOINTS.filter((k) => k.pattern.test(sentence));
      const about = scope.events.filter((e) => e.start && e.t <= context.time.selectedMs && (kinds.length === 0 || kinds.some((k) => k.times(e).length > 0)));
      if (about.length > 0 && about.every((e) => !inOwnHalf(team.attacksTowards, e.start!.x)))
        issues.push(`${where} places play in ${team.name}'s half, but the recorded positions of the events it ${claim ? "cites" : "describes"} are in the other half`);
    }
  }
}

/*
 * Hints for the revision request: which supplied events would support the
 * wording if cited. They only name events already in the context (so never
 * anything after the selected time) and do not change what passes.
 */
const clock = (t: number) => `${Number((t / 1000).toFixed(2))} s`;

/** A shot result or goal cites its outcome; the shot itself starts at its startT, by the same player. */
function shotHint(label: string, scope: Scope, context: MatchContext): string {
  if (label !== "a shot") return "";
  const shots = context.events.filter((e) => e.type === "shot" && e.t <= context.time.selectedMs &&
    scope.events.some((c) => c.startT === e.t && c.playerId === e.playerId));
  return shots.length ? `; also cite the shot event ${shots.map((e) => e.id).join(", ")} in this claim, or do not mention the shot` : "";
}

/**
 * The one supplied event that, with an event the claim already cites, spans
 * the duration. Never a pair the claim does not anchor, nor a guess between
 * several candidates: either could fit the number by coincidence.
 */
function durationHint(context: MatchContext, scope: Scope, ms: number, tolerance: number): string {
  const generic = "; cite both events it is measured between in this claim, or remove the duration";
  const points = context.events.flatMap((e) => (e.startT !== undefined ? [{ id: e.id, t: e.t }, { id: e.id, t: e.startT }] : [{ id: e.id, t: e.t }]))
    .filter((p) => p.t <= context.time.selectedMs);
  const cited = new Set(scope.events.map((e) => e.id));
  const pairs: { anchor: (typeof points)[number]; other: (typeof points)[number] }[] = [];
  for (const anchor of points.filter((p) => cited.has(p.id)))
    for (const other of points)
      if (!cited.has(other.id) && Math.abs(Math.abs(other.t - anchor.t) - ms) <= tolerance) pairs.push({ anchor, other });
  // Exactly one pair: one uncited event fitting several cited anchors is as ambiguous as several events.
  if (pairs.length !== 1) return generic;
  const { anchor, other } = pairs[0]!;
  return `; it matches ${anchor.id} (${clock(anchor.t)}) to ${other.id} (${clock(other.t)}): also cite ${other.id} in this claim, or remove the duration`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
