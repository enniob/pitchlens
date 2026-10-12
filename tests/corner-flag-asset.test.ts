import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

async function exportedModel() {
  const bytes = await readFile(new URL("../public/models/corner-flag.glb", import.meta.url));
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
}

describe("Blender corner flag asset", () => {
  it("stands 1.5 m tall from a ground-level origin with a 40 x 30 cm recolourable cloth", async () => {
    const { scene } = await exportedModel();
    const pole = scene.getObjectByName("corner-flag-pole") as THREE.Mesh;
    const cloth = scene.getObjectByName("corner-flag-cloth") as THREE.Mesh;
    expect(scene.getObjectByName("corner-flag-clips")).toBeDefined();
    const bounds = new THREE.Box3().setFromObject(pole);
    expect(bounds.min.y).toBeCloseTo(0, 4);
    expect(bounds.max.y).toBeCloseTo(1.5, 3);
    const flag = new THREE.Box3().setFromObject(cloth);
    expect(flag.max.y).toBeLessThan(1.45);
    expect(flag.max.y - flag.min.y).toBeGreaterThan(.29);
    expect(flag.max.x - flag.min.x).toBeGreaterThan(.37);
    expect(flag.max.x - flag.min.x).toBeLessThan(.41);
    const material = cloth.material as THREE.MeshStandardMaterial;
    expect(material.name).toBe("Flag");
    expect(material.side).toBe(THREE.DoubleSide);
    expect(cloth.geometry.getAttribute("uv")).toBeDefined();
  });

  it("stays within a small mesh budget", async () => {
    const { scene } = await exportedModel();
    let triangles = 0;
    scene.traverse((object) => {
      const geometry = (object as THREE.Mesh).geometry;
      if (geometry) triangles += (geometry.index?.count ?? geometry.getAttribute("position").count) / 3;
    });
    expect(triangles).toBeLessThan(1500);
  });
});
