import { describe, expect, it } from "vitest";
import { EvidenceSession } from "@/explain/evidence";
import { checkGrounding } from "@/explain/grounding";
import { pruneRejectedClaims } from "@/explain/prune";
import type { ExplanationResponse } from "@/explain/response";
import { goalExplanation } from "./support/fakeModel";
import { scenarioById } from "./support/scenarios";

describe("removing rejected claims", () => {
  const draft = (): ExplanationResponse => {
    const d = goalExplanation();
    d.facts.push({ text: "The turnover came 3.3 s after the kickoff.", evidence: [{ kind: "event", id: "e1-turnover" }] });
    return d;
  };

  it("removes only the claims every problem names", () => {
    const d = draft();
    const out = pruneRejectedClaims(d, ["facts[3] gives the duration 3.3 s", "interpretation[0] is not supported", "limitations[0] says x"]);
    expect(out?.response).toEqual({ ...d, facts: d.facts.slice(0, 3), interpretation: d.interpretation.slice(1), limitations: d.limitations.slice(1) });
    expect(out?.removed).toEqual(["facts[3]", "interpretation[0]", "limitations[0]"]);
  });

  it("refuses when a problem concerns the headline, explanation or answer as a whole", () => {
    for (const issue of ["headline mentions 2–0", "explanation is not supported", "more than 4 facts for the casual audience", "an explained response needs at least one fact"])
      expect(pruneRejectedClaims(draft(), ["facts[3] gives the duration 3.3 s", issue]), issue).toBeNull();
  });

  it("refuses when no fact would remain, or for an insufficient-evidence answer", () => {
    const d = draft();
    expect(pruneRejectedClaims(d, d.facts.map((_, i) => `facts[${i}] is not supported`))).toBeNull();
    expect(pruneRejectedClaims({ ...d, status: "insufficient-evidence" }, ["facts[3] is not supported"])).toBeNull();
  });

  it("refuses when the summary repeats a number only the removed claim gives", () => {
    const d = draft();
    d.explanation = `${d.explanation} The turnover came 3.3 s after the kickoff.`;
    expect(pruneRejectedClaims(d, ["facts[3] gives the duration 3.3 s"])).toBeNull();
  });
});

describe("negated event wording", () => {
  const s = scenarioById("demo-goal-recorded");
  const context = new EvidenceSession(s.fixture, s.timeMs, s.focus).context();
  const claim = (text: string): ExplanationResponse => ({ ...goalExplanation(), facts: [{ text, evidence: [{ kind: "event", id: "e2-pass" }] }], interpretation: [], limitations: [] });

  it("does not read 'no shot' as a shot, but still rejects an unsupported one", () => {
    expect(checkGrounding(claim("S. Okafor passed to a teammate, with no shot yet."), context, "analyst")).not.toContainEqual(expect.stringContaining("contains no shot"));
    expect(checkGrounding(claim("S. Okafor passed to a teammate without a shot."), context, "analyst")).not.toContainEqual(expect.stringContaining("contains no shot"));
    expect(checkGrounding(claim("S. Okafor passed to a teammate, then took a shot."), context, "analyst")).toContainEqual(expect.stringContaining("contains no shot"));
  });
});

describe("removing a rejected score claim", () => {
  it("is not blocked by the summary stating the score, which grounding checks separately", () => {
    const d = goalExplanation();
    d.facts.push({ text: "The score is 1–0.", evidence: [{ kind: "event", id: "e5-shot" }] });
    expect(pruneRejectedClaims(d, ["facts[3] is not one of verifiedFacts"])?.removed).toEqual(["facts[3]"]);
  });
});
