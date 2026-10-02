/**
 * "Explain this moment": the evidence package.
 *
 * `extractMatchContext(fixture, t)` turns a fixture and a playback time into a
 * compact, JSON-serialisable summary of what is observable at that time. It is
 * the only match data an explanation may draw on, and every evidence
 * reference in an explanation must point back into it (see ./response.ts).
 *
 * Nothing after the selected time is included:
 *   - events are those with `t` ≤ the selected time, as in playback; an action
 *     that starts earlier but resolves later (a pass or shot still in flight,
 *     an offside not yet flagged) is not included at all
 *   - a shot whose result has not been revealed is reported as `pending`,
 *     without its destination
 *   - positions come from the latest snapshot at or before the selected time,
 *     never from interpolation towards the next one
 *   - formations are the starting formation plus changes applied by then;
 *     scheduled changes are never included
 *
 * Pure and deterministic: the same fixture, time and options always give the
 * same package. No rendering, React or network dependencies.
 */
import type {
  EventType,
  FormationId,
  MatchEvent,
  MatchFixture,
  Possession,
  Score,
  Snapshot,
  TacticalPosition,
  Team,
  Vec3,
} from "@/match/contract";
import { formationSlot } from "@/match/formations";
import { validateFixture } from "@/match/validate";
import { eventsAt, formationsAt, lastAtOrBefore, scoreAt } from "@/playback/derive";

export const CONTEXT_VERSION = "1.0.0" as const;

/** Defaults and hard limits for the extractor options. */
export const CONTEXT_LIMITS = {
  lookbackMs: { default: 10_000, min: 0, max: 30_000 },
  maxEvents: { default: 20, min: 1, max: 50 },
  maxSnapshots: { default: 6, min: 1, max: 8 },
  maxBytes: { default: 24_000, min: 8_000, max: 64_000 },
} as const;

export interface ContextOptions {
  /** How far before the selected time events and snapshots are taken from, in ms. */
  lookbackMs?: number;
  /** Most recent events kept from the lookback window. */
  maxEvents?: number;
  /** Snapshots kept, including the one at the selected time, spread evenly over the window. */
  maxSnapshots?: number;
  /** Upper bound on the package's size as UTF-8 JSON. */
  maxBytes?: number;
}

export interface ContextPlayer {
  id: string;
  teamId: string;
  name: string;
  number: number;
  role: "GK" | "DF" | "MF" | "FW";
  /** Formation slot at the selected time; absent without formation data. */
  slot?: { id: string; position: TacticalPosition };
}

export interface ContextFormation {
  teamId: string;
  formation: FormationId;
  /** When it took effect: 0 for the starting formation. */
  since: number;
  /** The formation-change event that applied it; absent for the starting formation. */
  changeEventId?: string;
}

export interface ContextEvent {
  id: string;
  t: number;
  type: EventType;
  teamId: string;
  playerId?: string;
  recipientId?: string;
  outcome: MatchEvent["outcome"];
  startT?: number;
  start?: Vec3;
  end?: Vec3;
  description: string;
}

export interface ContextSnapshot {
  t: number;
  discontinuity?: true;
  ball: Vec3;
  possession: Possession | null;
  players: { playerId: string; x: number; y: number; facing: number }[];
}

export type LimitationCode =
  | "synthetic-data"
  | "no-player-attributes"
  | "no-formation-data"
  | "positions-sampled-earlier"
  | "ball-not-controlled"
  | "events-before-window"
  | "events-truncated"
  | "snapshots-truncated";

export interface Limitation {
  code: LimitationCode;
  message: string;
}

export interface MatchContext {
  contextVersion: typeof CONTEXT_VERSION;
  match: {
    matchId: string;
    /**
     * Neutral label built from the team names. The fixture's own `title` is
     * left out: it is free text that can describe the whole sequence,
     * including how it ends (the scripted demo's is "turnover to goal").
     */
    label: string;
    // The fixture's `generator` metadata (seed, simulator version, config key)
    // is for debugging and reproducing a match and says nothing about the
    // football, so it is left out too.
    schemaVersion: string;
    synthetic: true;
    durationMs: number;
  };
  time: {
    /** The time asked for, after flooring to whole ms. */
    selectedMs: number;
    /** Time of the snapshot the positions come from: the latest at or before `selectedMs`. */
    positionsAtMs: number;
    lookbackMs: number;
    /** Events and snapshots come from [windowStartMs, selectedMs]. */
    windowStartMs: number;
  };
  score: Score;
  teams: Pick<Team, "id" | "side" | "name" | "shortName" | "attacksTowards">[];
  players: ContextPlayer[];
  /** Each team's active formation, or null for fixtures without formation data. */
  formations: ContextFormation[] | null;
  /** Revealed events in the window, oldest first. */
  events: ContextEvent[];
  /** Oldest first; the last one is at `time.positionsAtMs`. */
  snapshots: ContextSnapshot[];
  ball: {
    /** `controlled`: a player has the ball; `team`: a team has it but nobody is touching it; `none`: in flight, loose or dead. */
    control: "controlled" | "team" | "none";
    /** Latest snapshot in the window in which a player controlled the ball. */
    lastControl: { t: number; teamId: string; playerId: string } | null;
  };
  limitations: Limitation[];
}

// Adding 0 turns -0 into 0, so values survive a JSON round trip unchanged.
const round1 = (v: number) => Math.round(v * 10) / 10 + 0;
const round2 = (v: number) => Math.round(v * 100) / 100 + 0;
const vec = (p: Vec3): Vec3 => ({ x: round1(p.x), y: round1(p.y), z: round1(p.z) });

function option(name: keyof typeof CONTEXT_LIMITS, value: number | undefined): number {
  const { default: fallback, min, max } = CONTEXT_LIMITS[name];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer from ${min} to ${max}, got ${String(value)}`);
  return value;
}

/** Byte length of the package as UTF-8 JSON. */
export function contextSize(context: MatchContext): number {
  return new TextEncoder().encode(JSON.stringify(context)).length;
}

const isShotResult = (shot: MatchEvent, e: MatchEvent) =>
  (e.type === "goal" || e.type === "shot-result") && e.teamId === shot.teamId && (e.startT === undefined || e.startT === shot.t);

/**
 * Evidence package for `fixture` at playback time `t` (ms). Throws a
 * RangeError for a time outside [0, durationMs] or a bad option, and an Error
 * for a fixture that fails validation.
 */
export function extractMatchContext(fixture: MatchFixture, t: number, options: ContextOptions = {}): MatchContext {
  if (typeof t !== "number" || !Number.isFinite(t)) throw new RangeError(`Time must be a finite number of ms, got ${String(t)}`);
  if (t < 0 || t > fixture.durationMs) throw new RangeError(`Time ${t} is outside the match (0 to ${fixture.durationMs} ms)`);
  const lookbackMs = option("lookbackMs", options.lookbackMs);
  const maxEvents = option("maxEvents", options.maxEvents);
  const maxSnapshots = option("maxSnapshots", options.maxSnapshots);
  const maxBytes = option("maxBytes", options.maxBytes);
  const problems = validateFixture(fixture);
  if (problems.length > 0) throw new Error(`Invalid fixture: ${problems.slice(0, 3).join("; ")}`);

  const selectedMs = Math.floor(t);
  const windowStartMs = Math.max(0, selectedMs - lookbackMs);

  // Events: revealed by the selected time, inside the window, most recent kept.
  const revealed = eventsAt(fixture, selectedMs);
  const beforeWindow = lastAtOrBefore(revealed, windowStartMs - 1, (e) => e.t) + 1;
  const playerName = new Map(fixture.roster.map((p) => [p.id, `${p.name} (#${p.number})`]));
  // `revealed` is a prefix of the fixture's events, so `i` is also the event's index there.
  const toContextEvent = (e: MatchEvent, i: number): ContextEvent => {
    const pending = e.type === "shot" && !revealed.slice(i + 1).some((r) => isShotResult(e, r));
    const out: ContextEvent = { id: e.id, t: e.t, type: e.type, teamId: e.teamId, outcome: pending ? "pending" : e.outcome, description: e.description };
    if (e.playerId !== undefined) out.playerId = e.playerId;
    if (e.recipientId !== undefined) out.recipientId = e.recipientId;
    if (e.startT !== undefined) out.startT = e.startT;
    if (e.start) out.start = vec(e.start);
    if (pending) {
      // The destination and result of a shot belong to its result event, which has not happened yet.
      const by = e.playerId ? ` by ${playerName.get(e.playerId) ?? e.playerId}` : "";
      out.description = `Shot${by}; result not yet known`;
    } else if (e.end) out.end = vec(e.end);
    return out;
  };
  let events = revealed.slice(beforeWindow).map((e, k) => toContextEvent(e, beforeWindow + k));
  let truncatedEvents = Math.max(0, events.length - maxEvents);
  events = events.slice(truncatedEvents);

  // Snapshots: the latest at or before the selected time, plus earlier ones spread over the window.
  const snaps = fixture.snapshots;
  const anchorIndex = Math.max(0, lastAtOrBefore(snaps, selectedMs, (s) => s.t));
  const anchor = snaps[anchorIndex]!;
  const picked = new Set<number>([anchorIndex]);
  for (let k = 1; k < maxSnapshots; k++) {
    const target = anchor.t - Math.round((k * lookbackMs) / (maxSnapshots - 1));
    if (target < windowStartMs) break;
    const i = lastAtOrBefore(snaps, target, (s) => s.t);
    if (i >= 0 && snaps[i]!.t >= windowStartMs) picked.add(i);
  }
  const toContextSnapshot = (s: Snapshot): ContextSnapshot => ({
    t: s.t,
    ...(s.discontinuity ? { discontinuity: true as const } : {}),
    ball: vec(s.ball),
    possession: s.possession ? { teamId: s.possession.teamId, playerId: s.possession.playerId } : null,
    players: s.players.map((p) => ({ playerId: p.playerId, x: round1(p.x), y: round1(p.y), facing: round2(p.facing) })),
  });
  let snapshots = [...picked].sort((a, b) => a - b).map((i) => toContextSnapshot(snaps[i]!));
  let truncatedSnapshots = 0;

  let lastControl: MatchContext["ball"]["lastControl"] = null;
  for (let i = anchorIndex; i >= 0 && (i === anchorIndex || snaps[i]!.t >= windowStartMs); i--) {
    const p = snaps[i]!.possession;
    if (p?.playerId) {
      lastControl = { t: snaps[i]!.t, teamId: p.teamId, playerId: p.playerId };
      break;
    }
  }
  const control = anchor.possession ? (anchor.possession.playerId ? "controlled" : "team") : "none";

  // Formations active at the selected time; scheduled changes are deliberately left out.
  const active = formationsAt(fixture, selectedMs);
  const slotOf = new Map<string, ContextPlayer["slot"]>();
  for (const f of active ?? []) {
    for (const [playerId, slotId] of Object.entries(f.assignments)) {
      const s = formationSlot(f.formation, slotId);
      if (s) slotOf.set(playerId, { id: s.id, position: s.position });
    }
  }
  const formations =
    active?.map((f): ContextFormation => {
      const change = f.since > 0 ? fixture.tactics!.applied.find((c) => c.teamId === f.teamId && c.t === f.since) : undefined;
      return { teamId: f.teamId, formation: f.formation, since: f.since, ...(change ? { changeEventId: change.eventId } : {}) };
    }) ?? null;

  const home = fixture.teams.find((team) => team.side === "home")!;
  const away = fixture.teams.find((team) => team.side === "away")!;

  const build = (): MatchContext => {
    const limitations: Limitation[] = [
      {
        code: "synthetic-data",
        message:
          "Synthetic match from a simplified simulation or a scripted demo. Teams, players and events are made up; nothing here describes real football.",
      },
      {
        code: "no-player-attributes",
        message:
          "The data has no player attributes, fitness, instructions or intentions; only positions, possession and recorded events.",
      },
    ];
    if (!formations)
      limitations.push({ code: "no-formation-data", message: "This fixture has no formation data, so formations and player slots are unknown." });
    if (anchor.t < selectedMs)
      limitations.push({
        code: "positions-sampled-earlier",
        message: `Positions are from the snapshot at ${anchor.t} ms, the latest at or before the selected time (${selectedMs} ms).`,
      });
    if (control === "none")
      limitations.push({
        code: "ball-not-controlled",
        message: "No player controls the ball (in flight, loose or dead). The outcome of any pass or shot still in progress is not included.",
      });
    if (beforeWindow > 0)
      limitations.push({
        code: "events-before-window",
        message: `${beforeWindow} earlier event(s) before ${windowStartMs} ms are outside the lookback window; the score still counts them.`,
      });
    if (truncatedEvents > 0)
      limitations.push({ code: "events-truncated", message: `${truncatedEvents} older event(s) in the window were left out to bound the payload.` });
    if (truncatedSnapshots > 0)
      limitations.push({ code: "snapshots-truncated", message: `${truncatedSnapshots} older snapshot(s) were left out to bound the payload.` });

    return {
      contextVersion: CONTEXT_VERSION,
      match: {
        matchId: fixture.matchId,
        label: `${home.name} vs ${away.name} (synthetic)`,
        schemaVersion: fixture.schemaVersion,
        synthetic: true,
        durationMs: fixture.durationMs,
      },
      time: { selectedMs, positionsAtMs: anchor.t, lookbackMs, windowStartMs },
      score: scoreAt(fixture, selectedMs),
      teams: fixture.teams.map((team) => ({
        id: team.id,
        side: team.side,
        name: team.name,
        shortName: team.shortName,
        attacksTowards: team.attacksTowards,
      })),
      players: fixture.roster.map((p) => {
        const slot = slotOf.get(p.id);
        return { id: p.id, teamId: p.teamId, name: p.name, number: p.number, role: p.role, ...(slot ? { slot } : {}) };
      }),
      formations,
      events,
      snapshots,
      ball: { control, lastControl },
      limitations,
    };
  };

  // Bound the payload: drop the oldest earlier snapshots first, then the oldest events.
  let context = build();
  while (contextSize(context) > maxBytes) {
    if (snapshots.length > 1) {
      snapshots = snapshots.slice(1);
      truncatedSnapshots++;
    } else if (events.length > 0) {
      events = events.slice(1);
      truncatedEvents++;
    } else {
      throw new RangeError(`The minimal context does not fit in maxBytes = ${maxBytes}`);
    }
    context = build();
  }
  return context;
}
