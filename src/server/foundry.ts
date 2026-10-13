/**
 * Server-only client for chat completions on Microsoft Foundry.
 *
 * Uses the Azure OpenAI v1 API that Foundry resources expose
 * (`POST {endpoint}/openai/v1/chat/completions`, `api-key` header), with plain
 * `fetch`, so no SDK or Python sidecar is needed. See docs/explain-service.md
 * for why this was chosen over Microsoft Agent Framework.
 *
 * Errors are reduced to a few codes. Provider response bodies, headers and
 * the API key never appear in an error message.
 */

import { ModelScheduler } from "./modelScheduler";
import type { ExplainTrace } from "@/explain/api";

export interface FoundryConfig {
  /** Base URL ending in /openai/v1, e.g. https://<resource>.openai.azure.com/openai/v1 */
  baseUrl: string;
  apiKey: string;
  /** Deployment name of the analyst model. */
  deployment: string;
  /** Deployment name of the verifier model; defaults to the analyst's. */
  verifierDeployment: string;
  /** `json_schema` (strict structured output) or `json_object` for models without it. */
  structuredOutput: "json_schema" | "json_object";
  /** Optional provider-supported reasoning setting for the analyst; omitted unless configured. */
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
  /** The verifier's reasoning setting; defaults to the analyst's. */
  verifierReasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
  /** Optional sampling setting for deployments that support it. */
  temperature?: number;
  /** Deployment request quota, used to space calls (including verifier calls). */
  requestsPerMinute?: number;
}

export type ConfigResult = { ok: true; config: FoundryConfig } | { ok: false; missing: string[]; invalid: string[] };

/** Reads the configuration from environment variables. Never logs or returns the key. */
export function foundryConfigFromEnv(env: Record<string, string | undefined> = process.env): ConfigResult {
  const missing: string[] = [];
  const invalid: string[] = [];
  const read = (name: string) => {
    const v = env[name]?.trim();
    if (!v) missing.push(name);
    return v ?? "";
  };
  const endpoint = read("FOUNDRY_ENDPOINT");
  const apiKey = read("FOUNDRY_API_KEY");
  const deployment = read("FOUNDRY_DEPLOYMENT");
  const verifierDeployment = env.FOUNDRY_VERIFIER_DEPLOYMENT?.trim() || deployment;
  const structured = env.FOUNDRY_STRUCTURED_OUTPUT?.trim() || "json_schema";
  if (structured !== "json_schema" && structured !== "json_object") invalid.push("FOUNDRY_STRUCTURED_OUTPUT");
  const reasoning = env.FOUNDRY_REASONING_EFFORT?.trim();
  if (reasoning && !["none", "minimal", "low", "medium", "high"].includes(reasoning)) invalid.push("FOUNDRY_REASONING_EFFORT");
  const ownVerifierReasoning = env.FOUNDRY_VERIFIER_REASONING_EFFORT?.trim();
  if (ownVerifierReasoning && !["none", "minimal", "low", "medium", "high"].includes(ownVerifierReasoning)) invalid.push("FOUNDRY_VERIFIER_REASONING_EFFORT");
  const verifierReasoning = ownVerifierReasoning || reasoning;
  const temperature = env.FOUNDRY_TEMPERATURE?.trim();
  const rpm = env.FOUNDRY_REQUESTS_PER_MINUTE?.trim();
  if (rpm && (!Number.isInteger(Number(rpm)) || Number(rpm) < 1 || Number(rpm) > 60_000)) invalid.push("FOUNDRY_REQUESTS_PER_MINUTE");
  if (temperature && (!Number.isFinite(Number(temperature)) || Number(temperature) < 0 || Number(temperature) > 2)) invalid.push("FOUNDRY_TEMPERATURE");

  let baseUrl = "";
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
      const path = url.pathname.replace(/\/+$/, "");
      baseUrl = `${url.origin}${path.endsWith("/openai/v1") ? path : `${path}/openai/v1`}`;
    } catch {
      invalid.push("FOUNDRY_ENDPOINT");
    }
  }
  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid };
  return {
    ok: true,
    config: { baseUrl, apiKey, deployment, verifierDeployment, structuredOutput: structured as FoundryConfig["structuredOutput"],
      ...(reasoning ? { reasoningEffort: reasoning as FoundryConfig["reasoningEffort"] } : {}),
      ...(verifierReasoning ? { verifierReasoningEffort: verifierReasoning as FoundryConfig["verifierReasoningEffort"] } : {}),
      ...(temperature ? { temperature: Number(temperature) } : {}),
      ...(rpm ? { requestsPerMinute: Number(rpm) } : {}) },
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatRequest {
  role: "analyst" | "verifier";
  messages: ChatMessage[];
  tools?: readonly unknown[];
  toolChoice?: "auto" | "none";
  /** JSON Schema for the answer. */
  schema: { name: string; schema: unknown };
  maxCompletionTokens: number;
  signal: AbortSignal;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: { prompt: number; completion: number } | null;
}

/** Anything that can answer a chat request: the Foundry client, or a fake in tests. */
export interface ModelClient {
  complete(request: ChatRequest): Promise<ChatResult>;
}

export type ModelErrorCode = "timeout" | "rate-limited" | "provider-error" | "bad-provider-response";

/** Safe local diagnostics: no URL, headers, prompts or response text. */
export interface ModelFailureDiagnostics {
  role: ChatRequest["role"];
  stage: "queue" | "request" | "response-body" | "provider-http";
  elapsedMs: number;
  queueMs: number;
  httpStatus?: number;
}

export class ModelError extends Error {
  /** Recorded by the workflow for local evaluation; never sent as an HTTP error body. */
  trace?: ExplainTrace;
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly retryAfterMs?: number,
    readonly diagnostics?: ModelFailureDiagnostics,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

function retryAfter(headers: Headers): number | undefined {
  const ms = Number(headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, 600_000);
  const s = headers.get("retry-after");
  if (!s) return undefined;
  const seconds = Number(s);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 600_000);
  const date = Date.parse(s);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), 600_000) : undefined;
}

const deploymentSchedulers = new Map<string, ModelScheduler>();

export class FoundryClient implements ModelClient {
  private readonly isolatedSchedulers = new Map<string, ModelScheduler>();
  private scheduler(role: ChatRequest["role"]): ModelScheduler {
    const schedulers = this.fetchImpl === fetch ? deploymentSchedulers : this.isolatedSchedulers;
    const deployment = role === "verifier" ? this.config.verifierDeployment : this.config.deployment;
    const key = JSON.stringify([this.config.baseUrl, deployment, this.config.requestsPerMinute]);
    let scheduler = schedulers.get(key);
    if (!scheduler) {
      // Bound process memory if configuration is changed repeatedly.
      if (schedulers.size >= 64) schedulers.delete(schedulers.keys().next().value!);
      scheduler = new ModelScheduler(this.config.requestsPerMinute ? Math.ceil(60_000 / this.config.requestsPerMinute) : 0);
      schedulers.set(key, scheduler);
    }
    return scheduler;
  }
  constructor(
    private readonly config: FoundryConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(request: ChatRequest): Promise<ChatResult> {
    const started = performance.now();
    let stage: ModelFailureDiagnostics["stage"] = "queue";
    let queueMs = 0;
    const failure = (code: ModelErrorCode, message: string, retry?: number, status?: number) =>
      new ModelError(code, message, retry, { role: request.role, stage, elapsedMs: Math.round(performance.now() - started), queueMs,
        ...(status === undefined ? {} : { httpStatus: status }) });
    const body: Record<string, unknown> = {
      model: request.role === "verifier" ? this.config.verifierDeployment : this.config.deployment,
      messages: request.messages,
      max_completion_tokens: request.maxCompletionTokens,
      response_format:
        this.config.structuredOutput === "json_schema"
          ? { type: "json_schema", json_schema: { name: request.schema.name, strict: true, schema: request.schema.schema } }
          : { type: "json_object" },
    };
    const reasoningEffort = request.role === "verifier" ? this.config.verifierReasoningEffort : this.config.reasoningEffort;
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice ?? "auto";
      body.parallel_tool_calls = false;
    }

    let response: Response;
    try {
      await this.scheduler(request.role).acquire(request.signal);
      request.signal.throwIfAborted();
      queueMs = Math.round(performance.now() - started);
      stage = "request";
      response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "api-key": this.config.apiKey },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (e) {
      if (stage === "queue") queueMs = Math.round(performance.now() - started);
      if (request.signal.aborted) throw failure("timeout", "The model did not answer in time.");
      throw failure("provider-error", `Could not reach the model service (${e instanceof Error ? e.name : "network error"}).`);
    }

    if (response.status === 429) {
      stage = "provider-http";
      await response.body?.cancel().catch(() => {});
      const delay = retryAfter(response.headers) ?? 1_000;
      this.scheduler(request.role).defer(delay);
      throw failure("rate-limited", "The model service is rate limiting requests.", delay, response.status);
    }
    if (response.status === 408 || response.status === 504) {
      stage = "provider-http";
      await response.body?.cancel().catch(() => {});
      throw failure("timeout", "The model service timed out.", undefined, response.status);
    }
    if (!response.ok) {
      stage = "provider-http";
      await response.body?.cancel().catch(() => {});
      throw failure("provider-error", `The model service returned HTTP ${response.status}.`, undefined, response.status);
    }

    let json: unknown;
    stage = "response-body";
    try {
      json = await response.json();
    } catch {
      if (request.signal.aborted) throw failure("timeout", "The model did not answer in time.");
      throw failure("bad-provider-response", "The model service returned a body that is not JSON.", undefined, response.status);
    }
    if (typeof json !== "object" || json === null || Array.isArray(json))
      throw new ModelError("bad-provider-response", "The model service returned no message.");
    const choice = (json as { choices?: { message?: Record<string, unknown>; finish_reason?: unknown }[] }).choices?.[0];
    const message = choice?.message;
    if (!message || typeof message !== "object") throw new ModelError("bad-provider-response", "The model service returned no message.");
    const content = typeof message.content === "string" ? message.content : null;
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls: ToolCall[] = [];
    for (const c of rawCalls) {
      const call = c as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
      if (typeof call.id !== "string" || typeof call.function?.name !== "string")
        throw new ModelError("bad-provider-response", "The model service returned a malformed tool call.");
      toolCalls.push({
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: typeof call.function.arguments === "string" ? call.function.arguments : "" },
      });
    }
    const usage = (json as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
    return {
      content,
      toolCalls,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : "unknown",
      usage:
        usage && typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number"
          ? { prompt: usage.prompt_tokens, completion: usage.completion_tokens }
          : null,
    };
  }
}
