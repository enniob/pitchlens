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

  // Deterministic turf grain: generated once, with no downloaded assets.
  const pixels = ctx.createImageData(canvas.width, canvas.height);
  let seed = 731;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const grain = ((seed >>> 24) / 255 - 0.5) * 16;
      const variation = Math.sin(x / 93) * Math.cos(y / 71) * 3;
      const stripe = Math.floor((x / PX_PER_M - APRON) / (PITCH_LENGTH / 18));
      const inPitch = x >= APRON * PX_PER_M && x <= (APRON + PITCH_LENGTH) * PX_PER_M
        && y >= APRON * PX_PER_M && y <= (APRON + PITCH_WIDTH) * PX_PER_M;
      const mow = inPitch ? (stripe % 2 === 0 ? 5 : -3) : -8;
      const i = (y * canvas.width + x) * 4;
      pixels.data[i] = 65 + grain + variation + mow;
      pixels.data[i + 1] = 104 + grain + variation + mow;
      pixels.data[i + 2] = 35 + grain * 0.5 + variation + mow;
      pixels.data[i + 3] = 255;
    }
  }
  ctx.putImageData(pixels, 0, 0);

  // Fine, translucent mowing streaks soften the stripe edges.
  const stripes = 18;
  const stripeW = PITCH_LENGTH / stripes;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? "rgba(195,207,119,0.04)" : "rgba(15,40,17,0.04)";
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

function netPanel(width: number, height: number, material: THREE.LineBasicMaterial): THREE.LineSegments {
  const vertices: number[] = [];
  const columns = Math.ceil(width / 0.18);
  const rows = Math.ceil(height / 0.18);
  for (let i = 0; i <= columns; i++) {
    const x = -width / 2 + width * i / columns;
    vertices.push(x, -height / 2, 0, x, height / 2, 0);
  }
  for (let i = 0; i <= rows; i++) {
    const y = -height / 2 + height * i / rows;
    vertices.push(-width / 2, y, 0, width / 2, y, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  return new THREE.LineSegments(geometry, material);
}

function buildGoal(material: THREE.Material, netMaterial: THREE.LineBasicMaterial, side: -1 | 1): THREE.Group {
  const goal = new THREE.Group();
  const half = GOAL_WIDTH / 2;

  const postGeo = new THREE.CylinderGeometry(POST_RADIUS, POST_RADIUS, GOAL_HEIGHT, 12);
  for (const z of [-half, half]) {
    const post = new THREE.Mesh(postGeo, material);
    post.position.set(0, GOAL_HEIGHT / 2, z);
    post.castShadow = true;
    goal.add(post);
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(POST_RADIUS, POST_RADIUS, GOAL_WIDTH + POST_RADIUS * 2, 12), material);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(0, GOAL_HEIGHT, 0);
  bar.castShadow = true;
  goal.add(bar);

  // Square net cells rather than the diagonals of triangulated wireframes.
  const back = netPanel(GOAL_WIDTH, GOAL_HEIGHT, netMaterial);
  back.position.set(side * GOAL_DEPTH, GOAL_HEIGHT / 2, 0);
  back.rotation.y = Math.PI / 2;
  goal.add(back);
  const roof = netPanel(GOAL_DEPTH, GOAL_WIDTH, netMaterial);
  roof.position.set((side * GOAL_DEPTH) / 2, GOAL_HEIGHT, 0);
  roof.rotation.x = Math.PI / 2;
  goal.add(roof);
  for (const z of [-half, half]) {
    const wall = netPanel(GOAL_DEPTH, GOAL_HEIGHT, netMaterial);
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
    new THREE.MeshStandardMaterial({ map: texture, roughness: 0.96 }),
  );
  grass.rotation.x = -Math.PI / 2;
  grass.receiveShadow = true;
  group.add(grass);

  // Surround so the pitch doesn't float in the void at angled views.
  const surround = new THREE.Mesh(
    new THREE.PlaneGeometry(PITCH_LENGTH + 60, PITCH_WIDTH + 60),
    new THREE.MeshStandardMaterial({ color: "#263a22", roughness: 1 }),
  );
  surround.rotation.x = -Math.PI / 2;
  surround.position.y = -0.02;
  group.add(surround);

  const frame = new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.4 });
  const net = new THREE.LineBasicMaterial({
    color: "#e2e8f0",
    transparent: true,
    opacity: 0.48,
  });
  group.add(buildGoal(frame, net, -1));
  group.add(buildGoal(frame, net, 1));
  return group;
}
