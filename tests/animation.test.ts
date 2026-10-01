import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { sampleFixture } from "@/match/fixture";
import { KICK_RECOVER_MS, KICK_WINDUP_MS, kickContacts, motionAt } from "@/playback/animation";
import { ballRadiusAtZoom } from "@/scene/Ball";
import { poseFor, STRIDE_CYCLE } from "@/scene/pose";
import { ANKLE_HEIGHT, HEAD_HEIGHT, HEAD_RADIUS, HIP_HEIGHT, MODEL_SCALE, Rig, solveRig, TOE_REACH } from "@/scene/rig";
import { DRIBBLE_OFFSET, generateMatch, MAX_PLAYER_SPEED } from "@/simulation/generate";

const generated = generateMatch({ seed: 42, durationMs: 60_000 });
const fixtures = [
  ["scripted 1.0.0", sampleFixture],
  ["generated 1.1.0", generated],
] as const;

const still = { speed: 0, distance: 0, kickMs: null };

/** World position of a point given in a rig part's local frame. */
const worldPoint = (m: THREE.Matrix4, x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m);
const toe = (rig: Rig, leg: 0 | 1) => worldPoint(rig.foot[leg], TOE_REACH, -ANKLE_HEIGHT, 0);

describe.each(fixtures)("player motion from snapshots: %s", (_name, f) => {
  it("is a pure function of time", () => {
    for (const t of [0, 1_234, f.durationMs / 2, f.durationMs]) {
      const first = motionAt(f, t);
      motionAt(f, f.durationMs);
      motionAt(f, 0);
      expect(motionAt(f, t)).toEqual(first);
      expect(first.map((m) => m.playerId)).toEqual(f.snapshots[0]!.players.map((p) => p.playerId));
    }
    expect(motionAt(f, -50)).toEqual(motionAt(f, 0));
    expect(motionAt(f, f.durationMs + 50)).toEqual(motionAt(f, f.durationMs));
  });

  it("reports bounded speeds and a distance that only grows", () => {
    let last = motionAt(f, 0);
    for (let t = 0; t <= f.durationMs; t += 130) {
      const now = motionAt(f, t);
      now.forEach((m, i) => {
        expect(m.speed).toBeGreaterThanOrEqual(0);
        // The scripted demo's keyframed sprints are a little quicker than the simulator's limit.
        expect(m.speed).toBeLessThanOrEqual(f === generated ? MAX_PLAYER_SPEED + 1e-6 : 10);
        expect(m.distance).toBeGreaterThanOrEqual(last[i]!.distance);
        // The stride never jumps: 130 ms of travel is well under one cycle.
        expect(m.distance - last[i]!.distance).toBeLessThan(STRIDE_CYCLE);
      });
      last = now;
    }
  });

  it("does not count a dead-ball cut as running", () => {
    const cut = f.snapshots.find((s) => s.discontinuity);
    if (!cut) return;
    const justBefore = motionAt(f, cut.t - 1);
    const at = motionAt(f, cut.t);
    at.forEach((m, i) => expect(m.distance - justBefore[i]!.distance).toBeLessThan(0.02));
  });

  it("puts each kicker, and only them, in a kick window around the strike", () => {
    const contacts = kickContacts(f);
    expect(contacts.length).toBeGreaterThan(0);
    for (const c of contacts) {
      const offset = (dt: number) => motionAt(f, c.t + dt).find((m) => m.playerId === c.playerId)!.kickMs;
      expect(offset(0)).toBe(0);
      expect(offset(-KICK_WINDUP_MS)).toBe(-KICK_WINDUP_MS);
      expect(offset(100)).toBe(100);
      if (c.t + KICK_RECOVER_MS <= f.durationMs) expect(offset(KICK_RECOVER_MS)).toBeNull();
    }
    const first = contacts[0]!;
    for (const m of motionAt(f, first.t)) if (m.playerId !== first.playerId) expect(m.kickMs).toBeNull();
    expect(motionAt(f, first.t - KICK_WINDUP_MS - 1).every((m) => m.kickMs === null)).toBe(true);
  });

  it("needs no events, so animation cannot reveal anything the feed has not shown", () => {
    const bare = { ...f, events: [] };
    for (const t of [0, 3_333, f.durationMs * 0.7]) expect(motionAt(bare, t)).toEqual(motionAt(f, t));
  });
});

describe("poses", () => {
  it("stands almost still when idle, with only a slow sway", () => {
    for (const t of [0, 400, 5_000]) {
      const pose = poseFor(still, t, 1.3, 1);
      for (const side of [0, 1] as const) {
        expect(Math.abs(pose.hip[side])).toBeLessThan(0.01);
        expect(Math.abs(pose.shoulder[side])).toBeLessThan(0.05);
      }
      expect(Math.abs(pose.bob)).toBeLessThan(0.01);
    }
    expect(poseFor(still, 0, 1.3, 1)).not.toEqual(poseFor(still, 700, 1.3, 1));
    expect(poseFor(still, 700, 1.3, 1)).toEqual(poseFor(still, 700, 1.3, 1));
  });

  it("runs with legs in antiphase, arms opposite the legs and a longer stride at speed", () => {
    const quarter = STRIDE_CYCLE / 4;
    const sprint = poseFor({ speed: 6.5, distance: quarter, kickMs: null }, 0, 0, 1);
    expect(sprint.hip[1]).toBeGreaterThan(0.6);
    expect(sprint.hip[0]).toBeCloseTo(-sprint.hip[1], 9);
    expect(Math.sign(sprint.shoulder[1])).toBe(-Math.sign(sprint.hip[1]));
    expect(sprint.lean).toBeGreaterThan(0.15);
    const jog = poseFor({ speed: 2.5, distance: quarter, kickMs: null }, 0, 0, 1);
    expect(jog.hip[1]).toBeGreaterThan(0.2);
    expect(jog.hip[1]).toBeLessThan(sprint.hip[1]);
    // One stride cycle of travel returns to the same pose; half a cycle swaps the legs.
    const start = poseFor({ speed: 5, distance: 1, kickMs: null }, 0, 0, 1);
    const cycle = poseFor({ speed: 5, distance: 1 + STRIDE_CYCLE, kickMs: null }, 0, 0, 1);
    const half = poseFor({ speed: 5, distance: 1 + STRIDE_CYCLE / 2, kickMs: null }, 0, 0, 1);
    expect(cycle.hip[1]).toBeCloseTo(start.hip[1], 9);
    expect(half.hip[1]).toBeCloseTo(start.hip[0], 9);
  });

  it.each([0, 1] as const)("swings leg %s back, then through the ball at contact", (leg) => {
    const rig = new Rig();
    const toeAt = (kickMs: number) => {
      solveRig(rig, 0, 0, 0, poseFor({ speed: 0, distance: 0, kickMs }, 0, 0, leg));
      return toe(rig, leg);
    };
    expect(toeAt(-90).x).toBeLessThan(0);
    const contact = toeAt(0);
    // The simulator puts the ball DRIBBLE_OFFSET ahead of the player; the boot meets it there, low.
    expect(Math.abs(contact.x - DRIBBLE_OFFSET)).toBeLessThan(0.25);
    expect(contact.y).toBeLessThan(0.45);
    expect(toeAt(110).x).toBeGreaterThan(contact.x);
    expect(toeAt(110).y).toBeGreaterThan(contact.y);
    // The kick blends in from, and back out to, the ordinary pose.
    expect(poseFor({ ...still, kickMs: -KICK_WINDUP_MS }, 0, 0, leg)).toEqual(poseFor(still, 0, 0, leg));
    expect(poseFor({ ...still, kickMs: KICK_RECOVER_MS }, 0, 0, leg)).toEqual(poseFor(still, 0, 0, leg));
  });
});

describe("rig", () => {
  it("stands on the pitch at the given position with the head on top", () => {
    const rig = new Rig();
    solveRig(rig, 12, -7, 0, poseFor(still, 0, 0, 1));
    for (const leg of [0, 1] as const) {
      const sole = worldPoint(rig.foot[leg], 0, -ANKLE_HEIGHT, 0);
      expect(sole.y).toBeLessThan(0.05);
      expect(sole.y).toBeGreaterThan(-0.05);
      expect(Math.abs(sole.x - 12)).toBeLessThan(0.15);
    }
    const crown = worldPoint(rig.head, 0, HEAD_RADIUS, 0);
    expect(crown.y).toBeCloseTo((HIP_HEIGHT + HEAD_HEIGHT + HEAD_RADIUS) * MODEL_SCALE, 1);
    expect(crown.z).toBeCloseTo(-7, 1);
  });

  it("turns the whole body with the facing, matching the scene convention", () => {
    const rig = new Rig();
    // facing = +y in pitch space → rotation.y = −π/2 → model forward (+x) points along scene +z.
    solveRig(rig, 0, 0, -Math.PI / 2, poseFor({ ...still, kickMs: 0 }, 0, 0, 1));
    const contact = toe(rig, 1);
    expect(contact.z).toBeGreaterThan(0.3);
    expect(Math.abs(contact.x)).toBeLessThan(0.25);
  });
});

describe("ball size", () => {
  it("is enlarged for the full-pitch view and in proportion with the players once zoomed in", () => {
    expect(ballRadiusAtZoom(1)).toBeGreaterThan(0.3);
    // A real 0.11 m ball at the players' model scale.
    for (const zoom of [2.2, 3, 4]) expect(ballRadiusAtZoom(zoom)).toBeCloseTo(0.11 * MODEL_SCALE, 9);
    let last = ballRadiusAtZoom(1);
    for (let zoom = 1; zoom <= 4; zoom += 0.1) {
      expect(ballRadiusAtZoom(zoom)).toBeLessThanOrEqual(last);
      last = ballRadiusAtZoom(zoom);
    }
    expect(ballRadiusAtZoom(0.5)).toBe(ballRadiusAtZoom(1));
  });
});
