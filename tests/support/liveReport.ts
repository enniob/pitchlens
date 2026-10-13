/**
 * Bounds, cost estimate and report for the opt-in live evaluation
 * (tests-live/explain.live.test.ts). Pure, so it is tested offline in
 * tests/explain-eval-report.test.ts.
 *
 * Nothing here reads or prints credentials: the report names deployments and
 * model settings, never the endpoint or the key, and error text is redacted.
 */
import type { Audience, ExplainTrace, VerificationSummary } from "@/explain/api";
import { WORKFLOW_LIMITS } from "@/server/analyst";
import type { ExplanationResponse } from "@/explain/response";
import type { Quality } from "./assess";
import type { ModelFailureDiagnostics } from "@/server/foundry";
import { assessAudiences, type AudienceAssessment } from "./audience";
import { EVAL_AUDIENCES, type EvalScenario } from "./scenarios";

type Env = Record<string, string | undefined>;

/** Hard ceilings, whatever the environment asks for. */
export const LIVE_CEILINGS = { cases: 40, modelCalls: 320 } as const;
export const LIVE_DEFAULT_CASES = 14;

export interface LiveBounds {
  /** `all`: the scenario matrix; `adversarial`: the planted-instruction scenarios; or IDs from either. */
  scenarios: "default" | "all" | "adversarial" | string[];
  audiences: Audience[];
  maxCases: number;
  /** Model calls for the whole run. A case starts only if a worst-case workflow still fits. */
  maxModelCalls: number;
}

const positiveInt = (env: Env, name: string, fallback: number, ceiling: number, errors: string[]): number => {
  const raw = env[name]?.trim();
  if (!raw) return Math.min(fallback, ceiling);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    errors.push(name);
    return fallback;
  }
  return Math.min(n, ceiling);
};

/** Reads the live-run bounds. Throws, naming the variable but not its value, when one is malformed. */
export function liveBoundsFromEnv(env: Env): LiveBounds {
  const errors: string[] = [];
  const list = (name: string) => env[name]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const ids = list("PITCHLENS_LIVE_SCENARIOS");
  const keyword = ids.length === 1 && ["default", "all", "adversarial"].includes(ids[0]!) ? (ids[0] as "default" | "all" | "adversarial") : undefined;
  const scenarios = ids.length === 0 ? "default" : keyword ?? ids;
  const audiences = list("PITCHLENS_LIVE_AUDIENCES");
  if (audiences.some((a) => !(EVAL_AUDIENCES as readonly string[]).includes(a))) errors.push("PITCHLENS_LIVE_AUDIENCES");
  const maxCases = positiveInt(env, "PITCHLENS_LIVE_MAX_CASES", LIVE_DEFAULT_CASES, LIVE_CEILINGS.cases, errors);
  const maxModelCalls = positiveInt(env, "PITCHLENS_LIVE_MAX_MODEL_CALLS", maxCases * WORKFLOW_LIMITS.modelCalls, LIVE_CEILINGS.modelCalls, errors);
  if (errors.length > 0) throw new Error(`Invalid live evaluation settings: ${errors.join(", ")}`);
  return { scenarios, audiences: audiences.length > 0 ? (audiences as Audience[]) : [...EVAL_AUDIENCES], maxCases, maxModelCalls };
}

/** The cases a live run makes, in order, at most `maxCases`. Unknown scenario IDs throw. */
export function selectCases(all: readonly EvalScenario[], bounds: LiveBounds): { scenario: EvalScenario; audience: Audience }[] {
  let picked: EvalScenario[];
  if (bounds.scenarios === "default") picked = all.filter((s) => s.live && !s.injected);
  else if (bounds.scenarios === "all") picked = all.filter((s) => !s.injected);
  else if (bounds.scenarios === "adversarial") picked = all.filter((s) => s.injected);
  else {
    const unknown = bounds.scenarios.filter((id) => !all.some((s) => s.id === id));
    if (unknown.length > 0) throw new Error(`Unknown evaluation scenario(s): ${unknown.join(", ")}`);
    picked = bounds.scenarios.map((id) => all.find((s) => s.id === id)!);
  }
  return picked.flatMap((scenario) => bounds.audiences.map((audience) => ({ scenario, audience }))).slice(0, bounds.maxCases);
}

export interface Prices {
  currency: string;
  /** Per million tokens. */
  analyst: { input: number; output: number };
  verifier: { input: number; output: number };
}

/**
 * Prices per million tokens from the environment, or null when none are set
 * (the report then says the cost was not estimated). The verifier defaults to
 * the analyst's prices. Set them from your own deployment's price sheet.
 */
export function pricesFromEnv(env: Env): Prices | null {
  const names = ["PITCHLENS_PRICE_INPUT_PER_MTOK", "PITCHLENS_PRICE_OUTPUT_PER_MTOK", "PITCHLENS_PRICE_VERIFIER_INPUT_PER_MTOK", "PITCHLENS_PRICE_VERIFIER_OUTPUT_PER_MTOK"];
  const values = names.map((n) => env[n]?.trim() || undefined);
  if (values.every((v) => v === undefined)) return null;
  const bad = names.filter((n, i) => values[i] !== undefined && !(Number.isFinite(Number(values[i])) && Number(values[i]) >= 0));
  if (values[0] === undefined || values[1] === undefined) bad.push("PITCHLENS_PRICE_INPUT_PER_MTOK and PITCHLENS_PRICE_OUTPUT_PER_MTOK are both required");
  if (bad.length > 0) throw new Error(`Invalid price settings: ${bad.join(", ")}`);
  const [input, output, vInput, vOutput] = values.map((v) => (v === undefined ? undefined : Number(v)));
  return {
    currency: env.PITCHLENS_PRICE_CURRENCY?.trim() || "USD",
    analyst: { input: input!, output: output! },
    verifier: { input: vInput ?? input!, output: vOutput ?? output! },
  };
}

/** Estimated inference cost of one workflow, from the per-call token counts in its trace. */
export function estimateCost(trace: ExplainTrace, prices: Prices): { amount: number; complete: boolean } {
  let amount = 0;
  let calls = 0;
  let complete = true;
  for (const step of trace.steps) {
    if (step.kind !== "model") continue;
    calls++;
    if (!step.tokens) {
      complete = false;
      continue;
    }
    const p = prices[step.role];
    amount += (step.tokens.prompt * p.input + step.tokens.completion * p.output) / 1_000_000;
  }
  // The trace keeps a bounded number of steps; a call missing from it cannot be priced.
  if (calls < trace.modelCalls) complete = false;
  return { amount, complete };
}

export type LiveOutcome = VerificationSummary["outcome"] | "error" | "skipped";

export interface LiveResult {
  /** Redacted JSON of the final answer and verification, retained for manual review. */
  answer?: string;
  scenario: string;
  audience: Audience;
  outcome: LiveOutcome;
  /** Deterministic release blockers (empty = safety passed). Empty for errors and skipped cases. */
  blockers: string[];
  leaks: string[];
  unsupported: string[];
  quality?: Quality;
  latencyMs: number;
  trace?: ExplainTrace;
  cost?: { amount: number; complete: boolean };
  /** Error code or reason, redacted. */
  error?: string;
  diagnostics?: ModelFailureDiagnostics;
}

/** Removes every occurrence of each secret (and anything that looks like a bearer or api-key header). */
export function redact(text: string, secrets: (string | undefined)[], limit = 200): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  return out.replace(/(api-key|authorization)\s*[:=]\s*(bearer\s+)?\S+/gi, "$1: [redacted]").slice(0, limit);
}

/** Release gates apply to every selected case, including provider failures. */
export function releaseFailures(results: LiveResult[], expected: { scenario: { id: string }; audience: Audience }[]): string[] {
  const failures: string[] = [];
  for (const c of expected) {
    const matches = results.filter((r) => r.scenario === c.scenario.id && r.audience === c.audience);
    const label = `${c.scenario.id} (${c.audience})`;
    if (matches.length !== 1) { failures.push(`${label}: missing or duplicate result`); continue; }
    const r = matches[0]!;
    if (r.outcome === "error" || r.outcome === "skipped" || r.outcome === "fallback") failures.push(`${label}: ${r.outcome}`);
    else if (r.blockers.length || r.leaks.length || r.unsupported.length || !["usable", "honest-insufficient"].includes(r.quality ?? "")) failures.push(`${label}: safety or quality gate failed`);
    if (r.outcome !== "error" && r.outcome !== "skipped" && !r.answer) failures.push(`${label}: answer was not retained`);
  }
  for (const p of audiencePairs(results)) for (const c of p.conflicts) failures.push(`${p.scenario} (both audiences): ${c}`);
  return failures;
}

/** The final explanation in a retained answer, or undefined when it was not retained or cannot be read. */
function retainedExplanation(r: LiveResult): ExplanationResponse | undefined {
  try {
    return r.answer ? (JSON.parse(r.answer) as { explanation: ExplanationResponse }).explanation : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The paired audience assessment for every scenario where both audiences
 * returned an answer. Conflicts fail the release gate; readability and detail
 * flags are for human review.
 */
export function audiencePairs(results: LiveResult[]): ({ scenario: string } & AudienceAssessment)[] {
  const out: ({ scenario: string } & AudienceAssessment)[] = [];
  for (const scenario of [...new Set(results.map((r) => r.scenario))]) {
    const [casual, analyst] = (["casual", "analyst"] as const).map((a) => {
      const r = results.find((x) => x.scenario === scenario && x.audience === a);
      return r && retainedExplanation(r);
    });
    if (casual && analyst) out.push({ scenario, ...assessAudiences(casual, analyst) });
  }
  return out;
}

export interface LiveSummary {
  runs: number;
  outcomes: Record<LiveOutcome, number>;
  /** Answered with no deterministic release blocker. */
  safetyPassed: number;
  safetyFailed: number;
  /** Shown explanations covering the expected facts with nothing flagged. */
  usable: number;
  honestInsufficient: number;
  needsReview: number;
  modelCalls: number;
  toolCalls: number;
  tokens: { input: number; output: number };
  latencyMs: { median: number; max: number };
  cost: { amount: number; currency: string; complete: boolean } | null;
}

export function summarise(results: LiveResult[], prices: Prices | null): LiveSummary {
  const outcomes: Record<LiveOutcome, number> = { verified: 0, revised: 0, "insufficient-evidence": 0, fallback: 0, error: 0, skipped: 0 };
  for (const r of results) outcomes[r.outcome]++;
  const answered = results.filter((r) => r.outcome !== "error" && r.outcome !== "skipped");
  const latencies = results.filter((r) => r.outcome !== "skipped").map((r) => r.latencyMs).sort((a, b) => a - b);
  const sum = (f: (r: LiveResult) => number) => results.reduce((n, r) => n + f(r), 0);
  return {
    runs: results.length,
    outcomes,
    safetyPassed: answered.filter((r) => r.blockers.length === 0).length,
    safetyFailed: answered.filter((r) => r.blockers.length > 0).length,
    usable: results.filter((r) => r.quality === "usable").length,
    honestInsufficient: results.filter((r) => r.quality === "honest-insufficient").length,
    needsReview: results.filter((r) => r.quality === "needs-review").length,
    modelCalls: sum((r) => r.trace?.modelCalls ?? 0),
    toolCalls: sum((r) => r.trace?.toolCalls ?? 0),
    tokens: { input: sum((r) => r.trace?.tokens.prompt ?? 0), output: sum((r) => r.trace?.tokens.completion ?? 0) },
    latencyMs: { median: latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)]! : 0, max: latencies.at(-1) ?? 0 },
    cost: prices
      ? { amount: sum((r) => r.cost?.amount ?? 0), currency: prices.currency, complete: results.every((r) => !r.trace || r.cost?.complete !== false) }
      : null,
  };
}

export interface LiveMeta {
  commit: string;
  date: string;
  /** Deployment names and model settings only; never the endpoint or key. */
  settings: Record<string, string | number | undefined>;
  bounds: LiveBounds;
  /** The scenario set's version and fingerprint, so reports from different sets are not compared as alike. */
  scenarios?: string;
}

/** A Markdown report including redacted synthetic-match answers for local review. */
export function formatReport(meta: LiveMeta, results: LiveResult[], summary: LiveSummary): string {
  const money = (n: number) => n.toFixed(4);
  const lines = [
    "## Live evaluation",
    "",
    `- Commit: \`${meta.commit}\`, run ${meta.date}`,
    `- Model settings: ${Object.entries(meta.settings).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    ...(meta.scenarios ? [`- Scenario set: ${meta.scenarios}`] : []),
    `- Bounds: ${meta.bounds.maxCases} cases, ${meta.bounds.maxModelCalls} model calls; scenarios ${Array.isArray(meta.bounds.scenarios) ? meta.bounds.scenarios.join(", ") : meta.bounds.scenarios}`,
    "",
    "| Scenario | Audience | Outcome | Safety | Quality | Flags | Seconds | Model calls | Tool calls | Input tokens | Output tokens | Cost |",
    "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.map((r) => {
      const answered = r.outcome !== "error" && r.outcome !== "skipped";
      const flags = r.leaks.length + r.unsupported.length;
      return `| ${r.scenario} | ${r.audience} | ${r.outcome}${r.error ? ` (${r.error})` : ""} | ${answered ? (r.blockers.length === 0 ? "pass" : "FAIL") : "-"} | ${r.quality ?? "-"} | ${flags || "-"} | ${(r.latencyMs / 1000).toFixed(1)} | ${r.trace?.modelCalls ?? "-"} | ${r.trace?.toolCalls ?? "-"} | ${r.trace?.tokens.prompt ?? "-"} | ${r.trace?.tokens.completion ?? "-"} | ${r.cost ? money(r.cost.amount) + (r.cost.complete ? "" : "+") : "-"} |`;
    }),
    "",
    `Outcomes: verified ${summary.outcomes.verified} · revised ${summary.outcomes.revised} · insufficient evidence ${summary.outcomes["insufficient-evidence"]} · fallback ${summary.outcomes.fallback} · error ${summary.outcomes.error} · skipped ${summary.outcomes.skipped}`,
    `Safety (no release blocker): ${summary.safetyPassed} passed, ${summary.safetyFailed} failed. Usable explanations: ${summary.usable}; honest insufficient evidence: ${summary.honestInsufficient}; flagged for review: ${summary.needsReview}.`,
    `Totals: ${summary.modelCalls} model calls, ${summary.toolCalls} tool calls, ${summary.tokens.input} input and ${summary.tokens.output} output tokens; median ${(summary.latencyMs.median / 1000).toFixed(1)} s, max ${(summary.latencyMs.max / 1000).toFixed(1)} s.`,
    summary.cost
      ? `Estimated cost: ${money(summary.cost.amount)} ${summary.cost.currency}${summary.cost.complete ? "" : " (lower bound: some calls reported no usage)"}, from the configured per-token prices.`
      : "Estimated cost: not estimated (no prices configured).",
    "",
    "Safety passing means no deterministic release blocker was found; it does not make an answer usable or true. Model review is not proof of factual correctness.",
  ];
  const flagged = results.filter((r) => r.blockers.length + r.leaks.length + r.unsupported.length > 0);
  if (results.some((r) => r.diagnostics)) {
    lines.push("", "### Provider failure diagnostics", "", "No prompts, response bodies, endpoints or credentials are retained. Reported tokens exclude unreported usage from failed calls.", "");
    for (const r of results) if (r.diagnostics) {
      const d = r.diagnostics;
      lines.push(`- ${r.scenario} (${r.audience}): ${r.error}; role=${d.role}, stage=${d.stage}, elapsed=${d.elapsedMs} ms, queue=${d.queueMs} ms${d.httpStatus ? `, HTTP ${d.httpStatus}` : ""}`);
    }
  }
  if (flagged.length > 0) {
    lines.push("", "### Flags for human review", "");
    for (const r of flagged)
      for (const f of [...r.blockers.map((b) => `BLOCKER ${b}`), ...r.leaks.map((l) => `leak? ${l}`), ...r.unsupported.map((u) => `unsupported? ${u}`)])
        lines.push(`- ${r.scenario} (${r.audience}): ${f.replace(/\|/g, "\\|")}`);
  }
  const pairs = audiencePairs(results);
  if (pairs.length > 0) {
    lines.push(
      "",
      "### Audience pairs",
      "",
      "Both audiences receive the same evidence. Conflicts mean the two answers disagree about the match and fail the release gate. Readability (Casual Fan) and detail (Analyst) are wording heuristics for human review, not measures of clarity or usefulness.",
      "",
      "| Scenario | Conflicts | Casual readability | Analyst detail |",
      "| --- | --- | --- | --- |",
      ...pairs.map((p) => `| ${p.scenario} | ${[p.conflicts, p.readability, p.detail].map((f) => (f.length ? f.join("; ").replace(/\|/g, "\\|") : "-")).join(" | ")} |`),
    );
  }
  for (const r of results.filter((r) => r.answer)) {
    lines.push("", `### Retained answer: ${r.scenario} (${r.audience})`, "", ...r.answer!.split("\n").map((line) => `    ${line}`));
  }
  return lines.join("\n");
}
