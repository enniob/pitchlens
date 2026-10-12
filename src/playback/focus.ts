import type { MatchEvent, MatchFixture } from "@/match/contract";

/** A match-scoped viewing preference; never changes model evidence or its cutoff. */
export interface MatchFocus { teamId: string | null; playerId: string | null }
export const ALL_MATCH: MatchFocus = { teamId: null, playerId: null };

export function normalizeFocus(fixture: MatchFixture, focus: MatchFocus): MatchFocus {
  const teamId = fixture.teams.some((t) => t.id === focus.teamId) ? focus.teamId : null;
  const player = fixture.roster.find((p) => p.id === focus.playerId && (!teamId || p.teamId === teamId));
  return { teamId, playerId: player?.id ?? null };
}

/** An intercepted pass names an intended recipient, not an observed reception. */
export function eventMatchesFocus(event: MatchEvent, focus: MatchFocus): boolean {
  if (focus.teamId && event.teamId !== focus.teamId) return false;
  return !focus.playerId || event.playerId === focus.playerId ||
    (event.type === "pass" && event.outcome === "complete" && event.recipientId === focus.playerId);
}

export function focusStatisticsAt(fixture: MatchFixture, timeMs: number, focus: MatchFocus) {
  const valid = normalizeFocus(fixture, focus);
  const events = fixture.events.filter((e) => e.t <= Math.max(0, Math.min(timeMs, fixture.durationMs)) && eventMatchesFocus(e, valid));
  return {
    shots: events.filter((e) => e.type === "shot").length,
    goals: events.filter((e) => e.type === "goal").length,
    passesCompleted: events.filter((e) => e.type === "pass" && e.outcome === "complete" && (!valid.playerId || e.playerId === valid.playerId)).length,
    receptions: events.filter((e) => e.type === "pass" && e.outcome === "complete" && e.recipientId === valid.playerId).length,
  };
}
