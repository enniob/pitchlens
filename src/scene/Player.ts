/**
 * Procedural footballers: head and hair, shirt, shorts, arms, legs with socks
 * and boots, in the team's kit. No external model or texture assets are used —
 * every shape is built here from Three.js primitives.
 *
 * To keep 22 animated players cheap on phones, each body part is one
 * InstancedMesh shared by all players (ten draw calls for every body on the
 * pitch) with per-instance colours for kits and skin. Per frame the rig solves
 * one matrix per part from the recorded player state and its derived pose.
 *
 * Shirt numbers appear twice: on the back of the shirt, and on a camera-facing
 * badge above the head that keeps a constant on-screen size so it stays
 * readable from the overhead camera and on small screens.
 */
import * as THREE from "three";
import type { MatchFixture, Player, PlayerState, Team } from "@/match/contract";
import type { PlayerMotion } from "@/playback/animation";
import { facingToRotationY, toScene } from "./coords";
import { poseFor } from "./pose";
import {
  ANKLE_HEIGHT,
  FOREARM_LENGTH,
  HEAD_RADIUS,
  Rig,
  SHIN_LENGTH,
  SHOULDER_HEIGHT,
  solveRig,
  THIGH_LENGTH,
  TOE_REACH,
  UPPER_ARM_LENGTH,
} from "./rig";

/** Badge size as a fraction of viewport height, so numbers stay readable at any zoom and screen size. */
const BADGE_SIZE = 0.036;
/** Badge anchor height; the badge is drawn above this point on screen so it never hides the body. */
const BADGE_HEIGHT = 2.65;

const SKIN_TONES = ["#f1c9a5", "#d6a77a", "#a9744f", "#6f4a34"];
const HAIR_COLORS = ["#1c1917", "#3f2a1d", "#6b4423", "#c8a165"];
const BOOT_COLOR = "#16181d";
const KEEPER_SHORTS = "#0f172a";

/** Stable small hash so a player's look depends only on their ID. */
function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Limb hanging down from its joint at the origin. */
function limb(radius: number, length: number): THREE.BufferGeometry {
  return new THREE.CapsuleGeometry(radius, length - radius, 3, 8).translate(0, -length / 2, 0);
}

function numberTexture(number: number, kit: Team["kit"], badge: boolean): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable for player numbers");
  if (badge) {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
    ctx.fillStyle = kit.primary;
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = kit.number;
    ctx.stroke();
  }
  ctx.fillStyle = kit.number;
  ctx.font = `bold ${badge ? 64 : 104}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(number), size / 2, size / 2 + 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

interface Member {
  player: Player;
  rig: Rig;
  /** Phase offset so players do not stride or sway in unison. */
  seed: number;
  kickLeg: 0 | 1;
  badge: THREE.Sprite;
  backNumber: THREE.Mesh;
}

export class PlayerSquad {
  readonly object = new THREE.Group();
  private readonly members = new Map<string, Member>();
  private readonly order: Member[] = [];

  private readonly torso: THREE.InstancedMesh;
  private readonly shorts: THREE.InstancedMesh;
  private readonly head: THREE.InstancedMesh;
  private readonly hair: THREE.InstancedMesh;
  private readonly shadow: THREE.InstancedMesh;
  // Paired parts hold two instances per player: left at 2i, right at 2i + 1.
  private readonly upperArm: THREE.InstancedMesh;
  private readonly forearm: THREE.InstancedMesh;
  private readonly thigh: THREE.InstancedMesh;
  private readonly shin: THREE.InstancedMesh;
  private readonly boot: THREE.InstancedMesh;
  private readonly ground = new THREE.Matrix4();

  constructor(fixture: MatchFixture) {
    this.object.name = "players";
    const count = fixture.roster.length;
    const cloth = new THREE.MeshLambertMaterial();
    const part = (geometry: THREE.BufferGeometry, perPlayer: number, material: THREE.Material = cloth) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count * perPlayer);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instances are spread across the whole pitch, so a single bounding sphere is useless for culling.
      mesh.frustumCulled = false;
      this.object.add(mesh);
      return mesh;
    };

    // Shirt: an oval tube, wider at the shoulders, from just below the waist to the shoulder line.
    const shirt = new THREE.CylinderGeometry(0.22, 0.165, 0.62, 12).scale(0.62, 1, 1).translate(0, 0.27, 0);
    const shortsGeo = new THREE.CylinderGeometry(0.17, 0.195, 0.27, 12).scale(0.75, 1, 1).translate(0, -0.1, 0);
    const hairGeo = new THREE.SphereGeometry(HEAD_RADIUS * 1.06, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55)
      .rotateZ(0.45)
      .translate(-0.012, 0.012, 0);
    const bootGeo = new THREE.BoxGeometry(TOE_REACH + 0.08, 0.085, 0.105).translate(TOE_REACH / 2 - 0.01, 0.0425 - ANKLE_HEIGHT, 0);
    const shadowGeo = new THREE.CircleGeometry(0.72, 20).rotateX(-Math.PI / 2);

    this.shadow = part(
      shadowGeo,
      1,
      new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.28, depthWrite: false }),
    );
    this.shadow.renderOrder = 1;
    this.torso = part(shirt, 1);
    this.shorts = part(shortsGeo, 1);
    this.head = part(new THREE.SphereGeometry(HEAD_RADIUS, 12, 10), 1);
    this.hair = part(hairGeo, 1);
    this.upperArm = part(limb(0.06, UPPER_ARM_LENGTH), 2);
    this.forearm = part(limb(0.047, FOREARM_LENGTH), 2);
    this.thigh = part(limb(0.09, THIGH_LENGTH), 2);
    this.shin = part(limb(0.068, SHIN_LENGTH), 2);
    this.boot = part(bootGeo, 2);

    // Number on the back of the shirt: a small plane just behind the torso, facing backwards.
    const backGeo = new THREE.PlaneGeometry(0.26, 0.26).rotateY(-Math.PI / 2).translate(-0.145, SHOULDER_HEIGHT - 0.2, 0);

    const teams = new Map(fixture.teams.map((t) => [t.id, t]));
    const color = new THREE.Color();
    fixture.roster.forEach((player, i) => {
      const team = teams.get(player.teamId)!;
      const look = hash(player.id);
      const keeper = player.role === "GK";
      // Goalkeepers wear the team's secondary colour, long sleeves and dark shorts so they stand out.
      const shirtColor = keeper ? team.kit.secondary : team.kit.primary;
      const shortsColor = keeper ? KEEPER_SHORTS : team.kit.secondary;
      const skin = SKIN_TONES[look % SKIN_TONES.length]!;
      this.torso.setColorAt(i, color.set(shirtColor));
      this.shorts.setColorAt(i, color.set(shortsColor));
      this.head.setColorAt(i, color.set(skin));
      this.hair.setColorAt(i, color.set(HAIR_COLORS[(look >>> 4) % HAIR_COLORS.length]!));
      for (const side of [0, 1]) {
        this.upperArm.setColorAt(i * 2 + side, color.set(shirtColor));
        this.forearm.setColorAt(i * 2 + side, color.set(keeper ? shirtColor : skin));
        this.thigh.setColorAt(i * 2 + side, color.set(skin));
        this.shin.setColorAt(i * 2 + side, color.set(shirtColor));
        this.boot.setColorAt(i * 2 + side, color.set(BOOT_COLOR));
      }

      const badge = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: numberTexture(player.number, team.kit, true), depthTest: false, sizeAttenuation: false }),
      );
      badge.name = `badge:${player.id}`;
      badge.scale.set(BADGE_SIZE, BADGE_SIZE, 1);
      badge.center.set(0.5, -0.1);
      badge.renderOrder = 10;

      const backNumber = new THREE.Mesh(
        backGeo,
        new THREE.MeshBasicMaterial({ map: numberTexture(player.number, team.kit, false), transparent: true, depthWrite: false }),
      );
      backNumber.matrixAutoUpdate = false;
      backNumber.frustumCulled = false;

      const member: Member = {
        player,
        rig: new Rig(),
        seed: (look % 628) / 100,
        kickLeg: (look >>> 8) % 4 === 0 ? 0 : 1,
        badge,
        backNumber,
      };
      this.members.set(player.id, member);
      this.order.push(member);
      this.object.add(badge, backNumber);
    });
  }

  /** Poses every player from recorded state plus motion derived from the same snapshots. */
  update(states: readonly PlayerState[], motions: readonly PlayerMotion[], timeMs: number): void {
    const motionById = new Map(motions.map((m) => [m.playerId, m]));
    for (const state of states) {
      const member = this.members.get(state.playerId);
      const motion = motionById.get(state.playerId);
      if (!member || !motion) continue;
      const [x, , z] = toScene(state.x, state.y);
      solveRig(member.rig, x, z, facingToRotationY(state.facing), poseFor(motion, timeMs, member.seed, member.kickLeg));
      member.badge.position.set(x, BADGE_HEIGHT, z);
      member.backNumber.matrix.copy(member.rig.torso);
    }
    this.order.forEach(({ rig }, i) => {
      this.torso.setMatrixAt(i, rig.torso);
      this.shorts.setMatrixAt(i, rig.pelvis);
      this.head.setMatrixAt(i, rig.head);
      this.hair.setMatrixAt(i, rig.head);
      // Under the hips, so a diving or fallen player's shadow stays under their body.
      this.shadow.setMatrixAt(i, this.ground.makeTranslation(rig.pelvis.elements[12]!, 0.02, rig.pelvis.elements[14]!));
      for (const side of [0, 1] as const) {
        this.upperArm.setMatrixAt(i * 2 + side, rig.upperArm[side]);
        this.forearm.setMatrixAt(i * 2 + side, rig.forearm[side]);
        this.thigh.setMatrixAt(i * 2 + side, rig.thigh[side]);
        this.shin.setMatrixAt(i * 2 + side, rig.shin[side]);
        this.boot.setMatrixAt(i * 2 + side, rig.foot[side]);
      }
    });
    for (const mesh of this.instanced) mesh.instanceMatrix.needsUpdate = true;
  }

  /** Geometry, materials and textures are disposed by MatchScene's scene traversal; this frees instance buffers. */
  dispose(): void {
    for (const mesh of this.instanced) mesh.dispose();
    this.members.clear();
    this.order.length = 0;
  }

  private get instanced(): THREE.InstancedMesh[] {
    return [this.torso, this.shorts, this.head, this.hair, this.shadow, this.upperArm, this.forearm, this.thigh, this.shin, this.boot];
  }
}
