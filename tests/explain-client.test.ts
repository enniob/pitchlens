import { describe, expect, it, vi } from "vitest";
import { requestExplanation } from "@/explain/client";
import { sampleFixture } from "@/match/fixture";
import { extractMatchContext } from "@/explain/context";
import { insufficientEvidence } from "@/explain/response";

const signal = new AbortController().signal;
const answer = (timeMs = 9_400) => ({
  apiVersion: "1.0.0", ok: true, matchId: sampleFixture.matchId, timeMs, audience: "casual",
  explanation: insufficientEvidence(extractMatchContext(sampleFixture, timeMs), "Only synthetic match evidence is available."),
});
const reply = (body: unknown, status = 200) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe("viewer explanation transport", () => {
  it("posts only a match reference, time and audience with cancellation", async () => {
    const fetcher = reply(answer());
    const result = await requestExplanation(sampleFixture, sampleFixture.matchId, 9_400.5, "casual", signal, fetcher);
    expect(result.explanation.status).toBe("insufficient-evidence");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("/api/explain");
    expect(init?.signal).toBe(signal);
    expect(JSON.parse(String(init?.body))).toEqual({ match: { kind: "sample", matchId: sampleFixture.matchId }, timeMs: 9_400, audience: "casual" });
    expect(init?.headers).toEqual({ "content-type": "application/json" });
  });

  it.each(["matchId", "timeMs", "audience"])("rejects a response for a different %s", async (field) => {
    await expect(requestExplanation(sampleFixture, sampleFixture.matchId, 9_400, "casual", signal,
      reply({ ...answer(), [field]: "wrong" }))).rejects.toThrow("does not match");
  });

  it.each([{ kind: "event", id: "invented-event" }, { kind: "snapshot", t: 9_500 },
    { kind: "event", id: sampleFixture.events.find((e) => e.t > 9_400)!.id }])("rejects unsupported or future citations %j", async (ref) => {
    const body = answer();
    body.explanation.facts = [{ text: "A match event occurred.", evidence: [ref as never] }];
    await expect(requestExplanation(sampleFixture, sampleFixture.matchId, 9_400, "casual", signal, reply(body))).rejects.toThrow("could not be checked");
  });

  it("accepts bounded earlier evidence and rejects it after seeking backwards", async () => {
    const body = answer();
    body.explanation.facts = [{ text: "A match event occurred.", evidence: [{ kind: "snapshot", t: 9_300 }] }];
    await expect(requestExplanation(sampleFixture, sampleFixture.matchId, 9_400, "casual", signal, reply(body))).resolves.toBeDefined();
    const earlier = answer(9_000);
    earlier.explanation.facts = body.explanation.facts;
    await expect(requestExplanation(sampleFixture, sampleFixture.matchId, 9_000, "casual", signal, reply(earlier))).rejects.toThrow("could not be checked");
  });

  it("shows safe errors without returning provider text", async () => {
    await expect(requestExplanation(sampleFixture, sampleFixture.matchId, 9_400, "casual", signal,
      reply({ ok: false, error: { code: "timeout", message: "PRIVATE_PROVIDER_BODY" } }, 504))).rejects.toThrow("took too long");
    await expect(requestExplanation(sampleFixture, sampleFixture.matchId, 9_400, "casual", signal,
      reply({ error: "PRIVATE_PROVIDER_BODY" }, 502))).rejects.toThrow("could not be loaded");
  });
});
