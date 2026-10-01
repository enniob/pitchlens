/**
 * Animation inputs derived purely from recorded snapshots: how fast each player
 * is moving, how far they have travelled (which drives the stride cycle) and
 * which ball contact, if any, they are in the middle of (which drives kicks,
 * throws, receptions, saves, tackles, blocks and falls).
 *
 * Like the rest of playback, everything here is a pure function of the fixture
 * and a time, so seeking, restarting and changing speed always give the same
 * pose for the same time. Events are never read: every contact is recognised
 * from the snapshots themselves, from who has the ball and where it goes. The
 * only look-ahead is the short wind-up before a contact (at most
 * MAX_WINDUP_MS), which reads snapshots slightly ahead; it never touches the
 * score, feed, timeline or statistics.
 */
import type { MatchFixture, Snapshot } from "@/match/contract";
import { clampTime, lastAtOrBefore, positionsAt } from "./derive";

/** The kick animation starts this long before the ball is struck. */
export const KICK_WINDUP_MS = 220;
/** ...and has fully blended back out this long after. */
export const KICK_RECOVER_MS = 380;
/** Half-width of the window player speed is averaged over, so the gait changes smoothly. */
const SPEED_WINDOW_MS = 150;

/**
 * kick: the ball leaves a player's foot. throw: it leaves their hands (a
 * throw-in), including the time they hold it overhead beforehand.
 * receive: a player takes control of a free ball. save: a goalkeeper stops or
 * parries a shot. tackle: a player takes the ball off an opponent, or fouls
 * them. block: an outfield player deflects the ball. fall: a fouled player
 * goes down.
 */
export type ContactKind = "kick" | "throw" | "receive" | "save" | "tackle" | "block" | "fall";

/** How long before and after the contact instant each animation runs, ms. */
export const CONTACT_WINDOW: Record<ContactKind, readonly [before: number, after: number]> = {
  kick: [KICK_WINDUP_MS, KICK_RECOVER_MS],
  throw: [300, 420],
  receive: [180, 320],
  save: [300, 750],
  tackle: [280, 700],
  block: [150, 380],
  fall: [60, 1700],
};
/** The longest look-ahead any animation needs. */
export const MAX_WINDUP_MS = Math.max(...Object.values(CONTACT_WINDOW).map(([before]) => before));

export interface BallContact {
  /** Snapshot time of the contact. */
  t: number;
  playerId: string;
  kind: ContactKind;
  /** Where the ball was relative to the player at the contact: metres to their right (negative = left) and height. */
  side: number;
  height: number;
  /** Horizontal distance from the player to the ball at the contact. */
  reach: number;
  /**
   * Direction (pitch facing, radians) the contact is made facing, which `side`
   * is measured from. For a goalkeeper's save this is back along the line the
   * shot arrived on, as they square up to it; otherwise the recorded facing.
   */
  face: number;
  /** Absolute times the animation starts and ends. */
  start: number;
  end: number;
}

/** A contact as seen from a moment in time. */
export interface PlayerAction {
  kind: ContactKind;
  /** Milliseconds relative to the contact (negative = before it). */
  ms: number;
  /** Milliseconds from the start of the animation to the contact (its wind-up, or a throw's hold). */
  lead: number;
  side: number;
  height: number;
  reach: number;
  /** Turn from the player's current recorded facing to the contact's `face`, radians (positive = towards their right). */
  turn: number;
}

export interface PlayerMotion {
  playerId: string;
  /** Metres per second, averaged over a short window around the time. */
  speed: number;
  /** Metres travelled since t = 0 (dead-ball cuts add nothing). */
  distance: number;
  /** The contact this player is animating, or null. */
  action: PlayerAction | null;
}

interface MotionIndex {
  playerIds: string[];
  /** Cumulative distance per snapshot, row-major: [snapshot][player]. */
  travelled: Float64Array;
  contacts: BallContact[];
  /** Per player, contacts sorted by start time. */
  byPlayer: Map<string, BallContact[]>;
}

const indexCache = new WeakMap<MatchFixture, MotionIndex>();

/**
 * A goalkeeper taking a free ball that arrives faster than this, or soon after
 * an opponent struck it, is stopping a shot rather than receiving a pass.
 */
const SAVE_SPEED = 8;
const SAVE_AFTER_STRIKE_MS = 600;
/** A free ball changing direction by more than this within a player's reach has come off them. */
const DEFLECTION_ANGLE = 0.5;
const DEFLECTION_REACH = 1.6;
/** How long after striking the ball a kicker cannot touch it again. */
const KICKER_CLEAR_MS = 400;

const playerAt = (s: Snapshot, id: string) => s.players.find((p) => p.playerId === id);
const moved = (a: Snapshot, b: Snapshot) => Math.hypot(b.ball.x - a.ball.x, b.ball.y - a.ball.y, b.ball.z - a.ball.z);

const angleDelta = (from: number, to: number) => {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

/**
 * Ball position relative to a player in snapshot `s`: to their right, height,
 * and horizontal distance. With `from` (the previous snapshot), the player is
 * taken to face back along the ball's incoming path instead of their recorded
 * facing, as a goalkeeper squares up to a shot.
 */
function relative(s: Snapshot, playerId: string, from?: Snapshot): Pick<BallContact, "side" | "height" | "reach" | "face"> {
  const p = playerAt(s, playerId)!;
  const dx = s.ball.x - p.x;
  const dy = s.ball.y - p.y;
  let facing = p.facing;
  if (from && Math.hypot(s.ball.x - from.ball.x, s.ball.y - from.ball.y) > 0.05)
    facing = Math.atan2(from.ball.y - s.ball.y, from.ball.x - s.ball.x);
  // Model right is the facing direction turned by +90° in pitch space (see scene/coords.ts).
  return {
    side: -dx * Math.sin(facing) + dy * Math.cos(facing),
    height: s.ball.z,
    reach: Math.hypot(dx, dy),
    face: facing,
  };
}

function recognise(fixture: MatchFixture): BallContact[] {
  const snaps = fixture.snapshots;
  const teamOf = new Map(fixture.roster.map((p) => [p.id, p.teamId]));
  const found: BallContact[] = [];
  let lastStrike = { t: -Infinity, teamId: "", playerId: "" };
  const add = (s: Snapshot, playerId: string, kind: ContactKind, start?: number, from?: Snapshot) => {
    const [before, after] = CONTACT_WINDOW[kind];
    found.push({ t: s.t, playerId, kind, ...relative(s, playerId, from), start: start ?? s.t - before, end: s.t + after });
  };

  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1]!;
    const b = snaps[i]!;
    const c = snaps[i + 1];
    if (b.discontinuity) continue;
    const had = a.possession?.playerId ?? null;
    const has = b.possession?.playerId ?? null;
    const continues = !!c && !c.discontinuity;

    if (had && !has) {
      const dead = continues && !c.possession && moved(b, c) <= 1e-3;
      if (continues && !dead) {
        // Released and moving away: a kick, or a throw when it leaves from above head height.
        if (b.ball.z > 1) {
          let k = i - 1;
          while (k > 0 && snaps[k - 1]!.possession?.playerId === had && snaps[k - 1]!.ball.z > 1 && !snaps[k]!.discontinuity) k--;
          add(b, had, "throw", Math.min(snaps[k]!.t, b.t - CONTACT_WINDOW.throw[0]));
        } else {
          add(b, had, "kick");
        }
        lastStrike = { t: b.t, teamId: teamOf.get(had) ?? "", playerId: had };
      } else if (dead && b.ball.z < 0.5) {
        // Play stopped with the ball dead at the carrier's feet: they were fouled by the nearest opponent.
        add(b, had, "fall");
        let fouler: string | null = null;
        let best = Infinity;
        for (const p of b.players) {
          if (teamOf.get(p.playerId) === teamOf.get(had)) continue;
          const d = Math.hypot(p.x - b.ball.x, p.y - b.ball.y);
          if (d < best) [fouler, best] = [p.playerId, d];
        }
        if (fouler) add(b, fouler, "tackle");
      }
      continue;
    }
    if (has && has !== had) {
      if (had) {
        add(b, has, "tackle");
      } else {
        const keeper = fixture.roster.find((p) => p.id === has)?.role === "GK";
        const incoming = moved(a, b) / ((b.t - a.t) / 1000);
        const shot = incoming > SAVE_SPEED || (lastStrike.teamId !== teamOf.get(has) && b.t - lastStrike.t <= SAVE_AFTER_STRIKE_MS);
        if (keeper && shot) add(b, has, "save", undefined, a);
        else add(b, has, "receive");
      }
      continue;
    }
    if (!had && !has && continues && !c.possession) {
      // A free ball turning sharply next to a player has come off them (a ground bounce keeps its heading).
      const inX = b.ball.x - a.ball.x;
      const inY = b.ball.y - a.ball.y;
      const outX = c.ball.x - b.ball.x;
      const outY = c.ball.y - b.ball.y;
      const inLen = Math.hypot(inX, inY);
      const outLen = Math.hypot(outX, outY);
      if (inLen < 0.02 || outLen < 0.02) continue;
      const cos = (inX * outX + inY * outY) / (inLen * outLen);
      if (cos > Math.cos(DEFLECTION_ANGLE)) continue;
      let who: string | null = null;
      let best = DEFLECTION_REACH;
      for (const p of b.players) {
        // The kicker is still following through and cannot be the one it came off (as in the simulator).
        if (p.playerId === lastStrike.playerId && b.t - lastStrike.t < KICKER_CLEAR_MS) continue;
        const d = Math.hypot(p.x - b.ball.x, p.y - b.ball.y);
        if (d < best) [who, best] = [p.playerId, d];
      }
      if (who && fixture.roster.find((p) => p.id === who)?.role === "GK") add(b, who, "save", undefined, a);
      else if (who) add(b, who, "block");
    }
  }
  return found;
}

function motionIndex(fixture: MatchFixture): MotionIndex {
  let index = indexCache.get(fixture);
  if (index) return index;
  const snaps = fixture.snapshots;
  const playerIds = snaps[0]!.players.map((p) => p.playerId);
  const column = new Map(playerIds.map((id, i) => [id, i]));
  const n = playerIds.length;
  const travelled = new Float64Array(snaps.length * n);
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
  }
  const contacts = recognise(fixture);
  const byPlayer = new Map<string, BallContact[]>();
  for (const c of contacts) {
    const list = byPlayer.get(c.playerId);
    if (list) list.push(c);
    else byPlayer.set(c.playerId, [c]);
  }
  for (const list of byPlayer.values()) list.sort((a, b) => a.start - b.start || a.t - b.t);
  index = { playerIds, travelled, contacts, byPlayer };
  indexCache.set(fixture, index);
  return index;
}

/** Every ball contact in the fixture, in time order, recognised from snapshots alone. */
export function ballContacts(fixture: MatchFixture): BallContact[] {
  return motionIndex(fixture).contacts;
}

/** Every strike of the ball (kicks and throws), in time order. */
export function kickContacts(fixture: MatchFixture): BallContact[] {
  return ballContacts(fixture).filter((c) => c.kind === "kick" || c.kind === "throw");
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

/** The contact a player facing `facing` is animating at time t: the most recently started one that has not ended. */
function actionAt(list: BallContact[] | undefined, t: number, facing: number): PlayerAction | null {
  if (!list) return null;
  for (let i = lastAtOrBefore(list, t, (c) => c.start); i >= 0; i--) {
    const c = list[i]!;
    if (t <= c.end) {
      const turn = angleDelta(facing, c.face);
      return { kind: c.kind, ms: t - c.t, lead: c.t - c.start, side: c.side, height: c.height, reach: c.reach, turn };
    }
    // Windows are short, so anything that started long ago has ended too.
    if (t - c.start > 10_000) break;
  }
  return null;
}

/** Motion of every player at time t, in the order of the first snapshot's players. */
export function motionAt(fixture: MatchFixture, t: number): PlayerMotion[] {
  const index = motionIndex(fixture);
  const time = clampTime(fixture, t);
  const from = clampTime(fixture, time - SPEED_WINDOW_MS);
  const to = clampTime(fixture, time + SPEED_WINDOW_MS);
  const facing = new Map(positionsAt(fixture, time).players.map((p) => [p.playerId, p.facing]));
  return index.playerIds.map((playerId, col) => ({
    playerId,
    speed:
      to > from
        ? ((travelledAt(fixture, index, to, col) - travelledAt(fixture, index, from, col)) / (to - from)) * 1000
        : 0,
    distance: travelledAt(fixture, index, time, col),
    action: actionAt(index.byPlayer.get(playerId), time, facing.get(playerId) ?? 0),
  }));
}
