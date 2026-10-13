/**
 * Deterministic football measurements derived from recorded events and
 * position snapshots, for the analyst tools.
 *
 * Every function here is pure and only sees what its caller passes in. The
 * callers pass events revealed by the selected time and snapshots at or
 * before it, so a measurement can never use a pass that is still in flight,
 * a shot's result before it is revealed, or positions from later on.
 *
 * Rules every measurement follows:
 *   - Units are in the field name (`M` metres, `Ms` milliseconds, `Mps`
 *     metres per second) and values are rounded to 0.1.
 *   - A distance says what it is: a straight-line displacement between two
 *     points, or a path summed over samples. Neither is reported as the other.
 *   - Distances use the pitch surface (x, y). Ball height is ignored.
 *   - Positions are never interpolated, and never compared across a reset
 *     (a snapshot marked `discontinuity`, such as the kickoff after a goal).
 *   - Every value lists the event IDs or snapshot times it comes from. When
 *     no supplied event or snapshot supports a value, it is left out, so a
 *     model can always cite the evidence behind a number.
 *   - Missing data gives `null` with the reason, never a guessed value.
 *
 * They describe what was recorded, not pressure, difficulty, intention or
 * cause. A count of nearby opponents is a proximity count only.
 */
import type { FormationId, MatchEvent, Possession, Team } from "@/match/contract";

export const DERIVED_LIMITS = {
  /** Most recent passes measured. */
  passes: 8,
  /** Most recent possession spells kept. */
  possessionSpells: 4,
  /** Players whose movement is measured, besides the ball. */
  movementPlayers: 4,
  /** Radii of the nearby-opponent counts, in metres. */
  proximityRadiiM: [5, 10] as readonly number[],
} as const;

// Adding 0 turns -0 into 0, so values survive a JSON round trip unchanged.
const round1 = (v: number) => Math.round(v * 10) / 10 + 0;
const planar = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);

// Passes ---------------------------------------------------------------------

export interface PassMeasurement {
  eventId: string;
  teamId: string;
  /**
   * Straight-line distance from where the pass was struck (`start`) to where
   * it ended (`end`: the reception, interception or the point it went out).
   * A displacement of the ball, not the path it travelled.
   */
  straightLineDistanceM: number | null;
  /** Strike to resolution (`t − startT`). */
  travelMs: number | null;
  /** `straightLineDistanceM` over the travel time: an average along the straight line, not the ball's speed at any instant. */
  averageStraightLineSpeedMps: number | null;
  /** Gain towards the goal the team attacks along the pitch length; negative for a backward pass. */
  forwardProgressM: number | null;
  /** Recorded fields this pass lacks, which leave the values that need them `null`. */
  unavailable: ("start" | "end" | "startT")[];
}

/**
 * Geometry and timing of each pass in `events` (the latest `limit`). Passes
 * appear in the event list only once they resolve, so a pass still in flight
 * is never measured and its recipient and result are never implied.
 */
export function measurePasses(
  events: readonly MatchEvent[], teams: readonly Pick<Team, "id" | "attacksTowards">[], limit: number = DERIVED_LIMITS.passes,
): { passes: PassMeasurement[]; omittedOlder: number } {
  const direction = new Map(teams.map((t) => [t.id, t.attacksTowards === "increasing-x" ? 1 : -1]));
  const all = events.filter((e) => e.type === "pass");
  const kept = all.slice(Math.max(0, all.length - limit));
  const passes = kept.map((e): PassMeasurement => {
    const unavailable: PassMeasurement["unavailable"] = [];
    if (!e.start) unavailable.push("start");
    if (!e.end) unavailable.push("end");
    if (e.startT === undefined) unavailable.push("startT");
    const distance = e.start && e.end ? planar(e.start, e.end) : null;
    const travelMs = e.startT !== undefined ? e.t - e.startT : null;
    const sign = direction.get(e.teamId);
    return {
      eventId: e.id,
      teamId: e.teamId,
      straightLineDistanceM: distance === null ? null : round1(distance),
      travelMs,
      averageStraightLineSpeedMps: distance !== null && travelMs ? round1(distance / (travelMs / 1000)) : null,
      forwardProgressM: e.start && e.end && sign ? round1((e.end.x - e.start.x) * sign) : null,
      unavailable,
    };
  });
  return { passes, omittedOlder: all.length - kept.length };
}

// Formation changes ----------------------------------------------------------

export interface FormationChangeMeasurement {
  eventId: string;
  teamId: string;
  t: number;
  from: FormationId;
  to: FormationId;
  /** Time from the change to the selected time. */
  activeForMs: number;
}

/**
 * Formation changes announced by the supplied formation-change events. Only
 * changes already applied (their event is supplied) appear; a change scheduled
 * for later never does. Fixtures without formation data give none.
 */
export function measureFormationChanges(
  events: readonly MatchEvent[],
  applied: readonly { eventId: string; teamId: string; t: number; from: FormationId; to: FormationId }[] | undefined,
  selectedMs: number,
): FormationChangeMeasurement[] {
  if (!applied) return [];
  const byEvent = new Map(applied.map((c) => [c.eventId, c]));
  return events.flatMap((e) => {
    const c = e.type === "formation-change" && e.t <= selectedMs ? byEvent.get(e.id) : undefined;
    return c ? [{ eventId: e.id, teamId: c.teamId, t: c.t, from: c.from, to: c.to, activeForMs: selectedMs - c.t }] : [];
  });
}

// Positions ------------------------------------------------------------------

/** The part of a snapshot the position measurements read. */
export interface PositionSample {
  t: number;
  discontinuity?: boolean;
  ball: { x: number; y: number };
  possession: Possession | null;
  players: { playerId: string; x: number; y: number }[];
}

/** Events and snapshot times a measurement may cite: the ones supplied with it. */
export interface Citable {
  events: readonly Pick<MatchEvent, "id" | "t" | "teamId">[];
  snapshotTimes: readonly number[];
}

/** A citation in the explanation contract's shape: an event by ID or a snapshot by time. */
export type EvidenceCitation = { kind: "event"; id: string } | { kind: "snapshot"; t: number };

export interface PossessionSpell {
  teamId: string;
  /** First snapshot showing the team in possession, or the window start when the spell began before it. */
  fromMs: number;
  /** Last snapshot at or before the selected time showing the team in possession. */
  toMs: number;
  /** `toMs − fromMs`. Includes the team's own passes in flight, when no one has the ball. */
  durationMs: number;
  startsBeforeWindow: boolean;
  /** Why the spell ended, as far as is known at the selected time. */
  end: "opponent-gained-possession" | "reset" | "ongoing";
  /**
   * Supplied events by this team from `fromMs` until the other team gained
   * possession or the reset (to the selected time while ongoing), so a shot
   * struck after the team's last touch still counts.
   */
  eventIds: string[];
  /** Supplied snapshots within [fromMs, toMs]. */
  snapshotTimes: number[];
  /**
   * The earliest and latest of that evidence (one entry when they are the
   * same). A claim stating the spell's duration cites both, so it stays
   * within the per-claim citation limit however long the spell is.
   */
  cite: EvidenceCitation[];
}

/**
 * Team possession spells over [windowStartMs, selectedMs], read from every
 * snapshot in that range (`samples`, oldest first, none after the selected
 * time). A spell is one team's run of possession: snapshots with no
 * possession (a pass in flight, a dead ball) do not end it, the other team
 * gaining possession or a reset does. A spell starts at the first sample in
 * the window that shows the team on the ball; it `startsBeforeWindow` when
 * that is the sample in force at the window start and the team already had
 * the ball before it. A spell with no supplied event or snapshot inside it
 * cannot be cited and is counted in `omittedUncitable`.
 */
export function measurePossessionSpells(
  samples: readonly PositionSample[], windowStartMs: number, selectedMs: number, citable: Citable,
  limit: number = DERIVED_LIMITS.possessionSpells,
): { spells: PossessionSpell[]; omittedOlder: number; omittedUncitable: number } {
  type Open = { teamId: string; fromMs: number; toMs: number; startsBeforeWindow: boolean };
  // `closedAt`: when the opponent gained possession or the reset happened; the spell's events stop just before it.
  const closed: (Open & { end: PossessionSpell["end"]; closedAt: number })[] = [];
  let open = null as Open | null;
  // The state at the window start is the latest sample at or before it.
  let first = 0;
  for (let i = 0; i < samples.length && samples[i]!.t <= windowStartMs; i++) first = i;
  // The latest team in possession at or before sample `from`, back to a reset.
  const latestTeam = (from: number): string | null => {
    for (let i = from; i >= 0; i--) {
      const s = samples[i]!;
      if (s.possession) return s.possession.teamId;
      if (s.discontinuity) return null;
    }
    return null;
  };
  // A spell the window-start sample shows began before the window if the window starts after that sample,
  // or the same team had the ball before it.
  const runsIntoWindow = (teamId: string) => windowStartMs > 0 && (samples[first]!.t < windowStartMs ||
    (!samples[first]!.discontinuity && first > 0 && latestTeam(first - 1) === teamId));
  for (let i = first; i < samples.length; i++) {
    const s = samples[i]!;
    if (s.t > selectedMs) break;
    if (s.discontinuity && i > first && open) {
      closed.push({ ...open, end: "reset", closedAt: s.t });
      open = null;
    }
    const at = Math.max(s.t, windowStartMs);
    const teamId = s.possession?.teamId;
    if (!teamId) continue;
    if (open?.teamId === teamId) {
      open.toMs = at;
      continue;
    }
    if (open) closed.push({ ...open, end: "opponent-gained-possession", closedAt: at });
    open = { teamId, fromMs: at, toMs: at, startsBeforeWindow: i === first && runsIntoWindow(teamId) };
  }
  const all = [...closed, ...(open ? [{ ...open, end: "ongoing" as const, closedAt: selectedMs + 1 }] : [])];
  let omittedUncitable = 0;
  const spells = all.flatMap((sp): PossessionSpell[] => {
    const eventIds = citable.events.filter((e) => e.teamId === sp.teamId && e.t >= sp.fromMs && e.t < sp.closedAt).map((e) => e.id);
    const snapshotTimes = citable.snapshotTimes.filter((t) => t >= sp.fromMs && t <= sp.toMs);
    if (eventIds.length === 0 && snapshotTimes.length === 0) {
      omittedUncitable++;
      return [];
    }
    // Oldest first; an event before a snapshot at the same time.
    const evidence = [
      ...citable.events.filter((e) => eventIds.includes(e.id)).map((e) => ({ t: e.t, ref: { kind: "event" as const, id: e.id } })),
      ...snapshotTimes.map((t) => ({ t, ref: { kind: "snapshot" as const, t } })),
    ].sort((a, b) => a.t - b.t || (a.ref.kind === "event" ? -1 : 1));
    const cite = evidence.length > 1 ? [evidence[0]!.ref, evidence[evidence.length - 1]!.ref] : [evidence[0]!.ref];
    return [{ teamId: sp.teamId, fromMs: sp.fromMs, toMs: sp.toMs, durationMs: sp.toMs - sp.fromMs,
      startsBeforeWindow: sp.startsBeforeWindow, end: sp.end, eventIds, snapshotTimes, cite }];
  });
  const kept = spells.slice(Math.max(0, spells.length - limit));
  return { spells: kept, omittedOlder: spells.length - kept.length, omittedUncitable };
}

export type MovementSubject = { kind: "ball" } | { kind: "player"; playerId: string };

export interface MovementMeasurement {
  subject: MovementSubject;
  /** Earliest and latest supplied snapshot used, the latest being the one at the selected time. */
  fromMs: number;
  toMs: number;
  /** Every supplied snapshot used, oldest first; cite them all for a movement claim. */
  snapshotTimes: number[];
  /** Straight-line distance between the positions at `fromMs` and `toMs`. */
  displacementM: number | null;
  /**
   * Sum of the straight lines between consecutive supplied snapshots. The
   * subject may have moved further between samples, so this is a lower bound
   * on the path, not the path itself.
   */
  sampledPathM: number | null;
  /** `sampledPathM` over `toMs − fromMs`: an average along the sampled path, not a top or current speed. */
  averageSampledPathSpeedMps: number | null;
  /** Why the values are `null`: fewer than two snapshots of the subject in one continuous segment. */
  unavailable?: "single-sample";
}

/**
 * Movement of the ball and each listed player across the supplied snapshots
 * (`samples`, oldest first, the last at the selected time). Only the latest
 * continuous segment counts: a reset at `resetTimes` (every discontinuity at
 * or before the selected time, including ones between supplied snapshots)
 * ends it, as does a snapshot without the player.
 */
export function measureMovement(
  samples: readonly PositionSample[], resetTimes: readonly number[], subjects: readonly MovementSubject[],
): MovementMeasurement[] {
  if (samples.length === 0) return [];
  // A pair of samples is continuous when no reset falls in (earlier.t, later.t].
  const continuous = (a: PositionSample, b: PositionSample) => !b.discontinuity && !resetTimes.some((t) => t > a.t && t <= b.t);
  return subjects.map((subject) => {
    const at = (s: PositionSample) => subject.kind === "ball" ? s.ball : s.players.find((p) => p.playerId === subject.playerId);
    const used: { t: number; p: { x: number; y: number } }[] = [];
    for (let i = samples.length - 1; i >= 0; i--) {
      const p = at(samples[i]!);
      if (!p) break;
      if (used.length && !continuous(samples[i]!, samples[i + 1]!)) break;
      used.unshift({ t: samples[i]!.t, p });
    }
    const last = samples[samples.length - 1]!;
    if (used.length < 2) {
      return { subject, fromMs: used[0]?.t ?? last.t, toMs: last.t, snapshotTimes: used.map((u) => u.t),
        displacementM: null, sampledPathM: null, averageSampledPathSpeedMps: null, unavailable: "single-sample" as const };
    }
    let path = 0;
    for (let i = 1; i < used.length; i++) path += planar(used[i - 1]!.p, used[i]!.p);
    const fromMs = used[0]!.t;
    const toMs = used[used.length - 1]!.t;
    return {
      subject, fromMs, toMs, snapshotTimes: used.map((u) => u.t),
      displacementM: round1(planar(used[0]!.p, used[used.length - 1]!.p)),
      sampledPathM: round1(path),
      averageSampledPathSpeedMps: round1(path / ((toMs - fromMs) / 1000)),
    };
  });
}

export interface ProximityMeasurement {
  /** The snapshot the counts come from. */
  snapshotT: number;
  /** Player in control of the ball in that snapshot. */
  playerId: string;
  teamId: string;
  /** Opponents whose position is within each radius of the player, boundary included. */
  opponentsWithin: { radiusM: number; count: number }[];
  /** Straight-line distance to the closest opponent in the snapshot, or `null` when none is present. */
  nearestOpponentM: number | null;
}

/**
 * How many opponents are near the player controlling the ball in `sample`.
 * A count of positions within fixed radii: not a pressure rating, and it says
 * nothing about whether anyone is closing the player down. `null` when no
 * player controls the ball or the controller is not in the snapshot.
 */
export function measureProximity(
  sample: PositionSample, teamOf: ReadonlyMap<string, string>, radiiM: readonly number[] = DERIVED_LIMITS.proximityRadiiM,
): ProximityMeasurement | null {
  const playerId = sample.possession?.playerId;
  if (!playerId) return null;
  const carrier = sample.players.find((p) => p.playerId === playerId);
  const teamId = teamOf.get(playerId);
  if (!carrier || !teamId) return null;
  const distances = sample.players
    .filter((p) => { const team = teamOf.get(p.playerId); return team !== undefined && team !== teamId; })
    .map((p) => planar(carrier, p));
  return {
    snapshotT: sample.t,
    playerId,
    teamId,
    // Compared before rounding, so a player exactly on the radius counts.
    opponentsWithin: radiiM.map((radiusM) => ({ radiusM, count: distances.filter((d) => d <= radiusM + 1e-9).length })),
    nearestOpponentM: distances.length ? round1(Math.min(...distances)) : null,
  };
}
