import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export const PLAYER_PARTS = ["torso", "shorts", "head", "hair", "sleeve", "upperArm", "forearm", "thigh", "shin", "boot"] as const;
export type PlayerPart = typeof PLAYER_PARTS[number];
export type PlayerGeometry = Record<PlayerPart, THREE.BufferGeometry>;
export const KEEPER_PARTS = [...PLAYER_PARTS, "gloveLeft", "gloveRight"] as const;
export type KeeperGeometry = PlayerGeometry & Record<"gloveLeft" | "gloveRight", THREE.BufferGeometry>;

/** Convert Blender's assembled neutral pose into joint-local geometry.
 * The exporter converts the axes; world translation is removed because the
 * playback rig supplies each joint's position. No model animation clock runs.
 */
export function extractPlayerGeometry(scene: THREE.Group): PlayerGeometry {
  return extractParts(scene, PLAYER_PARTS);
}

export function extractKeeperGeometry(scene: THREE.Group): KeeperGeometry {
  return extractParts(scene, KEEPER_PARTS);
}

function extractParts<T extends string>(scene: THREE.Group, names: readonly T[]): Record<T, THREE.BufferGeometry> {
  const geometries: Partial<Record<T, THREE.BufferGeometry>> = {};
  scene.updateMatrixWorld(true);
  try {
    for (const name of names) {
      const mesh = scene.getObjectByName(name);
      if (!(mesh instanceof THREE.Mesh) || !(mesh.geometry instanceof THREE.BufferGeometry)
        || !mesh.geometry.getAttribute("position") || !mesh.geometry.getAttribute("normal")
        || !mesh.geometry.getAttribute("color")) {
        throw new Error(`Invalid footballer asset part: ${name}`);
      }
      const transform = mesh.matrixWorld.clone().setPosition(0, 0, 0);
      const geometry = mesh.geometry.clone().applyMatrix4(transform);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      geometries[name] = geometry;
    }
    return geometries as Record<T, THREE.BufferGeometry>;
  } catch (error) {
    for (const name of names) geometries[name]?.dispose();
    throw error;
  }
}

export function disposePlayerGeometry(geometries: PlayerGeometry): void {
  Object.values(geometries).forEach((geometry) => geometry.dispose());
}

export async function loadPlayerGeometry(signal: AbortSignal): Promise<PlayerGeometry> {
  return loadGeometry(signal, "/models/footballer.glb", extractPlayerGeometry);
}

export async function loadKeeperGeometry(signal: AbortSignal): Promise<KeeperGeometry> {
  return loadGeometry(signal, "/models/goalkeeper.glb", extractKeeperGeometry);
}

async function loadGeometry<T>(signal: AbortSignal, url: string, extract: (scene: THREE.Group) => T): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Footballer asset unavailable");
  const model = await new GLTFLoader().parseAsync(await response.arrayBuffer(), "");
  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return extract(model.scene);
  } finally {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    model.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
  }
}
