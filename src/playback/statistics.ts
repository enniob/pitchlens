import type { MatchFixture, TeamSide } from "@/match/contract";
import { clampTime } from "./derive";

export interface TeamStatistics {
  possessionMs: number;
  possessionPercent: number | null;
  completedPasses: number;
  shots: number;
  saves: number;
  goals: number;
}

export type MatchStatistics = Record<TeamSide, TeamStatistics>;

/** Totals for this sequence up to t; no future results or prior-match totals. */
export function statisticsAt(fixture: MatchFixture, t: number): MatchStatistics {
  const time = clampTime(fixture, Number.isFinite(t) ? t : 0);
  const empty = (): TeamStatistics => ({ possessionMs: 0, possessionPercent: null, completedPasses: 0, shots: 0, saves: 0, goals: 0 });
  const stats: MatchStatistics = { home: empty(), away: empty() };
  const sides = new Map(fixture.teams.map((team) => [team.id, team.side]));
  // A snapshot's possession holds until the next snapshot, including reset cuts.
  for (let i = 0; i < fixture.snapshots.length; i++) {
    const snapshot = fixture.snapshots[i]!;
    if (snapshot.t >= time) break;
    const end = Math.min(time, fixture.snapshots[i + 1]?.t ?? fixture.durationMs);
    const side = snapshot.possession && sides.get(snapshot.possession.teamId);
    if (side) stats[side].possessionMs += end - snapshot.t;
  }
  const controlled = stats.home.possessionMs + stats.away.possessionMs;
  if (controlled > 0) {
    stats.home.possessionPercent = Math.round(stats.home.possessionMs / controlled * 100);
    stats.away.possessionPercent = 100 - stats.home.possessionPercent;
  }
  for (const event of fixture.events) {
    if (event.t > time) break;
    const side = sides.get(event.teamId);
    if (!side) continue;
    if (event.type === "pass" && event.outcome === "complete") stats[side].completedPasses++;
    if (event.type === "shot") stats[side].shots++;
    if (event.type === "goal") stats[side].goals++;
    if (event.type === "shot-result" && event.outcome === "saved") {
      stats[side === "home" ? "away" : "home"].saves++;
    }
  }
  return stats;
}
