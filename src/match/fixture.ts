/**
 * Deterministic scripted sample fixture: a short, clearly synthetic sequence.
 *
 *   turnover → three completed passes → shot → goal → kickoff restart
 *
 * The fixture is produced by a small builder from hand-written keyframes so the
 * ball and the players touching it stay in sync. Off-ball players follow a
 * simple formation that shifts with the ball. No randomness is used: building
 * the fixture twice yields identical data.
 *
 * The output is plain data matching src/match/contract.ts — consumers never see
 * the builder, so a future simulator can replace it without touching playback
 * or rendering code.
 */
import {
  PITCH_LENGTH,
  PITCH_WIDTH,
  SCHEMA_VERSION,
  type MatchEvent,
  type MatchFixture,
  type Player,
  type PlayerState,
  type Possession,
  type Snapshot,
  type Team,
  type Vec2,
  type Vec3,
} from "./contract";

const SNAPSHOT_INTERVAL_MS = 100;
const DURATION_MS = 24_000;
const BALL_RADIUS = 0.11;
/** Distance from a player's centre to a ball at their feet. */
const DRIBBLE_OFFSET = 0.55;

// Timeline (ms) -----------------------------------------------------------------
const T_TURNOVER = 2_400;
const T_PASS1_KICK = 2_900;
const T_PASS1_RECV = 4_000;
const T_PASS2_KICK = 5_300;
const T_PASS2_RECV = 6_500;
const T_PASS3_KICK = 7_300;
const T_PASS3_RECV = 8_100;
const T_SHOT = 8_800;
const T_GOAL = 9_400;
const T_IN_NET = 9_650;
const T_BALL_DEAD = 10_100;
/** Everyone starts walking back to kickoff positions. */
const T_WALK_BACK = 10_500;
/** Everyone is in kickoff position. */
const T_SET = 19_000;
const T_KICKOFF = 19_500;
const T_KICKOFF_PASS_KICK = 20_000;
const T_KICKOFF_PASS_RECV = 21_000;
/** How long players take to blend from kickoff spots back into shifting formation. */
const KICKOFF_BLEND_MS = 4_500;

// Teams and roster ------------------------------------------------------------

const HOME = "hcf";
const AWAY = "nvr";

const teams: [Team, Team] = [
  {
    id: HOME,
    side: "home",
    name: "Harbor City FC",
    shortName: "HCF",
    kit: { primary: "#1d4ed8", secondary: "#bfdbfe", number: "#ffffff" },
    attacksTowards: "increasing-x",
  },
  {
    id: AWAY,
    side: "away",
    name: "Northvale Rovers",
    shortName: "NVR",
    kit: { primary: "#f97316", secondary: "#7c2d12", number: "#111827" },
    attacksTowards: "decreasing-x",
  },
];

type Role = Player["role"];

/** Shirt number → [role, base position for a team attacking towards +x]. */
const FORMATION: Record<number, [Role, Vec2]> = {
  1: ["GK", { x: 5, y: 34 }],
  2: ["DF", { x: 32, y: 56 }],
  5: ["DF", { x: 28, y: 41 }],
  4: ["DF", { x: 28, y: 27 }],
  3: ["DF", { x: 32, y: 12 }],
  6: ["MF", { x: 40, y: 34 }],
  8: ["MF", { x: 46, y: 24 }],
  10: ["MF", { x: 48, y: 44 }],
  7: ["FW", { x: 58, y: 58 }],
  9: ["FW", { x: 60, y: 34 }],
  11: ["FW", { x: 58, y: 10 }],
};

/** Kickoff positions in pitch coordinates. Away kicks off after conceding. */
const KICKOFF: Record<string, Record<number, Vec2>> = {
  [HOME]: {
    1: { x: 5, y: 34 },
    2: { x: 40, y: 58 },
    5: { x: 35, y: 42 },
    4: { x: 35, y: 26 },
    3: { x: 40, y: 10 },
    6: { x: 42, y: 34 },
    8: { x: 46, y: 22 },
    10: { x: 46, y: 46 },
    7: { x: 50, y: 60 },
    9: { x: 43, y: 30 },
    11: { x: 50, y: 8 },
  },
  [AWAY]: {
    1: { x: 100, y: 34 },
    2: { x: 73, y: 10 },
    5: { x: 70, y: 26 },
    4: { x: 70, y: 42 },
    3: { x: 73, y: 58 },
    6: { x: 63, y: 34 },
    8: { x: 58, y: 39 },
    10: { x: 60, y: 25 },
    7: { x: 54, y: 8 },
    9: { x: 53.05, y: 34 },
    11: { x: 54, y: 60 },
  },
};

const NAMES: Record<string, Record<number, string>> = {
  [HOME]: {
    1: "T. Varga",
    2: "E. Mensah",
    3: "J. Pereira",
    4: "K. Asante",
    5: "M. Lind",
    6: "S. Okafor",
    7: "L. Brandt",
    8: "N. Haddad",
    9: "R. Castell",
    10: "I. Moreau",
    11: "D. Novak",
  },
  [AWAY]: {
    1: "H. Aalto",
    2: "A. Bello",
    3: "C. Holt",
    4: "P. Dorn",
    5: "Y. Kaya",
    6: "M. Silvi",
    7: "O. Tarr",
    8: "F. Lindqvist",
    9: "B. Oduya",
    10: "L. Ferrand",
    11: "T. Marsh",
  },
};

const SHIRTS = [1, 2, 5, 4, 3, 6, 8, 10, 7, 9, 11];

const pid = (teamId: string, number: number) => `${teamId}-${number}`;

const roster: Player[] = teams.flatMap((team) =>
  SHIRTS.map((number) => ({
    id: pid(team.id, number),
    teamId: team.id,
    name: NAMES[team.id]![number]!,
    number,
    role: FORMATION[number]![0],
  })),
);

const playerById = new Map(roster.map((p) => [p.id, p]));

// Geometry helpers ------------------------------------------------------------

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerp2 = (a: Vec2, b: Vec2, k: number): Vec2 => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) });
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (k: number) => {
  const c = clamp(k, 0, 1);
  return c * c * (3 - 2 * c);
};
const round = (v: number) => Math.round(v * 100) / 100;

// Scripted player paths -------------------------------------------------------

/** A keyframe position, or "auto" to resolve to the formation position at that time. */
type Key = { t: number; at: Vec2 | "auto" };

/** Each script is a sorted list of keys; the player is scripted between its first and last key. */
const SCRIPTS: Record<string, Key[][]> = {
  // Away #8 carries the ball forward and loses it.
  [pid(AWAY, 8)]: [
    [
      { t: 0, at: { x: 60, y: 30 } },
      { t: T_TURNOVER, at: { x: 54.5, y: 31.4 } },
      { t: 3_400, at: { x: 54.8, y: 33.8 } },
      { t: 6_000, at: "auto" },
    ],
    [
      { t: T_KICKOFF, at: "auto" },
      { t: T_KICKOFF_PASS_RECV, at: { x: 58.6, y: 39.2 } },
      { t: DURATION_MS, at: { x: 54.5, y: 37.5 } },
    ],
  ],
  // Home #6 steps in, wins the ball, and plays pass 1.
  [pid(HOME, 6)]: [
    [
      { t: 0, at: "auto" },
      { t: T_TURNOVER, at: { x: 53.4, y: 31.45 } },
      { t: T_PASS1_KICK, at: { x: 54.3, y: 32.4 } },
      { t: 4_500, at: "auto" },
    ],
  ],
  // Home #8 receives pass 1, carries, plays pass 2.
  [pid(HOME, 8)]: [
    [
      { t: 1_500, at: "auto" },
      { t: T_PASS1_RECV, at: { x: 64, y: 22 } },
      { t: T_PASS2_KICK, at: { x: 71.5, y: 24.5 } },
      { t: 6_500, at: { x: 76, y: 22 } },
      { t: 8_500, at: "auto" },
    ],
  ],
  // Home #10 receives pass 2 (lofted), plays pass 3.
  [pid(HOME, 10)]: [
    [
      { t: 2_500, at: "auto" },
      { t: T_PASS2_RECV, at: { x: 81, y: 40 } },
      { t: T_PASS3_KICK, at: { x: 84, y: 38.5 } },
      { t: 8_800, at: { x: 91, y: 40 } },
      { t: 13_000, at: "auto" },
    ],
  ],
  // Home #9 receives pass 3, shoots, scores, celebrates, jogs back.
  [pid(HOME, 9)]: [
    [
      { t: 5_000, at: "auto" },
      { t: T_PASS3_RECV, at: { x: 90.5, y: 31 } },
      { t: T_SHOT, at: { x: 92.5, y: 32 } },
      { t: T_GOAL, at: { x: 94.5, y: 32.5 } },
      { t: 11_800, at: { x: 99, y: 50 } },
      { t: 12_800, at: { x: 98, y: 51 } },
      { t: T_SET, at: KICKOFF[HOME]![9]! },
    ],
  ],
  // Away goalkeeper dives too late.
  [pid(AWAY, 1)]: [
    [
      { t: 8_000, at: "auto" },
      { t: T_SHOT, at: { x: 103.6, y: 33.5 } },
      { t: T_GOAL, at: { x: 103.4, y: 36.2 } },
      { t: 10_600, at: { x: 103.2, y: 35.4 } },
      { t: 13_000, at: "auto" },
    ],
  ],
  // Away #9 takes the kickoff and runs forward.
  [pid(AWAY, 9)]: [
    [
      { t: T_SET, at: "auto" },
      { t: T_KICKOFF_PASS_KICK, at: KICKOFF[AWAY]![9]! },
      { t: 21_500, at: { x: 49, y: 33 } },
      { t: DURATION_MS, at: "auto" },
    ],
  ],
};

// Ball segments -------------------------------------------------------------------

type BallSegment =
  | { kind: "held"; from: number; to: number; playerId: string }
  | {
      kind: "flight";
      from: number;
      to: number;
      start: Vec3 | { heldBy: string };
      end: Vec3 | { heldBy: string };
      /** Extra height at mid-flight, on top of the straight line between endpoints. */
      arc: number;
    }
  | { kind: "dead"; from: number; to: number; at: Vec3 };

const NET_POINT: Vec3 = { x: 106.6, y: 35.8, z: 1.2 };
const GOAL_LINE_POINT: Vec3 = { x: PITCH_LENGTH, y: 35.6, z: 1.7 };
const BALL_REST: Vec3 = { x: 106.4, y: 35.9, z: BALL_RADIUS };

const BALL: BallSegment[] = [
  { kind: "held", from: 0, to: T_TURNOVER, playerId: pid(AWAY, 8) },
  { kind: "held", from: T_TURNOVER, to: T_PASS1_KICK, playerId: pid(HOME, 6) },
  {
    kind: "flight",
    from: T_PASS1_KICK,
    to: T_PASS1_RECV,
    start: { heldBy: pid(HOME, 6) },
    end: { heldBy: pid(HOME, 8) },
    arc: 0.15,
  },
  { kind: "held", from: T_PASS1_RECV, to: T_PASS2_KICK, playerId: pid(HOME, 8) },
  {
    kind: "flight",
    from: T_PASS2_KICK,
    to: T_PASS2_RECV,
    start: { heldBy: pid(HOME, 8) },
    end: { heldBy: pid(HOME, 10) },
    arc: 3.5,
  },
  { kind: "held", from: T_PASS2_RECV, to: T_PASS3_KICK, playerId: pid(HOME, 10) },
  {
    kind: "flight",
    from: T_PASS3_KICK,
    to: T_PASS3_RECV,
    start: { heldBy: pid(HOME, 10) },
    end: { heldBy: pid(HOME, 9) },
    arc: 0.25,
  },
  { kind: "held", from: T_PASS3_RECV, to: T_SHOT, playerId: pid(HOME, 9) },
  { kind: "flight", from: T_SHOT, to: T_GOAL, start: { heldBy: pid(HOME, 9) }, end: GOAL_LINE_POINT, arc: 0.6 },
  { kind: "flight", from: T_GOAL, to: T_IN_NET, start: GOAL_LINE_POINT, end: NET_POINT, arc: 0 },
  { kind: "flight", from: T_IN_NET, to: T_BALL_DEAD, start: NET_POINT, end: BALL_REST, arc: 0 },
  { kind: "dead", from: T_BALL_DEAD, to: T_KICKOFF, at: BALL_REST },
  { kind: "held", from: T_KICKOFF, to: T_KICKOFF_PASS_KICK, playerId: pid(AWAY, 9) },
  {
    kind: "flight",
    from: T_KICKOFF_PASS_KICK,
    to: T_KICKOFF_PASS_RECV,
    start: { heldBy: pid(AWAY, 9) },
    end: { heldBy: pid(AWAY, 8) },
    arc: 0.15,
  },
  { kind: "held", from: T_KICKOFF_PASS_RECV, to: DURATION_MS, playerId: pid(AWAY, 8) },
];

/**
 * Coarse ball track (the contact points above) that the formation reacts to.
 * Kept independent of player positions so off-ball movement never depends on
 * itself through the ball.
 */
const FOCUS: { t: number; at: Vec2 }[] = [
  { t: 0, at: { x: 60, y: 30 } },
  { t: T_TURNOVER, at: { x: 54, y: 31.5 } },
  { t: T_PASS1_KICK, at: { x: 54.5, y: 32.4 } },
  { t: T_PASS1_RECV, at: { x: 64, y: 22 } },
  { t: T_PASS2_KICK, at: { x: 71.5, y: 24.5 } },
  { t: T_PASS2_RECV, at: { x: 81, y: 40 } },
  { t: T_PASS3_KICK, at: { x: 84, y: 38.5 } },
  { t: T_PASS3_RECV, at: { x: 90.5, y: 31 } },
  { t: T_SHOT, at: { x: 92.5, y: 32 } },
  { t: T_GOAL, at: { x: PITCH_LENGTH, y: 35.6 } },
  { t: T_KICKOFF - 1, at: { x: PITCH_LENGTH, y: 35.6 } },
  { t: T_KICKOFF, at: { x: PITCH_LENGTH / 2, y: PITCH_WIDTH / 2 } },
  { t: T_KICKOFF_PASS_KICK, at: { x: PITCH_LENGTH / 2, y: PITCH_WIDTH / 2 } },
  { t: T_KICKOFF_PASS_RECV, at: { x: 58.6, y: 39.2 } },
  { t: DURATION_MS, at: { x: 54.5, y: 37.5 } },
];

function focusAt(t: number): Vec2 {
  for (let i = 0; i < FOCUS.length - 1; i++) {
    const a = FOCUS[i]!;
    const b = FOCUS[i + 1]!;
    if (t >= a.t && t <= b.t) return lerp2(a.at, b.at, (t - a.t) / (b.t - a.t));
  }
  return FOCUS[FOCUS.length - 1]!.at;
}

// Builder -----------------------------------------------------------------------

class SequenceBuilder {
  private posCache = new Map<string, Vec2>();
  private depth = 0;

  private teamOf(playerId: string): Team {
    const teamId = playerById.get(playerId)!.teamId;
    return teams.find((t) => t.id === teamId)!;
  }

  private attackSign(playerId: string): 1 | -1 {
    return this.teamOf(playerId).attacksTowards === "increasing-x" ? 1 : -1;
  }

  /** Base formation position in pitch space (mirrored for the away team). */
  private base(playerId: string): Vec2 {
    const p = playerById.get(playerId)!;
    const b = FORMATION[p.number]![1];
    return this.attackSign(playerId) === 1 ? b : { x: PITCH_LENGTH - b.x, y: PITCH_WIDTH - b.y };
  }

  /** Formation shifted towards where the ball was a moment ago. */
  private shifted(playerId: string, t: number): Vec2 {
    const p = playerById.get(playerId)!;
    const b = this.base(playerId);
    // React to where the ball was a moment ago, but never to where it was before the kickoff reset.
    const focus = focusAt(Math.max(t >= T_KICKOFF ? T_KICKOFF : 0, t - 700));
    const gk = p.role === "GK";
    const kx = gk ? 0.08 : 0.4;
    const ky = gk ? 0.12 : 0.25;
    // Gentle deterministic sway so the formation never looks frozen.
    const sway = Math.sin(t / 1100 + p.number * 1.7) * (gk ? 0.2 : 0.6);
    return {
      x: clamp(b.x + (focus.x - PITCH_LENGTH / 2) * kx + sway, 1, PITCH_LENGTH - 1),
      y: clamp(b.y + (focus.y - PITCH_WIDTH / 2) * ky + sway * 0.5, 1.5, PITCH_WIDTH - 1.5),
    };
  }

  private kickoffSpot(playerId: string): Vec2 {
    const p = playerById.get(playerId)!;
    return KICKOFF[p.teamId]![p.number]!;
  }

  /** Off-ball movement: shifting formation, then walk back to kickoff spots, then blend back in. */
  private offBall(playerId: string, t: number): Vec2 {
    if (t < T_WALK_BACK) return this.shifted(playerId, t);
    if (t < T_KICKOFF) {
      const k = smooth((t - T_WALK_BACK) / (T_SET - T_WALK_BACK));
      return lerp2(this.shifted(playerId, T_WALK_BACK), this.kickoffSpot(playerId), k);
    }
    const k = smooth((t - T_KICKOFF) / KICKOFF_BLEND_MS);
    return lerp2(this.kickoffSpot(playerId), this.shifted(playerId, t), k);
  }

  private resolve(playerId: string, key: Key): Vec2 {
    return key.at === "auto" ? this.offBall(playerId, key.t) : key.at;
  }

  position(playerId: string, t: number): Vec2 {
    const cacheKey = `${playerId}@${t}`;
    const hit = this.posCache.get(cacheKey);
    if (hit) return hit;
    if (++this.depth > 200) throw new Error(`Fixture builder recursion while resolving ${cacheKey}`);
    try {
      let result: Vec2 | undefined;
      for (const keys of SCRIPTS[playerId] ?? []) {
        const first = keys[0]!;
        const last = keys[keys.length - 1]!;
        if (t < first.t || t > last.t) continue;
        for (let i = 0; i < keys.length - 1; i++) {
          const a = keys[i]!;
          const b = keys[i + 1]!;
          if (t >= a.t && t <= b.t) {
            result = lerp2(this.resolve(playerId, a), this.resolve(playerId, b), (t - a.t) / (b.t - a.t));
            break;
          }
        }
        if (result) break;
      }
      result ??= this.offBall(playerId, t);
      this.posCache.set(cacheKey, result);
      return result;
    } finally {
      this.depth--;
    }
  }

  private holder(t: number): string | null {
    const seg = BALL.find((s) => t >= s.from && t < s.to) ?? BALL[BALL.length - 1]!;
    return seg.kind === "held" ? seg.playerId : null;
  }

  /** Facing from velocity; when standing still, face the attack (if on the ball) or the ball. */
  facing(playerId: string, t: number): number {
    const a = this.position(playerId, Math.max(0, t - 100));
    const b = this.position(playerId, Math.min(DURATION_MS, t + 100));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.hypot(dx, dy) > 0.08) return Math.atan2(dy, dx);
    if (this.holder(t) === playerId) return this.attackSign(playerId) === 1 ? 0 : Math.PI;
    const me = this.position(playerId, t);
    const ball = this.ball(t);
    return Math.atan2(ball.y - me.y, ball.x - me.x);
  }

  private atFeet(playerId: string, t: number): Vec3 {
    const p = this.position(playerId, t);
    const f = this.facing(playerId, t);
    return { x: p.x + Math.cos(f) * DRIBBLE_OFFSET, y: p.y + Math.sin(f) * DRIBBLE_OFFSET, z: BALL_RADIUS };
  }

  ball(t: number): Vec3 {
    const seg = BALL.find((s) => t >= s.from && t < s.to) ?? BALL[BALL.length - 1]!;
    switch (seg.kind) {
      case "held":
        return this.atFeet(seg.playerId, t);
      case "dead":
        return seg.at;
      case "flight": {
        const start = "heldBy" in seg.start ? this.atFeet(seg.start.heldBy, seg.from) : seg.start;
        const end = "heldBy" in seg.end ? this.atFeet(seg.end.heldBy, seg.to) : seg.end;
        const k = (t - seg.from) / (seg.to - seg.from);
        return {
          x: lerp(start.x, end.x, k),
          y: lerp(start.y, end.y, k),
          z: Math.max(BALL_RADIUS, lerp(start.z, end.z, k) + 4 * seg.arc * k * (1 - k)),
        };
      }
    }
  }

  possession(t: number): Possession | null {
    const h = this.holder(t);
    return h ? { teamId: playerById.get(h)!.teamId, playerId: h } : null;
  }

  snapshot(t: number): Snapshot {
    const players: PlayerState[] = roster.map((p) => {
      const pos = this.position(p.id, t);
      return { playerId: p.id, x: round(pos.x), y: round(pos.y), facing: round(this.facing(p.id, t)) };
    });
    const b = this.ball(t);
    const snap: Snapshot = {
      t,
      players,
      ball: { x: round(b.x), y: round(b.y), z: round(b.z) },
      possession: this.possession(t),
    };
    if (t === T_KICKOFF) snap.discontinuity = true;
    return snap;
  }

  rounded(v: Vec3): Vec3 {
    return { x: round(v.x), y: round(v.y), z: round(v.z) };
  }
}

function describe(playerId: string): string {
  const p = playerById.get(playerId)!;
  return `#${p.number} ${p.name}`;
}

export function buildSampleFixture(): MatchFixture {
  const b = new SequenceBuilder();
  const snapshots: Snapshot[] = [];
  for (let t = 0; t <= DURATION_MS; t += SNAPSHOT_INTERVAL_MS) snapshots.push(b.snapshot(t));

  // Event positions are sampled at contact times so they match the snapshots.
  const contact = (t: number) => b.rounded(b.ball(t));

  const pass = (
    id: string,
    teamId: string,
    from: string,
    to: string,
    kick: number,
    recv: number,
  ): MatchEvent => ({
    id,
    t: recv,
    type: "pass",
    teamId,
    playerId: from,
    recipientId: to,
    outcome: "complete",
    startT: kick,
    start: contact(kick),
    end: contact(recv),
    description: `Pass ${describe(from)} → ${describe(to)}`,
  });

  const events: MatchEvent[] = [
    {
      id: "e1-turnover",
      t: T_TURNOVER,
      type: "turnover",
      teamId: HOME,
      playerId: pid(HOME, 6),
      outcome: "won",
      start: contact(T_TURNOVER),
      description: `Turnover: ${describe(pid(HOME, 6))} wins the ball from ${describe(pid(AWAY, 8))}`,
    },
    pass("e2-pass", HOME, pid(HOME, 6), pid(HOME, 8), T_PASS1_KICK, T_PASS1_RECV),
    pass("e3-pass", HOME, pid(HOME, 8), pid(HOME, 10), T_PASS2_KICK, T_PASS2_RECV),
    pass("e4-pass", HOME, pid(HOME, 10), pid(HOME, 9), T_PASS3_KICK, T_PASS3_RECV),
    {
      id: "e5-shot",
      t: T_SHOT,
      type: "shot",
      teamId: HOME,
      playerId: pid(HOME, 9),
      outcome: "on-target",
      start: contact(T_SHOT),
      end: GOAL_LINE_POINT,
      description: `Shot on target by ${describe(pid(HOME, 9))}`,
    },
    {
      id: "e6-goal",
      t: T_GOAL,
      type: "goal",
      teamId: HOME,
      playerId: pid(HOME, 9),
      outcome: "scored",
      end: contact(T_GOAL),
      description: `GOAL! ${describe(pid(HOME, 9))} scores for Harbor City FC`,
    },
    {
      id: "e7-kickoff",
      t: T_KICKOFF,
      type: "kickoff",
      teamId: AWAY,
      playerId: pid(AWAY, 9),
      outcome: "taken",
      start: contact(T_KICKOFF),
      description: "Kickoff: Northvale Rovers restart play",
    },
    pass("e8-pass", AWAY, pid(AWAY, 9), pid(AWAY, 8), T_KICKOFF_PASS_KICK, T_KICKOFF_PASS_RECV),
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    matchId: "synthetic-mvp1-sample-001",
    title: "Synthetic sample: turnover to goal",
    synthetic: true,
    durationMs: DURATION_MS,
    teams,
    roster,
    startingState: {
      score: { home: 0, away: 0 },
      possession: { teamId: AWAY, playerId: pid(AWAY, 8) },
    },
    snapshots,
    events,
  };
}

export const sampleFixture: MatchFixture = buildSampleFixture();
