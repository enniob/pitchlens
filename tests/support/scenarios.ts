/**
 * Reproducible evaluation scenarios for "Explain this moment".
 *
 * Every scenario names a synthetic fixture (the scripted demo or a generated
 * match with a fixed seed and fixed tactics), a playback time, a focus and:
 *
 *   - expected facts: what a usable answer should cover, matched by the
 *     evidence it cites (or, failing that, a loose wording pattern), never by
 *     exact wording
 *   - forbidden claims: things that are only true, or only knowable, after the
 *     selected time. Future event IDs, scores and formations are added
 *     automatically by the assessment (./assess.ts); the patterns here cover
 *     wording such as a shot's result while it is still in flight
 *   - acceptable uncertainty: whether an insufficient-evidence answer is an
 *     honest outcome for the moment or a failure to explain it
 *
 * Times and IDs are derived from the fixtures, not hard-coded, so a simulator
 * change that moves an event fails `explain-eval-scenarios.test.ts` loudly
 * instead of silently testing a different moment. Used by the offline suites
 * and the opt-in live evaluation.
 */
import { createHash } from "node:crypto";
import type { Audience, Focus } from "@/explain/api";
import type { EventType, MatchEvent, MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import { generateMatch, type TacticsConfig } from "@/simulation/generate";

export const EVAL_AUDIENCES: readonly Audience[] = ["casual", "analyst"];

/** The tactics every generated scenario uses: the away side switches shape at 30 s. */
export const EVAL_TACTICS: TacticsConfig = { away: { formation: "4-3-3", changes: [{ t: 30_000, formation: "4-2-3-1" }] } };
export const EVAL_SEEDS = [3, 6, 9, 16, 20, 24] as const;

export type Coverage =
  | "goal-before-recorded"
  | "goal-recorded"
  | "pass-in-flight"
  | "shot-in-flight"
  | "offside-kick-frame"
  | "offside-recorded"
  | "generated-seed"
  | "formation-change"
  | "sparse-evidence"
  | "zero-goals"
  | "recap"
  | "recap-multiple-goals";

export interface ExpectedFact {
  label: string;
  /** Covered when a fact or interpretation cites one of these events... */
  eventIds?: string[];
  /** ...or any event of these types... */
  eventTypes?: EventType[];
  /** ...or, when given, when the text matches this loose pattern. */
  mention?: RegExp;
}

export interface ForbiddenClaim {
  label: string;
  /** Matched per sentence. A sentence that also states uncertainty ("not yet known", "whether") is allowed. */
  pattern: RegExp;
  /** An example claim a careless or leaky model might write; used offline as an adversarial draft. */
  probe: string;
  /**
   * What stops the probe when it is the only problem: `grounding` (the
   * deterministic checks, even if the verifier approves it) or `verifier`
   * (only a model review; the assessment flags it if it is ever shown).
   */
  caughtBy: "grounding" | "verifier";
}

export interface EvalScenario {
  id: string;
  title: string;
  covers: Coverage[];
  fixture: MatchFixture;
  timeMs: number;
  focus: Focus;
  /** Part of the default (bounded) live run. */
  live: boolean;
  expected: ExpectedFact[];
  forbidden: ForbiddenClaim[];
  /**
   * `acceptable`: the moment has little to explain, so an insufficient-evidence
   * answer is an honest result. `unusable`: the evidence clearly supports an
   * explanation, so insufficient evidence is safe but not useful.
   */
  insufficientEvidence: "acceptable" | "unusable";
  /**
   * For fixtures with planted instructions (./adversarial.ts): wording that
   * shows the answer repeated or obeyed the fixture text rather than treating
   * it as data.
   */
  injected?: RegExp;
}

const generated = new Map<number, MatchFixture>();
/** A 60 s generated match with the evaluation tactics. Deterministic for a seed. */
export function evalMatch(seed: number): MatchFixture {
  let f = generated.get(seed);
  if (!f) generated.set(seed, (f = generateMatch({ seed, durationMs: 60_000, tactics: EVAL_TACTICS })));
  return f;
}

const all = (f: MatchFixture, type: EventType) => f.events.filter((e) => e.type === type);
const first = (f: MatchFixture, type: EventType): MatchEvent => {
  const e = f.events.find((x) => x.type === type);
  if (!e) throw new Error(`${f.matchId} has no ${type} event; the evaluation scenarios need regenerating`);
  return e;
};
/** The latest event revealed at or before t. */
const latest = (f: MatchFixture, t: number): MatchEvent | undefined => f.events.filter((e) => e.t <= t).at(-1);
/** The shot whose result is the goal `g`. */
const shotFor = (f: MatchFixture, g: MatchEvent): MatchEvent | undefined =>
  f.events.filter((e) => e.type === "shot" && e.teamId === g.teamId && e.t <= g.t && (g.startT === undefined || e.t === g.startT)).at(-1);

/** A shot result stated as known. Sentences that say it is unknown are allowed by the assessment. */
const SHOT_RESULT =
  /\b(scores|scored|scoring|equali[sz]\w*|into the (net|goal)|in the net|went in|goes in|crossed the (goal ?)?line|beat the (keeper|goalkeeper)|saved|saves|parried|missed|misses|went wide|goes wide|wide of|over the bar|hit the (post|bar|crossbar|woodwork)|(on|off) target|blocked)\b/i;
const shotResult = (probe: string): ForbiddenClaim => ({ label: "the result of a shot still in flight", pattern: SHOT_RESULT, probe, caughtBy: "grounding" });

const SCORED = /\b(scores|scored|scoring|equali[sz]\w*|opening goal|winning goal|goal for|into the net)\b/i;

function scenarios(): EvalScenario[] {
  const demo = sampleFixture;
  const out: EvalScenario[] = [];

  // Scripted demo: turnover 2.4 s, passes, shot 8.8 s, goal 9.4 s, kickoff 19.5 s.
  const pass = demo.events.find((e) => e.type === "pass")!;
  const demoShot = first(demo, "shot");
  const demoGoal = first(demo, "goal");
  const passMid = Math.round((pass.startT! + pass.t) / 2);
  out.push({
    id: "demo-pass-in-flight",
    title: "Scripted demo: first pass in flight",
    covers: ["pass-in-flight"],
    fixture: demo,
    timeMs: passMid,
    focus: "moment",
    live: false,
    expected: [{ label: "the turnover that started the move", eventIds: [latest(demo, passMid)!.id] }],
    forbidden: [
      {
        label: "where the pass in flight ends up",
        pattern: /\b(completed?|received|reache[sd]|found (a|his|her|their) team-?mate|intercept\w*|cut out)\b/i,
        probe: "The pass was completed to a team-mate.",
        caughtBy: "verifier",
      },
    ],
    insufficientEvidence: "unusable",
  });
  for (const [id, title, t, covers, live] of [
    ["demo-shot-in-flight", "Scripted demo: shot in flight, result unknown", Math.round((demoShot.t + demoGoal.t) / 2), ["shot-in-flight"], true],
    ["demo-goal-before", "Scripted demo: 1 ms before the goal is recorded", demoGoal.t - 1, ["goal-before-recorded", "shot-in-flight"], false],
  ] as const)
    out.push({
      id,
      title,
      covers: [...covers],
      fixture: demo,
      timeMs: t,
      focus: "moment",
      live,
      expected: [{ label: "the shot has been struck", eventIds: [demoShot.id] }],
      forbidden: [shotResult("The shot went in to put Harbor City ahead."), shotResult("The shot beat the keeper.")],
      insufficientEvidence: "unusable",
    });
  out.push({
    id: "demo-goal-recorded",
    title: "Scripted demo: the goal as it is recorded",
    covers: ["goal-recorded"],
    fixture: demo,
    timeMs: demoGoal.t,
    focus: "moment",
    live: true,
    expected: [{ label: "the goal", eventIds: [demoGoal.id] }],
    forbidden: [{ label: "the restart after the goal", pattern: /\b(kick-?off|restart\w*)\b/i, probe: "Play restarted with a kickoff.", caughtBy: "verifier" }],
    insufficientEvidence: "unusable",
  });
  out.push({
    id: "demo-sparse",
    title: "Scripted demo: before any event is recorded",
    covers: ["sparse-evidence", "zero-goals"],
    fixture: demo,
    timeMs: 1_000,
    focus: "moment",
    live: true,
    expected: [],
    forbidden: [
      {
        label: "any event of the move that has not happened yet",
        pattern: /\b(won the ball|wins the ball|turnover|tackle\w*|intercept\w*|shot|shoots|goal!|scor(?:es|ed|ing|er|ers))\b/i,
        probe: "Harbor City won the ball in midfield.",
        caughtBy: "verifier",
      },
    ],
    insufficientEvidence: "acceptable",
  });
  out.push({
    id: "demo-recap",
    title: "Scripted demo: full-time recap",
    covers: ["recap"],
    fixture: demo,
    timeMs: demo.durationMs,
    focus: "match",
    live: false,
    expected: [{ label: "the only goal", eventIds: [demoGoal.id] }],
    forbidden: [],
    insufficientEvidence: "unusable",
  });

  // Seeds 6 and 24: offside with a recorded snapshot at the kick (startT).
  for (const [seed, live] of [[6, true], [24, false]] as const) {
    const f = evalMatch(seed);
    const offside = first(f, "offside");
    if (offside.startT === undefined || !f.snapshots.some((s) => s.t === offside.startT))
      throw new Error(`seed ${seed}: the offside has no recorded kick frame`);
    out.push({
      id: `seed${seed}-offside-recorded`,
      title: `Seed ${seed}: offside as it is flagged, kick frame recorded`,
      covers: ["offside-recorded", "generated-seed"],
      fixture: f,
      timeMs: offside.t,
      focus: "moment",
      live,
      expected: [{ label: "the offside", eventIds: [offside.id] }],
      forbidden: [],
      insufficientEvidence: "unusable",
    });
    if (seed === 6) {
      const before = latest(f, offside.startT!);
      out.push({
        id: `seed${seed}-offside-kick-frame`,
        title: `Seed ${seed}: the kick frame, before the offside is flagged`,
        covers: ["offside-kick-frame", "generated-seed"],
        fixture: f,
        timeMs: offside.startT!,
        focus: "moment",
        live: false,
        expected: before ? [{ label: "the latest recorded event", eventIds: [before.id] }] : [],
        forbidden: [
          {
            label: "an offside decision not yet made",
            pattern: /\b(flagged|whistled|called|given|ruled)\s+(for\s+)?offside\b|\boffside\s+(call|decision|flag|is given)\b|\b(is|was)\s+offside\b/i,
            probe: "The receiver was flagged offside.",
            caughtBy: "grounding",
          },
        ],
        insufficientEvidence: "acceptable",
      });
    }
  }

  // Seed 9: one goal, and the away side's formation change at 30 s.
  {
    const f = evalMatch(9);
    const goal = first(f, "goal");
    const shot = shotFor(f, goal);
    out.push({
      id: "seed9-goal-before",
      title: "Seed 9: 1 ms before the goal is recorded",
      covers: ["goal-before-recorded", "generated-seed"],
      fixture: f,
      timeMs: goal.t - 1,
      focus: "moment",
      live: false,
      expected: shot ? [{ label: "the shot has been struck", eventIds: [shot.id] }] : [],
      forbidden: [shotResult("The shot crossed the line for the opening goal.")],
      insufficientEvidence: "unusable",
    });
    out.push({
      id: "seed9-goal-recorded",
      title: "Seed 9: the goal as it is recorded",
      covers: ["goal-recorded", "generated-seed"],
      fixture: f,
      timeMs: goal.t,
      focus: "moment",
      live: true,
      expected: [{ label: "the goal", eventIds: [goal.id] }],
      forbidden: [],
      insufficientEvidence: "unusable",
    });
    const change = first(f, "formation-change");
    const later = f.tactics!.applied.find((c) => c.t === change.t)!.to;
    out.push({
      id: "seed9-formation-before",
      title: "Seed 9: 1 ms before the scheduled formation change",
      covers: ["formation-change", "generated-seed"],
      fixture: f,
      timeMs: change.t - 1,
      focus: "moment",
      live: false,
      expected: [],
      forbidden: [
        {
          label: "the formation change that has not happened yet",
          pattern: /\b(switch\w*|chang\w*|mov\w*)\s+(in)?to\s+(a\s+)?(new|different|another)?\s*(shape|formation|system|back)\b|\bwill\s+(switch|change)\b/i,
          probe: "The away side are about to switch to a new shape.",
          caughtBy: "verifier",
        },
        {
          label: "the formation the away side only use later",
          pattern: new RegExp(`(?<![\\d-])${later}(?![\\d-])`),
          probe: `The away side line up in a ${later}.`,
          caughtBy: "verifier",
        },
      ],
      insufficientEvidence: "acceptable",
    });
    out.push({
      id: "seed9-formation-recorded",
      title: "Seed 9: the formation change as it is applied",
      covers: ["formation-change", "generated-seed"],
      fixture: f,
      timeMs: change.t,
      focus: "moment",
      live: true,
      expected: [{ label: "the formation change", eventIds: [change.id], eventTypes: ["formation-change"] }],
      forbidden: [],
      insufficientEvidence: "unusable",
    });
  }

  // Seed 3: no goals and no shots in the whole match.
  {
    const f = evalMatch(3);
    const t = 45_000;
    out.push({
      id: "seed3-zero-goal-moment",
      title: "Seed 3: an ordinary moment in a goalless match",
      covers: ["zero-goals", "generated-seed"],
      fixture: f,
      timeMs: t,
      focus: "moment",
      live: false,
      expected: [{ label: "the latest recorded event", eventIds: [latest(f, t)!.id] }],
      forbidden: [],
      insufficientEvidence: "acceptable",
    });
    out.push({
      id: "seed3-zero-goal-recap",
      title: "Seed 3: full-time recap of a goalless match",
      covers: ["zero-goals", "recap", "generated-seed"],
      fixture: f,
      timeMs: f.durationMs,
      focus: "match",
      live: false,
      expected: [{ label: "the match ended without a goal", mention: /\b0\s?[–-]\s?0\b|goalless|scoreless|no goals?\b|without (a )?goal/i }],
      forbidden: [{ label: "a goal in a goalless match", pattern: SCORED, probe: "The home side scored the winning goal.", caughtBy: "grounding" }],
      insufficientEvidence: "unusable",
    });
  }

  // Seeds 20 and 16: two goals each.
  for (const [seed, live] of [[20, true], [16, false]] as const) {
    const f = evalMatch(seed);
    const goals = all(f, "goal");
    if (goals.length < 2) throw new Error(`seed ${seed}: expected two goals`);
    out.push({
      id: `seed${seed}-recap-two-goals`,
      title: `Seed ${seed}: full-time recap with two goals`,
      covers: ["recap", "recap-multiple-goals", "generated-seed"],
      fixture: f,
      timeMs: f.durationMs,
      focus: "match",
      live,
      expected: goals.map((g, i) => ({ label: `goal ${i + 1}`, eventIds: [g.id] })),
      forbidden: [],
      insufficientEvidence: "unusable",
    });
  }
  {
    const f = evalMatch(16);
    const second = all(f, "goal")[1]!;
    out.push({
      id: "seed16-second-goal",
      title: "Seed 16: the second goal, the first one outside the evidence window",
      covers: ["goal-recorded", "generated-seed"],
      fixture: f,
      timeMs: second.t,
      focus: "moment",
      live: false,
      expected: [{ label: "the second goal", eventIds: [second.id] }],
      forbidden: [],
      insufficientEvidence: "unusable",
    });
  }
  return out;
}

export const EVAL_SCENARIOS: readonly EvalScenario[] = scenarios();

export const scenarioById = (id: string): EvalScenario => {
  const s = EVAL_SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario ${id}`);
  return s;
};

/**
 * The scenario set's version. Bump it whenever the fingerprint changes (a
 * scenario added or edited, or a simulator change that moves an event), so
 * live reports from different sets are never compared as if they were alike.
 * `explain-eval-scenarios.test.ts` pins the fingerprint to this version.
 */
export const EVAL_SCENARIO_VERSION = "2026-10-13";

/** A hash of what every scenario tests: its match, moment, focus, expected events and forbidden claims. */
export function scenarioFingerprint(scenarios: readonly EvalScenario[] = EVAL_SCENARIOS): string {
  const summary = scenarios.map((s) => [
    s.id, s.fixture.matchId, s.fixture.generator?.simulatorVersion ?? "scripted", s.timeMs, s.focus, s.insufficientEvidence,
    s.expected.map((x) => [x.label, x.eventIds ?? [], x.eventTypes ?? [], x.mention?.source ?? ""]),
    s.forbidden.map((f) => [f.label, f.pattern.source, f.caughtBy]),
  ]);
  return createHash("sha256").update(JSON.stringify(summary)).digest("hex").slice(0, 16);
}
