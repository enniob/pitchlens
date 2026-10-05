/** A scripted stand-in for the Foundry client, for workflow and handler tests. No network. */
import type { ChatRequest, ChatResult, ModelClient, ToolCall } from "@/server/foundry";
import { sampleFixture } from "@/match/fixture";
import type { ExplanationResponse } from "@/explain/response";

export type Step = ChatResult | Error | ((request: ChatRequest) => ChatResult | Error | Promise<ChatResult | Error>);

/** Answers each call with the next step; each request is recorded (messages copied as they were sent). */
export class FakeModel implements ModelClient {
  readonly requests: ChatRequest[] = [];
  constructor(private readonly steps: Step[]) {}

  async complete(request: ChatRequest): Promise<ChatResult> {
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    const step = this.steps.shift();
    if (step === undefined) throw new Error("FakeModel: no more scripted steps");
    const out = typeof step === "function" ? await step(request) : step;
    if (out instanceof Error) throw out;
    return out;
  }
}

export const answer = (value: unknown, usage = { prompt: 1_000, completion: 200 }): ChatResult => ({
  content: typeof value === "string" ? value : JSON.stringify(value),
  toolCalls: [],
  finishReason: "stop",
  usage,
});

let callId = 0;
export const toolCall = (name: string, args: unknown): ChatResult => ({
  content: null,
  toolCalls: [{ id: `call_${++callId}`, type: "function", function: { name, arguments: JSON.stringify(args) } } satisfies ToolCall],
  finishReason: "tool_calls",
  usage: { prompt: 800, completion: 30 },
});

/** A verifier answer approving every target of `draft`. */
export const approve = (draft: ExplanationResponse): ChatResult =>
  answer({
    reviews: ["headline", "explanation", ...draft.facts.map((_, i) => `facts[${i}]`), ...draft.interpretation.map((_, i) => `interpretation[${i}]`)].map(
      (target) => ({ target, verdict: "supported", reason: "" }),
    ),
  });

/** The documented valid explanation of the scripted demo's goal at 9 400 ms. */
export const goalExplanation = (): ExplanationResponse => ({
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
    {
      text: "Quick forward passing after the turnover left little time to defend the move.",
      evidence: [{ kind: "event", id: "e2-pass" }, { kind: "event", id: "e4-pass" }],
    },
  ],
  limitations: ["Synthetic scripted sequence; not real football."],
});
