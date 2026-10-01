import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import { sampleFixture } from "@/match/fixture";
import { frameAt, nextEventTime, previousEventTime } from "@/playback/derive";
import { PlaybackEngine } from "@/playback/engine";
import { generateMatch } from "@/simulation/generate";

const fixtures = [
  ["scripted 1.0.0", sampleFixture],
  ["generated 1.1.0", generateMatch({ seed: 42, durationMs: 60_000 })],
  ["generated 1.1.0 (seed 7)", generateMatch({ seed: 7, durationMs: 120_000 })],
] as const;

describe.each(fixtures)("seeking: %s", (_name, f) => {
  const times = [...new Set(f.events.map((e) => e.t))];

  it("matches a frame computed fresh, regardless of how we got there", () => {
    const target = Math.floor(f.durationMs * 0.6);
    const direct = new PlaybackEngine(f);
    direct.seek(target);

    const walked = new PlaybackEngine(f);
    walked.play();
    walked.advance(f.durationMs); // run to the end first
    walked.seek(target);

    expect(walked.frame()).toEqual(direct.frame());
    expect(direct.frame()).toEqual(frameAt(f, target));
  });

  it("never reveals future events, score or possession, in either direction", () => {
    const engine = new PlaybackEngine(f);
    const probes = [f.durationMs, f.durationMs / 2, 0, f.durationMs * 0.9, 1, f.durationMs / 3];
    for (const t of probes) {
      engine.seek(t);
      const frame = engine.frame();
      expect(frame.timeMs).toBe(t);
      expect(frame.events.every((e) => e.t <= t)).toBe(true);
      expect(frame.events).toHaveLength(f.events.filter((e) => e.t <= t).length);
      const home = f.teams.find((x) => x.side === "home")!.id;
      const goals = f.events.filter((e) => e.type === "goal" && e.t <= t);
      expect(frame.score).toEqual({
        home: f.startingState.score.home + goals.filter((g) => g.teamId === home).length,
        away: f.startingState.score.away + goals.filter((g) => g.teamId !== home).length,
      });
    }
  });

  it("updates players, ball and possession together at a snapshot time", () => {
    const snap = f.snapshots[Math.floor(f.snapshots.length / 2)]!;
    const engine = new PlaybackEngine(f);
    engine.seek(snap.t);
    const frame = engine.frame();
    expect(frame.players).toEqual(snap.players);
    expect(frame.ball).toEqual(snap.ball);
    expect(frame.possession).toEqual(snap.possession);
  });

  it("clamps out-of-range times and ignores non-finite ones", () => {
    const engine = new PlaybackEngine(f);
    engine.seek(-500);
    expect(engine.status.timeMs).toBe(0);
    engine.seek(Number.NaN);
    engine.seek(Number.POSITIVE_INFINITY);
    expect(engine.status.timeMs).toBe(0);
    engine.seek(f.durationMs + 10_000);
    expect(engine.status).toMatchObject({ timeMs: f.durationMs, ended: true, playing: false });
  });

  it("keeps pause/play state and speed, and continues deterministically", () => {
    const paused = new PlaybackEngine(f);
    paused.seek(1_000);
    expect(paused.status.playing).toBe(false);
    expect(paused.advance(500)).toEqual([]);
    expect(paused.status.timeMs).toBe(1_000);

    const playing = new PlaybackEngine(f);
    playing.setSpeed(2);
    playing.play();
    playing.seek(1_000);
    expect(playing.status).toMatchObject({ playing: true, speed: 2 });
    playing.advance(500);
    expect(playing.status.timeMs).toBe(2_000);
  });

  it("reports only events after the seek point when playing on", () => {
    const t = times[Math.floor(times.length / 2)]!;
    const engine = new PlaybackEngine(f);
    engine.play();
    engine.seek(t);
    const crossed = engine.advance(f.durationMs);
    expect(crossed.every((e) => e.t > t)).toBe(true);
    expect(crossed).toHaveLength(f.events.filter((e) => e.t > t).length);
  });

  it("restarts to the initial state after a seek", () => {
    const engine = new PlaybackEngine(f);
    engine.seek(f.durationMs);
    engine.restart();
    expect(engine.frame()).toEqual(frameAt(f, 0));
    expect(engine.frame().events).toEqual([]);
  });

  it("steps through every distinct event time forwards and backwards", () => {
    const engine = new PlaybackEngine(f);
    const forward: number[] = [];
    while (engine.seekToNextEvent()) forward.push(engine.status.timeMs);
    expect(forward).toEqual(times);
    expect(engine.seekToNextEvent()).toBe(false);

    // The forward walk ended on the last event, so backward starts one stop earlier.
    const backward: number[] = [];
    while (engine.seekToPreviousEvent()) backward.push(engine.status.timeMs);
    expect(backward).toEqual([...times].reverse().slice(1));
    expect(engine.seekToPreviousEvent()).toBe(false);
  });

  it("landing on an event includes that event and nothing later", () => {
    const engine = new PlaybackEngine(f);
    for (const t of times) {
      engine.seek(t - 1 < 0 ? 0 : t - 1);
      if (t > 0) expect(engine.frame().events.some((e) => e.t === t)).toBe(false);
      engine.seekToNextEvent();
      if (t > 0) expect(engine.status.timeMs).toBe(t);
      const atT = engine.frame().events;
      expect(atT.at(-1)!.t).toBeLessThanOrEqual(t);
      expect(atT.filter((e) => e.t === t)).toHaveLength(f.events.filter((e) => e.t === t).length);
    }
  });

  it("navigates relative to a time between events", () => {
    const a = times.find((t) => t > 0)!;
    const mid = a + 1;
    expect(previousEventTime(f, mid)).toBe(a);
    expect(previousEventTime(f, a)).toBe(times[times.indexOf(a) - 1] ?? null);
    expect(nextEventTime(f, a)).toBe(times[times.indexOf(a) + 1] ?? null);
  });
});

describe("goal scrubbing", () => {
  const f = sampleFixture;
  const goal = f.events.find((e) => e.type === "goal")!;

  it("shows the goal only from its timestamp, including when scrubbing back", () => {
    const engine = new PlaybackEngine(f);
    engine.seek(goal.t);
    expect(engine.frame().score).toEqual({ home: 1, away: 0 });
    engine.seek(goal.t - 1);
    expect(engine.frame().score).toEqual({ home: 0, away: 0 });
    expect(engine.frame().events.some((e) => e.type === "goal")).toBe(false);
  });

  it("previous event from the goal returns to the shot, with score back at 0–0", () => {
    const engine = new PlaybackEngine(f);
    engine.seek(goal.t);
    engine.seekToPreviousEvent();
    expect(engine.status.timeMs).toBeLessThan(goal.t);
    expect(engine.frame().score).toEqual({ home: 0, away: 0 });
  });
});

describe("Timeline markup", () => {
  const render = (over: Partial<Parameters<typeof Timeline>[0]> = {}) =>
    renderToStaticMarkup(
      <Timeline
        timeMs={2_000}
        durationMs={sampleFixture.durationMs}
        events={sampleFixture.events}
        hasPrevious
        hasNext
        onSeek={() => {}}
        onScrubStart={() => {}}
        onScrubEnd={() => {}}
        onPreviousEvent={() => {}}
        onNextEvent={() => {}}
        {...over}
      />,
    );

  it("exposes a labelled native slider with readable value text and event buttons", () => {
    const html = render();
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-label="Seek"');
    expect(html).toContain("0:02.0 of");
    expect(html).toContain("Prev event");
    expect(html).toContain("Next event");
  });

  it("disables navigation buttons at the ends", () => {
    const html = render({ hasPrevious: false, hasNext: false });
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it("does not leak event descriptions", () => {
    const html = render();
    for (const e of sampleFixture.events) expect(html).not.toContain(e.description);
  });
});
