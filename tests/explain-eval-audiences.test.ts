/**
 * Offline evaluation of the two audiences as a pair (tests/support/audience.ts):
 * the same evidence for both, no factual disagreement, a readable Casual Fan
 * answer and an Analyst answer with more detail. Scripted model, no network.
 */
import { describe, expect, it } from "vitest";
import type { ExplanationResponse } from "@/explain/response";
import { explainMoment } from "@/server/analyst";
import { assessAudiences } from "./support/audience";
import { groundedDraft, lenientVerifier } from "./support/drafts";
import { answer, FakeModel } from "./support/fakeModel";
import { EVAL_AUDIENCES, EVAL_SCENARIOS, scenarioById } from "./support/scenarios";

describe("Casual Fan and Analyst answers as a pair", () => {
  it.each(EVAL_SCENARIOS)("$id: both audiences are given exactly the same evidence", async (s) => {
    const sent = await Promise.all(
      EVAL_AUDIENCES.map(async (audience) => {
        const model = new FakeModel([answer(groundedDraft(s, audience)), lenientVerifier]);
        await explainMoment({ fixture: s.fixture, timeMs: s.timeMs, audience, focus: s.focus, client: model });
        const [analyst, verifier] = model.requests;
        return { system: analyst!.messages[0]!.content, evidence: analyst!.messages[1]!.content, verifier: verifier?.messages[1]?.content };
      }),
    );
    expect(sent[0]!.evidence).toBe(sent[1]!.evidence);
    // Only the audience wording differs.
    expect(sent[0]!.system).not.toBe(sent[1]!.system);
  });

  it.each(EVAL_SCENARIOS)("$id: grounded answers for the two audiences agree and suit their readers", (s) => {
    expect(assessAudiences(groundedDraft(s, "casual"), groundedDraft(s, "analyst"))).toEqual({ conflicts: [], readability: [], detail: [] });
  });

  const s = scenarioById("demo-goal-recorded");
  const casual = () => groundedDraft(s, "casual");
  const analyst = () => groundedDraft(s, "analyst");
  const edit = (r: ExplanationResponse, patch: Partial<ExplanationResponse>): ExplanationResponse => ({ ...r, ...patch });

  it("flags answers that disagree about the match", () => {
    const insufficient = edit(analyst(), { status: "insufficient-evidence", facts: [], interpretation: [] });
    expect(assessAudiences(casual(), insufficient).conflicts.join("\n")).toMatch(/explained but the Analyst answer is insufficient-evidence/);
    expect(assessAudiences(edit(casual(), { explanation: "Harbor City lead 2–0." }), analyst()).conflicts.join("\n")).toMatch(/different latest scores \(0–2 vs 0–1\)/);
    const a = analyst();
    const turnover = a.facts.find((f) => f.evidence.length === 1 && f.evidence[0]!.kind === "event")!;
    const c = edit(casual(), { facts: [{ text: turnover.text.replace(/\d+\.\d s/, "14.0 s"), evidence: turnover.evidence }] });
    expect(assessAudiences(c, a).conflicts.join("\n")).toMatch(/different times for/);
    // A duration is not a timestamp, and rounding within a second is not a conflict.
    const rounded = edit(casual(), { facts: [{ text: turnover.text.replace(/(\d+)\.\d s/, "$1 s"), evidence: turnover.evidence }] });
    expect(assessAudiences(rounded, a).conflicts).toEqual([]);
  });

  it("flags a Casual Fan answer that is hard to read", () => {
    const long = `Harbor City ${"kept moving the ball forward and ".repeat(8)}scored.`;
    const flags = (patch: Partial<ExplanationResponse>) => assessAudiences(edit(casual(), patch), analyst()).readability.join("\n");
    expect(flags({ explanation: long })).toMatch(/words/);
    expect(flags({ explanation: "Harbor City attacked through the half-space and scored." })).toMatch(/jargon \("half-space"\)/);
    expect(flags({ explanation: "The shot came from x=96.4 at 31 m/s after e5-shot." })).toMatch(/raw coordinates[\s\S]*speed unit[\s\S]*event ID/);
    expect(flags({ explanation: "At 2.4 s, 4.1 s, 6.0 s and 8.8 s Harbor City passed and at 9.4 s scored." })).toMatch(/numbers/);
    expect(flags({ headline: "Harbor City finally score after a long and patient move through every line of the pitch" })).toMatch(/headline has/);
  });

  it("flags an Analyst answer without useful detail", () => {
    const flags = (r: ExplanationResponse) => assessAudiences(casual(), r).detail.join("\n");
    expect(flags(edit(casual(), {}))).toMatch(/repeats the Casual Fan/);
    const a = analyst();
    expect(flags(edit(a, { facts: a.facts.slice(0, 1) }))).toMatch(/cites less evidence/);
    expect(flags(edit(a, { facts: a.facts.map((f) => ({ ...f, text: "Harbor City kept the ball." })) }))).toMatch(/no Analyst fact states/);
  });

  it("does not judge readability or detail of an answer that explains nothing", () => {
    const none = (r: ExplanationResponse) => edit(r, { status: "insufficient-evidence", facts: [], interpretation: [], explanation: "x ".repeat(80) });
    expect(assessAudiences(none(casual()), none(analyst()))).toEqual({ conflicts: [], readability: [], detail: [] });
  });
});
