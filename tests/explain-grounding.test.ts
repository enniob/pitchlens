import { describe, expect, it } from "vitest";
import { extractMatchContext } from "@/explain/context";
import { AUDIENCE_LIMITS, checkGrounding } from "@/explain/grounding";
import type { ExplanationResponse } from "@/explain/response";
import { sampleFixture } from "@/match/fixture";
import { generateMatch } from "@/simulation/generate";
import { goalExplanation } from "./support/fakeModel";
import { evalMatch } from "./support/scenarios";

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

describe("revision hints", () => {
  // Seed 99: #9's shot is blocked, its result revealed at 39.52 s (a live fallback case).
  const fixture = generateMatch({ seed: 99, durationMs: 60_000 });
  const result = fixture.events.find((e) => e.type === "shot-result" && e.t === 39_520)!;
  const shot = fixture.events.find((e) => e.type === "shot" && e.t === result.startT && e.playerId === result.playerId)!;
  const context = extractMatchContext(fixture, result.t);
  const answer = (facts: ExplanationResponse["facts"]): ExplanationResponse => ({
    explanationVersion: "1.0.0", matchId: fixture.matchId, timeMs: result.t, status: "explained",
    headline: "Shot blocked", explanation: "The shot was blocked.", facts, interpretation: [], limitations: [],
  });
  const cite = (...ids: string[]) => ids.map((id) => ({ kind: "event" as const, id }));

  it("names the uncited shot behind a cited shot result, and citing it passes", () => {
    const text = "The shot was blocked.";
    const found = checkGrounding(answer([{ text, evidence: cite(result.id) }]), context, "casual");
    expect(found).toContainEqual(expect.stringContaining(`contains no shot; also cite the shot event ${shot.id} in this claim`));
    expect(checkGrounding(answer([{ text, evidence: cite(result.id, shot.id) }]), context, "casual")).toEqual([]);
  });

  it("names the other endpoint of a duration only when the claim cites one and the other is unambiguous", () => {
    // From the last pass before the shot; the claim cites the shot, so the pass is the missing endpoint.
    const pass = fixture.events.filter((e) => e.type === "pass" && e.t < shot.t).at(-1)!;
    const text = `The shot came ${Number(((shot.t - pass.t) / 1000).toFixed(2))} s after the pass.`;
    const found = checkGrounding(answer([{ text, evidence: cite(shot.id) }]), context, "casual");
    expect(found).toContainEqual(expect.stringContaining(`: also cite ${pass.id} in this claim, or remove the duration`));
    expect(checkGrounding(answer([{ text, evidence: cite(shot.id, pass.id) }]), context, "casual")).toEqual([]);
  });

  it("never suggests a coincidental pair the claim does not anchor", () => {
    // Citing only a turnover anchors nothing that spans 1.06 s, whatever pairs elsewhere happen to.
    const turnover = context.events.find((e) => e.type === "turnover")!;
    const found = checkGrounding(answer([{ text: "Possession changed 1.06 s later.", evidence: cite(turnover.id) }]), context, "casual");
    const issue = found.find((i) => i.includes("not supported by two cited time endpoints"));
    expect(issue).toMatch(/cite both events it is measured between in this claim, or remove the duration$/);
  });

  it("does not change what passes: the unrepaired claims are still rejected", () => {
    const found = checkGrounding(answer([{ text: "The shot took 0.26 s to be blocked.", evidence: cite(result.id) }]), context, "casual");
    expect(found.some((i) => i.includes("contains no shot"))).toBe(true);
  });
});

describe("duration hint ambiguity", () => {
  const fixture = generateMatch({ seed: 99, durationMs: 60_000 });
  const base = extractMatchContext(fixture, 39_520);
  const [a, b, c] = base.events.filter((e) => e.type === "pass").slice(-3);
  // One uncited pass exactly 3 s from each of two cited passes.
  const context = { ...base, events: base.events.map((e) =>
    e === a ? { ...e, t: 30_000, startT: undefined } : e === b ? { ...e, t: 36_000, startT: undefined } : e === c ? { ...e, t: 33_000, startT: undefined } : e) };

  it("gives the generic hint when one uncited event fits several cited anchors", () => {
    const draft: ExplanationResponse = {
      explanationVersion: "1.0.0", matchId: fixture.matchId, timeMs: 39_520, status: "explained",
      headline: "Two passes", explanation: "Two passes were recorded.",
      facts: [{ text: "The passes came 3 s apart.", evidence: [{ kind: "event", id: a!.id }, { kind: "event", id: b!.id }] }],
      interpretation: [], limitations: [],
    };
    const issue = checkGrounding(draft, context, "casual").find((i) => i.includes("not supported by two cited time endpoints"));
    expect(issue).toMatch(/cite both events it is measured between in this claim, or remove the duration$/);
  });
});

// Defects found by manual review of live answers (docs/replay-reliability-2026-10-12.md).
describe("checks added after the live evaluation", () => {
  const only = (r: ExplanationResponse, patch: Partial<ExplanationResponse>) => ({ ...r, interpretation: [], limitations: [], ...patch });
  const ev = (...ids: string[]) => ids.map((id) => ({ kind: "event" as const, id }));

  it("reject a duration whose named endpoints are not the events it spans", () => {
    // Turnover 2.4 s, shot 8.8 s, goal 9.4 s: 6.4 s is turnover to shot, 7.0 s turnover to goal.
    const wrong = only(goalExplanation(), { explanation: "The goal came 6.4 s after S. Okafor won the ball." });
    expect(issues(wrong)).toContainEqual(expect.stringContaining("6.4 s between a goal, turnover"));
    expect(issues(only(goalExplanation(), { explanation: "The goal came 7.0 s after S. Okafor won the ball." }))).toEqual([]);
    expect(issues(only(goalExplanation(), { explanation: "The shot came 6.4 s after the turnover, and the goal followed." }))).toEqual([]);
    const fact = (text: string) => only(goalExplanation(), { facts: [{ text, evidence: ev("e1-turnover", "e5-shot", "e6-goal") }] });
    expect(issues(fact("The turnover-to-goal interval took 6.4 s."))).toContainEqual(expect.stringContaining("no such pair"));
    expect(issues(fact("The turnover-to-shot interval took 6.4 s."))).toEqual([]);
    // Each duration is judged on its own clause.
    expect(issues(fact("The shot came 6.4 s after the turnover and the goal 0.6 s later."))).toEqual([]);
  });

  it("reject a pass called forward when it moved backward, and the reverse", () => {
    // Seed 3: Novak to Haddad from x=78.3 to x=58.4 while Harbor City attack increasing x.
    const fixture = evalMatch(3);
    const pass = fixture.events.find((e) => e.type === "pass" && e.start!.x - e.end!.x > 15 && e.teamId === "hcf")!;
    const context = extractMatchContext(fixture, pass.t);
    const r = (text: string): ExplanationResponse => ({
      explanationVersion: "1.0.0", matchId: fixture.matchId, timeMs: pass.t, status: "explained",
      headline: "A pass", explanation: "A pass was played.", facts: [{ text, evidence: ev(pass.id) }], interpretation: [], limitations: [],
    });
    expect(issues(r("The pass moved play forward."), context)).toContainEqual(expect.stringContaining("moved backward"));
    expect(issues(r("The pass went backward."), context)).toEqual([]);
    // The live answer said it in the explanation, which cites nothing: the sentence names passer and recipient.
    const surname = (id?: string) => fixture.roster.find((p) => p.id === id)!.name.split(" ").pop();
    const prose = `${surname(pass.playerId)} completed a pass to ${surname(pass.recipientId)}, moving play forward.`;
    expect(issues({ ...r("The pass was completed."), explanation: prose }, context)).toContainEqual(expect.stringContaining("explanation calls play forward"));
    expect(issues({ ...r("The pass was completed."), explanation: prose.replace("forward", "backward") }, context)).toEqual([]);
    expect(issues(only(goalExplanation(), { facts: [{ text: "The pass went backwards.", evidence: ev("e2-pass") }] }))).toContainEqual(expect.stringContaining("moved forward"));
    expect(issues(only(goalExplanation(), { facts: [{ text: "The pass moved play forward.", evidence: ev("e2-pass") }] }))).toEqual([]);
  });

  it("reject play placed in the wrong team's half", () => {
    // Seed 9: Northvale win the ball at x=94.5; Northvale attack decreasing x, so that is their own half.
    const fixture = evalMatch(9);
    const turnover = fixture.events.find((e) => e.type === "turnover" && e.teamId === "nvr" && e.start!.x > 90)!;
    const context = extractMatchContext(fixture, turnover.t);
    const r = (text: string): ExplanationResponse => ({
      explanationVersion: "1.0.0", matchId: fixture.matchId, timeMs: turnover.t, status: "explained",
      headline: "Northvale win the ball", explanation: "Northvale won the ball.", facts: [{ text, evidence: ev(turnover.id) }], interpretation: [], limitations: [],
    });
    expect(issues(r("Northvale won the ball deep in Harbor City's half."), context)).toContainEqual(expect.stringContaining("Harbor City FC's half"));
    expect(issues(r("Northvale won the ball deep in Northvale Rovers' own half."), context)).toEqual([]);
  });

  it("reject left/right touchline, flank and wing labels", () => {
    for (const label of ["right touchline", "left flank", "right wing"])
      expect(issues(only(goalExplanation(), { explanation: `The move began near the ${label}.` }))).toContainEqual(expect.stringContaining("zone label"));
  });

  it("reject a count of filtered events of one type, even in a limitation", () => {
    const r = only(goalExplanation(), { limitations: ["22 ordinary passes were filtered out of this summary."] });
    expect(issues(r)).toContainEqual(expect.stringContaining("only a total of filtered events"));
    expect(issues(only(goalExplanation(), { limitations: ["22 other events were filtered out of this summary."] }))).toEqual([]);
  });
});
