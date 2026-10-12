import type { Vector3 } from "three";

/** Fit the pitch apron and goal height at zoom 1. Direction must be normalized.
 * Portrait rotates screen-right onto the z axis.
 */
export function pitchCameraDistance(direction: Vector3, aspect: number, fov: number, portrait: boolean): number {
  const tanVertical = Math.tan(fov * Math.PI / 360);
  const tanHorizontal = tanVertical * aspect;
  let distance = 0;
  for (const x of [-56.5, 56.5]) {
    for (const z of [-38, 38]) {
      for (const y of [0, 4]) {
        const depth = x * direction.x + y * direction.y + z * direction.z;
        const horizontal = portrait ? z : x;
        const vertical = portrait ? y * direction.x - x * direction.y : y * direction.z - z * direction.y;
        distance = Math.max(distance, depth + Math.abs(horizontal) / tanHorizontal,
          depth + Math.abs(vertical) / tanVertical);
      }
    }
  }
  return distance;
}
