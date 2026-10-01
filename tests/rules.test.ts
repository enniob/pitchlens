import { describe, expect, it } from "vitest";
import {
  GOAL_HEIGHT,
  GOAL_WIDTH,
  PENALTY_AREA_DEPTH,
  PENALTY_AREA_HALF_WIDTH,
  PENALTY_SPOT_DISTANCE,
  PITCH_LENGTH,
  PITCH_WIDTH,
  POST_RADIUS,
  type MatchEvent,
  type MatchFixture,
  type Snapshot,
} from "@/match/contract";
import { statisticsAt } from "@/playback/statistics";
import { BALL_RADIUS } from "@/simulation/ball";
import { generateMatch, PLAYER_GAP, RESTART_DISTANCE, type TacticsConfig } from "@/simulation/generate";

const SEEDS = Array.from({ length: 24 }, (_, i) => i);
/** The same rules must hold whatever formation each team plays, and across a mid-match change. */
const TACTICS: TacticsConfig[] = [
  { home: { formation: "4-4-2" }, away: { formation: "4-2-3-1" } },
  { home: { formation: "4-2-3-1", changes: [{ t: 45_000, formation: "4-3-3" }] }, away: { formation: "4-4-2" } },
  { home: { formation: "4-3-3" }, away: { formation: "4-4-2", changes: [{ t: 30_000, formation: "4-2-3-1" }, { t: 90_000, formation: "4-3-3" }] } },
];
const matches = [
  ...SEEDS.map((seed) => generateMatch({ seed, durationMs: 120_000 })),
  ...Array.from({ length: 12 }, (_, i) => generateMatch({ seed: 24 + i, durationMs: 120_000, tactics: TACTICS[i % TACTICS.length] })),
];
const all = <T>(pick: (f: MatchFixture) => T[]) => matches.flatMap((f) => pick(f).map((x) => [f, x] as const));

const snapshotAt = (f: MatchFixture, t: number) => f.snapshots.find((s) => s.t === t)!;
const before = (f: MatchFixture, t: number) => f.snapshots[f.snapshots.findIndex((s) => s.t === t) - 1]!;
const playerIn = (s: Snapshot, id: string) => s.players.find((p) => p.playerId === id)!;
const gap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const teamOf = (f: MatchFixture, playerId: string) => f.roster.find((p) => p.id === playerId)!.teamId;
const attacksUp = (f: MatchFixture, teamId: string) => f.teams.find((t) => t.id === teamId)!.attacksTowards === "increasing-x";
/** The next restart after time t. */
const RESTARTS = ["kickoff", "goal-kick", "throw-in", "corner", "free-kick", "penalty"];
const restartAfter = (f: MatchFixture, t: number) => f.events.find((e) => e.t > t && RESTARTS.includes(e.type));
const inArea = (f: MatchFixture, p: { x: number; y: number }, defendingTeamId: string) => {
  const goalX = attacksUp(f, defendingTeamId) ? 0 : PITCH_LENGTH;
  return Math.abs(p.x - goalX) <= PENALTY_AREA_DEPTH && Math.abs(p.y - PITCH_WIDTH / 2) <= PENALTY_AREA_HALF_WIDTH;
};
/** Players of `attackingTeamId` in an offside position in snapshot `s`. */
const offsidePositions = (f: MatchFixture, s: Snapshot, attackingTeamId: string, kickerId: string) => {
  const sign = attacksUp(f, attackingTeamId) ? 1 : -1;
  const depths = s.players.filter((p) => teamOf(f, p.playerId) !== attackingTeamId).map((p) => p.x * sign).sort((a, b) => b - a);
  const line = depths[1]!;
  return s.players
    .filter((p) => teamOf(f, p.playerId) === attackingTeamId && p.playerId !== kickerId)
    .filter((p) => (p.x - PITCH_LENGTH / 2) * sign > 0 && p.x * sign > s.ball.x * sign && p.x * sign > line)
    .map((p) => p.playerId);
};

describe("coverage", () => {
  it("produces every new event across the sampled seeds", () => {
    const seen = new Set(matches.flatMap((f) => f.events.map((e) => `${e.type}:${e.outcome}`)));
    for (const key of [
      "throw-in:taken",
      "corner:taken",
      "free-kick:taken",
      "penalty:taken",
      "foul:committed",
      "offside:flagged",
      "deflection:deflected",
      "shot-result:blocked",
      "shot-result:saved",
      "goal-kick:taken",
    ])
      expect(seen.has(key), key).toBe(true);
    const deflections = matches.flatMap((f) => f.events.filter((e) => e.type === "deflection").map((e) => e.description));
    for (const kind of [/^Blocked by/, /^Parried by/, /hits the post$/, /hits the crossbar$/, /^Deflected off/])
      expect(deflections.some((d) => kind.test(d)), String(kind)).toBe(true);
  });
});

describe("player collisions", () => {
  it("never lets two players pass through each other", () => {
    let closest = Infinity;
    for (const f of matches)
      for (const s of f.snapshots)
        for (let i = 0; i < s.players.length; i++)
          for (let j = i + 1; j < s.players.length; j++) closest = Math.min(closest, gap(s.players[i]!, s.players[j]!));
    // Pushes are limited by top speed, so a pair can briefly sit inside PLAYER_GAP, but never on top of each other.
    expect(closest).toBeGreaterThan(PLAYER_GAP * 0.7);
  });
});

describe("fouls", () => {
  const fouls = all((f) => f.events.filter((e) => e.type === "foul"));

  it("happen only in a challenge on the player with the ball, and stop play there", () => {
    expect(fouls.length).toBeGreaterThan(5);
    for (const [f, foul] of fouls) {
      const victim = before(f, foul.t).possession!.playerId!;
      expect(teamOf(f, victim)).not.toBe(foul.teamId);
      const s = snapshotAt(f, foul.t);
      expect(s.possession).toBeNull();
      expect(s.ball).toEqual(foul.start);
      expect(gap(playerIn(s, foul.playerId!), s.ball)).toBeLessThan(2);
      // Dead ball until the restart, two seconds later, with nothing else happening.
      const restart = restartAfter(f, foul.t);
      if (!restart) continue;
      expect(restart.t - foul.t).toBe(2000);
      // A scheduled formation change may fall in the stoppage; it does not restart play.
      expect(f.events.filter((e) => e.t > foul.t && e.t < restart.t && e.type !== "formation-change")).toEqual([]);
      for (const x of f.snapshots.filter((x) => x.t > foul.t && x.t < restart.t)) expect(x.ball).toEqual(s.ball);
    }
  });

  it("give a free kick where they happened, or a penalty inside the area, to the fouled team", () => {
    const kinds = new Set<string>();
    for (const [f, foul] of fouls) {
      const restart = restartAfter(f, foul.t);
      if (!restart) continue;
      kinds.add(restart.type);
      expect(restart.teamId).not.toBe(foul.teamId);
      const penalty = inArea(f, foul.start!, foul.teamId);
      expect(restart.type).toBe(penalty ? "penalty" : "free-kick");
      const s = snapshotAt(f, restart.t);
      expect(s.discontinuity).toBe(true);
      expect(s.possession?.playerId).toBe(restart.playerId);
      if (penalty) {
        const goalX = attacksUp(f, restart.teamId) ? PITCH_LENGTH : 0;
        expect(gap(s.ball, { x: goalX + (goalX ? -1 : 1) * PENALTY_SPOT_DISTANCE, y: PITCH_WIDTH / 2 })).toBeLessThan(1e-9);
        // Everyone but the taker and the goalkeeper waits outside the area.
        const keeper = f.roster.find((p) => p.teamId === foul.teamId && p.role === "GK")!.id;
        for (const p of s.players)
          if (p.playerId !== restart.playerId && p.playerId !== keeper) expect(Math.abs(p.x - goalX)).toBeGreaterThan(PENALTY_AREA_DEPTH);
      } else {
        // At the foul, moved in from the lines if need be; the taker is the player who was fouled.
        expect(gap(s.ball, foul.start!)).toBeLessThan(1 + 1e-9);
        expect(restart.playerId).toBe(before(f, foul.t).possession!.playerId);
      }
      // Opponents back the required distance.
      for (const p of s.players)
        if (teamOf(f, p.playerId) === foul.teamId && !penalty) expect(gap(p, s.ball)).toBeGreaterThan(RESTART_DISTANCE - 0.6);
    }
    expect(kinds).toEqual(new Set(["free-kick", "penalty"]));
  });

  it("lets the penalty taker shoot from the spot", () => {
    const penalties = all((f) => f.events.filter((e) => e.type === "penalty"));
    expect(penalties.length).toBeGreaterThan(0);
    for (const [f, pen] of penalties) {
      const next = f.events.find((e) => e.t > pen.t && e.type !== "deflection" && e.type !== "formation-change");
      if (!next) continue;
      expect(next.type).toBe("shot");
      expect(next.playerId).toBe(pen.playerId);
    }
  });

  it("put up a three-player wall for a direct free kick near goal", () => {
    let walls = 0;
    for (const [f, fk] of all((x) => x.events.filter((e) => e.type === "free-kick" && e.description.startsWith("Free kick")))) {
      const s = snapshotAt(f, fk.t);
      const goal = { x: attacksUp(f, fk.teamId) ? PITCH_LENGTH : 0, y: PITCH_WIDTH / 2 };
      if (gap(s.ball, goal) > 30) continue;
      walls++;
      const d = gap(s.ball, goal);
      const wall = s.players.filter((p) => {
        if (teamOf(f, p.playerId) === fk.teamId) return false;
        // On the line to goal, at the restart distance.
        const along = ((p.x - s.ball.x) * (goal.x - s.ball.x) + (p.y - s.ball.y) * (goal.y - s.ball.y)) / d;
        return Math.abs(along - RESTART_DISTANCE) < 0.3 && Math.abs(gap(p, s.ball) - along) < 0.2;
      });
      expect(wall.length).toBeGreaterThanOrEqual(3);
    }
    expect(walls).toBeGreaterThan(0);
  });
});

describe("offside", () => {
  const flags = all((f) => f.events.filter((e) => e.type === "offside"));
  /** The restart a kick at time t came from, if it was the first kick after it. */
  const firstKickAfterRestart = (f: MatchFixture, t: number) => {
    const restart = f.events.filter((e) => RESTARTS.includes(e.type) && e.t <= t).at(-1);
    if (!restart) return null;
    const kicks = f.events.filter((e) => e.t > restart.t && (e.type === "shot" || e.type === "pass" || e.type === "offside"));
    const first = kicks.map((e) => (e.type === "shot" ? e.t : e.startT!)).sort((a, b) => a - b)[0];
    return first === t ? restart.type : null;
  };

  it("is flagged when a player in an offside position at the pass plays the ball", () => {
    expect(flags.length).toBeGreaterThan(2);
    for (const [f, flag] of flags) {
      const strike = snapshotAt(f, flag.startT!);
      const kicker = before(f, flag.startT!).possession!.playerId!;
      expect(teamOf(f, kicker)).toBe(flag.teamId);
      expect(offsidePositions(f, strike, flag.teamId, kicker)).toContain(flag.playerId);
      // ...where they reached the ball.
      const s = snapshotAt(f, flag.t);
      expect(s.possession).toBeNull();
      expect(gap(playerIn(s, flag.playerId!), flag.end!)).toBeLessThan(1.5);
      // Never from a throw-in, corner or goal kick.
      expect(["throw-in", "corner", "goal-kick"]).not.toContain(firstKickAfterRestart(f, flag.startT!));
    }
  });

  it("gives the defending team an indirect free kick, which is not shot at goal", () => {
    let checked = 0;
    for (const [f, flag] of flags) {
      const restart = restartAfter(f, flag.t);
      if (!restart) continue;
      expect(restart.type).toBe("free-kick");
      expect(restart.description).toMatch(/^Indirect/);
      expect(restart.teamId).not.toBe(flag.teamId);
      expect(gap(snapshotAt(f, restart.t).ball, flag.end!)).toBeLessThan(1 + 1e-9);
      // The first strike after the restart is the taker's, and it is a pass.
      const strikeT = (e: MatchEvent) => (e.type === "shot" ? e.t : e.startT!);
      const first = f.events
        .filter((e) => (e.type === "shot" || e.type === "pass" || e.type === "offside") && strikeT(e) > restart.t)
        .sort((a, b) => strikeT(a) - strikeT(b))[0];
      if (!first) continue;
      checked++;
      expect(first.playerId).toBe(restart.playerId);
      expect(first.type).not.toBe("shot");
    }
    expect(checked).toBeGreaterThan(2);
  });

  it("is never missed: a pass is only completed to a player who was onside when it was played", () => {
    for (const [f, pass] of all((x) => x.events.filter((e) => e.type === "pass" && e.outcome === "complete"))) {
      const restart = firstKickAfterRestart(f, pass.startT!);
      if (restart && ["throw-in", "corner", "goal-kick"].includes(restart)) continue;
      const strike = snapshotAt(f, pass.startT!);
      expect(offsidePositions(f, strike, pass.teamId, pass.playerId!)).not.toContain(pass.recipientId);
    }
  });
});

describe("woodwork", () => {
  it("bounces the ball off a post or the crossbar where it touches the frame", () => {
    const hits = all((f) => f.events.filter((e) => e.type === "deflection" && /hits the (post|crossbar)$/.test(e.description)));
    expect(hits.length).toBeGreaterThan(2);
    const touch = POST_RADIUS + BALL_RADIUS;
    for (const [f, hit] of hits) {
      const b = hit.start!;
      const line = b.x < PITCH_LENGTH / 2 ? 0 : PITCH_LENGTH;
      if (hit.description.endsWith("post")) {
        const post = { x: line, y: PITCH_WIDTH / 2 + Math.sign(b.y - PITCH_WIDTH / 2) * (GOAL_WIDTH / 2) };
        expect(gap(b, post)).toBeCloseTo(touch, 6);
        expect(b.z).toBeLessThanOrEqual(GOAL_HEIGHT);
      } else {
        expect(Math.hypot(b.x - line, b.z - GOAL_HEIGHT)).toBeCloseTo(touch, 6);
        expect(Math.abs(b.y - PITCH_WIDTH / 2)).toBeLessThanOrEqual(GOAL_WIDTH / 2);
      }
      // Coming off the frame, away from it.
      const s = snapshotAt(f, hit.t);
      const i = f.snapshots.indexOf(s);
      const [a, c] = [f.snapshots[i - 1]!, f.snapshots[i + 1]];
      if (!c || c.discontinuity) continue;
      const inbound = { x: s.ball.x - a.ball.x, y: s.ball.y - a.ball.y, z: s.ball.z - a.ball.z };
      const outbound = { x: c.ball.x - s.ball.x, y: c.ball.y - s.ball.y, z: c.ball.z - s.ball.z };
      expect(inbound.x * outbound.x + inbound.y * outbound.y + inbound.z * outbound.z).toBeLessThan(
        Math.hypot(inbound.x, inbound.y, inbound.z) * Math.hypot(outbound.x, outbound.y, outbound.z),
      );
    }
  });
});

describe("statistics with the new rules", () => {
  it("counts one result per shot, so goals and saves never outnumber shots", () => {
    for (const f of matches) {
      const stats = statisticsAt(f, f.durationMs);
      for (const team of f.teams) {
        const own = f.events.filter((e: MatchEvent) => e.teamId === team.id);
        const s = stats[team.side];
        const other = stats[team.side === "home" ? "away" : "home"];
        const ownGoals = f.events.filter((e) => e.type === "goal" && e.teamId === team.id && !e.playerId).length;
        expect(s.goals - ownGoals + other.saves + own.filter((e) => e.outcome === "blocked").length).toBeLessThanOrEqual(s.shots);
        expect(s.fouls).toBe(own.filter((e) => e.type === "foul").length);
        expect(s.corners).toBe(own.filter((e) => e.type === "corner").length);
        expect(s.offsides).toBe(own.filter((e) => e.type === "offside").length);
      }
    }
  });
});
