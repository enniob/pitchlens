/**
 * Deterministic ball physics for the seeded simulator. Pure functions only: no
 * renderer, wall clock or randomness. The simulator advances the ball with
 * `stepBall` at its fixed timestep and records the result in snapshots; the
 * renderer never integrates anything itself.
 *
 * Model (deliberately small — not a rigid-body engine):
 *   - airborne: constant gravity, no drag, integrated exactly per step
 *   - ground impact: vertical speed scaled by a restitution factor, horizontal
 *     speed scaled by a scrub factor; weak impacts settle into a roll
 *   - rolling: constant deceleration until the ball stops
 *
 * Only `Math.sqrt` and basic arithmetic are used, so results are bit-identical
 * across engines for the same inputs.
 */
import type { Vec3 } from "@/match/contract";

/** Real ball radius in metres; a ball resting on the grass has z = BALL_RADIUS. */
export const BALL_RADIUS = 0.11;
export const GRAVITY = 9.81;
/** Rolling deceleration on grass, m/s². */
export const ROLL_DECELERATION = 1.8;
/** Fraction of vertical speed kept by a bounce. */
export const BOUNCE_RESTITUTION = 0.55;
/** Fraction of horizontal speed kept by a bounce. */
export const BOUNCE_SCRUB = 0.8;
/** A bounce that would leave the ground slower than this (m/s) settles into a roll instead. */
export const MIN_BOUNCE_SPEED = 0.9;

export interface BallState extends Vec3 {
  vx: number;
  vy: number;
  vz: number;
}

export interface BallStep {
  state: BallState;
  /** Ground impacts during this step (including the one that settles the ball). */
  bounces: number;
}

const EPSILON = 1e-9;

export const isAirborne = (b: BallState) => b.z > BALL_RADIUS + EPSILON || b.vz > EPSILON;
export const horizontalSpeed = (b: BallState) => Math.sqrt(b.vx * b.vx + b.vy * b.vy);

/** Advance the ball by `dtMs` of simulation time. Does not mutate its input. */
export function stepBall(ball: BallState, dtMs: number): BallStep {
  const b = { ...ball };
  let remaining = dtMs / 1000;
  let bounces = 0;
  // Each pass either uses up the step or reaches a ground impact; impacts lose
  // energy, so a handful of passes always suffices.
  for (let pass = 0; pass < 8 && remaining > EPSILON; pass++) {
    if (!isAirborne(b)) {
      roll(b, remaining);
      remaining = 0;
      break;
    }
    const drop = Math.max(0, b.z - BALL_RADIUS);
    const toImpact = (b.vz + Math.sqrt(b.vz * b.vz + 2 * GRAVITY * drop)) / GRAVITY;
    if (toImpact > remaining) {
      fly(b, remaining);
      remaining = 0;
      break;
    }
    fly(b, toImpact);
    remaining -= toImpact;
    bounces++;
    b.z = BALL_RADIUS;
    const rebound = -b.vz * BOUNCE_RESTITUTION;
    b.vz = rebound < MIN_BOUNCE_SPEED ? 0 : rebound;
    b.vx *= BOUNCE_SCRUB;
    b.vy *= BOUNCE_SCRUB;
  }
  if (remaining > EPSILON) {
    // Ran out of passes mid-bounce (only possible for extreme inputs): settle.
    b.z = BALL_RADIUS;
    b.vz = 0;
    roll(b, remaining);
  }
  return { state: b, bounces };
}

function fly(b: BallState, dt: number): void {
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt - 0.5 * GRAVITY * dt * dt;
  b.vz -= GRAVITY * dt;
}

function roll(b: BallState, dt: number): void {
  b.z = BALL_RADIUS;
  b.vz = 0;
  const speed = horizontalSpeed(b);
  if (speed <= EPSILON) {
    b.vx = 0;
    b.vy = 0;
    return;
  }
  const t = Math.min(dt, speed / ROLL_DECELERATION);
  const travelled = speed * t - 0.5 * ROLL_DECELERATION * t * t;
  const after = Math.max(0, speed - ROLL_DECELERATION * t);
  b.x += (b.vx / speed) * travelled;
  b.y += (b.vy / speed) * travelled;
  b.vx = (b.vx / speed) * after;
  b.vy = (b.vy / speed) * after;
}

/** Launch speed for a ground pass that arrives `distance` metres away at `arrivalSpeed`. */
export function rollLaunchSpeed(distance: number, arrivalSpeed: number): number {
  return Math.sqrt(arrivalSpeed * arrivalSpeed + 2 * ROLL_DECELERATION * Math.max(0, distance));
}

/** Seconds a ball rolling from `launchSpeed` takes to cover `distance`, or Infinity if it stops short. */
export function rollTravelTime(distance: number, launchSpeed: number): number {
  const disc = launchSpeed * launchSpeed - 2 * ROLL_DECELERATION * distance;
  return disc < 0 ? Infinity : (launchSpeed - Math.sqrt(disc)) / ROLL_DECELERATION;
}

/**
 * Vertical launch speed for a ball that leaves the ground and is `rise` metres
 * higher after `seconds` in the air (rise = 0 lands it back on the grass).
 */
export function loftLaunchSpeed(rise: number, seconds: number): number {
  return rise / seconds + 0.5 * GRAVITY * seconds;
}
