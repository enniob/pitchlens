/**
 * Deterministic seeded match simulator. No renderer, wall clock or network
 * dependencies: the same seed and duration always produce the same fixture.
 *
 * The simulation advances in fixed STEP_MS steps. Every step moves the players,
 * then either carries the ball at its owner's foot or advances the free ball
 * with the physics in ./ball.ts. Outcomes are read off the ball's actual path:
 * a pass is received or intercepted when the ball comes within a player's
 * reach, a shot is saved when it comes within the goalkeeper's reach, and a
 * goal is scored when the whole ball crosses the line inside the frame.
 *
 * Snapshots are recorded every SNAPSHOT_INTERVAL_MS and additionally at every
 * contact step (kick, reception, tackle, save, bounce, line crossing), so each
 * event has a snapshot at exactly its timestamp. Playback only ever replays
 * these snapshots; nothing is re-simulated in the viewer.
 */
import {
  GOAL_HEIGHT,
  GOAL_WIDTH,
  PITCH_LENGTH,
  PITCH_WIDTH,
  type MatchEvent,
  type MatchFixture,
  type Player,
  type PlayerState,
  type Snapshot,
  type Team,
  type Vec2,
  type Vec3,
} from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
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

export interface SimulationOptions {
  seed: number;
  durationMs?: number;
}

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
/** An opponent this close to the ball at the carrier's feet can win it, m. */
export const TACKLE_RANGE = 1.8;
const WINDUP_MS = 160;
const DEAD_BALL_MS = 2000;
const INTERCEPT_CHANCE = 0.5;
/** A pass cannot be cut out until it has travelled this far from the kick, m. */
const INTERCEPT_MIN_TRAVEL = 2.5;
const TACKLE_CHANCE = 0.25;
const MISHIT_CHANCE = 0.06;
/** An opponent this close to a pass's path moves to cut it out, m. */
const CUT_OUT_RANGE = 5;
const SAVE_CHANCE = 0.65;
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

/** Base shape for a team attacking towards +x, in roster order (GK first). */
const SHAPE: [number, number][] = [
  [2.5, 34], [27, 56], [25, 42], [25, 26], [27, 12], [37, 34], [41, 23], [41, 45], [49, 58], [50, 34], [49, 10],
];

interface Body {
  info: Player;
  team: Team;
  /** +1 when attacking towards increasing x. */
  sign: 1 | -1;
  keeper: boolean;
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
  /** Players who got a touch but failed to hold the ball; they do not get a second attempt. */
  beaten: Set<Body>;
  /** Nobody is expected to receive it any more; anyone may collect it. */
  loose: boolean;
  /** Earliest time the defending goalkeeper reacts to a shot. */
  reactT: number;
}

type Intent =
  | { kind: "pass"; since: number; receiver: Body; lofted: boolean }
  | { kind: "shot"; since: number; target: Vec3; speed: number };

interface Restart {
  kind: "kickoff" | "goal-kick" | "throw-in";
  until: number;
  /** Team that restarts play. */
  team: Team;
  /** Which goal the ball is in (+1 = the x = 105 end), or 0. */
  net: -1 | 0 | 1;
  /** Where a throw-in restart is taken. */
  at: Vec2;
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

export function generateMatch({ seed, durationMs = 60_000 }: SimulationOptions): MatchFixture {
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

  const bodies: Body[] = [];
  for (const team of teams) {
    const sign = team.attacksTowards === "increasing-x" ? 1 : -1;
    roster
      .filter((p) => p.teamId === team.id)
      .forEach((info, i) => {
        const [x, y] = SHAPE[i]!;
        const base = { x: sign > 0 ? x : PITCH_LENGTH - x, y };
        bodies.push({
          info,
          team,
          sign,
          keeper: info.role === "GK",
          base,
          state: { playerId: info.id, ...base, facing: sign > 0 ? 0 : Math.PI },
        });
      });
  }
  // Snapshots list players in roster order.
  bodies.sort((a, b) => roster.indexOf(a.info) - roster.indexOf(b.info));
  const keeperOf = (team: Team) => bodies.find((b) => b.team === team && b.keeper)!;
  const strikerOf = (team: Team) => bodies.find((b) => b.team === team && b.info.number === 9)!;
  const label = (b: Body) => `#${b.info.number} ${b.info.name}`;

  let t = 0;
  let owner = null as Body | null;
  /** True once a held ball has been drawn in to the owner's foot. */
  let gathered = true;
  let ball: BallState = { ...CENTRE, z: BALL_RADIUS, vx: 0, vy: 0, vz: 0 };
  let flight = null as Flight | null;
  let intent = null as Intent | null;
  let restart = null as Restart | null;
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
  const give = (b: Body, at?: Vec3) => {
    owner = b;
    gathered = false;
    flight = null;
    intent = null;
    ball = { ...(at ?? ballPosition()), vx: 0, vy: 0, vz: 0 };
    contact = true;
  };
  const place = (b: Body) => {
    owner = b;
    gathered = true;
    flight = null;
    intent = null;
    ball = { ...footOf(b), vx: 0, vy: 0, vz: 0 };
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

  /** Dead-ball cut to restart positions; never interpolated across by the viewer. */
  const setPiece = (team: Team, kind: "kickoff" | "goal-kick") => {
    for (const b of bodies) Object.assign(b.state, b.base, { facing: b.sign > 0 ? 0 : Math.PI });
    const taker = kind === "kickoff" ? strikerOf(team) : keeperOf(team);
    if (kind === "kickoff") {
      taker.state.x = CENTRE.x - taker.sign * DRIBBLE_OFFSET;
      taker.state.y = CENTRE.y;
      // Non-kicking opponents must stay outside the centre circle.
      for (const b of bodies)
        if (b.team !== team && distance(b.state, CENTRE) < 9.15) b.state.x = CENTRE.x - b.sign * 10;
    }
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

  const formationSpot = (b: Body, attacking: Team | null): Vec2 => ({
    x: clamp(b.base.x + (ball.x - CENTRE.x) * 0.55 + (attacking === b.team ? b.sign * 14 : 0), 2, PITCH_LENGTH - 2),
    y: clamp(b.base.y + (ball.y - CENTRE.y) * 0.25, 2, PITCH_WIDTH - 2),
  });
  const ballLead = (): Vec2 => ({
    x: clamp(ball.x + ball.vx * 0.25, 0.5, PITCH_LENGTH - 0.5),
    y: clamp(ball.y + ball.vy * 0.25, 0.5, PITCH_WIDTH - 0.5),
  });
  const kickDirection = (from: Body, i: Intent) => {
    const to = i.kind === "pass" ? i.receiver.state : i.target;
    return Math.atan2(to.y - from.state.y, to.x - from.state.x);
  };

  const movePlayers = () => {
    const attacking = owner?.team ?? flight?.from.team ?? null;
    const outfield = bodies.filter((b) => !b.keeper);
    // One opponent closes down an outfield carrier; a loose ball draws one chaser per team.
    const presser = owner && !owner.keeper ? nearest(outfield.filter((b) => b.team !== owner!.team), owner.state) : null;
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

    for (const b of bodies) {
      const s = b.state;
      if (b === owner) {
        if (intent) {
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
        let target = { x: b.base.x, y: clamp(ball.y, 30.5, 37.5) };
        let speed = MAX_PLAYER_SPEED;
        if (flight?.kind === "shot" && flight.from.team !== b.team && !flight.loose) {
          // Move across the line towards where the shot will arrive, after a reaction delay.
          speed = KEEPER_SPEED;
          const eta = Math.abs(ball.vx) > 0.5 ? (s.x - ball.x) / ball.vx : -1;
          target = t < flight.reactT || eta <= 0 ? s : { x: b.base.x, y: clamp(ball.y + ball.vy * eta, 29.5, 38.5) };
        }
        move(b, target, speed, null);
      } else if (b === cutter) {
        move(b, cutPoint, MAX_PLAYER_SPEED, null);
      } else if (b === presser) {
        move(b, owner!.state, PRESS_SPEED, null);
      } else {
        move(b, formationSpot(b, attacking), MAX_PLAYER_SPEED, null);
      }
    }
  };

  // Kicks ---------------------------------------------------------------------

  const release = (from: Body, f: Pick<Flight, "kind" | "intended" | "aim" | "arriveT" | "reactT">, v: Vec3) => {
    const start = ballPosition();
    ball = { ...start, vx: v.x, vy: v.y, vz: v.z };
    flight = { ...f, from, startT: t, start, beaten: new Set(), loose: false };
    owner = null;
    intent = null;
    contact = true;
  };

  const strikePass = (from: Body, receiver: Body, lofted: boolean) => {
    const range = distance(ball, receiver.state);
    const spread = 0.2 + 0.02 * range;
    const aim = {
      x: clamp(receiver.state.x + (rng() * 2 - 1) * spread, 1, PITCH_LENGTH - 1),
      y: clamp(receiver.state.y + (rng() * 2 - 1) * spread, 1, PITCH_WIDTH - 1),
    };
    const d = Math.max(0.5, distance(ball, aim));
    // A mishit is dragged off line and overhit; the receiver still runs to where it was meant to go.
    const mishit = rng() < MISHIT_CHANCE;
    const skew = mishit ? (rng() < 0.5 ? -1 : 1) * (0.15 + rng() * 0.2) : 0;
    const heading = Math.atan2(aim.y - ball.y, aim.x - ball.x) + skew;
    const dir = { x: Math.cos(heading), y: Math.sin(heading) };
    const touch = mishit ? 1.2 + rng() * 0.3 : 0.96 + rng() * 0.08;
    let speed: number;
    let lift = 0;
    let seconds: number;
    if (lofted) {
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
    );
  };

  const strikeShot = (from: Body, target: Vec3, speed: number) => {
    const d = Math.max(0.5, distance(ball, target));
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
    );
  };

  /** The carrier picks its next action; kicks become an intent that is struck once the player has turned. */
  const decide = (from: Body) => {
    const s = from.state;
    const opponents = bodies.filter((b) => b.team !== from.team);
    const tackler = from.keeper ? null : nearest(opponents.filter((b) => distance(b.state, ball) < TACKLE_RANGE), ball);
    const goal = { x: from.sign > 0 ? PITCH_LENGTH : 0, y: CENTRE.y };
    const depth = Math.abs(goal.x - s.x);
    if (tackler && rng() < TACKLE_CHANCE) {
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
    } else if (!from.keeper && distance(s, goal) < 28 && Math.abs(s.y - goal.y) < depth * 0.9 + 6 && rng() < 0.65) {
      // Aim somewhere around the frame; wide and high aims miss on their own.
      const target = { x: goal.x, y: goal.y + (rng() * 2 - 1) * 4.3, z: 0.25 + rng() * 2.6 };
      intent = { kind: "shot", since: t, target, speed: 21 + rng() * 6 };
    } else if (rng() < 0.4) {
      // Carry into space before reconsidering a pass.
      nextAction = t + 1200;
    } else {
      const candidates = bodies.filter((b) => {
        const d = distance(b.state, s);
        return b.team === from.team && b !== from && d > 3 && d < 35;
      });
      candidates.sort((a, b) => (b.state.x - a.state.x) * from.sign);
      const receiver = candidates[Math.floor(rng() * Math.min(3, candidates.length))];
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
      intent = { kind: "pass", since: t, receiver, lofted };
    }
  };

  // Free ball -----------------------------------------------------------------

  const settle = () => (nextAction = t + 800 + Math.floor(rng() * 8) * 100);

  /** The ball has left the pitch (or entered a goal): resolve the kick and stop play. */
  const leavePitch = (f: Flight, at: Vec3, next: Omit<Restart, "until">, scored: boolean) => {
    const attackers = opponentOf(next.team);
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
    } else if (f.kind === "shot") {
      emit({
        type: "shot-result",
        teamId: f.from.team.id,
        playerId: f.from.info.id,
        outcome: "missed",
        startT: f.startT,
        end: at,
        description: `Shot by ${label(f.from)} misses the target`,
      });
    } else {
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
    }
    flight = null;
    restart = { ...next, until: t + DEAD_BALL_MS };
  };

  const collect = (f: Flight, by: Body, at: Vec3) => {
    give(by, at);
    if (f.kind === "shot") {
      const saved = by.keeper && by.team !== f.from.team && !f.loose;
      emit({
        type: "shot-result",
        teamId: f.from.team.id,
        playerId: f.from.info.id,
        outcome: saved ? "saved" : "missed",
        startT: f.startT,
        end: at,
        description: saved ? `Shot by ${label(f.from)} saved by ${label(by)}` : `Shot by ${label(f.from)} runs out of pace`,
      });
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
    if (by.team !== f.from.team && !(f.kind === "shot" && by.keeper && !f.loose))
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

  const moveFreeBall = (f: Flight) => {
    const prev = ballPosition();
    const step = stepBall(ball, STEP_MS);
    ball = step.state;
    if (step.bounces > 0) contact = true;

    // Out of play once the whole ball is over a line; a goal if that happens inside the frame.
    const overEnd = ball.x > PITCH_LENGTH + BALL_RADIUS ? 1 : ball.x < -BALL_RADIUS ? -1 : 0;
    if (overEnd !== 0) {
      const line = overEnd > 0 ? PITCH_LENGTH + BALL_RADIUS : -BALL_RADIUS;
      const k = (line - prev.x) / (ball.x - prev.x);
      const y = prev.y + (ball.y - prev.y) * k;
      const z = prev.z + (ball.z - prev.z) * k;
      const scored = Math.abs(y - CENTRE.y) < GOAL_WIDTH / 2 - BALL_RADIUS && z < GOAL_HEIGHT - BALL_RADIUS;
      const defenders = teams.find((team) => (team.attacksTowards === "increasing-x") !== overEnd > 0)!;
      const next = { kind: scored ? "kickoff" : "goal-kick", team: defenders, net: scored ? overEnd : 0, at: CENTRE } as const;
      // The event records where the ball crossed the line.
      leavePitch(f, { x: line, y, z }, next, scored);
      contain(next.net);
      return;
    }
    if (ball.y < -BALL_RADIUS || ball.y > PITCH_WIDTH + BALL_RADIUS) {
      const line = ball.y < 0 ? -BALL_RADIUS : PITCH_WIDTH + BALL_RADIUS;
      const k = (line - prev.y) / (ball.y - prev.y);
      const crossing = { x: prev.x + (ball.x - prev.x) * k, y: line, z: prev.z + (ball.z - prev.z) * k };
      const at = { x: clamp(crossing.x, 1, PITCH_LENGTH - 1), y: ball.y < 0 ? 1 : PITCH_WIDTH - 1 };
      leavePitch(f, crossing, { kind: "throw-in", team: opponentOf(f.from.team), at, net: 0 }, false);
      return;
    }

    f.loose ||= t > f.arriveT + 500 || (!isAirborne(ball) && horizontalSpeed(ball) < (f.kind === "shot" ? 4 : 2));

    // Players the ball came within reach of during this step, earliest first.
    const touches: { by: Body; u: number; at: Vec3; chance: number }[] = [];
    for (const b of bodies) {
      if (f.beaten.has(b)) continue;
      const opponent = b.team !== f.from.team;
      let reach = CONTROL_REACH;
      let height = CONTROL_HEIGHT;
      let chance = 1;
      if (f.loose) {
        // Anyone, including the kicker, may pick up a loose ball.
      } else if (f.kind === "shot") {
        if (!opponent || !b.keeper) continue;
        [reach, height, chance] = [KEEPER_REACH, KEEPER_HEIGHT, SAVE_CHANCE];
      } else if (opponent) {
        if (distance(ball, f.start) < INTERCEPT_MIN_TRAVEL) continue;
        [reach, height, chance] = [INTERCEPT_REACH, INTERCEPT_HEIGHT, INTERCEPT_CHANCE];
      } else if (b !== f.intended) {
        continue;
      }
      const a = approach(prev, ball, b.state);
      if (a.gap <= reach && a.at.z <= height) touches.push({ by: b, u: a.u, at: a.at, chance });
    }
    touches.sort((a, b) => a.u - b.u);
    for (const touch of touches) {
      if (touch.chance < 1 && rng() >= touch.chance) {
        f.beaten.add(touch.by);
        continue;
      }
      collect(f, touch.by, touch.at);
      return;
    }
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
    if (r.kind === "throw-in") {
      // Simplified: the nearest opponent restarts with the ball at their feet where it went out.
      const taker = nearest(bodies.filter((b) => b.team === r.team && !b.keeper), r.at)!;
      Object.assign(taker.state, r.at, { facing: Math.atan2(CENTRE.y - r.at.y, CENTRE.x - r.at.x) });
      place(taker);
      nextAction = t + 1000;
      emit({
        type: "turnover",
        teamId: r.team.id,
        playerId: taker.info.id,
        outcome: "won",
        start: ballPosition(),
        description: `${r.team.name} restart after the ball went out of play`,
      });
    } else {
      setPiece(r.team, r.kind);
      emit({
        type: r.kind,
        teamId: r.team.id,
        playerId: owner!.info.id,
        outcome: "taken",
        start: ballPosition(),
        description: r.kind === "kickoff" ? "Kickoff by the conceding team" : "Goal kick after the ball went out of play",
      });
    }
  };

  // Main loop -----------------------------------------------------------------

  for (t = STEP_MS; t <= durationMs; t += STEP_MS) {
    contact = false;
    let cut = false;
    if (restart) {
      const r: Restart = restart;
      if (t >= r.until) {
        restart = null;
        takeRestart(r);
        cut = true;
      } else {
        // Players drift towards where play will resume while the ball runs on.
        for (const b of bodies) move(b, r.kind === "throw-in" ? formationSpot(b, r.team) : b.base, WALK_SPEED, null);
        moveDeadBall(r.net);
      }
    } else {
      movePlayers();
      if (owner) {
        const carrier: Body = owner;
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
        if (intent) {
          // Strike once the ball is at the foot and the player faces the kick.
          const i: Intent = intent;
          const aligned = Math.abs(angleDelta(carrier.state.facing, kickDirection(carrier, i))) < 0.2;
          if (gathered && aligned && t - i.since >= WINDUP_MS) {
            if (i.kind === "pass") strikePass(carrier, i.receiver, i.lofted);
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
    schemaVersion: "1.1.0",
    matchId: `sim-v2-${seed}-${durationMs}`,
    title: `Generated match · seed ${seed}`,
    synthetic: true,
    durationMs,
    teams,
    roster,
    startingState,
    snapshots,
    events,
  };
}
