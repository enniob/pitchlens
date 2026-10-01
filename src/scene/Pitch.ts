/**
 * Static pitch geometry: grass, markings and goals. Independent of playback.
 * Markings are painted onto one canvas texture at 20 px per metre.
 */
import * as THREE from "three";
import { GOAL_HEIGHT, GOAL_WIDTH, PITCH_LENGTH, PITCH_WIDTH, POST_RADIUS } from "@/match/contract";
import { HALF_LENGTH } from "./coords";

/** Grass beyond the lines, in metres. */
const APRON = 6;
const PX_PER_M = 20;
const LINE_WIDTH = 0.12;
const GOAL_DEPTH = 2;

function paintGrass(): HTMLCanvasElement {
  const totalL = PITCH_LENGTH + APRON * 2;
  const totalW = PITCH_WIDTH + APRON * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(totalL * PX_PER_M);
  canvas.height = Math.round(totalW * PX_PER_M);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable for pitch texture");

  // Mown stripes.
  const stripes = 18;
  const stripeW = PITCH_LENGTH / stripes;
  ctx.fillStyle = "#2f7d32";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? "#358a38" : "#2e7a31";
    ctx.fillRect((APRON + i * stripeW) * PX_PER_M, APRON * PX_PER_M, stripeW * PX_PER_M, PITCH_WIDTH * PX_PER_M);
  }

  // Markings, drawn in pitch metres.
  ctx.save();
  ctx.scale(PX_PER_M, PX_PER_M);
  ctx.translate(APRON, APRON);
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.lineWidth = LINE_WIDTH;

  const L = PITCH_LENGTH;
  const W = PITCH_WIDTH;
  const midY = W / 2;
  ctx.strokeRect(0, 0, L, W);
  ctx.beginPath();
  ctx.moveTo(L / 2, 0);
  ctx.lineTo(L / 2, W);
  ctx.stroke();

  const circle = (x: number, y: number, r: number, a0 = 0, a1 = Math.PI * 2) => {
    ctx.beginPath();
    ctx.arc(x, y, r, a0, a1);
    ctx.stroke();
  };
  const spot = (x: number, y: number) => {
    ctx.beginPath();
    ctx.arc(x, y, 0.22, 0, Math.PI * 2);
    ctx.fill();
  };

  circle(L / 2, midY, 9.15);
  spot(L / 2, midY);

  for (const side of [0, 1] as const) {
    const x0 = side === 0 ? 0 : L;
    const dir = side === 0 ? 1 : -1;
    // Penalty area 16.5 m deep, 40.32 m wide; goal area 5.5 m deep, 18.32 m wide.
    ctx.strokeRect(side === 0 ? 0 : L - 16.5, midY - 20.16, 16.5, 40.32);
    ctx.strokeRect(side === 0 ? 0 : L - 5.5, midY - 9.16, 5.5, 18.32);
    const penX = x0 + dir * 11;
    spot(penX, midY);
    // Penalty arc: the part of the 9.15 m circle outside the area.
    const a = Math.acos(5.5 / 9.15);
    if (side === 0) circle(penX, midY, 9.15, -a, a);
    else circle(penX, midY, 9.15, Math.PI - a, Math.PI + a);
  }

  // Corner arcs.
  circle(0, 0, 1, 0, Math.PI / 2);
  circle(L, 0, 1, Math.PI / 2, Math.PI);
  circle(0, W, 1, -Math.PI / 2, 0);
  circle(L, W, 1, Math.PI, Math.PI * 1.5);
  ctx.restore();

  return canvas;
}

function buildGoal(material: THREE.Material, netMaterial: THREE.Material, side: -1 | 1): THREE.Group {
  const goal = new THREE.Group();
  const half = GOAL_WIDTH / 2;

  const postGeo = new THREE.CylinderGeometry(POST_RADIUS, POST_RADIUS, GOAL_HEIGHT, 12);
  for (const z of [-half, half]) {
    const post = new THREE.Mesh(postGeo, material);
    post.position.set(0, GOAL_HEIGHT / 2, z);
    goal.add(post);
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(POST_RADIUS, POST_RADIUS, GOAL_WIDTH + POST_RADIUS * 2, 12), material);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(0, GOAL_HEIGHT, 0);
  goal.add(bar);

  // Net: back, roof and two sides as wireframe planes.
  const back = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_WIDTH, GOAL_HEIGHT, 24, 8), netMaterial);
  back.position.set(side * GOAL_DEPTH, GOAL_HEIGHT / 2, 0);
  back.rotation.y = Math.PI / 2;
  goal.add(back);
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_DEPTH, GOAL_WIDTH, 6, 24), netMaterial);
  roof.position.set((side * GOAL_DEPTH) / 2, GOAL_HEIGHT, 0);
  roof.rotation.x = Math.PI / 2;
  goal.add(roof);
  for (const z of [-half, half]) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_DEPTH, GOAL_HEIGHT, 6, 8), netMaterial);
    wall.position.set((side * GOAL_DEPTH) / 2, GOAL_HEIGHT / 2, z);
    goal.add(wall);
  }

  goal.position.set(side * HALF_LENGTH, 0, 0);
  return goal;
}

/** Builds the pitch group. Disposal is handled by MatchScene traversing the scene. */
export function createPitch(maxAnisotropy: number): THREE.Group {
  const group = new THREE.Group();
  group.name = "pitch";

  const texture = new THREE.CanvasTexture(paintGrass());
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, maxAnisotropy);
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(PITCH_LENGTH + APRON * 2, PITCH_WIDTH + APRON * 2),
    new THREE.MeshLambertMaterial({ map: texture }),
  );
  grass.rotation.x = -Math.PI / 2;
  grass.receiveShadow = false;
  group.add(grass);

  // Surround so the pitch doesn't float in the void at angled views.
  const surround = new THREE.Mesh(
    new THREE.PlaneGeometry(PITCH_LENGTH + 60, PITCH_WIDTH + 60),
    new THREE.MeshLambertMaterial({ color: "#1d3b22" }),
  );
  surround.rotation.x = -Math.PI / 2;
  surround.position.y = -0.02;
  group.add(surround);

  const frame = new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.4 });
  const net = new THREE.MeshBasicMaterial({
    color: "#e2e8f0",
    wireframe: true,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
  });
  group.add(buildGoal(frame, net, -1));
  group.add(buildGoal(frame, net, 1));
  return group;
}
