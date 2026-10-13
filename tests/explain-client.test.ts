import { afterEach, describe, expect, it, vi } from "vitest";
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
const busy = (retryAfterMs?: number, headers?: HeadersInit) => new Response(JSON.stringify({
  ok: false, error: { code: "upstream-rate-limited", retryable: true, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
}), { status: 503, headers });
afterEach(() => vi.useRealTimers());

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

  it("automatically retries model throttling once after the cooldown with the same moment and audience", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(busy(2_000, { "retry-after": "3" }))
      .mockResolvedValueOnce(new Response(JSON.stringify(answer())));
    const pending = requestExplanation(sampleFixture, sampleFixture.matchId, 9_400, "casual", signal, fetcher);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ timeMs: 9_400, audience: "casual" });
    expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after one automatic retry and returns the safe busy message", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy());
    const pending = expect(requestExplanation(sampleFixture, sampleFixture.matchId, 9_400, "casual", signal, fetcher))
      .rejects.toThrow("The model service is busy. Try again shortly.");
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("cancels the cooldown without sending another request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(busy(2_000));
    const pending = expect(requestExplanation(sampleFixture, sampleFixture.matchId, 9_400, "casual", controller.signal, fetcher))
      .rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["unauthorized", "budget-exhausted", "session-quota-exhausted", "rate-limited", "not-configured"])("does not automatically retry %s", async (code) => {
    const fetcher = reply({ ok: false, error: { code, retryable: true } }, 503);
    await expect(requestExplanation(sampleFixture, sampleFixture.matchId, 9_400, "casual", signal, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("leaves cooldowns longer than a minute to manual retry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(busy(61_000));
    await expect(requestExplanation(sampleFixture, sampleFixture.matchId, 9_400, "casual", signal, fetcher)).rejects.toThrow("model service is busy");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("validates the retried answer against the original cutoff", async () => {
    vi.useFakeTimers();
    const future = answer();
    future.explanation.facts = [{ text: "A match event occurred.", evidence: [{ kind: "snapshot", t: 9_500 }] }];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(busy(1_000))
      .mockResolvedValueOnce(new Response(JSON.stringify(future)));
    const pending = expect(requestExplanation(sampleFixture, sampleFixture.matchId, 9_400, "casual", signal, fetcher))
      .rejects.toThrow("could not be checked");
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
