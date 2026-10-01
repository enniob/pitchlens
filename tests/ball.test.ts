import { describe, expect, it } from "vitest";
import {
  BALL_RADIUS,
  BOUNCE_RESTITUTION,
  BOUNCE_SCRUB,
  GRAVITY,
  ROLL_DECELERATION,
  horizontalSpeed,
  isAirborne,
  loftLaunchSpeed,
  rollLaunchSpeed,
  rollTravelTime,
  stepBall,
  type BallState,
} from "@/simulation/ball";

const STEP_MS = 20;
const resting = (over: Partial<BallState> = {}): BallState => ({ x: 0, y: 0, z: BALL_RADIUS, vx: 0, vy: 0, vz: 0, ...over });

/** Runs the ball for `ms`, returning every intermediate state. */
function run(start: BallState, ms: number, stepMs = STEP_MS) {
  const states = [start];
  let bounces = 0;
  for (let t = 0; t < ms; t += stepMs) {
    const step = stepBall(states[states.length - 1]!, stepMs);
    states.push(step.state);
    bounces += step.bounces;
  }
  return { states, bounces, end: states[states.length - 1]! };
}

describe("airborne ball", () => {
  it("follows the analytic parabola under gravity", () => {
    const start = resting({ vx: 12, vy: -5, vz: 9 });
    const { states } = run(start, 1_500);
    states.forEach((s, i) => {
      const t = (i * STEP_MS) / 1000;
      expect(s.x).toBeCloseTo(12 * t, 9);
      expect(s.y).toBeCloseTo(-5 * t, 9);
      expect(s.z).toBeCloseTo(BALL_RADIUS + 9 * t - 0.5 * GRAVITY * t * t, 9);
      expect(s.vz).toBeCloseTo(9 - GRAVITY * t, 9);
    });
  });

  it("reaches the apex and lands when and where the launch helpers say", () => {
    const seconds = 1.6;
    const vz = loftLaunchSpeed(0, seconds);
    const { states } = run(resting({ vx: 10, vz }), seconds * 1000);
    const apex = Math.max(...states.map((s) => s.z));
    expect(apex).toBeCloseTo(BALL_RADIUS + (vz * vz) / (2 * GRAVITY), 2);
    const landing = states[states.length - 1]!;
    expect(landing.x).toBeCloseTo(10 * seconds, 6);
    expect(landing.z).toBeCloseTo(BALL_RADIUS, 6);
  });

  it("can be aimed at a height above the ground", () => {
    const seconds = 0.8;
    const { end } = run(resting({ vx: 25, vz: loftLaunchSpeed(1.5, seconds) }), seconds * 1000);
    expect(end.z).toBeCloseTo(BALL_RADIUS + 1.5, 9);
  });
});

describe("bounces", () => {
  it("lose height and pace on every impact and never sink into the pitch", () => {
    const { states, bounces } = run(resting({ z: 3, vx: 8 }), 6_000);
    expect(bounces).toBeGreaterThan(2);
    for (const s of states) expect(s.z).toBeGreaterThanOrEqual(BALL_RADIUS - 1e-12);
    // Apex of each hop: local maxima of z.
    const peaks: number[] = [3];
    for (let i = 1; i < states.length - 1; i++)
      if (states[i]!.z > states[i - 1]!.z && states[i]!.z >= states[i + 1]!.z) peaks.push(states[i]!.z);
    for (let i = 1; i < peaks.length; i++) {
      const before = peaks[i - 1]! - BALL_RADIUS;
      const after = peaks[i]! - BALL_RADIUS;
      expect(after).toBeLessThan(before);
      // Rebound height is restitution² of the drop (sampled every 20 ms, hence the tolerance).
      expect(after / before).toBeCloseTo(BOUNCE_RESTITUTION ** 2, 1);
    }
  });

  it("damp horizontal speed by the scrub factor per impact", () => {
    const dropTime = Math.sqrt((2 * 1) / GRAVITY);
    const step = stepBall(resting({ z: BALL_RADIUS + 1, vx: 10 }), dropTime * 1000 + 1);
    expect(step.bounces).toBe(1);
    expect(step.state.vx).toBeCloseTo(10 * BOUNCE_SCRUB, 9);
    expect(step.state.vz).toBeGreaterThan(0);
  });

  it("settle into a roll and then come to rest", () => {
    const { end } = run(resting({ z: 2, vx: 3 }), 10_000);
    expect(isAirborne(end)).toBe(false);
    expect(end.z).toBe(BALL_RADIUS);
    expect(horizontalSpeed(end)).toBe(0);
    expect(end.vz).toBe(0);
  });
});

describe("rolling ball", () => {
  it("decelerates at a constant rate and stops after v²/2a", () => {
    const { states, end } = run(resting({ vx: 6, vy: 8 }), 8_000);
    const distance = Math.hypot(end.x, end.y);
    expect(distance).toBeCloseTo(10 ** 2 / (2 * ROLL_DECELERATION), 9);
    expect(horizontalSpeed(end)).toBe(0);
    // Direction never changes and speed never increases.
    for (let i = 1; i < states.length; i++) {
      expect(horizontalSpeed(states[i]!)).toBeLessThanOrEqual(horizontalSpeed(states[i - 1]!));
      expect(states[i]!.y * 6).toBeCloseTo(states[i]!.x * 8, 9);
      expect(states[i]!.z).toBe(BALL_RADIUS);
    }
    const afterOneSecond = states[1000 / STEP_MS]!;
    expect(horizontalSpeed(afterOneSecond)).toBeCloseTo(10 - ROLL_DECELERATION, 9);
  });

  it("arrives at the requested speed for a ground pass", () => {
    const launch = rollLaunchSpeed(20, 9);
    const seconds = rollTravelTime(20, launch);
    const { end } = run(resting({ vx: launch }), Math.round(seconds * 1000), 1);
    expect(end.x).toBeCloseTo(20, 1);
    expect(horizontalSpeed(end)).toBeCloseTo(9, 1);
    expect(rollTravelTime(100, 5)).toBe(Infinity);
  });
});

describe("determinism", () => {
  const start = resting({ z: 1.2, vx: 14, vy: 3, vz: 6 });

  it("does not mutate its input and repeats exactly", () => {
    const copy = { ...start };
    const a = run(start, 5_000);
    const b = run(start, 5_000);
    expect(start).toEqual(copy);
    expect(a.states).toEqual(b.states);
  });

  it("gives the same path whatever the step size, because each step is integrated exactly", () => {
    const fine = run(start, 4_000, 20).end;
    const coarse = run(start, 4_000, 100).end;
    for (const key of ["x", "y", "z", "vx", "vy", "vz"] as const) expect(coarse[key]).toBeCloseTo(fine[key], 6);
  });
});
