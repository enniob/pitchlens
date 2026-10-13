import { describe, expect, it } from "vitest";
import { EvidenceSession } from "@/explain/evidence";
import { checkGrounding } from "@/explain/grounding";
import type { ExplanationResponse } from "@/explain/response";
import { assess } from "./support/assess";
import { goalExplanation } from "./support/fakeModel";
import { scenarioById } from "./support/scenarios";

describe("October 13 live regressions", () => {
  const goal = scenarioById("demo-goal-recorded");
  const context = new EvidenceSession(goal.fixture, goal.timeMs, goal.focus).context();
  const draft = (text: string): ExplanationResponse => ({ ...goalExplanation(), facts: [{ text, evidence: [{ kind: "event", id: "e6-goal" }] }], interpretation: [], limitations: [] });
  it("does not describe the turnover-to-shot interval as the duration of the passes", () => {
    const s = scenarioById("demo-shot-in-flight");
    const evidence = new EvidenceSession(s.fixture, s.timeMs, s.focus).context();
    const answer = { ...goalExplanation(), timeMs: s.timeMs,
      headline: "Castell takes a shot",
      explanation: "Harbor City won the ball at 2.4 s, then played three completed forward passes in 6.4 s. Castell took a shot at 8.8 s; its result is not yet known.",
      facts: [{ text: "Castell took a shot at 8.8 s.", evidence: [{ kind: "event" as const, id: "e5-shot" }] }],
      interpretation: [], limitations: [] };
    expect(checkGrounding(answer, evidence, "analyst")).toContainEqual(expect.stringContaining("no cited pass endpoints span that duration"));
    expect(checkGrounding({ ...answer,
      explanation: "The shot came 6.4 s after Harbor City won the ball, with three completed passes in between." }, evidence, "analyst")).toEqual([]);
  });
  it("accepts grouped millisecond timestamps and rejects malformed grouping", () => {
    expect(checkGrounding(draft("Castell scored at 9,400 ms."), context, "analyst")).toEqual([]);
    expect(assess({ scenario: goal, audience: "analyst", explanation: draft("Castell scored at 9,400 ms.") }).unsupported).toEqual([]);
    expect(checkGrounding(draft("Castell scored at 9,40 ms."), context, "analyst")).toContainEqual(expect.stringContaining("malformed time"));
    expect(assess({ scenario: goal, audience: "analyst", explanation: draft("Castell scored at 9,40 ms.") }).unsupported).toContainEqual(expect.stringContaining("malformed time"));
  });
  it("checks the whole grouped future timestamp in every field", () => {
    for (const field of ["headline", "explanation", "facts", "interpretation", "limitations"] as const) {
      const text = "At 19,500 ms the ball is in play.";
      const r = draft("Castell scored at 9400 ms.");
      if (field === "facts" || field === "interpretation") r[field] = [{ text, evidence: [{ kind: "event", id: "e6-goal" }] }];
      else if (field === "limitations") r.limitations = [text];
      else r[field] = text;
      expect(checkGrounding(r, context, "analyst"), field).toContainEqual(expect.stringContaining("after the selected time"));
      expect(assess({ scenario: goal, audience: "analyst", explanation: r }).blockers, field).toContainEqual(expect.stringContaining("after the selected time"));
    }
  });
  it("checks grouped millisecond intervals against their named endpoints", () => {
    const r = draft("The turnover-to-shot sequence took 6,400 ms.");
    r.facts[0]!.evidence = [{ kind: "event", id: "e1-turnover" }, { kind: "event", id: "e5-shot" }];
    expect(checkGrounding(r, context, "analyst")).toEqual([]);
    r.facts[0]!.text = "The turnover-to-goal sequence took 6,400 ms.";
    r.facts[0]!.evidence.push({ kind: "event", id: "e6-goal" });
    expect(checkGrounding(r, context, "analyst")).toContainEqual(expect.stringContaining("no such pair"));
    r.facts[0]!.text = "It took 6,400 ms from the turnover to the goal.";
    expect(checkGrounding(r, context, "analyst")).toContainEqual(expect.stringContaining("no such pair"));
    expect(assess({ scenario: goal, audience: "analyst", explanation: r }).unsupported).toContainEqual(expect.stringContaining("no such pair"));
  });
  it("treats 'at 19.5 s after the goal' as a timestamp, not a 19.5 s duration", () => {
    const recap = scenarioById("demo-recap");
    const r = { ...draft("Northvale took a kickoff at 19.5 s after the goal."), timeMs: recap.timeMs };
    r.facts[0]!.evidence = [{ kind: "event", id: "e7-kickoff" }, { kind: "event", id: "e6-goal" }];
    expect(checkGrounding(r, new EvidenceSession(recap.fixture, recap.timeMs, recap.focus).context(), "analyst", recap.focus)).toEqual([]);
    expect(assess({ scenario: recap, audience: "analyst", explanation: r }).unsupported).toEqual([]);
  });

  const offside = scenarioById("seed24-offside-recorded");
  const offContext = new EvidenceSession(offside.fixture, offside.timeMs).context();
  const spell = offContext.measurements.possessionSpells.at(-1)!;
  const possession = (text: string): ExplanationResponse => ({
    explanationVersion: "1.0.0", matchId: offside.fixture.matchId, timeMs: offside.timeMs, status: "explained",
    headline: "Recorded possession", explanation: "Harbor City had possession.",
    facts: [{ text, evidence: spell.cite }], interpretation: [], limitations: [],
  });
  it("rejects both live offside-ended-spell claims even with valid citations", () => {
    for (const text of [
      "The offside ended a Harbor City FC possession spell that began at 10.78 s and lasted 3.92 s.",
      "The offside ended a Harbor City FC possession spell that began at 10.78 s and lasted about 6.4 s.",
    ]) {
      const r = possession(text);
      expect(checkGrounding(r, offContext, "analyst")).toContainEqual(expect.stringContaining("spell's end"));
      expect(assess({ scenario: offside, audience: "analyst", explanation: r }).unsupported).toContainEqual(expect.stringContaining("spell's end"));
    }
  });
  it("rejects event gaps as possession durations, but accepts the measured duration", () => {
    expect(checkGrounding(possession("Harbor City FC's possession spell lasted 6.4 s."), offContext, "analyst"))
      .toContainEqual(expect.stringContaining("possession duration"));
    expect(checkGrounding(possession("Harbor City FC's sampled possession spell lasted 3.92 s."), offContext, "analyst")).toEqual([]);
    expect(assess({ scenario: offside, audience: "analyst", explanation: possession("Harbor City FC's sampled possession spell lasted 3.92 s.") }).unsupported).toEqual([]);
    const missing = possession("Harbor City FC's sampled possession spell lasted 3.92 s.");
    missing.facts[0]!.evidence = [spell.cite[0]!];
    expect(checkGrounding(missing, offContext, "analyst")).toContainEqual(expect.stringContaining("possession duration"));
    expect(checkGrounding(possession("Harbor City FC had possession for 6.4 s."), offContext, "analyst"))
      .toContainEqual(expect.stringContaining("possession duration"));
  });
});

describe("October 13 verified-facts run", () => {
  const recap = scenarioById("seed3-zero-goal-recap");
  const context = new EvidenceSession(recap.fixture, recap.timeMs, recap.focus).base;
  const change = context.events.find((e) => e.type === "formation-change")!;
  const answer = (explanation: string): ExplanationResponse => ({
    explanationVersion: "1.0.0", matchId: recap.fixture.matchId, timeMs: recap.timeMs, status: "explained",
    headline: "Northvale Rovers change shape but 0–0 draw stands", explanation,
    facts: [{ text: "Northvale Rovers changed formation from 4-3-3 to 4-2-3-1 at 30.0 s.", evidence: [{ kind: "event", id: change.id }] }],
    interpretation: [], limitations: [],
  });
  it("reads 'no goals were scored' in a goalless recap as no goal, but still flags a stated one", () => {
    const fine = assess({ scenario: recap, audience: "casual", explanation: answer("The match ended 0–0. Northvale Rovers switched from 4-3-3 to 4-2-3-1 at 30.0 s, but no goals were scored by either side.") });
    expect(fine).toMatchObject({ leaks: [], unsupported: [], quality: "usable" });
    const wrong = assess({ scenario: recap, audience: "casual", explanation: answer("Northvale Rovers switched to 4-2-3-1 at 30.0 s and then scored.") });
    expect(wrong.leaks.length + wrong.unsupported.length).toBeGreaterThan(0);
  });
});
