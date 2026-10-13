import { describe, expect, it } from "vitest";
import { EvidenceSession } from "@/explain/evidence";
import { buildFactCatalog, checkFactsFromCatalog, latestEvents } from "@/explain/factCatalog";
import { checkGrounding } from "@/explain/grounding";
import { validateExplanation } from "@/explain/response";
import { goalExplanation } from "./support/fakeModel";
import { EVAL_SCENARIOS, scenarioById } from "./support/scenarios";
import { ADVERSARIAL_SCENARIOS, INJECTION_CANARY } from "./support/adversarial";

const contextOf = (id: string) => {
  const s = scenarioById(id);
  return { s, context: new EvidenceSession(s.fixture, s.timeMs, s.focus).base };
};

describe("verified facts", () => {
  it.each(EVAL_SCENARIOS)("$id: every fact passes the answer checks on its own and cites only evidence up to the selected time", (s) => {
    const context = new EvidenceSession(s.fixture, s.timeMs, s.focus).base;
    const catalog = buildFactCatalog(context, s.focus);
    const later = new Set(s.fixture.events.filter((e) => e.t > s.timeMs).map((e) => e.id));
    for (const f of catalog) {
      const probe = { ...goalExplanation(), matchId: context.match.matchId, timeMs: context.time.selectedMs, explanation: f.text, headline: "Fact", facts: [{ text: f.text, evidence: f.evidence }], interpretation: [], limitations: [] };
      expect(validateExplanation(probe, context).ok, f.text).toBe(true);
      expect(checkGrounding(probe, context, "casual", s.focus), f.text).toEqual([]);
      for (const r of f.evidence) if (r.kind === "event") expect(later.has(r.id), f.text).toBe(false);
    }
    // A moment's latest events each have a fact the answer must include.
    if (s.focus === "moment") for (const e of latestEvents(context))
      if (catalog.some((f) => f.evidence.some((r) => r.kind === "event" && r.id === e.id))) expect(catalog.some((f) => f.latest)).toBe(true);
  });

  it("states the goal interval exactly, separately from the shot interval", () => {
    const texts = buildFactCatalog(contextOf("demo-goal-recorded").context).map((f) => f.text);
    expect(texts).toContain("The shot came 6.4 s after Harbor City FC won the ball, with 3 completed passes in between.");
    expect(texts).toContain("The goal came 7.0 s after Harbor City FC won the ball, with 3 completed passes in between.");
  });

  it("does not reveal a shot's result before it is recorded, and marks both events at the same instant as latest", () => {
    const before = buildFactCatalog(contextOf("demo-goal-before").context);
    expect(before.find((f) => f.latest)?.text).toMatch(/its result is not yet known/);
    expect(before.map((f) => f.text).join(" ")).not.toMatch(/scored|1–0/);
    const offside = buildFactCatalog(contextOf("seed6-offside-recorded").context).filter((f) => f.latest).map((f) => f.text);
    expect(offside).toEqual([expect.stringMatching(/missed the target/), expect.stringMatching(/flagged offside/)]);
  });

  it.each(ADVERSARIAL_SCENARIOS)("$id: is built from structured fields, never from event descriptions", (s) => {
    const context = new EvidenceSession(s.fixture, s.timeMs, s.focus).base;
    expect(JSON.stringify(buildFactCatalog(context, s.focus))).not.toContain(INJECTION_CANARY);
  });

  it("requires every fact to be copied exactly, and the latest event's fact to be included", () => {
    const { context } = contextOf("demo-goal-recorded");
    const catalog = buildFactCatalog(context);
    const latest = catalog.find((f) => f.latest)!;
    const other = catalog.find((f) => !f.latest)!;
    const facts = (...fs: { text: string; evidence: typeof latest.evidence }[]) => ({ status: "explained", facts: fs });
    expect(checkFactsFromCatalog(facts(latest, other), catalog)).toEqual([]);
    // Spacing, a final full stop and dash style may differ.
    expect(checkFactsFromCatalog(facts({ ...latest, text: `  ${latest.text.replace("–", "-").slice(0, -1)} ` }), catalog)).toEqual([]);
    expect(checkFactsFromCatalog(facts({ ...latest, text: latest.text.replace("9.4", "9.5") }), catalog)).toEqual([
      expect.stringMatching(/^facts\[0\] is not one of verifiedFacts/), expect.stringMatching(/must include the verified fact about the latest/)]);
    expect(checkFactsFromCatalog(facts({ ...latest, evidence: [...latest.evidence, { kind: "event", id: "e5-shot" }] }), catalog)[0]).toMatch(/^facts\[0\]/);
    expect(checkFactsFromCatalog(facts(other), catalog)).toEqual([expect.stringMatching(/must include the verified fact about the latest/)]);
    expect(checkFactsFromCatalog({ status: "insufficient-evidence", facts: [] }, catalog)).toEqual([]);
  });
});

describe("internal identifiers in text", () => {
  it("are rejected in every field, but ordinary words are not", () => {
    const { context } = contextOf("demo-goal-recorded");
    const draft = goalExplanation();
    expect(checkGrounding(draft, context, "casual")).toEqual([]);
    const player = context.players[0]!;
    draft.explanation = `${player.name} (${player.id}) was involved.`;
    expect(checkGrounding(draft, context, "casual")).toContainEqual(expect.stringContaining(`internal identifier ${player.id}`));
    draft.explanation = "The goal (e6-goal) was recorded.";
    expect(checkGrounding(draft, context, "analyst")).toContainEqual(expect.stringContaining("internal identifier e6-goal"));
  });
});
