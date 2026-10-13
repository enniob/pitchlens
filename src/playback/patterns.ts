import { PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PITCH_LENGTH, PITCH_WIDTH, type MatchEvent, type Team } from "@/match/contract";
import { measurePasses, type PassMeasurement } from "./derivedEvidence";

/** Measurements describe recorded events, never pressure, intention or cause. */
export interface MeasuredPattern {
  id: string;
  kind: "turnover-to-shot" | "repeated-flank" | "activity-change";
  teamId: string;
  fromMs: number;
  toMs: number;
  eventIds: string[];
  summary: string;
  /** Units and boundaries are explicit so consumers never infer a metric. */
  values: Record<string, number | string>;
}

export interface EventMeasurements {
  fromMs: number;
  toMs: number;
  coverage: "complete-window" | "retained-events-only";
  statistics: TeamWindowStatistics[];
  patterns: MeasuredPattern[];
  shotLocations: ShotLocation[];
  /** Geometry and timing of the latest resolved passes; see ./derivedEvidence.ts. */
  passes: PassMeasurement[];
  /** Resolved passes in the window not measured in `passes`, to bound the payload. */
  passesOmittedOlder: number;
}

/** Counts of resolved events in [fromMs, toMs], never whole-match totals unless the window starts at 0. */
export interface TeamWindowStatistics {
  teamId: string;
  shots: number;
  /** Resolved passes of any outcome (complete, intercepted, missed). A pass still in flight is not counted. */
  attemptedPasses: number;
  completedPasses: number;
  /**
   * completedPasses / attemptedPasses as a whole percentage, over this window only.
   * `null` without attempts, or for `retained-events-only` coverage, where missing
   * passes would make the ratio wrong.
   */
  completionPercent: number | null;
  goals: number;
  /** Every shot, goal and pass counted above. */
  eventIds: string[];
}

/** Strike-position geometry only; never shot outcome, destination or quality. */
export interface ShotLocation {
  eventId: string;
  /** Straight-line distance from the shot start to the attacking goal centre, rounded to 0.1 m. */
  distanceToGoalM: number;
  /** Shot start lies inside the attacking penalty area, boundaries inclusive. */
  insidePenaltyArea: boolean;
  /** Fixed screen thirds across the pitch: top y < 68/3 m, bottom y > 136/3 m. */
  channel: "central" | "top-outer-third" | "bottom-outer-third";
}

function shotLocation(e: MatchEvent & { start: NonNullable<MatchEvent["start"]> }, attacksTowards: Team["attacksTowards"]): ShotLocation {
  const goalX = attacksTowards === "increasing-x" ? PITCH_LENGTH : 0;
  const depth = Math.abs(goalX - e.start.x);
  const offset = e.start.y - PITCH_WIDTH / 2;
  return {
    eventId: e.id,
    distanceToGoalM: Math.round(Math.hypot(depth, offset) * 10) / 10,
    insidePenaltyArea: depth <= PENALTY_AREA_DEPTH && e.start.x >= 0 && e.start.x <= PITCH_LENGTH
      && e.start.y >= PITCH_WIDTH / 2 - PENALTY_AREA_HALF_WIDTH && e.start.y <= PITCH_WIDTH / 2 + PENALTY_AREA_HALF_WIDTH,
    channel: e.start.y < PITCH_WIDTH / 3 ? "top-outer-third" : e.start.y > PITCH_WIDTH * 2 / 3 ? "bottom-outer-third" : "central",
  };
}

/**
 * Pure, stateless derivation; callers specify whether their event window is
 * complete. Filtered/truncated windows yield retained-event counts only, not
 * comparisons or sequences which could hide an intervening interruption.
 */
export function measureEvents(
  input: readonly MatchEvent[], teams: readonly Pick<Team, "id" | "attacksTowards">[],
  selectedMs: number, fromMs = Math.max(0, selectedMs - 30_000), complete = true,
): EventMeasurements {
  const events = input.filter((e) => e.t >= fromMs && e.t <= selectedMs);
  const statistics = teams.map(({ id }): TeamWindowStatistics => {
    const counted = events.filter((e) => e.teamId === id && (e.type === "shot" || e.type === "goal" || e.type === "pass"));
    const attemptedPasses = counted.filter((e) => e.type === "pass").length;
    const completedPasses = counted.filter((e) => e.type === "pass" && e.outcome === "complete").length;
    return { teamId: id, shots: counted.filter((e) => e.type === "shot").length, attemptedPasses, completedPasses,
      completionPercent: complete && attemptedPasses > 0 ? Math.round(completedPasses / attemptedPasses * 100) : null,
      goals: counted.filter((e) => e.type === "goal").length, eventIds: counted.map((e) => e.id) };
  });
  const patterns: MeasuredPattern[] = [];
  if (complete) {
    let chain: MatchEvent[] = [];
    for (const e of events) {
      if (e.type === "turnover" && e.outcome === "won") chain = [e];
      else if (chain.length && e.teamId === chain[0]!.teamId && e.type === "pass" && e.outcome === "complete") chain.push(e);
      else if (chain.length && e.teamId === chain[0]!.teamId && e.type === "shot") {
        const first = chain[0]!;
        patterns.push({ id: `sequence:${first.id}:${e.id}`, kind: "turnover-to-shot", teamId: e.teamId,
          fromMs: first.t, toMs: e.t, eventIds: [...chain, e].map((x) => x.id),
          summary: `Shot ${(e.t - first.t) / 1000} s after a turnover won, with ${chain.length - 1} completed passes.`,
          values: { elapsedMs: e.t - first.t, completedPasses: chain.length - 1 } });
        chain = [];
      } else if (e.type !== "formation-change") chain = [];
    }
    // Keep the two latest complete sequences; all their supporting events remain supplied.
    patterns.splice(0, Math.max(0, patterns.length - 2));
    const flankFrom = Math.max(fromMs, selectedMs - 30_000);
    for (const team of teams) {
      for (const flank of ["low-y", "high-y"] as const) {
        const qualifying = events.filter((e) => {
          if (e.t < flankFrom || e.teamId !== team.id || !e.start) return false;
          if (e.type !== "shot" && !(e.type === "pass" && e.outcome === "complete")) return false;
          const attackingHalf = team.attacksTowards === "increasing-x" ? e.start.x >= PITCH_LENGTH / 2 : e.start.x <= PITCH_LENGTH / 2;
          return attackingHalf && (flank === "low-y" ? e.start.y < PITCH_WIDTH / 3 : e.start.y > PITCH_WIDTH * 2 / 3);
        });
        if (qualifying.length >= 3) patterns.push({ id: `flank:${team.id}:${flank}`, kind: "repeated-flank", teamId: team.id,
          fromMs: flankFrom, toMs: selectedMs, eventIds: qualifying.map((e) => e.id),
          summary: `${qualifying.length} completed passes or shots started in the attacking half's ${flank === "low-y" ? "top" : "bottom"} outer third.`,
          values: { actions: qualifying.length, flank, xBoundaryM: PITCH_LENGTH / 2, yBoundaryM: flank === "low-y" ? PITCH_WIDTH / 3 : PITCH_WIDTH * 2 / 3 } });
      }
      // Equal adjacent windows; exclude the shared boundary from the later
      // count. Do not compare a partial opening window with a full one.
      const windowMs = 5_000;
      const start = selectedMs - 2 * windowMs;
      const middle = selectedMs - windowMs;
      if (start < fromMs) continue;
      const qualifying = events.filter((e) => e.teamId === team.id && e.t > start && (e.type === "shot" || (e.type === "pass" && e.outcome === "complete")));
      const count = (type: "shot" | "pass", recent: boolean) => qualifying.filter((e) => e.type === type && (recent ? e.t > middle : e.t <= middle)).length;
      const previousShots = count("shot", false), recentShots = count("shot", true);
      const previousPasses = count("pass", false), recentPasses = count("pass", true);
      if (qualifying.length && (previousShots !== recentShots || previousPasses !== recentPasses)) patterns.push({
        id: `activity:${team.id}`, kind: "activity-change", teamId: team.id, fromMs: start, toMs: selectedMs,
        eventIds: qualifying.map((e) => e.id),
        summary: `Last 5 s versus previous 5 s: ${recentShots} vs ${previousShots} shots; ${recentPasses} vs ${previousPasses} completed passes.`,
        values: { windowMs, boundaryMs: middle, previousShots, recentShots, previousPasses, recentPasses, intervalRule: "(fromMs, boundaryMs], (boundaryMs, toMs]" },
      });
    }
  }
  // Per-event geometry needs no surrounding events, so retained partial windows keep it.
  const shotLocations = events.flatMap((e) => {
    const team = teams.find((x) => x.id === e.teamId);
    return e.type === "shot" && e.start && team ? [shotLocation({ ...e, start: e.start }, team.attacksTowards)] : [];
  });
  // Like shot locations, each pass is measured from its own event alone.
  const { passes, omittedOlder: passesOmittedOlder } = measurePasses(events, teams);
  return { fromMs, toMs: selectedMs, coverage: complete ? "complete-window" : "retained-events-only", statistics, patterns, shotLocations, passes, passesOmittedOlder };
}
