import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HALF_LENGTH, HALF_WIDTH } from "./coords";

const PARTS = ["corner-flag-pole", "corner-flag-clips", "corner-flag-cloth"] as const;

function freeModel(object: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    geometries.add(child.geometry);
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

/** Static furniture: physical scale, no playback clock or match data. */
export class CornerFlags {
  readonly object = new THREE.Group();
  private readonly request = new AbortController();
  private disposed = false;

  constructor() {
    this.object.name = "corner-flags";
    const fallback = new THREE.Group();
    fallback.add(new THREE.Mesh(
      new THREE.CylinderGeometry(.0175, .0175, 1.5, 8).translate(0, .75, 0),
      new THREE.MeshStandardMaterial({ color: "#ecebe4", roughness: .45 }),
    ));
    fallback.add(new THREE.Mesh(
      new THREE.PlaneGeometry(.4, .3).translate(.224, 1.27, 0),
      new THREE.MeshStandardMaterial({ color: "#8edcb9", side: THREE.DoubleSide, roughness: .9 }),
    ));
    this.place(fallback);
    this.object.userData.asset = "loading";
    void this.load().catch(() => {
      if (!this.disposed) this.object.userData.asset = "fallback";
    });
  }

  private place(model: THREE.Group): void {
    for (const x of [-1, 1]) for (const z of [-1, 1]) {
      const flag = model.clone(true);
      flag.position.set(x * HALF_LENGTH, 0, z * HALF_WIDTH);
      // Cloth flies away from the playing area at each end of the pitch.
      flag.rotation.y = x < 0 ? Math.PI : 0;
      flag.traverse((child) => {
        if (child instanceof THREE.Mesh) child.castShadow = true;
      });
      this.object.add(flag);
    }
  }

  private async load(): Promise<void> {
    const response = await fetch("/models/corner-flag.glb", { signal: this.request.signal });
    if (!response.ok) throw new Error("Corner flag asset unavailable");
    const { scene } = await new GLTFLoader().parseAsync(await response.arrayBuffer(), "");
    try {
      if (this.disposed || this.request.signal.aborted) return;
      for (const name of PARTS) {
        const part = scene.getObjectByName(name);
        if (!(part instanceof THREE.Mesh) || !part.geometry.getAttribute("position")
          || !part.geometry.getAttribute("normal")) throw new Error(`Invalid corner flag part: ${name}`);
      }
      freeModel(this.object);
      this.object.clear();
      this.place(scene);
      this.object.userData.asset = "blender";
    } finally {
      // Successful clones share the loaded resources; the scene traversal owns them.
      if (this.object.userData.asset !== "blender" || this.disposed) freeModel(scene);
    }
  }

  /** Current resources belong to MatchScene; only cancel pending work here. */
  dispose(): void {
    this.disposed = true;
    this.request.abort();
  }
}
