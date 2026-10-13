/**
 * LIVE evaluation of the analyst workflow against a real Microsoft Foundry
 * deployment. Opt-in, paid and never part of `npm test`:
 *
 *   PITCHLENS_LIVE_EVAL=1 + the FOUNDRY_* variables, then `npm run test:live`
 *
 * It runs the evaluation scenarios (tests/support/scenarios.ts), and on
 * request the planted-instruction ones (tests/support/adversarial.ts), for both
 * audiences, one case at a time, within hard bounds on cases and total model
 * calls (tests/support/liveReport.ts). Each case makes up to
 * WORKFLOW_LIMITS.modelCalls calls.
 *
 * Hard assertions cover only the deterministic release blockers, which must
 * hold whatever the model writes: contract and citations against evidence the
 * tools could have returned, no later event, time, score or formation, and
 * the right match and time. The default release gate also requires every
 * selected case to complete with usable quality or honest insufficient
 * evidence. Exploratory runs may explicitly disable that gate.
 */
import { writeFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
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
  releaseFailures,
  type LiveResult,
} from "../tests/support/liveReport";
import { ADVERSARIAL_SCENARIOS } from "../tests/support/adversarial";
import { EVAL_SCENARIOS } from "../tests/support/scenarios";
import { evaluationRevision } from "../tests/support/revision";

const config = foundryConfigFromEnv(process.env);
if (process.env.PITCHLENS_LIVE_EVAL === "1" && !config.ok)
  throw new Error(`Live evaluation was explicitly enabled but configuration is missing or invalid: ${[...config.missing, ...config.invalid].join(", ")}`);
const enabled = process.env.PITCHLENS_LIVE_EVAL === "1" && config.ok;
// Settings are validated even when the run is skipped, so a typo is caught before anything is paid for.
const bounds = liveBoundsFromEnv(process.env);
const prices = pricesFromEnv(process.env);
const cases = selectCases([...EVAL_SCENARIOS, ...ADVERSARIAL_SCENARIOS], bounds);
const secrets = [process.env.FOUNDRY_API_KEY, process.env.FOUNDRY_ENDPOINT, process.env.PITCHLENS_EXPLAIN_ACCESS_TOKEN];

const results: LiveResult[] = [];
const revision = evaluationRevision();
let callsUsed = 0;
let lastFinished = 0;
const rawCooldown = process.env.PITCHLENS_LIVE_COOLDOWN_MS ?? "65000";
const cooldownMs = Number(rawCooldown);
if (!Number.isInteger(cooldownMs) || cooldownMs < 0 || cooldownMs > 120_000) throw new Error("Invalid PITCHLENS_LIVE_COOLDOWN_MS");

describe.skipIf(!enabled)("LIVE: analyst workflow on Microsoft Foundry", () => {
  afterEach(() => {
    const path = process.env.PITCHLENS_LIVE_REPORT?.trim();
    if (path) writeFileSync(`${path}.progress.json`, JSON.stringify({ revision, results }, null, 2), "utf8");
  });
  for (const { scenario: s, audience } of cases)
    it(`${s.id}: ${s.title} (${audience})`, { timeout: 210_000 }, async () => {
      if (!config.ok) throw new Error("not configured");
      // Stop before a case that could take the run over its call budget.
      if (callsUsed + WORKFLOW_LIMITS.modelCalls > bounds.maxModelCalls) {
        results.push({ scenario: s.id, audience, outcome: "skipped", blockers: [], leaks: [], unsupported: [], latencyMs: 0, error: "call budget" });
        return;
      }
      const wait = Math.max(0, lastFinished + cooldownMs - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const started = Date.now();
      let out: Awaited<ReturnType<typeof explainMoment>>;
      try {
        out = await explainMoment({ fixture: s.fixture, timeMs: s.timeMs, audience, focus: s.focus, client: new FoundryClient(config.config) });
      } catch (e) {
        lastFinished = Date.now();
        // A failed call may still have been billed; count the worst case against the budget.
        callsUsed += WORKFLOW_LIMITS.modelCalls;
        const reason = e instanceof ModelError ? e.code : redact(e instanceof Error ? e.message : String(e), secrets);
        results.push({ scenario: s.id, audience, outcome: "error", blockers: [], leaks: [], unsupported: [], latencyMs: Date.now() - started, error: reason });
        // Provider failures are reported as errors; anything else is a bug.
        if (!(e instanceof ModelError)) throw e;
        return;
      }
      lastFinished = Date.now();
      callsUsed += out.trace.modelCalls;
      const verdict = assess({ scenario: s, audience, explanation: out.explanation, verification: out.verification });
      results.push({
        scenario: s.id,
        audience,
        answer: redact(JSON.stringify({ explanation: out.explanation, verification: out.verification }, null, 2), secrets, 100_000),
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
      commit = revision;
    } catch {}
    const summary = summarise(results, prices);
    const failures = releaseFailures(results, cases);
    const report = formatReport(
      { commit, date: new Date().toISOString(), settings: { deployment, verifierDeployment, structuredOutput, reasoningEffort, temperature }, bounds },
      results,
      summary,
    ) + `\n\nRelease gate: ${process.env.PITCHLENS_LIVE_RELEASE_GATE === "0" ? "disabled (exploratory)" : failures.length ? "FAILED" : "passed"}. Coverage: ${results.filter((r) => r.outcome !== "error" && r.outcome !== "skipped").length}/${cases.length} selected cases answered.\n${failures.map((f) => `- ${f}`).join("\n")}`;
    console.info(`\nLIVE evaluation (real model calls; results vary between runs)\n\n${report}\n`);
    // Optional copy for a pull request; choose a path outside the repository or a git-ignored one.
    const path = process.env.PITCHLENS_LIVE_REPORT?.trim();
    if (path) writeFileSync(path, `${report}\n`, "utf8");
    expect(evaluationRevision(), "implementation changed during evaluation").toBe(revision);
    if (process.env.PITCHLENS_LIVE_RELEASE_GATE !== "0") {
      expect(failures, failures.join("\n")).toEqual([]);
    }
  });
});

describe.runIf(!enabled)("LIVE evaluation", () => {
  it(`is skipped: set PITCHLENS_LIVE_EVAL=1 and the FOUNDRY_* variables to run it (${cases.length} cases selected)`, () => {
    expect(enabled).toBe(false);
  });
});
