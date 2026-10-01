/**
 * Ball model, driven only by playback state. Rendered larger than a real ball
 * (0.38 m radius vs 0.11 m) so it is visible from the overhead camera; a ground
 * shadow that fades with height conveys z.
 */
import * as THREE from "three";
import type { Vec3 } from "@/match/contract";
import { toScene } from "./coords";

/** Radius of a real ball, used by the fixture for "on the ground" z. */
const REAL_RADIUS = 0.11;
const RENDER_RADIUS = 0.38;

export class BallModel {
  readonly object = new THREE.Group();
  private readonly ball: THREE.Mesh;
  private readonly shadow: THREE.Mesh;
  private readonly shadowMaterial: THREE.MeshBasicMaterial;

  constructor() {
    this.object.name = "ball";
    this.ball = new THREE.Mesh(
      new THREE.IcosahedronGeometry(RENDER_RADIUS, 2),
      new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.35, emissive: "#6b6b55", flatShading: true }),
    );
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      color: "#000000",
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    const shadowGeo = new THREE.CircleGeometry(RENDER_RADIUS * 1.1, 20);
    shadowGeo.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(shadowGeo, this.shadowMaterial);
    this.shadow.renderOrder = 1;
    this.object.add(this.ball, this.shadow);
  }

  setPosition(p: Vec3): void {
    const height = Math.max(0, p.z - REAL_RADIUS);
    const [x, , z] = toScene(p.x, p.y);
    this.ball.position.set(x, RENDER_RADIUS + height, z);
    this.shadow.position.set(x, 0.025, z);
    const fade = Math.max(0.15, 1 - height / 6);
    this.shadow.scale.setScalar(1 + height * 0.12);
    this.shadowMaterial.opacity = 0.4 * fade;
  }
}
