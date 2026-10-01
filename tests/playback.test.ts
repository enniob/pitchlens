import { describe, expect, it } from "vitest";
import type { MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import { validateFixture } from "@/match/validate";
import { eventsAt, frameAt, scoreAt } from "@/playback/derive";
import { PlaybackEngine, SPEEDS } from "@/playback/engine";

const f = sampleFixture;
const goal = f.events.find((e) => e.type === "goal")!;

/**
 * Run the engine to the end with a fixed real-time step, recording every crossed
 * event and checking after each step that the displayed score matches the
 * starting score plus the goals crossed so far.
 */
function runToEnd(engine: PlaybackEngine, stepMs: number) {
  const crossed: string[] = [];
  const home = engine.fixture.teams.find((t) => t.side === "home")!.id;
  const expected = { ...engine.fixture.startingState.score };
  engine.play();
  let guard = 0;
  while (engine.status.playing && guard++ < 1_000_000) {
    for (const e of engine.advance(stepMs)) {
      crossed.push(e.id);
      if (e.type === "goal") expected[e.teamId === home ? "home" : "away"] += 1;
    }
    expect(engine.frame().score).toEqual(expected);
  }
  return { crossed, score: engine.frame().score };
}

describe("PlaybackEngine clock", () => {
  it("starts paused at t = 0 with the starting state", () => {
    const engine = new PlaybackEngine(f);
    expect(engine.status).toMatchObject({ timeMs: 0, playing: false, speed: 1, ended: false });
    const frame = engine.frame();
    expect(frame.score).toEqual(f.startingState.score);
    expect(frame.events).toEqual([]);
  });

  it("does not move while paused", () => {
    const engine = new PlaybackEngine(f);
    engine.play();
    engine.advance(1_000);
    engine.pause();
    const frozen = engine.frame();
    expect(engine.advance(5_000)).toEqual([]);
    expect(engine.frame()).toEqual(frozen);
  });

  it("resumes from exactly where it paused", () => {
    const engine = new PlaybackEngine(f);
    engine.play();
    engine.advance(1_234);
    engine.pause();
    engine.advance(10_000);
    engine.play();
    engine.advance(16);
    expect(engine.status.timeMs).toBe(1_250);
  });

  it.each(SPEEDS)("scales real time by speed %s", (speed) => {
    const engine = new PlaybackEngine(f);
    engine.setSpeed(speed);
    engine.play();
    engine.advance(1_000);
    expect(engine.status.timeMs).toBe(1_000 * speed);
  });

  it("rejects unsupported speeds", () => {
    const engine = new PlaybackEngine(f);
    // @ts-expect-error — 3 is not a supported speed
    expect(() => engine.setSpeed(3)).toThrow();
  });

  it("stops at the end and replays from the start on play", () => {
    const engine = new PlaybackEngine(f);
    engine.play();
    engine.advance(f.durationMs * 10);
    expect(engine.status).toMatchObject({ timeMs: f.durationMs, playing: false, ended: true });
    engine.play();
    expect(engine.status.timeMs).toBe(0);
    expect(engine.status.playing).toBe(true);
  });
});

describe("event processing", () => {
  it("reports every event crossed by a single large step, in order", () => {
    const engine = new PlaybackEngine(f);
    engine.setSpeed(4);
    engine.play();
    // One "frame" covering the whole attack: turnover, three passes, shot and goal.
    const crossed = engine.advance(goal.t / 4);
    expect(crossed.map((e) => e.type)).toEqual(["turnover", "pass", "pass", "pass", "shot", "goal"]);
    expect(engine.frame().score).toEqual({ home: 1, away: 0 });
  });

  it.each(SPEEDS.flatMap((speed) => [16, 33, 250, 1_000].map((step) => [speed, step] as const)))(
    "preserves event order and score at speed %sx with %sms frames",
    (speed, step) => {
      const engine = new PlaybackEngine(f);
      engine.setSpeed(speed);
      const { crossed, score } = runToEnd(engine, step);
      expect(crossed).toEqual(f.events.map((e) => e.id));
      expect(score).toEqual({ home: 1, away: 0 });
    },
  );

  it("never reveals future events or the final score early", () => {
    for (let t = 0; t <= f.durationMs; t += 50) {
      const frame = frameAt(f, t);
      expect(frame.events.every((e) => e.t <= t)).toBe(true);
      expect(frame.events).toHaveLength(f.events.filter((e) => e.t <= t).length);
      expect(frame.score).toEqual(t < goal.t ? { home: 0, away: 0 } : { home: 1, away: 0 });
    }
  });

  it("produces identical events and results on replay", () => {
    const run = () => {
      const engine = new PlaybackEngine(f);
      engine.setSpeed(2);
      const result = runToEnd(engine, 17);
      return { ...result, final: engine.frame() };
    };
    expect(run()).toEqual(run());
  });
});

describe("restart", () => {
  it("clears score, event history and playback position", () => {
    const engine = new PlaybackEngine(f);
    engine.play();
    engine.advance(goal.t + 500);
    expect(engine.frame().score).toEqual({ home: 1, away: 0 });
    expect(engine.frame().events.length).toBeGreaterThan(0);

    engine.restart();
    const frame = engine.frame();
    expect(engine.status.timeMs).toBe(0);
    expect(frame.score).toEqual({ home: 0, away: 0 });
    expect(frame.events).toEqual([]);
    expect(frame).toEqual(frameAt(f, 0));
  });

  it("keeps playing after a restart if it was playing", () => {
    const engine = new PlaybackEngine(f);
    engine.play();
    engine.advance(3_000);
    engine.restart();
    expect(engine.status.playing).toBe(true);
    engine.advance(100);
    expect(engine.status.timeMs).toBe(100);
  });

  it("returns to a nonzero starting score, not 0–0", () => {
    const leading: MatchFixture = {
      ...f,
      matchId: "synthetic-mvp1-sample-001-leading",
      startingState: { ...f.startingState, score: { home: 1, away: 0 } },
    };
    expect(validateFixture(leading)).toEqual([]);

    const engine = new PlaybackEngine(leading);
    expect(engine.frame().score).toEqual({ home: 1, away: 0 });
    engine.play();
    engine.advance(f.durationMs);
    expect(engine.frame().score).toEqual({ home: 2, away: 0 });

    engine.restart();
    expect(engine.frame().score).toEqual({ home: 1, away: 0 });
    expect(engine.frame().events).toEqual([]);
    expect(scoreAt(leading, 0)).toEqual({ home: 1, away: 0 });
    expect(eventsAt(leading, 0)).toEqual([]);
  });
});
