/**
 * "Explain this moment": how the browser names a match to the explanation
 * service without sending the match itself.
 *
 * The browser never uploads a fixture. It sends a `MatchReference`: either the
 * scripted demo, or the recipe (seed, duration, formations and changes) that
 * produced a generated match. The service rebuilds the fixture from that
 * recipe with the deterministic simulator and only accepts it when the
 * rebuilt `matchId` equals the one the browser claims, so a client cannot
 * supply its own events, positions or text.
 *
 * Pure and safe to import in the browser: `matchReferenceOf` builds a
 * reference from a loaded fixture, `parseMatchReference` checks an untrusted
 * one. Resolving a reference to a fixture is server-side (src/server/resolveMatch.ts).
 */
import { FORMATION_IDS, type FormationId, type MatchFixture, type TeamSide } from "@/match/contract";

/** Most formation changes a reference may carry per team. */
export const MAX_REFERENCE_CHANGES = 3;

export interface ReferenceTeamTactics {
  formation: FormationId;
  /** Formation changes in time order; empty for none. */
  changes: { t: number; formation: FormationId }[];
}

export type MatchReference =
  | { kind: "sample"; matchId: string }
  | {
      kind: "generated";
      /** The matchId the browser shows; the rebuilt fixture must have the same one. */
      matchId: string;
      seed: number;
      durationMs: number;
      tactics: Record<TeamSide, ReferenceTeamTactics>;
    };

export type ReferenceParse = { ok: true; reference: MatchReference } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFormation = (v: unknown): v is FormationId => (FORMATION_IDS as readonly unknown[]).includes(v);
const MATCH_ID = /^[A-Za-z0-9._-]{1,80}$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], where: string): string | null {
  for (const key of Object.keys(value)) if (!keys.includes(key)) return `${where}: unexpected field ${key}`;
  for (const key of keys) if (!(key in value)) return `${where}: missing field ${key}`;
  return null;
}

/**
 * The reference for a fixture the viewer has loaded, or null when the service
 * cannot rebuild it (an older fixture without generator metadata).
 * `sampleMatchId` is the scripted demo's ID.
 */
export function matchReferenceOf(fixture: MatchFixture, sampleMatchId: string): MatchReference | null {
  if (fixture.matchId === sampleMatchId && !fixture.generator) return { kind: "sample", matchId: fixture.matchId };
  if (!fixture.generator || !fixture.tactics) return null;
  const tacticsOf = (side: TeamSide): ReferenceTeamTactics | null => {
    const team = fixture.teams.find((t) => t.side === side)!;
    const initial = fixture.tactics!.initial.find((f) => f.teamId === team.id);
    if (!initial) return null;
    const changes = fixture.tactics!.scheduled.filter((c) => c.teamId === team.id).map((c) => ({ t: c.t, formation: c.formation }));
    return { formation: initial.formation, changes };
  };
  const home = tacticsOf("home");
  const away = tacticsOf("away");
  if (!home || !away) return null;
  return {
    kind: "generated",
    matchId: fixture.matchId,
    seed: fixture.generator.seed,
    durationMs: fixture.durationMs,
    tactics: { home, away },
  };
}

/** Checks an untrusted reference's shape and bounds. It does not rebuild the match. */
export function parseMatchReference(value: unknown): ReferenceParse {
  const fail = (error: string): ReferenceParse => ({ ok: false, error });
  if (!isObject(value)) return fail("match must be an object");
  if (typeof value.matchId !== "string" || !MATCH_ID.test(value.matchId)) return fail("match.matchId must be 1–80 letters, digits, '.', '_' or '-'");

  if (value.kind === "sample") {
    const keys = exactKeys(value, ["kind", "matchId"], "match");
    return keys ? fail(keys) : { ok: true, reference: { kind: "sample", matchId: value.matchId } };
  }
  if (value.kind !== "generated") return fail('match.kind must be "sample" or "generated"');

  const keys = exactKeys(value, ["kind", "matchId", "seed", "durationMs", "tactics"], "match");
  if (keys) return fail(keys);
  const { seed, durationMs, tactics } = value;
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    return fail("match.seed must be an integer from 0 to 4294967295");
  if (typeof durationMs !== "number" || !Number.isInteger(durationMs) || durationMs < 10_000 || durationMs > 180_000 || durationMs % 100 !== 0)
    return fail("match.durationMs must be 10000–180000 in steps of 100");
  if (!isObject(tactics)) return fail("match.tactics must be an object");
  const tacticsKeys = exactKeys(tactics, ["home", "away"], "match.tactics");
  if (tacticsKeys) return fail(tacticsKeys);

  const parsed = {} as Record<TeamSide, ReferenceTeamTactics>;
  for (const side of ["home", "away"] as const) {
    const where = `match.tactics.${side}`;
    const team = tactics[side];
    if (!isObject(team)) return fail(`${where} must be an object`);
    const teamKeys = exactKeys(team, ["formation", "changes"], where);
    if (teamKeys) return fail(teamKeys);
    if (!isFormation(team.formation)) return fail(`${where}.formation must be one of ${FORMATION_IDS.join(", ")}`);
    if (!Array.isArray(team.changes) || team.changes.length > MAX_REFERENCE_CHANGES)
      return fail(`${where}.changes must be a list of at most ${MAX_REFERENCE_CHANGES}`);
    const changes: ReferenceTeamTactics["changes"] = [];
    for (const [i, c] of team.changes.entries()) {
      const at = `${where}.changes[${i}]`;
      if (!isObject(c)) return fail(`${at} must be an object`);
      const changeKeys = exactKeys(c, ["t", "formation"], at);
      if (changeKeys) return fail(changeKeys);
      if (typeof c.t !== "number" || !Number.isInteger(c.t) || c.t <= 0 || c.t >= durationMs) return fail(`${at}.t must be an integer inside the match`);
      if (!isFormation(c.formation)) return fail(`${at}.formation must be one of ${FORMATION_IDS.join(", ")}`);
      changes.push({ t: c.t, formation: c.formation });
    }
    parsed[side] = { formation: team.formation, changes };
  }
  return { ok: true, reference: { kind: "generated", matchId: value.matchId, seed, durationMs, tactics: parsed } };
}
