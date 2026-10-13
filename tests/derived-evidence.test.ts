import { describe, expect, it } from "vitest";
import { contextSize, extractMatchContext, type MatchContext } from "@/explain/context";
import { checkGrounding } from "@/explain/grounding";
import type { MatchEvent, MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import {
  measureFormationChanges,
  measureMovement,
  measurePasses,
  measurePossessionSpells,
  measureProximity,
  type PositionSample,
} from "@/playback/derivedEvidence";
import { measureEvents } from "@/playback/patterns";
import { generateMatch } from "@/simulation/generate";
import { goalExplanation } from "./support/fakeModel";

const teams = [{ id: "a", attacksTowards: "increasing-x" as const }, { id: "b", attacksTowards: "decreasing-x" as const }];

function pass(id: string, t: number, teamId = "a", from = { x: 50, y: 30 }, to = { x: 53, y: 34 }, outcome: MatchEvent["outcome"] = "complete"): MatchEvent {
  return { id, t, type: "pass", teamId, playerId: `${teamId}1`, recipientId: `${teamId}2`, outcome, startT: t - 1_000,
    start: { ...from, z: 0 }, end: { ...to, z: 0 }, description: id };
}

function sample(t: number, teamId: string | null, players: Record<string, [number, number]> = {}, extra: Partial<PositionSample> = {}): PositionSample {
  return {
    t,
    ball: { x: 0, y: 0 },
    possession: teamId ? { teamId, playerId: `${teamId}1` } : null,
    players: Object.entries(players).map(([playerId, [x, y]]) => ({ playerId, x, y })),
    ...extra,
  };
}

/** Every event ID and snapshot time the measurements cite, which must all be in the package. */
function citations(c: MatchContext): { events: string[]; snapshots: number[] } {
  const m = c.measurements;
  return {
    events: [
      ...m.statistics.flatMap((s) => s.eventIds), ...m.patterns.flatMap((p) => p.eventIds), ...m.shotLocations.map((s) => s.eventId),
      ...m.passes.map((p) => p.eventId), ...m.formationChanges.map((f) => f.eventId),
      ...m.possessionSpells.flatMap((s) => [...s.eventIds, ...s.cite.flatMap((r) => r.kind === "event" ? [r.id] : [])]),
    ],
    snapshots: [...m.possessionSpells.flatMap((s) => [...s.snapshotTimes, ...s.cite.flatMap((r) => r.kind === "snapshot" ? [r.t] : [])]),...m.movement.flatMap((x) => x.snapshotTimes), ...(m.proximity ? [m.proximity.snapshotT] : [])],
  };
}

function expectCitableAndBounded(f: MatchFixture, c: MatchContext) {
  const t = c.time.selectedMs;
  const { events, snapshots } = citations(c);
  for (const id of events) expect(c.events.some((e) => e.id === id && e.t <= t), `event ${id}`).toBe(true);
  for (const s of snapshots) expect(c.snapshots.some((x) => x.t === s && x.t <= t), `snapshot ${s}`).toBe(true);
  const m = c.measurements;
  for (const sp of m.possessionSpells) {
    expect(sp.fromMs).toBeGreaterThanOrEqual(c.time.windowStartMs);
    expect(sp.toMs).toBeLessThanOrEqual(t);
    expect(sp.durationMs).toBe(sp.toMs - sp.fromMs);
  }
  for (const x of m.movement) expect(x.toMs).toBeLessThanOrEqual(t);
  const text = JSON.stringify(m);
  for (const e of f.events) if (e.t > t) expect(text).not.toContain(`"${e.id}"`);
  expect(m.passes.length).toBeLessThanOrEqual(8);
  expect(m.possessionSpells.length).toBeLessThanOrEqual(4);
  expect(m.movement.length).toBeLessThanOrEqual(5);
}

describe("pass measurements", () => {
  it("measures a known 3-4-5 pass and labels it a straight-line displacement", () => {
    const [p] = measurePasses([pass("p", 2_000, "a", { x: 50, y: 30 }, { x: 53, y: 34 })], teams).passes;
    expect(p).toEqual({ eventId: "p", teamId: "a", straightLineDistanceM: 5, travelMs: 1_000, averageStraightLineSpeedMps: 5,
      forwardProgressM: 3, unavailable: [] });
  });

  it("measures forward progress towards each team's own attacking goal", () => {
    const { passes } = measurePasses([pass("a-back", 1_000, "a", { x: 60, y: 34 }, { x: 50, y: 34 }), pass("b-fwd", 2_000, "b", { x: 60, y: 34 }, { x: 50, y: 34 })], teams);
    expect(passes.map((p) => p.forwardProgressM)).toEqual([-10, 10]);
    expect(passes.map((p) => p.straightLineDistanceM)).toEqual([10, 10]);
  });

  it("returns null with the reason for legacy passes missing coordinates or a start time", () => {
    const { start: _s, end: _e, startT: _t, ...bare } = pass("bare", 1_000);
    const [p] = measurePasses([bare as MatchEvent], teams).passes;
    expect(p).toEqual({ eventId: "bare", teamId: "a", straightLineDistanceM: null, travelMs: null, averageStraightLineSpeedMps: null,
      forwardProgressM: null, unavailable: ["start", "end", "startT"] });
  });

  it("keeps the latest passes and counts the rest", () => {
    const events = Array.from({ length: 11 }, (_, i) => pass(`p${i}`, 1_000 * (i + 1)));
    const { passes, omittedOlder } = measurePasses(events, teams);
    expect(passes.map((p) => p.eventId)).toEqual(["p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"]);
    expect(omittedOlder).toBe(3);
  });

  it("never measures a pass still in flight, so its recipient and result stay hidden", () => {
    const inFlight = sampleFixture.events.find((e) => e.id === "e3-pass")!;
    const c = extractMatchContext(sampleFixture, inFlight.startT! + 100);
    expect(c.measurements.passes.map((p) => p.eventId)).toEqual(["e2-pass"]);
    expect(c.measurements.statistics.find((s) => s.teamId === inFlight.teamId)!.attemptedPasses).toBe(1);
    expect(JSON.stringify(c.measurements)).not.toContain("e3-pass");
    expect(JSON.stringify(c.measurements)).not.toContain(inFlight.recipientId!);
    const landed = extractMatchContext(sampleFixture, inFlight.t);
    const measured = landed.measurements.passes.find((p) => p.eventId === "e3-pass")!;
    expect(measured.travelMs).toBe(inFlight.t - inFlight.startT!);
    const event = landed.events.find((e) => e.id === "e3-pass")!;
    expect(measured.straightLineDistanceM).toBe(Math.round(Math.hypot(event.end!.x - event.start!.x, event.end!.y - event.start!.y) * 10) / 10);
  });
});

describe("pass completion", () => {
  const events = [pass("old", 1_000), pass("c1", 12_000), pass("lost", 13_000, "a", undefined, undefined, "intercepted"), pass("miss", 14_000, "a", undefined, undefined, "missed"), pass("c2", 15_000)];

  it("uses the window as the denominator, never earlier or later passes", () => {
    const s = measureEvents([...events, pass("future", 16_001)], teams, 16_000, 10_000).statistics[0]!;
    expect(s).toMatchObject({ attemptedPasses: 4, completedPasses: 2, completionPercent: 50 });
    expect(s.eventIds).toEqual(["c1", "lost", "miss", "c2"]);
    expect(measureEvents(events, teams, 16_000, 0).statistics[0]).toMatchObject({ attemptedPasses: 5, completedPasses: 3, completionPercent: 60 });
  });

  it("gives no ratio for partial coverage or no attempts", () => {
    expect(measureEvents(events, teams, 16_000, 10_000, false).statistics[0]).toMatchObject({ attemptedPasses: 4, completionPercent: null });
    expect(measureEvents(events, teams, 16_000, 10_000).statistics[1]).toMatchObject({ attemptedPasses: 0, completionPercent: null });
  });

  it("gives no ratio when the key-event filter leaves passes out of the package", () => {
    const c = extractMatchContext(sampleFixture, 9_400, { eventTypes: ["shot", "goal"] });
    expect(c.measurements.statistics.every((s) => s.completionPercent === null && s.attemptedPasses === 0)).toBe(true);
  });
});

describe("formation changes", () => {
  const base = { home: { formation: "4-4-2" as const }, away: { formation: "4-3-3" as const, changes: [{ t: 20_000, formation: "4-4-2" as const }] } };
  const fixture = generateMatch({ seed: 5, durationMs: 40_000, tactics: base });
  const change = fixture.tactics!.applied[0]!;

  it("reports an applied change with its from/to and time since, citing its event", () => {
    const c = extractMatchContext(fixture, change.t + 2_500);
    expect(c.measurements.formationChanges).toEqual([{ eventId: change.eventId, teamId: change.teamId, t: change.t, from: "4-3-3", to: "4-4-2", activeForMs: 2_500 }]);
    expectCitableAndBounded(fixture, c);
  });

  it("never reveals a scheduled change before it applies, and forgets it after seeking back", () => {
    const before = extractMatchContext(fixture, change.t - 1);
    expect(before.measurements.formationChanges).toEqual([]);
    expect(JSON.stringify(before.measurements)).not.toContain(change.eventId);
    extractMatchContext(fixture, change.t + 5_000);
    expect(extractMatchContext(fixture, change.t - 1)).toEqual(before);
  });

  it("gives none for fixtures without formation data or unmatched events", () => {
    const event = fixture.events.find((e) => e.id === change.eventId)!;
    expect(measureFormationChanges([event], undefined, 30_000)).toEqual([]);
    expect(measureFormationChanges([event], [], 30_000)).toEqual([]);
    expect(measureFormationChanges([event], fixture.tactics!.applied, change.t - 1)).toEqual([]);
  });
});

describe("possession spells", () => {
  const all = { events: [] as { id: string; t: number; teamId: string }[], snapshotTimes: [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000] };
  const samples = [sample(0, "a"), sample(1_000, null), sample(2_000, "a"), sample(3_000, "b"), sample(4_000, "b"), sample(5_000, null), sample(6_000, "a")];

  it("bridges a team's own passes in flight and ends when the opponent gains the ball", () => {
    const { spells } = measurePossessionSpells(samples, 0, 6_000, all);
    expect(spells.map(({ teamId, fromMs, toMs, durationMs, end }) => ({ teamId, fromMs, toMs, durationMs, end }))).toEqual([
      { teamId: "a", fromMs: 0, toMs: 2_000, durationMs: 2_000, end: "opponent-gained-possession" },
      { teamId: "b", fromMs: 3_000, toMs: 4_000, durationMs: 1_000, end: "opponent-gained-possession" },
      { teamId: "a", fromMs: 6_000, toMs: 6_000, durationMs: 0, end: "ongoing" },
    ]);
  });

  it("ends a spell at a reset instead of joining across it", () => {
    const reset = [sample(0, "a"), sample(1_000, "a"), sample(2_000, "a", {}, { discontinuity: true }), sample(3_000, "a")];
    const { spells } = measurePossessionSpells(reset, 0, 3_000, all);
    expect(spells.map((s) => [s.fromMs, s.toMs, s.end])).toEqual([[0, 1_000, "reset"], [2_000, 3_000, "ongoing"]]);
  });

  it("clips a spell that began before the window to the window start", () => {
    const { spells } = measurePossessionSpells(samples, 500, 2_500, all);
    expect(spells).toMatchObject([{ teamId: "a", fromMs: 500, toMs: 2_000, startsBeforeWindow: true, end: "ongoing" }]);
    // At a sample exactly on the window start, the spell only starts before it if the team had the ball earlier.
    expect(measurePossessionSpells(samples, 2_000, 2_500, all).spells[0]).toMatchObject({ fromMs: 2_000, startsBeforeWindow: true });
    expect(measurePossessionSpells(samples, 3_000, 3_500, all).spells[0]).toMatchObject({ teamId: "b", fromMs: 3_000, startsBeforeWindow: false });
    // Nothing carries over from an empty sample at the window start.
    expect(measurePossessionSpells(samples, 5_000, 5_500, all).spells).toEqual([]);
  });

  it("uses nothing after the selected time and changes nothing when seeking back", () => {
    const now = measurePossessionSpells(samples, 0, 3_500, all);
    expect(now.spells.at(-1)).toMatchObject({ teamId: "b", toMs: 3_000, end: "ongoing" });
    measurePossessionSpells(samples, 0, 6_000, all);
    expect(measurePossessionSpells(samples, 0, 3_500, all)).toEqual(now);
  });

  it("cites the team's events until the opponent gains the ball, and drops spells nothing supplied can cite", () => {
    const citable = { events: [{ id: "a-shot", t: 2_500, teamId: "a" }, { id: "b-tackle", t: 3_000, teamId: "b" }], snapshotTimes: [4_000] };
    const r = measurePossessionSpells(samples, 0, 6_000, citable);
    expect(r.spells.map((s) => [s.teamId, s.eventIds, s.snapshotTimes])).toEqual([["a", ["a-shot"], []], ["b", ["b-tackle"], [4_000]]]);
    expect(r.spells.map((s) => s.cite)).toEqual([[{ kind: "event", id: "a-shot" }], [{ kind: "event", id: "b-tackle" }, { kind: "snapshot", t: 4_000 }]]);
    expect(r.omittedUncitable).toBe(1);
  });

  it("keeps the latest spells", () => {
    const flips = Array.from({ length: 9 }, (_, i) => sample(i * 1_000, i % 2 ? "b" : "a"));
    const r = measurePossessionSpells(flips, 0, 8_000, all);
    expect(r.spells.map((s) => s.fromMs)).toEqual([5_000, 6_000, 7_000, 8_000]);
    expect(r.omittedOlder).toBe(5);
  });

  it("matches the sample fixture's turnover-to-goal possession", () => {
    const c = extractMatchContext(sampleFixture, 9_400);
    const hcf = c.measurements.possessionSpells.find((s) => s.teamId === "hcf")!;
    // hcf-9 still has the ball at 8.7 s; the shot is struck at 8.8 s.
    expect(hcf).toMatchObject({ fromMs: 2_400, toMs: 8_700, durationMs: 6_300, end: "ongoing" });
    expect(hcf.cite).toEqual([{ kind: "event", id: "e1-turnover" }, { kind: "event", id: "e6-goal" }]);
    expect(hcf.eventIds).toEqual(["e1-turnover", "e2-pass", "e3-pass", "e4-pass", "e5-shot", "e6-goal"]);
    expectCitableAndBounded(sampleFixture, c);
  });
});

describe("movement", () => {
  const triangle = [sample(0, null, { p: [0, 0] }), sample(1_000, null, { p: [3, 4] }), sample(2_000, null, { p: [6, 0] })];

  it("keeps displacement, sampled path and average speed distinct on known geometry", () => {
    expect(measureMovement(triangle, [], [{ kind: "player", playerId: "p" }])).toEqual([{
      subject: { kind: "player", playerId: "p" }, fromMs: 0, toMs: 2_000, snapshotTimes: [0, 1_000, 2_000],
      displacementM: 6, sampledPathM: 10, averageSampledPathSpeedMps: 5,
    }]);
  });

  it("measures the ball on the pitch surface, ignoring height", () => {
    const ball = [sample(0, null, {}, { ball: { x: 0, y: 0 } }), sample(500, null, {}, { ball: { x: 6, y: 8 } })];
    expect(measureMovement(ball, [], [{ kind: "ball" }])[0]).toMatchObject({ displacementM: 10, sampledPathM: 10, averageSampledPathSpeedMps: 20 });
  });

  it("never measures across a reset, even one between the supplied snapshots", () => {
    expect(measureMovement(triangle, [1_500], [{ kind: "player", playerId: "p" }])[0]).toMatchObject({
      fromMs: 2_000, snapshotTimes: [2_000], displacementM: null, sampledPathM: null, averageSampledPathSpeedMps: null, unavailable: "single-sample" });
    const flagged = triangle.map((s) => s.t === 1_000 ? { ...s, discontinuity: true } : s);
    expect(measureMovement(flagged, [], [{ kind: "player", playerId: "p" }])[0]).toMatchObject({ fromMs: 1_000, displacementM: 5, sampledPathM: 5 });
  });

  it("stops at a snapshot without the player", () => {
    const missing = [sample(0, null, { p: [0, 0] }), sample(1_000, null, {}), sample(2_000, null, { p: [6, 0] })];
    expect(measureMovement(missing, [], [{ kind: "player", playerId: "p" }])[0]).toMatchObject({ unavailable: "single-sample", snapshotTimes: [2_000] });
    expect(measureMovement(missing, [], [{ kind: "player", playerId: "x" }])[0]).toMatchObject({ unavailable: "single-sample", snapshotTimes: [] });
  });

  it("does not span the kickoff reset after the sample fixture's goal", () => {
    const c = extractMatchContext(sampleFixture, 21_000);
    expect(c.measurements.movement.length).toBeGreaterThan(0);
    for (const m of c.measurements.movement) expect(m.fromMs).toBeGreaterThanOrEqual(19_500);
    expectCitableAndBounded(sampleFixture, c);
  });
});

describe("nearby opponents", () => {
  const teamOf = new Map([["a1", "a"], ["a2", "a"], ["b1", "b"], ["b2", "b"], ["b3", "b"]]);
  const at = sample(1_000, "a", { a1: [50, 30], a2: [51, 30], b1: [53, 34], b2: [50, 40], b3: [60.01, 30] });

  it("counts opponents within each radius, boundaries included, ignoring teammates", () => {
    expect(measureProximity(at, teamOf)).toEqual({ snapshotT: 1_000, playerId: "a1", teamId: "a",
      opponentsWithin: [{ radiusM: 5, count: 1 }, { radiusM: 10, count: 2 }], nearestOpponentM: 5 });
  });

  it("is null when nobody controls the ball or the controller is missing", () => {
    expect(measureProximity({ ...at, possession: null }, teamOf)).toBeNull();
    expect(measureProximity({ ...at, possession: { teamId: "a", playerId: null } }, teamOf)).toBeNull();
    expect(measureProximity({ ...at, possession: { teamId: "a", playerId: "ghost" } }, teamOf)).toBeNull();
  });

  it("gives no nearest distance without opponents", () => {
    expect(measureProximity(sample(0, "a", { a1: [0, 0] }), teamOf)).toMatchObject({ opponentsWithin: [{ radiusM: 5, count: 0 }, { radiusM: 10, count: 0 }], nearestOpponentM: null });
  });
});

describe("in the evidence package", () => {
  const generated = generateMatch({ seed: 12 });

  it("cites only supplied evidence at or before the cutoff, at every time, within the byte budget", () => {
    for (const f of [sampleFixture, generated]) {
      for (let t = 0; t <= f.durationMs; t += 1_250) {
        const c = extractMatchContext(f, t);
        expectCitableAndBounded(f, c);
        expect(contextSize(c)).toBeLessThanOrEqual(24_000);
      }
    }
  });

  it("keeps measurements citable after the byte budget trims snapshots and events", () => {
    const c = extractMatchContext(generated, 30_000, { maxBytes: 8_000 });
    expect(contextSize(c)).toBeLessThanOrEqual(8_000);
    expectCitableAndBounded(generated, c);
  });

  it("recomputes identical measurements after seeking backwards", () => {
    const earlier = extractMatchContext(generated, 20_000);
    extractMatchContext(generated, 50_000);
    expect(extractMatchContext(generated, 20_000).measurements).toEqual(earlier.measurements);
  });

  it("works for the legacy 1.0.0 sample fixture, whose passes predate formation data", () => {
    const c = extractMatchContext(sampleFixture, 9_400);
    expect(c.match.schemaVersion).toBe("1.0.0");
    expect(c.measurements.formationChanges).toEqual([]);
    expect(c.measurements.passes.map((p) => p.eventId)).toEqual(["e2-pass", "e3-pass", "e4-pass"]);
    expect(c.measurements.statistics.find((s) => s.teamId === "hcf")).toMatchObject({ attemptedPasses: 3, completedPasses: 3, completionPercent: 100 });
  });

  it("lets a claim state a possession spell's duration only with all of its evidence", () => {
    const c = extractMatchContext(sampleFixture, 9_400);
    const spell = c.measurements.possessionSpells.find((s) => s.teamId === "hcf")!;
    const r = goalExplanation();
    r.interpretation = [];
    r.facts = [{ text: `Hartwell kept possession for ${spell.durationMs / 1000} s.`, evidence: spell.cite }];
    expect(checkGrounding(r, c, "analyst").filter((i) => i.includes("duration"))).toEqual([]);
    r.facts[0]!.evidence = [spell.cite[0]!, { kind: "event", id: "e5-shot" }];
    expect(checkGrounding(r, c, "analyst")).toContainEqual(expect.stringContaining("duration 6.3 s"));
  });
});
