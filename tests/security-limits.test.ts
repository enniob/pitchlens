import { describe, expect, it } from "vitest";
import { readLimitedBody } from "@/server/requestBody";
import { UsageBudget, usageConfig } from "@/server/usageBudget";
import { requestOrigin } from "@/server/requestOrigin";

describe("HTTP origin resolution", () => {
  it("uses the browser Host when Next normalizes its internal URL", () => {
    expect(requestOrigin(new Request("http://localhost:3102/api/session", { headers: { host: "127.0.0.1:3102" } }))).toBe("http://127.0.0.1:3102");
  });
  it("ignores forwarded-host and rejects malformed Host", () => {
    expect(requestOrigin(new Request("https://pitchlens.example/api/session", { headers: { "x-forwarded-host": "evil.example" } }))).toBe("https://pitchlens.example");
    expect(requestOrigin(new Request("https://pitchlens.example/api/session", { headers: { host: "evil.example/path" } }))).toBeNull();
  });
});

describe("bounded request ingress", () => {
  const streamed = (stream: ReadableStream<Uint8Array>, signal?: AbortSignal) => new Request("https://pitchlens.example", {
    method: "POST", body: stream, duplex: "half", signal,
  } as RequestInit);

  it("enforces streamed byte limits without waiting for hostile cancellation", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(11)); },
      cancel() { return new Promise(() => {}); },
    });
    await expect(readLimitedBody(streamed(stream), 10, 100)).rejects.toMatchObject({ code: "payload-too-large" });
  });

  it("times out even when the stream's cancel never settles", async () => {
    const stream = new ReadableStream<Uint8Array>({ cancel() { return new Promise(() => {}); } });
    await expect(readLimitedBody(streamed(stream), 10, 20)).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects invalid UTF-8 and handles multibyte characters split across chunks", async () => {
    const invalid = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([255])); c.close(); } });
    await expect(readLimitedBody(streamed(invalid), 10)).rejects.toMatchObject({ code: "invalid-request" });
    const valid = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([195])); c.enqueue(new Uint8Array([169])); c.close(); } });
    await expect(readLimitedBody(streamed(valid), 2)).resolves.toBe("é");
  });
});

describe("usage allowance ledger", () => {
  it("reserves concurrent workflows before spending, and settles only once", () => {
    const budget = new UsageBudget(() => 0);
    const first = budget.reserve("a", 1000, 80, 100, 10);
    expect(first.ok).toBe(true);
    expect(budget.reserve("b", 1000, 80, 100, 10)).toMatchObject({ ok: false, code: "budget-exhausted" });
    if (!first.ok) throw new Error("reservation rejected");
    first.settle(10);
    first.settle(1000);
    expect(budget.reserve("b", 1000, 80, 100, 10).ok).toBe(true);
  });

  it("charges failed requests conservatively", () => {
    const budget = new UsageBudget(() => 0);
    const first = budget.reserve("a", 1000, 80, 100, 10);
    if (!first.ok) throw new Error("reservation rejected");
    first.settle();
    expect(budget.reserve("b", 1000, 80, 100, 10)).toMatchObject({ code: "budget-exhausted" });
  });

  it("limits active and total session workflows independently of address headers", () => {
    let now = 0;
    const budget = new UsageBudget(() => now);
    const first = budget.reserve("judge:one", 1000, 10, 1000, 1);
    if (!first.ok) throw new Error("reservation rejected");
    expect(budget.reserve("judge:one", 1000, 10, 1000, 1)).toMatchObject({ code: "busy" });
    first.settle(0);
    expect(budget.reserve("judge:one", 1000, 10, 1000, 1)).toMatchObject({ code: "session-quota-exhausted" });
    now = 1001;
    expect(budget.reserve("judge:one", 2000, 10, 1000, 1).ok).toBe(true);
  });

  it("carries pending reservations across UTC midnight", () => {
    let now = Date.parse("2026-10-12T23:59:59Z");
    const budget = new UsageBudget(() => now);
    const first = budget.reserve("a", now + 10000, 80, 100, 10);
    if (!first.ok) throw new Error("reservation rejected");
    now += 2000;
    expect(budget.reserve("b", now + 10000, 80, 100, 10)).toMatchObject({ code: "budget-exhausted" });
    first.settle(10);
    expect(budget.reserve("b", now + 10000, 80, 100, 10).ok).toBe(true);
  });

  it("rejects malformed configuration", () => {
    expect(usageConfig({})).toEqual({ dailyTokens: 1_000_000, sessionExplanations: 30 });
    for (const value of ["", "0", "-1", "NaN", "1.5", "Infinity"]) {
      expect(usageConfig({ PITCHLENS_DAILY_TOKEN_BUDGET: value })).toBeNull();
      expect(usageConfig({ PITCHLENS_SESSION_EXPLANATIONS: value })).toBeNull();
    }
  });
});
