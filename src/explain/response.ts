/**
 * "Explain this moment": the explanation response contract.
 *
 * Whatever produces an explanation (later a hosted model, today only tests)
 * must return an `ExplanationResponse` for one `MatchContext`, and nothing is
 * shown until `validateExplanation` accepts it against that same context. The
 * contract is plain JSON and names no provider.
 *
 * Observable facts and tactical interpretation are kept apart. Every claim of
 * either kind cites evidence, and every citation must resolve to an event or
 * snapshot actually included in the context, so a response cannot cite
 * fabricated or future data. Facts must not assert intent or cause; see
 * `FACT_SPECULATION`.
 */
import type { MatchContext } from "./context";

export const EXPLANATION_VERSION = "1.0.0" as const;

export const EXPLANATION_LIMITS = {
  headline: 100,
  explanation: 1_200,
  claimText: 300,
  facts: 8,
  interpretation: 5,
  evidencePerClaim: 8,
  limitations: 8,
  limitationText: 300,
} as const;

/** A citation: an event by ID, or a snapshot by its timestamp. */
export type EvidenceRef = { kind: "event"; id: string } | { kind: "snapshot"; t: number };

export interface Claim {
  text: string;
  evidence: EvidenceRef[];
}

export type ExplanationStatus = "explained" | "insufficient-evidence";

export interface ExplanationResponse {
  explanationVersion: typeof EXPLANATION_VERSION;
  /** Must match the context's match and selected time. */
  matchId: string;
  timeMs: number;
  status: ExplanationStatus;
  /** Short headline. */
  headline: string;
  /** Plain-language explanation, consistent with the facts and interpretation below. */
  explanation: string;
  /** Observable facts only: what happened, where, when, who. At least one when explained. */
  facts: Claim[];
  /** Tactical reading of the facts. Must stay empty when the evidence is insufficient. */
  interpretation: Claim[];
  /** Caveats. At least one when the evidence is insufficient. */
  limitations: string[];
}

export type ExplanationValidation = { ok: true; response: ExplanationResponse } | { ok: false; errors: string[] };

/**
 * Wording that asserts intent or cause. Allowed in interpretation (where it is
 * presented as a reading), rejected in facts. Deliberately conservative: a
 * false rejection costs a retry, a false acceptance presents speculation as fact.
 */
export const FACT_SPECULATION =
  /\b(because|due to|so that|in order to|caus(e|ed|es|ing)|intend\w*|intention\w*|tried|tries|trying|attempt\w*|wanted|wants?|decid\w*|deliberate\w*|meant to|planned|plans? to|hoped?|chose|choos\w*)\b/i;

const KEYS = ["explanationVersion", "matchId", "timeMs", "status", "headline", "explanation", "facts", "interpretation", "limitations"];
const STATUSES: readonly string[] = ["explained", "insufficient-evidence"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks `value` against the contract and resolves every citation against `context`. */
export function validateExplanation(value: unknown, context: MatchContext): ExplanationValidation {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(msg);
  if (!isObject(value)) return { ok: false, errors: ["response must be a JSON object"] };

  for (const key of Object.keys(value)) if (!KEYS.includes(key)) err(`unexpected field ${key}`);
  for (const key of KEYS) if (!(key in value)) err(`missing field ${key}`);

  const text = (where: string, v: unknown, max: number) => {
    if (typeof v !== "string" || v.trim() === "") err(`${where} must be a non-empty string`);
    else if (v.length > max) err(`${where} is longer than ${max} characters`);
  };

  if (value.explanationVersion !== EXPLANATION_VERSION) err(`explanationVersion must be ${EXPLANATION_VERSION}`);
  if (value.matchId !== context.match.matchId) err(`matchId does not match the context (${context.match.matchId})`);
  if (value.timeMs !== context.time.selectedMs) err(`timeMs does not match the context (${context.time.selectedMs})`);
  if (!STATUSES.includes(value.status as string)) err(`status must be one of ${STATUSES.join(", ")}`);
  text("headline", value.headline, EXPLANATION_LIMITS.headline);
  text("explanation", value.explanation, EXPLANATION_LIMITS.explanation);

  const eventIds = new Set(context.events.map((e) => e.id));
  const snapshotTimes = new Set(context.snapshots.map((s) => s.t));
  const claims = (field: "facts" | "interpretation", max: number): number => {
    const list = value[field];
    if (!Array.isArray(list)) {
      if (field in value) err(`${field} must be a list`);
      return 0;
    }
    if (list.length > max) err(`${field} has more than ${max} claims`);
    list.forEach((claim, i) => {
      const where = `${field}[${i}]`;
      if (!isObject(claim)) {
        err(`${where} must be an object`);
        return;
      }
      for (const key of Object.keys(claim)) if (key !== "text" && key !== "evidence") err(`${where}: unexpected field ${key}`);
      text(`${where}.text`, claim.text, EXPLANATION_LIMITS.claimText);
      if (field === "facts" && typeof claim.text === "string" && FACT_SPECULATION.test(claim.text))
        err(`${where}: a fact must not assert intent or cause ("${claim.text.match(FACT_SPECULATION)![0]}"); move it to interpretation`);
      const refs = claim.evidence;
      if (!Array.isArray(refs) || refs.length === 0) {
        err(`${where}.evidence must cite at least one event or snapshot`);
        return;
      }
      if (refs.length > EXPLANATION_LIMITS.evidencePerClaim) err(`${where}.evidence has more than ${EXPLANATION_LIMITS.evidencePerClaim} references`);
      const seen = new Set<string>();
      refs.forEach((ref, j) => {
        const at = `${where}.evidence[${j}]`;
        if (!isObject(ref)) {
          err(`${at} must be an object`);
          return;
        }
        const key = JSON.stringify(ref);
        if (seen.has(key)) err(`${at} is a duplicate`);
        seen.add(key);
        if (ref.kind === "event") {
          if (Object.keys(ref).length !== 2 || typeof ref.id !== "string") err(`${at} must be { kind: "event", id }`);
          else if (!eventIds.has(ref.id)) err(`${at} cites event ${ref.id}, which is not in the context`);
        } else if (ref.kind === "snapshot") {
          if (Object.keys(ref).length !== 2 || typeof ref.t !== "number") err(`${at} must be { kind: "snapshot", t }`);
          else if (!snapshotTimes.has(ref.t)) err(`${at} cites a snapshot at ${ref.t} ms, which is not in the context`);
        } else err(`${at} has unknown kind ${String(ref.kind)}`);
      });
    });
    return list.length;
  };
  const facts = claims("facts", EXPLANATION_LIMITS.facts);
  const interpretation = claims("interpretation", EXPLANATION_LIMITS.interpretation);

  const limitations = value.limitations;
  if (!Array.isArray(limitations)) {
    if ("limitations" in value) err("limitations must be a list");
  } else {
    if (limitations.length > EXPLANATION_LIMITS.limitations) err(`limitations has more than ${EXPLANATION_LIMITS.limitations} entries`);
    limitations.forEach((l, i) => text(`limitations[${i}]`, l, EXPLANATION_LIMITS.limitationText));
  }

  if (value.status === "explained" && facts === 0) err("an explained response needs at least one fact");
  if (value.status === "insufficient-evidence") {
    if (interpretation > 0) err("an insufficient-evidence response must not interpret");
    if (!Array.isArray(limitations) || limitations.length === 0) err("an insufficient-evidence response must say what is missing in limitations");
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, response: value as unknown as ExplanationResponse };
}

/** Parses raw JSON text (e.g. a model's output) and validates it. */
export function parseExplanation(json: string, context: MatchContext): ExplanationValidation {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, errors: ["response is not valid JSON"] };
  }
  return validateExplanation(value, context);
}

/** A valid response saying the moment cannot be explained from the evidence, e.g. as a fallback after a rejected response. */
export function insufficientEvidence(context: MatchContext, reason: string): ExplanationResponse {
  return {
    explanationVersion: EXPLANATION_VERSION,
    matchId: context.match.matchId,
    timeMs: context.time.selectedMs,
    status: "insufficient-evidence",
    headline: "Not enough evidence to explain this moment",
    explanation: "The available match data does not support an explanation of this moment.",
    facts: [],
    interpretation: [],
    limitations: [reason.slice(0, EXPLANATION_LIMITS.limitationText)],
  };
}

const claimSchema = (description: string) => ({
  type: "array",
  description,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["text", "evidence"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: EXPLANATION_LIMITS.claimText },
      evidence: {
        type: "array",
        minItems: 1,
        maxItems: EXPLANATION_LIMITS.evidencePerClaim,
        items: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "id"],
              properties: { kind: { const: "event" }, id: { type: "string" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "t"],
              properties: { kind: { const: "snapshot" }, t: { type: "number" } },
            },
          ],
        },
      },
    },
  },
});

/**
 * JSON Schema (2020-12) of the response's shape, for providers that support
 * structured output. It cannot express the cross-checks against the context
 * (citations, matchId, timeMs, status rules), so `validateExplanation` stays
 * the authority.
 */
export const EXPLANATION_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "PitchLens explanation response",
  type: "object",
  additionalProperties: false,
  required: KEYS,
  properties: {
    explanationVersion: { const: EXPLANATION_VERSION },
    matchId: { type: "string" },
    timeMs: { type: "number" },
    status: { enum: STATUSES },
    headline: { type: "string", minLength: 1, maxLength: EXPLANATION_LIMITS.headline },
    explanation: { type: "string", minLength: 1, maxLength: EXPLANATION_LIMITS.explanation },
    facts: { ...claimSchema("Observable facts only, each citing the context."), maxItems: EXPLANATION_LIMITS.facts },
    interpretation: {
      ...claimSchema("Tactical reading of the facts, each citing the context. Empty when evidence is insufficient."),
      maxItems: EXPLANATION_LIMITS.interpretation,
    },
    limitations: {
      type: "array",
      maxItems: EXPLANATION_LIMITS.limitations,
      items: { type: "string", minLength: 1, maxLength: EXPLANATION_LIMITS.limitationText },
    },
  },
} as const;
