/**
 * Static pitch geometry: grass, markings and goals. Independent of playback.
 * Markings are painted onto one canvas texture at 20 px per metre.
 */
import * as THREE from "three";
import { PITCH_LENGTH, PITCH_WIDTH } from "@/match/contract";
import { HALF_LENGTH } from "./coords";
import { createGoal } from "./Goal";

/** Grass beyond the lines, in metres. */
const APRON = 6;
const PX_PER_M = 20;
const LINE_WIDTH = 0.12;

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
      const variation = Math.sin(x / 193 + Math.cos(y / 137)) * Math.cos(y / 111) * 4;
      const stripe = Math.floor((x / PX_PER_M - APRON) / (PITCH_LENGTH / 18));
      const inPitch = x >= APRON * PX_PER_M && x <= (APRON + PITCH_LENGTH) * PX_PER_M
        && y >= APRON * PX_PER_M && y <= (APRON + PITCH_WIDTH) * PX_PER_M;
      const mow = inPitch ? (stripe % 2 === 0 ? 5 : -3) : -8;
      const i = (y * canvas.width + x) * 4;
      pixels.data[i] = 65 + grain + variation + mow;
      pixels.data[i + 1] = 103 + grain + variation + mow;
      pixels.data[i + 2] = 32 + grain * 0.5 + variation + mow;
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

  // Small irregular blades catch the light at closer camera distances.
  ctx.lineWidth = 0.7;
  for (let i = 0; i < 85_000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const x = (seed / 4294967296) * canvas.width;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const y = (seed / 4294967296) * canvas.height;
    ctx.strokeStyle = i % 2 ? "rgba(192,201,123,0.12)" : "rgba(21,38,12,0.16)";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 1.5, y - 2.5);
    ctx.stroke();
  }

  // Worn goal mouths, kept subtle and underneath the painted markings.
  for (const x of [APRON, APRON + PITCH_LENGTH]) {
    ctx.save();
    ctx.translate(x * PX_PER_M, (APRON + PITCH_WIDTH / 2) * PX_PER_M);
    ctx.scale(1, 1.8);
    const wear = ctx.createRadialGradient(0, 0, 1, 0, 0, 3.8 * PX_PER_M);
    wear.addColorStop(0, "rgba(157,132,76,0.20)");
    wear.addColorStop(1, "rgba(157,132,76,0)");
    ctx.fillStyle = wear;
    ctx.fillRect(-80, -80, 160, 160);
    ctx.restore();
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
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ color: "#2c421b", roughness: 1 }),
  );
  surround.rotation.x = -Math.PI / 2;
  surround.position.y = -0.02;
  group.add(surround);

  for (const side of [-1, 1] as const) {
    const goal = createGoal(side);
    goal.position.x = side * HALF_LENGTH;
    group.add(goal);
  }
  return group;
}
