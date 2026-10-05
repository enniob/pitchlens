import { describe, expect, it } from "vitest";
import type { ExplainApiResponse, ExplainRequest } from "@/explain/api";
import { matchReferenceOf } from "@/explain/matchRef";
import { sampleFixture } from "@/match/fixture";
import { generateMatch } from "@/simulation/generate";
import { handleExplain, MAX_BODY_BYTES, type ExplainDeps, type ExplainLogRecord } from "@/server/explainHandler";
import { ModelError } from "@/server/foundry";
import { AnswerCache, RequestGuard } from "@/server/guard";
import { answer, approve, FakeModel, goalExplanation, type Step } from "./support/fakeModel";

const KEY = "secret-key-for-tests";
const ENV = { FOUNDRY_ENDPOINT: "https://r.openai.azure.com", FOUNDRY_API_KEY: KEY, FOUNDRY_DEPLOYMENT: "d" };
const URL_ = "https://pitchlens.example/api/explain";

function setup(steps: Step[] = [], env: Record<string, string> = ENV, guard = new RequestGuard()) {
  const model = new FakeModel(steps);
  const logs: ExplainLogRecord[] = [];
  const deps: ExplainDeps = { env, createClient: () => model, guard, cache: new AnswerCache(), log: (r) => logs.push(r) };
  return { model, logs, deps };
}

const body = (extra: Partial<ExplainRequest> & Record<string, unknown> = {}): ExplainRequest => ({
  requestId: "req-12345678",
  match: { kind: "sample", matchId: sampleFixture.matchId },
  timeMs: 9_400,
  audience: "analyst",
  ...extra,
});
const post = (payload: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
const call = async (deps: ExplainDeps, request: Request) => {
  const response = await handleExplain(request, deps);
  return { response, json: (await response.json()) as ExplainApiResponse };
};

describe("POST /api/explain", () => {
  it("answers with the explanation, its verification, a trace and the request ID", async () => {
    const draft = goalExplanation();
    const { deps, logs } = setup([answer(draft), approve(draft)]);
    const { response, json } = await call(deps, post(body()));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req-12345678");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({
      apiVersion: "1.0.0",
      ok: true,
      requestId: "req-12345678",
      matchId: sampleFixture.matchId,
      timeMs: 9_400,
      audience: "analyst",
      explanation: draft,
      verification: { outcome: "verified" },
      cached: false,
    });
    expect(logs).toEqual([expect.objectContaining({ requestId: "req-12345678", status: 200, outcome: "verified" })]);
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(draft.headline);
  });

  it("generates a request ID when none is sent, and floors the time", async () => {
    const draft = { ...goalExplanation() };
    const { deps } = setup([answer(draft), approve(draft)]);
    const { requestId: _r, ...rest } = body({ timeMs: 9_400.7 });
    const { json } = await call(deps, post(rest));
    expect(json.ok && json.timeMs).toBe(9_400);
    expect(json.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("explains a generated match rebuilt from its reference", async () => {
    const fixture = generateMatch({ seed: 11, durationMs: 20_000 });
    const insufficient = {
      explanationVersion: "1.0.0",
      matchId: fixture.matchId,
      timeMs: 5_000,
      status: "insufficient-evidence",
      headline: "Not enough to go on",
      explanation: "Too little has happened.",
      facts: [],
      interpretation: [],
      limitations: ["Few events so far."],
    };
    const { deps } = setup([answer(insufficient)]);
    const { response, json } = await call(deps, post(body({ match: matchReferenceOf(fixture, sampleFixture.matchId)!, timeMs: 5_000, audience: "casual" })));
    expect(response.status).toBe(200);
    expect(json).toMatchObject({ ok: true, matchId: fixture.matchId, verification: { outcome: "insufficient-evidence" } });
  });

  it("serves a repeated request from the cache without calling the model", async () => {
    const draft = goalExplanation();
    const { deps, model } = setup([answer(draft), approve(draft)]);
    await call(deps, post(body()));
    const { json } = await call(deps, post(body({ requestId: "req-second-1" })));
    expect(json).toMatchObject({ ok: true, cached: true, requestId: "req-second-1" });
    expect(model.requests).toHaveLength(2);
    // A different audience is a different answer: it reaches the model, which has no more scripted answers here.
    await call(deps, post(body({ audience: "casual" })));
    expect(model.requests).toHaveLength(3);
  });

  it("rejects bad requests before calling the model", async () => {
    const { deps, model } = setup();
    const cases: [Request, number, string][] = [
      [post("{"), 400, "invalid-request"],
      [post([]), 400, "invalid-request"],
      [post(body({ audience: "pundit" as never })), 400, "invalid-request"],
      [post(body({ timeMs: -1 })), 400, "invalid-request"],
      [post(body({ timeMs: "9400" as never })), 400, "invalid-request"],
      [post(body({ timeMs: 99_000 })), 400, "invalid-request"],
      [post(body({ requestId: "x" })), 400, "invalid-request"],
      [post(body({ fixture: {} } as never)), 400, "invalid-request"],
      // A whole fixture never fits.
      [post(body({ fixture: sampleFixture } as never)), 413, "payload-too-large"],
      [post(body({ match: { kind: "upload", matchId: "x" } as never })), 400, "invalid-request"],
      [post(body({ match: { kind: "sample", matchId: "other-match" } })), 404, "unknown-match"],
      [post(body({ match: { ...matchReferenceOf(generateMatch({ seed: 1, durationMs: 10_000 }), "")!, matchId: "sim-v4-1-10000-forged" } as never })), 404, "unknown-match"],
      [post({ ...body(), padding: "x".repeat(MAX_BODY_BYTES) }), 413, "payload-too-large"],
      [new Request(URL_, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body()) }), 415, "unsupported-media-type"],
      [post(body(), { origin: "https://evil.example" }), 403, "forbidden-origin"],
    ];
    for (const [request, status, code] of cases) {
      const { response, json } = await call(deps, request);
      expect(response.status, code).toBe(status);
      expect(json.ok === false && json.error.code).toBe(code);
    }
    expect(model.requests).toHaveLength(0);
  });

  it("accepts its own origin and configured extra origins", async () => {
    const draft = goalExplanation();
    const { deps } = setup([answer(draft), approve(draft), answer(draft), approve(draft)], { ...ENV, PITCHLENS_ALLOWED_ORIGINS: "https://preview.example" });
    expect((await call(deps, post(body(), { origin: "https://pitchlens.example" }))).response.status).toBe(200);
    expect((await call(deps, post(body({ audience: "casual" }), { origin: "https://preview.example" }))).response.status).not.toBe(403);
  });

  it("says when the service is not configured", async () => {
    const { deps } = setup([], {});
    const { response, json } = await call(deps, post(body()));
    expect(response.status).toBe(503);
    expect(json).toMatchObject({ ok: false, error: { code: "not-configured", retryable: false } });
    expect(JSON.stringify(json)).not.toContain("FOUNDRY");
  });

  it("requires the access token when one is set", async () => {
    const draft = goalExplanation();
    const { deps } = setup([answer(draft), approve(draft)], { ...ENV, PITCHLENS_EXPLAIN_ACCESS_TOKEN: "let-me-in" });
    expect((await call(deps, post(body()))).response.status).toBe(401);
    expect((await call(deps, post(body(), { authorization: "Bearer wrong" }))).response.status).toBe(401);
    expect((await call(deps, post(body(), { authorization: "Bearer let-me-in" }))).response.status).toBe(200);
  });

  it("rate-limits each client and says when to retry", async () => {
    const { deps } = setup([], ENV, new RequestGuard({ perClient: 1 }));
    deps.createClient = () => new FakeModel([new ModelError("provider-error", "x")]);
    await call(deps, post(body()));
    const { response, json } = await call(deps, post(body()));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(json).toMatchObject({ ok: false, error: { code: "rate-limited", retryable: true, retryAfterMs: expect.any(Number) } });
    // Another client is still served.
    expect((await call(deps, post(body(), { "x-forwarded-for": "198.51.100.7" }))).json).not.toMatchObject({ error: { code: "rate-limited" } });
  });

  it("limits concurrent workflows", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const draft = goalExplanation();
    const { deps } = setup(
      [
        async () => {
          await gate;
          return answer(draft);
        },
        approve(draft),
      ],
      ENV,
      new RequestGuard({ concurrent: 1 }),
    );
    const first = call(deps, post(body()));
    const second = await call(deps, post(body({ audience: "casual" }), { "x-forwarded-for": "198.51.100.9" }));
    expect(second.response.status).toBe(429);
    expect(second.json).toMatchObject({ error: { code: "busy" } });
    release();
    expect((await first).response.status).toBe(200);
  });

  it("maps provider failures to retryable errors", async () => {
    const cases: [ModelError, number, string][] = [
      [new ModelError("timeout", "slow"), 504, "timeout"],
      [new ModelError("rate-limited", "busy", 3_000), 503, "upstream-rate-limited"],
      [new ModelError("provider-error", `HTTP 500 ${KEY}`), 502, "upstream-error"],
      [new ModelError("bad-provider-response", "not json"), 502, "upstream-error"],
    ];
    for (const [error, status, code] of cases) {
      const { deps, logs } = setup([error]);
      const { response, json } = await call(deps, post(body()));
      expect(response.status, code).toBe(status);
      expect(json).toMatchObject({ ok: false, error: { code, retryable: true } });
      expect(JSON.stringify(json)).not.toContain(KEY);
      expect(logs[0]).toMatchObject({ error: code, status });
      if (code === "upstream-rate-limited") expect(response.headers.get("retry-after")).toBe("3");
    }
  });

  it("hides unexpected errors", async () => {
    const { deps } = setup([new Error(`boom ${KEY}`)]);
    const { response, json } = await call(deps, post(body()));
    expect(response.status).toBe(500);
    expect(JSON.stringify(json)).not.toContain(KEY);
    expect(json).toMatchObject({ error: { code: "internal-error" } });
  });
});
