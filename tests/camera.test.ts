import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { pitchCameraDistance } from "@/scene/camera";

describe("full-pitch camera framing", () => {
  it.each([0.4, 0.84, 0.85, 1, 1.6, 2.4, 3.2])("keeps pitch corners and goal height in frame at aspect %s", (aspect) => {
    const portrait = aspect < 0.85;
    for (const [up, across] of [[1, 0.17], [0.75, 0.85]]) {
      const direction = new Vector3(portrait ? across : 0, up, portrait ? 0 : across).normalize();
      const camera = new PerspectiveCamera(22, aspect, 0.5, 1000);
      camera.position.copy(direction).multiplyScalar(pitchCameraDistance(direction, aspect, 22, portrait));
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      for (const x of [-56.5, 56.5]) {
        for (const z of [-38, 38]) {
          for (const y of [0, 4]) {
            const projected = new Vector3(x, y, z).project(camera);
            expect(Math.abs(projected.x)).toBeLessThanOrEqual(1 + 1e-10);
            expect(Math.abs(projected.y)).toBeLessThanOrEqual(1 + 1e-10);
            expect(projected.z).toBeGreaterThan(-1);
            expect(projected.z).toBeLessThan(1);
          }
        }
      }
    }
  });
});
