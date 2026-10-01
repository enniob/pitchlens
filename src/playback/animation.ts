/**
 * Animation inputs derived purely from recorded snapshots: how fast each player
 * is moving, how far they have travelled (which drives the stride cycle) and
 * where they are relative to a ball contact (which drives the kick).
 *
 * Like the rest of playback, everything here is a pure function of the fixture
 * and a time, so seeking, restarting and changing speed always give the same
 * pose for the same time. Events are never read: a kick is recognised from the
 * snapshots themselves, as the instant a player's possession ends with the ball
 * released. The only look-ahead is the kick wind-up, which reads snapshots up
 * to KICK_WINDUP_MS ahead; it does not touch the score, feed or timeline.
 */
import type { MatchFixture } from "@/match/contract";
import { clampTime, lastAtOrBefore } from "./derive";

/** The kick animation starts this long before the ball is struck. */
export const KICK_WINDUP_MS = 220;
/** ...and has fully blended back out this long after. */
export const KICK_RECOVER_MS = 380;
/** Half-width of the window player speed is averaged over, so the gait changes smoothly. */
const SPEED_WINDOW_MS = 150;

export interface KickContact {
  /** Snapshot time at which the ball leaves the foot. */
  t: number;
  playerId: string;
}

export interface PlayerMotion {
  playerId: string;
  /** Metres per second, averaged over a short window around the time. */
  speed: number;
  /** Metres travelled since t = 0 (dead-ball cuts add nothing). */
  distance: number;
  /** Milliseconds relative to this player's nearest kick (negative = before contact), or null outside one. */
  kickMs: number | null;
}

interface MotionIndex {
  playerIds: string[];
  /** Cumulative distance per snapshot, row-major: [snapshot][player]. */
  travelled: Float64Array;
  contacts: KickContact[];
  kicksByPlayer: Map<string, number[]>;
}

const indexCache = new WeakMap<MatchFixture, MotionIndex>();

function motionIndex(fixture: MatchFixture): MotionIndex {
  let index = indexCache.get(fixture);
  if (index) return index;
  const snaps = fixture.snapshots;
  const playerIds = snaps[0]!.players.map((p) => p.playerId);
  const column = new Map(playerIds.map((id, i) => [id, i]));
  const n = playerIds.length;
  const travelled = new Float64Array(snaps.length * n);
  const contacts: KickContact[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1]!;
    const b = snaps[i]!;
    travelled.copyWithin(i * n, (i - 1) * n, i * n);
    if (b.discontinuity) continue;
    const before = new Map(a.players.map((p) => [p.playerId, p]));
    for (const p of b.players) {
      const prev = before.get(p.playerId);
      const col = column.get(p.playerId);
      if (prev && col !== undefined) travelled[i * n + col]! += Math.hypot(p.x - prev.x, p.y - prev.y);
    }
    // Possession ending with nobody on the ball is a kick; a tackle hands it straight to another player.
    if (a.possession?.playerId && b.possession === null) contacts.push({ t: b.t, playerId: a.possession.playerId });
  }
  const kicksByPlayer = new Map<string, number[]>();
  for (const c of contacts) {
    const list = kicksByPlayer.get(c.playerId);
    if (list) list.push(c.t);
    else kicksByPlayer.set(c.playerId, [c.t]);
  }
  index = { playerIds, travelled, contacts, kicksByPlayer };
  indexCache.set(fixture, index);
  return index;
}

/** Every ball strike in the fixture, in time order, recognised from snapshots alone. */
export function kickContacts(fixture: MatchFixture): KickContact[] {
  return motionIndex(fixture).contacts;
}

function travelledAt(fixture: MatchFixture, index: MotionIndex, t: number, col: number): number {
  const snaps = fixture.snapshots;
  const n = index.playerIds.length;
  const i = Math.max(0, lastAtOrBefore(snaps, t, (s) => s.t));
  const a = snaps[i]!;
  const b = snaps[i + 1];
  const from = index.travelled[i * n + col]!;
  if (!b || b.discontinuity) return from;
  return from + (index.travelled[(i + 1) * n + col]! - from) * ((t - a.t) / (b.t - a.t));
}

function kickOffset(kicks: number[] | undefined, t: number): number | null {
  if (!kicks) return null;
  // First kick that has not finished recovering; anything earlier is over.
  const next = lastAtOrBefore(kicks, t - KICK_RECOVER_MS, (k) => k) + 1;
  const kick = kicks[next];
  return kick !== undefined && t >= kick - KICK_WINDUP_MS ? t - kick : null;
}

/** Motion of every player at time t, in the order of the first snapshot's players. */
export function motionAt(fixture: MatchFixture, t: number): PlayerMotion[] {
  const index = motionIndex(fixture);
  const time = clampTime(fixture, t);
  const from = clampTime(fixture, time - SPEED_WINDOW_MS);
  const to = clampTime(fixture, time + SPEED_WINDOW_MS);
  return index.playerIds.map((playerId, col) => ({
    playerId,
    speed:
      to > from
        ? ((travelledAt(fixture, index, to, col) - travelledAt(fixture, index, from, col)) / (to - from)) * 1000
        : 0,
    distance: travelledAt(fixture, index, time, col),
    kickMs: kickOffset(index.kicksByPlayer.get(playerId), time),
  }));
}
