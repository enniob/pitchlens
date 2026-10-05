/**
 * "Explain this moment": the HTTP contract between the viewer and the
 * explanation service (`POST /api/explain`).
 *
 * Types only, plus the audience list and error-code table, so the browser can
 * import it without pulling in server code. See docs/explain-service.md.
 */
import type { MatchReference } from "./matchRef";
import type { ExplanationResponse } from "./response";

export const EXPLAIN_API_VERSION = "1.0.0" as const;
export const EXPLAIN_PATH = "/api/explain";

/** Who the explanation is written for. Wording only; the evidence and checks are the same. */
export const AUDIENCES = ["casual", "analyst"] as const;
export type Audience = (typeof AUDIENCES)[number];

export interface ExplainRequest {
  /** Optional client correlation ID (8–64 of A–Z, a–z, 0–9, '_', '-'); echoed back. Not an idempotency key. */
  requestId?: string;
  match: MatchReference;
  /** Playback time in ms, 0 to the match duration; floored to whole ms. */
  timeMs: number;
  audience: Audience;
}

/** How the explanation was checked. Automated checks reduce, but cannot rule out, unsupported text. */
export interface VerificationSummary {
  /**
   * `verified`: the first draft passed every check. `revised`: it failed, the
   * one allowed revision passed. `fallback`: no draft passed, so the
   * explanation is the standard insufficient-evidence response.
   * `insufficient-evidence`: the analyst itself said the evidence is not enough.
   */
  outcome: "verified" | "revised" | "fallback" | "insufficient-evidence";
  revisions: 0 | 1;
  /** Contract validation and citation resolution (validateExplanation). */
  schema: "passed" | "failed";
  /** Deterministic text checks against the cited evidence (grounding.ts). */
  grounding: "passed" | "failed" | "skipped";
  /** A second model reading the draft against the evidence. A review, not proof. */
  modelReview: "passed" | "failed" | "skipped";
  /** Why drafts were rejected, shortened; empty when the first draft passed. */
  issues: string[];
}

export type TraceStep =
  | {
      kind: "model";
      role: "analyst" | "verifier";
      ms: number;
      finishReason: string;
      toolCalls: number;
      tokens: { prompt: number; completion: number } | null;
    }
  | {
      kind: "tool";
      name: string;
      ok: boolean;
      ms: number;
      /** Evidence the call returned: event IDs and snapshot times. */
      events: string[];
      snapshots: number[];
      error?: string;
    }
  | { kind: "check"; stage: "draft" | "revision"; schema: boolean; grounding: boolean; modelReview: boolean | null; issues: number };

/** What happened, without prompts, model text or credentials. */
export interface ExplainTrace {
  totalMs: number;
  modelCalls: number;
  toolCalls: number;
  /** Tokens as reported by the provider. */
  tokens: { prompt: number; completion: number };
  /** Tokens counted against the budget: reported usage, or the full reservation for a call that reported none. */
  chargedTokens: number;
  steps: TraceStep[];
}

export interface ExplainSuccess {
  apiVersion: typeof EXPLAIN_API_VERSION;
  ok: true;
  requestId: string;
  matchId: string;
  timeMs: number;
  audience: Audience;
  explanation: ExplanationResponse;
  verification: VerificationSummary;
  trace: ExplainTrace;
  /** True when served from the service's short-lived cache of identical requests. */
  cached: boolean;
}

export const EXPLAIN_ERRORS = {
  "invalid-request": { status: 400, retryable: false },
  "unauthorized": { status: 401, retryable: false },
  "forbidden-origin": { status: 403, retryable: false },
  "unknown-match": { status: 404, retryable: false },
  "payload-too-large": { status: 413, retryable: false },
  "unsupported-media-type": { status: 415, retryable: false },
  "rate-limited": { status: 429, retryable: true },
  "busy": { status: 429, retryable: true },
  "internal-error": { status: 500, retryable: true },
  "upstream-error": { status: 502, retryable: true },
  "not-configured": { status: 503, retryable: false },
  "upstream-rate-limited": { status: 503, retryable: true },
  "timeout": { status: 504, retryable: true },
} as const;
export type ExplainErrorCode = keyof typeof EXPLAIN_ERRORS;

export interface ExplainFailure {
  apiVersion: typeof EXPLAIN_API_VERSION;
  ok: false;
  requestId: string;
  error: {
    code: ExplainErrorCode;
    /** Plain words, safe to show; never contains credentials or provider bodies. */
    message: string;
    retryable: boolean;
    /** When to try again, for rate-limit codes. Also sent as the Retry-After header. */
    retryAfterMs?: number;
  };
}

export type ExplainApiResponse = ExplainSuccess | ExplainFailure;
