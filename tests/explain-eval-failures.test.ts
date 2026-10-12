/**
 * Offline evaluation of failure handling on the evaluation scenarios: the
 * bounded analyst/verifier workflow, the HTTP handler and the browser client
 * with a scripted model. Every path must end in a safe answer or a safe
 * error; none may show a rejected draft. See docs/ai-evaluation.md.
 */
import { describe, expect, it, vi } from "vitest";
import type { Audience, ExplainApiResponse, ExplainSuccess } from "@/explain/api";
import { requestExplanation } from "@/explain/client";
import { matchReferenceOf } from "@/explain/matchRef";
import { sampleFixture } from "@/match/fixture";
import { explainMoment } from "@/server/analyst";
import { handleExplain, type ExplainDeps } from "@/server/explainHandler";
import { ModelError, type ChatRequest, type ChatResult } from "@/server/foundry";
import { AnswerCache, RequestGuard } from "@/server/guard";
import { assess } from "./support/assess";
import { evidenceFor, groundedDraft, verifierRejecting } from "./support/drafts";
import { answer, approve, FakeModel, type Step } from "./support/fakeModel";
import { EVAL_AUDIENCES, EVAL_SCENARIOS, type EvalScenario } from "./support/scenarios";

const cases = EVAL_SCENARIOS.flatMap((s) => EVAL_AUDIENCES.map((audience) => ({ s, audience, name: `${s.id} (${audience})` })));
const run = (s: EvalScenario, audience: Audience, steps: Step[], limits = {}) =>
  explainMoment({ fixture: s.fixture, timeMs: s.timeMs, audience, focus: s.focus, client: new FakeModel(steps), limits });
const other = (s: EvalScenario) => EVAL_SCENARIOS.find((x) => x.fixture.matchId !== s.fixture.matchId)!;

/** Ways an analyst answer can be malformed or unsupported, each with the issue it must be rejected for. */
function malformed(s: EvalScenario, audience: Audience): { label: string; result: ChatResult; issue: RegExp }[] {
  const good = groundedDraft(s, audience);
  const future = s.fixture.events.find((e) => e.t > s.timeMs);
  const cite = (ref: unknown) => ({ ...good, status: "explained", facts: [{ text: "A match event occurred.", evidence: [ref] }] });
  const list = [
    { label: "not JSON", result: answer("Here is the explanation: Harbor City scored."), issue: /not valid JSON/ },
    { label: "cut off at the token limit", result: { ...answer(JSON.stringify(good).slice(0, 80)), finishReason: "length" }, issue: /not valid JSON/ },
    { label: "a verifier-shaped object", result: answer({ reviews: [] }), issue: /unexpected field reviews/ },
    { label: "an invented event", result: answer(cite({ kind: "event", id: "e99-invented" })), issue: /e99-invented/ },
    { label: "a snapshot that does not exist", result: answer(cite({ kind: "snapshot", t: s.timeMs + 0.5 })), issue: /snapshot/ },
    { label: "another match", result: answer({ ...good, matchId: other(s).fixture.matchId }), issue: /matchId/ },
    { label: "another time", result: answer({ ...good, timeMs: Math.max(0, s.timeMs - 1) }), issue: /timeMs/ },
    { label: "intent stated as fact", result: answer({ ...cite({ kind: "snapshot", t: evidenceFor(s).time.positionsAtMs }), facts: [{ text: "The defender deliberately stepped up.", evidence: [{ kind: "snapshot", t: evidenceFor(s).time.positionsAtMs }] }] }), issue: /intent or cause/ },
  ];
  if (future) list.push({ label: `a later event (${future.id})`, result: answer(cite({ kind: "event", id: future.id })), issue: new RegExp(future.id) });
  return list;
}

const shown = (r: { headline: string; explanation: string; facts: { text: string }[] }) => [r.headline, r.explanation, ...r.facts.map((f) => f.text)].join(" ");
const expectSafe = (s: EvalScenario, audience: Audience, out: Awaited<ReturnType<typeof explainMoment>>) => {
  const verdict = assess({ scenario: s, audience, explanation: out.explanation, verification: out.verification });
  expect(verdict.blockers).toEqual([]);
  expect(verdict.leaks).toEqual([]);
  return verdict;
};

describe("failure handling on the evaluation scenarios", () => {
  it.each(cases)("$name: each malformed or unsupported answer is rejected, and a grounded revision is shown instead", async ({ s, audience }) => {
    const good = groundedDraft(s, audience);
    for (const m of malformed(s, audience)) {
      const out = await run(s, audience, [m.result, answer(good), approve(good)]);
      expect(out.verification.revisions, m.label).toBe(1);
      expect(out.verification.outcome, m.label).toBe(good.status === "explained" ? "revised" : "insufficient-evidence");
      expect(out.verification.issues.join(" "), m.label).toMatch(m.issue);
      expect(shown(out.explanation), m.label).not.toContain("A match event occurred");
      expectSafe(s, audience, out);
    }
  });

  it.each(cases)("$name: a malformed answer twice ends in the fallback: safe, but not usable", async ({ s, audience }) => {
    for (const m of malformed(s, audience)) {
      const out = await run(s, audience, [m.result, m.result]);
      expect(out.verification, m.label).toMatchObject({ outcome: "fallback", revisions: 1, modelReview: "skipped" });
      expect(out.explanation.status).toBe("insufficient-evidence");
      const verdict = expectSafe(s, audience, out);
      expect(["not-explained", "honest-insufficient"]).toContain(verdict.quality);
    }
  });

  const explained = cases.filter(({ s, audience }) => groundedDraft(s, audience).status === "explained");

  it.each(explained)("$name: a draft the verifier rejects twice ends in the fallback", async ({ s, audience }) => {
    const good = groundedDraft(s, audience);
    const out = await run(s, audience, [answer(good), verifierRejecting(/./), answer(good), verifierRejecting(/./)]);
    expect(out.verification).toMatchObject({ outcome: "fallback", revisions: 1, grounding: "passed", modelReview: "failed" });
    expect(out.verification.issues.join(" ")).toContain("not supported");
    expectSafe(s, audience, out);
  });

  it.each(explained)("$name: an unusable review ends in the fallback without a revision", async ({ s, audience }) => {
    const good = groundedDraft(s, audience);
    for (const review of [answer("not json"), answer({ reviews: [{ target: "headline", verdict: "supported", reason: "" }] }), answer({ reviews: [{ target: "facts", verdict: "maybe", reason: "" }] })]) {
      const model = new FakeModel([answer(good), review]);
      const out = await explainMoment({ fixture: s.fixture, timeMs: s.timeMs, audience, focus: s.focus, client: model });
      expect(out.verification).toMatchObject({ outcome: "fallback", revisions: 0, modelReview: "failed" });
      expect(model.requests).toHaveLength(2);
      expectSafe(s, audience, out);
    }
  });

  it.each(cases)("$name: provider failures and timeouts are errors, never an explanation", async ({ s, audience }) => {
    const good = groundedDraft(s, audience);
    await expect(run(s, audience, [new ModelError("provider-error", "HTTP 500")])).rejects.toMatchObject({ code: "provider-error" });
    await expect(run(s, audience, [new ModelError("rate-limited", "busy", 3_000)])).rejects.toMatchObject({ code: "rate-limited", retryAfterMs: 3_000 });
    // The verifier failing after a good draft is still an error, not an unreviewed answer.
    if (good.status === "explained")
      await expect(run(s, audience, [answer(good), new ModelError("bad-provider-response", "no message")])).rejects.toMatchObject({ code: "bad-provider-response" });
    const slow = (r: ChatRequest) => new Promise<Error>((resolve) => r.signal.addEventListener("abort", () => resolve(new ModelError("timeout", "slow"))));
    await expect(run(s, audience, [slow], { modelCallMs: 10 })).rejects.toMatchObject({ code: "timeout" });
  });

  it.each(explained)("$name: running out of calls or tokens ends in the fallback", async ({ s, audience }) => {
    const good = groundedDraft(s, audience);
    const calls = await run(s, audience, [answer(good), approve(good)], { modelCalls: 1 });
    expect(calls.verification.outcome).toBe("fallback");
    const tokens = await run(s, audience, [answer(good, { prompt: 79_000, completion: 500 }), approve(good)]);
    expect(tokens.verification.outcome).toBe("fallback");
    expectSafe(s, audience, calls);
    expectSafe(s, audience, tokens);
  });
});

const KEY = "eval-secret-key-0123456789";
const ENV = { FOUNDRY_ENDPOINT: "https://eval.openai.azure.com", FOUNDRY_API_KEY: KEY, FOUNDRY_DEPLOYMENT: "eval-analyst" };

function handler(steps: Step[]) {
  const model = new FakeModel(steps);
  const deps: ExplainDeps = { env: ENV, createClient: () => model, guard: new RequestGuard(), cache: new AnswerCache(), log: () => {} };
  const post = (s: EvalScenario, audience: Audience, timeMs = s.timeMs) =>
    handleExplain(
      new Request("https://pitchlens.example/api/explain", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ match: matchReferenceOf(s.fixture, sampleFixture.matchId), timeMs, audience, ...(s.focus === "match" ? { focus: "match" } : {}) }),
      }),
      deps,
    ).then(async (r) => ({ status: r.status, text: await r.clone().text(), json: (await r.json()) as ExplainApiResponse }));
  return { model, deps, post };
}

describe("the endpoint on the evaluation scenarios", () => {
  it.each(EVAL_SCENARIOS)("$id: answers for the requested match, time and audience only", async (s) => {
    const casual = groundedDraft(s, "casual");
    const analyst = groundedDraft(s, "analyst");
    const steps: Step[] = [answer(casual), approve(casual), answer(analyst), approve(analyst)];
    const { model, post } = handler(steps.filter((_, i) => casual.status === "explained" || i % 2 === 0));
    for (const [audience, draft] of [["casual", casual], ["analyst", analyst]] as const) {
      const { status, json } = await post(s, audience);
      expect(status).toBe(200);
      const ok = json as ExplainSuccess;
      expect(ok).toMatchObject({ ok: true, matchId: s.fixture.matchId, timeMs: Math.floor(s.timeMs), audience, focus: s.focus, cached: false });
      expect(ok.explanation).toEqual(draft.status === "explained" ? draft : expect.objectContaining({ status: "insufficient-evidence" }));
      expect(assess({ scenario: s, audience, explanation: ok.explanation, verification: ok.verification, envelope: ok }).blockers).toEqual([]);
    }
    // The second audience was not served from the first one's cache.
    expect(model.requests.filter((r) => r.role === "analyst")).toHaveLength(2);
    expect((await post(s, "casual")).json).toMatchObject({ cached: true, audience: "casual" });
  });

  it.each(EVAL_SCENARIOS.filter((s) => s.focus === "moment" && s.timeMs > 0))("$id: never serves a cached answer for another time", async (s) => {
    const draft = groundedDraft(s, "analyst");
    const earlier = { ...s, timeMs: s.timeMs - 1 };
    const { post } = handler([answer(draft), approve(draft), new ModelError("provider-error", "down")]);
    expect((await post(s, "analyst")).status).toBe(200);
    const res = await post(earlier, "analyst");
    expect(res.status).toBe(502);
  });

  it.each(EVAL_SCENARIOS)("$id: maps failures to safe errors without leaking the key, and does not cache a fallback", async (s) => {
    const good = groundedDraft(s, "analyst");
    const slow = (r: ChatRequest) => new Promise<Error>((resolve) => r.signal.addEventListener("abort", () => resolve(new ModelError("timeout", "slow"))));
    const { post, deps } = handler([
      new ModelError("provider-error", `HTTP 500 ${KEY}`),
      new ModelError("rate-limited", "busy", 2_000),
      slow,
      answer("not json"),
      answer("still not json"),
      answer(good),
      approve(good),
    ]);
    deps.limits = { modelCallMs: 10 };
    const results = [await post(s, "analyst"), await post(s, "analyst"), await post(s, "analyst")];
    expect(results.map((r) => r.status)).toEqual([502, 503, 504]);
    expect(results.map((r) => (r.json.ok ? "" : r.json.error.code))).toEqual(["upstream-error", "upstream-rate-limited", "timeout"]);
    for (const r of results) expect(r.text).not.toContain(KEY);
    deps.limits = undefined;
    const fallback = await post(s, "analyst");
    expect(fallback.json).toMatchObject({ ok: true, verification: { outcome: "fallback" }, cached: false });
    const retry = await post(s, "analyst");
    expect(retry.json).toMatchObject({ ok: true, cached: false, verification: { outcome: good.status === "explained" ? "verified" : "insufficient-evidence" } });
  });
});

describe("the viewer client on the evaluation scenarios", () => {
  const signal = new AbortController().signal;
  const envelope = (s: EvalScenario, audience: Audience) => ({
    apiVersion: "1.0.0", ok: true, requestId: "eval-request-1", matchId: s.fixture.matchId, timeMs: Math.floor(s.timeMs), audience, focus: s.focus,
    explanation: groundedDraft(s, audience),
    verification: { outcome: "verified", revisions: 0, schema: "passed", grounding: "passed", modelReview: "passed", issues: [] },
    trace: { totalMs: 1, modelCalls: 2, toolCalls: 0, tokens: { prompt: 1, completion: 1 }, chargedTokens: 2, steps: [] }, cached: false,
  });
  const reply = (body: unknown) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  const ask = (s: EvalScenario, audience: Audience, body: unknown) =>
    requestExplanation(s.fixture, sampleFixture.matchId, s.timeMs, audience, signal, reply(body), s.focus);

  it.each(cases)("$name: shows its own answer, and refuses one for another match, time or audience", async ({ s, audience }) => {
    await expect(ask(s, audience, envelope(s, audience))).resolves.toMatchObject({ matchId: s.fixture.matchId });
    const otherAudience: Audience = audience === "casual" ? "analyst" : "casual";
    await expect(ask(s, audience, envelope(s, otherAudience))).rejects.toThrow("does not match");
    await expect(ask(s, audience, envelope(other(s), audience))).rejects.toThrow("does not match");
    await expect(ask(s, audience, { ...envelope(s, audience), timeMs: Math.floor(s.timeMs) + 1 })).rejects.toThrow("does not match");
    // A copy of another scenario's explanation under this scenario's envelope fails the evidence check.
    const foreign = { ...envelope(s, audience), explanation: groundedDraft(other(s), audience) };
    await expect(ask(s, audience, foreign)).rejects.toThrow();
  });
});
