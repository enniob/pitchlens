/**
 * Abuse controls for the explanation endpoint, which spends paid model calls.
 *
 * In-memory and per server instance: a fixed-window rate limit per client and
 * overall, a cap on concurrent workflows, and a short-lived cache of finished
 * answers so that repeating a request costs nothing. A deployment with more
 * than one instance, or a public one, should also limit requests at its
 * gateway; see docs/explain-service.md.
 */

export const GUARD_LIMITS = {
  /** Requests per client per window. */
  perClient: 6,
  /** Requests across all clients per window. */
  global: 60,
  windowMs: 60_000,
  /** Workflows running at once. */
  concurrent: 4,
  /** Clients tracked before the oldest are forgotten. */
  maxClients: 5_000,
  /** Finished answers kept, and for how long. */
  cacheEntries: 200,
  cacheMs: 10 * 60_000,
} as const;

export type GuardLimits = { [K in keyof typeof GUARD_LIMITS]: number };

export type Admission = { ok: true; release: () => void } | { ok: false; code: "rate-limited" | "busy"; retryAfterMs: number };

export class RequestGuard {
  private readonly limits: GuardLimits;
  private readonly now: () => number;
  private windowStart = 0;
  private globalCount = 0;
  private readonly clients = new Map<string, number>();
  private running = 0;

  constructor(limits: Partial<GuardLimits> = {}, now: () => number = Date.now) {
    this.limits = { ...GUARD_LIMITS, ...limits };
    this.now = now;
  }

  /** Counts a request against the limits; on success the caller must `release()` when done. */
  admit(client: string): Admission {
    const t = this.now();
    if (t - this.windowStart >= this.limits.windowMs) {
      this.windowStart = t;
      this.globalCount = 0;
      this.clients.clear();
    }
    const retryAfterMs = Math.max(1_000, this.windowStart + this.limits.windowMs - t);
    const used = this.clients.get(client) ?? 0;
    if (used >= this.limits.perClient || this.globalCount >= this.limits.global) return { ok: false, code: "rate-limited", retryAfterMs };
    if (this.running >= this.limits.concurrent) return { ok: false, code: "busy", retryAfterMs: 2_000 };
    if (!this.clients.has(client) && this.clients.size >= this.limits.maxClients) this.clients.delete(this.clients.keys().next().value!);
    this.clients.set(client, used + 1);
    this.globalCount++;
    this.running++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (!released) this.running--;
        released = true;
      },
    };
  }
}

/** A small time-limited LRU cache. */
export class AnswerCache<T> {
  private readonly entries = new Map<string, { at: number; value: T }>();

  constructor(
    private readonly size: number = GUARD_LIMITS.cacheEntries,
    private readonly ttlMs: number = GUARD_LIMITS.cacheMs,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key);
    if (this.now() - hit.at > this.ttlMs) return undefined;
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), value });
    if (this.entries.size > this.size) this.entries.delete(this.entries.keys().next().value!);
  }
}

/**
 * Best-effort client key: the first X-Forwarded-For address when behind a
 * proxy, else a shared key. X-Forwarded-For can be forged by a client unless
 * the platform overwrites it, which is why the global limit also applies.
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded && /^[0-9a-fA-F.:]{2,45}$/.test(forwarded)) return forwarded;
  const real = headers.get("x-real-ip")?.trim();
  if (real && /^[0-9a-fA-F.:]{2,45}$/.test(real)) return real;
  return "unknown";
}

/** Constant-time string comparison for the access token. */
export function sameSecret(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
