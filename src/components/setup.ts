/**
 * Match set-up form model: what the "Set up match" drawer edits, how it is
 * validated (one message per field, in plain words) and how it becomes the
 * simulator's tactics configuration. Nothing here touches the loaded match.
 */
import type { FormationId, MatchFixture, TeamSide } from "@/match/contract";
import { DEFAULT_FORMATION } from "@/match/formations";
import type { TacticsConfig } from "@/simulation/generate";

export interface TeamControls {
  formation: FormationId;
  /** Seconds as typed; blank means no change. */
  changeAt: string;
  changeTo: FormationId;
}

export interface SetupDraft {
  seed: string;
  durationSeconds: number;
  /** Whether each team's "change formation during the match" box is ticked. */
  changeOn: Record<TeamSide, boolean>;
  teams: Record<TeamSide, TeamControls>;
}

export type SetupErrors = Partial<Record<TeamSide | "seed", string>>;

export const DURATIONS_SECONDS = [30, 60, 120] as const;
export const SIDE_LABEL: Record<TeamSide, string> = { home: "Home", away: "Away" };

export const DEFAULT_DRAFT: SetupDraft = {
  seed: "42",
  durationSeconds: 60,
  changeOn: { home: false, away: false },
  teams: {
    home: { formation: DEFAULT_FORMATION, changeAt: "", changeTo: "4-2-3-1" },
    away: { formation: DEFAULT_FORMATION, changeAt: "", changeTo: "4-2-3-1" },
  },
};

/** Problem with a change time, or null. Seconds with at most one decimal, strictly inside the match. */
export function changeTimeError(raw: string, durationSeconds: number): string | null {
  const value = raw.trim();
  if (value === "") return "Enter when the change should happen, in seconds.";
  if (!/^\d+(\.\d)?$/.test(value)) return "Use seconds, like 30 or 42.5.";
  const ms = Math.round(Number(value) * 1000);
  if (ms <= 0 || ms >= durationSeconds * 1000)
    return `Pick a time between 0 and ${durationSeconds} seconds; the match is ${durationSeconds} seconds long.`;
  return null;
}

export function seedError(raw: string): string | null {
  const value = raw.trim();
  return /^\d+$/.test(value) && Number(value) <= 0xffffffff ? null : "Use a whole number from 0 to 4,294,967,295.";
}

export function setupErrors(draft: SetupDraft): SetupErrors {
  const errors: SetupErrors = {};
  for (const side of ["home", "away"] as const) {
    if (!draft.changeOn[side]) continue;
    const e = changeTimeError(draft.teams[side].changeAt, draft.durationSeconds);
    if (e) errors[side] = e;
  }
  const s = seedError(draft.seed);
  if (s) errors.seed = s;
  return errors;
}

/**
 * Turns per-team controls into a tactics configuration. A blank change time
 * means no change. Throws with a readable message on the first invalid time.
 */
export function tacticsFromControls(controls: Record<TeamSide, TeamControls>, durationSeconds: number): TacticsConfig {
  const tactics: TacticsConfig = {};
  for (const side of ["home", "away"] as const) {
    const c = controls[side];
    tactics[side] = { formation: c.formation };
    if (c.changeAt.trim() === "") continue;
    const error = changeTimeError(c.changeAt, durationSeconds);
    if (error) throw new Error(`${SIDE_LABEL[side]} change time: ${error}`);
    tactics[side].changes = [{ t: Math.round(Number(c.changeAt.trim()) * 1000), formation: c.changeTo }];
  }
  return tactics;
}

/** The draft's controls with unticked changes cleared. */
export function controlsOf(draft: SetupDraft): Record<TeamSide, TeamControls> {
  const off = (side: TeamSide) => ({ ...draft.teams[side], changeAt: draft.changeOn[side] ? draft.teams[side].changeAt : "" });
  return { home: off("home"), away: off("away") };
}

/** The set-up that produced a generated fixture, or null for the scripted demo and older fixtures. */
export function draftFromFixture(fixture: MatchFixture): SetupDraft | null {
  if (!fixture.generator || !fixture.tactics) return null;
  const draft: SetupDraft = structuredClone(DEFAULT_DRAFT);
  draft.seed = String(fixture.generator.seed);
  draft.durationSeconds = fixture.durationMs / 1000;
  for (const side of ["home", "away"] as const) {
    const team = fixture.teams.find((t) => t.side === side)!;
    const initial = fixture.tactics.initial.find((x) => x.teamId === team.id);
    if (initial) draft.teams[side].formation = initial.formation;
    const change = fixture.tactics.scheduled.find((c) => c.teamId === team.id);
    if (change) {
      draft.changeOn[side] = true;
      draft.teams[side].changeAt = String(change.t / 1000);
      draft.teams[side].changeTo = change.formation;
    }
  }
  return draft;
}

/** True when two drafts would generate the same match. */
export function sameSetup(a: SetupDraft, b: SetupDraft): boolean {
  const norm = (d: SetupDraft) =>
    JSON.stringify({
      seed: d.seed.trim(),
      duration: d.durationSeconds,
      teams: (["home", "away"] as const).map((side) => {
        const t = d.teams[side];
        const on = d.changeOn[side];
        return [t.formation, on, on ? Number(t.changeAt.trim()) : null, on ? t.changeTo : null];
      }),
    });
  return norm(a) === norm(b);
}
