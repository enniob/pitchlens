/**
 * Pure functions deriving what is visible at simulation time `t` from a
 * fixture. Everything shown on screen — positions, score, event history — is
 * computed from the fixture's starting state plus data with timestamps ≤ t, so
 * nothing from the future can leak and any time can be reproduced exactly.
 */
import type { MatchEvent, MatchFixture, PlayerState, Possession, Score, Snapshot, Vec3 } from "@/match/contract";

export interface PlaybackFrame {
  timeMs: number;
  players: PlayerState[];
  ball: Vec3;
  possession: Possession | null;
  score: Score;
  /** Events whose timestamp has been reached, oldest first. */
  events: MatchEvent[];
}

/** Index of the last element with key ≤ t, or -1. Arrays must be sorted by key. */
function lastAtOrBefore<T>(items: readonly T[], t: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]!) <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** Interpolate angles along the shortest arc. */
function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * k;
}

const playerIndexCache = new WeakMap<Snapshot, Map<string, PlayerState>>();
function playersById(s: Snapshot): Map<string, PlayerState> {
  let m = playerIndexCache.get(s);
  if (!m) {
    m = new Map(s.players.map((p) => [p.playerId, p]));
    playerIndexCache.set(s, m);
  }
  return m;
}

export function clampTime(fixture: MatchFixture, t: number): number {
  return Math.min(fixture.durationMs, Math.max(0, t));
}

/**
 * Interpolated positions at time t. Never interpolates into a snapshot marked
 * as a discontinuity: the previous snapshot holds until the reset instant.
 */
export function positionsAt(
  fixture: MatchFixture,
  t: number,
): Pick<PlaybackFrame, "players" | "ball" | "possession"> {
  const snaps = fixture.snapshots;
  if (snaps.length === 0) throw new Error("Fixture has no snapshots; validate it before playback");
  const time = clampTime(fixture, t);
  const i = Math.max(0, lastAtOrBefore(snaps, time, (s) => s.t));
  const a = snaps[i]!;
  const b = snaps[i + 1];
  if (!b || b.discontinuity || a.t === time) {
    return { players: a.players, ball: a.ball, possession: a.possession };
  }
  const k = (time - a.t) / (b.t - a.t);
  const bPlayers = playersById(b);
  return {
    players: a.players.map((pa) => {
      const pb = bPlayers.get(pa.playerId) ?? pa;
      return {
        playerId: pa.playerId,
        x: lerp(pa.x, pb.x, k),
        y: lerp(pa.y, pb.y, k),
        facing: lerpAngle(pa.facing, pb.facing, k),
      };
    }),
    ball: { x: lerp(a.ball.x, b.ball.x, k), y: lerp(a.ball.y, b.ball.y, k), z: lerp(a.ball.z, b.ball.z, k) },
    possession: a.possession,
  };
}

/** Events with timestamp ≤ t, oldest first. */
export function eventsAt(fixture: MatchFixture, t: number): MatchEvent[] {
  return fixture.events.slice(0, lastAtOrBefore(fixture.events, t, (e) => e.t) + 1);
}

/** Starting score plus goals revealed by time t. */
export function scoreAt(fixture: MatchFixture, t: number): Score {
  const score = { ...fixture.startingState.score };
  for (const e of eventsAt(fixture, t)) {
    if (e.type !== "goal") continue;
    const side = fixture.teams.find((team) => team.id === e.teamId)?.side;
    if (side) score[side] += 1;
  }
  return score;
}

/** Events with prevT < timestamp ≤ t, in order — the ones a single step crossed. */
export function eventsBetween(fixture: MatchFixture, prevT: number, t: number): MatchEvent[] {
  if (t <= prevT) return [];
  const from = lastAtOrBefore(fixture.events, prevT, (e) => e.t) + 1;
  const to = lastAtOrBefore(fixture.events, t, (e) => e.t) + 1;
  return fixture.events.slice(from, to);
}

export function frameAt(fixture: MatchFixture, t: number): PlaybackFrame {
  const time = clampTime(fixture, t);
  return {
    timeMs: time,
    ...positionsAt(fixture, time),
    score: scoreAt(fixture, time),
    events: eventsAt(fixture, time),
  };
}

/** Timestamp of the latest event strictly before t, or null. Equal-time events share one stop. */
export function previousEventTime(fixture: MatchFixture, t: number): number | null {
  const events = fixture.events;
  // Last event with timestamp < t: the last one at or before the next-lower integer ms.
  let lo = 0;
  let hi = events.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.t < t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found < 0 ? null : events[found]!.t;
}

/** Timestamp of the earliest event strictly after t, or null. */
export function nextEventTime(fixture: MatchFixture, t: number): number | null {
  const i = lastAtOrBefore(fixture.events, t, (e) => e.t) + 1;
  return i < fixture.events.length ? fixture.events[i]!.t : null;
}
