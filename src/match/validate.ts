import { PITCH_LENGTH, PITCH_WIDTH, SCHEMA_VERSION, type MatchFixture } from "./contract";

/** Ball may legitimately sit a little beyond the lines (e.g. in the net). */
const BALL_MARGIN = 4;

/**
 * Checks a fixture against the contract's structural rules. Returns a list of
 * human-readable problems; an empty list means the fixture is valid.
 */
export function validateFixture(f: MatchFixture): string[] {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(msg);

  if (f.schemaVersion !== SCHEMA_VERSION) err(`Unsupported schema version ${f.schemaVersion}`);
  if (!(f.durationMs > 0)) err("durationMs must be positive");

  // Teams and roster
  const teamIds = new Set(f.teams.map((t) => t.id));
  if (teamIds.size !== 2) err("Fixture must have two teams with distinct IDs");
  const playerIds = new Set<string>();
  for (const p of f.roster) {
    if (playerIds.has(p.id)) err(`Duplicate player ID ${p.id}`);
    playerIds.add(p.id);
    if (!teamIds.has(p.teamId)) err(`Player ${p.id} references unknown team ${p.teamId}`);
  }
  for (const t of f.teams) {
    const squad = f.roster.filter((p) => p.teamId === t.id);
    if (squad.length !== 11) err(`Team ${t.id} has ${squad.length} players, expected 11`);
    if (new Set(squad.map((p) => p.number)).size !== squad.length) err(`Team ${t.id} has duplicate shirt numbers`);
  }

  const checkPossession = (where: string, pos: MatchFixture["startingState"]["possession"]) => {
    if (!pos) return;
    if (!teamIds.has(pos.teamId)) err(`${where}: unknown possession team ${pos.teamId}`);
    if (pos.playerId !== null) {
      if (!playerIds.has(pos.playerId)) err(`${where}: unknown possession player ${pos.playerId}`);
      else if (f.roster.find((p) => p.id === pos.playerId)!.teamId !== pos.teamId)
        err(`${where}: possession player ${pos.playerId} is not on team ${pos.teamId}`);
    }
  };

  // Starting state
  const { score } = f.startingState;
  if (!Number.isInteger(score.home) || !Number.isInteger(score.away) || score.home < 0 || score.away < 0)
    err("Starting score must be non-negative integers");
  checkPossession("startingState", f.startingState.possession);

  // Snapshots
  if (f.snapshots.length < 2) err("At least two snapshots are required");
  if (f.snapshots[0]?.t !== 0) err("First snapshot must be at t = 0");
  if (f.snapshots[f.snapshots.length - 1]?.t !== f.durationMs) err("Last snapshot must be at t = durationMs");
  f.snapshots.forEach((s, i) => {
    const where = `snapshot[${i}] t=${s.t}`;
    if (i > 0 && s.t <= f.snapshots[i - 1]!.t) err(`${where}: timestamps must be strictly increasing`);
    if (i === 0 && s.discontinuity) err(`${where}: first snapshot cannot be a discontinuity`);
    const seen = new Set<string>();
    for (const ps of s.players) {
      if (!playerIds.has(ps.playerId)) err(`${where}: unknown player ${ps.playerId}`);
      if (seen.has(ps.playerId)) err(`${where}: duplicate player ${ps.playerId}`);
      seen.add(ps.playerId);
      if (ps.x < 0 || ps.x > PITCH_LENGTH || ps.y < 0 || ps.y > PITCH_WIDTH)
        err(`${where}: player ${ps.playerId} outside the pitch`);
      if (!Number.isFinite(ps.facing)) err(`${where}: player ${ps.playerId} has invalid facing`);
    }
    if (seen.size !== playerIds.size) err(`${where}: expected ${playerIds.size} players, got ${seen.size}`);
    const b = s.ball;
    if (
      b.x < -BALL_MARGIN ||
      b.x > PITCH_LENGTH + BALL_MARGIN ||
      b.y < -BALL_MARGIN ||
      b.y > PITCH_WIDTH + BALL_MARGIN ||
      b.z < 0
    )
      err(`${where}: ball out of bounds`);
    checkPossession(where, s.possession);
  });

  // Events
  const eventIds = new Set<string>();
  f.events.forEach((e, i) => {
    const where = `event[${i}] ${e.id}`;
    if (eventIds.has(e.id)) err(`Duplicate event ID ${e.id}`);
    eventIds.add(e.id);
    if (i > 0 && e.t < f.events[i - 1]!.t) err(`${where}: events must be ordered by timestamp`);
    if (e.t < 0 || e.t > f.durationMs) err(`${where}: timestamp outside fixture duration`);
    if (e.startT !== undefined && (e.startT > e.t || e.startT < 0)) err(`${where}: startT must be within [0, t]`);
    if (!teamIds.has(e.teamId)) err(`${where}: unknown team ${e.teamId}`);
    if (e.playerId !== undefined && !playerIds.has(e.playerId)) err(`${where}: unknown player ${e.playerId}`);
    if (e.type === "pass") {
      if (!e.recipientId) err(`${where}: pass must identify its recipient`);
      else if (!playerIds.has(e.recipientId)) err(`${where}: unknown recipient ${e.recipientId}`);
      else if (f.roster.find((p) => p.id === e.recipientId)!.teamId !== e.teamId && e.outcome === "complete")
        err(`${where}: completed pass recipient must be a teammate`);
    }
  });

  return errors;
}
