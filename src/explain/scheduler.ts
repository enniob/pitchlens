/**
 * "manual": asked for by the viewer (Explain this moment, the full-time recap).
 * "automatic": a live insight requested as play reaches a key moment.
 */
export type RequestPriority = "manual" | "automatic";

export interface ScheduleOptions {
  priority: RequestPriority;
  /** The caller's own signal. Aborting it removes a waiting request, or frees the slot of a running one. */
  signal: AbortSignal;
  /** Called when the request leaves the queue, just before it is sent. */
  onStart?: () => void;
  /**
   * Checked just before sending. False skips the request, leaving it waiting:
   * its owner is about to cancel it (playback moved back before its time, or
   * access locked) but has not yet, because another owner reacted first.
   */
  wanted?: () => boolean;
}

interface Task {
  priority: RequestPriority;
  wanted: () => boolean;
  start: () => void;
  /** Settles the caller's promise with `reason` and detaches from its signal. */
  drop: (reason: unknown) => void;
}

/**
 * Browser-side pacing for one viewer's explanation requests. The server runs
 * only one explanation per session, so overlapping requests from the insight
 * feed, the panel and the recap would be refused as busy; this sends them one
 * at a time instead. Waiting manual requests go before waiting automatic ones,
 * but a running request is never interrupted for priority. A configured gap
 * starts when a request finishes or is cancelled. Provider cooldowns can extend
 * that wait, including after the caller has exhausted its retry.
 *
 * A convenience, not a control: the server still enforces concurrency,
 * access, quotas and budgets on every request.
 */
export class ExplanationScheduler {
  private active: Task | null = null;
  private queue: Task[] = [];
  private nextAllowedMs = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly minGapMs = 0, private readonly now = Date.now) {}

  /** A provider cooldown applies to every caller sharing this queue. */
  defer(delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    this.nextAllowedMs = Math.max(this.nextAllowedMs, this.now() + delayMs);
    this.pump();
  }

  /** Sends once every earlier request has finished. A request aborted while waiting is never sent. */
  schedule<T>({ priority, signal, onStart, wanted = () => true }: ScheduleOptions, send: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const detach = () => signal.removeEventListener("abort", onAbort);
      const task: Task = {
        priority,
        wanted,
        start: () => {
          let sent: Promise<T>;
          try {
            onStart?.();
            sent = send();
          } catch (e) {
            sent = Promise.reject(e);
          }
          sent.then(resolve, reject).finally(() => { detach(); this.release(task); });
        },
        drop: (reason) => { detach(); reject(reason); },
      };
      // Aborting settles at once and frees the slot, even if the transport is slow to stop.
      const onAbort = () => {
        task.drop(signal.reason);
        if (this.active === task) this.release(task);
        else { this.queue = this.queue.filter((t) => t !== task); this.pump(); }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.enqueue(task);
      this.pump();
    });
  }

  /** Drops every waiting request, e.g. when the viewer goes away. A running request is left to its owner. */
  cancelQueued(reason: unknown = new DOMException("Explanation request cancelled.", "AbortError")): void {
    const waiting = this.queue;
    this.queue = [];
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const task of waiting) task.drop(reason);
  }

  /** Requests waiting to be sent. */
  get pending(): number { return this.queue.length; }
  /** Whether a request is in flight. */
  get busy(): boolean { return this.active !== null; }

  private enqueue(task: Task) {
    // Manual requests keep their order among themselves, ahead of every automatic one.
    const at = task.priority === "manual" ? this.queue.findIndex((t) => t.priority === "automatic") : -1;
    if (at === -1) this.queue.push(task);
    else this.queue.splice(at, 0, task);
  }

  private release(task: Task) {
    if (this.active !== task) return;
    this.active = null;
    this.nextAllowedMs = Math.max(this.nextAllowedMs, this.now() + this.minGapMs);
    this.pump();
  }

  private pump() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.active) return;
    const next = this.queue.find((t) => t.wanted());
    if (!next) return;
    const delay = this.nextAllowedMs - this.now();
    if (delay > 0) {
      this.timer = setTimeout(() => this.pump(), Math.min(delay, 60_000));
      return;
    }
    this.queue = this.queue.filter((t) => t !== next);
    this.active = next;
    next.start();
  }
}
