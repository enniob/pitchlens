/**
 * Deterministic seeded match simulator. No renderer, wall clock or network
 * dependencies: the same seed and duration always produce the same fixture.
 *
 * The simulation advances in fixed STEP_MS steps. Every step moves the players
 * (who keep a body's width apart), then either carries the ball at its owner's
 * foot or advances the free ball with the physics in ./ball.ts. Outcomes are
 * read off the ball's actual path, earliest contact first: a pass is received
 * or intercepted when the ball comes within a player's reach, it deflects off
 * an opponent's body or the woodwork, a goalkeeper holds or parries it, and a
 * goal is scored when the whole ball crosses the line inside the frame.
 *
 * Play stops for goals, the ball leaving the pitch, fouls and offside, and
 * restarts after a dead-ball pause with a kickoff, throw-in, corner, goal kick,
 * free kick or penalty, depending on where the ball went and who touched it last.
 *
 * Each team plays in a formation (see src/match/formations.ts) and may switch
 * formation at scheduled times. A player's slot sets their neutral spot and,
 * through a per-position profile, how they shift with the ball, push on in
 * attack, tuck in and recover in defence, and whether they run off the
 * defenders' shoulder. A change only moves those targets: nobody teleports, and
 * the ball, possession and any kick in flight carry on untouched.
 *
 * Snapshots are recorded every SNAPSHOT_INTERVAL_MS and additionally at every
 * contact step (kick, reception, tackle, deflection, save, bounce, line
 * crossing), so each event has a snapshot at exactly its timestamp. Playback
 * only ever replays these snapshots; nothing is re-simulated in the viewer.
 */
import {
  GOAL_HEIGHT,
  GOAL_WIDTH,
  PENALTY_AREA_DEPTH,
  PENALTY_AREA_HALF_WIDTH,
  PENALTY_SPOT_DISTANCE,
  PITCH_LENGTH,
  PITCH_WIDTH,
  POST_RADIUS,
  type AppliedFormationChange,
  type FormationId,
  type MatchEvent,
  type MatchFixture,
  type Player,
  type PlayerState,
  type ScheduledFormationChange,
  type SlotAssignments,
  type Snapshot,
  type TacticalPosition,
  type Team,
  type TeamFormation,
  type TeamSide,
  type Vec2,
  type Vec3,
} from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import {
  assignmentErrors,
  DEFAULT_FORMATION,
  defaultAssignments,
  FORMATIONS,
  formationSlot,
  hashKey,
  isFormationId,
  remapAssignments,
  slotSpot,
  type FormationSlot,
} from "@/match/formations";
import {
  BALL_RADIUS,
  horizontalSpeed,
  isAirborne,
  loftLaunchSpeed,
  rollLaunchSpeed,
  rollTravelTime,
  stepBall,
  type BallState,
} from "./ball";

/** A formation change for one team at simulation time `t` (ms, a multiple of STEP_MS, inside the match). */
export interface FormationChangeConfig {
  t: number;
  formation: FormationId;
  /** Player ID → slot ID in the new formation. Defaults to moving each player to the nearest new slot. */
  assignments?: SlotAssignments;
}

export interface TeamTacticsConfig {
  /** Starting formation; defaults to DEFAULT_FORMATION. */
  formation?: FormationId;
  /** Player ID → slot ID; defaults to `defaultAssignments`. */
  assignments?: SlotAssignments;
  changes?: FormationChangeConfig[];
}

export type TacticsConfig = Partial<Record<TeamSide, TeamTacticsConfig>>;

export interface SimulationOptions {
  seed: number;
  durationMs?: number;
  tactics?: TacticsConfig;
}

/**
 * Bumped whenever the simulator's output for a given seed and configuration
 * changes. Part of every generated matchId.
 */
export const SIMULATOR_VERSION = "4";

/** Fixed simulation timestep for player movement and ball physics. */
export const STEP_MS = 20;
/** Regular snapshot spacing; contact steps add snapshots in between. */
export const SNAPSHOT_INTERVAL_MS = 100;
export const MAX_PLAYER_SPEED = 7;
/** Distance from a player's centre to a ball at their foot, along their facing. */
export const DRIBBLE_OFFSET = 0.55;
/** Horizontal reach / maximum ball height at which an outfield player controls the ball. */
export const CONTROL_REACH = 1.1;
export const CONTROL_HEIGHT = 1.4;
/** Reach of opponents cutting out a pass (tighter than a prepared receiver). */
export const INTERCEPT_REACH = 1;
export const INTERCEPT_HEIGHT = 1.2;
/** Goalkeeper reach when stopping a shot. */
export const KEEPER_REACH = 1.3;
export const KEEPER_HEIGHT = 2.6;
/** How far behind the goal line the net stops the ball. */
export const NET_DEPTH = 2;
/** A ball that leaves the pitch is stopped this far beyond the lines. */
export const RUN_OFF = 3;
/** Players' centres are kept at least this far apart: nobody runs through anybody. */
export const PLAYER_GAP = 0.7;
/** A ball passing within this distance of an opponent's centre, below BODY_HEIGHT, hits them. */
export const BODY_REACH = 0.5;
/** A defender stretching a leg can block a shot passing this close. */
export const BLOCK_REACH = 0.9;
export const BODY_HEIGHT = 1.9;
/** Height at which a throw-in is held and released, and how far in front of the thrower. */
export const THROW_HEIGHT = 2.2;
export const THROW_REACH = 0.3;
/** Opponents stand at least this far from the ball at a free kick, corner or kickoff. */
export const RESTART_DISTANCE = 9.15;
/** An opponent this close to the ball at the carrier's feet can win it, m. */
export const TACKLE_RANGE = 1.8;
/** Fraction of horizontal speed kept by a deflection off a body or the frame (normal component). */
export const BODY_RESTITUTION = 0.3;
export const WOODWORK_RESTITUTION = 0.6;

const DT = STEP_MS / 1000;
const DRIBBLE_SPEED = 5.5;
const PRESS_SPEED = 6;
const KEEPER_SPEED = 4.5;
const WALK_SPEED = 3.5;
const WINDUP_SPEED = 1.5;
/** Facing turn rate, rad/s. */
const TURN_RATE = 10;
/** Speed at which a newly won ball is drawn in to the foot, m/s. Faster than any foot moves. */
const GATHER_SPEED = 14;
const WINDUP_MS = 160;
const DEAD_BALL_MS = 2000;
const INTERCEPT_CHANCE = 0.5;
/** A pass cannot be cut out until it has travelled this far from the kick, m. */
const INTERCEPT_MIN_TRAVEL = 2.5;
/** A shot cannot be blocked until it has left the shooter's foot by this much, m. */
const BLOCK_MIN_TRAVEL = 1;
/** Nobody can touch a kicked ball until it has left the foot by this much, m (a loose ball excepted). */
const CONTACT_MIN_TRAVEL = 0.25;
const TACKLE_CHANCE = 0.25;
/** Chance that a challenge is a foul instead (checked when the tackle does not win the ball cleanly). */
const FOUL_CHANCE = 0.035;
const MISHIT_CHANCE = 0.06;
/** An opponent this close to a pass's path moves to cut it out, m. */
const CUT_OUT_RANGE = 5;
const SAVE_CHANCE = 0.65;
/** When a goalkeeper fails to hold a shot, the chance they still get a hand to it. */
const PARRY_CHANCE = 0.7;
/** A player who has just deflected the ball cannot touch it again for this long. */
const DEFLECT_RECOVERY_MS = 400;
/** ...and neither can a player who has just kicked it, while they follow through (e.g. a shot parried straight back). */
const KICK_RECOVERY_MS = 400;
/** Chance that a passer notices a team-mate is offside and looks for someone else. */
const OFFSIDE_AWARENESS = 0.75;
/** Once a carrier is this close to goal, a defender steps into the line between them and the goal. */
const COVER_RANGE = 32;
/** ...this far in front of the ball. */
const COVER_DISTANCE = 5;
/** A direct free kick this close to goal gets a wall. */
const WALL_RANGE = 32;
const GROUND_PASS_ARRIVAL_SPEED = 9;
const MAX_GROUND_PASS_SPEED = 24;
const LOFT_ANGLE = (32 * Math.PI) / 180;
const CENTRE: Vec2 = { x: PITCH_LENGTH / 2, y: PITCH_WIDTH / 2 };
const TAU = Math.PI * 2;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const angleDelta = (from: number, to: number) => {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};
const onPitch = (p: Vec2, margin = 0): Vec2 => ({
  x: clamp(p.x, margin, PITCH_LENGTH - margin),
  y: clamp(p.y, margin, PITCH_WIDTH - margin),
});

/** Mulberry32: all stochastic choices use this one seeded stream. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let n = Math.imul(state ^ (state >>> 15), state | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How each position moves off the ball, in the team's own frame (see
 * formations.ts). A deliberately simple synthetic model, not a validated
 * tactical one.
 *   follow / slide: fraction of the ball's offset from the centre followed along / across the pitch
 *   push:  metres moved upfield while the team has the ball
 *   width: lateral spread multiplier while attacking; tuck: while defending
 *   drop:  metres given up while defending
 *   recover: while defending, stay at most this far upfield of the ball (negative: goal-side of it); null = stay up
 *   runs:  time runs along the defenders' offside line while the team attacks
 */
interface MovementProfile {
  follow: number;
  slide: number;
  push: number;
  width: number;
  tuck: number;
  drop: number;
  recover: number | null;
  runs: boolean;
}
const profile = (follow: number, slide: number, push: number, width: number, tuck: number, drop: number, recover: number | null, runs = false): MovementProfile => ({
  follow,
  slide,
  push,
  width,
  tuck,
  drop,
  recover,
  runs,
});
const FULL_BACK = profile(0.5, 0.25, 18, 1.25, 0.8, 3, 0);
const WIDE_MID = profile(0.55, 0.22, 13, 1.25, 0.75, 5, 10);
const WINGER = profile(0.6, 0.2, 14, 1.2, 0.8, 4, 16, true);
export const MOVEMENT_PROFILES: Record<TacticalPosition, MovementProfile> = {
  GK: profile(0, 0, 0, 1, 1, 0, null),
  CB: profile(0.5, 0.3, 8, 1.1, 0.85, 3, -1),
  RB: FULL_BACK,
  LB: FULL_BACK,
  DM: profile(0.5, 0.35, 9, 1, 0.75, 5, 3),
  CM: profile(0.55, 0.35, 14, 1.1, 0.8, 5, 8),
  RM: WIDE_MID,
  LM: WIDE_MID,
  AM: profile(0.6, 0.35, 16, 1, 0.8, 7, 14),
  RW: WINGER,
  LW: WINGER,
  ST: profile(0.6, 0.3, 12, 1, 1, 2, null, true),
};

/**
 * Resolves the tactics configuration: default formations and assignments,
 * validated custom ones, and every scheduled change with its full assignment.
 * Changes are returned in processing order: by time, then the home team first.
 * Throws on invalid configuration.
 */
export function resolveTactics(
  config: TacticsConfig | undefined,
  durationMs: number,
  teams: readonly Team[] = sampleFixture.teams,
  roster: readonly Player[] = sampleFixture.roster,
): { initial: TeamFormation[]; scheduled: ScheduledFormationChange[] } {
  const initial: TeamFormation[] = [];
  const scheduled: ScheduledFormationChange[] = [];
  const ordered = [...teams].sort((a, b) => (a.side === b.side ? 0 : a.side === "home" ? -1 : 1));
  for (const team of ordered) {
    const cfg = config?.[team.side] ?? {};
    const squad = roster.filter((p) => p.teamId === team.id);
    const check = (formation: unknown, assignments: SlotAssignments | undefined, where: string): SlotAssignments | undefined => {
      if (!isFormationId(formation)) throw new Error(`${where}: unknown formation ${String(formation)}`);
      if (assignments === undefined) return undefined;
      const errors = assignmentErrors(formation, assignments, squad, roster);
      if (errors.length > 0) throw new Error(`${where}: ${errors.join("; ")}`);
      return Object.fromEntries(squad.map((p) => [p.id, assignments[p.id]!]));
    };
    const formation = cfg.formation ?? DEFAULT_FORMATION;
    let current: TeamFormation = {
      teamId: team.id,
      formation,
      assignments: check(formation, cfg.assignments, `${team.name} formation`) ?? defaultAssignments(formation, squad),
    };
    initial.push(current);
    const changes = [...(cfg.changes ?? [])].sort((a, b) => a.t - b.t);
    changes.forEach((c, i) => {
      const where = `${team.name} change at ${c.t} ms`;
      if (!Number.isInteger(c.t) || c.t <= 0 || c.t >= durationMs)
        throw new Error(`${where}: time must be after kickoff and before the end of the match (0–${durationMs} ms, exclusive)`);
      if (c.t % STEP_MS !== 0) throw new Error(`${where}: time must be a multiple of ${STEP_MS} ms`);
      if (i > 0 && changes[i - 1]!.t === c.t) throw new Error(`${where}: a team can change formation only once at a time`);
      const assignments =
        check(c.formation, c.assignments, where) ?? remapAssignments(current.formation, current.assignments, c.formation, squad);
      current = { teamId: team.id, formation: c.formation, assignments };
      scheduled.push({ ...current, t: c.t });
    });
  }
  // Stable sort keeps the home team's change first at equal times.
  scheduled.sort((a, b) => a.t - b.t);
  return { initial, scheduled };
}

/** Where the attackers stand for a corner, as [metres from the goal line, metres across from the goal's centre]. */
const CORNER_SPOTS: [number, number][] = [[6, -2.5], [8, 3], [11, -0.5], [9.5, 6.5], [13, -6]];

interface Body {
  info: Player;
  team: Team;
  /** +1 when attacking towards increasing x. */
  sign: 1 | -1;
  keeper: boolean;
  /** Current formation slot, and its neutral spot on the pitch. */
  slot: FormationSlot;
  base: Vec2;
  state: PlayerState;
}

interface Flight {
  kind: "pass" | "shot";
  from: Body;
  intended: Body | null;
  /** Where the kick was aimed, on the ground. */
  aim: Vec2;
  startT: number;
  start: Vec3;
  /** When the ball is expected to reach the aim point. */
  arriveT: number;
  /** Players who cannot touch the ball before the given time: beaten by it (for good), or recovering from a deflection. */
  barred: Map<Body, number>;
  /** Nobody is expected to receive it any more; anyone may collect it. */
  loose: boolean;
  /** Earliest time the defending goalkeeper reacts to a shot. */
  reactT: number;
  /** Team-mates of the kicker in an offside position at the strike; empty for restarts exempt from offside. */
  offside: Set<Body>;
  /** For a shot, the first touch that turned it away; it decides the result unless the ball still goes in or is held. */
  turned: { kind: "parry" | "block" | "woodwork"; by: Body | null } | null;
}

type Intent =
  | { kind: "pass"; since: number; receiver: Body; lofted: boolean; thrown: boolean; exempt: boolean }
  | { kind: "shot"; since: number; target: Vec3; speed: number };

type RestartKind = "kickoff" | "goal-kick" | "throw-in" | "corner" | "free-kick" | "penalty";

interface Restart {
  kind: RestartKind;
  until: number;
  /** Team that restarts play. */
  team: Team;
  /** Which goal the ball is in (+1 = the x = 105 end), or 0. */
  net: -1 | 0 | 1;
  /** Where the restart is taken (for a corner, which corner). */
  at: Vec2;
  /** Player who takes it, when already decided (the fouled player). */
  taker?: Body;
  /** An indirect free kick may not be shot at goal. */
  indirect?: boolean;
  /** Players who stay where they are during the stoppage (the fouled player and the fouler). */
  still?: Body[];
}

/** Closest approach of point `p` to the ball's path over one step. */
function approach(prev: Vec3, cur: Vec3, p: Vec2): { u: number; gap: number; at: Vec3 } {
  const dx = cur.x - prev.x;
  const dy = cur.y - prev.y;
  const len2 = dx * dx + dy * dy;
  const u = len2 > 1e-12 ? clamp(((p.x - prev.x) * dx + (p.y - prev.y) * dy) / len2, 0, 1) : 1;
  const at = { x: prev.x + dx * u, y: prev.y + dy * u, z: prev.z + (cur.z - prev.z) * u };
  return { u, gap: distance(at, p), at };
}

/**
 * Fraction of the way along a→b at which a point moving in a plane first
 * touches a circle of radius r around c, or null if it does not during the
 * segment. A point already inside the circle is moving away from a contact it
 * has already made, so it is ignored.
 */
function sweep(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number): number | null {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - cx;
  const fy = ay - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0 || a < 1e-12) return null;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const u = (-b - Math.sqrt(disc)) / (2 * a);
  return u >= 0 && u <= 1 ? u : null;
}

const lerpBall = (a: BallState, b: BallState, u: number): BallState => ({
  x: a.x + (b.x - a.x) * u,
  y: a.y + (b.y - a.y) * u,
  z: a.z + (b.z - a.z) * u,
  vx: a.vx + (b.vx - a.vx) * u,
  vy: a.vy + (b.vy - a.vy) * u,
  vz: a.vz + (b.vz - a.vz) * u,
});

/** Things the ball can meet during one step, in the order they are resolved (earliest u first). */
type Hit =
  | { u: number; kind: "out"; at: Vec3; end: -1 | 0 | 1 }
  | { u: number; kind: "frame"; part: "post" | "crossbar"; normal: Vec3 }
  | { u: number; kind: "control"; by: Body; at: Vec3; chance: number; solid: boolean }
  | { u: number; kind: "body"; by: Body };

export function generateMatch({ seed, durationMs = 60_000, tactics: config }: SimulationOptions): MatchFixture {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error("Seed must be an integer from 0 to 4294967295");
  if (
    !Number.isInteger(durationMs) ||
    durationMs < 10_000 ||
    durationMs > 180_000 ||
    durationMs % SNAPSHOT_INTERVAL_MS !== 0
  )
    throw new Error("Duration must be 10–180 seconds in 100 ms steps");

  const rng = random(seed);
  const teams = structuredClone(sampleFixture.teams);
  const roster = structuredClone(sampleFixture.roster);
  const opponentOf = (team: Team) => teams.find((t) => t.id !== team.id)!;
  const { initial, scheduled } = resolveTactics(config, durationMs, teams, roster);
  const configKey = hashKey(JSON.stringify({ initial, scheduled }));
  /** Each team's formation as of the current step. */
  const current = new Map(initial.map((f) => [f.teamId, f]));

  const bodies: Body[] = roster.map((info) => {
    const team = teams.find((t) => t.id === info.teamId)!;
    const sign = team.attacksTowards === "increasing-x" ? 1 : -1;
    const f = current.get(team.id)!;
    const s = formationSlot(f.formation, f.assignments[info.id]!)!;
    const base = slotSpot(s, team.attacksTowards);
    return {
      info,
      team,
      sign,
      keeper: info.role === "GK",
      slot: s,
      base,
      state: { playerId: info.id, ...base, facing: sign > 0 ? 0 : Math.PI },
    };
  });
  const signOf = (team: Team): 1 | -1 => (team.attacksTowards === "increasing-x" ? 1 : -1);
  const keeperOf = (team: Team) => bodies.find((b) => b.team === team && b.keeper)!;
  /** The player in the team's first ST slot (or, with none, its most advanced slot): takes kickoffs and penalties. */
  const strikerOf = (team: Team) => {
    const own = bodies.filter((b) => b.team === team && !b.keeper);
    for (const s of FORMATIONS[current.get(team.id)!.formation].slots)
      if (s.position === "ST") return own.find((b) => b.slot === s)!;
    return own.reduce((a, b) => (b.slot.depth > a.slot.depth ? b : a));
  };
  const outfieldOf = (team: Team) => bodies.filter((b) => b.team === team && !b.keeper);
  /** x of the goal line a team attacks. */
  const goalLineOf = (team: Team) => (signOf(team) > 0 ? PITCH_LENGTH : 0);
  const label = (b: Body) => `#${b.info.number} ${b.info.name}`;

  let t = 0;
  let owner = null as Body | null;
  /** True once a held ball has been drawn in to the owner's foot. */
  let gathered = true;
  /** True while a thrower holds the ball over their head. */
  let held = false;
  let ball: BallState = { ...CENTRE, z: BALL_RADIUS, vx: 0, vy: 0, vz: 0 };
  let flight = null as Flight | null;
  let intent = null as Intent | null;
  let restart = null as Restart | null;
  /** The restart just taken, consumed by the taker's first decision. */
  let setPlay = null as { taker: Body; kind: RestartKind; indirect: boolean } | null;
  /** Last player to touch the ball; decides who gets a throw-in, corner or goal kick. */
  let lastTouch = null as Body | null;
  let nextAction = 1000;
  /** Set when this step contains a contact, so a snapshot is recorded at exactly this time. */
  let contact = false;

  const events: MatchEvent[] = [];
  const snapshots: Snapshot[] = [];
  const emit = (e: Omit<MatchEvent, "id" | "t">) => {
    events.push({ ...e, id: `sim-${events.length + 1}`, t });
    contact = true;
  };
  const ballPosition = (): Vec3 => ({ x: ball.x, y: ball.y, z: ball.z });
  const snap = (discontinuity = false) =>
    snapshots.push({
      t,
      players: bodies.map((b) => ({ ...b.state })),
      ball: ballPosition(),
      possession: owner ? { teamId: owner.team.id, playerId: owner.info.id } : null,
      ...(discontinuity ? { discontinuity: true } : {}),
    });

  const footOf = (b: Body): Vec3 => ({
    x: b.state.x + Math.cos(b.state.facing) * DRIBBLE_OFFSET,
    y: b.state.y + Math.sin(b.state.facing) * DRIBBLE_OFFSET,
    z: BALL_RADIUS,
  });
  const handsOf = (b: Body): Vec3 => ({
    x: b.state.x + Math.cos(b.state.facing) * THROW_REACH,
    y: b.state.y + Math.sin(b.state.facing) * THROW_REACH,
    z: THROW_HEIGHT,
  });
  const give = (b: Body, at?: Vec3) => {
    owner = b;
    lastTouch = b;
    gathered = false;
    held = false;
    flight = null;
    intent = null;
    ball = { ...(at ?? ballPosition()), vx: 0, vy: 0, vz: 0 };
    contact = true;
  };
  const place = (b: Body, hands = false) => {
    owner = b;
    lastTouch = b;
    gathered = true;
    held = hands;
    flight = null;
    intent = null;
    ball = { ...(hands ? handsOf(b) : footOf(b)), vx: 0, vy: 0, vz: 0 };
  };
  /** Stands `b` so the ball at `spot` is at their foot, facing `towards`. */
  const standAt = (b: Body, spot: Vec2, towards: Vec2) => {
    const facing = Math.atan2(towards.y - spot.y, towards.x - spot.x);
    Object.assign(b.state, {
      x: clamp(spot.x - Math.cos(facing) * DRIBBLE_OFFSET, 0, PITCH_LENGTH),
      y: clamp(spot.y - Math.sin(facing) * DRIBBLE_OFFSET, 0, PITCH_WIDTH),
      facing,
    });
  };
  const nearest = (candidates: Body[], to: Vec2): Body | null => {
    let best: Body | null = null;
    let bestD = Infinity;
    for (const c of candidates) {
      const d = distance(c.state, to);
      if (d < bestD) {
        best = c;
        bestD = d;
      }
    }
    return best;
  };
  const inPenaltyArea = (p: Vec2, defending: Team) =>
    Math.abs(p.x - goalLineOf(opponentOf(defending))) <= PENALTY_AREA_DEPTH &&
    Math.abs(p.y - CENTRE.y) <= PENALTY_AREA_HALF_WIDTH;
  /** x of the second-last defender of `defending`, the offside line for the other team. */
  const offsideLine = (defending: Team) => {
    const attackSign = -signOf(defending);
    const depths = bodies.filter((b) => b.team === defending).map((b) => b.state.x * attackSign);
    depths.sort((a, b) => b - a);
    return depths[1]! * attackSign;
  };
  /** Team-mates of `kicker` in an offside position right now. */
  const offsidePlayers = (kicker: Body): Set<Body> => {
    const sign = kicker.sign;
    const line = offsideLine(opponentOf(kicker.team)) * sign;
    const set = new Set<Body>();
    for (const b of bodies) {
      if (b.team !== kicker.team || b === kicker) continue;
      const depth = b.state.x * sign;
      if ((b.state.x - CENTRE.x) * sign > 0 && depth > ball.x * sign && depth > line) set.add(b);
    }
    return set;
  };

  /** Moves every opponent of `team` at least RESTART_DISTANCE away from `spot`. */
  const clearFrom = (spot: Vec2, team: Team) => {
    for (const b of bodies) {
      if (b.team === team) continue;
      const d = distance(b.state, spot);
      if (d >= RESTART_DISTANCE) continue;
      // Straight back towards their own goal when standing on the spot itself.
      const [dx, dy] = d > 1e-6 ? [(b.state.x - spot.x) / d, (b.state.y - spot.y) / d] : [-b.sign, 0];
      Object.assign(b.state, onPitch({ x: spot.x + dx * (RESTART_DISTANCE + 0.05), y: spot.y + dy * (RESTART_DISTANCE + 0.05) }));
    }
  };

  /**
   * Restart positions are placed directly (a dead-ball cut), so nothing has kept
   * players apart: anyone standing on top of someone else steps away from them,
   * the taker never moves. Visited in roster order, so this is deterministic.
   */
  const unstack = (taker: Body) => {
    for (let pass = 0; pass < 3; pass++)
      for (const b of bodies) {
        if (b === taker) continue;
        for (const o of bodies) {
          if (o === b) continue;
          const d = distance(b.state, o.state);
          if (d >= PLAYER_GAP) continue;
          const [dx, dy] = d > 1e-6 ? [(b.state.x - o.state.x) / d, (b.state.y - o.state.y) / d] : [-b.sign, 0];
          Object.assign(b.state, onPitch({ x: o.state.x + dx * (PLAYER_GAP + 0.01), y: o.state.y + dy * (PLAYER_GAP + 0.01) }));
        }
      }
  };

  /** Dead-ball cut to restart positions; never interpolated across by the viewer. */
  const setPiece = (team: Team, kind: "kickoff" | "goal-kick") => {
    for (const b of bodies) Object.assign(b.state, b.base, { facing: b.sign > 0 ? 0 : Math.PI });
    const taker = kind === "kickoff" ? strikerOf(team) : keeperOf(team);
    if (kind === "kickoff") {
      taker.state.x = CENTRE.x - taker.sign * DRIBBLE_OFFSET;
      taker.state.y = CENTRE.y;
      // Non-kicking opponents must stay outside the centre circle (straight out from the centre, so in their own half).
      clearFrom(CENTRE, team);
    }
    unstack(taker);
    place(taker);
    nextAction = t + 1000;
  };

  setPiece(teams[seed % 2]!, "kickoff");
  const startingState = { score: { home: 0, away: 0 }, possession: { teamId: owner!.team.id, playerId: owner!.info.id } };
  snap();

  // Movement ------------------------------------------------------------------

  const move = (b: Body, target: Vec2, speed: number, face: number | null) => {
    const s = b.state;
    const dx = target.x - s.x;
    const dy = target.y - s.y;
    const d = Math.hypot(dx, dy);
    let desired = face;
    if (d > 1e-3) {
      const step = Math.min(d, speed * DT);
      s.x += (dx / d) * step;
      s.y += (dy / d) * step;
      if (desired === null && d > 0.15) desired = Math.atan2(dy, dx);
    }
    // Standing players watch the ball.
    if (desired === null) desired = Math.atan2(ball.y - s.y, ball.x - s.x);
    const turn = clamp(angleDelta(s.facing, desired), -TURN_RATE * DT, TURN_RATE * DT);
    s.facing = angleDelta(0, s.facing + turn);
  };

  /**
   * Keeps players a body's width apart by pushing overlapping pairs away from
   * each other, then limits each player's movement this step to their top speed
   * and keeps them on the pitch. Pairs are visited in a fixed order, so this is
   * deterministic; any overlap left over is resolved in the following steps.
   */
  const separate = (from: Vec2[]) => {
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i]!.state;
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j]!.state;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= PLAYER_GAP) continue;
        if (d < 1e-6) [dx, dy, d] = [i % 2 === 0 ? 1 : -1, 0, 1];
        const push = (PLAYER_GAP - d) / 2;
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
      }
    }
    const limit = MAX_PLAYER_SPEED * DT;
    bodies.forEach((b, i) => {
      const s = b.state;
      const o = from[i]!;
      const d = Math.hypot(s.x - o.x, s.y - o.y);
      if (d > limit) {
        s.x = o.x + ((s.x - o.x) / d) * limit;
        s.y = o.y + ((s.y - o.y) / d) * limit;
      }
      s.x = clamp(s.x, 0, PITCH_LENGTH);
      s.y = clamp(s.y, 0, PITCH_WIDTH);
    });
  };
  const positions = () => bodies.map((b) => ({ x: b.state.x, y: b.state.y }));

  /** Where `b` takes up position off the ball, from their slot, its movement profile, the ball and which team has it. */
  const formationSpot = (b: Body, attacking: Team | null): Vec2 => {
    const p = MOVEMENT_PROFILES[b.slot.position];
    const phase = attacking === null ? 0 : attacking === b.team ? 1 : -1;
    // The ball in the team's own frame: depth from its goal line, lateral to its left.
    const ballDepth = b.sign > 0 ? ball.x : PITCH_LENGTH - ball.x;
    const ballLateral = b.sign > 0 ? CENTRE.y - ball.y : ball.y - CENTRE.y;
    let depth = b.slot.depth + (phase > 0 ? p.push : phase < 0 ? -p.drop : 0) + (ballDepth - CENTRE.x) * p.follow;
    if (phase < 0 && p.recover !== null) depth = Math.max(4, Math.min(depth, ballDepth + p.recover));
    const lateral = b.slot.lateral * (phase > 0 ? p.width : phase < 0 ? p.tuck : 1) + ballLateral * p.slide;
    const spot = slotSpot({ depth, lateral }, b.team.attacksTowards);
    return { x: clamp(spot.x, 2, PITCH_LENGTH - 2), y: clamp(spot.y, 2, PITCH_WIDTH - 2) };
  };
  const keeperSpot = (b: Body): Vec2 => ({ x: b.base.x, y: clamp(ball.y, 30.5, 37.5) });
  const ballLead = (): Vec2 => ({
    x: clamp(ball.x + ball.vx * 0.25, 0.5, PITCH_LENGTH - 0.5),
    y: clamp(ball.y + ball.vy * 0.25, 0.5, PITCH_WIDTH - 0.5),
  });
  const kickDirection = (from: Body, i: Intent) => {
    const to = i.kind === "pass" ? i.receiver.state : i.target;
    return Math.atan2(to.y - from.state.y, to.x - from.state.x);
  };

  const movePlayers = () => {
    const start = positions();
    const attacking = owner?.team ?? flight?.from.team ?? null;
    const outfield = bodies.filter((b) => !b.keeper);
    // One opponent closes down an outfield carrier; a loose ball draws one chaser per team.
    const presser =
      owner && !owner.keeper && !held ? nearest(outfield.filter((b) => b.team !== owner!.team), owner.state) : null;
    const chasers = flight?.loose ? teams.map((team) => nearest(outfield.filter((b) => b.team === team), ballLead())) : [];
    // The opponent closest to a pass's remaining path steps in to cut it out.
    let cutter: Body | null = null;
    let cutPoint: Vec2 = CENTRE;
    if (flight?.kind === "pass" && !flight.loose) {
      const aim = { ...flight.aim, z: 0 };
      let best = CUT_OUT_RANGE;
      for (const b of outfield) {
        if (b.team === flight.from.team) continue;
        const a = approach(ball, aim, b.state);
        if (a.gap < best) [cutter, cutPoint, best] = [b, a.at, a.gap];
      }
    }
    // Near goal, a second defender closes the angle between the carrier and the goal, ready to block a shot.
    let cover: Body | null = null;
    let coverPoint: Vec2 = CENTRE;
    if (owner && !owner.keeper && !held) {
      const goal = { x: goalLineOf(owner.team), y: CENTRE.y };
      const d = distance(owner.state, goal);
      if (d < COVER_RANGE && d > COVER_DISTANCE + 1) {
        coverPoint = {
          x: owner.state.x + ((goal.x - owner.state.x) / d) * COVER_DISTANCE,
          y: owner.state.y + ((goal.y - owner.state.y) / d) * COVER_DISTANCE,
        };
        cover = nearest(outfield.filter((b) => b.team !== owner!.team && b !== presser), coverPoint);
      }
    }
    // Forwards of the attacking team time runs along the defenders' offside line, sometimes drifting beyond it.
    const runLine = attacking ? offsideLine(opponentOf(attacking)) : 0;

    for (const b of bodies) {
      const s = b.state;
      if (b === owner) {
        if (held) {
          // A thrower stays on the line and only turns.
          move(b, s, 0, intent ? kickDirection(b, intent) : s.facing);
        } else if (intent) {
          // Plant and turn to face the kick.
          move(b, { x: s.x + Math.cos(s.facing), y: s.y + Math.sin(s.facing) }, WINDUP_SPEED, kickDirection(b, intent));
        } else if (b.keeper) {
          move(b, s, 0, b.sign > 0 ? 0 : Math.PI);
        } else {
          const ahead = { x: clamp(s.x + b.sign * 5, 2, PITCH_LENGTH - 2), y: clamp(s.y + (CENTRE.y - s.y) * 0.15, 3, PITCH_WIDTH - 3) };
          move(b, ahead, DRIBBLE_SPEED, null);
        }
      } else if (flight?.intended === b && !flight.loose) {
        // Hold the aim point, then attack the ball once it is close and playable.
        const close = distance(s, ball) < 6 && ball.z < CONTROL_HEIGHT;
        move(b, close ? ballLead() : flight.aim, MAX_PLAYER_SPEED, null);
      } else if (chasers.includes(b)) {
        move(b, ballLead(), MAX_PLAYER_SPEED, null);
      } else if (b.keeper) {
        let target = keeperSpot(b);
        let speed = MAX_PLAYER_SPEED;
        if (flight?.kind === "shot" && flight.from.team !== b.team && !flight.loose) {
          // Move across the line towards where the shot will arrive, after a reaction delay.
          speed = KEEPER_SPEED;
          const eta = Math.abs(ball.vx) > 0.5 ? (s.x - ball.x) / ball.vx : -1;
          target = t < flight.reactT || eta <= 0 ? s : { x: b.base.x, y: clamp(ball.y + ball.vy * eta, 29.5, 38.5) };
        }
        // Goalkeepers shuffle across their goal while facing the ball, so they can dive either way.
        move(b, target, speed, Math.atan2(ball.y - s.y, ball.x - s.x));
      } else if (b === cutter) {
        move(b, cutPoint, MAX_PLAYER_SPEED, null);
      } else if (b === presser) {
        move(b, owner!.state, PRESS_SPEED, null);
      } else if (b === cover) {
        move(b, coverPoint, MAX_PLAYER_SPEED, null);
      } else {
        const spot = formationSpot(b, attacking);
        if (MOVEMENT_PROFILES[b.slot.position].runs && attacking === b.team) {
          const run = Math.sin(t / 2600 + b.info.number * 1.7) * 3 - 1;
          spot.x = clamp(runLine + b.sign * run, 2, PITCH_LENGTH - 2);
        }
        move(b, spot, MAX_PLAYER_SPEED, null);
      }
    }
    separate(start);
  };

  // Kicks ---------------------------------------------------------------------

  const release = (
    from: Body,
    f: Pick<Flight, "kind" | "intended" | "aim" | "arriveT" | "reactT">,
    v: Vec3,
    exempt: boolean,
  ) => {
    const start = ballPosition();
    ball = { ...start, vx: v.x, vy: v.y, vz: v.z };
    flight = {
      ...f,
      from,
      startT: t,
      start,
      barred: new Map([[from, t + KICK_RECOVERY_MS]]),
      loose: false,
      offside: exempt ? new Set() : offsidePlayers(from),
      turned: null,
    };
    owner = null;
    lastTouch = from;
    held = false;
    intent = null;
    contact = true;
  };

  const strikePass = (from: Body, i: Extract<Intent, { kind: "pass" }>) => {
    const { receiver, lofted, thrown } = i;
    const range = distance(ball, receiver.state);
    const spread = 0.2 + 0.02 * range;
    const aim = {
      x: clamp(receiver.state.x + (rng() * 2 - 1) * spread, 1, PITCH_LENGTH - 1),
      y: clamp(receiver.state.y + (rng() * 2 - 1) * spread, 1, PITCH_WIDTH - 1),
    };
    const d = Math.max(0.5, distance(ball, aim));
    // A mishit is dragged off line and overhit; the receiver still runs to where it was meant to go.
    const mishit = !thrown && rng() < MISHIT_CHANCE;
    const skew = mishit ? (rng() < 0.5 ? -1 : 1) * (0.15 + rng() * 0.2) : 0;
    const heading = Math.atan2(aim.y - ball.y, aim.x - ball.x) + skew;
    const dir = { x: Math.cos(heading), y: Math.sin(heading) };
    const touch = mishit ? 1.2 + rng() * 0.3 : 0.96 + rng() * 0.08;
    let speed: number;
    let lift = 0;
    let seconds: number;
    if (thrown) {
      // From the hands, dropping onto the aim point.
      seconds = 0.35 + d / 16;
      speed = d / seconds;
      lift = loftLaunchSpeed(BALL_RADIUS - ball.z, seconds);
    } else if (lofted) {
      // Fixed launch angle; the ball lands on the aim point.
      speed = Math.sqrt((d * 9.81) / Math.sin(2 * LOFT_ANGLE)) * Math.cos(LOFT_ANGLE);
      seconds = d / speed;
      lift = loftLaunchSpeed(0, seconds);
    } else {
      speed = Math.min(MAX_GROUND_PASS_SPEED, rollLaunchSpeed(d, GROUND_PASS_ARRIVAL_SPEED)) * touch;
      seconds = rollTravelTime(d, speed);
      if (!Number.isFinite(seconds)) seconds = 3;
    }
    release(
      from,
      { kind: "pass", intended: receiver, aim, arriveT: t + seconds * 1000, reactT: 0 },
      { x: dir.x * speed, y: dir.y * speed, z: lift },
      i.exempt,
    );
  };

  const strikeShot = (from: Body, aim: Vec3, speed: number) => {
    const d = Math.max(0.5, distance(ball, aim));
    // From close in, a shot cannot climb more steeply than about 30°, or it would leave the foot implausibly fast.
    const target = { ...aim, z: Math.min(aim.z, ball.z + d * 0.6) };
    const seconds = d / speed;
    emit({
      type: "shot",
      teamId: from.team.id,
      playerId: from.info.id,
      outcome: "pending",
      start: ballPosition(),
      description: `Shot by ${label(from)}`,
    });
    release(
      from,
      {
        kind: "shot",
        intended: null,
        aim: { x: target.x, y: target.y },
        arriveT: t + seconds * 1000,
        reactT: t + 200 + Math.floor(rng() * 10) * STEP_MS,
      },
      {
        x: ((target.x - ball.x) / d) * speed,
        y: ((target.y - ball.y) / d) * speed,
        z: loftLaunchSpeed(target.z - ball.z, seconds),
      },
      false,
    );
  };

  // Stoppages -----------------------------------------------------------------

  /** Stops play with the ball where it is; the restart follows after the dead-ball pause. */
  const stopPlay = (next: Omit<Restart, "until" | "net">) => {
    owner = null;
    held = false;
    flight = null;
    intent = null;
    ball.vx = 0;
    ball.vy = 0;
    restart = { ...next, net: 0, until: t + DEAD_BALL_MS };
  };

  const commitFoul = (fouler: Body, victim: Body) => {
    const at = ballPosition();
    const penalty = inPenaltyArea(at, fouler.team);
    emit({
      type: "foul",
      teamId: fouler.team.id,
      playerId: fouler.info.id,
      outcome: "committed",
      start: at,
      description: `Foul by ${label(fouler)} on ${label(victim)}${penalty ? " in the area" : ""}`,
    });
    stopPlay({ kind: penalty ? "penalty" : "free-kick", team: victim.team, at, taker: victim, still: [fouler, victim] });
  };

  /** Emits a shot's result unless it was scored. `by` is whoever ended its flight, if anyone did. */
  const shotResult = (f: Flight, at: Vec3, by: Body | null) => {
    const shooter = label(f.from);
    const caught = !!by && by.keeper && by.team !== f.from.team && !f.loose;
    let outcome: MatchEvent["outcome"] = "missed";
    let description = by ? `Shot by ${shooter} comes to nothing` : `Shot by ${shooter} misses the target`;
    if (caught) {
      outcome = "saved";
      description = `Shot by ${shooter} saved by ${label(by)}`;
    } else if (f.turned?.kind === "parry") {
      outcome = "saved";
      description = `Shot by ${shooter} saved by ${label(f.turned.by!)}`;
    } else if (f.turned?.kind === "block") {
      outcome = "blocked";
      description = `Shot by ${shooter} blocked by ${label(f.turned.by!)}`;
    } else if (f.turned?.kind === "woodwork") {
      description = `Shot by ${shooter} comes back off the woodwork`;
    } else if (by && f.loose) {
      description = `Shot by ${shooter} runs out of pace`;
    }
    emit({ type: "shot-result", teamId: f.from.team.id, playerId: f.from.info.id, outcome, startT: f.startT, end: at, description });
    return caught;
  };

  const callOffside = (f: Flight, by: Body, at: Vec3) => {
    if (f.kind === "shot") shotResult(f, at, by);
    ball = { ...at, vx: ball.vx, vy: ball.vy, vz: ball.vz };
    emit({
      type: "offside",
      teamId: by.team.id,
      playerId: by.info.id,
      outcome: "flagged",
      startT: f.startT,
      start: f.start,
      end: at,
      description: `${label(by)} is offside`,
    });
    stopPlay({ kind: "free-kick", team: opponentOf(by.team), at, indirect: true });
  };

  /** The carrier picks its next action; kicks become an intent that is struck once the player has turned. */
  const decide = (from: Body) => {
    const s = from.state;
    const play = setPlay?.taker === from ? setPlay : null;
    setPlay = null;
    const opponents = bodies.filter((b) => b.team !== from.team);
    const team = bodies.filter((b) => b.team === from.team && b !== from);
    const goal = { x: goalLineOf(from.team), y: CENTRE.y };
    const depth = Math.abs(goal.x - s.x);
    const pick = <T>(list: T[]) => list[Math.floor(rng() * list.length)];

    if (play?.kind === "penalty") {
      const side = rng() < 0.5 ? -1 : 1;
      const target = { x: goal.x, y: goal.y + side * (0.4 + rng() * 3.1), z: 0.3 + rng() * 1.9 };
      intent = { kind: "shot", since: t, target, speed: 22 + rng() * 6 };
      return;
    }
    if (play?.kind === "throw-in" || play?.kind === "corner") {
      // Throw-ins go to a nearby team-mate; corners are crossed to an attacker in the area.
      const options =
        play.kind === "throw-in"
          ? team.filter((b) => !b.keeper && distance(b.state, s) > 4 && distance(b.state, s) < 22)
          : team.filter((b) => inPenaltyArea(b.state, opponentOf(from.team)));
      const receiver = pick(options) ?? nearest(team.filter((b) => !b.keeper), s)!;
      intent = { kind: "pass", since: t, receiver, lofted: true, thrown: play.kind === "throw-in", exempt: true };
      return;
    }

    const tackler = from.keeper || play ? null : nearest(opponents.filter((b) => distance(b.state, ball) < TACKLE_RANGE), ball);
    if (tackler) {
      const challenge = rng();
      if (challenge < TACKLE_CHANCE) {
        give(tackler);
        emit({
          type: "turnover",
          teamId: tackler.team.id,
          playerId: tackler.info.id,
          outcome: "won",
          start: ballPosition(),
          description: `${label(tackler)} wins the ball from ${label(from)}`,
        });
        nextAction = t + 900;
        return;
      }
      if (challenge < TACKLE_CHANCE + FOUL_CHANCE) {
        commitFoul(tackler, from);
        return;
      }
    }
    if (
      !from.keeper &&
      !play?.indirect &&
      distance(s, goal) < 28 &&
      Math.abs(s.y - goal.y) < depth * 0.9 + 6 &&
      rng() < 0.65
    ) {
      // Aim somewhere around the frame; wide and high aims miss on their own.
      const target = { x: goal.x, y: goal.y + (rng() * 2 - 1) * 4.3, z: 0.25 + rng() * 2.6 };
      intent = { kind: "shot", since: t, target, speed: 21 + rng() * 6 };
    } else if (!play && rng() < 0.4) {
      // Carry into space before reconsidering a pass.
      nextAction = t + 1200;
    } else {
      const candidates = team.filter((b) => {
        const d = distance(b.state, s);
        return d > 3 && d < 35;
      });
      candidates.sort((a, b) => (b.state.x - a.state.x) * from.sign);
      let receiver = pick(candidates.slice(0, 3));
      const offside = offsidePlayers(from);
      if (receiver && offside.has(receiver) && rng() < OFFSIDE_AWARENESS) {
        receiver = pick(candidates.filter((b) => !offside.has(b)).slice(0, 3));
      }
      if (!receiver) {
        nextAction = t + 600;
        return;
      }
      const lane = { x: receiver.state.x - s.x, y: receiver.state.y - s.y };
      const len2 = lane.x * lane.x + lane.y * lane.y;
      const blocked = opponents.some((b) => {
        const u = ((b.state.x - s.x) * lane.x + (b.state.y - s.y) * lane.y) / len2;
        return u > 0.1 && u < 0.9 && distance(b.state, { x: s.x + u * lane.x, y: s.y + u * lane.y }) < 2.5;
      });
      // Long balls are chipped; a blocked lane is chipped over only some of the time.
      const lofted = Math.sqrt(len2) > 26 || (blocked && rng() < 0.5);
      // Offside does not apply to the first pass from a goal kick.
      intent = { kind: "pass", since: t, receiver, lofted, thrown: false, exempt: play?.kind === "goal-kick" };
    }
  };

  // Free ball -----------------------------------------------------------------

  const settle = () => (nextAction = t + 800 + Math.floor(rng() * 8) * 100);

  /** The ball has left the pitch (or entered a goal): resolve the kick and stop play. */
  const leavePitch = (f: Flight, at: Vec3, end: -1 | 0 | 1) => {
    flight = null;
    const until = t + DEAD_BALL_MS;
    if (end === 0) {
      // Over a touchline: a throw-in to the team that did not touch it last, where it went out.
      if (f.kind === "shot") shotResult(f, at, null);
      else passOut(f, at);
      const spot = { x: clamp(at.x, 1, PITCH_LENGTH - 1), y: at.y < CENTRE.y ? 0 : PITCH_WIDTH };
      restart = { kind: "throw-in", team: opponentOf(lastTouch!.team), at: spot, net: 0, until };
      return;
    }
    const defenders = teams.find((team) => signOf(team) !== end)!;
    const attackers = opponentOf(defenders);
    const scored = Math.abs(at.y - CENTRE.y) < GOAL_WIDTH / 2 - BALL_RADIUS && at.z < GOAL_HEIGHT - BALL_RADIUS;
    if (scored) {
      const own = f.from.team !== attackers;
      emit({
        type: "goal",
        teamId: attackers.id,
        ...(own ? {} : { playerId: f.from.info.id }),
        outcome: "scored",
        startT: f.startT,
        end: at,
        description: own ? `Own goal by ${label(f.from)}` : `Goal! ${label(f.from)} scores for ${attackers.name}`,
      });
      restart = { kind: "kickoff", team: defenders, at: CENTRE, net: end, until };
      return;
    }
    if (f.kind === "shot") shotResult(f, at, null);
    else passOut(f, at);
    // Over the goal line: a corner if a defender touched it last, otherwise a goal kick.
    restart =
      lastTouch!.team === defenders
        ? { kind: "corner", team: attackers, at: { x: end > 0 ? PITCH_LENGTH : 0, y: at.y < CENTRE.y ? 0 : PITCH_WIDTH }, net: 0, until }
        : { kind: "goal-kick", team: defenders, at: CENTRE, net: 0, until };
  };

  const passOut = (f: Flight, at: Vec3) =>
    emit({
      type: "pass",
      teamId: f.from.team.id,
      playerId: f.from.info.id,
      recipientId: f.intended!.info.id,
      outcome: "missed",
      startT: f.startT,
      start: f.start,
      end: at,
      description: `Pass by ${label(f.from)} runs out of play`,
    });

  const collect = (f: Flight, by: Body, at: Vec3) => {
    if (f.offside.has(by)) {
      callOffside(f, by, at);
      return;
    }
    give(by, at);
    let saved = false;
    if (f.kind === "shot") {
      saved = shotResult(f, at, by);
    } else if (by !== f.from) {
      const complete = by.team === f.from.team;
      emit({
        type: "pass",
        teamId: f.from.team.id,
        playerId: f.from.info.id,
        recipientId: (complete ? by : f.intended!).info.id,
        outcome: complete ? "complete" : "intercepted",
        startT: f.startT,
        start: f.start,
        end: at,
        description: complete ? `Pass ${label(f.from)} → ${label(by)}` : `Pass by ${label(f.from)} intercepted`,
      });
    }
    if (by.team !== f.from.team && !saved)
      emit({
        type: "turnover",
        teamId: by.team.id,
        playerId: by.info.id,
        outcome: "won",
        start: at,
        description: `${label(by)} wins possession`,
      });
    settle();
  };

  /** The ball changes direction off a player or the frame without anyone controlling it. */
  const deflect = (f: Flight, at: BallState, v: Vec3, by: Body | null, what: string) => {
    ball = { x: at.x, y: at.y, z: Math.max(BALL_RADIUS, at.z), vx: v.x, vy: v.y, vz: v.z };
    f.loose = true;
    contact = true;
    if (by) {
      lastTouch = by;
      f.barred.set(by, Math.max(f.barred.get(by) ?? 0, t + DEFLECT_RECOVERY_MS));
    }
    emit({
      type: "deflection",
      teamId: (by ?? f.from).team.id,
      ...(by ? { playerId: by.info.id } : {}),
      outcome: "deflected",
      start: ballPosition(),
      description: what,
    });
  };

  /** Reflects velocity `v` off a surface with unit normal `n`, keeping `e` of the normal component. */
  const reflect = (v: Vec3, n: Vec3, e: number): Vec3 => {
    const vn = v.x * n.x + v.y * n.y + v.z * n.z;
    return { x: v.x - (1 + e) * vn * n.x, y: v.y - (1 + e) * vn * n.y, z: v.z - (1 + e) * vn * n.z };
  };

  /** Bounces the ball off a player's body: reflected off the side it hit, slowed, popped up a little. */
  const bodyDeflection = (f: Flight, by: Body, at: BallState) => {
    const nx = at.x - by.state.x;
    const ny = at.y - by.state.y;
    const n = Math.hypot(nx, ny) || 1;
    const out = reflect({ x: at.vx, y: at.vy, z: 0 }, { x: nx / n, y: ny / n, z: 0 }, BODY_RESTITUTION);
    const turn = (rng() * 2 - 1) * 0.25;
    const keep = 0.6 + rng() * 0.2;
    const v = {
      x: (out.x * Math.cos(turn) - out.y * Math.sin(turn)) * keep,
      y: (out.x * Math.sin(turn) + out.y * Math.cos(turn)) * keep,
      z: Math.abs(at.vz) * 0.3 + rng() * 2.5,
    };
    const what = f.kind === "shot" && !f.turned ? `Blocked by ${label(by)}` : `Deflected off ${label(by)}`;
    if (f.kind === "shot") f.turned ??= { kind: "block", by };
    deflect(f, at, v, by, what);
  };

  /** A goalkeeper gets a hand to a shot but cannot hold it: pushed round the post, or back out and wide. */
  const parry = (f: Flight, keeper: Body, at: BallState) => {
    const speed = Math.hypot(at.vx, at.vy);
    const side = rng() < 0.5 ? -1 : 1;
    const round = rng() < 0.6;
    const heading = Math.atan2(at.vy, at.vx) + (round ? side * (0.9 + rng() * 0.4) : Math.PI + side * (0.9 + rng() * 0.9));
    const keep = round ? 0.5 + rng() * 0.2 : 0.3 + rng() * 0.2;
    f.turned ??= { kind: "parry", by: keeper };
    deflect(
      f,
      at,
      { x: Math.cos(heading) * speed * keep, y: Math.sin(heading) * speed * keep, z: 1 + rng() * 3 },
      keeper,
      `Parried by ${label(keeper)}`,
    );
  };

  const moveFreeBall = (f: Flight) => {
    const prev: BallState = { ...ball };
    const step = stepBall(ball, STEP_MS);
    const next = step.state;
    if (step.bounces > 0) contact = true;
    f.loose ||= t > f.arriveT + 500 || (!isAirborne(next) && horizontalSpeed(next) < (f.kind === "shot" ? 4 : 2));

    const hits: Hit[] = [];

    // Out of play once the whole ball is over a line; whether it is a goal is decided in leavePitch.
    const overEnd = next.x > PITCH_LENGTH + BALL_RADIUS ? 1 : next.x < -BALL_RADIUS ? -1 : 0;
    const overSide = next.y < -BALL_RADIUS ? -1 : next.y > PITCH_WIDTH + BALL_RADIUS ? 1 : 0;
    const crossing = (axis: "x" | "y", line: number) => {
      const k = (line - prev[axis]) / (next[axis] - prev[axis]);
      const at = lerpBall(prev, next, k);
      return { k, at: { x: at.x, y: at.y, z: at.z } };
    };
    if (overEnd !== 0) {
      const { k, at } = crossing("x", overEnd > 0 ? PITCH_LENGTH + BALL_RADIUS : -BALL_RADIUS);
      hits.push({ u: k, kind: "out", at, end: overEnd });
    }
    if (overSide !== 0) {
      const { k, at } = crossing("y", overSide > 0 ? PITCH_WIDTH + BALL_RADIUS : -BALL_RADIUS);
      hits.push({ u: k, kind: "out", at, end: 0 });
    }

    // The woodwork: posts are upright cylinders on the goal line, the crossbar a cylinder across the top.
    const frame = POST_RADIUS + BALL_RADIUS;
    for (const line of [0, PITCH_LENGTH]) {
      if (Math.min(Math.abs(prev.x - line), Math.abs(next.x - line)) > 2) continue;
      for (const side of [-1, 1]) {
        const py = CENTRE.y + (side * GOAL_WIDTH) / 2;
        const u = sweep(prev.x, prev.y, next.x, next.y, line, py, frame);
        if (u === null) continue;
        const at = lerpBall(prev, next, u);
        if (at.z > GOAL_HEIGHT) continue;
        hits.push({ u, kind: "frame", part: "post", normal: { x: (at.x - line) / frame, y: (at.y - py) / frame, z: 0 } });
      }
      const u = sweep(prev.x, prev.z, next.x, next.z, line, GOAL_HEIGHT, frame);
      if (u !== null) {
        const at = lerpBall(prev, next, u);
        if (Math.abs(at.y - CENTRE.y) <= GOAL_WIDTH / 2)
          hits.push({ u, kind: "frame", part: "crossbar", normal: { x: (at.x - line) / frame, y: 0, z: (at.z - GOAL_HEIGHT) / frame } });
      }
    }

    // Players the ball comes within reach of.
    const travelled = distance(next, f.start);
    for (const b of bodies) {
      if ((f.barred.get(b) ?? -Infinity) > t) continue;
      const opponent = b.team !== f.from.team;
      let reach = CONTROL_REACH;
      let height = CONTROL_HEIGHT;
      let chance = 1;
      let controls = true;
      let solid = false;
      if (f.loose) {
        // Anyone, including the kicker, may pick up a loose ball.
      } else if (f.kind === "shot") {
        if (!opponent) continue;
        if (b.keeper) [reach, height, chance] = [KEEPER_REACH, KEEPER_HEIGHT, SAVE_CHANCE];
        else [controls, solid] = [false, travelled >= BLOCK_MIN_TRAVEL];
      } else if (opponent) {
        if (travelled < INTERCEPT_MIN_TRAVEL) continue;
        [reach, height, chance, solid] = [INTERCEPT_REACH, INTERCEPT_HEIGHT, INTERCEPT_CHANCE, true];
      } else if (b !== f.intended) {
        continue;
      }
      if (controls) {
        const a = approach(prev, next, b.state);
        if (a.gap <= reach && a.at.z <= height && (f.loose || distance(a.at, f.start) >= CONTACT_MIN_TRAVEL)) {
          hits.push({ u: a.u, kind: "control", by: b, at: a.at, chance, solid });
          continue;
        }
      }
      if (solid) {
        const u = sweep(prev.x, prev.y, next.x, next.y, b.state.x, b.state.y, f.kind === "shot" ? BLOCK_REACH : BODY_REACH);
        if (u !== null && lerpBall(prev, next, u).z <= BODY_HEIGHT) hits.push({ u, kind: "body", by: b });
      }
    }

    // Resolve the earliest contact; equal fractions keep the order above.
    hits.sort((a, b) => a.u - b.u);
    for (const hit of hits) {
      if (hit.kind === "out") {
        ball = next;
        leavePitch(f, hit.at, hit.end);
        contain(restart!.net);
        return;
      }
      if (hit.kind === "frame") {
        const at = lerpBall(prev, next, hit.u);
        const v = reflect({ x: at.vx, y: at.vy, z: at.vz }, hit.normal, WOODWORK_RESTITUTION);
        if (f.kind === "shot") f.turned ??= { kind: "woodwork", by: null };
        const kick = f.kind === "shot" ? "Shot" : "Pass";
        deflect(f, at, v, null, `${kick} by ${label(f.from)} hits the ${hit.part}`);
        return;
      }
      if (hit.kind === "body") {
        bodyDeflection(f, hit.by, lerpBall(prev, next, hit.u));
        return;
      }
      // A controlling touch: held, or, when it fails, the ball may still strike the player.
      if (hit.chance >= 1 || rng() < hit.chance) {
        ball = next;
        collect(f, hit.by, hit.at);
        return;
      }
      if (hit.by.keeper && f.kind === "shot" && rng() < PARRY_CHANCE) {
        parry(f, hit.by, lerpBall(prev, next, hit.u));
        return;
      }
      f.barred.set(hit.by, Infinity);
      if (hit.solid) {
        const u = sweep(prev.x, prev.y, next.x, next.y, hit.by.state.x, hit.by.state.y, BODY_REACH);
        if (u !== null && lerpBall(prev, next, u).z <= BODY_HEIGHT) {
          bodyDeflection(f, hit.by, lerpBall(prev, next, u));
          return;
        }
      }
    }
    ball = next;
  };

  /** After the whistle the ball keeps moving until the net or the run-off stops it. */
  const contain = (net: -1 | 0 | 1) => {
    const stop = (axis: "x" | "y", value: number) => {
      ball[axis] = value;
      ball.vx = 0;
      ball.vy = 0;
    };
    if (net !== 0) {
      const back = net > 0 ? PITCH_LENGTH + NET_DEPTH - BALL_RADIUS : -NET_DEPTH + BALL_RADIUS;
      if ((ball.x - back) * net > 0) stop("x", back);
      const side = GOAL_WIDTH / 2 - BALL_RADIUS;
      if (Math.abs(ball.y - CENTRE.y) > side) stop("y", CENTRE.y + Math.sign(ball.y - CENTRE.y) * side);
      if (ball.z > GOAL_HEIGHT - BALL_RADIUS) {
        ball.z = GOAL_HEIGHT - BALL_RADIUS;
        ball.vz = Math.min(0, ball.vz);
      }
    } else {
      if (ball.x < -RUN_OFF || ball.x > PITCH_LENGTH + RUN_OFF)
        stop("x", clamp(ball.x, -RUN_OFF, PITCH_LENGTH + RUN_OFF));
      if (ball.y < -RUN_OFF || ball.y > PITCH_WIDTH + RUN_OFF)
        stop("y", clamp(ball.y, -RUN_OFF, PITCH_WIDTH + RUN_OFF));
    }
  };
  const moveDeadBall = (net: -1 | 0 | 1) => {
    const step = stepBall(ball, STEP_MS);
    ball = step.state;
    if (step.bounces > 0) contact = true;
    contain(net);
  };


  const takeRestart = (r: Restart) => {
    const attacking = r.team;
    const sign = signOf(attacking);
    const goal = { x: goalLineOf(attacking), y: CENTRE.y };
    let description: string;
    let indirect = false;
    switch (r.kind) {
      case "kickoff":
      case "goal-kick":
        setPiece(attacking, r.kind);
        description = r.kind === "kickoff" ? "Kickoff by the conceding team" : `Goal kick to ${attacking.name}`;
        break;
      case "throw-in": {
        // Taken from the touchline where the ball went out, holding the ball over the head.
        const taker = nearest(outfieldOf(attacking), r.at)!;
        const infield = r.at.y === 0 ? 1 : -1;
        Object.assign(taker.state, r.at, { facing: Math.atan2(infield * 4, (CENTRE.x - r.at.x) * 0.1 + sign) });
        place(taker, true);
        description = `Throw-in to ${attacking.name}`;
        break;
      }
      case "corner": {
        const spot = { x: r.at.x === 0 ? 1 : PITCH_LENGTH - 1, y: r.at.y === 0 ? 1 : PITCH_WIDTH - 1 };
        const taker = nearest(outfieldOf(attacking), spot)!;
        standAt(taker, spot, { x: goal.x - sign * PENALTY_SPOT_DISTANCE, y: CENTRE.y });
        // The most advanced attackers go into the area; each is picked up by the nearest free defender, goal-side.
        const runners = outfieldOf(attacking)
          .filter((b) => b !== taker)
          .sort((a, b) => b.base.x * sign - a.base.x * sign)
          .slice(0, CORNER_SPOTS.length);
        const markers = outfieldOf(opponentOf(attacking));
        runners.forEach((b, i) => {
          const [deep, across] = CORNER_SPOTS[i]!;
          Object.assign(b.state, { x: goal.x - sign * deep, y: CENTRE.y + across, facing: Math.atan2(spot.y - CENTRE.y, spot.x - b.state.x) });
          const marker = nearest(markers, b.state);
          if (!marker) return;
          markers.splice(markers.indexOf(marker), 1);
          Object.assign(marker.state, { x: b.state.x + sign * 1, y: b.state.y + 0.4 });
        });
        Object.assign(keeperOf(opponentOf(attacking)).state, { x: goal.x - sign * 1, y: CENTRE.y });
        place(taker);
        clearFrom(spot, attacking);
        description = `Corner to ${attacking.name}`;
        break;
      }
      case "free-kick": {
        const spot = onPitch(r.at, 1);
        const taker = r.taker && r.taker.team === attacking && !r.taker.keeper ? r.taker : nearest(outfieldOf(attacking), spot)!;
        standAt(taker, spot, goal);
        indirect = !!r.indirect;
        if (!indirect && distance(spot, goal) < WALL_RANGE) {
          // A three-player wall on the line from the ball to the middle of the goal.
          const ux = (goal.x - spot.x) / distance(spot, goal);
          const uy = (goal.y - spot.y) / distance(spot, goal);
          const wall = outfieldOf(opponentOf(attacking))
            .sort((a, b) => distance(a.state, spot) - distance(b.state, spot))
            .slice(0, 3);
          wall.forEach((b, i) => {
            const across = (i - 1) * 0.75;
            Object.assign(b.state, onPitch({ x: spot.x + ux * (RESTART_DISTANCE + 0.1) - uy * across, y: spot.y + uy * (RESTART_DISTANCE + 0.1) + ux * across }), {
              facing: Math.atan2(-uy, -ux),
            });
          });
        }
        place(taker);
        clearFrom(spot, attacking);
        description = `${indirect ? "Indirect free kick" : "Free kick"} to ${attacking.name}`;
        break;
      }
      case "penalty": {
        const spot = { x: goal.x - sign * PENALTY_SPOT_DISTANCE, y: CENTRE.y };
        const taker = strikerOf(attacking);
        const keeper = keeperOf(opponentOf(attacking));
        // Everyone else waits outside the area and the arc.
        bodies
          .filter((b) => b !== taker && b !== keeper)
          .forEach((b, i) => {
            Object.assign(b.state, {
              x: goal.x - sign * (PENALTY_AREA_DEPTH + 2.5 + (i % 3) * 1.5),
              y: CENTRE.y + ((i % 7) - 3) * 5 + (i % 2) * 1.2,
            });
          });
        Object.assign(keeper.state, { x: goal.x - sign * 0.5, y: CENTRE.y, facing: sign > 0 ? Math.PI : 0 });
        standAt(taker, spot, goal);
        place(taker);
        description = `Penalty to ${attacking.name}`;
        break;
      }
    }
    unstack(owner!);
    setPlay = { taker: owner!, kind: r.kind, indirect };
    nextAction = t + 1000;
    emit({
      type: r.kind,
      teamId: attacking.id,
      playerId: owner!.info.id,
      outcome: "taken",
      start: ballPosition(),
      description,
    });
  };

  // Formation changes --------------------------------------------------------

  const applied: AppliedFormationChange[] = [];
  let nextChange = 0;
  /**
   * Applies a scheduled change at the start of its step, before any restart or
   * movement in that step. Only slots and neutral spots change: players then
   * run to their new positions at normal speed. During a stoppage they drift
   * towards the restart positions of the new formation, and a kickoff or goal
   * kick taken at or after the change lines up in it.
   */
  const changeFormation = (c: ScheduledFormationChange) => {
    const team = teams.find((x) => x.id === c.teamId)!;
    const before = current.get(team.id)!;
    for (const b of bodies) {
      if (b.team !== team) continue;
      b.slot = formationSlot(c.formation, c.assignments[b.info.id]!)!;
      b.base = slotSpot(b.slot, team.attacksTowards);
    }
    current.set(team.id, { teamId: team.id, formation: c.formation, assignments: c.assignments });
    emit({
      type: "formation-change",
      teamId: team.id,
      outcome: "applied",
      description: `${team.name} switch from ${before.formation} to ${c.formation}`,
    });
    applied.push({
      eventId: events[events.length - 1]!.id,
      teamId: team.id,
      t,
      from: before.formation,
      to: c.formation,
      previousAssignments: before.assignments,
      assignments: c.assignments,
    });
  };

  // Main loop -----------------------------------------------------------------

  for (t = STEP_MS; t <= durationMs; t += STEP_MS) {
    contact = false;
    let cut = false;
    while (scheduled[nextChange]?.t === t) changeFormation(scheduled[nextChange++]!);
    if (restart) {
      const r: Restart = restart;
      if (t >= r.until) {
        restart = null;
        takeRestart(r);
        cut = true;
      } else {
        // Players drift towards where play will resume while the ball runs on; a fouled player stays down.
        const start = positions();
        for (const b of bodies) {
          if (r.still?.includes(b)) move(b, b.state, 0, null);
          else if (r.kind === "kickoff" || r.kind === "goal-kick") move(b, b.base, WALK_SPEED, null);
          else move(b, b.keeper ? keeperSpot(b) : formationSpot(b, r.team), WALK_SPEED, null);
        }
        separate(start);
        moveDeadBall(r.net);
      }
    } else {
      movePlayers();
      if (owner) {
        const carrier: Body = owner;
        if (held) {
          Object.assign(ball, handsOf(carrier));
        } else {
          const foot = footOf(carrier);
          const gap = Math.hypot(foot.x - ball.x, foot.y - ball.y, foot.z - ball.z);
          const reach = GATHER_SPEED * DT;
          if (gathered || gap <= reach) {
            Object.assign(ball, foot);
            gathered = true;
          } else {
            ball.x += ((foot.x - ball.x) / gap) * reach;
            ball.y += ((foot.y - ball.y) / gap) * reach;
            ball.z += ((foot.z - ball.z) / gap) * reach;
          }
        }
        if (intent) {
          // Strike once the ball is at the foot (or in the hands) and the player faces the kick.
          const i: Intent = intent;
          const aligned = Math.abs(angleDelta(carrier.state.facing, kickDirection(carrier, i))) < 0.2;
          if (gathered && aligned && t - i.since >= WINDUP_MS) {
            if (held) Object.assign(ball, handsOf(carrier));
            if (i.kind === "pass") strikePass(carrier, i);
            else strikeShot(carrier, i.target, i.speed);
          }
        } else if (gathered && t >= nextAction) {
          decide(carrier);
        }
      } else if (flight) {
        moveFreeBall(flight);
      }
    }
    if (contact || cut || t % SNAPSHOT_INTERVAL_MS === 0) snap(cut);
  }

  return {
    schemaVersion: "1.3.0",
    matchId: `sim-v${SIMULATOR_VERSION}-${seed}-${durationMs}-${configKey}`,
    title: `Generated match · seed ${seed} · ${initial.map((f) => f.formation).join(" v ")}`,
    synthetic: true,
    durationMs,
    teams,
    roster,
    startingState,
    snapshots,
    events,
    generator: { simulatorVersion: SIMULATOR_VERSION, seed, configKey },
    tactics: { initial, scheduled, applied },
  };
}
