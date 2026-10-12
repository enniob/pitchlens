import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelScheduler } from "@/server/modelScheduler";

afterEach(() => vi.useRealTimers());
describe("deployment pacing", () => {
  it("spaces concurrent reservations and honors a shared provider cooldown", async () => {
    vi.useFakeTimers();
    const scheduler = new ModelScheduler(1_000);
    const signal = new AbortController().signal;
    await scheduler.acquire(signal);
    const granted: number[] = [];
    const start = Date.now();
    const second = scheduler.acquire(signal).then(() => granted.push(Date.now() - start));
    const third = scheduler.acquire(signal).then(() => granted.push(Date.now() - start));
    scheduler.defer(2_000);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(granted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_001);
    await Promise.all([second, third]);
    expect(granted).toEqual([2_000, 3_000]);
  });
  it("cancels waiting reservations without consuming another slot", async () => {
    vi.useFakeTimers();
    const scheduler = new ModelScheduler(1_000);
    const controller = new AbortController();
    await scheduler.acquire(controller.signal);
    const waiting = scheduler.acquire(controller.signal);
    const failed = expect(waiting).rejects.toBeDefined();
    controller.abort();
    await failed;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.acquire(new AbortController().signal);
  });
});
