/**
 * "Recap": the few moments that shaped a finished match, chosen by rules in
 * code rather than by a model, so the same match always gives the same cards.
 *
 * Unlike the rest of playback this reads the whole match. The viewer only
 * shows the recap once playback has reached full time.
 */
import type { EventType, MatchEvent, MatchFixture } from "@/match/contract";

/** How much each kind of event shapes a result. Unlisted types never make the recap. */
const WEIGHT: Partial<Record<EventType, number>> = {
  goal: 10,
  penalty: 6,
  "formation-change": 4,
  shot: 2,
  offside: 1.5,
  foul: 1,
  corner: 1,
  "free-kick": 1,
  turnover: 1,
};

/** Picks closer together than this describe the same passage of play (a shot and its goal). */
const SAME_PASSAGE_MS = 3_000;

const weightOf = (e: MatchEvent): number => (e.type === "shot-result" ? (e.outcome === "saved" ? 3 : 0) : (WEIGHT[e.type] ?? 0));

/** Up to `max` defining moments of the whole match, oldest first: goals, then the next most significant events. */
export function recapMoments(fixture: MatchFixture, max = 3): MatchEvent[] {
  const ranked = fixture.events
    .filter((e) => e.t <= fixture.durationMs && weightOf(e) > 0)
    .sort((a, b) => weightOf(b) - weightOf(a) || a.t - b.t);
  const picked: MatchEvent[] = [];
  for (const e of ranked) {
    if (picked.length >= max) break;
    if (picked.some((p) => Math.abs(p.t - e.t) < SAME_PASSAGE_MS)) continue;
    picked.push(e);
  }
  return picked.sort((a, b) => a.t - b.t);
}
