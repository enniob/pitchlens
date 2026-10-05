import { describe, expect, it } from "vitest";
import { extractMatchContext } from "@/explain/context";
import { AUDIENCE_LIMITS, checkGrounding } from "@/explain/grounding";
import type { ExplanationResponse } from "@/explain/response";
import { sampleFixture } from "@/match/fixture";
import { goalExplanation } from "./support/fakeModel";

const atGoal = extractMatchContext(sampleFixture, 9_400);
const beforeGoal = extractMatchContext(sampleFixture, 9_050);

const edit = (change: (r: ExplanationResponse) => void, base = goalExplanation()) => {
  change(base);
  return base;
};
const issues = (r: ExplanationResponse, context = atGoal, audience: "casual" | "analyst" = "analyst") => checkGrounding(r, context, audience);

describe("grounding checks", () => {
  it("accept the documented example", () => {
    expect(issues(goalExplanation())).toEqual([]);
    expect(issues(goalExplanation(), atGoal, "casual")).toEqual([]);
  });

  it("reject a time after the selected moment", () => {
    expect(issues(edit((r) => (r.explanation += " Play restarted at 19.5 s.")))).toEqual([expect.stringContaining("19.5 s")]);
    expect(issues(edit((r) => (r.facts[0]!.text = "Harbor City #6 won the ball at 12000 ms.")))[0]).toContain("12000 ms");
    expect(issues(edit((r) => (r.headline = "A goal in the 3rd minute")))[0]).toContain("minute");
    // Rounded to a tenth of a second is fine.
    expect(issues(edit((r) => (r.facts[1]!.text = "#9 shot at 8.8 s and the ball crossed the line at 9.4 s.")))).toEqual([]);
  });

  it("reject a score other than the current one, but not a formation", () => {
    expect(issues(edit((r) => (r.explanation = "That makes it 2–0.")))[0]).toContain("2–0");
    expect(issues(edit((r) => (r.explanation = "It is 0-1 now from the away side's view.")))).toEqual([]);
    expect(issues(edit((r) => (r.interpretation[0]!.text = "A 4-3-3 left little time to defend the move.")))).toEqual([]);
    expect(issues(edit((r) => (r.interpretation[0]!.text = "Their 4-4-2 and 4-2-3-1 shapes are irrelevant here.")))).toEqual([]);
  });

  it("reject players who are not in the roster or not in a claim's cited evidence", () => {
    expect(issues(edit((r) => (r.explanation += " #42 watched.")))[0]).toContain("#42");
    expect(issues(edit((r) => (r.facts[0]!.text = "#9 won the ball at 2.4 s.")))[0]).toContain("#9");
    expect(issues(edit((r) => (r.facts[0]!.text = "Castell won the ball at 2.4 s.")))[0]).toContain("Castell");
    // A snapshot shows every player.
    expect(issues(edit((r) => (r.facts[2]!.text = "The score is 1–0 with Castell inside the area.")))).toEqual([]);
  });

  it("reject events the evidence does not contain", () => {
    const pending: ExplanationResponse = {
      explanationVersion: "1.0.0",
      matchId: sampleFixture.matchId,
      timeMs: 9_050,
      status: "explained",
      headline: "Castell shoots",
      explanation: "Harbor City's number 9 has just shot; the result is not known yet.",
      facts: [{ text: "#9 shot at 8.8 s.", evidence: [{ kind: "event", id: "e5-shot" }] }],
      interpretation: [],
      limitations: [],
    };
    expect(issues(pending, beforeGoal)).toEqual([]);
    expect(issues(edit((r) => (r.headline = "Castell scores"), structuredClone(pending)), beforeGoal)[0]).toContain("scores");
    expect(issues(edit((r) => (r.facts[0]!.text = "#9 shot at 8.8 s and the keeper saved it."), structuredClone(pending)), beforeGoal)[0]).toContain("saved");
    expect(issues(edit((r) => (r.facts[0]!.text = "#9 was flagged offside at 8.8 s."), structuredClone(pending)), beforeGoal)[0]).toContain("offside");
    expect(issues(edit((r) => (r.facts[0]!.text = "#9 shot from a corner at 8.8 s."), structuredClone(pending)), beforeGoal)[0]).toContain("corner");
    // Ordinary football words are not events.
    expect(issues(edit((r) => (r.facts[0]!.text = "#9 shot on goal from the corner of the box at 8.8 s."), structuredClone(pending)), beforeGoal)).toEqual([]);
    expect(issues(edit((r) => (r.facts[0]!.text = "#9 shot from inside the penalty area at 8.8 s."), structuredClone(pending)), beforeGoal)).toEqual([]);
    // A claim about a goal must cite it.
    expect(issues(edit((r) => (r.facts[0]!.text = "Harbor City #6 won the ball at 2.4 s before they scored.")))[0]).toContain("scored");
  });

  it("allow a goal outside the evidence window when the score shows it", () => {
    const later = extractMatchContext(sampleFixture, 22_000);
    expect(later.events.some((e) => e.type === "goal")).toBe(false);
    const r: ExplanationResponse = {
      explanationVersion: "1.0.0",
      matchId: sampleFixture.matchId,
      timeMs: 22_000,
      status: "explained",
      headline: "Play restarts after Harbor City scored",
      explanation: "Harbor City lead 1–0 and Northvale have restarted.",
      facts: [{ text: "Northvale kicked off after Harbor City scored.", evidence: [{ kind: "event", id: "e7-kickoff" }] }],
      interpretation: [],
      limitations: [],
    };
    expect(issues(r, later)).toEqual([]);
  });

  it("apply the audience limits", () => {
    const long = edit((r) => (r.explanation = "Harbor City won the ball. ".repeat(30).trim()));
    expect(long.explanation.length).toBeGreaterThan(AUDIENCE_LIMITS.casual.explanation);
    expect(issues(long, atGoal, "analyst")).toEqual([]);
    expect(issues(long, atGoal, "casual")[0]).toContain("casual");
    const many = edit((r) => (r.facts = Array.from({ length: 5 }, () => ({ text: "The score is 1–0.", evidence: [{ kind: "snapshot" as const, t: 9_400 }] }))));
    expect(issues(many, atGoal, "casual")).toEqual([expect.stringContaining("more than 4 facts")]);
  });
});
