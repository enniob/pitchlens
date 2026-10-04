/**
 * Extra figures for the "Pro data" view. Every number is read or computed
 * directly from fixture data (event start/end positions and times, player
 * IDs and formation assignments); nothing is estimated or invented. Like the
 * statistics, totals only count events with a timestamp ≤ t.
 */
import { PITCH_LENGTH, PITCH_WIDTH, type MatchEvent, type MatchFixture, type TeamSide } from "@/match/contract";
import { clampTime, formationsAt } from "./derive";

export interface ProStatistics {
  passesCompleted: number;
  passesAttempted: number;
  /** Completed / attempted, 0–100, or null before any pass. */
  passCompletion: number | null;
  /** Mean length of completed passes in metres, or null before any. */
  averagePassLength: number | null;
  /** Goals scored by a player (not own goals) plus shots the goalkeeper saved. */
  shotsOnTarget: number;
  /** Times the team won the ball back. */
  ballsWon: number;
}

const length = (e: MatchEvent) => (e.start && e.end ? Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y) : null);

export function proStatisticsAt(fixture: MatchFixture, t: number): Record<TeamSide, ProStatistics> {
  const time = clampTime(fixture, Number.isFinite(t) ? t : 0);
  const empty = (): ProStatistics => ({
    passesCompleted: 0,
    passesAttempted: 0,
    passCompletion: null,
    averagePassLength: null,
    shotsOnTarget: 0,
    ballsWon: 0,
  });
  const out: Record<TeamSide, ProStatistics> = { home: empty(), away: empty() };
  const lengths: Record<TeamSide, number[]> = { home: [], away: [] };
  const sides = new Map(fixture.teams.map((team) => [team.id, team.side]));
  for (const e of fixture.events) {
    if (e.t > time) break;
    const side = sides.get(e.teamId);
    if (!side) continue;
    const s = out[side];
    if (e.type === "pass") {
      s.passesAttempted++;
      if (e.outcome === "complete") {
        s.passesCompleted++;
        const l = length(e);
        if (l !== null) lengths[side].push(l);
      }
    }
    if (e.type === "goal" && e.playerId) s.shotsOnTarget++;
    if (e.type === "shot-result" && e.outcome === "saved") s.shotsOnTarget++;
    if (e.type === "turnover") s.ballsWon++;
  }
  for (const side of ["home", "away"] as const) {
    const s = out[side];
    if (s.passesAttempted > 0) s.passCompletion = Math.round((s.passesCompleted / s.passesAttempted) * 100);
    if (lengths[side].length > 0) s.averagePassLength = lengths[side].reduce((a, b) => a + b, 0) / lengths[side].length;
  }
  return out;
}

/** Third of the pitch from the acting team's point of view. */
export function pitchZone(x: number, attacksTowards: "increasing-x" | "decreasing-x"): string {
  const depth = attacksTowards === "increasing-x" ? x : PITCH_LENGTH - x;
  if (depth < PITCH_LENGTH / 3) return "own third";
  if (depth < (PITCH_LENGTH * 2) / 3) return "middle third";
  return "attacking third";
}

/**
 * Short data chips for one event in the Pro feed, e.g. "18.4 m",
 * "1.7 s travel", "RCM #8 → ST #9". Position labels come from the formation
 * active when the event happened, so they are omitted for fixtures without
 * formation data.
 */
export function proChips(fixture: MatchFixture, e: MatchEvent): string[] {
  const chips: string[] = [];
  const team = fixture.teams.find((x) => x.id === e.teamId);
  const formations = formationsAt(fixture, e.t);
  const who = (playerId: string | undefined) => {
    if (!playerId) return null;
    const p = fixture.roster.find((x) => x.id === playerId);
    if (!p) return null;
    const slot = formations?.find((f) => f.teamId === p.teamId)?.assignments[p.id];
    return slot ? `${slot} #${p.number}` : `#${p.number}`;
  };
  const travel = e.startT !== undefined ? `${((e.t - e.startT) / 1000).toFixed(1)} s travel` : null;

  if (e.type === "pass") {
    const l = length(e);
    if (l !== null) chips.push(`${l.toFixed(1)} m`);
    if (travel) chips.push(travel);
    const from = who(e.playerId);
    const to = who(e.recipientId);
    if (from && to) chips.push(`${from} → ${to}`);
  } else if (e.type === "shot" && e.start && team) {
    const goalX = team.attacksTowards === "increasing-x" ? PITCH_LENGTH : 0;
    chips.push(`${Math.hypot(goalX - e.start.x, PITCH_WIDTH / 2 - e.start.y).toFixed(1)} m from goal`);
    const by = who(e.playerId);
    if (by) chips.push(by);
  } else if (e.type === "goal" || e.type === "shot-result") {
    if (travel) chips.push(travel);
    if (e.end) chips.push(`at ${e.end.z.toFixed(1)} m high`);
  } else if (e.type === "formation-change") {
    const change = fixture.tactics?.applied.find((c) => c.eventId === e.id);
    if (change) {
      const moved = Object.keys(change.assignments).filter((id) => change.assignments[id] !== change.previousAssignments[id]).length;
      chips.push(`${moved} of ${Object.keys(change.assignments).length} change position`);
    }
  } else {
    if (e.start && team) chips.push(pitchZone(e.start.x, team.attacksTowards));
    const by = who(e.playerId);
    if (by) chips.push(by);
  }
  chips.push(e.id);
  return chips;
}
