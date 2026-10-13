import { describe, expect, it } from "vitest";
import { extractMatchContext } from "@/explain/context";
import { checkGrounding } from "@/explain/grounding";
import type { ExplanationResponse } from "@/explain/response";
import { EvidenceSession } from "@/explain/evidence";
import { explainMoment } from "@/server/analyst";
import { generateMatch } from "@/simulation/generate";
import { recordedAccount, recordedMatchSummary } from "@/explain/recorded";
import { answer, approve, FakeModel } from "./support/fakeModel";

const fixture = generateMatch({ seed: 12, durationMs: 60_000,
  tactics: { home: { formation: "4-3-3" }, away: { formation: "4-4-2" } } });
const timeMs = 48_360;
const context = extractMatchContext(fixture, timeMs);
const good = (): ExplanationResponse => ({
  explanationVersion: "1.0.0", matchId: fixture.matchId, timeMs, status: "explained",
  headline: "Castell scores after a free kick and two passes",
  explanation: "Harbor City took a free kick and completed two passes before Castell shot and scored. The goal made the score 1–0.",
  facts: [
    { text: "Harbor City took a free kick and completed two passes before Castell shot and scored.",
      evidence: ["sim-18", "sim-19", "sim-20", "sim-21", "sim-22"].map(id => ({ kind: "event", id })) },
    { text: "The foul was recorded at 38.5 s and the goal at 48.4 s.",
      evidence: [{ kind: "event", id: "sim-17" }, { kind: "event", id: "sim-22" }] },
  ], interpretation: [], limitations: [],
});

describe("seed 12 goal grounding", () => {
  it("reproduces the reported match and rejects the reported unsupported penalty and timing claims", () => {
    expect(fixture.matchId).toBe("sim-v5-12-60000-197b5a1c");
    expect(context.events.some(e => e.type === "penalty")).toBe(false);
    const draft = good();
    draft.headline = "Castell scores a penalty";
    draft.facts[1] = { text: "The sequence took 10 s.", evidence: [{ kind: "event", id: "sim-22" }] };
    const issues = checkGrounding(draft, context, "casual");
    expect(issues).toContainEqual(expect.stringContaining('headline says "penalty"'));
    expect(issues).toContainEqual(expect.stringContaining("not supported by two cited time endpoints"));
    draft.facts[1]!.text = "The foul was recorded at 38.36 s.";
    expect(checkGrounding(draft, context, "casual")).toContainEqual(expect.stringContaining("matches nothing it cites"));
    expect(checkGrounding(good(), context, "casual")).toEqual([]);
  });

  it.each(["penalty-area", "penalty area", "penalty areas", "penalty-box", "penalty box", "penalty boxes", "penalty-spot", "penalty spot", "penalty spots"])("does not mistake %s geography for an awarded penalty", label => {
    const draft = good();
    draft.headline = `Castell scores from a ${label} shot`;
    expect(checkGrounding(draft, context, "casual")).not.toContainEqual(expect.stringContaining("contains no penalty"));
    draft.headline = "Castell scores a penalty kick";
    expect(checkGrounding(draft, context, "casual")).toContainEqual(expect.stringContaining("contains no penalty"));
  });

  it("sends focused correction instructions and still checks a scripted revision and its citations", async () => {
    const bad = good();
    bad.headline = "Castell scores a penalty";
    bad.facts[1] = { text: "The sequence took 10 s.", evidence: [{ kind: "event", id: "sim-22" }] };
    const corrected = good();
    const model = new FakeModel([answer(bad), answer(corrected), approve(corrected)]);
    const result = await explainMoment({ fixture, timeMs, audience: "casual", client: model });
    expect(result.verification).toMatchObject({ outcome: "revised", grounding: "passed", modelReview: "passed" });
    const correction = model.requests[1]!.messages.at(-1)!.content;
    expect(correction).toContain("Correct every listed problem, including the headline");
    expect(correction).toContain("Never turn a disputed duration into a computed timestamp");
    expect(model.requests[0]!.messages[0]!.content).toContain("A shot inside the penalty area is not a penalty kick");
    expect(model.requests[0]!.messages[0]!.content).toContain("evidence-window boundaries, not event timestamps");
    for (const event of fixture.events.filter(e => e.t > timeMs))
      for (const request of model.requests)
        for (const message of request.messages)
          expect(message.content ?? "").not.toContain(`"id":"${event.id}"`);
  });
});

describe("seed 12 both teams 4-3-3 at 29.94 seconds", () => {
  const match = generateMatch({ seed: 12, durationMs: 60_000,
    tactics: { home: { formation: "4-3-3" }, away: { formation: "4-3-3" } } });
  const atMs = 29_940;
  const evidence = extractMatchContext(match, atMs);

  it("reports length and shot-citation failures together before using the one revision", async () => {
    expect(match.matchId).toBe("sim-v5-12-60000-2dd241ec");
    const shot = evidence.events.find(e => e.id === "sim-11")!;
    const outcome = evidence.events.find(e => (e.type === "goal" || e.type === "shot-result") &&
      e.startT === shot.t && e.playerId === shot.playerId)!;
    expect(shot.type).toBe("shot");
    expect(outcome.startT).toBe(shot.t);
    expect(outcome.playerId).toBe(shot.playerId);
    const corrected: ExplanationResponse = {
      explanationVersion: "1.0.0", matchId: match.matchId, timeMs: atMs, status: "explained",
      headline: "A shot and its recorded result",
      explanation: "A shot and its result were recorded.",
      facts: [{ text: "The shot and its result were recorded.",
        evidence: [{ kind: "event", id: shot.id }, { kind: "event", id: outcome.id }] }],
      interpretation: [], limitations: [],
    };
    const bad = structuredClone(corrected);
    bad.headline = "x".repeat(101);
    bad.facts[0]!.evidence = [{ kind: "event", id: outcome.id }];
    const model = new FakeModel([answer(bad), answer(corrected), approve(corrected)]);
    const result = await explainMoment({ fixture: match, timeMs: atMs, audience: "casual", client: model });
    expect(result.verification.outcome).toBe("revised");
    const correction = model.requests[1]!.messages.at(-1)!.content;
    expect(correction).toContain("headline is longer than 100 characters");
    expect(correction).toContain("also cite the shot event sim-11");
    // The citation hint comes before the contract error, so a long list of problems cannot cut it.
    expect(correction!.indexOf("also cite the shot event sim-11")).toBeLessThan(correction!.indexOf("headline is longer"));
    expect(model.requests.map(r => r.role)).toEqual(["analyst", "analyst", "verifier"]);

    const persistent = new FakeModel([answer(bad), answer(bad)]);
    const rejected = await explainMoment({ fixture: match, timeMs: atMs, audience: "casual", client: persistent });
    expect(rejected.verification).toMatchObject({ outcome: "fallback", schema: "failed", modelReview: "skipped" });
    expect(persistent.requests.every(r => r.role === "analyst")).toBe(true);
    // The fallback carries the recorded account built from the same evidence the analyst was given.
    expect(rejected.recordedSummary).toEqual(recordedAccount(evidence));
    expect(rejected.recordedSummary?.headline).toBe("Blocked effort");
  });
});

describe("seed 12 both teams 4-3-3 full-time summary", () => {
  const match = generateMatch({ seed: 12, durationMs: 60_000,
    tactics: { home: { formation: "4-3-3" }, away: { formation: "4-3-3" } } });
  const end = match.durationMs;
  const session = new EvidenceSession(match, end, "match");

  it("returns the recorded full-time account when the model's score fact is rejected", async () => {
    const summary = recordedMatchSummary(session.base)!;
    expect(summary).not.toBeNull();
    expect(summary.headline).toMatch(/^Full time: .+ 0–0 .+$/);
    expect(summary.facts.every(f => f.evidence.length === 1)).toBe(true);
    expect(checkGrounding(summary, session.base, "analyst", "match")).toEqual([]);

    const shot = session.base.events.find(e => e.type === "shot")!;
    const noFacts = { ...summary, facts: [] };
    const scoreFact = { ...summary, facts: [...summary.facts, { text: "The score is 0–0.", evidence: [{ kind: "event" as const, id: shot.id }] }] };
    const unsupported = (draft: ExplanationResponse) => answer({ reviews: [
      "headline", "explanation", ...draft.facts.map((_, i) => `facts[${i}]`)].map(target => ({
      target, verdict: target === `facts[${draft.facts.length - 1}]` ? "unsupported" : "supported",
      reason: target === `facts[${draft.facts.length - 1}]` ? "A shot does not show the score." : "" })) });
    const model = new FakeModel([answer(noFacts), answer(scoreFact), unsupported(scoreFact)]);
    const result = await explainMoment({ fixture: match, timeMs: end, audience: "casual", focus: "match", client: model });
    expect(result.verification).toMatchObject({ outcome: "fallback", modelReview: "failed" });
    expect(result.recordedSummary).toEqual(summary);

    const analyst = model.requests[0]!.messages;
    expect(analyst[0]!.content).toContain("a 0–0 score has no goal event to cite, so never put it in a fact");
    expect(analyst[1]!.content).toContain('"recordedAccount":{');
    expect(model.requests[2]!.messages[0]!.content).toContain("citing shots or other events does not show a score");
  });
});
