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
  BLOCK_REACH,
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
  THROW_HEIGHT,
  THROW_REACH,
} from "@/simulation/generate";

const SEEDS = [0, 1, 2, 3, 7, 42, 100, 999];
const fixtures = SEEDS.map((seed) => [seed, generateMatch({ seed, durationMs: 120_000 })] as const);

const snapshotAt = (f: MatchFixture, t: number) => f.snapshots.find((s) => s.t === t)!;
const before = (f: MatchFixture, t: number) => f.snapshots[f.snapshots.findIndex((s) => s.t === t) - 1]!;
const playerIn = (s: Snapshot, id: string) => s.players.find((p) => p.playerId === id)!;
const gap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const inGoalMouth = (b: { y: number; z: number }) => Math.abs(b.y - PITCH_WIDTH / 2) < GOAL_WIDTH / 2 && b.z < GOAL_HEIGHT;
const overEndLine = (b: { x: number }) => b.x > PITCH_LENGTH + BALL_RADIUS - 1e-9 || b.x < -BALL_RADIUS + 1e-9;
const RESTARTS = ["kickoff", "goal-kick", "throw-in", "corner", "free-kick", "penalty"];
/** Thrown passes leave from the hands; every other pass and shot from the foot. */
const thrown = (e: MatchEvent) => e.type === "pass" && e.start!.z === THROW_HEIGHT;

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
  it("is a valid schema 1.2.0 fixture on a fixed timestep", () => {
    expect(validateFixture(f)).toEqual([]);
    expect(f.schemaVersion).toBe("1.2.0");
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
        // The first snapshot out of play is exactly the one carrying the goal, or the result of the kick that went out.
        expect(f.events.some((e) => e.t === s.t && ["goal", "shot-result", "pass"].includes(e.type))).toBe(true);
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
    // Passes that came off someone or the frame on the way change direction mid-flight; they are covered elsewhere.
    const clean = (e: MatchEvent) => !f.events.some((d) => d.type === "deflection" && d.t > e.startT! && d.t < e.t);
    for (const pass of f.events.filter((e) => e.type === "pass" && e.outcome === "complete" && clean(e))) {
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

  it("starts every pass and shot at the kicker's foot, and every throw-in from the hands", () => {
    for (const e of f.events.filter(thrown)) {
      const s = snapshotAt(f, e.startT!);
      const p = playerIn(s, e.playerId!);
      expect(s.ball).toEqual(e.start);
      expect(gap(s.ball, { x: p.x + Math.cos(p.facing) * THROW_REACH, y: p.y + Math.sin(p.facing) * THROW_REACH })).toBeLessThan(1e-9);
      // The thrower is the one who took the throw-in, standing on the touchline.
      const restart = f.events.filter((x) => RESTARTS.includes(x.type) && x.t <= e.startT!).at(-1)!;
      expect(restart.type).toBe("throw-in");
      expect(restart.playerId).toBe(e.playerId);
      expect([0, PITCH_WIDTH]).toContain(p.y);
    }
    const kicks = f.events.filter((e) => (e.type === "pass" && !thrown(e)) || e.type === "shot");
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
    for (const c of contacts) {
      const s = snapshotAt(f, c.t);
      if (c.kind === "throw") expect(s.ball.z).toBe(THROW_HEIGHT);
      else expect(gap(s.ball, atFoot(s, c.playerId))).toBeLessThan(1e-9);
    }
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

  it("resolves every shot once, from where the ball actually went", () => {
    for (const shot of f.events.filter((e) => e.type === "shot")) {
      const results = f.events.filter((e) => e.startT === shot.t && (e.type === "goal" || e.type === "shot-result"));
      expect(results.length).toBeLessThanOrEqual(1);
      const result = results[0];
      if (!result) {
        // Still in flight when the sequence ended; no outcome is invented.
        expect(f.events.some((e) => e.t > shot.t && !["shot", "deflection"].includes(e.type))).toBe(false);
        continue;
      }
      const s = snapshotAt(f, result.t);
      const end = result.end!;
      expect(result.t).toBeGreaterThan(shot.t);
      // Touches on the way, which decide a result that is not a goal or a catch.
      const touches = f.events.filter((e) => e.type === "deflection" && e.t > shot.t && e.t <= result.t);
      const first = touches[0];
      // Whole ball over a goal line: the event records the crossing point on that line.
      const onEndLine = Math.abs(end.x - (PITCH_LENGTH + BALL_RADIUS)) < 1e-9 || Math.abs(end.x + BALL_RADIUS) < 1e-9;
      const insideFrame = Math.abs(end.y - PITCH_WIDTH / 2) < GOAL_WIDTH / 2 - BALL_RADIUS && end.z < GOAL_HEIGHT - BALL_RADIUS;
      const keeper = keeperOfOpponents(shot.teamId);
      if (result.outcome === "scored") {
        expect(onEndLine && insideFrame).toBe(true);
        expect(overEndLine(s.ball)).toBe(true);
        expect(inGoalMouth(s.ball)).toBe(true);
        expect(overEndLine(before(f, result.t).ball)).toBe(false);
        expect(s.possession).toBeNull();
        // It went in at the end the shooter attacks.
        const attacksUp = f.teams.find((team) => team.id === shot.teamId)!.attacksTowards === "increasing-x";
        expect(end.x > PITCH_LENGTH / 2).toBe(attacksUp);
      } else if (result.outcome === "saved" && s.possession?.playerId === keeper && !first) {
        // Held at the first attempt.
        expect(s.ball).toEqual(end);
        expect(gap(playerIn(s, keeper), s.ball)).toBeLessThanOrEqual(KEEPER_REACH + 1e-9);
        expect(s.ball.z).toBeLessThanOrEqual(KEEPER_HEIGHT);
        expect(overEndLine(s.ball)).toBe(false);
      } else if (result.outcome === "saved") {
        // Parried: the goalkeeper's touch came first.
        expect(first?.playerId).toBe(keeper);
        expect(first?.description).toMatch(/^Parried/);
      } else if (result.outcome === "blocked") {
        expect(first?.description).toMatch(/^Blocked/);
        expect(f.roster.find((p) => p.id === first!.playerId)!.teamId).not.toBe(shot.teamId);
      } else {
        expect(result.outcome).toBe("missed");
        expect(first === undefined || /hits the/.test(first.description)).toBe(true);
        const offside = f.events.some((e) => e.t === result.t && e.type === "offside");
        if (s.possession) {
          // Picked up once it had run out of pace.
          expect(s.ball).toEqual(end);
        } else if (!offside) {
          // Left the pitch outside the frame.
          const onTouchline = Math.abs(end.y + BALL_RADIUS) < 1e-9 || Math.abs(end.y - PITCH_WIDTH - BALL_RADIUS) < 1e-9;
          expect(onTouchline || (onEndLine && !insideFrame)).toBe(true);
        }
      }
    }
  });

  it("deflects the ball only off a player within reach of it, or the woodwork", () => {
    for (const d of f.events.filter((e) => e.type === "deflection")) {
      const s = snapshotAt(f, d.t);
      expect(s.possession).toBeNull();
      expect(s.ball).toEqual(d.start);
      if (d.playerId) {
        const reach = /^Parried/.test(d.description) ? KEEPER_REACH : BLOCK_REACH;
        expect(gap(playerIn(s, d.playerId), s.ball)).toBeLessThanOrEqual(reach + 1e-9);
      }
      // The ball leaves the contact on a new path.
      const next = f.snapshots[f.snapshots.indexOf(s) + 1];
      if (next && !next.discontinuity) expect(gap(next.ball, s.ball)).toBeGreaterThan(0);
    }
  });
});

describe("ball out of play", () => {
  /** Every kick that ended with the ball over a line without a goal: the event at that instant and the fixture. */
  const out = fixtures.flatMap(([, f]) =>
    f.events
      .filter((e) => (e.type === "pass" || e.type === "shot-result") && !snapshotAt(f, e.t).possession && e.end)
      .filter((e) => !f.events.some((x) => x.t === e.t && x.type === "offside"))
      .map((e) => [f, e] as const),
  );
  /** Team of the last player to touch the ball before it went out: the kicker, or whoever it came off since. */
  const lastTouch = (f: MatchFixture, e: MatchEvent) => {
    const touched = f.events.filter((x) => x.type === "deflection" && x.playerId && x.t > e.startT! && x.t <= e.t).at(-1);
    return touched ? f.roster.find((p) => p.id === touched.playerId)!.teamId : e.teamId;
  };

  it("happens for passes and shots in the sampled seeds", () => {
    expect(out.length).toBeGreaterThan(5);
  });

  it("restarts with a throw-in, corner or goal kick against the team that touched it last", () => {
    const kinds = new Set<string>();
    for (const [f, e] of out) {
      const end = e.end!;
      const side = Math.abs(end.y + BALL_RADIUS) < 1e-9 || Math.abs(end.y - PITCH_WIDTH - BALL_RADIUS) < 1e-9;
      const endLine = Math.abs(end.x + BALL_RADIUS) < 1e-9 || Math.abs(end.x - PITCH_LENGTH - BALL_RADIUS) < 1e-9;
      expect(side || endLine).toBe(true);
      const restart = f.events.find((x) => x.t > e.t && RESTARTS.includes(x.type));
      if (!restart) continue; // sequence ended during the dead ball
      // Nothing else happens while the ball is dead.
      expect(f.events.filter((x) => x.t > e.t && x.t < restart.t && x.type !== "deflection")).toEqual([]);
      const touched = lastTouch(f, e);
      expect(restart.teamId).not.toBe(touched);
      const s = snapshotAt(f, restart.t);
      expect(s.discontinuity).toBe(true);
      expect(s.possession?.playerId).toBe(restart.playerId);
      const taker = playerIn(s, restart.playerId!);
      kinds.add(restart.type);
      if (side) {
        // Thrown in from the touchline where it went out, held over the head.
        expect(restart.type).toBe("throw-in");
        expect(taker.y).toBe(end.y < 0 ? 0 : PITCH_WIDTH);
        expect(taker.x).toBeCloseTo(Math.min(PITCH_LENGTH - 1, Math.max(1, end.x)), 9);
        expect(s.ball.z).toBe(THROW_HEIGHT);
      } else {
        const defending = f.teams.find((t) => (t.attacksTowards === "increasing-x") === end.x < 0)!;
        expect(restart.type).toBe(touched === defending.id ? "corner" : "goal-kick");
        expect(gap(s.ball, taker)).toBeCloseTo(DRIBBLE_OFFSET, 9);
        if (restart.type === "corner") {
          // From the corner on the side it went out, inside the corner arc.
          const corner = { x: end.x < 0 ? 0 : PITCH_LENGTH, y: end.y < PITCH_WIDTH / 2 ? 0 : PITCH_WIDTH };
          expect(gap(s.ball, corner)).toBeLessThan(1.5);
        } else {
          expect(f.roster.find((p) => p.id === restart.playerId)!.role).toBe("GK");
        }
      }
    }
    expect(kinds.has("throw-in")).toBe(true);
    expect(kinds.has("goal-kick")).toBe(true);
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
    expect(kickContacts(sampleFixture).map(({ t, playerId, kind }) => ({ t, playerId, kind }))).toEqual([
      { t: 2_900, playerId: "hcf-6", kind: "kick" },
      { t: 5_300, playerId: "hcf-8", kind: "kick" },
      { t: 7_300, playerId: "hcf-10", kind: "kick" },
      { t: 8_800, playerId: "hcf-9", kind: "kick" },
      { t: 20_000, playerId: "nvr-9", kind: "kick" },
    ]);
  });
});
