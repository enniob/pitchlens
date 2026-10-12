import type { MatchEvent } from "@/match/contract";

/** A short trail of a completed pass, never a preview of the next action. */
export function completedPassAt(events: readonly MatchEvent[], timeMs: number): MatchEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.t > timeMs) continue;
    // Stop at the latest observed action: a later turnover or shot clears it.
    if (event.type !== "pass" || event.outcome !== "complete" || !event.start || !event.end
      || timeMs - event.t > 1800
      || Math.hypot(event.end.x - event.start.x, event.end.y - event.start.y) < 0.5) return null;
    return event;
  }
  return null;
}
