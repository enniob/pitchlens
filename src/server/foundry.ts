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
    config: { baseUrl, apiKey, deployment, verifierDeployment, structuredOutput: structured as FoundryConfig["structuredOutput"] },
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

export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly retryAfterMs?: number,
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

export class FoundryClient implements ModelClient {
  constructor(
    private readonly config: FoundryConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(request: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: request.role === "verifier" ? this.config.verifierDeployment : this.config.deployment,
      messages: request.messages,
      max_completion_tokens: request.maxCompletionTokens,
      response_format:
        this.config.structuredOutput === "json_schema"
          ? { type: "json_schema", json_schema: { name: request.schema.name, strict: true, schema: request.schema.schema } }
          : { type: "json_object" },
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice ?? "auto";
      body.parallel_tool_calls = false;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "api-key": this.config.apiKey },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (e) {
      if (request.signal.aborted) throw new ModelError("timeout", "The model did not answer in time.");
      throw new ModelError("provider-error", `Could not reach the model service (${e instanceof Error ? e.name : "network error"}).`);
    }

    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      throw new ModelError("rate-limited", "The model service is rate limiting requests.", retryAfter(response.headers));
    }
    if (response.status === 408 || response.status === 504) {
      await response.body?.cancel().catch(() => {});
      throw new ModelError("timeout", "The model service timed out.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ModelError("provider-error", `The model service returned HTTP ${response.status}.`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      if (request.signal.aborted) throw new ModelError("timeout", "The model did not answer in time.");
      throw new ModelError("bad-provider-response", "The model service returned a body that is not JSON.");
    }
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
