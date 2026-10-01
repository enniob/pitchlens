/**
 * Pitch space → Three.js scene space.
 *
 * Pitch space (see src/match/contract.ts): x ∈ [0, 105] along the length,
 * y ∈ [0, 68] across the width, z = height, all in metres.
 *
 * Scene space is Three.js's right-handed, y-up world, 1 unit = 1 metre, with
 * the centre spot at the origin:
 *   scene.x = pitch.x − 52.5     (left goal line at −52.5, right at +52.5)
 *   scene.y = pitch.z            (height)
 *   scene.z = pitch.y − 34       (top touchline at −34, bottom at +34)
 *
 * Viewed from above with the default cameras, pitch x increases to the right
 * and pitch y increases down the screen.
 *
 * A pitch-space facing angle f (0 = +x, π/2 = +y) becomes a rotation of −f
 * about the scene's y axis for a model whose forward direction is local +x.
 */
import { PITCH_LENGTH, PITCH_WIDTH } from "@/match/contract";

export const HALF_LENGTH = PITCH_LENGTH / 2;
export const HALF_WIDTH = PITCH_WIDTH / 2;

export function toScene(x: number, y: number, z = 0): [number, number, number] {
  return [x - HALF_LENGTH, z, y - HALF_WIDTH];
}

export function facingToRotationY(facing: number): number {
  return -facing;
}
