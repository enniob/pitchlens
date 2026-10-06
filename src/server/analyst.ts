/**
 * The bounded analyst → verifier workflow behind "Explain this moment".
 *
 *   1. The analyst model gets the evidence package for the selected time and
 *      may call the evidence tools (src/explain/evidence.ts), which never
 *      return anything after that time.
 *   2. Its answer must pass, in order: the response contract and citation
 *      check (`validateExplanation`), the deterministic wording checks
 *      (`checkGrounding`) and, for an explained moment, a review by a
 *      verifier model of the headline, explanation and every claim against
 *      the evidence.
 *   3. A rejected draft gets one revision with the problems found. If that
 *      also fails, the result is the standard insufficient-evidence response.
 *
 * Model calls, tool calls, tokens and time are all capped. Provider failures
 * (timeout, rate limit, outage) are thrown as `ModelError` for the caller to
 * report; a malformed answer is a failed draft, not an error.
 *
 * The verifier is another model reading the same evidence. Its approval
 * lowers the chance of unsupported text but proves nothing.
 */
import type { Audience, ExplainTrace, TraceStep, VerificationSummary } from "@/explain/api";
import type { MatchFixture } from "@/match/contract";
import { EvidenceSession, EVIDENCE_TOOLS } from "@/explain/evidence";
import { checkGrounding } from "@/explain/grounding";
import {
  analystInstructions,
  evidenceMessage,
  parseReview,
  revisionMessage,
  STRICT_EXPLANATION_SCHEMA,
  STRICT_REVIEW_SCHEMA,
  VERIFIER_INSTRUCTIONS,
  verifierMessage,
} from "@/explain/prompts";
import { insufficientEvidence, parseExplanation, type ExplanationResponse } from "@/explain/response";
import { ModelError, type ChatMessage, type ChatRequest, type ChatResult, type ModelClient } from "./foundry";

export const WORKFLOW_LIMITS = {
  /** Whole workflow, from the first model call to the answer. */
  totalMs: 60_000,
  /** One model call. */
  modelCallMs: 25_000,
  /** Model calls in total: analyst turns, verifier reviews and the revision. */
  modelCalls: 8,
  /** Evidence tool calls in total. */
  toolCalls: 6,
  /** Analyst turns per draft; the last one may not call tools. */
  analystTurns: 3,
  analystCompletionTokens: 2_000,
  verifierCompletionTokens: 1_200,
  /** Prompt plus completion tokens in total, as reported by the provider. */
  totalTokens: 80_000,
  /** Trace entries kept. */
  traceSteps: 40,
} as const;

export type WorkflowLimits = { [K in keyof typeof WORKFLOW_LIMITS]: number };

export interface ExplainInput {
  fixture: MatchFixture;
  timeMs: number;
  audience: Audience;
  client: ModelClient;
  /** Aborts the workflow, e.g. when the browser disconnects. */
  signal?: AbortSignal;
  limits?: Partial<WorkflowLimits>;
  now?: () => number;
}

export interface ExplainOutput {
  explanation: ExplanationResponse;
  verification: VerificationSummary;
  trace: ExplainTrace;
}

/** The workflow ran out of model calls or tokens; ends in the fallback, not an error. */
class BudgetExhausted extends Error {}
/** The verifier answered, but not with a usable review. Revising the draft would not help, so this ends in the fallback. */
class ReviewUnavailable extends Error {}

interface Evaluation {
  response: ExplanationResponse | null;
  schema: boolean;
  grounding: boolean | null;
  modelReview: boolean | null;
  issues: string[];
}

const FALLBACK_REASON = "The explanation could not be checked against the match data, so none is shown.";
const INSUFFICIENT_REASON = "The match data up to this moment is not enough to explain it.";

/**
 * A deliberately high estimate of a request's prompt tokens: one token per
 * 3 bytes of the JSON sent (messages, tools and schema) plus a fixed overhead.
 */
export function estimatePromptTokens(request: Pick<ChatRequest, "messages" | "tools" | "schema">): number {
  const bytes = new TextEncoder().encode(JSON.stringify([request.messages, request.tools ?? [], request.schema])).length;
  return Math.ceil(bytes / 3) + 50 * request.messages.length + 100;
}

export async function explainMoment(input: ExplainInput): Promise<ExplainOutput> {
  const limits: WorkflowLimits = { ...WORKFLOW_LIMITS, ...input.limits };
  const now = input.now ?? (() => performance.now());
  const started = now();
  const deadline = started + limits.totalMs;
  const session = new EvidenceSession(input.fixture, input.timeMs);

  const steps: TraceStep[] = [];
  const trace = (step: TraceStep) => {
    if (steps.length < limits.traceSteps) steps.push(step);
  };
  let modelCalls = 0;
  let toolCalls = 0;
  /** Tokens as reported by the provider. */
  const tokens = { prompt: 0, completion: 0 };
  /** Tokens counted against `totalTokens`: reported usage, or the full reservation when usage is missing. */
  let charged = 0;

  const call = async (request: Omit<ChatRequest, "signal">): Promise<ChatResult> => {
    if (modelCalls >= limits.modelCalls) throw new BudgetExhausted("model call limit reached");
    // Reserve the estimated prompt plus the whole completion allowance before calling.
    const reserve = estimatePromptTokens(request) + request.maxCompletionTokens;
    if (charged + reserve > limits.totalTokens)
      throw new BudgetExhausted(`token limit reached (${charged} used, ${reserve} needed, ${limits.totalTokens} allowed)`);
    const remaining = deadline - now();
    if (remaining < 1_000) throw new ModelError("timeout", "The explanation took too long.");
    modelCalls++;
    const timeout = AbortSignal.timeout(Math.min(limits.modelCallMs, remaining));
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const t0 = now();
    const result = await input.client.complete({ ...request, signal });
    if (result.usage) {
      tokens.prompt += result.usage.prompt;
      tokens.completion += result.usage.completion;
    }
    // Without reported usage, assume the worst case that was reserved.
    charged += result.usage ? result.usage.prompt + result.usage.completion : reserve;
    trace({
      kind: "model",
      role: request.role,
      ms: Math.round(now() - t0),
      finishReason: result.finishReason,
      toolCalls: result.toolCalls.length,
      tokens: result.usage,
    });
    // A call that went over the budget is not used, so an over-budget review never yields "verified".
    if (charged > limits.totalTokens) throw new BudgetExhausted(`token limit reached (${charged} used, ${limits.totalTokens} allowed)`);
    return result;
  };

  const messages: ChatMessage[] = [
    { role: "system", content: analystInstructions(input.audience) },
    { role: "user", content: evidenceMessage(session.base) },
  ];

  /** One draft: analyst turns until it answers without tool calls. Null when it never does. */
  const draft = async (): Promise<string | null> => {
    for (let turn = 0; turn < limits.analystTurns; turn++) {
      const toolsAllowed = turn < limits.analystTurns - 1 && toolCalls < limits.toolCalls;
      const result = await call({
        role: "analyst",
        messages,
        tools: EVIDENCE_TOOLS,
        toolChoice: toolsAllowed ? "auto" : "none",
        schema: { name: "explanation", schema: STRICT_EXPLANATION_SCHEMA },
        maxCompletionTokens: limits.analystCompletionTokens,
      });
      if (result.toolCalls.length === 0) {
        messages.push({ role: "assistant", content: result.content ?? "" });
        return result.content;
      }
      messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
      for (const tc of result.toolCalls) {
        if (!toolsAllowed || toolCalls >= limits.toolCalls) {
          messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "No more tool calls are allowed; answer now." }) });
          continue;
        }
        toolCalls++;
        const t0 = now();
        const out = session.call(tc.function.name, tc.function.arguments);
        trace({
          kind: "tool",
          name: tc.function.name.slice(0, 40),
          ok: out.ok,
          ms: Math.round(now() - t0),
          events: out.ok ? out.events : [],
          snapshots: out.ok ? out.snapshots : [],
          ...(out.ok ? {} : { error: out.error }),
        });
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out.ok ? out.content : { error: out.error }) });
      }
    }
    return null;
  };

  const evaluate = async (text: string | null): Promise<Evaluation> => {
    if (text === null) return { response: null, schema: false, grounding: null, modelReview: null, issues: ["no answer: the analyst kept calling tools"] };
    const context = session.context();
    const parsed = parseExplanation(text, context);
    if (!parsed.ok) return { response: null, schema: false, grounding: null, modelReview: null, issues: parsed.errors };
    const response = parsed.response;
    const grounding = checkGrounding(response, context, input.audience);
    if (grounding.length > 0) return { response, schema: true, grounding: false, modelReview: null, issues: grounding };
    // The analyst's own insufficient-evidence answer is not reviewed, so none of its wording is shown:
    // it is replaced with the fixed response.
    if (response.status === "insufficient-evidence")
      return { response: insufficientEvidence(session.base, INSUFFICIENT_REASON), schema: true, grounding: true, modelReview: null, issues: [] };

    const review = await call({
      role: "verifier",
      messages: [
        { role: "system", content: VERIFIER_INSTRUCTIONS },
        { role: "user", content: verifierMessage(context, response) },
      ],
      schema: { name: "review", schema: STRICT_REVIEW_SCHEMA },
      maxCompletionTokens: limits.verifierCompletionTokens,
    });
    const verdict = parseReview(review.content ?? "", response);
    if (!verdict.ok) throw new ReviewUnavailable(verdict.error);
    const issues = verdict.unsupported.map((u) => `${u.target} is not supported by its evidence${u.reason ? `: ${u.reason}` : ""}`);
    return { response, schema: true, grounding: true, modelReview: issues.length === 0, issues };
  };

  const issues: string[] = [];
  let explanation: ExplanationResponse | null = null;
  let verification: VerificationSummary | null = null;
  let revisions: 0 | 1 = 0;
  let last: Pick<Evaluation, "schema" | "grounding" | "modelReview"> | null = null;
  try {
    for (const attempt of [0, 1] as const) {
      revisions = attempt;
      let e: Evaluation;
      try {
        e = await evaluate(await draft());
      } catch (error) {
        if (error instanceof ReviewUnavailable) last = { schema: true, grounding: true, modelReview: false };
        throw error;
      }
      last = e;
      trace({
        kind: "check",
        stage: attempt === 0 ? "draft" : "revision",
        schema: e.schema,
        grounding: e.grounding === true,
        modelReview: e.modelReview,
        issues: e.issues.length,
      });
      if (e.issues.length === 0 && e.response) {
        explanation = e.response;
        verification = {
          outcome: e.response.status === "insufficient-evidence" ? "insufficient-evidence" : attempt === 0 ? "verified" : "revised",
          revisions: attempt,
          schema: "passed",
          grounding: "passed",
          modelReview: e.modelReview === null ? "skipped" : "passed",
          issues: issues.slice(0, 10),
        };
        break;
      }
      issues.push(...e.issues.map((i) => i.slice(0, 300)));
      if (attempt === 0) messages.push({ role: "user", content: revisionMessage(e.issues) });
    }
  } catch (error) {
    if (error instanceof BudgetExhausted) issues.push(`workflow budget used up (${error.message})`);
    else if (error instanceof ReviewUnavailable) issues.push(`the verifier's answer could not be used (${error.message})`);
    else throw error;
  }

  if (!explanation || !verification) {
    explanation = insufficientEvidence(session.base, FALLBACK_REASON);
    const state = (v: boolean | null | undefined) => (v === true ? "passed" : v === false ? "failed" : "skipped");
    verification = {
      outcome: "fallback",
      revisions,
      schema: last?.schema ? "passed" : "failed",
      grounding: state(last?.grounding),
      modelReview: state(last?.modelReview),
      issues: issues.slice(0, 10),
    };
  }

  return {
    explanation,
    verification,
    trace: { totalMs: Math.round(now() - started), modelCalls, toolCalls, tokens, chargedTokens: charged, steps },
  };
}

