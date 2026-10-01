/**
 * Skeleton for the procedural footballer: proportions plus the forward
 * kinematics that turn a pose into one world matrix per body part. Uses only
 * Three.js maths (no WebGL), so it can be exercised in unit tests.
 *
 * Model space: the player stands on the origin, forward is +x, up is +y and
 * the player's right is +z. Dimensions are for a 1.77-unit-tall figure and are
 * scaled by MODEL_SCALE in the scene — slightly larger than life, so players
 * read clearly from the overhead camera.
 */
import * as THREE from "three";
import type { Pose } from "./pose";

export const MODEL_SCALE = 1.4;

export const HIP_HEIGHT = 0.9;
export const HIP_SPREAD = 0.095;
export const THIGH_LENGTH = 0.44;
export const SHIN_LENGTH = 0.4;
/** Height of the ankle joint above the sole. */
export const ANKLE_HEIGHT = 0.06;
export const SHOULDER_HEIGHT = 0.52;
export const SHOULDER_SPREAD = 0.25;
export const UPPER_ARM_LENGTH = 0.27;
export const FOREARM_LENGTH = 0.26;
/** Head centre above the hips. */
export const HEAD_HEIGHT = 0.73;
export const HEAD_RADIUS = 0.135;
/** How far the toe reaches in front of the ankle. */
export const TOE_REACH = 0.18;

const SIDES = [-1, 1] as const;

export class Rig {
  readonly root = new THREE.Matrix4();
  readonly pelvis = new THREE.Matrix4();
  readonly torso = new THREE.Matrix4();
  readonly head = new THREE.Matrix4();
  readonly upperArm = [new THREE.Matrix4(), new THREE.Matrix4()] as const;
  readonly forearm = [new THREE.Matrix4(), new THREE.Matrix4()] as const;
  readonly thigh = [new THREE.Matrix4(), new THREE.Matrix4()] as const;
  readonly shin = [new THREE.Matrix4(), new THREE.Matrix4()] as const;
  /** Ankle frames; the boot geometry hangs off these. */
  readonly foot = [new THREE.Matrix4(), new THREE.Matrix4()] as const;
}

const local = new THREE.Matrix4();
const scale = new THREE.Vector3(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);

/** out = parent · translate(x, y, z) · rotateZ(angle) */
function joint(out: THREE.Matrix4, parent: THREE.Matrix4, x: number, y: number, z: number, angle: number): void {
  local.makeRotationZ(angle).setPosition(x, y, z);
  out.multiplyMatrices(parent, local);
}

/**
 * Fills `rig` for a player standing at scene position (x, 0, z), turned by
 * `rotationY` about the vertical axis, in the given pose.
 */
export function solveRig(rig: Rig, x: number, z: number, rotationY: number, pose: Pose): void {
  rig.root.makeRotationY(rotationY).scale(scale).setPosition(x, 0, z);
  joint(rig.pelvis, rig.root, 0, HIP_HEIGHT + pose.bob, 0, 0);
  // A rotation of −lean about z tips the spine forwards (+x).
  joint(rig.torso, rig.pelvis, 0, 0, 0, -pose.lean);
  // The head stays mostly level instead of following the lean.
  joint(rig.head, rig.torso, 0, HEAD_HEIGHT, 0, pose.lean * 0.6);
  for (const i of [0, 1] as const) {
    const side = SIDES[i];
    joint(rig.upperArm[i], rig.torso, 0, SHOULDER_HEIGHT, side * SHOULDER_SPREAD, pose.shoulder[i]);
    joint(rig.forearm[i], rig.upperArm[i], 0, -UPPER_ARM_LENGTH, 0, pose.elbow[i]);
    joint(rig.thigh[i], rig.pelvis, 0, 0, side * HIP_SPREAD, pose.hip[i]);
    joint(rig.shin[i], rig.thigh[i], 0, -THIGH_LENGTH, 0, -pose.knee[i]);
    // Keep the sole roughly parallel to the shin's swing rather than the ground: simple and reads well.
    joint(rig.foot[i], rig.shin[i], 0, -SHIN_LENGTH, 0, 0);
  }
}
