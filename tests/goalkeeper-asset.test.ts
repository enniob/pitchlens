import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { disposePlayerGeometry, extractPlayerGeometry, PLAYER_PARTS } from "@/scene/playerAsset";

async function exportedModel() {
  const bytes = await readFile(new URL("../public/models/goalkeeper.glb", import.meta.url));
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
}

/** Mean sideways position of latex (light) and backhand (dark) glove vertices, joint-local. */
function gloveSides(scene: THREE.Group, name: string) {
  const mesh = scene.getObjectByName(name) as THREE.Mesh;
  const positions = mesh.geometry.getAttribute("position");
  const colors = mesh.geometry.getAttribute("color");
  const light: number[] = [], dark: number[] = [];
  for (let i = 0; i < positions.count; i++) {
    if (positions.getY(i) > -.3) continue; // Skip the strap.
    (colors.getX(i) > .5 ? light : dark).push(positions.getZ(i));
  }
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  return { light: mean(light), dark: mean(dark), pivot: mesh.position.z };
}

describe("Blender goalkeeper asset", () => {
  it("keeps the footballer's joint-local part contract within a small mesh budget", async () => {
    const { scene } = await exportedModel();
    const parts = extractPlayerGeometry(scene);
    let triangles = 0;
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh) triangles += (object.geometry.index?.count ?? 0) / 3;
    });
    expect(triangles).toBeLessThan(6000);
    expect(parts.torso.boundingBox!.max.y).toBeCloseTo(.58, 3);
    expect(parts.thigh.boundingBox!.min.y).toBeCloseTo(-.44, 3);
    // Long sleeves reach the wrist, where the glove strap takes over.
    expect(parts.forearm.boundingBox!.min.y).toBeLessThan(-.23);
    expect(parts.forearm.boundingBox!.min.y).toBeGreaterThan(-.25);
    expect(Object.keys(parts)).toEqual([...PLAYER_PARTS]);
    disposePlayerGeometry(parts);
  });

  it("authors a glove per hand with the latex palm facing the body", async () => {
    const { scene } = await exportedModel();
    const left = gloveSides(scene, "gloveLeft"), right = gloveSides(scene, "gloveRight");
    expect(left.pivot).toBeCloseTo(-.25);
    expect(right.pivot).toBeCloseTo(.25);
    expect(left.light).toBeGreaterThan(left.dark);
    expect(right.light).toBeLessThan(right.dark);
    const bounds = new THREE.Box3().setFromBufferAttribute(
      (scene.getObjectByName("gloveLeft") as THREE.Mesh).geometry.getAttribute("position") as THREE.BufferAttribute);
    expect(bounds.max.y).toBeLessThan(-.21);
    expect(bounds.min.y).toBeGreaterThan(-.5);
  });
});
