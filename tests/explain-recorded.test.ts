import { buildFactCatalog } from "@/explain/factCatalog";
import { describe, expect, it } from "vitest";
import { extractMatchContext } from "@/explain/context";
import { recordedSummary } from "@/explain/recorded";
import { checkGrounding } from "@/explain/grounding";
import { validateExplanation } from "@/explain/response";
import { generateMatch } from "@/simulation/generate";
import { evidenceMessage } from "@/explain/prompts";

describe("recorded match summary", () => {
  it.each([
    ["4-4-2", 48_360, "Goal recorded"],
    ["4-3-3", 29_940, "Blocked effort"],
  ] as const)("provides checked facts for the reported seed 12 match with away %s", (formation, time, headline) => {
    const fixture = generateMatch({ seed: 12, durationMs: 60_000,
      tactics: { home: { formation: "4-3-3" }, away: { formation } } });
    const context = extractMatchContext(fixture, time);
    const summary = recordedSummary(context)!;
    expect(summary).not.toBeNull();
    expect(summary.headline).toBe(headline);
    expect(summary.facts.length).toBeGreaterThan(1);
    expect(summary.interpretation).toEqual([]);
    expect(validateExplanation(summary, context).ok).toBe(true);
    expect(checkGrounding(summary, context, "casual")).toEqual([]);
    expect(checkGrounding(summary, context, "analyst")).toEqual([]);
    // The model gets the verified facts; the latest one describes the same event as the recorded account.
    const catalog = buildFactCatalog(context);
    expect(evidenceMessage(context, "moment", catalog)).toContain(`"verifiedFacts":${JSON.stringify(catalog)}`);
    expect(catalog.find((f) => f.latest)?.evidence).toEqual(expect.arrayContaining(summary.facts[0]!.evidence));
    for (const event of fixture.events.filter(e => e.t > time))
      expect(evidenceMessage(context)).not.toContain(`"id":"${event.id}"`);
    for (const claim of summary.facts) for (const ref of claim.evidence) {
      expect(ref.kind).toBe("event");
      expect(context.events.find(e => e.id === (ref as { id: string }).id)!.t).toBeLessThanOrEqual(time);
    }
  });

  it("provides facts for every supported generated event without using unrevealed outcomes", () => {
    const fixture = generateMatch({ seed: 12, durationMs: 60_000 });
    for (const event of fixture.events) {
      const context = extractMatchContext(fixture, event.t);
      const summary = recordedSummary(context);
      expect(summary, `${event.type} ${event.id}`).not.toBeNull();
      expect(checkGrounding(summary!, context, "casual")).toEqual([]);
      if (event.type === "shot") {
        expect(summary!.headline).toBe("Shot recorded");
        expect(summary!.explanation).not.toMatch(/scored|saved|blocked|missed/);
      }
    }
  });

  it("does not invent an account without an eligible event or after backward seeking", () => {
    const fixture = generateMatch({ seed: 12, durationMs: 60_000 });
    const context = extractMatchContext(fixture, 48_360);
    expect(recordedSummary({ ...context, events: [] })).toBeNull();
    expect(recordedSummary({ ...context, time: { ...context.time, selectedMs: 0 } })).toBeNull();
    const latest = context.events.at(-1)!;
    expect(recordedSummary({ ...context, events: [{ ...latest, type: "shot-result", outcome: "pending" }] })).toBeNull();
  });
});
