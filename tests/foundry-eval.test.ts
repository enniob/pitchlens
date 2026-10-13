import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Audience, VerificationSummary } from "@/explain/api";
import { insufficientEvidence } from "@/explain/response";
import { extractMatchContext } from "@/explain/context";
import type { MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import { scoreAt } from "@/playback/derive";
import { explainMoment } from "@/server/analyst";
import { answer, approve, FakeModel, goalExplanation, toolCall } from "./support/fakeModel";
import { EVAL_SCENARIOS, type EvalScenario } from "./support/scenarios";
import { ADVERSARIAL_SCENARIOS } from "./support/adversarial";
import {
  canonicalJson,
  classifyError,
  deterministicClean,
  disagreements,
  evaluateRows,
  evalQuery,
  evidenceContext,
  exportAnswer,
  foundryEvalConfigFromEnv,
  formatFoundrySection,
  joinScores,
  passRates,
  qualityCriteria,
  RecordingClient,
  responseText,
  runEvaluation,
  safetyCriteria,
  scoreAndFormat,
  toJsonl,
  type EvalOutputItem,
  type EvalRunState,
  type EvalsApi,
  type FoundryEvalRow,
  type FoundryEvalSettings,
} from "./support/foundryEval";

const scenario = (id: string): EvalScenario => {
  const s = [...EVAL_SCENARIOS, ...ADVERSARIAL_SCENARIOS].find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
};

/** Runs the real workflow on a scripted model that calls both tools (one asking for later data) and then gives up. */
async function recordedContext(fixture: MatchFixture, timeMs: number, focus: "moment" | "match" = "moment") {
  const positions = toolCall("get_positions", { atMs: Math.max(0, Math.floor(timeMs) - 1_000) });
  const future = toolCall("get_positions", { atMs: Math.floor(timeMs) + 5_000 });
  const model = new RecordingClient(new FakeModel([
    { ...positions, toolCalls: [...positions.toolCalls, ...future.toolCalls] },
    toolCall("list_events", {}),
    answer("not json"),
    answer("still not json"),
  ]));
  const out = await explainMoment({ fixture, timeMs, audience: "analyst", focus, client: model });
  return { context: evidenceContext(model.analystRequests), out, model };
}

function expectNothingAfter(fixture: MatchFixture, timeMs: number, context: string) {
  const later = fixture.events.filter((e) => e.t > timeMs);
  for (const e of later) expect(context, `later event ${e.id}`).not.toContain(`"${e.id}"`);
  expect(context).not.toContain(fixture.title);
  expect(context).not.toMatch(/generator|simulatorVersion|configKey|"seed"|"scheduled"/);
  const score = scoreAt(fixture, timeMs);
  expect(context).toContain(canonicalJson({ score }).slice(1, -1));
}

const verdict = { blockers: [], leaks: [], unsupported: [], quality: "usable" as const };
const verified: VerificationSummary = { outcome: "verified", revisions: 0, schema: "passed", grounding: "passed", modelReview: "passed", issues: [] };

describe("export context: only evidence available at the selected time", () => {
  it("1 ms before a goal is recorded: no goal, kickoff or later score", async () => {
    for (const id of ["demo-goal-before", "seed9-goal-before"]) {
      const s = scenario(id);
      const { context } = await recordedContext(s.fixture, s.timeMs);
      expectNothingAfter(s.fixture, s.timeMs, context);
      expect(context).toContain("Tool result (list_events)");
      expect(context).toContain("Tool result (get_positions)");
      expect(context).toContain("later positions are not available");
    }
  });

  it("a shot in flight: the shot is there, its result is not", async () => {
    const s = scenario("demo-shot-in-flight");
    const { context } = await recordedContext(s.fixture, s.timeMs);
    expect(context).toContain('"e5-shot"');
    expect(context).not.toContain("e6-goal");
    expectNothingAfter(s.fixture, s.timeMs, context);
  });

  it("before a scheduled formation change: neither the change nor the later shape", async () => {
    const s = scenario("seed9-formation-before");
    const { context } = await recordedContext(s.fixture, s.timeMs);
    expectNothingAfter(s.fixture, s.timeMs, context);
    const change = s.fixture.tactics!.applied[0]!;
    expect(context).not.toContain(change.eventId);
    expect(context).not.toContain(`"${change.to}"`);
  });

  it("seeking backward gives exactly the context of a fresh request at the earlier time", async () => {
    const later = await recordedContext(sampleFixture, 20_500);
    expect(later.context).toContain("e6-goal");
    const back = await recordedContext(sampleFixture, 5_000);
    const fresh = await recordedContext(sampleFixture, 5_000);
    expect(back.context).toBe(fresh.context);
    expectNothingAfter(sampleFixture, 5_000, back.context);
  });

  it("is the evidence the analyst was sent, serialized deterministically, without instructions or drafts", async () => {
    const { context, model } = await recordedContext(sampleFixture, 9_050);
    const sent = model.analystRequests.at(-1)!;
    const evidence = JSON.parse(sent[1]!.content!.split("\n")[2]!);
    expect(context.startsWith(`Evidence package:\n${canonicalJson(evidence)}`)).toBe(true);
    expect(context).not.toContain("You explain one paused moment");
    expect(context).not.toContain("not json");
    expect(context).not.toContain("rejected by automated checks");
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } })).toBe('{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it("refuses a recording with no evidence message", () => {
    expect(() => evidenceContext([])).toThrow(/no analyst request/);
    expect(() => evidenceContext([[{ role: "user", content: "hello" }]])).toThrow(/no evidence message/);
  });
});

describe("export rows", () => {
  it("records a verified explanation with a neutral query and the shown citations", async () => {
    const s = scenario("demo-goal-recorded");
    const draft = goalExplanation();
    const model = new RecordingClient(new FakeModel([answer(draft), approve(draft)]));
    const out = await explainMoment({ fixture: s.fixture, timeMs: s.timeMs, audience: "casual", client: model });
    const result = exportAnswer({ scenario: s, scenarioSet: "v-test", audience: "casual", explanation: out.explanation, verification: out.verification, verdict,
      analystRequests: model.analystRequests }, "r01");
    expect("row" in result).toBe(true);
    const row = (result as { row: FoundryEvalRow }).row;
    expect(Object.keys(row.item).sort()).toEqual(["context", "query", "response", "row_id"]);
    expect(row.item.query).toBe("Explain the paused moment at 9.4 s of a synthetic football match for a casual fan, using only the supplied evidence.");
    for (const field of Object.values(row.item)) {
      expect(field).not.toContain(s.id);
      expect(field).not.toContain(s.title);
      expect(field).not.toContain(s.fixture.title);
    }
    expect(row.item.response).toContain(`Headline: ${draft.headline}`);
    expect(row.item.response).toContain("[event e6-goal]");
    expect(row.item.response).toContain("Interpretation:");
    expect(row.meta).toMatchObject({ scenario: s.id, audience: "casual", outcome: "verified", adversarial: false,
      deterministic: { safety: "pass", quality: "usable", blockers: 0, leaks: 0, unsupported: 0 } });
    const line = toJsonl([row]);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual(row);
    expect(toJsonl([])).toBe("");
  });

  it("does not score the fallback or insufficient-evidence answers, and says why", async () => {
    const s = scenario("demo-goal-recorded");
    const { out, model } = await recordedContext(s.fixture, s.timeMs);
    expect(out.verification.outcome).toBe("fallback");
    const base = { scenario: s, scenarioSet: "v", audience: "analyst" as Audience, verdict, analystRequests: model.analystRequests };
    expect(exportAnswer({ ...base, explanation: out.explanation, verification: out.verification }, "r01"))
      .toEqual({ excluded: { scenario: s.id, audience: "analyst", outcome: "fallback", reason: expect.stringMatching(/^fallback/) } });
    const honest = insufficientEvidence(extractMatchContext(s.fixture, s.timeMs), "Not enough.");
    expect(exportAnswer({ ...base, explanation: honest, verification: { ...verified, outcome: "insufficient-evidence", modelReview: "skipped" } }, "r01"))
      .toMatchObject({ excluded: { outcome: "insufficient-evidence", reason: expect.stringMatching(/^insufficient/) } });
  });

  it("writes a full-time query without the scenario", () => {
    expect(evalQuery(60_000, "match", "analyst")).toBe("Summarise the synthetic football match at full time (60.0 s) for a match analyst, using only the supplied evidence.");
    expect(responseText({ ...goalExplanation(), interpretation: [], limitations: [] })).not.toMatch(/Interpretation|Limitations/);
  });
});

describe("configuration", () => {
  const env = { PITCHLENS_FOUNDRY_EVAL: "1", FOUNDRY_PROJECT_ENDPOINT: "https://acct.services.ai.azure.com/api/projects/proj", FOUNDRY_EVAL_JUDGE_DEPLOYMENT: "judge" };
  it("is off unless explicitly enabled", () => {
    expect(foundryEvalConfigFromEnv({})).toEqual({ enabled: false });
    expect(foundryEvalConfigFromEnv({ ...env, PITCHLENS_FOUNDRY_EVAL: "true" })).toEqual({ enabled: false });
  });
  it("names missing and invalid settings without their values", () => {
    expect(foundryEvalConfigFromEnv({ PITCHLENS_FOUNDRY_EVAL: "1" })).toEqual({ enabled: true, ok: false, missing: ["FOUNDRY_PROJECT_ENDPOINT", "FOUNDRY_EVAL_JUDGE_DEPLOYMENT"], invalid: [] });
    const bad = foundryEvalConfigFromEnv({ ...env, FOUNDRY_PROJECT_ENDPOINT: "https://acct.openai.azure.com/?key=secret", PITCHLENS_FOUNDRY_MAX_ROWS: "500" });
    expect(bad).toMatchObject({ ok: false, invalid: [expect.stringMatching(/^FOUNDRY_PROJECT_ENDPOINT/), "PITCHLENS_FOUNDRY_MAX_ROWS"] });
    expect(JSON.stringify(bad)).not.toContain("secret");
  });
  it("applies defaults and bounds", () => {
    expect(foundryEvalConfigFromEnv(env)).toEqual({ enabled: true, ok: true, settings: {
      projectEndpoint: env.FOUNDRY_PROJECT_ENDPOINT, judgeDeployment: "judge", maxRows: 28, timeoutMs: 900_000, pollMs: 10_000, safety: true } });
    expect(foundryEvalConfigFromEnv({ ...env, PITCHLENS_FOUNDRY_MAX_ROWS: "4", PITCHLENS_FOUNDRY_SAFETY: "0" }))
      .toMatchObject({ settings: { maxRows: 4, safety: false } });
    expect(foundryEvalConfigFromEnv({ ...env, PITCHLENS_FOUNDRY_TIMEOUT_MS: "99999999" })).toMatchObject({ ok: false, invalid: ["PITCHLENS_FOUNDRY_TIMEOUT_MS"] });
  });
});

// Mocked evals client ----------------------------------------------------------

const settings: FoundryEvalSettings = { projectEndpoint: "https://acct.services.ai.azure.com/api/projects/proj", judgeDeployment: "judge", maxRows: 10, timeoutMs: 60_000, pollMs: 5_000, safety: true };

const makeRow = (id: string, over: { audience?: Audience; adversarial?: boolean; clean?: boolean; scenario?: string } = {}): FoundryEvalRow => ({
  item: { row_id: id, query: "q", context: "c", response: "r" },
  meta: { scenario: over.scenario ?? `s-${id}`, scenarioSet: "v", audience: over.audience ?? "casual", focus: "moment", timeMs: 1, adversarial: over.adversarial ?? false, outcome: "verified",
    deterministic: over.clean === false
      ? { safety: "pass", quality: "needs-review", blockers: 0, leaks: 1, unsupported: 0 }
      : { safety: "pass", quality: "usable", blockers: 0, leaks: 0, unsupported: 0 } },
});

const result = (name: string, score: number, passed: boolean) => ({ type: "azure_ai_evaluator", name, metric: name, score, passed, label: passed ? "pass" : "fail", threshold: 3, reason: `${name} reason` });

type Script = {
  statuses?: string[];
  failWith?: EvalRunState["error"];
  createErrors?: unknown[];
  items?: (evalName: string, sent: { row_id: string }[]) => EvalOutputItem[];
};

class MockEvals implements EvalsApi {
  readonly created: { name: string; testing_criteria: unknown[] }[] = [];
  readonly sent = new Map<string, { row_id: string }[]>();
  polls = 0;
  private readonly scripts = new Map<string, Script>();
  constructor(private readonly make: (name: string) => Script) {}
  /** One script per evaluation, so its statuses and errors are consumed in order. */
  private script(name: string): Script {
    if (!this.scripts.has(name)) this.scripts.set(name, this.make(name));
    return this.scripts.get(name)!;
  }
  async create(body: { name: string; data_source_config: unknown; testing_criteria: unknown[] }) {
    const errors = this.script(body.name).createErrors ?? [];
    if (errors.length) throw errors.shift();
    this.created.push(body);
    return { id: `eval-${body.name}`, name: body.name };
  }
  async createRun(evalId: string, body: { name: string; data_source: unknown }) {
    const content = (body.data_source as { source: { content: { item: { row_id: string } }[] } }).source.content.map((c) => c.item);
    this.sent.set(evalId, content);
    return { id: `run-${evalId}`, status: "queued" };
  }
  async retrieveRun(evalId: string, runId: string): Promise<EvalRunState> {
    this.polls++;
    const s = this.script(evalId.slice(5));
    const status = s.statuses?.shift() ?? "completed";
    return { id: runId, status, ...(status === "failed" ? { error: s.failWith ?? null } : {}),
      result_counts: { total: 1, passed: 1, failed: 0 }, per_model_usage: [{ model_name: "judge-model", prompt_tokens: 100, completion_tokens: 20 }] };
  }
  async *listOutputItems(evalId: string) {
    const s = this.script(evalId.slice(5));
    const sent = this.sent.get(evalId) ?? [];
    for (const item of s.items ? s.items(evalId.slice(5), sent) : sent.map((x, i) => ({ datasource_item: { ...x }, datasource_item_id: i, results: [] }))) yield item;
  }
}

const allPass = (name: string, sent: { row_id: string }[]): EvalOutputItem[] => sent.map((x, i) => ({
  datasource_item: { ...x }, datasource_item_id: i,
  results: name.includes("safety") ? ["violence", "sexual", "self_harm", "hate_unfairness", "indirect_attack"].map((n) => result(n, 0, true))
    : ["groundedness", "relevance", "coherence"].map((n) => result(n, 4, true)),
}));

const fastClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
};

describe("Foundry run (mocked SDK client)", () => {
  it("creates a quality evaluation for every row and a safety evaluation for adversarial rows, then polls to completion", async () => {
    const api = new MockEvals(() => ({ statuses: ["queued", "in_progress", "completed"], items: allPass }));
    const rows = [makeRow("r01"), makeRow("r02", { audience: "analyst" }), makeRow("r03", { adversarial: true })];
    const ev = await evaluateRows(api, rows, settings, "abc1234-20261013T120000", fastClock());
    expect(api.created.map((c) => c.name)).toEqual(["pitchlens-explanations-abc1234-20261013T120000", "pitchlens-adversarial-safety-abc1234-20261013T120000"]);
    expect(api.created[0]!.testing_criteria).toEqual(qualityCriteria("judge"));
    expect(api.created[1]!.testing_criteria).toEqual(safetyCriteria());
    expect([...api.sent.values()].map((v) => v.map((x) => x.row_id))).toEqual([["r01", "r02", "r03"], ["r03"]]);
    expect(ev.quality).toMatchObject({ ok: true, status: "completed" });
    const joined = joinScores(ev.scored, ev);
    expect(joined.missing).toEqual([]);
    expect(joined.rows.find((r) => r.row.item.row_id === "r03")!.scores.map((s) => s.evaluator))
      .toEqual(["groundedness", "relevance", "coherence", "violence", "sexual", "self_harm", "hate_unfairness", "indirect_attack"]);
    expect(passRates(joined)).toContainEqual({ evaluator: "groundedness", audience: "analyst", passed: 1, judged: 1 });
  });

  it("sends only row_id, query, context and response, and the documented evaluator configuration", async () => {
    const api = new MockEvals(() => ({ items: allPass }));
    await evaluateRows(api, [makeRow("r01", { scenario: "demo-goal-recorded" })], settings, "x", fastClock());
    expect(JSON.stringify([...api.sent.values()])).not.toContain("demo-goal-recorded");
    const g = qualityCriteria("judge")[0]!;
    expect(g).toEqual({ type: "azure_ai_evaluator", name: "groundedness", evaluator_name: "builtin.groundedness", initialization_parameters: { deployment_name: "judge" },
      data_mapping: { query: "{{item.query}}", context: "{{item.context}}", response: "{{item.response}}" } });
    expect(safetyCriteria().every((c) => !("initialization_parameters" in c))).toBe(true);
  });

  it("bounds the rows sent", async () => {
    const api = new MockEvals(() => ({ items: allPass }));
    const rows = Array.from({ length: 5 }, (_, i) => makeRow(`r0${i + 1}`));
    const ev = await evaluateRows(api, rows, { ...settings, maxRows: 2 }, "x", fastClock());
    expect(ev.scored.map((r) => r.item.row_id)).toEqual(["r01", "r02"]);
    expect(ev.overLimit).toHaveLength(3);
    expect(await evaluateRows(api, [], settings, "x")).toMatchObject({ quality: null, safety: null });
  });

  it("reports a failed run, naming a judge-model problem", async () => {
    const api = new MockEvals(() => ({ statuses: ["failed"], failWith: { code: "DeploymentNotFound", message: "The model deployment 'judge' was not found" } }));
    const ev = await evaluateRows(api, [makeRow("r01")], settings, "x", fastClock());
    expect(ev.quality).toMatchObject({ ok: false, kind: "judge-model", reason: expect.stringMatching(/^Run failed: DeploymentNotFound/) });
  });

  it("stops polling at the time limit", async () => {
    const api = new MockEvals(() => ({ statuses: Array(100).fill("in_progress") }));
    const ev = await evaluateRows(api, [makeRow("r01")], { ...settings, timeoutMs: 20_000 }, "x", fastClock());
    expect(ev.quality).toMatchObject({ ok: false, kind: "timeout" });
    expect(api.polls).toBe(4);
  });

  it("explains a missing role, without retrying, and scrubs URLs and IDs", async () => {
    const denied = Object.assign(new Error(`PermissionDenied on ${settings.projectEndpoint}/openai/v1/evals for principal 0b5e7d3a-1111-2222-3333-444455556666`), { status: 403 });
    const api = new MockEvals(() => ({ createErrors: [denied] }));
    const ev = await evaluateRows(api, [makeRow("r01")], settings, "x", fastClock());
    expect(ev.quality).toMatchObject({ ok: false, kind: "permission", reason: expect.stringContaining("Foundry User role") });
    const reason = (ev.quality as { reason: string }).reason;
    expect(reason).not.toMatch(/https?:|services\.ai\.azure\.com|0b5e7d3a/);
  });

  it("retries a rate-limited create call within its attempts", async () => {
    const limited = () => Object.assign(new Error("Too Many Requests"), { status: 429 });
    const ok = new MockEvals(() => ({ createErrors: [limited()], items: allPass }));
    expect((await runEvaluation(ok, "q", [], [makeRow("r01").item], settings, fastClock())).ok).toBe(true);
    const errors = [limited(), limited(), limited()];
    const stuck = new MockEvals(() => ({ createErrors: errors }));
    expect(await runEvaluation(stuck, "q", [], [makeRow("r01").item], settings, fastClock())).toMatchObject({ ok: false, kind: "rate-limited" });
    expect(errors).toHaveLength(0);
  });

  it("keeps quality scores when safety evaluators are unavailable in the region, and records why", async () => {
    const region = Object.assign(new Error("Safety evaluations are not supported in this region"), { status: 400 });
    const api = new MockEvals((name) => (name.includes("safety") ? { createErrors: [region] } : { items: allPass }));
    const ev = await evaluateRows(api, [makeRow("r01", { adversarial: true })], settings, "x", fastClock());
    expect(ev.quality).toMatchObject({ ok: true });
    expect(ev.safety).toMatchObject({ ok: false, kind: "unsupported" });
    const section = formatFoundrySection({ judgeDeployment: "judge", sdk: "sdk", date: "d" }, ev, joinScores(ev.scored, ev), []);
    expect(section).toMatch(/Safety and indirect attack .* unavailable \(unsupported\)/);
    const off = await evaluateRows(new MockEvals(() => ({ items: allPass })), [makeRow("r01", { adversarial: true })], { ...settings, safety: false }, "x", fastClock());
    expect(off.safety).toMatchObject({ ok: false, kind: "disabled" });
  });

  it("rejects malformed results instead of guessing", async () => {
    const noId = { ...new MockEvals(() => ({})), create: async () => ({}) as { id: string } } as unknown as EvalsApi;
    expect(await runEvaluation(noId, "q", [], [makeRow("r01").item], settings, fastClock())).toMatchObject({ ok: false, kind: "malformed" });
    const junk = new MockEvals(() => ({ items: () => [null as unknown as EvalOutputItem] }));
    expect(await runEvaluation(junk, "q", [], [makeRow("r01").item], settings, fastClock())).toMatchObject({ ok: false, kind: "malformed" });
  });

  it("reports a missing credential without throwing", async () => {
    const section = await scoreAndFormat({ rows: [makeRow("r01")], excluded: [] }, settings, "abc1234def", async () => {
      throw Object.assign(new Error("DefaultAzureCredential failed to retrieve a token"), { name: "CredentialUnavailableError" });
    }, "sdk");
    expect(section).toMatch(/unavailable \(credential\).*az login/);
    expect(section).toContain("| r01 |");
    expect(classifyError(Object.assign(new Error("boom"), { status: 503 })).kind).toBe("service");
    expect(classifyError(Object.assign(new Error("x"), { status: 404 })).kind).toBe("not-found");
  });
});

describe("join and report", () => {
  const rows = [makeRow("r01"), makeRow("r02", { clean: false }), makeRow("r03", { audience: "analyst" })];
  const completed = (items: EvalOutputItem[]) => ({ ok: true as const, evalName: "e", status: "completed" as const, rowIds: ["r01", "r02", "r03"], items, counts: null, usage: null });

  it("joins by row_id or position and counts missing, unmatched and duplicate results", () => {
    const joined = joinScores(rows, { quality: completed([
      { datasource_item: { row_id: "r01" }, results: [result("groundedness", 5, true)] },
      { datasource_item_id: 1, results: [result("groundedness", 4, true)] },
      { datasource_item: { row_id: "r01" }, results: [result("groundedness", 1, false)] },
      { datasource_item: { row_id: "r99" }, results: [result("groundedness", 1, false)] },
    ]), safety: null });
    expect(joined.missing).toEqual(["r03"]);
    expect(joined.extra).toBe(2);
    expect(joined.rows[0]!.scores).toEqual([{ evaluator: "groundedness", score: 5, passed: true, threshold: 3, reason: "groundedness reason" }]);
    expect(joined.rows[1]!.scores[0]!.score).toBe(4);
  });

  it("reads labels and missing scores without inventing a pass", () => {
    const joined = joinScores([rows[0]!], { quality: { ...completed([{ datasource_item: { row_id: "r01" }, results: [
      { name: "Coherence", score: Number.NaN, label: "fail" }, { name: "relevance", score: null, passed: null },
    ] }]), rowIds: ["r01"] }, safety: null });
    expect(joined.rows[0]!.scores).toEqual([
      { evaluator: "coherence", score: null, passed: false, threshold: null, reason: "" },
      { evaluator: "relevance", score: null, passed: null, threshold: null, reason: "" },
    ]);
  });

  it("lists disagreements in both directions and renders a report without URLs", () => {
    const joined = joinScores(rows, { quality: completed([
      { datasource_item: { row_id: "r01" }, results: [result("groundedness", 2, false), result("coherence", 4, true)] },
      { datasource_item: { row_id: "r02" }, results: [result("groundedness", 5, true)] },
      { datasource_item: { row_id: "r03" }, results: [result("groundedness", 5, true)] },
    ]), safety: null });
    expect(deterministicClean(rows[1]!.meta.deterministic)).toBe(false);
    expect(disagreements(joined)).toEqual([
      { rowId: "r01", scenario: "s-r01", audience: "casual", kind: "deterministic clean, Foundry fails", detail: "groundedness 2" },
      { rowId: "r02", scenario: "s-r02", audience: "casual", kind: "deterministic flags, Foundry passes", detail: "safety pass, quality needs-review, 0 blockers, 1 leaks, 0 unsupported" },
    ]);
    const ev = { quality: { ...completed([]), evalName: "pitchlens-explanations-x", items: [{}, {}, {}], usage: [{ model_name: "judge-model", prompt_tokens: 10, completion_tokens: 2 }] }, safety: null, scored: rows, overLimit: [] };
    const section = formatFoundrySection({ judgeDeployment: "judge", sdk: "sdk", date: "2026-10-13" }, ev, joined,
      [{ scenario: "demo-sparse", audience: "casual", outcome: "insufficient-evidence", reason: "insufficient evidence: not an explanation" }]);
    expect(section).toContain("| r01 | s-r01 | casual | pass/usable | 2 FAIL | 4 pass |");
    expect(section).toContain("| groundedness | 2/3 | 1/2 | 1/1 |");
    expect(section).toContain("deterministic flags, Foundry passes");
    expect(section).toContain("judge-model 10 in / 2 out tokens");
    expect(section).toContain("- demo-sparse (casual): insufficient evidence: not an explanation");
    expect(section).toContain("does not prove an explanation is true");
    expect(section).not.toMatch(/https?:\/\//);
  });
});

describe("production bundle", () => {
  it("application code never imports the Azure evaluation SDKs", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk("src");
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/@azure\/(ai-projects|identity)|foundryEval|foundryClient/);
  });
});
