import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Formations } from "@/components/Formations";
import { MatchViewer } from "@/components/MatchViewer";
import { tacticsFromControls } from "@/components/SampleMatchViewer";
import {
  FORMATION_IDS,
  PITCH_LENGTH,
  PITCH_WIDTH,
  type FormationId,
  type MatchFixture,
  type SlotAssignments,
  type TeamSide,
} from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import {
  assignmentErrors,
  defaultAssignments,
  FORMATIONS,
  formationSlot,
  remapAssignments,
  slotSpot,
} from "@/match/formations";
import { validateFixture } from "@/match/validate";
import { formationsAt, frameAt } from "@/playback/derive";
import { PlaybackEngine } from "@/playback/engine";
import {
  generateMatch,
  MAX_PLAYER_SPEED,
  RESTART_DISTANCE,
  SIMULATOR_VERSION,
  type TacticsConfig,
} from "@/simulation/generate";

const { teams, roster } = sampleFixture;
const home = teams.find((t) => t.side === "home")!;
const away = teams.find((t) => t.side === "away")!;
const squadOf = (teamId: string) => roster.filter((p) => p.teamId === teamId);
const gap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const teamIdOf = (side: TeamSide) => (side === "home" ? home.id : away.id);
const sideOf = (f: MatchFixture, teamId: string) => f.teams.find((t) => t.id === teamId)!;
const snapshotAt = (f: MatchFixture, t: number) => f.snapshots.find((s) => s.t === t)!;
const baseOf = (f: MatchFixture, playerId: string, t: number) => {
  const teamId = roster.find((p) => p.id === playerId)!.teamId;
  const active = formationsAt(f, t)!.find((x) => x.teamId === teamId)!;
  return slotSpot(formationSlot(active.formation, active.assignments[playerId]!)!, sideOf(f, teamId).attacksTowards);
};

describe("formation presets", () => {
  it.each(FORMATION_IDS)("%s has eleven unique slots, one goalkeeper, all in the team's own half", (id) => {
    const slots = FORMATIONS[id].slots;
    expect(slots).toHaveLength(11);
    expect(new Set(slots.map((s) => s.id)).size).toBe(11);
    expect(slots.filter((s) => s.position === "GK")).toHaveLength(1);
    // The outfield adds up to the name: 4-4-2 → 10 outfield players in four lines' worth of slots.
    expect(id.split("-").map(Number).reduce((a, b) => a + b)).toBe(10);
    for (const s of slots) {
      expect(s.depth).toBeGreaterThan(0);
      expect(s.depth).toBeLessThan(PITCH_LENGTH / 2);
      expect(Math.abs(s.lateral)).toBeLessThan(PITCH_WIDTH / 2);
    }
  });

  it("labels positions explicitly, left on the left", () => {
    for (const id of FORMATION_IDS)
      for (const s of FORMATIONS[id].slots) {
        if (s.position.startsWith("L")) expect(s.lateral).toBeGreaterThan(0);
        if (s.position.startsWith("R")) expect(s.lateral).toBeLessThan(0);
      }
    const positions = new Set(FORMATION_IDS.flatMap((id) => FORMATIONS[id].slots.map((s) => s.position)));
    for (const p of ["GK", "CB", "LB", "RB", "CM", "DM", "AM", "LW", "RW", "ST", "LM", "RM"]) expect(positions.has(p as never), p).toBe(true);
  });

  it("mirrors opposite attacking directions by a half turn, keeping left backs on their left", () => {
    for (const id of FORMATION_IDS)
      for (const s of FORMATIONS[id].slots) {
        const up = slotSpot(s, "increasing-x");
        const down = slotSpot(s, "decreasing-x");
        expect(up.x + down.x).toBeCloseTo(PITCH_LENGTH, 9);
        expect(up.y + down.y).toBeCloseTo(PITCH_WIDTH, 9);
        // Facing +x the left is towards y = 0; facing −x it is towards y = PITCH_WIDTH.
        if (s.lateral > 0) {
          expect(up.y).toBeLessThan(PITCH_WIDTH / 2);
          expect(down.y).toBeGreaterThan(PITCH_WIDTH / 2);
        }
        // Each team defends its own half.
        expect(up.x).toBeLessThan(PITCH_LENGTH / 2);
        expect(down.x).toBeGreaterThan(PITCH_LENGTH / 2);
      }
  });
});

describe("assignments", () => {
  it.each(FORMATION_IDS)("by default put every rostered player of the team in exactly one %s slot", (id) => {
    for (const team of teams) {
      const squad = squadOf(team.id);
      const a = defaultAssignments(id, squad);
      expect(Object.keys(a).sort()).toEqual(squad.map((p) => p.id).sort());
      expect(new Set(Object.values(a)).size).toBe(11);
      expect(assignmentErrors(id, a, squad, roster)).toEqual([]);
      const keeper = squad.find((p) => p.role === "GK")!;
      expect(a[keeper.id]).toBe("GK");
      // Deterministic.
      expect(defaultAssignments(id, squad)).toEqual(a);
    }
  });

  it("keep identity separate from position: the number 9 leads the line in every preset", () => {
    for (const id of FORMATION_IDS) {
      const a = defaultAssignments(id, squadOf(home.id));
      expect(formationSlot(id, a[`${home.id}-9`]!)!.position).toBe("ST");
    }
  });

  it("are validated", () => {
    const squad = squadOf(home.id);
    const good = defaultAssignments("4-4-2", squad);
    const errorsFor = (a: SlotAssignments) => assignmentErrors("4-4-2", a, squad, roster).join("\n");
    const { [`${home.id}-7`]: _dropped, ...missing } = good;
    expect(errorsFor(missing)).toMatch(/has no slot/);
    expect(errorsFor({ ...good, [`${home.id}-7`]: good[`${home.id}-8`]! })).toMatch(/assigned to both/);
    expect(errorsFor({ ...good, [`${home.id}-7`]: "LW" })).toMatch(/unknown 4-4-2 slot LW/);
    expect(errorsFor({ ...good, [`${away.id}-7`]: "RM" })).toMatch(/not on this team/);
    expect(errorsFor({ ...good, ghost: "RM" })).toMatch(/unknown player ghost/);
    expect(errorsFor({ ...good, [`${home.id}-1`]: "RM", [`${home.id}-7`]: "GK" })).toMatch(/goalkeeper/);
  });

  it("reshape to the nearest new slots on a change, keeping the goalkeeper in goal", () => {
    const squad = squadOf(home.id);
    const before = defaultAssignments("4-3-3", squad);
    const after = remapAssignments("4-3-3", before, "4-2-3-1", squad);
    expect(assignmentErrors("4-2-3-1", after, squad, roster)).toEqual([]);
    expect(after[`${home.id}-1`]).toBe("GK");
    // The back four are unchanged; the winger stays on their wing; the striker stays up front.
    for (const n of [2, 3, 4, 5]) expect(after[`${home.id}-${n}`]).toBe(before[`${home.id}-${n}`]);
    expect(after[`${home.id}-7`]).toBe("RW");
    expect(after[`${home.id}-9`]).toBe("ST");
  });

  it("reject custom assignments that are invalid, before simulating", () => {
    const a = defaultAssignments("4-4-2", squadOf(home.id));
    expect(() => generateMatch({ seed: 1, tactics: { home: { formation: "4-4-2", assignments: { ...a, [`${home.id}-9`]: "RM" } } } })).toThrow(
      /assigned to both/,
    );
    expect(() => generateMatch({ seed: 1, tactics: { home: { formation: "4-3-3", assignments: a } } })).toThrow(/unknown 4-3-3 slot/);
    expect(() => generateMatch({ seed: 1, tactics: { away: { formation: "5-4-1" as FormationId } } })).toThrow(/unknown formation/);
  });
});

describe("generated matches with formations", () => {
  const config: TacticsConfig = { home: { formation: "4-4-2" }, away: { formation: "4-3-3" } };
  const f = generateMatch({ seed: 5, durationMs: 60_000, tactics: config });

  it("start each team in its own formation, mirrored for the direction it attacks", () => {
    expect(validateFixture(f)).toEqual([]);
    expect(f.tactics!.initial.map((x) => [x.teamId, x.formation])).toEqual([
      [home.id, "4-4-2"],
      [away.id, "4-3-3"],
    ]);
    const kickoff = f.snapshots[0]!;
    const taker = f.startingState.possession!.playerId!;
    for (const p of kickoff.players) {
      if (p.playerId === taker) continue;
      const spot = baseOf(f, p.playerId, 0);
      // Opponents inside the centre circle have been moved back out of it.
      if (gap(spot, { x: PITCH_LENGTH / 2, y: PITCH_WIDTH / 2 }) >= RESTART_DISTANCE) expect(gap(p, spot)).toBeLessThan(0.75);
    }
  });

  it("is reproducible from seed and configuration, and the configuration is part of its identity", () => {
    expect(generateMatch({ seed: 5, durationMs: 60_000, tactics: config })).toEqual(f);
    expect(f.matchId).toBe(`sim-v${SIMULATOR_VERSION}-5-60000-${f.generator!.configKey}`);
    expect(f.generator).toEqual({ simulatorVersion: SIMULATOR_VERSION, seed: 5, configKey: expect.stringMatching(/^[0-9a-f]{8}$/) });
    const other = generateMatch({ seed: 5, durationMs: 60_000, tactics: { home: { formation: "4-3-3" }, away: { formation: "4-4-2" } } });
    expect(other.matchId).not.toBe(f.matchId);
    expect(other.snapshots).not.toEqual(f.snapshots);
    const changed = generateMatch({ seed: 5, durationMs: 60_000, tactics: { ...config, away: { formation: "4-3-3", changes: [{ t: 20_000, formation: "4-4-2" }] } } });
    expect(changed.matchId).not.toBe(f.matchId);
    // Spelling out the defaults is the same configuration.
    const explicit: TacticsConfig = {
      home: { formation: "4-4-2", assignments: defaultAssignments("4-4-2", squadOf(home.id)) },
      away: { formation: "4-3-3", changes: [] },
    };
    expect(generateMatch({ seed: 5, durationMs: 60_000, tactics: explicit })).toEqual(f);
    expect(generateMatch({ seed: 5, durationMs: 60_000 }).matchId).toBe(generateMatch({ seed: 5, durationMs: 60_000, tactics: {} }).matchId);
  });

  it("moves players by their position: full backs push on in attack, strikers stay highest", () => {
    // Average depth (towards the goal attacked) per position over the match, for the home team.
    const sign = home.attacksTowards === "increasing-x" ? 1 : -1;
    const depth = new Map<string, number[]>();
    for (const s of f.snapshots) {
      for (const p of s.players) {
        const a = f.tactics!.initial.find((x) => x.teamId === home.id)!.assignments[p.playerId];
        if (!a) continue;
        const list = depth.get(a) ?? [];
        list.push(sign > 0 ? p.x : PITCH_LENGTH - p.x);
        depth.set(a, list);
      }
    }
    const mean = (id: string) => depth.get(id)!.reduce((a, b) => a + b) / depth.get(id)!.length;
    expect(mean("RS")).toBeGreaterThan(mean("RCM"));
    expect(mean("RCM")).toBeGreaterThan(mean("RCB"));
    expect(mean("RCB")).toBeGreaterThan(mean("GK"));
    // Nobody follows an identical path: every outfield pair is apart most of the time.
    const ids = Object.keys(f.tactics!.initial[0]!.assignments);
    for (const s of f.snapshots.filter((_, i) => i % 50 === 0)) {
      const xs = new Set(s.players.filter((p) => ids.includes(p.playerId)).map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`));
      expect(xs.size).toBe(11);
    }
  });
});

describe("scheduled formation changes", () => {
  const T = 30_000;
  const config = (t: number): TacticsConfig => ({
    home: { formation: "4-4-2" },
    away: { formation: "4-3-3", changes: [{ t, formation: "4-2-3-1" }] },
  });
  const base = generateMatch({ seed: 11, durationMs: 60_000, tactics: { home: { formation: "4-4-2" }, away: { formation: "4-3-3" } } });
  const f = generateMatch({ seed: 11, durationMs: 60_000, tactics: config(T) });

  it("apply once, at exactly their timestamp, and are recorded", () => {
    expect(validateFixture(f)).toEqual([]);
    const changes = f.events.filter((e) => e.type === "formation-change");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ t: T, teamId: away.id, outcome: "applied" });
    expect(changes[0]!.description).toMatch(/4-3-3 to 4-2-3-1/);
    expect(f.tactics!.scheduled).toEqual([{ teamId: away.id, t: T, formation: "4-2-3-1", assignments: f.tactics!.applied[0]!.assignments }]);
    const [applied] = f.tactics!.applied;
    expect(applied).toMatchObject({ eventId: changes[0]!.id, teamId: away.id, t: T, from: "4-3-3", to: "4-2-3-1" });
    expect(applied!.previousAssignments).toEqual(f.tactics!.initial.find((x) => x.teamId === away.id)!.assignments);
    expect(assignmentErrors("4-2-3-1", applied!.assignments, squadOf(away.id), roster)).toEqual([]);
    // A snapshot marks the change, without cutting play.
    expect(snapshotAt(f, T).discontinuity).toBeUndefined();
  });

  it("change nothing before they happen, and the same player IDs carry on", () => {
    expect(f.snapshots.filter((s) => s.t < T)).toEqual(base.snapshots.filter((s) => s.t < T));
    expect(f.events.filter((e) => e.t < T)).toEqual(base.events.filter((e) => e.t < T));
    expect(f.roster).toEqual(base.roster);
    for (const s of f.snapshots) expect(s.players.map((p) => p.playerId)).toEqual(roster.map((p) => p.id));
  });

  it("move players to their new positions within the speed limit, without teleporting", () => {
    const i = f.snapshots.findIndex((s) => s.t === T);
    for (let k = i; k < f.snapshots.length; k++) {
      const [a, b] = [f.snapshots[k - 1]!, f.snapshots[k]!];
      if (b.discontinuity) continue;
      for (const p of b.players) {
        const q = a.players.find((x) => x.playerId === p.playerId)!;
        expect(gap(p, q) / ((b.t - a.t) / 1000)).toBeLessThanOrEqual(MAX_PLAYER_SPEED + 1e-8);
      }
    }
  });

  it("leave the ball, possession and a kick in flight alone", () => {
    // A pass in flight in the unchanged match; change formation half way through it.
    const pass = base.events.find((e) => e.type === "pass" && e.startT! > 5_000 && e.t - e.startT! >= 300)!;
    const mid = Math.round((pass.startT! + pass.t) / 2 / 100) * 100;
    for (const side of ["home", "away"] as const) {
      const g = generateMatch({
        seed: 11,
        durationMs: 60_000,
        tactics: {
          home: { formation: "4-4-2", ...(side === "home" ? { changes: [{ t: mid, formation: "4-3-3" as const }] } : {}) },
          away: { formation: "4-3-3", ...(side === "away" ? { changes: [{ t: mid, formation: "4-4-2" as const }] } : {}) },
        },
      });
      const at = snapshotAt(g, mid);
      const was = snapshotAt(base, mid);
      expect(at.ball).toEqual(was.ball);
      expect(at.possession).toEqual(was.possession);
      expect(at.possession).toBeNull();
      // The same kick still resolves: the next kick result is the one struck at pass.startT.
      const next = g.events.find((e) => e.t >= mid && e.type !== "formation-change")!;
      expect(next.startT).toBe(pass.startT);
    }
  });

  it("process changes at the same time in a fixed order: home first", () => {
    const g = generateMatch({
      seed: 3,
      durationMs: 30_000,
      tactics: { away: { changes: [{ t: 10_000, formation: "4-4-2" }] }, home: { changes: [{ t: 10_000, formation: "4-2-3-1" }] } },
    });
    expect(g.events.filter((e) => e.type === "formation-change").map((e) => [e.t, e.teamId])).toEqual([
      [10_000, home.id],
      [10_000, away.id],
    ]);
    expect(g.tactics!.applied.map((c) => c.teamId)).toEqual([home.id, away.id]);
    expect(validateFixture(g)).toEqual([]);
  });

  it("chain several changes for one team, each from the formation before it", () => {
    const g = generateMatch({
      seed: 9,
      durationMs: 60_000,
      tactics: { home: { changes: [{ t: 40_000, formation: "4-3-3" }, { t: 15_000, formation: "4-4-2" }] } },
    });
    expect(g.tactics!.applied.map((c) => [c.t, c.from, c.to])).toEqual([
      [15_000, "4-3-3", "4-4-2"],
      [40_000, "4-4-2", "4-3-3"],
    ]);
  });

  it("reject times outside the match, off the simulation step, or twice at once", () => {
    const at = (t: number) => () => generateMatch({ seed: 1, durationMs: 30_000, tactics: { home: { changes: [{ t, formation: "4-4-2" }] } } });
    for (const t of [0, -20, 30_000, 30_020, 1e9, NaN]) expect(at(t), String(t)).toThrow(/time must be/);
    expect(at(1_010)).toThrow(/multiple of 20/);
    expect(() =>
      generateMatch({ seed: 1, durationMs: 30_000, tactics: { home: { changes: [{ t: 1_000, formation: "4-4-2" }, { t: 1_000, formation: "4-3-3" }] } } }),
    ).toThrow(/only once/);
    expect(at(29_980)).not.toThrow();
  });

  it("during a stoppage, take effect for the restart: a goal kick lines up in the new shape", () => {
    // The first goal kick in an unchanged match; change the kicking team's formation during the dead ball before it.
    const seeds = Array.from({ length: 12 }, (_, i) => i);
    let checked = 0;
    for (const seed of seeds) {
      const plain = generateMatch({ seed, durationMs: 120_000 });
      const gk = plain.events.find((e) => e.type === "goal-kick");
      if (!gk) continue;
      const side = plain.teams.find((t) => t.id === gk.teamId)!.side;
      const t = gk.t - 1_000;
      const g = generateMatch({ seed, durationMs: 120_000, tactics: { [side]: { changes: [{ t, formation: "4-4-2" }] } } });
      const restart = g.events.find((e) => e.type === "goal-kick")!;
      // Same restart at the same time, taken by the same goalkeeper.
      expect([restart.t, restart.teamId, restart.playerId]).toEqual([gk.t, gk.teamId, gk.playerId]);
      const s = snapshotAt(g, restart.t);
      expect(s.discontinuity).toBe(true);
      for (const p of s.players) {
        if (p.playerId === restart.playerId) continue;
        expect(gap(p, baseOf(g, p.playerId, restart.t))).toBeLessThan(0.75);
      }
      // ...and the shape it lines up in is the new one.
      expect(formationsAt(g, restart.t)!.find((x) => x.teamId === gk.teamId)!.formation).toBe("4-4-2");
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
  });
});

describe("restart positioning with every formation", () => {
  const pairs = FORMATION_IDS.flatMap((h) => FORMATION_IDS.map((a) => [h, a] as const));
  const matches = pairs.map(([h, a], i) =>
    generateMatch({
      seed: 100 + i,
      durationMs: 120_000,
      tactics: { home: { formation: h }, away: { formation: a, changes: [{ t: 60_000, formation: h }] } },
    }),
  );

  it("lines teams up for kickoffs and goal kicks in their current formation", () => {
    let kickoffs = 0;
    for (const f of matches) {
      expect(validateFixture(f)).toEqual([]);
      const restarts = [{ t: 0, type: "kickoff", teamId: f.startingState.possession!.teamId, playerId: f.startingState.possession!.playerId! }, ...f.events.filter((e) => e.type === "kickoff" || e.type === "goal-kick")];
      for (const r of restarts) {
        const s = snapshotAt(f, r.t);
        const centre = { x: PITCH_LENGTH / 2, y: PITCH_WIDTH / 2 };
        for (const p of s.players) {
          const teamId = roster.find((q) => q.id === p.playerId)!.teamId;
          const up = sideOf(f, teamId).attacksTowards === "increasing-x";
          if (r.type === "kickoff") {
            kickoffs++;
            // Everyone in their own half; opponents outside the centre circle.
            expect(up ? p.x <= centre.x : p.x >= centre.x).toBe(true);
            if (teamId !== r.teamId) expect(gap(p, centre)).toBeGreaterThan(RESTART_DISTANCE - 0.75);
          }
          if (teamId === r.teamId && p.playerId !== r.playerId) expect(gap(p, baseOf(f, p.playerId, r.t))).toBeLessThan(0.75);
        }
      }
    }
    expect(kickoffs).toBeGreaterThan(0);
  });

  it("gives the kickoff and penalties to the player in the striker's slot", () => {
    for (const f of matches)
      for (const e of f.events.filter((x) => x.type === "kickoff" || x.type === "penalty")) {
        const active = formationsAt(f, e.t)!.find((x) => x.teamId === e.teamId)!;
        const slot = formationSlot(active.formation, active.assignments[e.playerId!]!)!;
        expect(slot.position).toBe("ST");
      }
  });

  it("keeps free kicks, corners and throw-ins legal after a change", () => {
    let checked = 0;
    for (const f of matches)
      for (const e of f.events.filter((x) => x.t > 60_000 && (x.type === "free-kick" || x.type === "corner"))) {
        const s = snapshotAt(f, e.t);
        for (const p of s.players)
          if (roster.find((q) => q.id === p.playerId)!.teamId !== e.teamId) expect(gap(p, s.ball)).toBeGreaterThan(RESTART_DISTANCE - 0.75);
        checked++;
      }
    for (const f of matches)
      for (const e of f.events.filter((x) => x.type === "throw-in")) {
        const s = snapshotAt(f, e.t);
        const thrower = s.players.find((p) => p.playerId === e.playerId)!;
        expect(thrower.y === 0 || thrower.y === PITCH_WIDTH).toBe(true);
        checked++;
      }
    expect(checked).toBeGreaterThan(5);
  });
});

describe("playback of formations", () => {
  const T = 20_000;
  const f = generateMatch({ seed: 21, durationMs: 60_000, tactics: { home: { formation: "4-4-2" }, away: { formation: "4-3-3", changes: [{ t: T, formation: "4-2-3-1" }] } } });
  const awayShape = (t: number) => formationsAt(f, t)!.find((x) => x.teamId === away.id)!;

  it("shows the formation active at the playback time, never a future one", () => {
    expect(awayShape(0)).toMatchObject({ formation: "4-3-3", since: 0 });
    expect(awayShape(T - 1)).toMatchObject({ formation: "4-3-3", since: 0 });
    expect(awayShape(T)).toMatchObject({ formation: "4-2-3-1", since: T });
    expect(awayShape(f.durationMs).formation).toBe("4-2-3-1");
    expect(formationsAt(f, T - 1)!.find((x) => x.teamId === home.id)!.formation).toBe("4-4-2");
    expect(frameAt(f, T).formations).toEqual(formationsAt(f, T));
  });

  it("restores the earlier formation when seeking back, and the initial one on restart", () => {
    const engine = new PlaybackEngine(f);
    engine.play();
    engine.advance(f.durationMs);
    expect(engine.frame().formations!.find((x) => x.teamId === away.id)!.formation).toBe("4-2-3-1");
    engine.seek(T - 100);
    expect(engine.frame().formations!.find((x) => x.teamId === away.id)!.formation).toBe("4-3-3");
    expect(engine.frame().events.some((e) => e.type === "formation-change")).toBe(false);
    engine.seek(T);
    expect(engine.frame().events.filter((e) => e.type === "formation-change")).toHaveLength(1);
    engine.restart();
    expect(engine.frame().formations).toEqual(formationsAt(f, 0));
    expect(engine.frame().formations!.map((x) => x.formation)).toEqual(["4-4-2", "4-3-3"]);
  });

  it("renders each team's active formation and lists the change in the event feed only once reached", () => {
    const render = (t: number) => renderToStaticMarkup(<Formations teams={f.teams} roster={f.roster} formations={formationsAt(f, t)} />);
    expect(render(T - 20)).toContain(">4-3-3<");
    expect(render(T - 20)).not.toContain("4-2-3-1");
    expect(render(T)).toContain(">4-2-3-1<");
    expect(render(T)).toContain("Since 0:20");
    // The score bug shows both shapes at the current time.
    expect(renderToStaticMarkup(<MatchViewer fixture={f} />)).toContain("Shape <b>4-4-2</b> v <b>4-3-3</b>");
  });

  it("supports the scripted demo and older fixtures without formation data", () => {
    expect(validateFixture(sampleFixture)).toEqual([]);
    expect(formationsAt(sampleFixture, 5_000)).toBeNull();
    expect(frameAt(sampleFixture, 5_000).formations).toBeNull();
    const html = renderToStaticMarkup(<MatchViewer fixture={sampleFixture} />);
    expect(html).toContain("Live feed");
    expect(html).not.toContain("Shape <b>");
    // A 1.2.0 fixture as the previous simulator wrote it.
    const { tactics: _t, generator: _g, ...rest } = f;
    const old: MatchFixture = { ...rest, schemaVersion: "1.2.0", events: f.events.filter((e) => e.type !== "formation-change") };
    expect(validateFixture(old)).toEqual([]);
    expect(formationsAt(old, 30_000)).toBeNull();
  });

  it("rejects inconsistent formation metadata", () => {
    const tactics = f.tactics!;
    const broken = (patch: Partial<MatchFixture>) => validateFixture({ ...f, ...patch }).join("\n");
    expect(broken({ tactics: { ...tactics, initial: tactics.initial.slice(0, 1) } })).toMatch(/exactly one starting formation/);
    expect(broken({ tactics: { ...tactics, applied: [{ ...tactics.applied[0]!, from: "4-4-2" }] } })).toMatch(/previous formation/);
    expect(broken({ tactics: { ...tactics, applied: [{ ...tactics.applied[0]!, t: T + 20 }] } })).toMatch(/does not match/);
    expect(broken({ tactics: { ...tactics, applied: [] } })).toMatch(/formation-change event/);
    const a = tactics.initial[0]!;
    expect(broken({ tactics: { ...tactics, initial: [{ ...a, assignments: { ...a.assignments, [`${home.id}-9`]: "LS", [`${home.id}-10`]: "LS" } }, tactics.initial[1]!] } })).toMatch(
      /assigned to both/,
    );
    const { tactics: _t, ...noTactics } = f;
    expect(validateFixture(noTactics as MatchFixture).join("\n")).toMatch(/require tactics metadata/);
  });
});

describe("generator controls", () => {
  const controls = (home: string, away = "") => ({
    home: { formation: "4-4-2" as const, changeAt: home, changeTo: "4-2-3-1" as const },
    away: { formation: "4-3-3" as const, changeAt: away, changeTo: "4-4-2" as const },
  });

  it("build independent formations and optional changes", () => {
    expect(tacticsFromControls(controls(""), 60)).toEqual({ home: { formation: "4-4-2" }, away: { formation: "4-3-3" } });
    expect(tacticsFromControls(controls("30", "12.5"), 60)).toEqual({
      home: { formation: "4-4-2", changes: [{ t: 30_000, formation: "4-2-3-1" }] },
      away: { formation: "4-3-3", changes: [{ t: 12_500, formation: "4-4-2" }] },
    });
  });

  it("reject change times outside the selected duration", () => {
    for (const bad of ["0", "60", "61", "-5", "abc", "1.25"]) expect(() => tacticsFromControls(controls(bad), 60), bad).toThrow();
    expect(() => tacticsFromControls(controls("59.9"), 60)).not.toThrow();
    expect(() => tacticsFromControls(controls("45"), 30)).toThrow(/between 0 and 30/);
  });
});
