import { describe, expect, it } from "vitest";
import { extractMatchContext } from "@/explain/context";
import { EvidenceSession, EVIDENCE_TOOLS, EVENT_TYPES, TOOL_LOOKBACK_MS } from "@/explain/evidence";
import { validateExplanation, type ExplanationResponse } from "@/explain/response";
import type { MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import { eventsAt } from "@/playback/derive";
import { generateMatch, type TacticsConfig } from "@/simulation/generate";

const TACTICS: TacticsConfig = { away: { formation: "4-3-3", changes: [{ t: 30_000, formation: "4-2-3-1" }] } };
// Seed 2 has an offside, 9 a goal, 0 a shot whose result arrives later (see explain-context tests).
const matches = [sampleFixture, ...[2, 9, 0].map((seed) => generateMatch({ seed, durationMs: 60_000, tactics: TACTICS }))];

const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
};

describe("evidence session", () => {
  it("starts from the default evidence package", () => {
    const session = new EvidenceSession(sampleFixture, 9_050);
    expect(session.base).toEqual(extractMatchContext(sampleFixture, 9_050));
    expect(session.context()).toEqual(session.base);
  });

  it("describes both tools and every event type", () => {
    expect(EVIDENCE_TOOLS.map((t) => t.function.name)).toEqual(["list_events", "get_positions"]);
    expect(EVENT_TYPES).toContain("formation-change");
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it("never returns anything after the selected time, at every event time and 1 ms before", () => {
    for (const fixture of matches) {
      const times = [...new Set(fixture.events.flatMap((e) => [e.t - 1, e.t]))].filter((t) => t >= 0 && t <= fixture.durationMs);
      for (const t of times) {
        const session = new EvidenceSession(fixture, t);
        const revealed = new Set(eventsAt(fixture, t).map((e) => e.id));
        const listed = ok(session.call("list_events", "{}"));
        for (const id of listed.events) expect(revealed.has(id), `${fixture.matchId} @${t}: ${id}`).toBe(true);
        const positions = ok(session.call("get_positions", JSON.stringify({ atMs: t })));
        expect(positions.snapshots[0]).toBeLessThanOrEqual(t);
        const earliest = ok(session.call("get_positions", JSON.stringify({ atMs: session.floorMs })));
        expect(earliest.snapshots[0]).toBeLessThanOrEqual(t);
        const context = session.context();
        expect(context.events.every((e) => e.t <= t && revealed.has(e.id))).toBe(true);
        expect(context.snapshots.every((s) => s.t <= t)).toBe(true);
        expect(context.snapshots.at(-1)!.t).toBe(context.time.positionsAtMs);
      }
    }
  });

  it("keeps an unresolved shot pending in tool results", () => {
    const session = new EvidenceSession(sampleFixture, 9_050);
    const listed = ok(session.call("list_events", JSON.stringify({ types: ["shot", "goal"] })));
    const content = listed.content as { events: { id: string; outcome: string; end?: unknown }[] };
    expect(content.events.map((e) => e.id)).toEqual(["e5-shot"]);
    expect(content.events[0]!.outcome).toBe("pending");
    expect(content.events[0]!.end).toBeUndefined();
    expect(JSON.stringify(listed.content)).not.toContain("e6-goal");
  });

  it("refuses times after the cutoff or before the lookback limit", () => {
    const fixture = matches[1]!;
    const session = new EvidenceSession(fixture, 45_000);
    expect(session.floorMs).toBe(45_000 - TOOL_LOOKBACK_MS);
    expect(session.call("get_positions", JSON.stringify({ atMs: 45_001 }))).toMatchObject({ ok: false, error: expect.stringContaining("after the selected time") });
    expect(session.call("get_positions", JSON.stringify({ atMs: 14_999 }))).toMatchObject({ ok: false, error: expect.stringContaining("earlier than") });
    expect(session.call("list_events", JSON.stringify({ fromMs: 45_100 }))).toMatchObject({ ok: false });
    expect(session.call("list_events", JSON.stringify({ fromMs: 0 }))).toMatchObject({ ok: false });
    expect(session.context()).toEqual(session.base);
  });

  it("rejects malformed calls without throwing", () => {
    const session = new EvidenceSession(sampleFixture, 9_050);
    for (const [name, args] of [
      ["get_positions", "{"],
      ["get_positions", "[]"],
      ["get_positions", '{"atMs": 9000.5}'],
      ["get_positions", '{"atMs": "9000"}'],
      ["get_positions", '{"atMs": 9000, "full": true}'],
      ["get_positions", ""],
      ["list_events", '{"types": []}'],
      ["list_events", '{"types": ["teleport"]}'],
      ["list_events", '{"limit": 99}'],
      ["run_simulation", "{}"],
      ["read_fixture", "{}"],
    ] as const)
      expect(session.call(name, args).ok, `${name} ${args}`).toBe(false);
  });

  it("lets an explanation cite older evidence only after a tool returned it", () => {
    const fixture = matches[1]!;
    const t = 50_000;
    const session = new EvidenceSession(fixture, t);
    const older = eventsAt(fixture, t).filter((e) => e.t >= session.floorMs && e.t < session.base.time.windowStartMs).at(-1)!;
    expect(older).toBeDefined();
    const response = (): ExplanationResponse => ({
      explanationVersion: "1.0.0",
      matchId: fixture.matchId,
      timeMs: t,
      status: "explained",
      headline: "Earlier play",
      explanation: "An earlier event.",
      facts: [{ text: "An earlier event happened.", evidence: [{ kind: "event", id: older.id }] }],
      interpretation: [],
      limitations: [],
    });
    expect(validateExplanation(response(), session.context()).ok).toBe(false);
    ok(session.call("list_events", "{}"));
    expect(validateExplanation(response(), session.context()).ok).toBe(true);

    const earlySnapshot = ok(session.call("get_positions", JSON.stringify({ atMs: session.floorMs + 1_234 }))).snapshots[0]!;
    const withSnapshot = response();
    withSnapshot.facts[0]!.evidence = [{ kind: "snapshot", t: earlySnapshot }];
    expect(validateExplanation(withSnapshot, session.context()).ok).toBe(true);
    // Events stay in time order once merged.
    const ts = session.context().events.map((e) => e.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("does not modify the fixture", () => {
    const fixture = matches[2]!;
    const before = JSON.stringify(fixture);
    const session = new EvidenceSession(fixture, 30_000);
    session.call("list_events", "{}");
    session.call("get_positions", '{"atMs": 20000}');
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it("throws for a time outside the match, like the extractor", () => {
    expect(() => new EvidenceSession(sampleFixture as MatchFixture, -1)).toThrow(RangeError);
    expect(() => new EvidenceSession(sampleFixture, sampleFixture.durationMs + 1)).toThrow(RangeError);
  });
});
