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

/**
 * Shift `pan` just enough to keep `target` inside the central dead zone of the
 * view. `halfX`/`halfZ` are the visible ground half-extents around the pan
 * centre; `deadZone` is the fraction of them the target may roam freely.
 * Returns the pan unchanged while the target is already inside the zone.
 */
export function followPan(
  pan: { x: number; y: number },
  target: { x: number; z: number },
  halfX: number,
  halfZ: number,
  deadZone = 0.5,
): { x: number; y: number } {
  const follow = (centre: number, value: number, half: number) => {
    const limit = half * deadZone;
    const offset = value - centre;
    if (offset > limit) return centre + offset - limit;
    if (offset < -limit) return centre + offset + limit;
    return centre;
  };
  return { x: follow(pan.x, target.x, halfX), y: follow(pan.y, target.z, halfZ) };
}
