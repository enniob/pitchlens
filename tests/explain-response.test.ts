import { describe, expect, it } from "vitest";
import { extractMatchContext } from "@/explain/context";
import {
  EXPLANATION_JSON_SCHEMA,
  EXPLANATION_LIMITS,
  insufficientEvidence,
  parseExplanation,
  validateExplanation,
  type ExplanationResponse,
} from "@/explain/response";
import { sampleFixture } from "@/match/fixture";

const context = extractMatchContext(sampleFixture, 9_400);

const valid: ExplanationResponse = {
  explanationVersion: "1.0.0",
  matchId: sampleFixture.matchId,
  timeMs: 9_400,
  status: "explained",
  headline: "Harbor City score after a three-pass move",
  explanation:
    "Harbor City won the ball, passed it forward three times and their number 9 shot from inside the area. The ball crossed the line, making it 1–0.",
  facts: [
    { text: "Harbor City #6 won the ball at 2.4 s.", evidence: [{ kind: "event", id: "e1-turnover" }] },
    { text: "#9 shot at 8.8 s and the ball crossed the line at 9.4 s.", evidence: [{ kind: "event", id: "e5-shot" }, { kind: "event", id: "e6-goal" }] },
    { text: "The score is 1–0.", evidence: [{ kind: "snapshot", t: 9_400 }, { kind: "event", id: "e6-goal" }] },
  ],
  interpretation: [
    { text: "Quick forward passing after the turnover left little time to defend the move.", evidence: [{ kind: "event", id: "e2-pass" }, { kind: "event", id: "e4-pass" }] },
  ],
  limitations: ["Synthetic scripted sequence; not real football."],
};

const withChange = (change: (r: Record<string, unknown>) => void) => {
  const copy = structuredClone(valid) as unknown as Record<string, unknown>;
  change(copy);
  return validateExplanation(copy, context);
};
const errorsOf = (r: ReturnType<typeof validateExplanation>) => (r.ok ? [] : r.errors);
const fact = (r: Record<string, unknown>, i = 0) => (r.facts as Record<string, unknown>[])[i]!;

describe("valid responses", () => {
  it("accepts a grounded explanation, as an object and as JSON text", () => {
    expect(validateExplanation(valid, context)).toEqual({ ok: true, response: valid });
    expect(parseExplanation(JSON.stringify(valid), context).ok).toBe(true);
  });

  it("accepts an insufficient-evidence response, including the built-in fallback", () => {
    const fallback = insufficientEvidence(context, "The model response could not be validated.");
    expect(validateExplanation(fallback, context).ok).toBe(true);
    const partial = withChange((r) => {
      r.status = "insufficient-evidence";
      r.interpretation = [];
    });
    expect(partial.ok).toBe(true);
  });

  it("allows intent or cause wording in interpretation, where it is presented as a reading", () => {
    const r = withChange((r) => {
      r.interpretation = [{ text: "The defence was stretched because of the quick passing.", evidence: [{ kind: "event", id: "e3-pass" }] }];
    });
    expect(r.ok).toBe(true);
  });

  it("the JSON Schema requires the same fields the validator does", () => {
    expect([...EXPLANATION_JSON_SCHEMA.required].sort()).toEqual(Object.keys(valid).sort());
    expect(Object.keys(EXPLANATION_JSON_SCHEMA.properties).sort()).toEqual(Object.keys(valid).sort());
  });
});

describe("evidence references", () => {
  it("rejects a fabricated event", () => {
    const r = withChange((r) => {
      fact(r).evidence = [{ kind: "event", id: "e99-goal" }];
    });
    expect(errorsOf(r)).toEqual(["facts[0].evidence[0] cites event e99-goal, which is not in the context"]);
  });

  it("rejects a real event that is not in this context (a later one)", () => {
    const r = withChange((r) => {
      fact(r).evidence = [{ kind: "event", id: "e7-kickoff" }];
    });
    expect(errorsOf(r).join()).toMatch(/e7-kickoff, which is not in the context/);
  });

  it("rejects an event outside the context's lookback window", () => {
    const narrow = extractMatchContext(sampleFixture, 9_400, { lookbackMs: 2_000 });
    const r = validateExplanation({ ...valid, facts: [valid.facts[0]!], interpretation: [] }, narrow);
    expect(r.ok ? [] : r.errors).toEqual(["facts[0].evidence[0] cites event e1-turnover, which is not in the context"]);
  });

  it("rejects snapshots that are not in the context, including future and interpolated times", () => {
    for (const t of [9_500, 9_450, 1_234]) {
      const r = withChange((r) => {
        fact(r).evidence = [{ kind: "snapshot", t }];
      });
      expect(errorsOf(r)).toEqual([`facts[0].evidence[0] cites a snapshot at ${t} ms, which is not in the context`]);
    }
  });

  it("rejects claims without evidence, malformed and duplicate references", () => {
    const cases: [unknown, RegExp][] = [
      [undefined, /must cite at least one/],
      [[], /must cite at least one/],
      ["e6-goal", /must cite at least one/],
      [["e6-goal"], /must be an object/],
      [[{ kind: "player", id: "hcf-9" }], /unknown kind player/],
      [[{ kind: "event", id: "e6-goal", t: 9_400 }], /must be \{ kind: "event", id \}/],
      [[{ kind: "snapshot", t: "9400" }], /must be \{ kind: "snapshot", t \}/],
      [[{ kind: "event", id: "e6-goal" }, { kind: "event", id: "e6-goal" }], /duplicate/],
      [Array.from({ length: EXPLANATION_LIMITS.evidencePerClaim + 1 }, () => ({ kind: "event", id: "e6-goal" })), /more than 8 references/],
    ];
    for (const [evidence, message] of cases) {
      const r = withChange((r) => {
        fact(r).evidence = evidence;
      });
      expect(r.ok).toBe(false);
      expect(errorsOf(r).join("\n")).toMatch(message);
    }
  });

  it("checks interpretation citations as strictly as facts", () => {
    const r = withChange((r) => {
      (r.interpretation as Record<string, unknown>[])[0]!.evidence = [{ kind: "event", id: "made-up" }];
    });
    expect(errorsOf(r)).toEqual(["interpretation[0].evidence[0] cites event made-up, which is not in the context"]);
  });
});

describe("facts versus interpretation", () => {
  it.each([
    "#9 shot because the keeper was off his line.",
    "#6 tried to find #8.",
    "#10 intended to play a through ball.",
    "The pass was deliberate.",
    "#9 decided to shoot early.",
    "The goal was caused by a defensive error.",
  ])("rejects a fact asserting intent or cause: %s", (text) => {
    const r = withChange((r) => {
      fact(r).text = text;
    });
    expect(errorsOf(r).join()).toMatch(/must not assert intent or cause/);
  });
});

describe("invalid responses", () => {
  it.each([null, [], "explained", 42])("rejects a non-object: %j", (value) => {
    expect(validateExplanation(value, context)).toEqual({ ok: false, errors: ["response must be a JSON object"] });
  });

  it("rejects invalid JSON text", () => {
    expect(parseExplanation("{ headline: 'Goal' ", context)).toEqual({ ok: false, errors: ["response is not valid JSON"] });
  });

  const cases: [string, (r: Record<string, unknown>) => void, RegExp][] = [
    ["a missing headline", (r) => delete r.headline, /missing field headline/],
    ["an empty explanation", (r) => (r.explanation = "   "), /explanation must be a non-empty string/],
    ["a long headline", (r) => (r.headline = "x".repeat(EXPLANATION_LIMITS.headline + 1)), /headline is longer than 100/],
    ["an unknown field", (r) => (r.confidence = 0.9), /unexpected field confidence/],
    ["an unknown claim field", (r) => (fact(r).speaker = "hcf-9"), /facts\[0\]: unexpected field speaker/],
    ["a wrong version", (r) => (r.explanationVersion = "2.0.0"), /explanationVersion must be 1.0.0/],
    ["another match", (r) => (r.matchId = "other-match"), /matchId does not match/],
    ["another time", (r) => (r.timeMs = 9_500), /timeMs does not match/],
    ["an unknown status", (r) => (r.status = "certain"), /status must be one of/],
    ["facts that are not a list", (r) => (r.facts = "a goal"), /facts must be a list/],
    ["too many facts", (r) => (r.facts = Array.from({ length: 9 }, () => fact(r))), /facts has more than 8/],
    ["an explained response without facts", (r) => (r.facts = []), /needs at least one fact/],
    [
      "insufficient evidence with interpretation",
      (r) => (r.status = "insufficient-evidence"),
      /must not interpret/,
    ],
    [
      "insufficient evidence without limitations",
      (r) => {
        r.status = "insufficient-evidence";
        r.interpretation = [];
        r.limitations = [];
      },
      /must say what is missing/,
    ],
    ["an empty limitation", (r) => (r.limitations = [""]), /limitations\[0\] must be a non-empty string/],
  ];
  it.each(cases)("rejects %s", (_, change, message) => {
    const r = withChange(change);
    expect(r.ok).toBe(false);
    expect(errorsOf(r).join("\n")).toMatch(message);
  });
});
