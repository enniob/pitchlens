import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { sampleFixture } from "@/match/fixture";
import {
  ballContacts,
  CONTACT_WINDOW,
  KICK_RECOVER_MS,
  KICK_WINDUP_MS,
  kickContacts,
  MAX_WINDUP_MS,
  motionAt,
  type ContactKind,
  type PlayerAction,
} from "@/playback/animation";
import { ballRadiusAtZoom } from "@/scene/Ball";
import { positionsAt } from "@/playback/derive";
import { facingToRotationY, toScene } from "@/scene/coords";
import { DIVE_ANGLE, poseFor, STRIDE_CYCLE } from "@/scene/pose";
import {
  ANKLE_HEIGHT,
  FOREARM_LENGTH,
  HEAD_HEIGHT,
  HEAD_RADIUS,
  HIP_HEIGHT,
  MODEL_SCALE,
  Rig,
  solveRig,
  TOE_REACH,
} from "@/scene/rig";
import { DRIBBLE_OFFSET, generateMatch, MAX_PLAYER_SPEED } from "@/simulation/generate";

const generated = generateMatch({ seed: 42, durationMs: 60_000 });
const fixtures = [
  ["scripted 1.0.0", sampleFixture],
  ["generated 1.2.0", generated],
] as const;

const still = { speed: 0, distance: 0, action: null };
/** An action as motionAt would report it, `ms` from its contact. */
const act = (kind: ContactKind, ms: number, extra: Partial<PlayerAction> = {}): PlayerAction => ({
  kind,
  ms,
  lead: CONTACT_WINDOW[kind][0],
  side: 0,
  height: 0.11,
  reach: 0.5,
  turn: 0,
  ...extra,
});
const kickAt = (ms: number) => act("kick", ms);

/** World position of a point given in a rig part's local frame. */
const worldPoint = (m: THREE.Matrix4, x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m);
const toe = (rig: Rig, leg: 0 | 1) => worldPoint(rig.foot[leg], TOE_REACH, -ANKLE_HEIGHT, 0);
const snapshotAt = <S extends { t: number }>(f: { snapshots: S[] }, t: number) => f.snapshots.find((s) => s.t === t)!;

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

  it("puts each kicker in a kick window around the strike", () => {
    const contacts = kickContacts(f).filter((c) => c.kind === "kick");
    expect(contacts.length).toBeGreaterThan(0);
    for (const c of contacts) {
      const action = (dt: number) => motionAt(f, c.t + dt).find((m) => m.playerId === c.playerId)!.action;
      expect(action(0)).toMatchObject({ kind: "kick", ms: 0 });
      expect(action(-KICK_WINDUP_MS)).toMatchObject({ kind: "kick", ms: -KICK_WINDUP_MS });
      expect(action(100)).toMatchObject({ kind: "kick", ms: 100 });
      // Afterwards the player is idle again, or already into their next contact.
      if (c.t + KICK_RECOVER_MS + 1 <= f.durationMs) expect(action(KICK_RECOVER_MS + 1)?.ms ?? null).not.toBe(KICK_RECOVER_MS + 1);
    }
  });

  it("animates nobody before the first contact, and only that player when it starts", () => {
    const first = ballContacts(f)[0]!;
    expect(motionAt(f, first.start - 1).every((m) => m.action === null)).toBe(true);
    for (const m of motionAt(f, first.start)) expect(m.action === null).toBe(m.playerId !== first.playerId);
    // No contact needs to look further ahead than its wind-up.
    for (const c of ballContacts(f)) if (c.kind !== "throw") expect(c.t - c.start).toBeLessThanOrEqual(MAX_WINDUP_MS);
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
    const sprint = poseFor({ speed: 6.5, distance: quarter, action: null }, 0, 0, 1);
    expect(sprint.hip[1]).toBeGreaterThan(0.6);
    expect(sprint.hip[0]).toBeCloseTo(-sprint.hip[1], 9);
    expect(Math.sign(sprint.shoulder[1])).toBe(-Math.sign(sprint.hip[1]));
    expect(sprint.lean).toBeGreaterThan(0.15);
    const jog = poseFor({ speed: 2.5, distance: quarter, action: null }, 0, 0, 1);
    expect(jog.hip[1]).toBeGreaterThan(0.2);
    expect(jog.hip[1]).toBeLessThan(sprint.hip[1]);
    // One stride cycle of travel returns to the same pose; half a cycle swaps the legs.
    const start = poseFor({ speed: 5, distance: 1, action: null }, 0, 0, 1);
    const cycle = poseFor({ speed: 5, distance: 1 + STRIDE_CYCLE, action: null }, 0, 0, 1);
    const half = poseFor({ speed: 5, distance: 1 + STRIDE_CYCLE / 2, action: null }, 0, 0, 1);
    expect(cycle.hip[1]).toBeCloseTo(start.hip[1], 9);
    expect(half.hip[1]).toBeCloseTo(start.hip[0], 9);
  });

  it.each([0, 1] as const)("swings leg %s back, then through the ball at contact", (leg) => {
    const rig = new Rig();
    const toeAt = (kickMs: number) => {
      solveRig(rig, 0, 0, 0, poseFor({ speed: 0, distance: 0, action: kickAt(kickMs) }, 0, 0, leg));
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
    expect(poseFor({ ...still, action: kickAt(-KICK_WINDUP_MS) }, 0, 0, leg)).toEqual(poseFor(still, 0, 0, leg));
    expect(poseFor({ ...still, action: kickAt(KICK_RECOVER_MS) }, 0, 0, leg)).toEqual(poseFor(still, 0, 0, leg));
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
    solveRig(rig, 0, 0, -Math.PI / 2, poseFor({ ...still, action: kickAt(0) }, 0, 0, 1));
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

describe("ball contacts recognised from snapshots match what the simulator did", () => {
  const matches = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((seed) => generateMatch({ seed, durationMs: 120_000 }));
  const all = matches.flatMap((f) => {
    const contacts = ballContacts(f);
    const at = (t: number, playerId: string | undefined) => contacts.filter((c) => c.t === t && c.playerId === playerId);
    return [{ f, contacts, at }];
  });
  const role = (f: (typeof matches)[number], id: string) => f.roster.find((p) => p.id === id)!.role;

  it("covers every kind of contact across the sampled seeds", () => {
    const kinds = new Set(all.flatMap(({ contacts }) => contacts.map((c) => c.kind)));
    expect([...kinds].sort()).toEqual(["block", "fall", "kick", "receive", "save", "tackle", "throw"]);
  });

  it("puts a fouled player on the ground and the fouler in a tackle, and nobody else", () => {
    for (const { f, contacts, at } of all) {
      const fouls = f.events.filter((e) => e.type === "foul");
      for (const foul of fouls) {
        const victim = f.snapshots[f.snapshots.findIndex((s) => s.t === foul.t) - 1]!.possession!.playerId!;
        expect(at(foul.t, victim).map((c) => c.kind)).toEqual(["fall"]);
        expect(at(foul.t, foul.playerId).map((c) => c.kind)).toEqual(["tackle"]);
      }
      expect(contacts.filter((c) => c.kind === "fall").map((c) => c.t)).toEqual(fouls.map((e) => e.t));
    }
  });

  it("animates receptions, tackles, parries and throw-ins where they happened", () => {
    for (const { f, contacts, at } of all) {
      for (const e of f.events) {
        if (e.type === "pass" && e.outcome === "complete") {
          const kinds = at(e.t, e.recipientId).map((c) => c.kind);
          expect(kinds).toEqual([role(f, e.recipientId!) === "GK" && kinds[0] === "save" ? "save" : "receive"]);
        }
        if (e.type === "turnover" && e.description.includes("wins the ball")) expect(at(e.t, e.playerId).map((c) => c.kind)).toEqual(["tackle"]);
        if (e.type === "deflection" && e.description.startsWith("Parried")) expect(at(e.t, e.playerId).map((c) => c.kind)).toEqual(["save"]);
        if (e.type === "throw-in") {
          const release = contacts.find((c) => c.kind === "throw" && c.playerId === e.playerId && c.t > e.t);
          // Held from the moment of the restart until the release.
          if (release) expect(release.start).toBe(e.t);
        }
      }
    }
  });

  it("dives a goalkeeper towards where the ball actually is", () => {
    const rig = new Rig();
    let dives = 0;
    for (const { f, contacts } of all) {
      for (const c of contacts.filter((x) => x.kind === "save" && Math.atan2(Math.abs(x.side), Math.max(0.3, x.height - 0.1)) > DIVE_ANGLE)) {
        dives++;
        const t = c.t + 150;
        const keeper = positionsAt(f, t).players.find((p) => p.playerId === c.playerId)!;
        const motion = motionAt(f, t).find((m) => m.playerId === c.playerId)!;
        const [x, , z] = toScene(keeper.x, keeper.y);
        solveRig(rig, x, z, facingToRotationY(keeper.facing), poseFor(motion, t, 0, 1));
        const head = worldPoint(rig.head, 0, 0, 0);
        // The body is laid out from the feet towards where the ball was, relative to the keeper, at the contact.
        const at = snapshotAt(f, c.t);
        const was = at.players.find((p) => p.playerId === c.playerId)!;
        const [dx, dz] = [at.ball.x - was.x, at.ball.y - was.y];
        expect((head.x - x) * dx + (head.z - z) * dz).toBeGreaterThan(0);
      }
    }
    expect(dives).toBeGreaterThan(3);
  });

  it("only shows a block where the ball came off that player, and a save only by a goalkeeper", () => {
    let blocks = 0;
    for (const { f, contacts } of all) {
      for (const c of contacts.filter((x) => x.kind === "block")) {
        blocks++;
        expect(f.events.some((e) => e.type === "deflection" && e.t === c.t && e.playerId === c.playerId)).toBe(true);
      }
      for (const c of contacts.filter((x) => x.kind === "save")) expect(role(f, c.playerId)).toBe("GK");
    }
    expect(blocks).toBeGreaterThan(5);
  });
});

describe("contact poses", () => {
  const rig = new Rig();
  const solve = (action: PlayerAction, leg: 0 | 1 = 1) => {
    solveRig(rig, 0, 0, 0, poseFor({ ...still, action }, 0, 0, leg));
    return rig;
  };
  const head = (r: Rig) => worldPoint(r.head, 0, 0, 0);
  const hands = (r: Rig) => [0, 1].map((i) => worldPoint(r.forearm[i as 0 | 1], 0, -FOREARM_LENGTH, 0));
  const standingHead = (HIP_HEIGHT + HEAD_HEIGHT) * MODEL_SCALE;

  it.each(Object.keys(CONTACT_WINDOW) as ContactKind[])("blends %s in from, and back out to, the ordinary pose", (kind) => {
    const [before, after] = CONTACT_WINDOW[kind];
    for (const extra of [{}, { side: 1.2, height: 0.4, reach: 1.6 }, { side: -0.2, height: 2.2 }]) {
      expect(poseFor({ ...still, action: act(kind, -before, extra) }, 0, 0, 1)).toEqual(poseFor(still, 0, 0, 1));
      expect(poseFor({ ...still, action: act(kind, after, extra) }, 0, 0, 1)).toEqual(poseFor(still, 0, 0, 1));
    }
  });

  it.each([1, -1])("dives a goalkeeper towards a low ball on side %s and lays them down beside their feet", (side) => {
    const r = solve(act("save", 220, { side: side * 1.2, height: 0.3 }));
    const h = head(r);
    // Model right is +z when facing +x.
    expect(h.z * side).toBeGreaterThan(1.5);
    expect(h.y).toBeLessThan(0.9);
    // The dive pivots on the feet, which stay at the player's recorded position.
    for (const leg of [0, 1] as const) expect(Math.abs(worldPoint(r.foot[leg], 0, -ANKLE_HEIGHT, 0).z)).toBeLessThan(0.8);
    // Up again once the animation ends.
    expect(head(solve(act("save", CONTACT_WINDOW.save[1], { side: side * 1.2, height: 0.3 }))).y).toBeCloseTo(standingHead, 1);
  });

  it("catches a high ball overhead without diving", () => {
    const r = solve(act("save", 0, { side: 0.2, height: 2.2 }));
    for (const hand of hands(r)) expect(hand.y).toBeGreaterThan(head(r).y);
    expect(Math.abs(head(r).z)).toBeLessThan(0.5);
  });

  it("puts a fouled player face down in front of where they stood, then back up", () => {
    const down = head(solve(act("fall", 800)));
    expect(down.x).toBeGreaterThan(1.5);
    expect(down.y).toBeLessThan(0.8);
    expect(head(solve(act("fall", CONTACT_WINDOW.fall[1]))).y).toBeCloseTo(standingHead, 1);
  });

  it("slides into a tackle from range, feet first along the ground, but tackles standing up close", () => {
    const slide = solve(act("tackle", 0, { reach: 1.6 }), 1);
    expect(worldPoint(slide.pelvis, 0, 0, 0).y).toBeLessThan(HIP_HEIGHT * MODEL_SCALE * 0.6);
    const boot = toe(slide, 1);
    expect(boot.x).toBeGreaterThan(1);
    expect(boot.y).toBeLessThan(0.5);
    const standing = solve(act("tackle", 0, { reach: 0.8 }), 1);
    expect(worldPoint(standing.pelvis, 0, 0, 0).y).toBeGreaterThan(HIP_HEIGHT * MODEL_SCALE * 0.85);
    expect(toe(standing, 1).x).toBeGreaterThan(0.3);
  });

  it("holds a throw-in behind the head, then releases it over the head going forwards", () => {
    const hold = solve(act("throw", -600, { lead: 1200, height: 2.2 }));
    for (const hand of hands(hold)) {
      expect(hand.y).toBeGreaterThan(head(hold).y);
      expect(hand.x).toBeLessThan(head(hold).x + 0.1);
    }
    const release = solve(act("throw", 0, { lead: 1200, height: 2.2 }));
    for (const hand of hands(release)) {
      expect(hand.y).toBeGreaterThan(head(release).y);
      expect(hand.x).toBeGreaterThan(head(release).x);
    }
  });

  it("cushions a low ball with the foot and takes a high one on the chest", () => {
    const low = solve(act("receive", 0, { height: 0.11 }), 1);
    expect(toe(low, 1).x).toBeGreaterThan(toe(low, 0).x + 0.2);
    const chest = poseFor({ ...still, action: act("receive", 0, { height: 1.2 }) }, 0, 0, 1);
    expect(chest.lean).toBeLessThan(0);
  });
});
