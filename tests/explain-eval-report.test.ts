/** The live evaluation's bounds, cost estimate and report, tested offline (no model calls). */
import { describe, expect, it } from "vitest";
import type { ExplainTrace } from "@/explain/api";
import { WORKFLOW_LIMITS } from "@/server/analyst";
import {
  estimateCost,
  formatReport,
  LIVE_CEILINGS,
  LIVE_DEFAULT_CASES,
  liveBoundsFromEnv,
  pricesFromEnv,
  redact,
  selectCases,
  summarise,
  type LiveResult,
} from "./support/liveReport";
import { EVAL_SCENARIOS } from "./support/scenarios";

const trace = (calls: { role: "analyst" | "verifier"; prompt: number; completion: number }[]): ExplainTrace => ({
  totalMs: 1_000,
  modelCalls: calls.length,
  toolCalls: 1,
  tokens: { prompt: calls.reduce((n, c) => n + c.prompt, 0), completion: calls.reduce((n, c) => n + c.completion, 0) },
  chargedTokens: 0,
  steps: calls.map((c) => ({ kind: "model", role: c.role, ms: 1, finishReason: "stop", toolCalls: 0, tokens: { prompt: c.prompt, completion: c.completion } })),
});
const result = (extra: Partial<LiveResult>): LiveResult => ({ scenario: "demo-goal-recorded", audience: "casual", outcome: "verified", blockers: [], leaks: [], unsupported: [], latencyMs: 2_000, ...extra });

describe("live evaluation bounds", () => {
  it("default to the live scenarios for both audiences, within the case and call limits", () => {
    const bounds = liveBoundsFromEnv({});
    expect(bounds).toEqual({ scenarios: "default", audiences: ["casual", "analyst"], maxCases: LIVE_DEFAULT_CASES, maxModelCalls: LIVE_DEFAULT_CASES * WORKFLOW_LIMITS.modelCalls });
    const cases = selectCases(EVAL_SCENARIOS, bounds);
    expect(cases.length).toBeLessThanOrEqual(LIVE_DEFAULT_CASES);
    expect(new Set(cases.map((c) => c.scenario.id))).toEqual(new Set(EVAL_SCENARIOS.filter((s) => s.live).map((s) => s.id)));
    expect(cases.filter((c) => c.audience === "casual")).toHaveLength(cases.length / 2);
  });

  it("can select scenarios and audiences, but never beyond the hard ceilings", () => {
    const some = liveBoundsFromEnv({ PITCHLENS_LIVE_SCENARIOS: "seed2-offside-kick-frame, demo-sparse", PITCHLENS_LIVE_AUDIENCES: "analyst", PITCHLENS_LIVE_MAX_CASES: "1" });
    expect(selectCases(EVAL_SCENARIOS, some).map((c) => [c.scenario.id, c.audience])).toEqual([["seed2-offside-kick-frame", "analyst"]]);
    const all = liveBoundsFromEnv({ PITCHLENS_LIVE_SCENARIOS: "all", PITCHLENS_LIVE_MAX_CASES: "10000", PITCHLENS_LIVE_MAX_MODEL_CALLS: "10000" });
    expect(all).toMatchObject({ maxCases: LIVE_CEILINGS.cases, maxModelCalls: LIVE_CEILINGS.modelCalls });
    expect(selectCases(EVAL_SCENARIOS, all)).toHaveLength(Math.min(LIVE_CEILINGS.cases, EVAL_SCENARIOS.length * 2));
  });

  it("refuse malformed settings and unknown scenarios, naming the setting but not its value", () => {
    expect(() => liveBoundsFromEnv({ PITCHLENS_LIVE_MAX_CASES: "-3" })).toThrow("PITCHLENS_LIVE_MAX_CASES");
    expect(() => liveBoundsFromEnv({ PITCHLENS_LIVE_MAX_MODEL_CALLS: "lots" })).toThrow("PITCHLENS_LIVE_MAX_MODEL_CALLS");
    expect(() => liveBoundsFromEnv({ PITCHLENS_LIVE_AUDIENCES: "pundit" })).toThrow("PITCHLENS_LIVE_AUDIENCES");
    expect(() => selectCases(EVAL_SCENARIOS, liveBoundsFromEnv({ PITCHLENS_LIVE_SCENARIOS: "nope" }))).toThrow("nope");
  });
});

describe("live evaluation cost", () => {
  it("is not estimated without prices, and uses per-role prices per million tokens", () => {
    expect(pricesFromEnv({})).toBeNull();
    const prices = pricesFromEnv({ PITCHLENS_PRICE_INPUT_PER_MTOK: "2", PITCHLENS_PRICE_OUTPUT_PER_MTOK: "8", PITCHLENS_PRICE_VERIFIER_INPUT_PER_MTOK: "0.5" })!;
    expect(prices).toEqual({ currency: "USD", analyst: { input: 2, output: 8 }, verifier: { input: 0.5, output: 8 } });
    const cost = estimateCost(trace([{ role: "analyst", prompt: 10_000, completion: 500 }, { role: "verifier", prompt: 8_000, completion: 200 }]), prices);
    // 10 000 × 2 + 500 × 8 + 8 000 × 0.5 + 200 × 8, per million.
    expect(cost.amount).toBeCloseTo(0.0296, 10);
    expect(cost.complete).toBe(true);
  });

  it("is marked as a lower bound when a call reported no usage", () => {
    const prices = pricesFromEnv({ PITCHLENS_PRICE_INPUT_PER_MTOK: "1", PITCHLENS_PRICE_OUTPUT_PER_MTOK: "1" })!;
    const t = trace([{ role: "analyst", prompt: 1_000_000, completion: 0 }]);
    t.steps.push({ kind: "model", role: "verifier", ms: 1, finishReason: "stop", toolCalls: 0, tokens: null });
    t.modelCalls = 2;
    expect(estimateCost(t, prices)).toEqual({ amount: 1, complete: false });
  });

  it("rejects incomplete or negative prices", () => {
    expect(() => pricesFromEnv({ PITCHLENS_PRICE_INPUT_PER_MTOK: "2" })).toThrow("both required");
    expect(() => pricesFromEnv({ PITCHLENS_PRICE_INPUT_PER_MTOK: "-1", PITCHLENS_PRICE_OUTPUT_PER_MTOK: "1" })).toThrow("PITCHLENS_PRICE_INPUT_PER_MTOK");
  });
});

describe("live evaluation report", () => {
  const prices = pricesFromEnv({ PITCHLENS_PRICE_INPUT_PER_MTOK: "1", PITCHLENS_PRICE_OUTPUT_PER_MTOK: "4", PITCHLENS_PRICE_CURRENCY: "EUR" })!;
  const t = trace([{ role: "analyst", prompt: 5_000, completion: 300 }, { role: "verifier", prompt: 4_000, completion: 100 }]);
  const results: LiveResult[] = [
    result({ quality: "usable", trace: t, cost: estimateCost(t, prices), latencyMs: 4_000 }),
    result({ audience: "analyst", outcome: "fallback", quality: "not-explained", trace: t, cost: estimateCost(t, prices), latencyMs: 9_000 }),
    result({ scenario: "demo-sparse", outcome: "insufficient-evidence", quality: "honest-insufficient", trace: t, cost: estimateCost(t, prices) }),
    result({ scenario: "seed9-goal-recorded", outcome: "verified", quality: "needs-review", leaks: ["facts[0] states x"], trace: t, cost: estimateCost(t, prices) }),
    result({ scenario: "seed9-goal-recorded", audience: "analyst", outcome: "error", error: "rate-limited", latencyMs: 500 }),
    result({ scenario: "seed20-recap-two-goals", outcome: "skipped", error: "call budget", latencyMs: 0 }),
  ];

  it("counts outcomes, and keeps safety separate from a usable explanation", () => {
    const s = summarise(results, prices);
    expect(s.outcomes).toEqual({ verified: 2, revised: 0, "insufficient-evidence": 1, fallback: 1, error: 1, skipped: 1 });
    // Four answers passed safety, but only one is a usable explanation.
    expect(s).toMatchObject({ safetyPassed: 4, safetyFailed: 0, usable: 1, honestInsufficient: 1, needsReview: 1, modelCalls: 8, toolCalls: 4 });
    expect(s.tokens).toEqual({ input: 36_000, output: 1_600 });
    expect(s.cost).toEqual({ amount: expect.closeTo((36_000 * 1 + 1_600 * 4) / 1e6, 10), currency: "EUR", complete: true });
    expect(s.latencyMs).toEqual({ median: 2_000, max: 9_000 });
  });

  it("names deployments and settings, never the endpoint or key", () => {
    const report = formatReport(
      { commit: "abc1234", date: "2026-10-12T00:00:00Z", settings: { deployment: "eval-analyst", verifierDeployment: "eval-verifier", reasoningEffort: undefined }, bounds: liveBoundsFromEnv({}) },
      results,
      summarise(results, prices),
    );
    expect(report).toContain("`abc1234`");
    expect(report).toContain("deployment=eval-analyst, verifierDeployment=eval-verifier");
    expect(report).not.toContain("reasoningEffort");
    expect(report).toContain("verified 2 · revised 0 · insufficient evidence 1 · fallback 1 · error 1 · skipped 1");
    expect(report).toContain("Usable explanations: 1");
    expect(report).toContain("EUR");
    expect(report).toContain("leak? facts[0] states x");
    expect(report).toMatch(/not proof of factual correctness/);
    expect(formatReport({ commit: "x", date: "d", settings: {}, bounds: liveBoundsFromEnv({}) }, [], summarise([], null))).toContain("not estimated");
  });

  it("redacts secrets from error text", () => {
    const key = "sk-live-0123456789abcdef";
    const text = redact(`fetch failed for https://res.openai.azure.com with api-key: ${key} and ${key}`, [key, "https://res.openai.azure.com"]);
    expect(text).not.toContain(key);
    expect(text).not.toContain("res.openai.azure.com");
    expect(redact("Authorization: Bearer abc.def", [])).toBe("Authorization: [redacted]");
  });
});
