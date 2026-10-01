/**
 * One reusable lightweight player model: capsule body in kit colour, head, a
 * chest marker showing facing direction, a ground shadow and a camera-facing
 * number badge that keeps a constant on-screen size. Geometry is shared by all
 * 22 instances; transforms come only from playback state via `setState`.
 *
 * Sizes are slightly exaggerated (≈2.1 m tall) so players read clearly from
 * the overhead camera.
 */
import * as THREE from "three";
import type { Player, PlayerState, Team } from "@/match/contract";
import { facingToRotationY, toScene } from "./coords";

const BODY_RADIUS = 0.42;
const BODY_LENGTH = 0.95;
const HEAD_RADIUS = 0.26;
/** Badge size as a fraction of viewport height, so numbers stay readable at any zoom and screen size. */
const BADGE_SIZE = 0.036;
/** Badge anchor height; the badge is drawn above this point on screen so it never hides the body. */
const BADGE_HEIGHT = 2.3;

export interface PlayerAssets {
  body: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  marker: THREE.BufferGeometry;
  shadow: THREE.BufferGeometry;
  skin: THREE.Material;
  shadowMaterial: THREE.Material;
}

export function createPlayerAssets(): PlayerAssets {
  const marker = new THREE.ConeGeometry(0.2, 0.5, 10);
  marker.rotateZ(-Math.PI / 2); // point along local +x (forward)
  const shadow = new THREE.CircleGeometry(0.75, 20);
  shadow.rotateX(-Math.PI / 2);
  return {
    body: new THREE.CapsuleGeometry(BODY_RADIUS, BODY_LENGTH, 6, 14),
    head: new THREE.SphereGeometry(HEAD_RADIUS, 14, 10),
    marker,
    shadow,
    skin: new THREE.MeshStandardMaterial({ color: "#d6a77a", roughness: 0.8 }),
    shadowMaterial: new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.28, depthWrite: false }),
  };
}

function numberBadgeTexture(number: number, kit: Team["kit"]): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable for player numbers");
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  ctx.fillStyle = kit.primary;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = kit.number;
  ctx.stroke();
  ctx.fillStyle = kit.number;
  ctx.font = "bold 64px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(number), size / 2, size / 2 + 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class PlayerModel {
  readonly object = new THREE.Group();

  constructor(
    readonly player: Player,
    team: Team,
    assets: PlayerAssets,
  ) {
    this.object.name = `player:${player.id}`;
    // Goalkeepers wear the team's secondary colour so they stand out.
    const kitColor = player.role === "GK" ? team.kit.secondary : team.kit.primary;
    const kit = new THREE.MeshStandardMaterial({ color: kitColor, roughness: 0.6 });

    const shadow = new THREE.Mesh(assets.shadow, assets.shadowMaterial);
    shadow.position.y = 0.02;
    shadow.renderOrder = 1;

    const body = new THREE.Mesh(assets.body, kit);
    body.position.y = BODY_RADIUS + BODY_LENGTH / 2;

    const head = new THREE.Mesh(assets.head, assets.skin);
    head.position.y = BODY_RADIUS * 2 + BODY_LENGTH + HEAD_RADIUS * 0.8;

    const marker = new THREE.Mesh(assets.marker, kit);
    marker.position.set(BODY_RADIUS + 0.2, BODY_RADIUS + BODY_LENGTH * 0.75, 0);

    const badge = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: numberBadgeTexture(player.number, team.kit), depthTest: false, sizeAttenuation: false }),
    );
    badge.scale.set(BADGE_SIZE, BADGE_SIZE, 1);
    badge.center.set(0.5, -0.1);
    badge.position.y = BADGE_HEIGHT;
    badge.renderOrder = 10;

    this.object.add(shadow, body, head, marker, badge);
  }

  setState(state: PlayerState): void {
    const [x, y, z] = toScene(state.x, state.y);
    this.object.position.set(x, y, z);
    this.object.rotation.y = facingToRotationY(state.facing);
  }
}
