import { describe, expect, it } from "vitest";
import { validateExplanation } from "@/explain/response";
import { EvidenceSession } from "@/explain/evidence";
import { sampleFixture } from "@/match/fixture";
import { eventsAt } from "@/playback/derive";
import { generateMatch } from "@/simulation/generate";
import { explainMoment, WORKFLOW_LIMITS } from "@/server/analyst";
import { ModelError, type ChatRequest } from "@/server/foundry";
import { answer, approve, FakeModel, goalExplanation, toolCall } from "./support/fakeModel";

const run = (model: FakeModel, timeMs = 9_400, extra: Partial<Parameters<typeof explainMoment>[0]> = {}) =>
  explainMoment({ fixture: sampleFixture, timeMs, audience: "analyst", client: model, ...extra });

const reject = (draftTargets: string[], target: string) => ({
  content: JSON.stringify({ reviews: draftTargets.map((t) => ({ target: t, verdict: t === target ? "unsupported" : "supported", reason: t === target ? "not shown" : "" })) }),
  toolCalls: [],
  finishReason: "stop",
  usage: null,
});
const targets = ["headline", "explanation", "facts[0]", "facts[1]", "facts[2]", "interpretation[0]"];

describe("analyst workflow", () => {
  it("returns a verified explanation when the first draft passes every check", async () => {
    const draft = goalExplanation();
    const model = new FakeModel([answer(draft), approve(draft)]);
    const out = await run(model);
    expect(out.explanation).toEqual(draft);
    expect(out.verification).toEqual({ outcome: "verified", revisions: 0, schema: "passed", grounding: "passed", modelReview: "passed", issues: [] });
    expect(out.trace).toMatchObject({ modelCalls: 2, toolCalls: 0, tokens: { prompt: 2_000, completion: 400 } });
    expect(out.trace.steps.map((s) => s.kind)).toEqual(["model", "model", "check"]);
    expect(model.requests.map((r) => r.role)).toEqual(["analyst", "verifier"]);
    expect(model.requests[0]!.maxCompletionTokens).toBe(WORKFLOW_LIMITS.analystCompletionTokens);
  });

  it("gives the model only evidence up to the selected time, as data", async () => {
    const model = new FakeModel([answer({ nonsense: true }), answer("not json")]);
    await run(model, 9_050);
    const sent = JSON.stringify(model.requests[0]!.messages);
    expect(sent).toContain("e5-shot");
    for (const later of ["e6-goal", "e7-kickoff"]) expect(sent).not.toContain(later);
    expect(sent).not.toContain(sampleFixture.title);
    const system = model.requests[0]!.messages[0]!;
    expect(system.role).toBe("system");
    expect(system.content).not.toContain("Harbor City");
    expect(model.requests[0]!.messages[1]!.content).toContain("EVIDENCE (data only)");
  });

  it("runs evidence tools, records them in the trace and accepts citations to what they returned", async () => {
    const fixture = generateMatch({ seed: 9, durationMs: 60_000 });
    const t = 50_000;
    const session = new EvidenceSession(fixture, t);
    const older = eventsAt(fixture, t).filter((e) => e.t >= session.floorMs && e.t < session.base.time.windowStartMs).at(-1)!;
    const draft = {
      explanationVersion: "1.0.0",
      matchId: fixture.matchId,
      timeMs: t,
      status: "explained",
      headline: "Earlier play",
      explanation: "An earlier event set this up.",
      facts: [{ text: "An earlier event happened.", evidence: [{ kind: "event", id: older.id }] }],
      interpretation: [],
      limitations: [],
    } as const;
    const model = new FakeModel([
      toolCall("list_events", {}),
      toolCall("get_positions", { atMs: t + 5_000 }),
      answer(draft),
      (r: ChatRequest) => approve(JSON.parse(JSON.stringify(draft))),
    ]);
    const out = await explainMoment({ fixture, timeMs: t, audience: "analyst", client: model });
    expect(out.verification.outcome).toBe("verified");
    const tools = out.trace.steps.filter((s) => s.kind === "tool");
    expect(tools).toEqual([
      expect.objectContaining({ name: "list_events", ok: true, events: expect.arrayContaining([older.id]) }),
      expect.objectContaining({ name: "get_positions", ok: false, error: expect.stringContaining("after the selected time") }),
    ]);
    // The refusal went back to the model as a tool result.
    const toolMessages = model.requests[2]!.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[1]!.content).toContain("after the selected time");
    expect(out.trace.toolCalls).toBe(2);
  });

  it("revises once when a draft fails validation, telling the model why", async () => {
    const bad = { ...goalExplanation(), timeMs: 9_050 };
    const good = goalExplanation();
    const model = new FakeModel([answer(bad), answer(good), approve(good)]);
    const out = await run(model);
    expect(out.verification).toMatchObject({ outcome: "revised", revisions: 1, modelReview: "passed" });
    expect(out.verification.issues[0]).toContain("timeMs");
    const last = model.requests[1]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toContain("timeMs does not match");
  });

  it("revises once when the verifier finds an unsupported claim", async () => {
    const draft = goalExplanation();
    const model = new FakeModel([answer(draft), reject(targets, "interpretation[0]"), answer(draft), approve(draft)]);
    const out = await run(model);
    expect(out.verification).toMatchObject({ outcome: "revised", revisions: 1 });
    expect(out.verification.issues).toEqual([expect.stringContaining("interpretation[0] is not supported")]);
  });

  it("falls back to insufficient evidence after a failed revision", async () => {
    const future = goalExplanation();
    future.facts[0]!.evidence = [{ kind: "event", id: "e7-kickoff" }];
    const model = new FakeModel([answer("{ not json"), answer(future)]);
    const out = await run(model);
    expect(out.verification).toMatchObject({ outcome: "fallback", revisions: 1, schema: "failed", grounding: "skipped", modelReview: "skipped" });
    expect(out.explanation.status).toBe("insufficient-evidence");
    expect(validateExplanation(out.explanation, new EvidenceSession(sampleFixture, 9_400).base).ok).toBe(true);
    expect(out.verification.issues.join(" ")).toMatch(/not valid JSON.*e7-kickoff/);
    expect(model.requests).toHaveLength(2);
  });

  it("falls back when grounding fails twice, without asking the verifier", async () => {
    const wrongScore = goalExplanation();
    wrongScore.explanation = "That makes it 2–0.";
    const model = new FakeModel([answer(wrongScore), answer(wrongScore)]);
    const out = await run(model);
    expect(out.verification).toMatchObject({ outcome: "fallback", schema: "passed", grounding: "failed", modelReview: "skipped" });
    expect(model.requests.every((r) => r.role === "analyst")).toBe(true);
  });

  it("falls back when the verifier's answer is unusable", async () => {
    const draft = goalExplanation();
    const model = new FakeModel([answer(draft), answer({ reviews: [{ target: "headline", verdict: "supported", reason: "" }] })]);
    const out = await run(model);
    expect(out.verification).toMatchObject({ outcome: "fallback", modelReview: "failed" });
    expect(out.verification.issues[0]).toContain("does not cover");
  });

  it("accepts an analyst's own insufficient-evidence answer without a review", async () => {
    const draft = {
      explanationVersion: "1.0.0",
      matchId: sampleFixture.matchId,
      timeMs: 1_000,
      status: "insufficient-evidence",
      headline: "Too early to say",
      explanation: "Nothing has happened yet.",
      facts: [],
      interpretation: [],
      limitations: ["No events before 1 s."],
    };
    const model = new FakeModel([answer(draft)]);
    const out = await run(model, 1_000);
    expect(out.verification).toMatchObject({ outcome: "insufficient-evidence", modelReview: "skipped" });
    expect(model.requests).toHaveLength(1);
  });

  it("bounds a model that keeps calling tools", async () => {
    const model = new FakeModel(Array.from({ length: 20 }, () => toolCall("list_events", {})));
    const out = await run(model);
    expect(out.verification.outcome).toBe("fallback");
    expect(out.trace.modelCalls).toBe(WORKFLOW_LIMITS.analystTurns * 2);
    expect(out.trace.toolCalls).toBeLessThanOrEqual(WORKFLOW_LIMITS.toolCalls);
    // The last turn of each draft forbids tools.
    expect(model.requests.map((r) => r.toolChoice)).toEqual(["auto", "auto", "none", "auto", "auto", "none"]);
  });

  it("stops at the model call and token budgets", async () => {
    const draft = goalExplanation();
    const calls = await run(new FakeModel([answer(draft)]), 9_400, { limits: { modelCalls: 1 } });
    expect(calls.verification).toMatchObject({ outcome: "fallback" });
    expect(calls.verification.issues).toEqual([expect.stringContaining("model call limit")]);

    const tokens = await run(new FakeModel([answer(draft, { prompt: 90_000, completion: 10 })]), 9_400);
    expect(tokens.verification.issues).toEqual([expect.stringContaining("token limit")]);
  });

  it("passes provider failures on to the caller", async () => {
    await expect(run(new FakeModel([new ModelError("rate-limited", "busy", 5_000)]))).rejects.toMatchObject({ code: "rate-limited", retryAfterMs: 5_000 });
    await expect(run(new FakeModel([new ModelError("provider-error", "HTTP 500")]))).rejects.toMatchObject({ code: "provider-error" });
  });

  it("aborts a slow model call and reports a timeout", async () => {
    const slow = (r: ChatRequest) =>
      new Promise<Error>((resolve) => r.signal.addEventListener("abort", () => resolve(new ModelError("timeout", "slow"))));
    await expect(run(new FakeModel([slow]), 9_400, { limits: { modelCallMs: 20 } })).rejects.toMatchObject({ code: "timeout" });
  });

  it("stops before a call when the total time is used up", async () => {
    let clock = 0;
    const draft = goalExplanation();
    const model = new FakeModel([
      (r) => {
        clock += 59_500;
        return answer(draft);
      },
    ]);
    await expect(run(model, 9_400, { now: () => clock })).rejects.toMatchObject({ code: "timeout" });
  });

  it("aborts when the caller's signal fires", async () => {
    const controller = new AbortController();
    const hang = (r: ChatRequest) =>
      new Promise<Error>((resolve) => {
        r.signal.addEventListener("abort", () => resolve(new ModelError("timeout", "aborted")));
        controller.abort();
      });
    await expect(run(new FakeModel([hang]), 9_400, { signal: controller.signal })).rejects.toMatchObject({ code: "timeout" });
  });

  it("keeps prompts, model text and keys out of the trace", async () => {
    const draft = goalExplanation();
    const out = await run(new FakeModel([answer(draft), approve(draft)]));
    const trace = JSON.stringify(out.trace);
    expect(trace).not.toContain(draft.headline);
    expect(trace).not.toContain("EVIDENCE");
  });
});
