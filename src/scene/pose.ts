/**
 * Joint angles for the footballer model: idle, running, and the ball contacts
 * recognised in playback/animation.ts (kick, throw-in, receiving, goalkeeper
 * saves and dives, tackles and slides, blocks, and a fouled player falling).
 * Pure maths with no timers — the pose is a function of the player's recorded
 * motion and the playback time, so the same time always shows the same pose.
 *
 * Angles are radians about the player's sideways axis. Positive hip/shoulder
 * angles swing the limb forwards; knee and elbow values are flexion (≥ 0).
 * Index 0 is the left limb, 1 the right. Whole-body tilt and roll pivot on the
 * feet, so a dive or a fall lays the body down beside the recorded position.
 */
import type { PlayerAction, PlayerMotion } from "@/playback/animation";
import { CONTACT_WINDOW, KICK_RECOVER_MS, KICK_WINDUP_MS } from "@/playback/animation";

export interface Pose {
  hip: [number, number];
  knee: [number, number];
  shoulder: [number, number];
  elbow: [number, number];
  /** Forward lean of the torso. */
  lean: number;
  /** Vertical offset of the hips, model units. */
  bob: number;
  /** Whole body tipped forwards (negative = backwards) about the feet, radians. */
  tilt: number;
  /** Whole body tipped towards the player's right (negative = left) about the feet, radians. */
  roll: number;
  /** Whole body lifted off the ground (a jump or a dive), model units. */
  rise: number;
  /** Whole body shifted forwards along the facing (a slide), model units. */
  advance: number;
  /** Whole body turned about the vertical from the recorded facing, radians (positive = towards the right). */
  turn: number;
}

/** Ground covered by one full stride cycle (two steps), metres. */
export const STRIDE_CYCLE = 2.8;
const SPRINT_SPEED = 6.5;
/** A goalkeeper dives when the ball is further than this from vertical above their feet, radians. */
export const DIVE_ANGLE = 0.45;
/** A tackle made from further than this away from the ball is a sliding tackle, metres. */
export const SLIDE_REACH = 1;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (lo: number, hi: number, v: number) => {
  const k = clamp01((v - lo) / (hi - lo));
  return k * k * (3 - 2 * k);
};
const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/** Piecewise-linear track through [time, value] keys. */
type Track = readonly (readonly [number, number])[];
function sample(track: Track, t: number): number {
  if (t <= track[0]![0]) return track[0]![1];
  for (let i = 1; i < track.length; i++) {
    const [t1, v1] = track[i]!;
    if (t <= t1) {
      const [t0, v0] = track[i - 1]!;
      return mix(v0, v1, (t - t0) / (t1 - t0));
    }
  }
  return track[track.length - 1]![1];
}

// Kick keyframes in ms relative to contact: backswing, strike through the ball, follow-through, recover.
const KICK_HIP: Track = [[-KICK_WINDUP_MS, 0], [-90, -0.8], [0, 0.5], [110, 1.05], [200, 0.9], [KICK_RECOVER_MS, 0.1]];
const KICK_KNEE: Track = [[-KICK_WINDUP_MS, 0.15], [-90, 1.3], [0, 0.25], [110, 0.05], [KICK_RECOVER_MS, 0.15]];
const KICK_ARM: Track = [[-KICK_WINDUP_MS, 0], [-90, -0.45], [0, 0.5], [110, 0.9], [KICK_RECOVER_MS, 0]];
const KICK_LEAN: Track = [[-KICK_WINDUP_MS, 0.05], [-90, 0.14], [0, -0.04], [110, -0.16], [KICK_RECOVER_MS, 0.05]];

// Throw-in: ball held behind the head with both hands, whipped forwards over it at release.
const THROW_SHOULDER: Track = [[-150, 2.95], [-40, 3.05], [0, 2.3], [140, 1.3], [420, 0.2]];
const THROW_ELBOW: Track = [[-150, 1.5], [-40, 1.6], [0, 0.35], [140, 0.2], [420, 0.3]];
const THROW_LEAN: Track = [[-150, -0.18], [-40, -0.24], [0, 0.12], [140, 0.25], [420, 0.05]];

/** 0 → 1 over the first `rampIn` ms of an action's window and back to 0 over its last `rampOut` ms. */
function envelope(a: PlayerAction, rampIn: number, rampOut: number): number {
  const end = CONTACT_WINDOW[a.kind][1];
  return smoothstep(-a.lead, -a.lead + rampIn, a.ms) * (1 - smoothstep(end - rampOut, end, a.ms));
}

/** Moves every joint of `pose` towards `target` by weight `w`; joints the target leaves out are untouched. */
function blend(pose: Pose, target: Partial<Pose>, w: number): void {
  for (const key of ["hip", "knee", "shoulder", "elbow"] as const) {
    const t = target[key];
    if (t) for (const side of [0, 1] as const) pose[key][side] = mix(pose[key][side], t[side], w);
  }
  for (const key of ["lean", "bob", "tilt", "roll", "rise", "advance", "turn"] as const) {
    const t = target[key];
    if (t !== undefined) pose[key] = mix(pose[key], t, w);
  }
}

/** Two values, the first for the given leg and the second for the other, in left/right order. */
const legs = (leg: 0 | 1, own: number, other: number): [number, number] => (leg === 0 ? [own, other] : [other, own]);

function kick(pose: Pose, k: number, leg: 0 | 1): void {
  const w = smoothstep(-KICK_WINDUP_MS, -KICK_WINDUP_MS + 80, k) * (1 - smoothstep(KICK_RECOVER_MS - 160, KICK_RECOVER_MS, k));
  const support = leg === 0 ? 1 : 0;
  const arm = sample(KICK_ARM, k);
  pose.hip[leg] = mix(pose.hip[leg], sample(KICK_HIP, k), w);
  pose.knee[leg] = mix(pose.knee[leg], sample(KICK_KNEE, k), w);
  pose.hip[support] = mix(pose.hip[support], -0.15, w);
  pose.knee[support] = mix(pose.knee[support], 0.3, w);
  // The arm opposite the kicking leg comes through with it for balance.
  pose.shoulder[support] = mix(pose.shoulder[support], arm, w);
  pose.shoulder[leg] = mix(pose.shoulder[leg], -0.7 * arm, w);
  pose.elbow[0] = mix(pose.elbow[0], 0.5, w);
  pose.elbow[1] = mix(pose.elbow[1], 0.5, w);
  pose.lean = mix(pose.lean, sample(KICK_LEAN, k), w);
  pose.bob = mix(pose.bob, -0.02, w);
}

function throwIn(pose: Pose, a: PlayerAction): void {
  const s = sample(THROW_SHOULDER, a.ms);
  const e = sample(THROW_ELBOW, a.ms);
  blend(
    pose,
    { shoulder: [s, s], elbow: [e, e], lean: sample(THROW_LEAN, a.ms), hip: [0.05, -0.12], knee: [0.15, 0.25], bob: -0.02 },
    envelope(a, 120, 200),
  );
}

/** Cushioning a ball with the foot, or taking a higher one on the chest. */
function receive(pose: Pose, a: PlayerAction, leg: 0 | 1): void {
  const touch = 1 - smoothstep(0, 260, Math.abs(a.ms));
  const target: Partial<Pose> =
    a.height < 0.6
      ? { hip: legs(leg, 0.15 + 0.45 * touch, -0.05), knee: legs(leg, 0.3 + 0.4 * touch, 0.25), lean: 0.12 }
      : { lean: -0.12 - 0.18 * touch, shoulder: [-0.35, -0.35], elbow: [0.9, 0.9], knee: [0.3, 0.3], bob: -0.03 };
  blend(pose, target, envelope(a, 100, 160));
}

/** Goalkeeper: a catch at the ball's height, or a dive towards it that lands on the side and gets back up. */
function save(pose: Pose, a: PlayerAction): void {
  const towards = Math.atan2(Math.abs(a.side), Math.max(0.3, a.height - 0.1));
  const dive = towards > DIVE_ANGLE;
  const side = a.side < 0 ? -1 : 1;
  // Square up to the shot, crouch ready, spring at the ball, lie there briefly, then get up.
  const launch = smoothstep(-a.lead, 0, a.ms);
  const square = a.turn * smoothstep(-a.lead, -a.lead / 2, a.ms);
  const down = smoothstep(80, 320, a.ms);
  const up = smoothstep(420, 720, a.ms);
  if (dive) {
    const lay = Math.min(1.35, towards);
    const target: Partial<Pose> = {
      roll: side * mix(lay * launch, 1.45, down) * (1 - up),
      rise: (0.22 * launch * (1 - down) + 0.05) * (1 - up),
      shoulder: [2.9, 2.9],
      elbow: [0.15, 0.15],
      hip: legs(side > 0 ? 1 : 0, 0.1, 0.35),
      knee: [0.35, 0.35],
      lean: 0.05,
      turn: square,
    };
    blend(pose, target, envelope(a, 120, 260));
    return;
  }
  // Catch: arms to the ball, a hop for a high one, a stoop for a low one.
  const reach = a.height < 0.7 ? 0.55 : a.height < 1.7 ? 1.35 : 2.85;
  const target: Partial<Pose> = {
    shoulder: [reach, reach],
    elbow: [a.height < 1.7 ? 0.7 : 0.2, a.height < 1.7 ? 0.7 : 0.2],
    lean: a.height < 0.7 ? 0.55 : 0.08,
    knee: a.height < 0.7 ? [0.9, 0.9] : [0.25, 0.25],
    hip: a.height < 0.7 ? [0.5, 0.5] : [0, 0],
    bob: a.height < 0.7 ? -0.12 : 0,
    rise: a.height >= 1.7 ? 0.18 * launch * (1 - smoothstep(60, 260, a.ms)) : 0,
    roll: side * Math.min(0.25, towards * 0.5),
    turn: square,
  };
  blend(pose, target, envelope(a, 120, 260));
}

/** A standing tackle lunges a leg at the ball; from further away it is a slide along the ground. */
function tackle(pose: Pose, a: PlayerAction, leg: 0 | 1): void {
  if (a.reach > SLIDE_REACH) {
    const go = smoothstep(-a.lead, 0, a.ms);
    const up = smoothstep(380, 680, a.ms);
    const target: Partial<Pose> = {
      tilt: -1.1 * go * (1 - up),
      // Leaning back about the feet would leave the hips in the air; drop them to the grass.
      rise: -0.3 * go * (1 - up),
      advance: Math.min(1.2, a.reach - 0.4) * go * (1 - up),
      hip: legs(leg, 0.45, 1.1),
      knee: legs(leg, 0.05, 1.5),
      shoulder: [-0.6, -0.6],
      elbow: [0.3, 0.3],
      lean: 0.25,
    };
    blend(pose, target, envelope(a, 100, 240));
    return;
  }
  const strike = 1 - smoothstep(0, 300, Math.abs(a.ms));
  blend(
    pose,
    {
      hip: legs(leg, 0.25 + 0.75 * strike, -0.25),
      knee: legs(leg, 0.15, 0.7),
      lean: 0.3,
      bob: -0.1,
      shoulder: legs(leg, -0.5, 0.6),
      elbow: [0.6, 0.6],
    },
    envelope(a, 100, 260),
  );
}

/** An outfield player throws their body in the way: braced, arms tucked, leaning into the ball's side. */
function block(pose: Pose, a: PlayerAction, leg: 0 | 1): void {
  blend(
    pose,
    {
      hip: legs(leg, 0.55, -0.1),
      knee: legs(leg, 0.2, 0.45),
      shoulder: [0.35, 0.35],
      elbow: [1.6, 1.6],
      lean: -0.08,
      bob: -0.06,
      roll: (a.side < 0 ? -1 : 1) * 0.18,
    },
    envelope(a, 80, 220),
  );
}

/** A fouled player goes down face first, stays down a moment, then gets up. */
function fall(pose: Pose, a: PlayerAction): void {
  const down = smoothstep(0, 380, a.ms);
  const up = smoothstep(1250, 1650, a.ms);
  blend(
    pose,
    {
      tilt: 1.42 * down * (1 - up),
      shoulder: [2.4 * down, 2.1 * down],
      elbow: [0.5, 0.6],
      hip: [0.25, 0.05],
      knee: [0.5, 0.2],
      lean: 0.1,
    },
    envelope(a, 60, 300),
  );
}

/**
 * @param timeMs playback time, used only for the idle sway
 * @param seed per-player offset so 22 players do not move in unison
 * @param kickLeg which leg strikes the ball (0 = left, 1 = right)
 */
export function poseFor(motion: Pick<PlayerMotion, "speed" | "distance" | "action">, timeMs: number, seed: number, kickLeg: 0 | 1): Pose {
  // Locomotion: legs in antiphase, arms opposite the legs, knee bent while the leg swings forward.
  const moving = smoothstep(0.15, 0.6, motion.speed);
  const effort = Math.sqrt(clamp01(motion.speed / SPRINT_SPEED)) * moving;
  const phase = (motion.distance / STRIDE_CYCLE) * Math.PI * 2 + seed;
  const sway = Math.sin(timeMs / 900 + seed) * 0.04 * (1 - moving);
  const pose: Pose = {
    hip: [0, 0],
    knee: [0, 0],
    shoulder: [0, 0],
    elbow: [0, 0],
    lean: 0.04 + 0.22 * effort * effort,
    bob: (Math.cos(phase * 2) * 0.035 - 0.03) * effort + Math.sin(timeMs / 650 + seed) * 0.008 * (1 - moving),
    tilt: 0,
    roll: 0,
    rise: 0,
    advance: 0,
    turn: 0,
  };
  for (const side of [0, 1] as const) {
    const legPhase = phase + (side === 0 ? Math.PI : 0);
    pose.hip[side] = 0.85 * effort * Math.sin(legPhase);
    pose.knee[side] = 0.1 + 1.2 * effort * Math.max(0, Math.cos(legPhase));
    pose.shoulder[side] = -0.75 * effort * Math.sin(legPhase) + sway;
    pose.elbow[side] = 0.25 + 1.1 * effort;
  }

  const a = motion.action;
  if (!a) return pose;
  switch (a.kind) {
    case "kick":
      kick(pose, a.ms, kickLeg);
      break;
    case "throw":
      throwIn(pose, a);
      break;
    case "receive":
      receive(pose, a, kickLeg);
      break;
    case "save":
      save(pose, a);
      break;
    case "tackle":
      tackle(pose, a, kickLeg);
      break;
    case "block":
      block(pose, a, kickLeg);
      break;
    case "fall":
      fall(pose, a);
      break;
  }
  return pose;
}
