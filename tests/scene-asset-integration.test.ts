import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleFixture } from "@/match/fixture";
import { frameAt } from "@/playback/derive";
import { motionAt } from "@/playback/animation";
import { CornerFlags } from "@/scene/CornerFlags";
import { HALF_LENGTH, HALF_WIDTH } from "@/scene/coords";
import { PlayerSquad } from "@/scene/Player";
import { extractKeeperGeometry } from "@/scene/playerAsset";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

async function bytes(name: string) {
  const data = await readFile(new URL(`../public/models/${name}.glb`, import.meta.url));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

function canvasStub() {
  vi.stubGlobal("document", { createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({ beginPath() {}, arc() {}, fill() {}, stroke() {}, fillText() {} }),
  }) });
}

function modelFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    arrayBuffer: () => bytes(url.split("/").at(-1)!.replace(".glb", "")),
  })));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("runtime scene assets", () => {
  it("loads keeper parts only for GK roles and reconstructs gloves after backward seeking", async () => {
    canvasStub();
    modelFetch();
    const squad = new PlayerSquad(sampleFixture);
    const outfield = squad.object.getObjectByName("outfield")!;
    const keepers = squad.object.getObjectByName("goalkeepers")!;
    await vi.waitFor(() => {
      expect(outfield.userData.playerAsset).toBe("blender");
      expect(keepers.userData.playerAsset).toBe("blender");
    });
    const keeperCount = sampleFixture.roster.filter((p) => p.role === "GK").length;
    expect((keepers.getObjectByName("torso") as THREE.InstancedMesh).count).toBe(keeperCount);
    expect((outfield.getObjectByName("torso") as THREE.InstancedMesh).count).toBe(sampleFixture.roster.length - keeperCount);
    expect(outfield.getObjectByName("gloveLeft")).toBeUndefined();
    const glove = keepers.getObjectByName("gloveLeft") as THREE.InstancedMesh;
    const right = keepers.getObjectByName("gloveRight") as THREE.InstancedMesh;
    expect(glove.geometry).not.toBe(right.geometry);
    expect((glove.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
    const update = (time: number) => squad.update(frameAt(sampleFixture, time).players, motionAt(sampleFixture, time), time);
    update(1000);
    const first = Array.from(glove.instanceMatrix.array);
    update(10000);
    update(1000);
    expect(Array.from(glove.instanceMatrix.array)).toEqual(first);
    const matrix = new THREE.Matrix4();
    const arm = keepers.getObjectByName("forearm") as THREE.InstancedMesh;
    arm.getMatrixAt(0, matrix);
    const gloveMatrix = new THREE.Matrix4();
    glove.getMatrixAt(0, gloveMatrix);
    expect(gloveMatrix.elements).toEqual(matrix.elements);
    squad.dispose();
  });

  it("keeps outfield models available when the goalkeeper load fails", async () => {
    canvasStub();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: !url.includes("goalkeeper"), arrayBuffer: () => bytes("footballer"),
    })));
    const squad = new PlayerSquad(sampleFixture);
    await vi.waitFor(() => {
      expect(squad.object.getObjectByName("outfield")!.userData.playerAsset).toBe("blender");
      expect(squad.object.getObjectByName("goalkeepers")!.userData.playerAsset).toBe("fallback");
    });
    squad.dispose();
  });

  it("requires both authored gloves before accepting goalkeeper geometry", async () => {
    const { scene } = await new GLTFLoader().parseAsync(await bytes("goalkeeper"), "");
    scene.remove(scene.getObjectByName("gloveRight")!);
    expect(() => extractKeeperGeometry(scene)).toThrow("gloveRight");
  });

  it("places four authored flags at ground level with outward cloth and shared geometry", async () => {
    modelFetch();
    const flags = new CornerFlags();
    await vi.waitFor(() => expect(flags.object.userData.asset).toBe("blender"));
    expect(flags.object.children.map((child) => child.position.toArray())).toEqual([
      [-HALF_LENGTH, 0, -HALF_WIDTH], [-HALF_LENGTH, 0, HALF_WIDTH],
      [HALF_LENGTH, 0, -HALF_WIDTH], [HALF_LENGTH, 0, HALF_WIDTH],
    ]);
    const poles = flags.object.children.map((child) => child.getObjectByName("corner-flag-pole") as THREE.Mesh);
    expect(new Set(poles.map((pole) => pole.geometry)).size).toBe(1);
    for (const child of flags.object.children) {
      const bounds = new THREE.Box3().setFromObject(child);
      expect(bounds.min.y).toBeCloseTo(0);
      expect(bounds.max.y).toBeCloseTo(1.5);
      if (child.position.x < 0) expect(bounds.min.x).toBeLessThan(-HALF_LENGTH - .35);
      else expect(bounds.max.x).toBeGreaterThan(HALF_LENGTH + .35);
    }
    flags.dispose();
  });

  it.each(["missing", "malformed"])("keeps fallback flags for a %s asset", async (failure) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: failure !== "missing", arrayBuffer: async () => new ArrayBuffer(8) }));
    const flags = new CornerFlags();
    const fallback = [...flags.object.children];
    await vi.waitFor(() => expect(flags.object.userData.asset).toBe("fallback"));
    expect(flags.object.children).toEqual(fallback);
    flags.dispose();
  });

  it("aborts pending loads and frees parsed flags arriving after disposal", async () => {
    let resolve!: (response: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetchMock);
    const flags = new CornerFlags();
    const fallback = [...flags.object.children];
    flags.dispose();
    expect((fetchMock.mock.calls[0] as unknown as [string, { signal: AbortSignal }])[1].signal.aborted).toBe(true);
    const dispose = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    resolve({ ok: true, arrayBuffer: () => bytes("corner-flag") });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(3));
    expect(flags.object.children).toEqual(fallback);
  });
});
