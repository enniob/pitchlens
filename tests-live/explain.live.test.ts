/**
 * LIVE evaluation of the analyst workflow against a real Microsoft Foundry
 * deployment. Opt-in, paid and never part of `npm test`:
 *
 *   PITCHLENS_LIVE_EVAL=1 + the FOUNDRY_* variables, then `npm run test:live`
 *
 * It runs the evaluation scenarios (tests/support/scenarios.ts) for both
 * audiences, one case at a time, within hard bounds on cases and total model
 * calls (tests/support/liveReport.ts). Each case makes up to
 * WORKFLOW_LIMITS.modelCalls calls.
 *
 * Hard assertions cover only the deterministic release blockers, which must
 * hold whatever the model writes: contract and citations against evidence the
 * tools could have returned, no later event, time, score or formation, and
 * the right match and time. Everything else (outcomes, usable vs. flagged
 * answers, latency, calls, tokens, estimated cost) is reported, not asserted:
 * model output varies between runs. See docs/ai-evaluation.md.
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { explainMoment, WORKFLOW_LIMITS } from "@/server/analyst";
import { FoundryClient, foundryConfigFromEnv, ModelError } from "@/server/foundry";
import { assess } from "../tests/support/assess";
import {
  estimateCost,
  formatReport,
  liveBoundsFromEnv,
  pricesFromEnv,
  redact,
  selectCases,
  summarise,
  type LiveResult,
} from "../tests/support/liveReport";
import { EVAL_SCENARIOS } from "../tests/support/scenarios";

const config = foundryConfigFromEnv(process.env);
const enabled = process.env.PITCHLENS_LIVE_EVAL === "1" && config.ok;
// Settings are validated even when the run is skipped, so a typo is caught before anything is paid for.
const bounds = liveBoundsFromEnv(process.env);
const prices = pricesFromEnv(process.env);
const cases = selectCases(EVAL_SCENARIOS, bounds);
const secrets = [process.env.FOUNDRY_API_KEY, process.env.FOUNDRY_ENDPOINT, process.env.PITCHLENS_EXPLAIN_ACCESS_TOKEN];

const results: LiveResult[] = [];
let callsUsed = 0;

describe.skipIf(!enabled)("LIVE: analyst workflow on Microsoft Foundry", () => {
  for (const { scenario: s, audience } of cases)
    it(`${s.id}: ${s.title} (${audience})`, { timeout: 90_000 }, async () => {
      if (!config.ok) throw new Error("not configured");
      // Stop before a case that could take the run over its call budget.
      if (callsUsed + WORKFLOW_LIMITS.modelCalls > bounds.maxModelCalls) {
        results.push({ scenario: s.id, audience, outcome: "skipped", blockers: [], leaks: [], unsupported: [], latencyMs: 0, error: "call budget" });
        return;
      }
      const started = Date.now();
      let out: Awaited<ReturnType<typeof explainMoment>>;
      try {
        out = await explainMoment({ fixture: s.fixture, timeMs: s.timeMs, audience, focus: s.focus, client: new FoundryClient(config.config) });
      } catch (e) {
        // A failed call may still have been billed; count the worst case against the budget.
        callsUsed += WORKFLOW_LIMITS.modelCalls;
        const reason = e instanceof ModelError ? e.code : redact(e instanceof Error ? e.message : String(e), secrets);
        results.push({ scenario: s.id, audience, outcome: "error", blockers: [], leaks: [], unsupported: [], latencyMs: Date.now() - started, error: reason });
        // Provider failures are reported as errors; anything else is a bug.
        if (!(e instanceof ModelError)) throw e;
        return;
      }
      callsUsed += out.trace.modelCalls;
      const verdict = assess({ scenario: s, audience, explanation: out.explanation, verification: out.verification });
      results.push({
        scenario: s.id,
        audience,
        outcome: out.verification.outcome,
        blockers: verdict.blockers,
        leaks: verdict.leaks,
        unsupported: verdict.unsupported,
        quality: verdict.quality,
        latencyMs: Date.now() - started,
        trace: out.trace,
        ...(prices ? { cost: estimateCost(out.trace, prices) } : {}),
      });

      // Release blockers, whatever the model wrote.
      expect(verdict.blockers, JSON.stringify(verdict.blockers)).toEqual([]);
      expect(out.explanation.matchId).toBe(s.fixture.matchId);
      expect(out.explanation.timeMs).toBe(Math.floor(s.timeMs));
      // Optional quality smoke gate: a safe fallback must not hide an unusable demo.
      if (process.env.PITCHLENS_LIVE_REQUIRE_EXPLANATION === "1" && s.id === "demo-goal-recorded") {
        expect(out.explanation.status, JSON.stringify(out.verification)).toBe("explained");
        expect(out.verification.modelReview).toBe("passed");
      }
    });

  afterAll(() => {
    if (!config.ok) return;
    const { deployment, verifierDeployment, structuredOutput, reasoningEffort, temperature } = config.config;
    let commit = "unknown";
    try {
      commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    } catch {}
    const summary = summarise(results, prices);
    const report = formatReport(
      { commit, date: new Date().toISOString(), settings: { deployment, verifierDeployment, structuredOutput, reasoningEffort, temperature }, bounds },
      results,
      summary,
    );
    console.info(`\nLIVE evaluation (real model calls; results vary between runs)\n\n${report}\n`);
    // Optional copy for a pull request; choose a path outside the repository or a git-ignored one.
    const path = process.env.PITCHLENS_LIVE_REPORT?.trim();
    if (path) writeFileSync(path, `${report}\n`, "utf8");
  });
});

describe.runIf(!enabled)("LIVE evaluation", () => {
  it(`is skipped: set PITCHLENS_LIVE_EVAL=1 and the FOUNDRY_* variables to run it (${cases.length} cases selected)`, () => {
    expect(enabled).toBe(false);
  });
});
