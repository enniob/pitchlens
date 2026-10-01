/**
 * Ball model, driven only by playback state. From the full-pitch view it is
 * drawn much larger than a real ball so it stays visible; as the camera zooms
 * in it shrinks to the same scale as the players, so it never looks oversized
 * next to them. A ground shadow that fades with height conveys z.
 */
import * as THREE from "three";
import type { Vec3 } from "@/match/contract";
import { toScene } from "./coords";
import { MODEL_SCALE } from "./rig";

/** Radius of a real ball, used by the fixture for "on the ground" z. */
const REAL_RADIUS = 0.11;
/** Radius at the full-pitch view (zoom 1). */
const OVERVIEW_RADIUS = 0.38;
/** Radius once zoomed in: a real ball at the players' model scale. */
const CLOSE_RADIUS = REAL_RADIUS * MODEL_SCALE;
/** Zoom level from which the ball is fully in proportion with the players. */
const PROPORTIONAL_ZOOM = 2.2;

/** Rendered ball radius for a camera zoom level (1 = whole pitch in view). */
export function ballRadiusAtZoom(zoom: number): number {
  const k = Math.min(1, Math.max(0, (zoom - 1) / (PROPORTIONAL_ZOOM - 1)));
  return OVERVIEW_RADIUS + (CLOSE_RADIUS - OVERVIEW_RADIUS) * k;
}

export class BallModel {
  readonly object = new THREE.Group();
  private readonly ball: THREE.Mesh;
  private readonly shadow: THREE.Mesh;
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private radius = OVERVIEW_RADIUS;
  private position: Vec3 = { x: 0, y: 0, z: REAL_RADIUS };

  constructor() {
    this.object.name = "ball";
    // Unit-radius geometry, scaled to the current render radius.
    this.ball = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 2),
      new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.35, emissive: "#6b6b55", flatShading: true }),
    );
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      color: "#000000",
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    const shadowGeo = new THREE.CircleGeometry(1.1, 20);
    shadowGeo.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(shadowGeo, this.shadowMaterial);
    this.shadow.renderOrder = 1;
    this.object.add(this.ball, this.shadow);
    this.place();
  }

  setPosition(p: Vec3): void {
    this.position = p;
    this.place();
  }

  /** Camera-dependent presentation only: the recorded ball position is unchanged. */
  setZoom(zoom: number): void {
    const radius = ballRadiusAtZoom(zoom);
    if (radius === this.radius) return;
    this.radius = radius;
    this.place();
  }

  private place(): void {
    const p = this.position;
    const height = Math.max(0, p.z - REAL_RADIUS);
    const [x, , z] = toScene(p.x, p.y);
    this.ball.scale.setScalar(this.radius);
    this.ball.position.set(x, this.radius + height, z);
    this.shadow.position.set(x, 0.025, z);
    const fade = Math.max(0.15, 1 - height / 6);
    this.shadow.scale.setScalar(this.radius * (1 + height * 0.12));
    this.shadowMaterial.opacity = 0.4 * fade;
  }
}
