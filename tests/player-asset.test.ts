import { readFile } from "node:fs/promises";
import { describe, expect, it, vi, afterEach } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { disposePlayerGeometry, extractPlayerGeometry, loadPlayerGeometry, PLAYER_PARTS } from "@/scene/playerAsset";

async function exportedModel() {
  const bytes = await readFile(new URL("../public/models/footballer.glb", import.meta.url));
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
}

afterEach(() => vi.unstubAllGlobals());

describe("Blender footballer asset", () => {
  it("loads all joint-local parts with correct axes, proportions, and a bounded mesh budget", async () => {
    const { scene } = await exportedModel();
    const parts = extractPlayerGeometry(scene);
    let triangles = 0;
    for (const name of PLAYER_PARTS) {
      const geometry = parts[name];
      expect(geometry.getAttribute("color").count).toBe(geometry.getAttribute("position").count);
      triangles += (geometry.index?.count ?? geometry.getAttribute("position").count) / 3;
    }
    expect(triangles).toBeLessThan(5000);
    expect(parts.torso.boundingBox!.max.y).toBeCloseTo(.575, 3);
    expect(parts.torso.boundingBox!.max.z).toBeCloseTo(.23, 3);
    expect(parts.thigh.boundingBox!.min.y).toBeCloseTo(-.44, 3);
    expect(parts.boot.boundingBox!.max.x).toBeGreaterThan(.17);
    expect(parts.boot.boundingBox!.min.y).toBeGreaterThan(-.061);
    expect(parts.head.boundingBox!.max.y).toBeLessThan(.15);
    disposePlayerGeometry(parts);
  });

  it("does not include Blender's assembled rest-pose translations in animation geometry", async () => {
    const { scene } = await exportedModel();
    scene.position.set(30, 4, 19);
    const parts = extractPlayerGeometry(scene);
    expect(parts.thigh.boundingBox!.min.y).toBeCloseTo(-.44, 3);
    expect(parts.head.boundingBox!.max.y).toBeLessThan(.15);
    disposePlayerGeometry(parts);
  });

  it("rejects incomplete assets and frees geometry already extracted", async () => {
    const { scene } = await exportedModel();
    scene.remove(scene.getObjectByName("boot")!);
    const dispose = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    expect(() => extractPlayerGeometry(scene)).toThrow("boot");
    expect(dispose).toHaveBeenCalledTimes(PLAYER_PARTS.length - 1);
    dispose.mockRestore();
  });

  it("reports a missing asset to the caller so procedural geometry remains available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(loadPlayerGeometry(new AbortController().signal)).rejects.toThrow("unavailable");
  });

  it("rejects a cancelled load after parsing instead of installing a late model", async () => {
    const controller = new AbortController();
    const bytes = await readFile(new URL("../public/models/footballer.glb", import.meta.url));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => {
      controller.abort();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } }));
    await expect(loadPlayerGeometry(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
