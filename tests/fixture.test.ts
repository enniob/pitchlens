import { describe, expect, it } from "vitest";
import { GOAL_HEIGHT, GOAL_WIDTH, PITCH_LENGTH, PITCH_WIDTH } from "@/match/contract";
import { buildSampleFixture, sampleFixture } from "@/match/fixture";
import { validateFixture } from "@/match/validate";
import { positionsAt } from "@/playback/derive";

const f = sampleFixture;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("sample fixture", () => {
  it("passes contract validation", () => {
    expect(validateFixture(f)).toEqual([]);
  });

  it("has unique event and player IDs", () => {
    expect(new Set(f.events.map((e) => e.id)).size).toBe(f.events.length);
    expect(new Set(f.roster.map((p) => p.id)).size).toBe(22);
  });

  it("references only rostered players and known teams", () => {
    const players = new Set(f.roster.map((p) => p.id));
    const teams = new Set(f.teams.map((t) => t.id));
    for (const e of f.events) {
      expect(teams.has(e.teamId)).toBe(true);
      if (e.playerId) expect(players.has(e.playerId)).toBe(true);
      if (e.recipientId) expect(players.has(e.recipientId)).toBe(true);
    }
    for (const s of f.snapshots) {
      expect(s.players).toHaveLength(22);
      for (const p of s.players) expect(players.has(p.playerId)).toBe(true);
    }
  });

  it("has ordered timestamps", () => {
    for (let i = 1; i < f.snapshots.length; i++) expect(f.snapshots[i]!.t).toBeGreaterThan(f.snapshots[i - 1]!.t);
    for (let i = 1; i < f.events.length; i++) expect(f.events[i]!.t).toBeGreaterThanOrEqual(f.events[i - 1]!.t);
  });

  it("scripts turnover → three completed passes → shot → goal → kickoff", () => {
    expect(f.events.map((e) => e.type)).toEqual([
      "turnover",
      "pass",
      "pass",
      "pass",
      "shot",
      "goal",
      "kickoff",
      "pass",
    ]);
    const home = f.teams.find((t) => t.side === "home")!.id;
    const attack = f.events.slice(0, 6);
    expect(attack.every((e) => e.teamId === home)).toBe(true);
    expect(attack.filter((e) => e.type === "pass").every((e) => e.outcome === "complete" && e.recipientId)).toBe(true);
  });

  it("is deterministic", () => {
    expect(buildSampleFixture()).toEqual(f);
  });

  it("is labelled synthetic", () => {
    expect(f.synthetic).toBe(true);
  });

  describe("ball/event synchronisation", () => {
    it("puts the ball at the passer's feet on the kick and the recipient's on reception", () => {
      for (const e of f.events.filter((ev) => ev.type === "pass")) {
        const atKick = positionsAt(f, e.startT!);
        const atRecv = positionsAt(f, e.t);
        const passer = atKick.players.find((p) => p.playerId === e.playerId)!;
        const recipient = atRecv.players.find((p) => p.playerId === e.recipientId)!;
        expect(dist(atKick.ball, passer)).toBeLessThan(1);
        expect(dist(atRecv.ball, recipient)).toBeLessThan(1);
        expect(dist(atKick.ball, e.start!)).toBeLessThan(0.05);
        expect(dist(atRecv.ball, e.end!)).toBeLessThan(0.05);
        expect(atRecv.possession?.playerId).toBe(e.recipientId);
      }
    });

    it("has the ball in the goal mouth exactly when the goal is revealed", () => {
      const goal = f.events.find((e) => e.type === "goal")!;
      const before = positionsAt(f, goal.t - 100).ball;
      const at = positionsAt(f, goal.t).ball;
      expect(before.x).toBeLessThan(PITCH_LENGTH);
      expect(at.x).toBeGreaterThanOrEqual(PITCH_LENGTH);
      expect(Math.abs(at.y - PITCH_WIDTH / 2)).toBeLessThan(GOAL_WIDTH / 2);
      expect(at.z).toBeLessThan(GOAL_HEIGHT);
    });

    it("resets to the centre spot at kickoff without sliding across the pitch", () => {
      const kickoff = f.events.find((e) => e.type === "kickoff")!;
      const reset = f.snapshots.find((s) => s.t === kickoff.t)!;
      expect(reset.discontinuity).toBe(true);
      // Just before the reset the ball is still in the net, not part-way to the centre.
      const justBefore = positionsAt(f, kickoff.t - 1).ball;
      expect(justBefore.x).toBeGreaterThan(PITCH_LENGTH);
      const at = positionsAt(f, kickoff.t).ball;
      expect(dist(at, { x: PITCH_LENGTH / 2, y: PITCH_WIDTH / 2 })).toBeLessThan(0.1);
    });

    it("has every player in their own half at kickoff", () => {
      const kickoff = f.events.find((e) => e.type === "kickoff")!;
      const { players } = positionsAt(f, kickoff.t);
      for (const p of players) {
        const team = f.teams.find((t) => t.id === f.roster.find((r) => r.id === p.playerId)!.teamId)!;
        if (team.attacksTowards === "increasing-x") expect(p.x).toBeLessThanOrEqual(PITCH_LENGTH / 2);
        else expect(p.x).toBeGreaterThanOrEqual(PITCH_LENGTH / 2);
      }
    });

    it("keeps player movement physically plausible", () => {
      // No player moves faster than ~10 m/s between consecutive snapshots of a continuous segment.
      for (let i = 1; i < f.snapshots.length; i++) {
        const a = f.snapshots[i - 1]!;
        const b = f.snapshots[i]!;
        if (b.discontinuity) continue;
        const dt = (b.t - a.t) / 1000;
        for (const pb of b.players) {
          const pa = a.players.find((p) => p.playerId === pb.playerId)!;
          expect(dist(pa, pb) / dt, `${pb.playerId} at t=${b.t}`).toBeLessThan(10);
        }
      }
    });
  });
});
