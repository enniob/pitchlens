/**
 * PitchLens match data contract.
 *
 * This is the boundary between whatever produces match data (today a scripted
 * fixture, later a simulator) and the playback engine / renderer. Producers
 * must emit data matching these types; consumers must not depend on anything
 * outside them.
 *
 * Coordinate convention (pitch space, metres):
 *   - x runs along the pitch length, 0 (left goal line) → 105 (right goal line)
 *   - y runs across the width, 0 (top touchline) → 68 (bottom touchline)
 *   - z is height above the grass
 * See src/scene/coords.ts for the conversion into Three.js scene space.
 *
 * All times are integer milliseconds of simulation time, measured from the
 * start of the fixture (t = 0).
 */

export const SCHEMA_VERSION = "1.0.0" as const;
export type SchemaVersion = typeof SCHEMA_VERSION | "1.1.0" | "1.2.0" | "1.3.0";

export const PITCH_LENGTH = 105;
export const PITCH_WIDTH = 68;
export const GOAL_WIDTH = 7.32;
export const GOAL_HEIGHT = 2.44;
/** Radius of the posts and crossbar. Post centres sit on the goal line at ±GOAL_WIDTH / 2; the bar's centre is at GOAL_HEIGHT. */
export const POST_RADIUS = 0.07;
/** Penalty area depth from the goal line and half-width across the pitch. */
export const PENALTY_AREA_DEPTH = 16.5;
export const PENALTY_AREA_HALF_WIDTH = 20.16;
export const PENALTY_SPOT_DISTANCE = 11;

export type TeamSide = "home" | "away";

export interface Team {
  /** Stable team ID, referenced by players and events. */
  id: string;
  side: TeamSide;
  name: string;
  shortName: string;
  /** Kit colours as CSS hex strings, e.g. "#1d4ed8". */
  kit: { primary: string; secondary: string; number: string };
  /** Direction this team attacks during the fixture. */
  attacksTowards: "increasing-x" | "decreasing-x";
}

export interface Player {
  /** Stable player ID, referenced by snapshots and events. */
  id: string;
  teamId: string;
  name: string;
  number: number;
  role: "GK" | "DF" | "MF" | "FW";
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 extends Vec2 {
  z: number;
}

export interface Score {
  home: number;
  away: number;
}

export interface Possession {
  teamId: string;
  /** Player in control of the ball, or null when the team has possession but nobody is touching it. */
  playerId: string | null;
}

export interface PlayerState {
  playerId: string;
  x: number;
  y: number;
  /** Facing direction in radians in pitch space: 0 = +x, π/2 = +y. */
  facing: number;
}

export interface Snapshot {
  t: number;
  players: PlayerState[];
  ball: Vec3;
  /** Null while the ball is in flight or dead. */
  possession: Possession | null;
  /**
   * True when this snapshot starts a new continuous segment (e.g. the kickoff
   * reset after a goal). Consumers must not interpolate from the previous
   * snapshot into this one; the previous state holds until `t`, then jumps.
   */
  discontinuity?: boolean;
}

/**
 * 1.0.0: kickoff, turnover, pass, shot, goal.
 * 1.1.0 adds shot-result and goal-kick.
 * 1.2.0 adds the restarts throw-in, corner, free-kick and penalty; foul and
 * offside, which stop play; and deflection, a touch that changes the ball's
 * path without anyone controlling it (a block, a parry, the woodwork).
 * 1.3.0 adds formation-change, a scheduled tactical change that does not stop
 * play, and the optional `generator` and `tactics` fixture metadata.
 */
export type EventType =
  | "kickoff"
  | "turnover"
  | "pass"
  | "shot"
  | "goal"
  | "shot-result"
  | "goal-kick"
  | "throw-in"
  | "corner"
  | "free-kick"
  | "penalty"
  | "foul"
  | "offside"
  | "deflection"
  | "formation-change";

export interface MatchEvent {
  /** Unique within the fixture. */
  id: string;
  /**
   * When the event resolves and becomes visible. For a pass this is the moment
   * of reception; for a shot, the strike; for a goal, the ball crossing the line.
   */
  t: number;
  type: EventType;
  teamId: string;
  playerId?: string;
  /** Pass recipient (required for passes). */
  recipientId?: string;
  outcome:
    | "won"
    | "complete"
    | "on-target"
    | "scored"
    | "taken"
    | "pending"
    | "intercepted"
    | "saved"
    | "missed"
    // 1.2.0
    | "blocked"
    | "deflected"
    | "committed"
    | "flagged"
    // 1.3.0
    | "applied";
  /** Time the action began (e.g. ball struck for a pass), if earlier than `t`. */
  startT?: number;
  start?: Vec3;
  end?: Vec3;
  /** Short human-readable description for the events panel. */
  description: string;
}

export interface StartingState {
  score: Score;
  possession: Possession | null;
}

export interface MatchFixture {
  schemaVersion: SchemaVersion;
  matchId: string;
  title: string;
  /** Always true for PitchLens fixtures in this milestone; surfaced in the UI. */
  synthetic: true;
  durationMs: number;
  teams: [Team, Team];
  roster: Player[];
  startingState: StartingState;
  /** Strictly increasing by `t`; first at t = 0, last at t = durationMs. */
  snapshots: Snapshot[];
  /** Non-decreasing by `t`. */
  events: MatchEvent[];
  /** Which simulator and configuration produced the fixture (1.3.0, generated fixtures only). */
  generator?: GeneratorInfo;
  /** Formations, slot assignments and formation changes (1.3.0). Absent from older and scripted fixtures. */
  tactics?: MatchTactics;
}

// Formations (1.3.0) ------------------------------------------------------------

export const FORMATION_IDS = ["4-4-2", "4-3-3", "4-2-3-1"] as const;
export type FormationId = (typeof FORMATION_IDS)[number];

/**
 * Tactical position of a formation slot. Independent of the player's roster
 * `role` and shirt number: any outfield player can fill any outfield slot.
 */
export type TacticalPosition = "GK" | "RB" | "CB" | "LB" | "DM" | "CM" | "RM" | "LM" | "AM" | "RW" | "LW" | "ST";

/** Player ID → slot ID within the team's current formation; every player of the team exactly once. */
export type SlotAssignments = Record<string, string>;

export interface TeamFormation {
  teamId: string;
  formation: FormationId;
  assignments: SlotAssignments;
}

/** A formation change requested before the match, at simulation time `t`. */
export interface ScheduledFormationChange extends TeamFormation {
  t: number;
}

/** A formation change as it was applied during the simulation. */
export interface AppliedFormationChange {
  /** The formation-change event that announced it. */
  eventId: string;
  teamId: string;
  t: number;
  from: FormationId;
  to: FormationId;
  previousAssignments: SlotAssignments;
  assignments: SlotAssignments;
}

export interface MatchTactics {
  /** Formations at t = 0, one per team. */
  initial: TeamFormation[];
  /** Changes as configured (with resolved assignments), in processing order. */
  scheduled: ScheduledFormationChange[];
  /** Changes as applied, in order; the formation at time t is `initial` plus every applied change with t' ≤ t. */
  applied: AppliedFormationChange[];
}

export interface GeneratorInfo {
  simulatorVersion: string;
  seed: number;
  /** Short hash of the resolved configuration (formations, assignments, changes). */
  configKey: string;
}
