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
export type SchemaVersion = typeof SCHEMA_VERSION | "1.1.0";

export const PITCH_LENGTH = 105;
export const PITCH_WIDTH = 68;
export const GOAL_WIDTH = 7.32;
export const GOAL_HEIGHT = 2.44;

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

export type EventType = "kickoff" | "turnover" | "pass" | "shot" | "goal" | "shot-result" | "goal-kick";

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
  outcome: "won" | "complete" | "on-target" | "scored" | "taken" | "pending" | "intercepted" | "saved" | "missed";
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
}
