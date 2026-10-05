/**
 * "Explain this moment": the evidence an analyst model may see, and the tools
 * it may call to see more.
 *
 * An `EvidenceSession` is bound to one fixture and one selected time. The
 * model never gets the fixture, the simulator or anything after the selected
 * time: it starts from the default evidence package (`extractMatchContext`)
 * and can call two tools, both answered by `extractMatchContext` at or before
 * the cutoff and limited to a fixed lookback:
 *
 *   - `list_events`: revealed events further back, optionally by type
 *   - `get_positions`: the position snapshot at an earlier time
 *
 * The cutoff is enforced here in code, not by the prompt: a tool call asking
 * for a time after the selected time, or before the lookback limit, is refused.
 *
 * Every event and snapshot handed to the model is recorded. `context()`
 * returns the base package extended with that evidence, which is what an
 * explanation's citations are checked against: a citation must point at
 * something the model was actually shown.
 *
 * Pure: no network, credentials or rendering.
 */
import type { EventType, MatchFixture } from "@/match/contract";
import { extractMatchContext, type ContextEvent, type ContextSnapshot, type MatchContext } from "./context";

/** How far before the selected time the tools can reach, in ms. */
export const TOOL_LOOKBACK_MS = 30_000;
/** Most events one `list_events` call returns. */
export const TOOL_MAX_EVENTS = 40;

// A record keyed by EventType, so adding an event type to the contract fails to compile until it is listed here.
const EVENT_TYPE_SET: Record<EventType, true> = {
  kickoff: true,
  turnover: true,
  pass: true,
  shot: true,
  goal: true,
  "shot-result": true,
  "goal-kick": true,
  "throw-in": true,
  corner: true,
  "free-kick": true,
  penalty: true,
  foul: true,
  offside: true,
  deflection: true,
  "formation-change": true,
};
export const EVENT_TYPES = Object.keys(EVENT_TYPE_SET) as EventType[];

export type ToolResult =
  | { ok: true; content: unknown; events: string[]; snapshots: number[] }
  | { ok: false; error: string };

/** Tool definitions in the OpenAI-compatible function-calling format Foundry uses. */
export const EVIDENCE_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_events",
      description:
        `Revealed match events from fromMs up to the selected time, oldest first (at most ${TOOL_MAX_EVENTS}, the most recent kept). ` +
        `fromMs defaults to ${TOOL_LOOKBACK_MS / 1000} s before the selected time and cannot be earlier than that. Nothing after the selected time is ever returned.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          fromMs: { type: "integer", description: "Start of the window in ms of match time." },
          types: { type: "array", items: { type: "string", enum: [...EVENT_TYPES] }, description: "Only these event types." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_positions",
      description:
        `Ball, possession and every player's position from the latest snapshot at or before atMs. atMs must be from ${TOOL_LOOKBACK_MS / 1000} s before the selected time up to the selected time.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["atMs"],
        properties: { atMs: { type: "integer", description: "Time in ms of match time." } },
      },
    },
  },
] as const;

export type ToolName = (typeof EVIDENCE_TOOLS)[number]["function"]["name"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class EvidenceSession {
  readonly base: MatchContext;
  private readonly fixture: MatchFixture;
  private readonly order: Map<string, number>;
  private readonly events = new Map<string, ContextEvent>();
  private readonly snapshots = new Map<number, ContextSnapshot>();

  /** Throws a RangeError for a time outside the match and an Error for an invalid fixture, like extractMatchContext. */
  constructor(fixture: MatchFixture, timeMs: number) {
    this.fixture = fixture;
    this.base = extractMatchContext(fixture, timeMs);
    this.order = new Map(fixture.events.map((e, i) => [e.id, i]));
    for (const e of this.base.events) this.events.set(e.id, e);
    for (const s of this.base.snapshots) this.snapshots.set(s.t, s);
  }

  get selectedMs(): number {
    return this.base.time.selectedMs;
  }

  /** Earliest time the tools reach. */
  get floorMs(): number {
    return Math.max(0, this.selectedMs - TOOL_LOOKBACK_MS);
  }

  /** Runs a tool call. Bad arguments give `{ ok: false }` (shown to the model), never an exception. */
  call(name: string, rawArguments: string): ToolResult {
    let args: unknown;
    try {
      args = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
    } catch {
      return { ok: false, error: "arguments are not valid JSON" };
    }
    if (!isObject(args)) return { ok: false, error: "arguments must be a JSON object" };
    if (name === "list_events") return this.listEvents(args);
    if (name === "get_positions") return this.getPositions(args);
    return { ok: false, error: `unknown tool ${name}` };
  }

  private listEvents(args: Record<string, unknown>): ToolResult {
    for (const key of Object.keys(args)) if (key !== "fromMs" && key !== "types") return { ok: false, error: `unexpected argument ${key}` };
    let from = this.floorMs;
    if (args.fromMs !== undefined) {
      if (typeof args.fromMs !== "number" || !Number.isInteger(args.fromMs)) return { ok: false, error: "fromMs must be an integer" };
      if (args.fromMs > this.selectedMs) return { ok: false, error: `fromMs is after the selected time (${this.selectedMs} ms); later events are not available` };
      if (args.fromMs < this.floorMs) return { ok: false, error: `fromMs is earlier than ${this.floorMs} ms, the furthest the tools reach back` };
      from = args.fromMs;
    }
    let types: Set<EventType> | null = null;
    if (args.types !== undefined) {
      if (!Array.isArray(args.types) || args.types.length === 0 || args.types.some((t) => !(EVENT_TYPES as readonly unknown[]).includes(t)))
        return { ok: false, error: `types must be a non-empty list of ${EVENT_TYPES.join(", ")}` };
      types = new Set(args.types as EventType[]);
    }
    // Same selected time as the base package, so shot results stay withheld exactly as there.
    const window = extractMatchContext(this.fixture, this.selectedMs, {
      lookbackMs: this.selectedMs - from,
      maxEvents: 50,
      maxSnapshots: 1,
      maxBytes: 64_000,
    });
    const matching = window.events.filter((e) => !types || types.has(e.type));
    const events = matching.slice(-TOOL_MAX_EVENTS);
    for (const e of events) this.events.set(e.id, e);
    return {
      ok: true,
      content: {
        fromMs: from,
        toMs: this.selectedMs,
        events,
        omittedOlder: matching.length > events.length || window.limitations.some((l) => l.code === "events-truncated"),
      },
      events: events.map((e) => e.id),
      snapshots: [],
    };
  }

  private getPositions(args: Record<string, unknown>): ToolResult {
    for (const key of Object.keys(args)) if (key !== "atMs") return { ok: false, error: `unexpected argument ${key}` };
    const at = args.atMs;
    if (typeof at !== "number" || !Number.isInteger(at)) return { ok: false, error: "atMs must be an integer" };
    if (at > this.selectedMs) return { ok: false, error: `atMs is after the selected time (${this.selectedMs} ms); later positions are not available` };
    if (at < this.floorMs) return { ok: false, error: `atMs is earlier than ${this.floorMs} ms, the furthest the tools reach back` };
    const ctx = extractMatchContext(this.fixture, at, { lookbackMs: 0, maxEvents: 1, maxSnapshots: 1 });
    const snapshot = ctx.snapshots[ctx.snapshots.length - 1]!;
    this.snapshots.set(snapshot.t, snapshot);
    return {
      ok: true,
      content: { requestedMs: at, snapshot, ballControl: ctx.ball.control },
      events: [],
      snapshots: [snapshot.t],
    };
  }

  /** The base package plus every event and snapshot the tools returned, in time order. Citations are checked against this. */
  context(): MatchContext {
    const events = [...this.events.values()].sort((a, b) => a.t - b.t || this.order.get(a.id)! - this.order.get(b.id)!);
    const snapshots = [...this.snapshots.values()].sort((a, b) => a.t - b.t);
    return { ...this.base, events, snapshots };
  }
}
