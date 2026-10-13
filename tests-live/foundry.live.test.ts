/**
 * Scores the answers retained by an earlier live run with Microsoft Foundry
 * cloud evaluation, without calling the analyst again. Opt-in and paid
 * (judge-model tokens); never part of `npm test`:
 *
 *   PITCHLENS_FOUNDRY_EVAL=1, FOUNDRY_PROJECT_ENDPOINT, FOUNDRY_EVAL_JUDGE_DEPLOYMENT,
 *   PITCHLENS_FOUNDRY_PROGRESS=<live report path>.progress.json, then `npm run eval:foundry`
 *
 * Reads the `foundry` rows the live runner exported (tests/support/foundryEval.ts),
 * so the evidence sent is exactly what the analyst received. Writes the
 * Foundry section to PITCHLENS_FOUNDRY_REPORT when set (use a git-ignored path).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { foundryEvalConfigFromEnv, scoreAndFormat, type ExcludedAnswer, type FoundryEvalRow } from "../tests/support/foundryEval";

const foundryEval = foundryEvalConfigFromEnv(process.env);
const progress = process.env.PITCHLENS_FOUNDRY_PROGRESS?.trim();
if (foundryEval.enabled && !foundryEval.ok)
  throw new Error(`Foundry evaluation was explicitly enabled but configuration is missing or invalid: ${[...foundryEval.missing, ...foundryEval.invalid].join(", ")}`);
const enabled = foundryEval.enabled && foundryEval.ok && Boolean(progress);

describe.skipIf(!enabled)("LIVE: Foundry cloud evaluation of retained answers", () => {
  it("scores the exported rows", { timeout: foundryEval.enabled && foundryEval.ok ? 2 * foundryEval.settings.timeoutMs + 300_000 : 5_000 }, async () => {
    if (!foundryEval.enabled || !foundryEval.ok || !progress) throw new Error("not configured");
    const saved = JSON.parse(readFileSync(progress, "utf8")) as { revision?: string; scenarioSet?: string; foundry?: { rows: FoundryEvalRow[]; excluded: ExcludedAnswer[] } };
    if (!saved.foundry || !Array.isArray(saved.foundry.rows))
      throw new Error("The progress file has no exported Foundry rows; rerun the live evaluation with this version of the runner.");
    const { createEvalsApi, FOUNDRY_EVAL_SDK } = await import("../tests/support/foundryClient");
    const section = await scoreAndFormat(saved.foundry, foundryEval.settings, saved.revision ?? "unknown",
      () => createEvalsApi(foundryEval.settings.projectEndpoint), FOUNDRY_EVAL_SDK);
    const text = `Retained answers from revision \`${saved.revision ?? "unknown"}\`; scenario set ${saved.scenarioSet ?? "unknown"}.\n\n${section}\n`;
    console.info(`\n${text}`);
    const out = process.env.PITCHLENS_FOUNDRY_REPORT?.trim();
    if (out) writeFileSync(out, text, "utf8");
    expect(section).toContain("Microsoft Foundry cloud evaluation");
  });
});

describe.runIf(!enabled)("LIVE Foundry evaluation", () => {
  it("is skipped: set PITCHLENS_FOUNDRY_EVAL=1, FOUNDRY_PROJECT_ENDPOINT, FOUNDRY_EVAL_JUDGE_DEPLOYMENT and PITCHLENS_FOUNDRY_PROGRESS to run it", () => {
    expect(enabled).toBe(false);
  });
});
