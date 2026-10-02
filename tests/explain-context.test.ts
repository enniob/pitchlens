import { describe, expect, it } from "vitest";
import { CONTEXT_LIMITS, contextSize, extractMatchContext, type MatchContext } from "@/explain/context";
import type { MatchEvent, MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import { eventsAt, positionsAt } from "@/playback/derive";
import { PlaybackEngine } from "@/playback/engine";
import { generateMatch, type TacticsConfig } from "@/simulation/generate";

/** The away team switches 4-3-3 → 4-2-3-1 at 0:30 in every generated match used here. */
const TACTICS: TacticsConfig = { away: { formation: "4-3-3", changes: [{ t: 30_000, formation: "4-2-3-1" }] } };
const generated = (seed: number) => generateMatch({ seed, durationMs: 60_000, tactics: TACTICS });
// Seeds picked for coverage: 2 has an offside, 9 a goal, 0 a shot whose result arrives 640 ms later.
const offsideMatch = generated(2);
const goalMatch = generated(9);
const shotMatch = generated(0);

const json = (c: MatchContext) => JSON.stringify(c);
const firstOf = (f: MatchFixture, type: MatchEvent["type"]) => {
  const e = f.events.find((x) => x.type === type);
  expect(e, `${f.matchId} should contain a ${type}`).toBeDefined();
  return e!;
};
const eventIn = (c: MatchContext, id: string) => c.events.find((e) => e.id === id);
const limitationCodes = (c: MatchContext) => c.limitations.map((l) => l.code);

/** Nothing in the package may come from after the selected time. */
function expectNoFutureData(f: MatchFixture, c: MatchContext) {
  const t = c.time.selectedMs;
  const text = json(c);
  for (const e of c.events) {
    expect(e.t).toBeLessThanOrEqual(t);
    if (e.startT !== undefined) expect(e.startT).toBeLessThanOrEqual(t);
  }
  for (const s of c.snapshots) expect(s.t).toBeLessThanOrEqual(t);
  expect(c.time.positionsAtMs).toBeLessThanOrEqual(t);
  for (const x of c.formations ?? []) expect(x.since).toBeLessThanOrEqual(t);
  for (const e of f.events) if (e.t > t) expect(text).not.toContain(`"${e.id}"`);
  expect(text).not.toContain("scheduled");
}

describe("goal", () => {
  const goal = firstOf(sampleFixture, "goal");
  const shot = firstOf(sampleFixture, "shot");

  it("before the goal: no goal, unchanged score, and the shot's result and destination withheld", () => {
    const c = extractMatchContext(sampleFixture, goal.t - 1);
    expect(c.score).toEqual({ home: 0, away: 0 });
    expect(eventIn(c, goal.id)).toBeUndefined();
    const s = eventIn(c, shot.id)!;
    expect(s.outcome).toBe("pending");
    expect(s.end).toBeUndefined();
    expect(s.description).not.toMatch(/on target/i);
    expect(json(c)).not.toMatch(/scored|on-target|GOAL/);
    expectNoFutureData(sampleFixture, c);
  });

  it("at and after the goal: it is included, the score counts it and the shot is resolved", () => {
    for (const t of [goal.t, goal.t + 3_000]) {
      const c = extractMatchContext(sampleFixture, t);
      expect(c.score).toEqual({ home: 1, away: 0 });
      expect(eventIn(c, goal.id)).toMatchObject({ type: "goal", outcome: "scored", t: goal.t });
      expect(eventIn(c, shot.id)).toMatchObject({ outcome: shot.outcome, end: shot.end });
      expectNoFutureData(sampleFixture, c);
    }
  });

  it("works the same for a simulated goal", () => {
    const g = firstOf(goalMatch, "goal");
    const before = extractMatchContext(goalMatch, g.t - 1);
    const at = extractMatchContext(goalMatch, g.t);
    const side = goalMatch.teams.find((t) => t.id === g.teamId)!.side;
    expect(at.score[side]).toBe(before.score[side] + 1);
    expect(eventIn(before, g.id)).toBeUndefined();
    expect(eventIn(at, g.id)?.outcome).toBe("scored");
    // The shot that scored is visible before the goal, still pending.
    const s = goalMatch.events.find((e) => e.type === "shot" && e.t === g.startT)!;
    expect(eventIn(before, s.id)?.outcome).toBe("pending");
    expectNoFutureData(goalMatch, before);
    expectNoFutureData(goalMatch, at);
  });
});

describe("offside", () => {
  const offside = firstOf(offsideMatch, "offside");

  it("is not exposed while the ball is still travelling to the offside player", () => {
    expect(offside.startT).toBeLessThan(offside.t);
    const c = extractMatchContext(offsideMatch, offside.t - 1);
    expect(eventIn(c, offside.id)).toBeUndefined();
    expect(json(c)).not.toContain("flagged");
    expect(json(c)).not.toMatch(/is offside/);
    expectNoFutureData(offsideMatch, c);
  });

  it("is included, with who was flagged and where, once it is called", () => {
    const c = extractMatchContext(offsideMatch, offside.t);
    expect(eventIn(c, offside.id)).toMatchObject({
      type: "offside",
      outcome: "flagged",
      teamId: offside.teamId,
      playerId: offside.playerId,
      startT: offside.startT,
    });
    expect(c.players.some((p) => p.id === offside.playerId)).toBe(true);
    expectNoFutureData(offsideMatch, c);
  });
});

describe("formation change", () => {
  const change = offsideMatch.tactics!.applied[0]!;
  const away = offsideMatch.teams.find((t) => t.side === "away")!;

  it("before its time: the starting formation only, and no hint of the change", () => {
    const c = extractMatchContext(offsideMatch, change.t - 1);
    expect(c.formations!.find((x) => x.teamId === away.id)).toEqual({ teamId: away.id, formation: "4-3-3", since: 0 });
    expect(eventIn(c, change.eventId)).toBeUndefined();
    expect(json(c)).not.toContain("4-2-3-1");
    for (const p of c.players.filter((p) => p.teamId === away.id))
      expect(p.slot?.id).toBe(offsideMatch.tactics!.initial.find((x) => x.teamId === away.id)!.assignments[p.id]);
    expectNoFutureData(offsideMatch, c);
  });

  it("at and after its time: the new formation, its assignments and its event", () => {
    for (const t of [change.t, change.t + 10_000]) {
      const c = extractMatchContext(offsideMatch, t);
      expect(c.formations!.find((x) => x.teamId === away.id)).toEqual({
        teamId: away.id,
        formation: "4-2-3-1",
        since: change.t,
        changeEventId: change.eventId,
      });
      for (const p of c.players.filter((p) => p.teamId === away.id)) expect(p.slot?.id).toBe(change.assignments[p.id]);
      if (t - c.time.lookbackMs <= change.t) expect(eventIn(c, change.eventId)?.type).toBe("formation-change");
      expectNoFutureData(offsideMatch, c);
    }
  });
});

describe("seeking backward", () => {
  it("gives exactly the package of a fresh extraction, with nothing from the later time", () => {
    const engine = new PlaybackEngine(sampleFixture);
    engine.seek(20_500);
    const later = extractMatchContext(sampleFixture, engine.status.timeMs);
    expect(later.score).toEqual({ home: 1, away: 0 });
    engine.seek(5_000);
    const back = extractMatchContext(sampleFixture, engine.status.timeMs);
    expect(back).toEqual(extractMatchContext(sampleFixture, 5_000));
    expect(back.score).toEqual({ home: 0, away: 0 });
    expectNoFutureData(sampleFixture, back);
  });

  it("never leaks later data, at any time, in any fixture", () => {
    for (const f of [sampleFixture, offsideMatch, goalMatch, shotMatch]) {
      for (let t = f.durationMs; t >= 0; t -= 1_370) expectNoFutureData(f, extractMatchContext(f, t));
      for (const e of f.events) {
        expectNoFutureData(f, extractMatchContext(f, e.t));
        if (e.t > 0) expectNoFutureData(f, extractMatchContext(f, e.t - 1));
      }
    }
  });
});

describe("actions in progress", () => {
  it("a pass in flight is not included, and neither is its recipient or result", () => {
    const pass = sampleFixture.events.find((e) => e.type === "pass")!;
    const c = extractMatchContext(sampleFixture, Math.round((pass.startT! + pass.t) / 2));
    expect(eventIn(c, pass.id)).toBeUndefined();
    expect(c.events.some((e) => e.recipientId === pass.recipientId)).toBe(false);
    expect(json(c)).not.toContain("complete");
    expect(c.ball.control).toBe("none");
    expect(c.ball.lastControl).toMatchObject({ playerId: pass.playerId });
    expect(c.ball.lastControl!.t).toBeLessThanOrEqual(pass.startT!);
    expect(limitationCodes(c)).toContain("ball-not-controlled");
  });

  it("a shot in flight is included as pending, without its destination or result", () => {
    const shot = shotMatch.events.find((e) => e.type === "shot")!;
    const result = shotMatch.events.find((e) => e.type === "shot-result" && e.startT === shot.t)!;
    expect(result.t - shot.t).toBeGreaterThan(200);
    const c = extractMatchContext(shotMatch, shot.t + 200);
    expect(eventIn(c, shot.id)).toMatchObject({ outcome: "pending" });
    expect(eventIn(c, shot.id)!.end).toBeUndefined();
    expect(eventIn(c, result.id)).toBeUndefined();
    expect(json(c)).not.toContain(`"${result.outcome}"`);
    expect(eventIn(extractMatchContext(shotMatch, result.t), result.id)?.outcome).toBe(result.outcome);
  });

  it("positions come from the latest snapshot at or before the time, never interpolated towards the next", () => {
    const shot = firstOf(sampleFixture, "shot");
    const t = shot.t + 50; // between snapshots, while the ball is moving fast
    const c = extractMatchContext(sampleFixture, t);
    const snapshot = sampleFixture.snapshots.find((s) => s.t === shot.t)!;
    expect(c.time.positionsAtMs).toBe(shot.t);
    const now = c.snapshots.at(-1)!;
    expect(now.t).toBe(shot.t);
    expect(now.ball.x).toBeCloseTo(snapshot.ball.x, 1);
    expect(Math.abs(positionsAt(sampleFixture, t).ball.x - now.ball.x)).toBeGreaterThan(0.2);
    expect(limitationCodes(c)).toContain("positions-sampled-earlier");
    expect(limitationCodes(extractMatchContext(sampleFixture, shot.t))).not.toContain("positions-sampled-earlier");
  });

  it("holds the snapshot before a discontinuity until the reset instant", () => {
    const reset = sampleFixture.snapshots.findIndex((s) => s.discontinuity);
    const cut = sampleFixture.snapshots[reset]!;
    expect(extractMatchContext(sampleFixture, cut.t - 1).time.positionsAtMs).toBe(sampleFixture.snapshots[reset - 1]!.t);
    expect(extractMatchContext(sampleFixture, cut.t).snapshots.at(-1)).toMatchObject({ t: cut.t, discontinuity: true });
  });
});

describe("descriptive metadata", () => {
  it("does not copy the fixture title, which can describe how the sequence ends", () => {
    const c = extractMatchContext(sampleFixture, 0);
    expect(sampleFixture.title).toMatch(/goal/);
    expect(c.match.label).toBe("Harbor City FC vs Northvale Rovers (synthetic)");
    expect(json(c)).not.toContain(sampleFixture.title);
    expect(json(c)).not.toMatch(/goal|score[sd]/i);
  });

  it("is independent of the title, whatever it says", () => {
    const spoiler: MatchFixture = { ...sampleFixture, title: "Late winner: Northvale snatch it 2-1" };
    const c = extractMatchContext(spoiler, 0);
    expect(c).toEqual(extractMatchContext(sampleFixture, 0));
    expect(json(c)).not.toMatch(/winner|snatch|2-1/);
  });
});

describe("fixtures without tactics metadata", () => {
  it("the scripted 1.0.0 demo: no formations or slots, and the gap is stated", () => {
    const c = extractMatchContext(sampleFixture, 9_400);
    expect(c.match).toMatchObject({ schemaVersion: "1.0.0", synthetic: true, matchId: sampleFixture.matchId });
    expect(c.match.generator).toBeUndefined();
    expect(c.formations).toBeNull();
    expect(c.players).toHaveLength(22);
    expect(c.players.every((p) => p.slot === undefined)).toBe(true);
    expect(limitationCodes(c)).toEqual(expect.arrayContaining(["synthetic-data", "no-player-attributes", "no-formation-data"]));
  });

  it("an older generated fixture without tactics", () => {
    const { tactics: _tactics, generator: _generator, ...rest } = generateMatch({ seed: 3, durationMs: 30_000 });
    const legacy: MatchFixture = { ...rest, schemaVersion: "1.2.0", events: rest.events.filter((e) => e.type !== "formation-change") };
    const c = extractMatchContext(legacy, 15_000);
    expect(c.formations).toBeNull();
    expect(limitationCodes(c)).toContain("no-formation-data");
    expectNoFutureData(legacy, c);
  });

  it("generated fixtures carry their generator and no formation-data limitation", () => {
    const c = extractMatchContext(offsideMatch, 10_000);
    expect(c.match.generator).toEqual(offsideMatch.generator);
    expect(limitationCodes(c)).not.toContain("no-formation-data");
    expect(limitationCodes(c)).toContain("synthetic-data");
  });
});

describe("timestamps", () => {
  it.each([NaN, Infinity, -Infinity, -1, sampleFixture.durationMs + 1, "100" as unknown as number, undefined as unknown as number])(
    "rejects %s",
    (t) => {
      expect(() => extractMatchContext(sampleFixture, t)).toThrow(RangeError);
    },
  );

  it("accepts both ends of the match", () => {
    expect(extractMatchContext(sampleFixture, 0).events).toEqual([]);
    expect(extractMatchContext(sampleFixture, 0).time.positionsAtMs).toBe(0);
    expect(extractMatchContext(sampleFixture, sampleFixture.durationMs).time.positionsAtMs).toBe(sampleFixture.durationMs);
  });

  it("floors fractional times, so a time just short of an event never reveals it", () => {
    const goal = firstOf(sampleFixture, "goal");
    expect(extractMatchContext(sampleFixture, goal.t - 0.1).time.selectedMs).toBe(goal.t - 1);
    expect(eventIn(extractMatchContext(sampleFixture, goal.t - 0.1), goal.id)).toBeUndefined();
    expect(eventIn(extractMatchContext(sampleFixture, goal.t + 0.7), goal.id)).toBeDefined();
  });

  it("rejects an invalid fixture", () => {
    const broken = { ...sampleFixture, snapshots: sampleFixture.snapshots.slice(0, 1) };
    expect(() => extractMatchContext(broken, 0)).toThrow(/Invalid fixture/);
  });
});

describe("bounded payload", () => {
  const long = generateMatch({ seed: 5, durationMs: 180_000, tactics: TACTICS });

  it("stays within the default limit at every time of a long match", () => {
    for (let t = 0; t <= long.durationMs; t += 2_500) {
      const c = extractMatchContext(long, t);
      expect(contextSize(c)).toBeLessThanOrEqual(CONTEXT_LIMITS.maxBytes.default);
      expect(c.events.length).toBeLessThanOrEqual(CONTEXT_LIMITS.maxEvents.default);
      expect(c.snapshots.length).toBeLessThanOrEqual(CONTEXT_LIMITS.maxSnapshots.default);
      expect(c.events.every((e) => e.t >= c.time.windowStartMs)).toBe(true);
      expect(c.snapshots.every((s) => s.t >= c.time.windowStartMs || s.t === c.time.positionsAtMs)).toBe(true);
    }
  });

  it("keeps the most recent events and says how many were dropped", () => {
    const all = extractMatchContext(sampleFixture, 9_400, { maxEvents: 50 });
    const few = extractMatchContext(sampleFixture, 9_400, { maxEvents: 2 });
    expect(few.events).toEqual(all.events.slice(-2));
    expect(few.limitations.find((l) => l.code === "events-truncated")?.message).toContain(`${all.events.length - 2}`);
  });

  it("reports events before the lookback window", () => {
    const c = extractMatchContext(sampleFixture, 21_000, { lookbackMs: 5_000 });
    expect(c.time.windowStartMs).toBe(16_000);
    expect(c.events.map((e) => e.id)).toEqual(["e7-kickoff", "e8-pass"]);
    expect(limitationCodes(c)).toContain("events-before-window");
    expect(c.score).toEqual({ home: 1, away: 0 });
  });

  it("trims the oldest snapshots, then the oldest events, to fit maxBytes", () => {
    const options = { lookbackMs: 30_000, maxEvents: 50, maxSnapshots: 8 };
    // The busiest 30 s of the match.
    const t = Array.from({ length: 31 }, (_, i) => 30_000 + i * 5_000).reduce((best, x) =>
      eventsAt(long, x).length - eventsAt(long, x - 30_000).length > eventsAt(long, best).length - eventsAt(long, best - 30_000).length ? x : best,
    );
    const full = extractMatchContext(long, t, options);
    for (const maxBytes of [8_000, 12_000, 16_000]) {
      const c = extractMatchContext(long, t, { ...options, maxBytes });
      expect(contextSize(c)).toBeLessThanOrEqual(maxBytes);
      expect(c.snapshots.at(-1)!.t).toBe(c.time.positionsAtMs);
      expect(c.snapshots).toEqual(full.snapshots.slice(full.snapshots.length - c.snapshots.length));
      expect(c.events).toEqual(full.events.slice(full.events.length - c.events.length));
      if (limitationCodes(c).includes("events-truncated")) expect(c.snapshots).toHaveLength(1);
    }
    const smallest = extractMatchContext(long, t, { ...options, maxBytes: 8_000 });
    expect(limitationCodes(smallest)).toEqual(expect.arrayContaining(["snapshots-truncated", "events-truncated"]));
  });

  it("spreads snapshots over the window and always keeps the current one", () => {
    const c = extractMatchContext(long, 90_000, { lookbackMs: 10_000, maxSnapshots: 6 });
    expect(c.snapshots.map((s) => s.t)).toEqual([80_000, 82_000, 84_000, 86_000, 88_000, 90_000]);
    // Between snapshots, the earliest target falls before the window and is left out.
    const between = extractMatchContext(long, 90_050, { lookbackMs: 10_000, maxSnapshots: 6 });
    expect(between.snapshots.map((s) => s.t)).toEqual([82_000, 84_000, 86_000, 88_000, 90_000]);
    expect(extractMatchContext(long, 90_050, { lookbackMs: 0 }).snapshots.map((s) => s.t)).toEqual([90_000]);
  });

  it.each([
    { lookbackMs: -1 },
    { lookbackMs: 30_001 },
    { maxEvents: 0 },
    { maxEvents: 2.5 },
    { maxSnapshots: 9 },
    { maxBytes: 7_999 },
    { maxBytes: 100_000 },
  ])("rejects option %o", (options) => {
    expect(() => extractMatchContext(sampleFixture, 1_000, options)).toThrow(RangeError);
  });
});

describe("determinism and serialisation", () => {
  it("gives identical, JSON-round-trippable output for the same input", () => {
    const a = extractMatchContext(offsideMatch, 41_000);
    const b = extractMatchContext(generated(2), 41_000);
    expect(b).toEqual(a);
    expect(JSON.parse(json(a))).toEqual(a);
  });

  it("does not modify the fixture", () => {
    const before = JSON.stringify(offsideMatch);
    extractMatchContext(offsideMatch, 35_000);
    expect(JSON.stringify(offsideMatch)).toBe(before);
  });
});
