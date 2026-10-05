/**
 * Server-side resolution of a `MatchReference` to a fixture.
 *
 * The scripted demo resolves to the built-in fixture. A generated match is
 * rebuilt with the deterministic simulator from its recipe and accepted only
 * when the rebuilt matchId equals the claimed one. Nothing the browser sends
 * becomes match data, and the simulator runs here, never as a model tool.
 *
 * Rebuilding a 180 s match takes a fraction of a second; the last few results
 * are kept in a small in-memory cache.
 */
import type { MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import { generateMatch, type TacticsConfig } from "@/simulation/generate";
import type { MatchReference } from "@/explain/matchRef";

export type ResolveResult = { ok: true; fixture: MatchFixture } | { ok: false; error: string };

const CACHE_SIZE = 8;
const cache = new Map<string, MatchFixture>();

export function resolveMatch(reference: MatchReference): ResolveResult {
  if (reference.kind === "sample") {
    return reference.matchId === sampleFixture.matchId
      ? { ok: true, fixture: sampleFixture }
      : { ok: false, error: "No scripted match has that matchId." };
  }

  const key = JSON.stringify(reference);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return { ok: true, fixture: hit };
  }

  const tactics: TacticsConfig = {};
  for (const side of ["home", "away"] as const) {
    const t = reference.tactics[side];
    tactics[side] = { formation: t.formation, changes: t.changes.map((c) => ({ t: c.t, formation: c.formation })) };
  }
  let fixture: MatchFixture;
  try {
    fixture = generateMatch({ seed: reference.seed, durationMs: reference.durationMs, tactics });
  } catch (e) {
    return { ok: false, error: `The match settings are not valid: ${e instanceof Error ? e.message : "unknown problem"}.` };
  }
  if (fixture.matchId !== reference.matchId)
    return { ok: false, error: "The match settings do not reproduce that matchId (different settings or simulator version)." };

  cache.set(key, fixture);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return { ok: true, fixture };
}
