/**
 * "Explain this moment": verified facts.
 *
 * Code, not the model, states what the evidence shows. `buildFactCatalog`
 * turns the evidence package for the selected time into short factual
 * sentences, each with the citations it needs: what each recent event was,
 * who was involved and when, the measured interval between key events, shot
 * location, pass direction and length, which half play was in, possession
 * spells and opponent proximity. The analyst chooses among them and writes the
 * headline, explanation and any interpretation; every fact it gives must be
 * one of these, copied exactly (`checkFactsFromCatalog`).
 *
 * Every sentence is built from structured fields only, never from event
 * descriptions, and each must pass `validateExplanation` and `checkGrounding`
 * on its own, or it is left out. The package holds nothing after the selected
 * time, so neither does the catalog. Both audiences get the same catalog.
 */
import type { Focus } from "./api";
import type { ContextEvent, MatchContext } from "./context";
import { checkGrounding } from "./grounding";
import { EXPLANATION_VERSION, validateExplanation, type Claim, type EvidenceRef } from "./response";

export interface CatalogFact extends Claim {
  /** Stable within one evidence package: F1, F2, ... */
  id: string;
  /** This fact states the latest revealed event: a moment's explanation must include one such fact. */
  latest?: true;
}

const MAX_EVENT_FACTS = 8;
const MAX_FACTS = 24;
const HALF_LINE = 52.5;

const at = (t: number) => `${(t / 1000).toFixed(1)} s`;
const span = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const ref = (e: ContextEvent): EvidenceRef => ({ kind: "event", id: e.id });

/** Normalised for comparison: a copied fact may differ only in spacing, a final full stop or dash style. */
export const normalizeFact = (text: string) => text.trim().replace(/\s+/g, " ").replace(/[‐‑‒–—−]/g, "-").replace(/\.$/, "").toLowerCase();

/**
 * The events a moment's explanation must cover: every event revealed at the
 * latest recorded instant, except the bookkeeping turnover that shares its
 * timestamp with a recorded result (a save and the keeper's possession).
 */
export function latestEvents(context: MatchContext): ContextEvent[] {
  const revealed = context.events.filter((e) => e.t <= context.time.selectedMs);
  const last = revealed.at(-1);
  if (!last) return [];
  const now = revealed.filter((e) => e.t === last.t);
  const result = now.some((e) => e.type === "goal" || e.type === "shot-result");
  return now.filter((e) => !(result && e.type === "turnover"));
}

const possessive = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`);

export interface CatalogOptions {
  /** Describe only these events: no latest flags, intervals or position facts. For tool results. */
  only?: ContextEvent[];
  /** Prefix for fact ids; default "F". */
  idPrefix?: string;
}

export function buildFactCatalog(context: MatchContext, focus: Focus = "moment", options: CatalogOptions = {}): CatalogFact[] {
  const selected = context.time.selectedMs;
  const revealed = context.events.filter((e) => e.t <= selected);
  const team = new Map(context.teams.map((t) => [t.id, t]));
  const name = new Map(context.players.map((p) => [p.id, p.name]));
  const other = (teamId: string) => context.teams.find((t) => t.id !== teamId);
  const actor = (e: ContextEvent) => (e.playerId && name.get(e.playerId)) || team.get(e.teamId)?.name || "A player";
  const resolved = (shot: ContextEvent) => revealed.some((r) => (r.type === "goal" || r.type === "shot-result") && r.startT === shot.t && r.teamId === shot.teamId);
  const shotFor = (e: ContextEvent) => revealed.find((s) => s.type === "shot" && s.t === e.startT && s.playerId === e.playerId && s.teamId === e.teamId);
  const half = (e: ContextEvent) => {
    const own = team.get(e.teamId);
    if (!e.start || !own?.attacksTowards) return "";
    const inOwn = own.attacksTowards === "increasing-x" ? e.start.x < HALF_LINE : e.start.x > HALF_LINE;
    if (Math.abs(e.start.x - HALF_LINE) < 1) return "";
    const defending = inOwn ? own : other(e.teamId);
    return defending ? `, in ${possessive(defending.name)} half` : "";
  };
  /** The score straight after a goal: the score now, less the goals revealed after it. */
  const scoreAfter = (goal: ContextEvent) => {
    const s = { ...context.score };
    for (const g of revealed) if (g.type === "goal" && g.t > goal.t) s[team.get(g.teamId)?.side === "home" ? "home" : "away"]--;
    return `${s.home}–${s.away}`;
  };

  const candidates: Omit<CatalogFact, "id">[] = [];
  const add = (text: string, evidence: EvidenceRef[], latest = false) => candidates.push({ text, evidence, ...(latest ? { latest: true as const } : {}) });

  /** One sentence for an event, or null for one with nothing useful to say. */
  const describe = (e: ContextEvent): { text: string; evidence: EvidenceRef[] } | null => {
    const side = team.get(e.teamId)?.name ?? "";
    switch (e.type) {
      case "goal": {
        const shot = shotFor(e);
        return { text: `${actor(e)} scored for ${side} at ${at(e.t)}, making it ${scoreAfter(e)}.`, evidence: shot ? [ref(shot), ref(e)] : [ref(e)] };
      }
      case "shot": {
        const loc = context.measurements.shotLocations.find((l) => l.eventId === e.id);
        const where = loc ? `, ${loc.distanceToGoalM.toFixed(1)} m from goal${loc.insidePenaltyArea ? " inside the penalty area" : " outside the penalty area"}` : "";
        const result = e.outcome === "pending" && !resolved(e) ? "; its result is not yet known" : "";
        return { text: `${actor(e)} took a shot for ${side} at ${at(e.t)}${where}${result}.`, evidence: [ref(e)] };
      }
      case "shot-result": {
        const shot = shotFor(e);
        const by = shot ? `${possessive(actor(shot))} shot` : "";
        const what = e.outcome === "saved" ? "was saved" : e.outcome === "blocked" ? "was blocked" : e.outcome === "missed" ? "missed the target" : null;
        return what && shot ? { text: `${by} at ${at(shot.t)} ${what}.`, evidence: [ref(shot), ref(e)] } : null;
      }
      case "pass": {
        const to = e.recipientId && name.get(e.recipientId);
        const m = context.measurements.passes.find((p) => p.eventId === e.id);
        const gain = m?.forwardProgressM;
        const direction = gain == null ? "" : gain > 1 ? "forward " : gain < -1 ? "backward " : "";
        const length = m?.straightLineDistanceM == null ? "" : ` of ${m.straightLineDistanceM.toFixed(1)} m`;
        if (e.outcome === "complete" && to) return { text: `${actor(e)} played a ${direction}pass${length} to ${to} at ${at(e.t)}.`, evidence: [ref(e)] };
        if (e.outcome === "intercepted") return { text: `A pass by ${actor(e)} was intercepted at ${at(e.t)}.`, evidence: [ref(e)] };
        return null;
      }
      case "turnover": return { text: `${actor(e)} won the ball for ${side} at ${at(e.t)}${half(e)}.`, evidence: [ref(e)] };
      case "offside": return { text: `${e.playerId ? `${actor(e)} of ${side}` : side} was flagged offside at ${at(e.t)}.`, evidence: [ref(e)] };
      case "foul": return { text: `A foul by ${actor(e)} of ${side} was recorded at ${at(e.t)}${half(e)}.`, evidence: [ref(e)] };
      case "kickoff": return { text: `${side} kicked off at ${at(e.t)}.`, evidence: [ref(e)] };
      case "corner": return { text: `${side} took a corner at ${at(e.t)}.`, evidence: [ref(e)] };
      case "throw-in": return { text: `${side} took a throw-in at ${at(e.t)}.`, evidence: [ref(e)] };
      case "free-kick": return { text: `${side} took a free kick at ${at(e.t)}${half(e)}.`, evidence: [ref(e)] };
      case "goal-kick": return { text: `${side} took a goal kick at ${at(e.t)}.`, evidence: [ref(e)] };
      case "penalty": return { text: `${side} were awarded a penalty at ${at(e.t)}.`, evidence: [ref(e)] };
      case "deflection": return { text: `${e.playerId ? `${actor(e)} deflected the ball` : "The ball was deflected"} at ${at(e.t)}.`, evidence: [ref(e)] };
      case "formation-change": {
        const change = context.measurements.formationChanges.find((f) => f.eventId === e.id);
        return change ? { text: `${side} changed formation from ${change.from} to ${change.to} at ${at(e.t)}.`, evidence: [ref(e)] } : null;
      }
      default: return null;
    }
  };

  const latest = latestEvents(context);
  if (options.only) {
    for (const e of options.only) {
      const d = describe(e);
      if (d) add(d.text, d.evidence, false);
    }
  } else if (focus === "match") {
    // Every key event the summary package holds, in order: goals, shots and their results first if space runs short.
    const key = revealed.filter((x) => x.type !== "pass" && x.type !== "turnover");
    const ranked = [...key.filter((x) => ["goal", "shot", "shot-result"].includes(x.type)), ...key.filter((x) => !["goal", "shot", "shot-result"].includes(x.type))];
    for (const e of ranked.slice(0, MAX_FACTS).sort((a, b) => a.t - b.t)) {
      const d = describe(e);
      if (d) add(d.text, d.evidence, false);
    }
  } else {
    // The latest events first, then earlier ones, newest first.
    const recent = [...revealed].reverse().filter((x) => !latest.includes(x)).slice(0, MAX_EVENT_FACTS);
    for (const e of [...latest, ...recent]) {
      const d = describe(e);
      if (d) add(d.text, d.evidence, latest.includes(e));
    }

    // Intervals: from the latest turnover or kickoff to each later key event, named exactly.
    const words: Partial<Record<ContextEvent["type"], string>> = { shot: "shot", goal: "goal", offside: "offside", foul: "foul", corner: "corner", "shot-result": "" };
    const start = [...revealed].reverse().find((e) => e.type === "turnover" || e.type === "kickoff");
    if (start) {
      const from = start.type === "turnover" ? `${team.get(start.teamId)?.name ?? "the team"} won the ball` : "the kickoff";
      const passes = (to: ContextEvent) => revealed.filter((p) => p.type === "pass" && p.outcome === "complete" && p.teamId === start.teamId && p.t > start.t && p.t < to.t);
      for (const e of revealed.filter((x) => x.t > start.t && words[x.type])) {
        const chain = passes(e);
        const between = start.type === "turnover" && chain.length > 0 && chain.length <= 5 ? `, with ${chain.length} completed pass${chain.length === 1 ? "" : "es"} in between` : "";
        const cites = between ? [ref(start), ...chain.map(ref), ref(e)] : [ref(start), ref(e)];
        if (e.type === "goal") {
          const shot = shotFor(e);
          if (shot && !cites.some((c) => c.kind === "event" && c.id === shot.id)) cites.splice(cites.length - 1, 0, ref(shot));
        }
        add(`The ${words[e.type]} came ${span(e.t - start.t)} after ${from}${between}.`, cites);
      }
    }

    // Possession: the latest spell, as sampled.
    const spell = context.measurements.possessionSpells.at(-1);
    const spellTeam = spell && team.get(spell.teamId);
    if (spell && spellTeam && spell.durationMs >= 1_000)
      add(`${spellTeam.name} had the ball for ${span(spell.durationMs)} in the sampled positions, from ${at(spell.fromMs)} to ${at(spell.toMs)}.`, spell.cite);

    // Opponents near the player on the ball, at one snapshot.
    const near = context.measurements.proximity;
    const holder = near && name.get(near.playerId);
    if (near && holder) {
      const within = near.opponentsWithin.map((w) => `${w.count} within ${w.radiusM} m`).join(", ");
      const nearest = near.nearestOpponentM == null ? "" : `; the nearest was ${near.nearestOpponentM.toFixed(1)} m away`;
      add(`With ${holder} on the ball at ${at(near.snapshotT)}, opponents nearby: ${within}${nearest}.`, [{ kind: "snapshot", t: near.snapshotT }]);
    }
  }

  // Keep only facts that pass the same checks as any answer, each on its own.
  const out: CatalogFact[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (out.length >= MAX_FACTS || seen.has(normalizeFact(c.text))) continue;
    const probe = {
      explanationVersion: EXPLANATION_VERSION, matchId: context.match.matchId, timeMs: selected, status: "explained" as const,
      headline: "Recorded fact", explanation: c.text, facts: [{ text: c.text, evidence: c.evidence }], interpretation: [], limitations: [],
    };
    if (!validateExplanation(probe, context).ok || checkGrounding(probe, context, "analyst", focus).length > 0) continue;
    seen.add(normalizeFact(c.text));
    out.push({ id: `${options.idPrefix ?? "F"}${out.length + 1}`, ...c });
  }
  return out;
}

const sameEvidence = (a: EvidenceRef[], b: EvidenceRef[]) => {
  const key = (r: EvidenceRef) => (r.kind === "event" ? `e:${r.id}` : `s:${r.t}`);
  const x = new Set(a.map(key));
  return a.length === b.length && b.every((r) => x.has(key(r)));
};

/** The catalog fact a claim copies, text and evidence alike. */
export function catalogMatch(claim: Claim, catalog: CatalogFact[]): CatalogFact | undefined {
  const text = normalizeFact(claim.text);
  return catalog.find((f) => normalizeFact(f.text) === text && sameEvidence(f.evidence, claim.evidence));
}

/**
 * Every fact must be a catalog fact, copied exactly, and an explained moment
 * must include the latest event's fact when the catalog has one.
 */
export function checkFactsFromCatalog(response: { status: string; facts: Claim[] }, catalog: CatalogFact[], focus: Focus = "moment"): string[] {
  if (response.status !== "explained") return [];
  const issues: string[] = [];
  response.facts.forEach((f, i) => {
    if (!catalogMatch(f, catalog))
      issues.push(`facts[${i}] is not one of verifiedFacts; copy a verified fact's text and evidence exactly, or remove it`);
  });
  const used = new Set(response.facts.map((f) => catalogMatch(f, catalog)?.id));
  const missing = focus === "moment" ? catalog.filter((f) => f.latest && !used.has(f.id)) : [];
  if (missing.length > 0)
    issues.push(`facts must include the verified fact about the latest recorded event (${missing.map((f) => f.id).join(", ")}): the explanation is about this moment`);
  return issues;
}
