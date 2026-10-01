/**
 * Joint angles for the footballer model: idle, running and kicking. Pure maths
 * with no timers — the pose is a function of the player's recorded motion and
 * the playback time, so the same time always shows the same pose.
 *
 * Angles are radians about the player's sideways axis. Positive hip/shoulder
 * angles swing the limb forwards; knee and elbow values are flexion (≥ 0).
 * Index 0 is the left limb, 1 the right.
 */
import { KICK_RECOVER_MS, KICK_WINDUP_MS, type PlayerMotion } from "@/playback/animation";

export interface Pose {
  hip: [number, number];
  knee: [number, number];
  shoulder: [number, number];
  elbow: [number, number];
  /** Forward lean of the torso. */
  lean: number;
  /** Vertical offset of the hips, model units. */
  bob: number;
}

/** Ground covered by one full stride cycle (two steps), metres. */
export const STRIDE_CYCLE = 2.8;
const SPRINT_SPEED = 6.5;

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

/**
 * @param timeMs playback time, used only for the idle sway
 * @param seed per-player offset so 22 players do not move in unison
 * @param kickLeg which leg strikes the ball (0 = left, 1 = right)
 */
export function poseFor(motion: Pick<PlayerMotion, "speed" | "distance" | "kickMs">, timeMs: number, seed: number, kickLeg: 0 | 1): Pose {
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
  };
  for (const side of [0, 1] as const) {
    const legPhase = phase + (side === 0 ? Math.PI : 0);
    pose.hip[side] = 0.85 * effort * Math.sin(legPhase);
    pose.knee[side] = 0.1 + 1.2 * effort * Math.max(0, Math.cos(legPhase));
    pose.shoulder[side] = -0.75 * effort * Math.sin(legPhase) + sway;
    pose.elbow[side] = 0.25 + 1.1 * effort;
  }

  if (motion.kickMs === null) return pose;
  const k = motion.kickMs;
  const weight = smoothstep(-KICK_WINDUP_MS, -KICK_WINDUP_MS + 80, k) * (1 - smoothstep(KICK_RECOVER_MS - 160, KICK_RECOVER_MS, k));
  const support = kickLeg === 0 ? 1 : 0;
  const arm = sample(KICK_ARM, k);
  pose.hip[kickLeg] = mix(pose.hip[kickLeg], sample(KICK_HIP, k), weight);
  pose.knee[kickLeg] = mix(pose.knee[kickLeg], sample(KICK_KNEE, k), weight);
  pose.hip[support] = mix(pose.hip[support], -0.15, weight);
  pose.knee[support] = mix(pose.knee[support], 0.3, weight);
  // The arm opposite the kicking leg comes through with it for balance.
  pose.shoulder[support] = mix(pose.shoulder[support], arm, weight);
  pose.shoulder[kickLeg] = mix(pose.shoulder[kickLeg], -0.7 * arm, weight);
  pose.elbow[0] = mix(pose.elbow[0], 0.5, weight);
  pose.elbow[1] = mix(pose.elbow[1], 0.5, weight);
  pose.lean = mix(pose.lean, sample(KICK_LEAN, k), weight);
  pose.bob = mix(pose.bob, -0.02, weight);
  return pose;
}
