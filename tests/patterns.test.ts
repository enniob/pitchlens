import { describe, expect, it } from "vitest";
import type { MatchEvent } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import { contextSize, extractMatchContext } from "@/explain/context";
import { measureEvents } from "@/playback/patterns";

const teams = [{ id: "a", attacksTowards: "increasing-x" as const }, { id: "b", attacksTowards: "decreasing-x" as const }];
function event(id: string, t: number, type: MatchEvent["type"], teamId = "a"): MatchEvent {
  return { id, t, type, teamId, outcome: type === "turnover" ? "won" : type === "pass" ? "complete" : "pending", description: id,
    start: { x: teamId === "a" ? 70 : 35, y: 10, z: 0 }, playerId: `${teamId}1` };
}
const chain = [event("win", 1_001, "turnover"), event("pass1", 2_010, "pass"), event("pass2", 3_110, "pass"), event("shot", 4_567, "shot")];

describe("cutoff-bound measured patterns", () => {
  it("records the exact turnover duration and complete ordered chain without shot outcome", () => {
    const p = measureEvents(chain, teams, 4_567, 0).patterns.find((x) => x.kind === "turnover-to-shot")!;
    expect(p.values).toEqual({ elapsedMs: 3_566, completedPasses: 2 });
    expect(p.eventIds).toEqual(["win", "pass1", "pass2", "shot"]);
    expect(p.summary).toBe("Shot 3.566 s after a turnover won, with 2 completed passes.");
    expect(JSON.stringify(p)).not.toMatch(/goal|scored|on-target/);
  });

  it("withholds a later shot and restores exact earlier state after backward seeking", () => {
    const earlier = measureEvents(chain, teams, 4_566, 0);
    expect(earlier.patterns.some((p) => p.kind === "turnover-to-shot")).toBe(false);
    expect(JSON.stringify(earlier)).not.toContain('"shot"');
    measureEvents(chain, teams, 4_567, 0);
    expect(measureEvents(chain, teams, 4_566, 0)).toEqual(earlier);
  });

  it.each(["foul", "offside", "kickoff", "deflection"] as const)("interrupts a chain on %s", (type) => {
    const interrupted = [...chain.slice(0, 2), event("stop", 2_500, type), ...chain.slice(2)];
    expect(measureEvents(interrupted, teams, 5_000, 0).patterns.some((p) => p.kind === "turnover-to-shot")).toBe(false);
  });

  it("interrupts a chain on an opponent's action or an incomplete pass", () => {
    const opponent = [...chain.slice(0, 2), event("other", 2_500, "pass", "b"), ...chain.slice(2)];
    expect(measureEvents(opponent, teams, 5_000, 0).patterns.some((p) => p.kind === "turnover-to-shot")).toBe(false);
    const incomplete = chain.map((e) => e.id === "pass1" ? { ...e, outcome: "intercepted" as const } : e);
    expect(measureEvents(incomplete, teams, 5_000, 0).patterns.some((p) => p.kind === "turnover-to-shot")).toBe(false);
  });

  it("counts only starts in defined attacking-half outer-thirds for both directions", () => {
    const actions = [event("a1", 1, "pass"), event("a2", 2, "pass"), event("a3", 3, "shot"),
      event("b1", 1, "pass", "b"), event("b2", 2, "pass", "b"), event("b3", 3, "shot", "b")];
    const flank = measureEvents(actions, teams, 100, 0).patterns.filter((p) => p.kind === "repeated-flank");
    expect(flank.map((p) => p.values.actions)).toEqual([3, 3]);
    const central = actions.map((e) => ({ ...e, start: { ...e.start!, y: 68 / 3 } }));
    expect(measureEvents(central, teams, 100, 0).patterns.filter((p) => p.kind === "repeated-flank")).toEqual([]);
    const defensive = actions.map((e) => ({ ...e, start: { ...e.start!, x: e.teamId === "a" ? 52 : 53 } }));
    expect(measureEvents(defensive, teams, 100, 0).patterns.filter((p) => p.kind === "repeated-flank")).toEqual([]);
  });

  it("compares equal adjacent windows without double counting the boundary", () => {
    const actions = [event("excluded", 0, "pass"), event("old", 5_000, "pass"), event("recent1", 5_001, "shot"), event("recent2", 10_000, "pass"), event("future", 10_001, "shot")];
    const p = measureEvents(actions, teams, 10_000, 0).patterns.find((p) => p.kind === "activity-change")!;
    expect(p.values).toMatchObject({ windowMs: 5_000, boundaryMs: 5_000, previousShots: 0, recentShots: 1, previousPasses: 1, recentPasses: 1 });
    expect(p.eventIds).toEqual(["old", "recent1", "recent2"]);
    expect(measureEvents(actions, teams, 9_999, 0).patterns.some((p) => p.kind === "activity-change")).toBe(false);
  });

  it("suppresses patterns for incomplete evidence and labels partial counts", () => {
    const partial = measureEvents(chain, teams, 5_000, 0, false);
    expect(partial.coverage).toBe("retained-events-only");
    expect(partial.patterns).toEqual([]);
    expect(partial.statistics[0]).toMatchObject({ shots: 1, completedPasses: 2, goals: 0 });
  });

  describe("shot locations", () => {
    const shotAt = (id: string, x: number, y: number, teamId = "a", t = 1_000): MatchEvent =>
      ({ ...event(id, t, "shot", teamId), outcome: "scored", start: { x, y, z: 0 }, end: { x: teamId === "a" ? 105 : 0, y: 34, z: 1 } });
    const locate = (events: MatchEvent[], selectedMs = 5_000, fromMs = 0, complete = true) =>
      measureEvents(events, teams, selectedMs, fromMs, complete).shotLocations;

    it("measures distance to each team's attacking goal centre for both directions", () => {
      expect(locate([shotAt("a", 70, 10), shotAt("b", 35, 10, "b")])).toEqual([
        { eventId: "a", distanceToGoalM: 42.4, insidePenaltyArea: false, channel: "top-outer-third" },
        { eventId: "b", distanceToGoalM: 42.4, insidePenaltyArea: false, channel: "top-outer-third" },
      ]);
      // A shot near its own goal is far from the goal it attacks.
      expect(locate([shotAt("own", 5, 34)])[0]).toMatchObject({ distanceToGoalM: 100, insidePenaltyArea: false });
    });

    it("measures a central shot from the penalty spot", () => {
      expect(locate([shotAt("a", 94, 34), shotAt("b", 11, 34, "b")])).toEqual([
        { eventId: "a", distanceToGoalM: 11, insidePenaltyArea: true, channel: "central" },
        { eventId: "b", distanceToGoalM: 11, insidePenaltyArea: true, channel: "central" },
      ]);
    });

    it("includes penalty-area boundaries and excludes points just beyond them", () => {
      const low = 34 - 20.16, high = 34 + 20.16;
      const inside = [shotAt("a-edge", 105 - 16.5, low), shotAt("a-line", 105, high), shotAt("b-edge", 16.5, high, "b"), shotAt("b-line", 0, low, "b")];
      expect(locate(inside).map((s) => s.insidePenaltyArea)).toEqual([true, true, true, true]);
      expect(locate(inside)[0]!.distanceToGoalM).toBe(26.1);
      const outside = [shotAt("a-deep", 88.49, 34), shotAt("a-wide", 100, high + 0.01), shotAt("b-deep", 16.51, 34, "b"), shotAt("b-wide", 5, low - 0.01, "b")];
      expect(locate(outside).map((s) => s.insidePenaltyArea)).toEqual([false, false, false, false]);
    });

    it("assigns third boundaries to the central channel", () => {
      const ys = [68 / 3 - 0.01, 68 / 3, 136 / 3, 136 / 3 + 0.01];
      expect(locate(ys.map((y, i) => shotAt(`s${i}`, 80, y))).map((s) => s.channel))
        .toEqual(["top-outer-third", "central", "central", "bottom-outer-third"]);
    });

    it("excludes future shots and never exposes outcomes or destinations", () => {
      const events = [shotAt("now", 94, 34, "a", 5_000), shotAt("future", 94, 34, "a", 5_001)];
      const result = measureEvents(events, teams, 5_000, 0);
      expect(result.shotLocations.map((s) => s.eventId)).toEqual(["now"]);
      expect(JSON.stringify(result.shotLocations)).not.toMatch(/future|scored|end|outcome/);
      expect(locate(events, 4_999)).toEqual([]);
    });

    it("keeps retained shots in partial windows but skips earlier, unlocated or unknown-team shots", () => {
      const { start: _start, ...noStart } = shotAt("no-start", 94, 34);
      const events = [shotAt("before", 94, 34, "a", 500), noStart as MatchEvent, shotAt("unknown", 94, 34, "z"), shotAt("kept", 94, 34, "b")];
      const partial = measureEvents(events, teams, 5_000, 1_000, false);
      expect(partial.coverage).toBe("retained-events-only");
      expect(partial.patterns).toEqual([]);
      expect(partial.shotLocations).toEqual([{ eventId: "kept", distanceToGoalM: 94, insidePenaltyArea: false, channel: "central" }]);
    });
  });

  it("rebuilds measurements after event truncation and obeys the complete byte budget", () => {
    const full = extractMatchContext(sampleFixture, sampleFixture.durationMs, { windowStartMs: 0, maxEvents: 50 });
    const trimmed = extractMatchContext(sampleFixture, sampleFixture.durationMs, { windowStartMs: 0, maxEvents: 2, maxBytes: 8_000 });
    expect(full.measurements.coverage).toBe("complete-window");
    expect(contextSize(trimmed)).toBeLessThanOrEqual(8_000);
    expect(trimmed.measurements.coverage).toBe("retained-events-only");
    expect(trimmed.measurements.patterns).toEqual([]);
    for (const stat of trimmed.measurements.statistics) for (const id of stat.eventIds) expect(trimmed.events.some((e) => e.id === id)).toBe(true);
    for (const shot of trimmed.measurements.shotLocations) expect(trimmed.events.some((e) => e.id === shot.eventId)).toBe(true);
    expect(full.measurements.shotLocations.length).toBeGreaterThan(0);
  });

  it("never derives model patterns from filtered events or references absent from evidence", () => {
    const filtered = extractMatchContext(sampleFixture, sampleFixture.durationMs, { windowStartMs: 0, eventTypes: ["shot", "goal"] });
    expect(filtered.measurements.coverage).toBe("retained-events-only");
    expect(filtered.measurements.patterns).toEqual([]);
    for (const time of [0, 1_000, 8_000, 16_000, 24_000]) {
      const c = extractMatchContext(sampleFixture, time, { windowStartMs: 0 });
      for (const p of c.measurements.patterns) {
        expect(p.toMs).toBeLessThanOrEqual(time);
        for (const id of p.eventIds) expect(c.events.some((e) => e.id === id && e.t <= time)).toBe(true);
      }
    }
  });
});
