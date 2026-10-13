/**
 * Independent assessment of one explanation against an evaluation scenario.
 *
 * It deliberately does not reuse `checkGrounding`: it is a second, separate
 * oracle, and reports on three separate levels:
 *
 *   1. blockers: deterministic release blockers. The response fails the
 *      contract, cites evidence that does not exist or is later than the
 *      selected time, is for the wrong match, time or audience, or its text
 *      contains a later event ID, time, score or formation.
 *   2. leaks: sentences stating a scenario's forbidden future fact (a shot's
 *      result while it is in flight, an offside not yet flagged...), unless
 *      the same sentence says it is unknown. Wording heuristics: in a live run
 *      they flag answers for human review.
 *   3. unsupported: claims whose wording goes beyond the evidence they cite
 *      (event kinds, shot results, times, players, scores, formations,
 *      invented metrics). Also heuristics; a passing claim is not proven true.
 *
 * Valid JSON and resolvable citations are necessary, not sufficient: a
 * response can pass `validateExplanation` and still be flagged here.
 * `quality` then separates a safe response from a usable explanation.
 */
import type { Audience, ExplainSuccess, VerificationSummary } from "@/explain/api";
import type { MatchContext } from "@/explain/context";
import { EVENT_TYPES, EvidenceSession } from "@/explain/evidence";
import { validateExplanation, type Claim, type ExplanationResponse } from "@/explain/response";
import { FORMATION_IDS, type EventType, type MatchFixture, type Score } from "@/match/contract";
import { formationsAt, scoreAt } from "@/playback/derive";
import type { EvalScenario } from "./scenarios";

export type Quality =
  /** A release blocker was found. */
  | "unsafe"
  /** Safe by the deterministic checks, but wording was flagged as a possible leak or unsupported claim. */
  | "needs-review"
  /** An explanation covering every expected fact, with nothing flagged. */
  | "usable"
  /** An explanation with nothing flagged that misses an expected fact. */
  | "incomplete"
  /** Insufficient evidence where the scenario accepts it as an honest answer. */
  | "honest-insufficient"
  /** Insufficient evidence (or the fallback) where the evidence supports an explanation: safe, not useful. */
  | "not-explained";

export interface Assessment {
  blockers: string[];
  leaks: string[];
  unsupported: string[];
  expected: { covered: string[]; missing: string[] };
  status: ExplanationResponse["status"] | "invalid";
  quality: Quality;
}

const UNCERTAIN =
  /\b(not (yet )?(known|shown|recorded|available|clear|visible|included|in the (data|evidence))|unknown|unclear|whether|if it|cannot (be )?(tell|told|say|confirm|determine|know)|can't (tell|say)|no (result|outcome)|yet to|pending|does not (show|say|include)|doesn't (show|say|include)|outside the evidence)\b/i;
// Not a shirt number followed by an initial ("#6 S. Okafor").
const TIME = /(?<![#\d.])(\d+(?:\.(\d+))?)\s*(ms|s|secs?|[sS]econds?)\b/g;
const SCORE = /(?<![\d.\-–])(\d{1,2})\s?[–-]\s?(\d{1,2})(?![\d\-–])/g;
const NUMBER = /#(\d{1,3})\b/g;
const FORMATION = new RegExp(`(?<![\\d-])(${FORMATION_IDS.map((f) => f.replace(/-/g, "\\-")).join("|")})(?![\\d-])`, "g");

/** Wording that says a kind of event happened, and the event types that support it in a claim's citations. */
const EVENT_WORDING: { label: string; pattern: RegExp; types: EventType[] }[] = [
  { label: "a goal", pattern: /\b(goal!|scores|scored|scoring|equali[sz]\w*|own goal|opening goal|winning goal)\b/i, types: ["goal"] },
  {
    label: "a shot result",
    pattern: /\b(into the (net|goal)|in the net|went in|goes in|crossed the (goal ?)?line|beat the (keeper|goalkeeper)|saved|parried|missed|went wide|goes wide|wide of|over the bar|hit the (post|bar|crossbar|woodwork)|(on|off) target)\b/i,
    types: ["goal", "shot-result", "deflection"],
  },
  { label: "a shot", pattern: /\b(shot|shoots|shooting)\b/i, types: ["shot", "shot-result", "goal", "penalty"] },
  { label: "a pass", pattern: /\bpass(es|ed)?\b/i, types: ["pass", "throw-in", "corner", "free-kick", "goal-kick", "kickoff", "offside"] },
  { label: "an offside", pattern: /\boffside\b(?!\s+(line|trap|position))/i, types: ["offside"] },
  { label: "a foul", pattern: /\bfoul(ed|s)?\b/i, types: ["foul", "free-kick", "penalty"] },
  { label: "a corner", pattern: /\bcorner(\s+kick)?s?\b(?!\s+(of|flag))/i, types: ["corner"] },
  { label: "a throw-in", pattern: /\bthrow-?ins?\b/i, types: ["throw-in"] },
  { label: "a formation change", pattern: /\b(switch(es|ed)?|chang(e|es|ed))\b[^.]*\b(formation|shape|system)\b|\b(formation|shape) change\b/i, types: ["formation-change"] },
];
/** The data has none of these; any claim stating them invents it. */
const INVENTED = /\b(xG|expected goals?|PPDA|pressing intensity|pressure (index|metric|rating)|tired|fatigued?|exhausted|confident|frustrat\w*|nervous)\b|\d+(\.\d+)?\s?(km\/h|mph)/i;
/** Percentages and speeds, allowed only when they repeat a supplied measurement. */
const MEASURED_UNIT = /(\d+(?:\.\d+)?)\s?(%|m\/s)/gi;

/**
 * Everything the analyst could have been shown: the default package, every
 * event the tools could list and every snapshot they could return. Citations
 * outside this are fabricated or later than the selected time.
 */
export function reachableContext(fixture: MatchFixture, timeMs: number, focus: EvalScenario["focus"]): MatchContext {
  const key = `${fixture.matchId}|${timeMs}|${focus}`;
  let hit = reachableCache.get(key);
  if (!hit) reachableCache.set(key, (hit = buildReachable(fixture, timeMs, focus)));
  return hit;
}
const reachableCache = new Map<string, MatchContext>();

function buildReachable(fixture: MatchFixture, timeMs: number, focus: EvalScenario["focus"]): MatchContext {
  const session = new EvidenceSession(fixture, timeMs, focus);
  for (const type of EVENT_TYPES) session.call("list_events", JSON.stringify({ types: [type] }));
  const ctx = session.context();
  const snapshots = fixture.snapshots
    .filter((s) => s.t >= session.floorMs && s.t <= ctx.time.selectedMs)
    .map((s) => ({ t: s.t, ball: s.ball, possession: null, players: [] }));
  return { ...ctx, snapshots };
}

/** Scores reached up to and after `t`, from the fixture's goal events. */
function scoreline(fixture: MatchFixture, t: number): { upTo: Score[]; after: Score[] } {
  const upTo: Score[] = [{ ...fixture.startingState.score }];
  const after: Score[] = [];
  for (const e of fixture.events) {
    if (e.type !== "goal") continue;
    const s = scoreAt(fixture, e.t);
    (e.t <= t ? upTo : after).push(s);
  }
  return { upTo, after };
}

const sameScore = (a: number, b: number) => (s: Score) => (a === s.home && b === s.away) || (a === s.away && b === s.home);
const sentences = (text: string) => text.split(/(?<=[.!?;])\s+/).filter(Boolean);

export interface AssessInput {
  scenario: EvalScenario;
  audience: Audience;
  /** The explanation as received; may be anything. */
  explanation: unknown;
  verification?: VerificationSummary;
  /** The HTTP envelope, when the answer came through the endpoint. */
  envelope?: Pick<ExplainSuccess, "matchId" | "timeMs" | "audience" | "focus">;
}

export function assess({ scenario, audience, explanation, verification, envelope }: AssessInput): Assessment {
  const { fixture, focus } = scenario;
  const selected = Math.floor(scenario.timeMs);
  const blockers: string[] = [];
  const leaks: string[] = [];
  const unsupported: string[] = [];
  const evidence = reachableContext(fixture, selected, focus);

  if (envelope) {
    if (envelope.matchId !== fixture.matchId) blockers.push(`answer is for match ${envelope.matchId}`);
    if (envelope.timeMs !== selected) blockers.push(`answer is for ${envelope.timeMs} ms, not ${selected} ms`);
    if (envelope.audience !== audience) blockers.push(`answer is for the ${envelope.audience} audience`);
    if (envelope.focus !== focus) blockers.push(`answer is a ${envelope.focus} answer`);
  }
  const valid = validateExplanation(explanation, evidence);
  if (!valid.ok) {
    blockers.push(...valid.errors.map((e) => `contract/citations: ${e}`));
    return { blockers, leaks, unsupported, expected: { covered: [], missing: scenario.expected.map((x) => x.label) }, status: "invalid", quality: "unsafe" };
  }
  const r = valid.response;
  if (verification) {
    const explained = verification.outcome === "verified" || verification.outcome === "revised";
    if (explained !== (r.status === "explained")) blockers.push(`outcome ${verification.outcome} with status ${r.status}`);
    if (explained && (verification.schema !== "passed" || verification.grounding !== "passed" || verification.modelReview !== "passed"))
      blockers.push(`outcome ${verification.outcome} without every check passing`);
  }

  // Whole-text checks: future IDs, times, scores and formations are release blockers wherever they appear.
  const futureIds = fixture.events.filter((e) => e.t > selected).map((e) => e.id);
  const { upTo, after } = scoreline(fixture, selected);
  const allowedScores = focus === "match" ? upTo : [scoreAt(fixture, selected)];
  const active = new Set<string>();
  for (const f of formationsAt(fixture, 0) ?? []) active.add(f.formation);
  for (const c of fixture.tactics?.applied ?? []) if (c.t <= selected) active.add(c.to);
  const future = new Set<string>((fixture.tactics?.applied ?? []).filter((c) => c.t > selected && !active.has(c.to)).map((c) => c.to));

  const texts: { where: string; text: string; claim?: Claim; fact?: boolean }[] = [
    { where: "headline", text: r.headline },
    { where: "explanation", text: r.explanation },
    ...r.facts.map((c, i) => ({ where: `facts[${i}]`, text: c.text, claim: c, fact: true })),
    ...r.interpretation.map((c, i) => ({ where: `interpretation[${i}]`, text: c.text, claim: c })),
    ...r.limitations.map((l, i) => ({ where: `limitations[${i}]`, text: l })),
  ];
  const players = new Map(evidence.players.map((p) => [p.id, p]));
  const measured = evidence.measurements;
  const percents = new Set(measured.statistics.flatMap((s) => s.completionPercent === null ? [] : [s.completionPercent]));
  const speeds = new Set([...measured.passes.map((p) => p.averageStraightLineSpeedMps), ...measured.movement.map((x) => x.averageSampledPathSpeedMps)]
    .filter((v): v is number => v !== null));
  const events = new Map(evidence.events.map((e) => [e.id, e]));

  for (const { where, text, claim, fact } of texts) {
    const cited = claim ? claim.evidence.flatMap((ref) => (ref.kind === "event" && events.has(ref.id) ? [events.get(ref.id)!] : [])) : evidence.events;
    const snapshotTimes = claim ? claim.evidence.flatMap((ref) => (ref.kind === "snapshot" ? [ref.t] : [])) : evidence.snapshots.map((s) => s.t);
    for (const id of futureIds) if (text.includes(id)) blockers.push(`${where} names later event ${id}`);
    for (const m of text.matchAll(TIME)) {
      const ms = m[3]!.toLowerCase() === "ms" ? Number(m[1]) : Number(m[1]) * 1000;
      const precision = m[3]!.toLowerCase() === "ms" ? 1 : 500 / 10 ** (m[2]?.length ?? 0);
      const before = text.slice(Math.max(0, m.index! - 60), m.index).toLowerCase();
      const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 15).toLowerCase();
      const elapsed = !/\bat\s+$/.test(before) && (/(?:took|takes|lasted|lasting|within|over|in|for|after|last|previous|duration(?: of)?|elapsed(?: time)?|approximately|about|roughly)\s+(?:(?:approximately|about|roughly|only|just)\s+)?$/.test(before) || /^\s+(?:later|earlier|apart|elapsed|after|before)\b/.test(after));
      const known = [...cited.flatMap((e) => e.startT === undefined ? [e.t] : [e.t, e.startT]), ...snapshotTimes];
      const roundedKnownTime = !elapsed && ms <= selected + precision && known.some((t) => t <= selected && Math.abs(t - ms) <= precision);
      if (ms > selected + 50 && !roundedKnownTime) blockers.push(`${where} mentions ${m[0].trim()}, after the selected time`);
    }
    for (const m of text.matchAll(SCORE)) {
      const is = sameScore(Number(m[1]), Number(m[2]));
      if (allowedScores.some(is)) continue;
      if (after.some(is)) blockers.push(`${where} mentions ${m[0]}, a later score`);
      else unsupported.push(`${where} mentions the score ${m[0]}, which the match never had by then`);
    }
    for (const m of text.matchAll(FORMATION)) {
      if (future.has(m[1]!)) blockers.push(`${where} mentions ${m[1]}, a formation not used until later`);
      else if (!active.has(m[1]!)) unsupported.push(`${where} mentions ${m[1]}, a formation neither team used`);
    }
    if (where.startsWith("limitations")) continue;

    for (const s of sentences(text))
      for (const f of scenario.forbidden) if (f.pattern.test(s) && !UNCERTAIN.test(s)) leaks.push(`${where} states ${f.label}: "${s.slice(0, 120)}"`);
    if (INVENTED.test(text)) unsupported.push(`${where} states a metric or attribute the data does not have ("${text.match(INVENTED)![0]}")`);
    for (const m of text.matchAll(MEASURED_UNIT)) {
      const supplied = m[2] === "%" ? percents : speeds;
      if (!supplied.has(Number(m[1]))) unsupported.push(`${where} states a metric or attribute the data does not have ("${m[0]}")`);
    }

    // Claim-level support: what the claim says must be in what it cites. Headline and explanation are
    // checked against everything reachable.
    for (const w of EVENT_WORDING) {
      const m = text.match(w.pattern);
      // A cited event's own description also supports its wording ("Shot on target by ...").
      if (!m || UNCERTAIN.test(text) || cited.some((e) => w.types.includes(e.type) || w.pattern.test(e.description))) continue;
      // A goal before the evidence window still counts in the score shown for the headline and explanation.
      if (!claim && w.label === "a goal" && (scoreAt(fixture, selected).home + scoreAt(fixture, selected).away > 0)) continue;
      unsupported.push(`${where} says "${m[0]}" but cites no ${w.label.replace(/^an? /, "")}`);
    }
    if (claim) {
      const seesAll = snapshotTimes.length > 0;
      const involved = new Set<string>();
      for (const e of cited) {
        if (e.playerId) involved.add(e.playerId);
        if (e.recipientId) involved.add(e.recipientId);
        if (e.type === "formation-change") for (const p of players.values()) if (p.teamId === e.teamId) involved.add(p.id);
        // "... wins the ball from #8 F. Lindqvist": the description names the other player too.
        for (const p of players.values()) if (e.description.includes(p.name)) involved.add(p.id);
      }
      for (const m of text.matchAll(NUMBER)) {
        const n = Number(m[1]);
        const wearing = [...players.values()].filter((p) => p.number === n);
        if (wearing.length === 0) unsupported.push(`${where} mentions #${n}, which no player wears`);
        else if (!seesAll && !wearing.some((p) => involved.has(p.id))) unsupported.push(`${where} mentions #${n}, who is not in its cited events`);
      }
      for (const p of players.values()) {
        const surname = p.name.split(/\s+/).pop()!;
        if (surname.length < 3 || seesAll || !new RegExp(`\\b${surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) continue;
        if (![...players.values()].some((q) => q.name.endsWith(surname) && involved.has(q.id)))
          unsupported.push(`${where} names ${surname}, who is not in its cited events`);
      }
      // A time stated in a fact should be the time of something it cites, to the precision it is written.
      {
        const times = [...cited.flatMap((e) => (e.startT !== undefined ? [e.t, e.startT] : [e.t])), ...snapshotTimes];
        for (const m of text.matchAll(TIME)) {
          const ms = m[3]!.toLowerCase() === "ms" ? Number(m[1]) : Number(m[1]) * 1000;
          const tolerance = m[3]!.toLowerCase() === "ms" ? 1 : 500 / 10 ** (m[2]?.length ?? 0);
          const before = text.slice(Math.max(0, m.index! - 60), m.index).toLowerCase();
          const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 15).toLowerCase();
          const elapsed = !/\bat\s+$/.test(before) && (/(?:took|takes|lasted|lasting|within|over|in|for|after|last|previous|duration(?: of)?|elapsed(?: time)?|approximately|about|roughly)\s+(?:(?:approximately|about|roughly|only|just)\s+)?$/.test(before) || /^\s+(?:later|earlier|apart|elapsed|after|before)\b/.test(after));
          if (elapsed) {
            const intervals = times.flatMap((start) => times.filter((end) => end !== start).map((end) => Math.abs(end - start)));
            const ids = new Set(cited.map((e) => e.id));
            const windowClaim = /(?:last|previous)\s+$/.test(before);
            const window = windowClaim && evidence.measurements?.patterns.some((p) => p.kind === "activity-change" && p.eventIds.length && p.eventIds.every((id) => ids.has(id)) && p.values.windowMs === ms);
            const cites = new Set(snapshotTimes);
            const spell = evidence.measurements?.possessionSpells?.some((sp) => Math.abs(sp.durationMs - ms) <= tolerance && sp.cite.every((ref) => ref.kind === "event" ? ids.has(ref.id) : cites.has(ref.t)));
            if (!spell && (windowClaim ? !window : !intervals.some((value) => Math.abs(value - ms) <= tolerance))) unsupported.push(`${where} gives the duration ${m[0].trim()}, without cited endpoints supporting it`);
          } else if (!times.some((t) => Math.abs(t - ms) <= tolerance)) unsupported.push(`${where} gives the time ${m[0].trim()}, which matches nothing it cites`);
        }
      }
    }
  }

  const claims = [...r.facts, ...r.interpretation];
  const allText = texts.map((t) => t.text).join(" ");
  const covered: string[] = [];
  const missing: string[] = [];
  for (const x of scenario.expected) {
    const byCitation = claims.some((c) =>
      c.evidence.some((ref) => ref.kind === "event" && (x.eventIds?.includes(ref.id) || (x.eventTypes ?? []).includes(events.get(ref.id)?.type as EventType))),
    );
    (byCitation || (x.mention?.test(allText) ?? false) ? covered : missing).push(x.label);
  }

  const shown = r.status === "explained";
  let quality: Quality;
  if (blockers.length > 0) quality = "unsafe";
  else if (shown && (leaks.length > 0 || unsupported.length > 0)) quality = "needs-review";
  else if (shown) quality = missing.length === 0 ? "usable" : "incomplete";
  else quality = scenario.insufficientEvidence === "acceptable" ? "honest-insufficient" : "not-explained";
  return { blockers, leaks, unsupported, expected: { covered, missing }, status: r.status, quality };
}
