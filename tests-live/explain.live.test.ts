/**
 * LIVE evaluation of the analyst workflow against a real Microsoft Foundry
 * deployment. Opt-in and never part of `npm test`:
 *
 *   PITCHLENS_LIVE_EVAL=1 FOUNDRY_ENDPOINT=... FOUNDRY_API_KEY=... FOUNDRY_DEPLOYMENT=... npm run test:live
 *
 * Each case makes up to WORKFLOW_LIMITS.modelCalls paid model calls. Hard
 * assertions cover only safety properties that must hold whatever the model
 * writes (contract, citations, cutoff). Quality (how often a draft is verified,
 * revised or falls back) is printed as a LIVE summary, not asserted.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { Audience, ExplainTrace, VerificationSummary } from "@/explain/api";
import { extractMatchContext } from "@/explain/context";
import { EvidenceSession, TOOL_LOOKBACK_MS } from "@/explain/evidence";
import { validateExplanation } from "@/explain/response";
import type { MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import { generateMatch, type TacticsConfig } from "@/simulation/generate";
import { explainMoment } from "@/server/analyst";
import { FoundryClient, foundryConfigFromEnv } from "@/server/foundry";

const config = foundryConfigFromEnv(process.env);
const enabled = process.env.PITCHLENS_LIVE_EVAL === "1" && config.ok;

const TACTICS: TacticsConfig = { away: { formation: "4-3-3", changes: [{ t: 30_000, formation: "4-2-3-1" }] } };
const at = (f: MatchFixture, type: string, delta = 0) => f.events.find((e) => e.type === type)!.t + delta;
const offside = generateMatch({ seed: 2, durationMs: 60_000, tactics: TACTICS });
const goal = generateMatch({ seed: 9, durationMs: 60_000, tactics: TACTICS });

const CASES: { name: string; fixture: MatchFixture; timeMs: number }[] = [
  { name: "scripted shot in flight (result unknown)", fixture: sampleFixture, timeMs: 9_050 },
  { name: "scripted goal", fixture: sampleFixture, timeMs: 9_400 },
  { name: "generated offside call", fixture: offside, timeMs: at(offside, "offside") },
  { name: "generated goal", fixture: goal, timeMs: at(goal, "goal") },
  { name: "generated formation change", fixture: goal, timeMs: 30_000 },
];
const AUDIENCE_LIST: Audience[] = ["casual", "analyst"];

const results: { name: string; audience: Audience; outcome: VerificationSummary["outcome"] | "error"; ms: number; trace?: ExplainTrace; error?: string }[] = [];

describe.skipIf(!enabled)("LIVE: analyst workflow on Microsoft Foundry", () => {
  for (const c of CASES)
    for (const audience of AUDIENCE_LIST)
      it(`${c.name} (${audience})`, { timeout: 90_000 }, async () => {
        if (!config.ok) throw new Error("not configured");
        const started = Date.now();
        try {
          const out = await explainMoment({ fixture: c.fixture, timeMs: c.timeMs, audience, client: new FoundryClient(config.config) });
          results.push({ name: c.name, audience, outcome: out.verification.outcome, ms: Date.now() - started, trace: out.trace });

          // Safety properties, whatever the model wrote: every citation is to evidence the tools could have
          // returned (revealed events and snapshots from the lookback limit up to the selected time).
          const session = new EvidenceSession(c.fixture, c.timeMs);
          const reachable = extractMatchContext(c.fixture, c.timeMs, { lookbackMs: TOOL_LOOKBACK_MS, maxEvents: 50, maxSnapshots: 1, maxBytes: 64_000 });
          const snapshots = c.fixture.snapshots.filter((s) => s.t >= session.floorMs && s.t <= c.timeMs) as never;
          expect(validateExplanation(out.explanation, { ...session.base, events: reachable.events, snapshots }).ok).toBe(true);
          const later = c.fixture.events.filter((e) => e.t > c.timeMs).map((e) => e.id);
          const cited = JSON.stringify(out.explanation);
          for (const id of later) expect(cited, `cites future event ${id}`).not.toContain(`"${id}"`);
          expect(out.explanation.matchId).toBe(c.fixture.matchId);
          expect(out.explanation.timeMs).toBe(Math.floor(c.timeMs));
        } catch (e) {
          if (!results.some((r) => r.name === c.name && r.audience === audience))
            results.push({ name: c.name, audience, outcome: "error", ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) });
          throw e;
        }
      });

  afterAll(() => {
    const count = (o: string) => results.filter((r) => r.outcome === o).length;
    console.info("\nLIVE evaluation (real model calls; results vary between runs)");
    console.table(
      results.map((r) => ({
        case: r.name,
        audience: r.audience,
        outcome: r.outcome,
        seconds: (r.ms / 1000).toFixed(1),
        modelCalls: r.trace?.modelCalls ?? "-",
        toolCalls: r.trace?.toolCalls ?? "-",
        tokens: r.trace ? r.trace.tokens.prompt + r.trace.tokens.completion : "-",
        error: r.error ?? "",
      })),
    );
    console.info(
      `LIVE summary: ${results.length} runs · verified ${count("verified")} · revised ${count("revised")} · ` +
        `insufficient ${count("insufficient-evidence")} · fallback ${count("fallback")} · error ${count("error")}`,
    );
  });
});

describe.runIf(!enabled)("LIVE evaluation", () => {
  it("is skipped: set PITCHLENS_LIVE_EVAL=1 and the FOUNDRY_* variables to run it", () => {
    expect(enabled).toBe(false);
  });
});
