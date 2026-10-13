/**
 * Offline evaluation of "Explain this moment" on reproducible synthetic
 * scenarios (tests/support/scenarios.ts), for both audiences. No network: the
 * model is scripted. See docs/ai-evaluation.md.
 */
import { describe, expect, it } from "vitest";
import type { Audience } from "@/explain/api";
import { validateExplanation } from "@/explain/response";
import { explainMoment } from "@/server/analyst";
import type { ChatRequest } from "@/server/foundry";
import { scoreAt } from "@/playback/derive";
import { assess, reachableContext } from "./support/assess";
import { evidenceFor, groundedDraft, lenientVerifier, verifierRejecting, withClaim } from "./support/drafts";
import { answer, approve, FakeModel, toolCall, type Step } from "./support/fakeModel";
import { EVAL_AUDIENCES, EVAL_SCENARIOS, EVAL_SEEDS, type Coverage, type EvalScenario } from "./support/scenarios";

const cases = EVAL_SCENARIOS.flatMap((s) => EVAL_AUDIENCES.map((audience) => ({ s, audience, name: `${s.id} (${audience})` })));
const run = (s: EvalScenario, audience: Audience, steps: Step[]) =>
  explainMoment({ fixture: s.fixture, timeMs: s.timeMs, audience, focus: s.focus, client: new FakeModel(steps) });
/** Answers every analyst turn with `draft` and every review with `review`. */
const byRole = (draft: unknown, review: (r: ChatRequest) => ReturnType<typeof lenientVerifier>): Step[] =>
  Array.from({ length: 8 }, () => (r: ChatRequest) => (r.role === "analyst" ? answer(draft) : review(r)));
const shownText = (e: { headline: string; explanation: string; facts: { text: string }[]; interpretation: { text: string }[]; limitations: string[] }) =>
  [e.headline, e.explanation, ...e.facts.map((f) => f.text), ...e.interpretation.map((f) => f.text), ...e.limitations].join("\n");

describe("evaluation scenarios", () => {
  it("cover every required situation, several seeds and both audiences", () => {
    const covered = new Set(EVAL_SCENARIOS.flatMap((s) => s.covers));
    const required: Coverage[] = [
      "goal-before-recorded", "goal-recorded", "pass-in-flight", "shot-in-flight", "offside-kick-frame", "offside-recorded",
      "generated-seed", "formation-change", "sparse-evidence", "zero-goals", "recap", "recap-multiple-goals",
    ];
    for (const c of required) expect(covered, c).toContain(c);
    const seeds = new Set(EVAL_SCENARIOS.flatMap((s) => (s.fixture.generator ? [s.fixture.generator.seed] : [])));
    expect([...seeds].sort((a, b) => a - b)).toEqual([...EVAL_SEEDS]);
    expect(EVAL_AUDIENCES).toEqual(["casual", "analyst"]);
    expect(new Set(EVAL_SCENARIOS.map((s) => s.id)).size).toBe(EVAL_SCENARIOS.length);
  });

  it.each(EVAL_SCENARIOS)("$id is well-formed: expected facts are reachable, forbidden ones are not yet true", (s) => {
    expect(s.timeMs).toBeGreaterThanOrEqual(0);
    expect(s.timeMs).toBeLessThanOrEqual(s.fixture.durationMs);
    if (s.focus === "match") expect(s.timeMs).toBe(s.fixture.durationMs);
    const reachable = reachableContext(s.fixture, s.timeMs, s.focus);
    expect(reachable.limitations.map((l) => l.code)).not.toContain("events-truncated");
    for (const x of s.expected)
      for (const id of x.eventIds ?? []) expect(reachable.events.map((e) => e.id), `${x.label}: ${id}`).toContain(id);
    for (const f of s.forbidden) expect(f.pattern.test(f.probe), f.label).toBe(true);
    // Each scenario's probes really are unsupported at that time: the event they describe is not revealed.
    if (s.covers.includes("shot-in-flight") || s.covers.includes("goal-before-recorded"))
      expect(reachable.events.filter((e) => e.type === "goal" || e.type === "shot-result").filter((e) => e.t > s.timeMs - 2_000)).toEqual([]);
  });

  it.each(cases)("$name: nothing after the selected time reaches the model", async ({ s, audience }) => {
    const context = evidenceFor(s);
    const model = new FakeModel([
      toolCall("list_events", {}),
      toolCall("get_positions", { atMs: context.time.selectedMs }),
      toolCall("get_positions", { atMs: context.time.selectedMs + 1 }),
      answer(groundedDraft(s, audience)),
      lenientVerifier,
    ]);
    await explainMoment({ fixture: s.fixture, timeMs: s.timeMs, audience, focus: s.focus, client: model });
    const sent = JSON.stringify(model.requests.map((r) => r.messages));
    for (const e of s.fixture.events.filter((x) => x.t > s.timeMs)) expect(sent, e.id).not.toContain(`"${e.id}"`);
    const final = scoreAt(s.fixture, s.fixture.durationMs);
    const now = scoreAt(s.fixture, s.timeMs);
    if (final.home !== now.home || final.away !== now.away) expect(sent).not.toContain(`"score":{"home":${final.home},"away":${final.away}}`);
    for (const c of s.fixture.tactics?.applied ?? [])
      if (c.t > s.timeMs && !s.fixture.tactics!.initial.some((i) => i.formation === c.to)) expect(sent, c.to).not.toContain(c.to);
    if (s.fixture.title) expect(sent).not.toContain(s.fixture.title);
    for (const key of ["simulatorVersion", "configKey", "generator"]) expect(sent).not.toContain(key);
  });

  it.each(cases)("$name: a grounded answer is verified and assessed safe and usable", async ({ s, audience }) => {
    const draft = groundedDraft(s, audience);
    const out = await run(s, audience, [answer(draft), approve(draft)]);
    const verdict = assess({ scenario: s, audience, explanation: out.explanation, verification: out.verification });
    expect(verdict).toMatchObject({ blockers: [], leaks: [], unsupported: [] });
    if (draft.status === "explained") {
      expect(out.verification.outcome, JSON.stringify(out.verification.issues)).toBe("verified");
      expect(verdict.quality, JSON.stringify(verdict.expected)).toBe("usable");
    } else {
      expect(out.verification.outcome).toBe("insufficient-evidence");
      expect(verdict.quality).toBe("honest-insufficient");
    }
  });

  const probes = cases.flatMap(({ s, audience, name }) => s.forbidden.map((f) => ({ s, audience, f, name: `${name}: ${f.label} ("${f.probe}")` })));

  it.each(probes)("$name passes JSON and citation checks, but the assessment flags it", ({ s, audience, f }) => {
    const draft = withClaim(s, audience, f.probe);
    expect(validateExplanation(draft, reachableContext(s.fixture, s.timeMs, s.focus)).ok).toBe(true);
    const verdict = assess({ scenario: s, audience, explanation: draft });
    expect(verdict.leaks.join("\n")).toContain(f.label);
    // A later formation by name is also a deterministic blocker.
    expect(["needs-review", "unsafe"]).toContain(verdict.quality);
  });

  it("accepts a percentage or speed only when it repeats a supplied measurement", () => {
    const s = EVAL_SCENARIOS.find((x) => x.id === "demo-goal-recorded")!;
    const measured = evidenceFor(s).measurements;
    const percent = measured.statistics.find((x) => x.completionPercent !== null)!.completionPercent!;
    const speed = measured.passes.find((p) => p.averageStraightLineSpeedMps !== null)!.averageStraightLineSpeedMps!;
    const flagged = (text: string) => assess({ scenario: s, audience: "analyst", explanation: withClaim(s, "analyst", text) }).unsupported
      .filter((u) => u.includes("metric or attribute"));
    expect(flagged(`Passes were completed at ${percent}% in the window, at ${speed} m/s on average.`)).toEqual([]);
    expect(flagged(`Passes were completed at ${percent - 13}% in the window.`)).toHaveLength(1);
    expect(flagged(`The pass moved at ${speed + 1} m/s.`)).toHaveLength(1);
    expect(flagged("The winger reached 30 km/h.")).toHaveLength(1);
  });

  const byGrounding = probes.filter((p) => p.f.caughtBy === "grounding");
  const byVerifier = probes.filter((p) => p.f.caughtBy === "verifier");

  it.each(byGrounding)("$name is never shown, even when the verifier approves everything", async ({ s, audience, f }) => {
    const draft = withClaim(s, audience, f.probe);
    const out = await run(s, audience, byRole(draft, lenientVerifier));
    expect(shownText(out.explanation)).not.toContain(f.probe);
    expect(out.verification).toMatchObject({ outcome: "fallback", grounding: "failed" });
    const verdict = assess({ scenario: s, audience, explanation: out.explanation, verification: out.verification });
    expect(verdict).toMatchObject({ blockers: [], leaks: [] });
  });

  // Known gap, documented in docs/ai-evaluation.md: these depend on the verifier. If one approves
  // them anyway, the evaluation must not count the answer as usable.
  it.each(byVerifier)("$name relies on the verifier; the assessment flags it if a verifier lets it through", async ({ s, audience, f }) => {
    const draft = withClaim(s, audience, f.probe);
    const out = await run(s, audience, byRole(draft, lenientVerifier));
    expect(out.verification.outcome).toBe("verified");
    const verdict = assess({ scenario: s, audience, explanation: out.explanation, verification: out.verification });
    expect(verdict.leaks.length + verdict.blockers.length).toBeGreaterThan(0);
    expect(["needs-review", "unsafe"]).toContain(verdict.quality);
  });

  it.each(probes)("$name is rejected by the checks or the verifier and removed in the revision", async ({ s, audience, f }) => {
    const leaky = withClaim(s, audience, f.probe, "interpretation");
    const fixed = groundedDraft(s, audience);
    let analystTurns = 0;
    const steps: Step[] = Array.from({ length: 8 }, () => (r: ChatRequest) =>
      r.role === "analyst" ? answer(analystTurns++ === 0 ? leaky : fixed) : verifierRejecting(f.pattern)(r));
    const out = await run(s, audience, steps);
    expect(shownText(out.explanation)).not.toContain(f.probe);
    expect(out.verification.revisions).toBe(1);
    const verdict = assess({ scenario: s, audience, explanation: out.explanation, verification: out.verification });
    expect(verdict).toMatchObject({ blockers: [], leaks: [], unsupported: [] });
  });
});
