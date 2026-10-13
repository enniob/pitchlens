import { describe, expect, it, vi } from "vitest";
import { ExplanationScheduler, type RequestPriority } from "@/explain/scheduler";

/** A request whose answer the test controls. */
function held(scheduler: ExplanationScheduler, name: string, priority: RequestPriority, sent: string[], controller = new AbortController()) {
  let finish!: (value: string) => void;
  let fail!: (e: unknown) => void;
  const result = scheduler.schedule({ priority, signal: controller.signal }, () => {
    sent.push(name);
    return new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  });
  result.catch(() => {});
  return { result, controller, finish: (v = name) => finish(v), fail: (e: unknown) => fail(e) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("explanation scheduler", () => {
  it("sends one request at a time; a manual request waits for a running automatic one", async () => {
    const scheduler = new ExplanationScheduler();
    const sent: string[] = [];
    const auto = held(scheduler, "auto", "automatic", sent);
    const manual = held(scheduler, "manual", "manual", sent);
    expect(sent).toEqual(["auto"]);
    expect(scheduler.pending).toBe(1);
    auto.finish();
    await expect(auto.result).resolves.toBe("auto");
    expect(sent).toEqual(["auto", "manual"]);
    manual.finish();
    await expect(manual.result).resolves.toBe("manual");
    expect(scheduler.busy).toBe(false);
  });

  it("sends waiting manual and recap requests before waiting automatic ones, in their own order", async () => {
    const scheduler = new ExplanationScheduler();
    const sent: string[] = [];
    const first = held(scheduler, "running-auto", "automatic", sent);
    const queuedAuto = held(scheduler, "queued-auto", "automatic", sent);
    const manual = held(scheduler, "manual", "manual", sent);
    const recap = held(scheduler, "recap", "manual", sent);
    // Priority never interrupts the running request.
    expect(first.controller.signal.aborted).toBe(false);
    first.finish(); await settle();
    manual.finish(); await settle();
    recap.finish(); await settle();
    queuedAuto.finish(); await settle();
    expect(sent).toEqual(["running-auto", "manual", "recap", "queued-auto"]);
  });

  it("never sends a request aborted while waiting, and rejects it with the abort reason", async () => {
    const scheduler = new ExplanationScheduler();
    const sent: string[] = [];
    const running = held(scheduler, "running", "manual", sent);
    const waiting = held(scheduler, "waiting", "automatic", sent);
    waiting.controller.abort();
    await expect(waiting.result).rejects.toMatchObject({ name: "AbortError" });
    expect(scheduler.pending).toBe(0);
    running.finish(); await settle();
    expect(sent).toEqual(["running"]);
    expect(scheduler.busy).toBe(false);
  });

  it("does not send a request whose signal is already aborted", async () => {
    const scheduler = new ExplanationScheduler();
    const send = vi.fn(async () => "x");
    const controller = new AbortController();
    controller.abort();
    await expect(scheduler.schedule({ priority: "manual", signal: controller.signal }, send)).rejects.toBeDefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("frees the slot as soon as the running request is aborted, even if its transport never settles", async () => {
    const scheduler = new ExplanationScheduler();
    const sent: string[] = [];
    const stuck = held(scheduler, "stuck", "automatic", sent);
    const next = held(scheduler, "next", "manual", sent);
    stuck.controller.abort();
    await expect(stuck.result).rejects.toMatchObject({ name: "AbortError" });
    expect(sent).toEqual(["stuck", "next"]);
    // A late answer from the abandoned request changes nothing.
    stuck.finish("late");
    next.finish(); await settle();
    await expect(next.result).resolves.toBe("next");
  });

  it("moves on after a failure, including one thrown before anything is sent", async () => {
    const scheduler = new ExplanationScheduler();
    const sent: string[] = [];
    const failing = held(scheduler, "failing", "automatic", sent);
    const throwing = scheduler.schedule({ priority: "manual", signal: new AbortController().signal }, () => { throw new Error("bad input"); });
    const after = held(scheduler, "after", "automatic", sent);
    failing.fail(new Error("busy"));
    await expect(failing.result).rejects.toThrow("busy");
    await expect(throwing).rejects.toThrow("bad input");
    await settle();
    expect(sent).toEqual(["failing", "after"]);
    after.finish();
    await expect(after.result).resolves.toBe("after");
  });

  it("skips a waiting request its owner no longer wants, sending the next one instead", async () => {
    const scheduler = new ExplanationScheduler();
    const sent: string[] = [];
    const running = held(scheduler, "running", "automatic", sent);
    let wanted = true;
    const stale = scheduler.schedule({ priority: "manual", signal: new AbortController().signal, wanted: () => wanted }, async () => { sent.push("stale"); return "stale"; });
    const next = held(scheduler, "next", "automatic", sent);
    wanted = false;
    running.finish(); await settle();
    expect(sent).toEqual(["running", "next"]);
    // Still waiting until its owner cancels it, or wants it again.
    expect(scheduler.pending).toBe(1);
    wanted = true;
    next.finish(); await settle();
    await expect(stale).resolves.toBe("stale");
    expect(sent).toEqual(["running", "next", "stale"]);
  });

  it("drops every waiting request on cancelQueued and leaves the running one to its owner", async () => {
    const scheduler = new ExplanationScheduler();
    const sent: string[] = [];
    const running = held(scheduler, "running", "automatic", sent);
    const a = held(scheduler, "a", "manual", sent);
    const b = held(scheduler, "b", "automatic", sent);
    scheduler.cancelQueued();
    await expect(a.result).rejects.toMatchObject({ name: "AbortError" });
    await expect(b.result).rejects.toMatchObject({ name: "AbortError" });
    running.finish(); await settle();
    await expect(running.result).resolves.toBe("running");
    expect(sent).toEqual(["running"]);
    // Still usable afterwards.
    const later = held(scheduler, "later", "manual", sent);
    expect(sent).toEqual(["running", "later"]);
    later.finish();
    await expect(later.result).resolves.toBe("later");
  });
});
