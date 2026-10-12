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
  it("rejects invented left/right zone mappings while allowing measured channels", () => {
    for (const label of ["right side", "left-sided", "right half-space"])
      expect(issues(edit((r) => { r.explanation = `The move reached the ${label} of the penalty area.`; })))
        .toContainEqual(expect.stringContaining("zone label not defined"));
    expect(issues(edit((r) => { r.explanation = "The shot started in the central channel inside the penalty area."; }))).toEqual([]);
  });
  it("requires the shot endpoint even when a sequence claim cites its passes", () => {
    const r = goalExplanation();
    r.facts = [{ text: "Three passes before the shot.", evidence: ["e2-pass", "e3-pass", "e4-pass"].map((id) => ({ kind: "event" as const, id })) }];
    expect(issues(r)).toContainEqual(expect.stringContaining("contains no shot"));
    r.facts[0]!.evidence.push({ kind: "event", id: "e5-shot" });
    expect(issues(r)).toEqual([]);
  });
  it("allows a rounded timestamp only when it matches cited revealed evidence", () => {
    const context = extractMatchContext(sampleFixture, 9_450);
    const r = goalExplanation();
    r.facts = [{ text: "The goal was recorded at 9 s.", evidence: [{ kind: "event", id: "e6-goal" }] }];
    expect(issues(r, context)).toEqual([]);
    r.facts[0]!.text = "The goal was recorded at 10 s.";
    expect(issues(r, context)).toContainEqual(expect.stringContaining("after the selected time"));
    const earlier = extractMatchContext(sampleFixture, 8_800);
    r.headline = "Castell shoots";
    r.explanation = "Castell took a shot.";
    r.interpretation = [];
    r.facts = [{ text: "Castell shot at 9 s.", evidence: [{ kind: "event", id: "e5-shot" }] }];
    expect(issues(r, earlier)).toEqual([]);
    r.facts[0]!.evidence = [{ kind: "event", id: "e4-pass" }];
    expect(issues(r, earlier)).toContainEqual(expect.stringContaining("after the selected time"));
  });
  it("accepts measured activity windows only with all supporting citations", () => {
    const context = extractMatchContext(sampleFixture, 12_000);
    const pattern = context.measurements.patterns.find((p) => p.kind === "activity-change")!;
    expect(pattern).toBeDefined();
    const r = goalExplanation();
    r.facts = [];
    r.interpretation = [{ text: pattern.summary, evidence: pattern.eventIds.map((id) => ({ kind: "event" as const, id })) }];
    expect(issues(r, context)).toEqual([]);
    r.interpretation[0]!.evidence = r.interpretation[0]!.evidence.slice(0, 1);
    expect(issues(r, context)).toContainEqual(expect.stringContaining("duration 5 s"));
  });
  it("requires a claim's timestamps and elapsed durations to match its own citations", () => {
    expect(issues(edit((r) => { r.facts[0]!.text = "The turnover happened at 2 s."; }))).toEqual([]);
    expect(issues(edit((r) => { r.facts[0]!.text = "The turnover happened at 2.8 s."; }))).toContainEqual(expect.stringContaining("matches nothing it cites"));
    const elapsed = edit((r) => { r.interpretation = [{ text: "The move took approximately 7 seconds.", evidence: [{ kind: "event", id: "e1-turnover" }, { kind: "event", id: "e4-pass" }] }]; });
    expect(issues(elapsed)).toContainEqual(expect.stringContaining("two cited time endpoints"));
    elapsed.interpretation[0]!.evidence.push({ kind: "event", id: "e6-goal" });
    expect(issues(elapsed)).toEqual([]);
    elapsed.interpretation[0]!.text = "The move took 5.7 seconds.";
    expect(issues(elapsed)).toEqual([]);
  });
  it("accept the documented example", () => {
    expect(issues(goalExplanation())).toEqual([]);
    expect(issues(goalExplanation(), atGoal, "casual")).toEqual([]);
  });

  it("reject a time after the selected moment", () => {
    expect(issues(edit((r) => (r.explanation = "Play restarts at 0:12.")))).toContainEqual(expect.stringContaining("after the selected time"));
    expect(issues(edit((r) => (r.explanation = "Play restarts in minute 3.")))).toContainEqual(expect.stringContaining("after the selected time"));
    expect(issues(edit((r) => (r.explanation = "The shot was at 0:09.")))).toEqual([]);
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

  it("allow a goal outside the evidence window in the headline and explanation only", () => {
    const later = extractMatchContext(sampleFixture, 22_000);
    expect(later.events.some((e) => e.type === "goal")).toBe(false);
    const r: ExplanationResponse = {
      explanationVersion: "1.0.0",
      matchId: sampleFixture.matchId,
      timeMs: 22_000,
      status: "explained",
      headline: "Play restarts after Harbor City scored",
      explanation: "Harbor City lead 1–0 and Northvale have restarted.",
      facts: [{ text: "Northvale kicked off.", evidence: [{ kind: "event", id: "e7-kickoff" }] }],
      interpretation: [],
      limitations: [],
    };
    expect(issues(r, later)).toEqual([]);
    // A claim cannot lean on the score: the goal it mentions must be cited, and here it cannot be.
    expect(issues(edit((x) => (x.facts[0]!.text = "Northvale kicked off after Harbor City scored."), structuredClone(r)), later)).toEqual([
      expect.stringContaining('facts[0] says "scored"'),
    ]);
    const interpreted = edit((x) => (x.interpretation = [{ text: "Northvale restarted quickly after the opening goal.", evidence: [{ kind: "event", id: "e7-kickoff" }] }]), structuredClone(r));
    expect(issues(interpreted, later)).toEqual([expect.stringContaining('interpretation[0] says "opening goal"')]);
  });

  it("require a claim about a goal to cite it even when the goal is in the evidence window", () => {
    expect(issues(edit((r) => (r.interpretation[0]!.text = "Quick forward passing led to the opening goal.")))).toEqual([
      expect.stringContaining('interpretation[0] says "opening goal"'),
    ]);
    expect(issues(edit((r) => {
      r.interpretation[0]!.text = "Quick forward passing led to the opening goal.";
      r.interpretation[0]!.evidence.push({ kind: "event", id: "e6-goal" });
    }))).toEqual([]);
  });

  it("check observable event wording in interpretation as in facts", () => {
    const claims: [string, string][] = [
      ["The pass sequence ended with #9 flagged offside.", "offside"],
      ["The press forced a foul in midfield.", "foul"],
      ["Quick passing won a penalty.", "penalty"],
      ["The move earned a corner.", "corner"],
      ["The move began from a throw-in.", "throw-in"],
      ["Quick passing forced a save from the keeper.", "save"],
    ];
    for (const [text, label] of claims)
      expect(issues(edit((r) => (r.interpretation[0]!.text = text))), text).toEqual([expect.stringContaining(`contains no ${label}`)]);
  });

  it("keep tactical terms out of the event check in interpretation", () => {
    for (const text of [
      "Quick forward passing beat the offside trap.",
      "Quick forward passing reached the penalty area before the defence reset.",
      "Quick forward passing found space at the corner of the box.",
    ])
      expect(issues(edit((r) => (r.interpretation[0]!.text = text))), text).toEqual([]);
  });

  it("check limitations for times, scores and players, but not event wording", () => {
    expect(issues(edit((r) => (r.limitations = ["Nothing is known after 20 s."])))[0]).toContain("limitations[0]");
    expect(issues(edit((r) => (r.limitations = ["The score could become 2–0."])))[0]).toContain("2–0");
    expect(issues(edit((r) => (r.limitations = ["#42 is not tracked."])))[0]).toContain("#42");
    expect(issues(edit((r) => (r.limitations = ["Whether a later shot is saved is not known."])))).toEqual([]);
  });

  // Regressions found by the scenario evaluation (docs/ai-evaluation.md).
  it("do not read a shirt number and initial as a time", () => {
    const early = extractMatchContext(sampleFixture, 3_450);
    const r: ExplanationResponse = {
      explanationVersion: "1.0.0",
      matchId: sampleFixture.matchId,
      timeMs: 3_450,
      status: "explained",
      headline: "Harbor City win the ball",
      explanation: "#6 S. Okafor won the ball at 2.4 s.",
      facts: [{ text: "At 2.4 s #6 S. Okafor won the ball.", evidence: [{ kind: "event", id: "e1-turnover" }] }],
      interpretation: [],
      limitations: [],
    };
    expect(issues(r, early)).toEqual([]);
    // A real later time is still caught, with or without a capital.
    expect(issues(edit((x) => (x.explanation = "Play stopped at 6 Seconds."), structuredClone(r)), early)[0]).toContain("6 Seconds");
    expect(issues(edit((x) => (x.explanation = "Play stopped at 6s."), structuredClone(r)), early)[0]).toContain("6s");
  });

  it("accept a player named in a cited event's own description", () => {
    const r = edit((x) => (x.facts[0]!.text = "#6 S. Okafor won the ball from #8 F. Lindqvist at 2.4 s."));
    expect(r.facts[0]!.evidence).toEqual([{ kind: "event", id: "e1-turnover" }]);
    expect(issues(r)).toEqual([]);
    // Still rejected when the cited event does not name them.
    expect(issues(edit((x) => (x.facts[1]!.text = "#9 shot at 8.8 s past F. Lindqvist."))).join()).toContain("Lindqvist");
  });

  it("reject a shot's result before it is revealed", () => {
    const pending: ExplanationResponse = {
      explanationVersion: "1.0.0",
      matchId: sampleFixture.matchId,
      timeMs: 9_050,
      status: "explained",
      headline: "Castell shoots",
      explanation: "Harbor City's number 9 has just shot.",
      facts: [{ text: "#9 shot at 8.8 s.", evidence: [{ kind: "event", id: "e5-shot" }] }],
      interpretation: [],
      limitations: ["Whether the shot went in is not known yet."],
    };
    expect(issues(pending, beforeGoal)).toEqual([]);
    for (const text of ["#9 shot at 8.8 s and it went in.", "#9's shot at 8.8 s beat the keeper.", "#9 shot on target at 8.8 s."])
      expect(issues(edit((r) => (r.facts[0]!.text = text), structuredClone(pending)), beforeGoal), text).toEqual([expect.stringContaining("shot result")]);
    expect(issues(edit((r) => (r.explanation = "The shot crossed the line."), structuredClone(pending)), beforeGoal)[0]).toContain("crossed the line");
    // Once the goal is revealed and cited, the same words are supported.
    expect(issues(edit((r) => (r.facts[1]!.text = "#9 shot at 8.8 s and it went in at 9.4 s.")))).toEqual([]);
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
