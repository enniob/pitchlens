import { describe, expect, it } from "vitest";
import {
  GOAL_HEIGHT,
  GOAL_WIDTH,
  PITCH_LENGTH,
  PITCH_WIDTH,
  type MatchEvent,
  type MatchFixture,
  type Snapshot,
} from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import { validateFixture } from "@/match/validate";
import { kickContacts, motionAt } from "@/playback/animation";
import { frameAt } from "@/playback/derive";
import { PlaybackEngine, SPEEDS } from "@/playback/engine";
import { statisticsAt } from "@/playback/statistics";
import { BALL_RADIUS, GRAVITY, ROLL_DECELERATION } from "@/simulation/ball";
import {
  CONTROL_HEIGHT,
  CONTROL_REACH,
  DRIBBLE_OFFSET,
  generateMatch,
  INTERCEPT_REACH,
  KEEPER_HEIGHT,
  KEEPER_REACH,
  NET_DEPTH,
  RUN_OFF,
  SNAPSHOT_INTERVAL_MS,
  STEP_MS,
  TACKLE_RANGE,
} from "@/simulation/generate";

const SEEDS = [0, 1, 2, 3, 7, 42, 100, 999];
const fixtures = SEEDS.map((seed) => [seed, generateMatch({ seed, durationMs: 120_000 })] as const);

const snapshotAt = (f: MatchFixture, t: number) => f.snapshots.find((s) => s.t === t)!;
const before = (f: MatchFixture, t: number) => f.snapshots[f.snapshots.findIndex((s) => s.t === t) - 1]!;
const playerIn = (s: Snapshot, id: string) => s.players.find((p) => p.playerId === id)!;
const gap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const inGoalMouth = (b: { y: number; z: number }) => Math.abs(b.y - PITCH_WIDTH / 2) < GOAL_WIDTH / 2 && b.z < GOAL_HEIGHT;
const overEndLine = (b: { x: number }) => b.x > PITCH_LENGTH + BALL_RADIUS - 1e-9 || b.x < -BALL_RADIUS + 1e-9;

describe("deterministic replay", () => {
  it("regenerates byte-identical fixtures from the same seed", () => {
    for (const seed of [5, 42]) {
      const a = JSON.stringify(generateMatch({ seed, durationMs: 60_000 }));
      expect(JSON.stringify(generateMatch({ seed, durationMs: 60_000 }))).toBe(a);
    }
    expect(JSON.stringify(generateMatch({ seed: 6 }).snapshots)).not.toBe(JSON.stringify(generateMatch({ seed: 5 }).snapshots));
  });

  it("is a prefix-stable simulation: a longer run starts with the shorter one", () => {
    const short = generateMatch({ seed: 11, durationMs: 30_000 });
    const long = generateMatch({ seed: 11, durationMs: 60_000 });
    expect(long.snapshots.slice(0, short.snapshots.length)).toEqual(short.snapshots);
    expect(long.events.filter((e) => e.t <= 30_000)).toEqual(short.events);
  });

  it("shows the same frame and poses at a time however playback got there", () => {
    const f = fixtures[5]![1];
    const target = 37_460;
    const expected = { frame: frameAt(f, target), motion: motionAt(f, target) };
    for (const speed of SPEEDS) {
      for (const frameMs of [7, 16.7, 250]) {
        const engine = new PlaybackEngine(f);
        engine.setSpeed(speed);
        engine.play();
        while (engine.status.timeMs + frameMs * speed < target) engine.advance(frameMs);
        engine.advance((target - engine.status.timeMs) / speed);
        expect(engine.status.timeMs).toBeCloseTo(target, 6);
        engine.seek(target);
        expect(engine.frame()).toEqual(expected.frame);
        expect(motionAt(f, engine.status.timeMs)).toEqual(expected.motion);
      }
    }
    const seeker = new PlaybackEngine(f);
    seeker.seek(f.durationMs);
    seeker.restart();
    seeker.seek(90_000);
    seeker.seek(target);
    expect(seeker.frame()).toEqual(expected.frame);
    expect(motionAt(f, seeker.status.timeMs)).toEqual(expected.motion);
  });
});

describe.each(fixtures)("ball physics in generated match, seed %s", (_seed, f) => {
  it("is a valid schema 1.1.0 fixture on a fixed timestep", () => {
    expect(validateFixture(f)).toEqual([]);
    expect(f.schemaVersion).toBe("1.1.0");
    const times = new Set(f.snapshots.map((s) => s.t));
    for (const s of f.snapshots) expect(s.t % STEP_MS).toBe(0);
    for (let t = 0; t <= f.durationMs; t += SNAPSHOT_INTERVAL_MS) expect(times.has(t)).toBe(true);
    for (const e of f.events) expect(times.has(e.t)).toBe(true);
  });

  it("keeps the ball and players inside the pitch boundaries", () => {
    let dead = false;
    for (const [i, s] of f.snapshots.entries()) {
      for (const p of s.players) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(PITCH_LENGTH);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(PITCH_WIDTH);
      }
      const b = s.ball;
      expect(b.z).toBeGreaterThanOrEqual(BALL_RADIUS - 1e-9);
      // Even a dead ball is stopped by the net or the run-off.
      expect(b.x).toBeGreaterThanOrEqual(-RUN_OFF - 1e-9);
      expect(b.x).toBeLessThanOrEqual(PITCH_LENGTH + RUN_OFF + 1e-9);
      expect(b.y).toBeGreaterThanOrEqual(-RUN_OFF - 1e-9);
      expect(b.y).toBeLessThanOrEqual(PITCH_WIDTH + RUN_OFF + 1e-9);
      // While play is live the whole ball has not crossed any line.
      if (s.discontinuity) dead = false;
      const inPlay =
        b.x >= -BALL_RADIUS && b.x <= PITCH_LENGTH + BALL_RADIUS && b.y >= -BALL_RADIUS && b.y <= PITCH_WIDTH + BALL_RADIUS;
      if (!inPlay && !dead) {
        // The first snapshot out of play is exactly the one carrying the goal or miss.
        expect(f.events.some((e) => e.t === s.t && ["scored", "missed"].includes(e.outcome))).toBe(true);
        expect(i).toBeGreaterThan(0);
        dead = true;
      }
      if (dead) expect(s.possession).toBeNull();
    }
  });

  it("holds the ball in the net after a goal until the kickoff cut", () => {
    for (const goal of f.events.filter((e) => e.type === "goal")) {
      const kickoff = f.events.find((e) => e.t > goal.t && e.type === "kickoff");
      const end = kickoff?.t ?? f.durationMs + 1;
      for (const s of f.snapshots.filter((x) => x.t >= goal.t && x.t < end)) {
        expect(overEndLine(s.ball)).toBe(true);
        expect(Math.min(s.ball.x, PITCH_LENGTH - s.ball.x)).toBeGreaterThanOrEqual(-NET_DEPTH);
        expect(inGoalMouth(s.ball)).toBe(true);
      }
      if (kickoff) {
        const s = snapshotAt(f, kickoff.t);
        expect(s.discontinuity).toBe(true);
        expect(gap(s.ball, { x: PITCH_LENGTH / 2, y: PITCH_WIDTH / 2 })).toBeLessThan(1e-9);
      }
    }
  });

  it("moves a passed ball by gravity in the air and friction on the ground", () => {
    let airborne = 0;
    let rolling = 0;
    for (const pass of f.events.filter((e) => e.type === "pass" && e.outcome === "complete")) {
      // Free flight only: from the strike up to, not including, the controlling touch.
      const path = f.snapshots.filter((s) => s.t >= pass.startT! && s.t < pass.t);
      for (let i = 2; i < path.length; i++) {
        const [a, b, c] = [path[i - 2]!, path[i - 1]!, path[i]!];
        const [dt1, dt2] = [(b.t - a.t) / 1000, (c.t - b.t) / 1000];
        const v1 = gap(a.ball, b.ball) / dt1;
        const v2 = gap(b.ball, c.ball) / dt2;
        const high = [a, b, c].every((s) => s.ball.z > BALL_RADIUS + 0.3);
        const low = [a, b, c].every((s) => s.ball.z === BALL_RADIUS);
        if (high) {
          airborne++;
          expect(v2).toBeCloseTo(v1, 6);
          const climb1 = (b.ball.z - a.ball.z) / dt1;
          const climb2 = (c.ball.z - b.ball.z) / dt2;
          expect(climb2 - climb1).toBeCloseTo((-GRAVITY * (dt1 + dt2)) / 2, 6);
        } else if (low && v2 > 0) {
          rolling++;
          expect(v2 - v1).toBeCloseTo((-ROLL_DECELERATION * (dt1 + dt2)) / 2, 6);
        }
      }
    }
    expect(rolling).toBeGreaterThan(0);
    expect(airborne + rolling).toBeGreaterThan(20);
  });

  it("never teleports the ball outside a dead-ball cut", () => {
    for (let i = 1; i < f.snapshots.length; i++) {
      const [a, b] = [f.snapshots[i - 1]!, f.snapshots[i]!];
      if (b.discontinuity) continue;
      const speed = Math.hypot(b.ball.x - a.ball.x, b.ball.y - a.ball.y, b.ball.z - a.ball.z) / ((b.t - a.t) / 1000);
      expect(speed).toBeLessThan(40);
      // A ball in someone's possession is never further away than the longest reach that can win it.
      if (b.possession?.playerId) expect(gap(playerIn(b, b.possession.playerId), b.ball)).toBeLessThan(TACKLE_RANGE + 0.2);
    }
  });
});

describe.each(fixtures)("event/contact alignment, seed %s", (_seed, f) => {
  const keeperOfOpponents = (teamId: string) => f.roster.find((p) => p.teamId !== teamId && p.role === "GK")!.id;
  const atFoot = (s: Snapshot, playerId: string) => {
    const p = playerIn(s, playerId);
    return { x: p.x + Math.cos(p.facing) * DRIBBLE_OFFSET, y: p.y + Math.sin(p.facing) * DRIBBLE_OFFSET };
  };
  const strikes = (e: MatchEvent) => (e.type === "pass" ? e.startT! : e.t);

  it("starts every pass and shot at the kicker's foot", () => {
    const kicks = f.events.filter((e) => e.type === "pass" || e.type === "shot");
    expect(kicks.length).toBeGreaterThan(5);
    for (const e of kicks) {
      const t = strikes(e);
      const s = snapshotAt(f, t);
      expect(s.ball).toEqual(e.start);
      expect(s.ball.z).toBe(BALL_RADIUS);
      expect(gap(s.ball, atFoot(s, e.playerId!))).toBeLessThan(1e-9);
      // The kicker held the ball right up to the strike and released it there.
      expect(before(f, t).possession?.playerId).toBe(e.playerId);
      expect(s.possession).toBeNull();
      // The ball is moving away from the foot afterwards.
      const next = f.snapshots[f.snapshots.indexOf(s) + 1];
      if (next && !next.discontinuity) expect(gap(next.ball, s.ball)).toBeGreaterThan(0.1);
    }
  });

  it("recognises the same strikes from snapshots alone, for the kick animation", () => {
    const contacts = kickContacts(f);
    const key = (t: number, id: string) => `${t}:${id}`;
    const recognised = new Set(contacts.map((c) => key(c.t, c.playerId)));
    for (const e of f.events.filter((x) => x.type === "pass" || x.type === "shot"))
      expect(recognised.has(key(strikes(e), e.playerId!))).toBe(true);
    for (const c of contacts) expect(gap(snapshotAt(f, c.t).ball, atFoot(snapshotAt(f, c.t), c.playerId))).toBeLessThan(1e-9);
    // Derived from snapshots only: stripping the events changes nothing.
    expect(kickContacts({ ...f, events: [] })).toEqual(contacts);
  });

  it("completes a pass only when the ball reaches the receiver", () => {
    for (const e of f.events.filter((x) => x.type === "pass" && x.outcome === "complete")) {
      const s = snapshotAt(f, e.t);
      expect(s.possession).toEqual({ teamId: e.teamId, playerId: e.recipientId });
      expect(s.ball).toEqual(e.end);
      expect(s.ball.z).toBeLessThanOrEqual(CONTROL_HEIGHT);
      expect(before(f, e.t).possession).toBeNull();
      // The ball stops on its own path within the receiver's reach (their position is interpolated within the step).
      expect(gap(playerIn(s, e.recipientId!), s.ball)).toBeLessThanOrEqual(CONTROL_REACH + 1e-9);
      expect(e.t).toBeGreaterThan(e.startT!);
    }
  });

  it("changes possession on an interception where the interceptor meets the ball", () => {
    for (const e of f.events.filter((x) => x.type === "pass" && x.outcome === "intercepted")) {
      const turnover = f.events.find((x) => x.type === "turnover" && x.t === e.t)!;
      expect(turnover).toBeDefined();
      expect(turnover.teamId).not.toBe(e.teamId);
      const s = snapshotAt(f, e.t);
      expect(s.possession?.playerId).toBe(turnover.playerId);
      expect(gap(playerIn(s, turnover.playerId!), s.ball)).toBeLessThanOrEqual(Math.max(INTERCEPT_REACH, CONTROL_REACH) + 1e-9);
    }
  });

  it("changes possession on a tackle only when the tackler is at the ball", () => {
    for (const e of f.events.filter((x) => x.type === "turnover" && x.description.includes("wins the ball"))) {
      const s = snapshotAt(f, e.t);
      expect(s.possession?.playerId).toBe(e.playerId);
      expect(before(f, e.t).possession?.teamId).not.toBe(e.teamId);
      // Within tackling range of the ball (the tackler has moved at most one step since the check).
      expect(gap(playerIn(s, e.playerId!), s.ball)).toBeLessThan(TACKLE_RANGE + 0.2);
      // The ball stays where it was and is then drawn in to the new owner's foot.
      expect(s.ball).toEqual(e.start);
    }
  });

  it("resolves every shot from where the ball actually went", () => {
    for (const shot of f.events.filter((e) => e.type === "shot")) {
      const result = f.events.find((e) => e.startT === shot.t && (e.type === "goal" || e.type === "shot-result"));
      if (!result) {
        // Still in flight when the sequence ended; no outcome is invented.
        expect(f.events.some((e) => e.t > shot.t && e.type !== "shot")).toBe(false);
        continue;
      }
      const s = snapshotAt(f, result.t);
      const end = result.end!;
      expect(result.t).toBeGreaterThan(shot.t);
      // Whole ball over a goal line: the event records the crossing point on that line.
      const onEndLine = Math.abs(end.x - (PITCH_LENGTH + BALL_RADIUS)) < 1e-9 || Math.abs(end.x + BALL_RADIUS) < 1e-9;
      const insideFrame = Math.abs(end.y - PITCH_WIDTH / 2) < GOAL_WIDTH / 2 - BALL_RADIUS && end.z < GOAL_HEIGHT - BALL_RADIUS;
      if (result.outcome === "scored") {
        expect(onEndLine && insideFrame).toBe(true);
        expect(overEndLine(s.ball)).toBe(true);
        expect(inGoalMouth(s.ball)).toBe(true);
        expect(overEndLine(before(f, result.t).ball)).toBe(false);
        expect(s.possession).toBeNull();
        // It went in at the end the shooter attacks.
        const attacksUp = f.teams.find((team) => team.id === shot.teamId)!.attacksTowards === "increasing-x";
        expect(end.x > PITCH_LENGTH / 2).toBe(attacksUp);
      } else if (result.outcome === "saved") {
        const keeper = keeperOfOpponents(shot.teamId);
        expect(s.ball).toEqual(end);
        expect(s.possession?.playerId).toBe(keeper);
        expect(gap(playerIn(s, keeper), s.ball)).toBeLessThanOrEqual(KEEPER_REACH + 1e-9);
        expect(s.ball.z).toBeLessThanOrEqual(KEEPER_HEIGHT);
        expect(overEndLine(s.ball)).toBe(false);
      } else {
        expect(result.outcome).toBe("missed");
        if (s.possession) {
          // Ran out of pace and was picked up.
          expect(s.ball).toEqual(end);
        } else {
          // Left the pitch outside the frame.
          const onTouchline = Math.abs(end.y + BALL_RADIUS) < 1e-9 || Math.abs(end.y - PITCH_WIDTH - BALL_RADIUS) < 1e-9;
          expect(onTouchline || (onEndLine && !insideFrame)).toBe(true);
        }
      }
    }
  });
});

describe("ball out of play", () => {
  const out = fixtures.flatMap(([, f]) =>
    f.events.filter((e) => e.type === "pass" && e.outcome === "missed").map((e) => [f, e] as const),
  );

  it("happens for overhit passes in the sampled seeds", () => {
    expect(out.length).toBeGreaterThan(0);
  });

  it("stops play where the ball crossed the line and restarts with the other team", () => {
    for (const [f, e] of out) {
      const end = e.end!;
      const onLine =
        Math.abs(end.y + BALL_RADIUS) < 1e-9 ||
        Math.abs(end.y - PITCH_WIDTH - BALL_RADIUS) < 1e-9 ||
        Math.abs(end.x + BALL_RADIUS) < 1e-9 ||
        Math.abs(end.x - PITCH_LENGTH - BALL_RADIUS) < 1e-9;
      expect(onLine).toBe(true);
      expect(snapshotAt(f, e.t).possession).toBeNull();
      const restart = f.events.find((x) => x.t > e.t && (x.type === "turnover" || x.type === "goal-kick"));
      if (!restart) continue; // sequence ended during the dead ball
      expect(restart.teamId).not.toBe(e.teamId);
      // Nothing else happens while the ball is dead.
      expect(f.events.filter((x) => x.t > e.t && x.t < restart.t)).toEqual([]);
      const s = snapshotAt(f, restart.t);
      expect(s.discontinuity).toBe(true);
      expect(s.possession?.playerId).toBe(restart.playerId);
      const taker = playerIn(s, restart.playerId!);
      expect(gap(s.ball, taker)).toBeCloseTo(DRIBBLE_OFFSET, 9);
      expect(s.ball.x).toBeGreaterThan(0);
      expect(s.ball.x).toBeLessThan(PITCH_LENGTH);
      expect(s.ball.y).toBeGreaterThan(0);
      expect(s.ball.y).toBeLessThan(PITCH_WIDTH);
    }
  });
});

describe("statistics compatibility", () => {
  it.each(fixtures)("derives consistent totals from the physics-driven events, seed %s", (_seed, f) => {
    const stats = statisticsAt(f, f.durationMs);
    const engine = new PlaybackEngine(f);
    engine.seek(f.durationMs);
    expect({ home: stats.home.goals, away: stats.away.goals }).toEqual(engine.frame().score);
    for (const team of f.teams) {
      const own = f.events.filter((e) => e.teamId === team.id);
      const s = stats[team.side];
      expect(s.shots).toBe(own.filter((e) => e.type === "shot").length);
      expect(s.completedPasses).toBe(own.filter((e) => e.type === "pass" && e.outcome === "complete").length);
      // A team cannot score, or be saved, more often than it shot (own goals aside).
      const ownGoals = f.events.filter((e) => e.type === "goal" && e.teamId === team.id && !e.playerId).length;
      const other = stats[team.side === "home" ? "away" : "home"];
      expect(s.goals - ownGoals + other.saves).toBeLessThanOrEqual(s.shots);
    }
    expect(stats.home.possessionPercent! + stats.away.possessionPercent!).toBe(100);
    expect(stats.home.possessionMs + stats.away.possessionMs).toBeLessThan(f.durationMs);
    expect(stats.home.possessionMs + stats.away.possessionMs).toBeGreaterThan(f.durationMs * 0.2);
  });

  it("never decreases a total as time advances, and reveals nothing early", () => {
    const f = fixtures[4]![1];
    let last = statisticsAt(f, 0);
    for (let t = 0; t <= f.durationMs; t += 500) {
      const now = statisticsAt(f, t);
      for (const side of ["home", "away"] as const)
        for (const key of ["possessionMs", "completedPasses", "shots", "saves", "goals"] as const)
          expect(now[side][key]).toBeGreaterThanOrEqual(last[side][key]);
      expect(frameAt(f, t).events.every((e) => e.t <= t)).toBe(true);
      last = now;
    }
  });
});

describe("scripted demo (schema 1.0.0) is unchanged", () => {
  it("keeps its schema, shape and kick timing", () => {
    expect(sampleFixture.schemaVersion).toBe("1.0.0");
    expect(validateFixture(sampleFixture)).toEqual([]);
    expect(sampleFixture.snapshots).toHaveLength(241);
    expect(sampleFixture.events.map((e) => e.type)).toEqual(["turnover", "pass", "pass", "pass", "shot", "goal", "kickoff", "pass"]);
    // The same snapshot-only rule finds the scripted kicks, so the demo gets the kick animation too.
    expect(kickContacts(sampleFixture)).toEqual([
      { t: 2_900, playerId: "hcf-6" },
      { t: 5_300, playerId: "hcf-8" },
      { t: 7_300, playerId: "hcf-10" },
      { t: 8_800, playerId: "hcf-9" },
      { t: 20_000, playerId: "nvr-9" },
    ]);
  });
});
