/** Per-process deployment pacing. No credentials or prompts are retained. */
export class ModelScheduler {
  private next = 0;
  private cooldown = 0;
  constructor(private readonly intervalMs = 0, private readonly now = Date.now) {}

  defer(ms: number): void {
    this.cooldown = Math.max(this.cooldown, this.now() + ms);
  }

  async acquire(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const delay = Math.max(this.next, this.cooldown) - this.now();
      if (delay <= 0) {
        this.next = this.now() + this.intervalMs;
        return;
      }
      await abortableDelay(delay, signal);
    }
  }
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
