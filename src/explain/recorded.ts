import type { Focus } from "./api";
import type { MatchContext } from "./context";
import { AUDIENCE_LIMITS, checkGrounding } from "./grounding";
import { EXPLANATION_VERSION, validateExplanation, type Claim, type ExplanationResponse } from "./response";

/** The recorded account for a request: the latest event for a moment, the goals and shots for a full-time summary. */
export function recordedAccount(context: MatchContext, focus: Focus = "moment"): ExplanationResponse | null {
  return focus === "match" ? recordedMatchSummary(context) : recordedSummary(context);
}

/** A factual account assembled from bounded evidence, never from model text. */
export function recordedSummary(context: MatchContext): ExplanationResponse | null {
  const latest = context.events.at(-1);
  // A save and the keeper gaining possession can share a timestamp. Prefer
  // the recorded result over the bookkeeping turnover at that same instant.
  const event = [...context.events].reverse().find(e => e.t === latest?.t && (e.type === "goal" || e.type === "shot-result")) ?? latest;
  if (!event || event.t > context.time.selectedMs) return null;
  const team = context.teams.find(t => t.id === event.teamId);
  if (!team) return null;
  const actor = context.players.find(p => p.id === event.playerId)?.name ?? team.name;
  const recipient = context.players.find(p => p.id === event.recipientId)?.name;
  let headline: string;
  let action: string;
  switch (event.type) {
    case "goal": headline = "Goal recorded"; action = `${actor} scored for ${team.name}.`; break;
    case "shot": headline = "Shot recorded"; action = `${actor} took a shot for ${team.name}.`; break;
    case "shot-result":
      if (event.outcome === "saved") { headline = "Save recorded"; action = `A save against ${team.name} was recorded.`; }
      else if (event.outcome === "blocked") { headline = "Blocked effort"; action = `${team.name}'s effort was blocked.`; }
      else if (event.outcome === "missed") { headline = "Missed effort"; action = `A missed result was recorded for ${team.name}.`; }
      else return null;
      break;
    case "foul": headline = "Foul recorded"; action = `A foul by ${actor} was recorded.`; break;
    case "offside": headline = "Offside recorded"; action = `An offside against ${team.name} was recorded.`; break;
    case "penalty": headline = "Penalty recorded"; action = `A penalty for ${team.name} was recorded.`; break;
    case "free-kick": headline = "Free kick recorded"; action = `${team.name} took a free kick.`; break;
    case "corner": headline = "Corner recorded"; action = `${team.name} took a corner.`; break;
    case "throw-in": headline = "Throw-in recorded"; action = `${team.name} took a throw-in.`; break;
    case "goal-kick": headline = "Goal kick recorded"; action = `${team.name} took a goal kick.`; break;
    case "kickoff": headline = "Kick-off recorded"; action = `${team.name} kicked off.`; break;
    case "turnover": headline = "Possession changed"; action = `${team.name} won possession.`; break;
    case "deflection": headline = "Deflection recorded"; action = `A deflection by ${actor} was recorded.`; break;
    case "formation-change": {
      const formation = context.formations?.find(f => f.teamId === team.id && f.changeEventId === event.id);
      if (!formation) return null;
      headline = "Formation changed"; action = `${team.name} changed to ${formation.formation}.`; break;
    }
    case "pass":
      if (event.outcome === "complete" && recipient) {
        headline = "Completed pass"; action = `${actor} completed a pass to ${recipient}.`;
      } else { headline = "Pass recorded"; action = `A pass by ${actor} was recorded.`; }
      break;
    default: return null;
  }
  const facts: Claim[] = [{ text: action, evidence: [{ kind: "event", id: event.id }] }];
  if (event.type === "goal") {
    facts.push({ text: `The score is ${context.score.home}–${context.score.away}.`, evidence: [{ kind: "event", id: event.id }] });
  }
  const shot = (event.type === "goal" || event.type === "shot-result") && context.events.find(e =>
    e.type === "shot" && e.t < event.t && e.t === event.startT && e.playerId === event.playerId && e.teamId === event.teamId);
  if (shot) facts.push({ text: "A shot was recorded before this result.",
    evidence: [{ kind: "event", id: shot.id }, { kind: "event", id: event.id }] });
  const summary: ExplanationResponse = {
    explanationVersion: EXPLANATION_VERSION, matchId: context.match.matchId, timeMs: context.time.selectedMs,
    status: "explained", headline, explanation: facts.map(f => f.text).join(" "), facts,
    interpretation: [], limitations: [],
  };
  // The same contract and grounding checks apply. Never return a best guess.
  const validation = validateExplanation(summary, context);
  const issues = checkGrounding(summary, context, "casual");
  return validation.ok && issues.length === 0
    ? summary : null;
}

const seconds = (t: number) => `${(t / 1000).toFixed(1)} s`;

/**
 * A full-time account from the match's key events: the final score (headline
 * and explanation only, as no event can be cited for it) and each recorded
 * goal, then the latest shots, as facts. It states no totals: a truncated
 * key-event package would make a count wrong.
 */
export function recordedMatchSummary(context: MatchContext): ExplanationResponse | null {
  const home = context.teams.find(t => t.side === "home");
  const away = context.teams.find(t => t.side === "away");
  if (!home || !away) return null;
  const maxFacts = AUDIENCE_LIMITS.casual.facts;
  const revealed = context.events.filter(e => e.t <= context.time.selectedMs);
  const goals = revealed.filter(e => e.type === "goal");
  const shots = revealed.filter(e => e.type === "shot").slice(-Math.max(0, maxFacts - goals.length));
  const facts: Claim[] = [...goals, ...shots].sort((a, b) => a.t - b.t).slice(-maxFacts).flatMap(e => {
    const team = context.teams.find(t => t.id === e.teamId);
    if (!team) return [];
    const actor = context.players.find(p => p.id === e.playerId)?.name ?? team.name;
    const text = e.type === "goal" ? `${actor} scored for ${team.name} at ${seconds(e.t)}.` : `${actor} took a shot for ${team.name} at ${seconds(e.t)}.`;
    return [{ text, evidence: [{ kind: "event" as const, id: e.id }] }];
  });
  if (facts.length === 0) return null;
  const result = `Full time: ${home.name} ${context.score.home}–${context.score.away} ${away.name}.`;
  const summary: ExplanationResponse = {
    explanationVersion: EXPLANATION_VERSION, matchId: context.match.matchId, timeMs: context.time.selectedMs,
    status: "explained", headline: result.slice(0, -1), explanation: [result, ...facts.map(f => f.text)].join(" "), facts,
    interpretation: [], limitations: [],
  };
  return validateExplanation(summary, context).ok && checkGrounding(summary, context, "casual", "match").length === 0
    ? summary : null;
}
