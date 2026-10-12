/** Single-process allowance ledger. A shared durable implementation is required for hosting. */
export class UsageBudget {
  private day = "";
  private used = 0;
  private readonly pending = new Map<string, number>();
  private readonly sessions = new Map<string, { count: number; expiresAt: number; running: number }>();
  constructor(private readonly now = Date.now) {}

  reserve(identity: string, expiresAt: number, tokens: number, dailyLimit: number, sessionLimit: number):
    | { ok: true; settle: (charged?: number) => void }
    | { ok: false; code: "budget-exhausted" | "session-quota-exhausted" | "busy"; retryAfterMs: number } {
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.day !== day) { this.day = day; this.used = 0; }
    // Pending reservations survive midnight, so an in-flight request cannot
    // become unaccounted for when the daily ledger rolls over.
    const reserved = [...this.pending.values()].reduce((sum, n) => sum + n, 0);
    if (this.used + reserved + tokens > dailyLimit)
      return { ok: false, code: "budget-exhausted", retryAfterMs: Date.parse(`${day}T00:00:00Z`) + 86_400_000 - now };
    for (const [key, value] of this.sessions) if (value.expiresAt <= now && value.running === 0) this.sessions.delete(key);
    const session = this.sessions.get(identity) ?? { count: 0, expiresAt, running: 0 };
    if (session.running >= 1) return { ok: false, code: "busy", retryAfterMs: 2_000 };
    if (session.count >= sessionLimit) return { ok: false, code: "session-quota-exhausted", retryAfterMs: Math.max(1_000, session.expiresAt - now) };
    if (!this.sessions.has(identity) && this.sessions.size >= 2_000) return { ok: false, code: "busy", retryAfterMs: 60_000 };
    session.count++;
    session.running++;
    this.sessions.set(identity, session);
    const id = crypto.randomUUID();
    this.pending.set(id, tokens);
    let settled = false;
    return { ok: true, settle: (charged = tokens) => {
      if (settled) return;
      settled = true;
      session.running--;
      this.pending.delete(id);
      const currentDay = new Date(this.now()).toISOString().slice(0, 10);
      if (this.day !== currentDay) { this.day = currentDay; this.used = 0; }
      // Failed calls retain the reservation. Never accept negative/NaN charges.
      this.used += Number.isFinite(charged) && charged >= 0 ? Math.ceil(charged) : tokens;
    } };
  }
}

export function usageConfig(env: Record<string, string | undefined>): { dailyTokens: number; sessionExplanations: number } | null {
  const positive = (name: string, fallback: number) => env[name] === undefined ? fallback : Number(env[name]);
  const dailyTokens = positive("PITCHLENS_DAILY_TOKEN_BUDGET", 1_000_000);
  const sessionExplanations = positive("PITCHLENS_SESSION_EXPLANATIONS", 30);
  return Number.isSafeInteger(dailyTokens) && dailyTokens > 0 && Number.isSafeInteger(sessionExplanations) && sessionExplanations > 0
    ? { dailyTokens, sessionExplanations } : null;
}
