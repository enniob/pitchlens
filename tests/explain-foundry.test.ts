import { describe, expect, it } from "vitest";
import { FoundryClient, foundryConfigFromEnv, type ChatRequest, type FoundryConfig } from "@/server/foundry";
import { STRICT_EXPLANATION_SCHEMA, strictSchema } from "@/explain/prompts";
import { EXPLANATION_JSON_SCHEMA } from "@/explain/response";
import { EVIDENCE_TOOLS } from "@/explain/evidence";

const KEY = "test-key-should-never-leak";
const ENV = { FOUNDRY_ENDPOINT: "https://example-resource.openai.azure.com", FOUNDRY_API_KEY: KEY, FOUNDRY_DEPLOYMENT: "analyst-deployment" };
const config = (extra: Partial<FoundryConfig> = {}): FoundryConfig => {
  const c = foundryConfigFromEnv(ENV);
  if (!c.ok) throw new Error("bad test config");
  return { ...c.config, ...extra };
};
const request = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  role: "analyst",
  messages: [{ role: "user", content: "hi" }],
  schema: { name: "explanation", schema: STRICT_EXPLANATION_SCHEMA },
  maxCompletionTokens: 500,
  signal: new AbortController().signal,
  ...extra,
});
const reply = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("Foundry configuration", () => {
  it("reports missing settings by name only", () => {
    const r = foundryConfigFromEnv({});
    expect(r).toEqual({ ok: false, missing: ["FOUNDRY_ENDPOINT", "FOUNDRY_API_KEY", "FOUNDRY_DEPLOYMENT"], invalid: [] });
  });

  it("normalises the endpoint to the v1 API base", () => {
    for (const endpoint of [
      "https://r.openai.azure.com",
      "https://r.openai.azure.com/",
      "https://r.openai.azure.com/openai/v1",
      "https://r.openai.azure.com/openai/v1/",
    ]) {
      const r = foundryConfigFromEnv({ ...ENV, FOUNDRY_ENDPOINT: endpoint });
      expect(r.ok && r.config.baseUrl).toBe("https://r.openai.azure.com/openai/v1");
    }
    const services = foundryConfigFromEnv({ ...ENV, FOUNDRY_ENDPOINT: "https://r.services.ai.azure.com" });
    expect(services.ok && services.config.baseUrl).toBe("https://r.services.ai.azure.com/openai/v1");
  });

  it("rejects insecure or odd endpoints and unknown output modes", () => {
    for (const endpoint of ["http://r.openai.azure.com", "not a url", "https://user:pw@r.openai.azure.com", "https://r.openai.azure.com/?x=1"])
      expect(foundryConfigFromEnv({ ...ENV, FOUNDRY_ENDPOINT: endpoint })).toMatchObject({ ok: false, invalid: ["FOUNDRY_ENDPOINT"] });
    expect(foundryConfigFromEnv({ ...ENV, FOUNDRY_STRUCTURED_OUTPUT: "xml" })).toMatchObject({ ok: false, invalid: ["FOUNDRY_STRUCTURED_OUTPUT"] });
  });

  it("uses the analyst deployment for the verifier unless one is set", () => {
    expect(config().verifierDeployment).toBe("analyst-deployment");
    const r = foundryConfigFromEnv({ ...ENV, FOUNDRY_VERIFIER_DEPLOYMENT: "verifier-deployment" });
    expect(r.ok && r.config.verifierDeployment).toBe("verifier-deployment");
  });
});

describe("strict structured-output schema", () => {
  it("keeps the shape but drops keywords strict mode does not accept", () => {
    const text = JSON.stringify(STRICT_EXPLANATION_SCHEMA);
    for (const k of ["$schema", "minLength", "maxLength", "minItems", "maxItems", '"const"', '"title"']) expect(text).not.toContain(k);
    expect(STRICT_EXPLANATION_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: EXPLANATION_JSON_SCHEMA.required,
      properties: { explanationVersion: { enum: ["1.0.0"] } },
    });
    expect(strictSchema({ properties: { title: { type: "string" } } })).toEqual({ properties: { title: { type: "string" } } });
  });
});

describe("Foundry client", () => {
  it("posts a chat completion with the key in a header and structured output", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = new FoundryClient(config(), async (url, init) => {
      seen.push({ url: String(url), init: init! });
      return reply({ choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    });
    const out = await client.complete(request({ tools: EVIDENCE_TOOLS, toolChoice: "auto" }));
    expect(out).toEqual({ content: '{"a":1}', toolCalls: [], finishReason: "stop", usage: { prompt: 12, completion: 3 } });
    expect(seen[0]!.url).toBe("https://example-resource.openai.azure.com/openai/v1/chat/completions");
    expect((seen[0]!.init.headers as Record<string, string>)["api-key"]).toBe(KEY);
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body).toMatchObject({
      model: "analyst-deployment",
      max_completion_tokens: 500,
      tool_choice: "auto",
      parallel_tool_calls: false,
      response_format: { type: "json_schema", json_schema: { name: "explanation", strict: true } },
    });
    expect(body.tools).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("uses the verifier deployment and json_object mode when configured", async () => {
    let body: Record<string, unknown> = {};
    const client = new FoundryClient(config({ verifierDeployment: "v", structuredOutput: "json_object" }), async (_u, init) => {
      body = JSON.parse(String(init!.body));
      return reply({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
    });
    const out = await client.complete(request({ role: "verifier" }));
    expect(body).toMatchObject({ model: "v", response_format: { type: "json_object" } });
    expect(body.tools).toBeUndefined();
    expect(out.usage).toBeNull();
  });

  it("returns tool calls", async () => {
    const client = new FoundryClient(config(), async () =>
      reply({
        choices: [
          { message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_events", arguments: '{"fromMs":1}' } }] }, finish_reason: "tool_calls" },
        ],
      }),
    );
    const out = await client.complete(request());
    expect(out.toolCalls).toEqual([{ id: "c1", type: "function", function: { name: "list_events", arguments: '{"fromMs":1}' } }]);
  });

  it("maps provider failures to codes without leaking the key or body", async () => {
    const failing = (response: Response | Error) => new FoundryClient(config(), async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    const secretBody = `{"error":"bad key ${KEY}"}`;
    const cases: [Response | Error, string, number?][] = [
      [new Response(secretBody, { status: 429, headers: { "retry-after": "7" } }), "rate-limited", 7_000],
      [new Response(secretBody, { status: 429, headers: { "retry-after-ms": "1500" } }), "rate-limited", 1_500],
      [new Response(secretBody, { status: 401 }), "provider-error"],
      [new Response(secretBody, { status: 500 }), "provider-error"],
      [new Response(secretBody, { status: 504 }), "timeout"],
      [reply("<html>"), "bad-provider-response"],
      [reply({ choices: [] }), "bad-provider-response"],
      [reply({ choices: [{ message: { content: null, tool_calls: [{ function: {} }] } }] }), "bad-provider-response"],
      [new TypeError(`fetch failed ${KEY}`), "provider-error"],
    ];
    for (const [response, code, retryAfterMs] of cases) {
      const error = await failing(response).complete(request()).then(() => null, (e: unknown) => e as { code: string; message: string; retryAfterMs?: number });
      expect(error, code).toMatchObject({ code });
      expect(error!.message).not.toContain(KEY);
      if (retryAfterMs) expect(error!.retryAfterMs).toBe(retryAfterMs);
    }
  });

  it("reports an aborted request as a timeout", async () => {
    const controller = new AbortController();
    const client = new FoundryClient(config(), (_u, init) =>
      new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
    const pending = client.complete(request({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
  });
});
