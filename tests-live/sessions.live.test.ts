/** Opt-in HTTP test of two independent signed judge sessions against a running build. */
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sampleFixture } from "@/match/fixture";
import { assess } from "../tests/support/assess";
import { scenarioById } from "../tests/support/scenarios";
import { redact } from "../tests/support/liveReport";
import { evaluationRevision } from "../tests/support/revision";

it.skipIf(process.env.PITCHLENS_LIVE_SESSIONS !== "1")("LIVE: concurrent judge sessions, cache isolation and recovery", { timeout: 400_000 }, async () => {
  const base = process.env.PITCHLENS_LIVE_BASE_URL ?? "http://127.0.0.1:3000";
  const secrets = [process.env.FOUNDRY_API_KEY, process.env.FOUNDRY_ENDPOINT, process.env.PITCHLENS_JUDGE_ACCESS_CODE, process.env.PITCHLENS_SESSION_SECRET];
  const records: object[] = [];
  const sessions: string[] = [];
  const scenario = scenarioById("demo-goal-recorded");
  // At most four uncached workflows (32 model calls, 80k tokens/60s each).
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ code: process.env.PITCHLENS_JUDGE_ACCESS_CODE }), signal: AbortSignal.timeout(10_000) });
      expect(response.status, "judge session login").toBe(200);
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      sessions.push(cookie); secrets.push(cookie);
    }
    expect(sessions[0] === sessions[1], "independent session identities").toBe(false);
    const run = async (index: number, phase: string) => {
      const audience = index === 0 ? "casual" : "analyst";
      const started = Date.now();
      const response = await fetch(`${base}/api/explain`, { method: "POST", headers: { "content-type": "application/json", origin: base, cookie: sessions[index]! },
        body: JSON.stringify({ match: { kind: "sample", matchId: sampleFixture.matchId }, timeMs: scenario.timeMs, audience }), signal: AbortSignal.timeout(70_000) });
      const body = await response.json();
      const verdict = body.ok ? assess({ scenario, audience, explanation: body.explanation, verification: body.verification }) : undefined;
      records.push({ phase, session: index + 1, audience, httpStatus: response.status, latencyMs: Date.now() - started,
        retryAfter: response.headers.get("retry-after"), body, verdict });
      return { body, verdict };
    };
    const initial = await Promise.all([run(0, "concurrent"), run(1, "concurrent")]);
    // One paced retry per failed session. Successful sessions exercise cache reuse.
    await new Promise(resolve => setTimeout(resolve, 65_000));
    const final = [];
    for (let i = 0; i < 2; i++) {
      if (i === 1 && !initial[0]!.body.ok) await new Promise(resolve => setTimeout(resolve, 65_000));
      final.push(await run(i, initial[i]!.body.ok ? "cache-repeat" : "recovery"));
    }
    for (const result of final) {
      expect(result.body.ok, "HTTP explanation success").toBe(true);
      expect(result.verdict?.blockers).toEqual([]);
      expect(result.verdict?.unsupported).toEqual([]);
      expect(result.verdict?.quality).toBe("usable");
    }
  } finally {
    for (const cookie of sessions) await fetch(`${base}/api/session`, { method: "DELETE", headers: { origin: base, cookie }, signal: AbortSignal.timeout(10_000) });
    const report = redact(JSON.stringify({ revision: evaluationRevision(), date: new Date().toISOString(), target: new URL(base).hostname === "127.0.0.1" ? "local production build" : base,
      bounds: { independentSessions: 2, maxUncachedWorkflows: 4, maxModelCalls: 32, workflowTokens: 80_000, workflowMs: 60_000 }, records }, null, 2), secrets, 300_000);
    writeFileSync(process.env.PITCHLENS_LIVE_SESSION_REPORT ?? ".local/final-sessions.json", report);
  }
});
