import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LiveFeed } from "@/components/LiveFeed";
import { MomentBanner } from "@/components/MomentBanner";
import { ScoreBug, TacticsNumbers } from "@/components/ScoreBug";
import { SetupDrawer } from "@/components/SetupDrawer";
import {
  changeTimeError,
  controlsOf,
  DEFAULT_DRAFT,
  draftFromFixture,
  sameSetup,
  setupErrors,
  tacticsFromControls,
  type SetupDraft,
} from "@/components/setup";
import { PITCH_LENGTH, type MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import { formationsAt, frameAt } from "@/playback/derive";
import {
  activeBanner,
  BANNER_MS,
  FEED_MAX,
  FEED_WINDOW_MS,
  isKeyEvent,
  liveFeed,
  nextMomentTime,
  previousMomentTime,
  timelineMoments,
} from "@/playback/moments";
import { pitchZone, proChips, proStatisticsAt } from "@/playback/proData";
import { statisticsAt } from "@/playback/statistics";
import { generateMatch } from "@/simulation/generate";

// Seed 46 with these tactics has two goals, two fouls and a formation change at 0:30.
const f = generateMatch({
  seed: 46,
  durationMs: 60_000,
  tactics: { home: { formation: "4-4-2" }, away: { formation: "4-3-3", changes: [{ t: 30_000, formation: "4-2-3-1" }] } },
});
const fixtures: [string, MatchFixture][] = [
  ["scripted demo", sampleFixture],
  ["generated", f],
];
const goal = f.events.find((e) => e.type === "goal")!;
const change = f.events.find((e) => e.type === "formation-change")!;
const foul = f.events.find((e) => e.type === "foul")!;
const probes = (fx: MatchFixture) => Array.from({ length: 61 }, (_, i) => (fx.durationMs * i) / 60);

describe.each(fixtures)("moments never show the future: %s", (_name, fx) => {
  it("timeline markers, pop-ups and the feed only use events already reached", () => {
    for (const t of probes(fx)) {
      for (const e of timelineMoments(fx, t)) expect(e.t).toBeLessThanOrEqual(t);
      const banner = activeBanner(fx, t);
      if (banner) expect(banner.event.t).toBeLessThanOrEqual(t);
      for (const pro of [false, true]) for (const e of liveFeed(fx, t, pro)) expect(e.t).toBeLessThanOrEqual(t);
      for (const e of fx.events) if (e.t <= t) for (const c of proChips(fx, e)) expect(c).not.toMatch(/NaN|undefined/);
    }
  });

  it("previous and next moment step between key events only", () => {
    const keys = fx.events.filter(isKeyEvent).map((e) => e.t);
    let t = 0;
    const visited: number[] = [];
    for (let next = nextMomentTime(fx, t); next !== null; next = nextMomentTime(fx, t)) {
      visited.push(next);
      t = next;
    }
    expect(visited).toEqual([...new Set(keys.filter((k) => k > 0))]);
    for (let prev = previousMomentTime(fx, t); prev !== null; prev = previousMomentTime(fx, t)) {
      expect(prev).toBeLessThan(t);
      t = prev;
    }
    expect(previousMomentTime(fx, keys[0]!)).toBeNull();
  });
});

describe("moment pop-ups", () => {
  it("show a goal for five seconds, then nothing", () => {
    expect(activeBanner(f, goal.t - 1)?.event.id).not.toBe(goal.id);
    expect(activeBanner(f, goal.t)).toEqual({ event: goal, kind: "goal" });
    expect(activeBanner(f, goal.t + BANNER_MS.goal - 1)?.event.id).toBe(goal.id);
    expect(activeBanner(f, goal.t + BANNER_MS.goal)?.event.id).not.toBe(goal.id);
  });

  it("show a tactical change for six seconds and a foul for 2.5", () => {
    expect(activeBanner(f, change.t + 5_900)).toEqual({ event: change, kind: "tactic" });
    expect(activeBanner(f, foul.t)).toEqual({ event: foul, kind: "stop" });
    expect(activeBanner(f, foul.t + BANNER_MS.stop)?.event.id).not.toBe(foul.id);
  });

  it("render as broadcast graphics with the score and the shape change", () => {
    const score = frameAt(f, goal.t).score;
    const goalHtml = renderToStaticMarkup(<MomentBanner fixture={f} event={goal} kind="goal" score={score} />);
    expect(goalHtml).toContain("GOAL");
    expect(goalHtml).toContain(`HCF ${score.home} – ${score.away} NVR`);
    const tacticHtml = renderToStaticMarkup(<MomentBanner fixture={f} event={change} kind="tactic" score={score} />);
    expect(tacticHtml).toContain("TACTICAL CHANGE");
    expect(tacticHtml).toContain("Northvale Rovers · 4-3-3 → 4-2-3-1");
    expect(tacticHtml).toContain('role="status"');
  });
});

describe("live feed", () => {
  it("keeps the simple feed to three recent key moments, newest first", () => {
    for (const t of probes(f)) {
      const feed = liveFeed(f, t, false);
      expect(feed.length).toBeLessThanOrEqual(FEED_MAX.simple);
      for (const e of feed) {
        expect(isKeyEvent(e)).toBe(true);
        expect(t - e.t).toBeLessThanOrEqual(FEED_WINDOW_MS.simple);
      }
      for (let i = 1; i < feed.length; i++) expect(feed[i]!.t).toBeLessThanOrEqual(feed[i - 1]!.t);
    }
  });

  it("adds every touch with Pro data, up to five from the last 20 seconds", () => {
    let sawPass = false;
    for (const t of probes(f)) {
      const feed = liveFeed(f, t, true);
      expect(feed.length).toBeLessThanOrEqual(FEED_MAX.pro);
      for (const e of feed) expect(t - e.t).toBeLessThanOrEqual(FEED_WINDOW_MS.pro);
      sawPass ||= feed.some((e) => e.type === "pass");
    }
    expect(sawPass).toBe(true);
  });

  it("shows the feed with data chips only with Tactics on; otherwise it stays a hidden live region", () => {
    const events = liveFeed(f, goal.t, true);
    const simple = renderToStaticMarkup(<LiveFeed fixture={f} events={liveFeed(f, goal.t, false)} pro={false} />);
    const pro = renderToStaticMarkup(<LiveFeed fixture={f} events={events} pro />);
    expect(simple).not.toContain('class="chip"');
    expect(pro).toContain('class="chip"');
    // Tactics off: visually hidden, but key moments are still announced to screen readers.
    expect(simple).toMatch(/class="feed[^"]*visually-hidden"/);
    expect(simple).toContain('aria-live="polite"');
    expect(simple).toContain("Goal!");
    expect(pro).not.toContain("visually-hidden");
  });
});

describe("Pro data", () => {
  it("measures passes from their recorded start and end points", () => {
    const pass = f.events.find((e) => e.type === "pass" && e.outcome === "complete" && e.start && e.end)!;
    const chips = proChips(f, pass);
    const metres = Math.hypot(pass.end!.x - pass.start!.x, pass.end!.y - pass.start!.y).toFixed(1);
    expect(chips).toContain(`${metres} m`);
    expect(chips).toContain(`${((pass.t - pass.startT!) / 1000).toFixed(1)} s travel`);
    // Positions come from the formation active at the time of the pass.
    const shapes = formationsAt(f, pass.t)!;
    const from = f.roster.find((p) => p.id === pass.playerId)!;
    const slot = shapes.find((s) => s.teamId === from.teamId)!.assignments[from.id];
    expect(chips.some((c) => c.startsWith(`${slot} #${from.number} → `))).toBe(true);
    expect(chips.at(-1)).toBe(pass.id);
  });

  it("counts how many players move in a formation change", () => {
    const applied = f.tactics!.applied[0]!;
    const moved = Object.keys(applied.assignments).filter((id) => applied.assignments[id] !== applied.previousAssignments[id]).length;
    expect(proChips(f, change)).toContain(`${moved} of 11 change position`);
  });

  it("omits positions for fixtures without formation data", () => {
    const pass = sampleFixture.events.find((e) => e.type === "pass")!;
    expect(proChips(sampleFixture, pass).some((c) => /→ #\d/.test(c))).toBe(true);
    expect(proChips(sampleFixture, pass).some((c) => /[A-Z]{2,3} #/.test(c))).toBe(false);
  });

  it("names pitch thirds from the acting team's goal", () => {
    expect(pitchZone(10, "increasing-x")).toBe("own third");
    expect(pitchZone(10, "decreasing-x")).toBe("attacking third");
    expect(pitchZone(PITCH_LENGTH / 2, "increasing-x")).toBe("middle third");
  });

  it("totals only events reached, consistent with the main statistics", () => {
    for (const t of [0, 20_000, 45_000, f.durationMs]) {
      const pro = proStatisticsAt(f, t);
      const stats = statisticsAt(f, t);
      for (const side of ["home", "away"] as const) {
        const team = f.teams.find((x) => x.side === side)!.id;
        const passes = f.events.filter((e) => e.t <= t && e.teamId === team && e.type === "pass");
        expect(pro[side].passesAttempted).toBe(passes.length);
        expect(pro[side].passesCompleted).toBe(stats[side].completedPasses);
        expect(pro[side].shotsOnTarget).toBeLessThanOrEqual(stats[side].shots);
        if (pro[side].passCompletion !== null) expect(pro[side].passCompletion).toBe(Math.round((pro[side].passesCompleted / passes.length) * 100));
      }
    }
    expect(proStatisticsAt(f, 0).home).toMatchObject({ passCompletion: null, averagePassLength: null, shotsOnTarget: 0 });
  });
});

describe("score bug", () => {
  const render = (t: number) => {
    const frame = frameAt(f, t);
    return renderToStaticMarkup(
      <ScoreBug
        teams={f.teams}
        score={frame.score}
        timeMs={t}
        status="paused"
        possessionTeamId={frame.possession?.teamId ?? null}
        formations={frame.formations}
      />,
    );
  };

  it("shows score, clock and the shapes active now, with team names and shapes as well as colour", () => {
    expect(render(change.t - 100)).toContain("Shape <b>4-4-2</b> v <b>4-3-3</b>");
    expect(render(change.t)).toContain("Shape <b>4-4-2</b> v <b>4-2-3-1</b>");
    const html = render(goal.t);
    expect(html).toContain('aria-label="Score: Harbor City FC 0, Northvale Rovers 1"');
    expect(html).toContain("marker--home");
    expect(html).toContain("marker--away");
    expect(html).toContain("<time>0:14</time>");
    // Full team names are written out, so the kit colour is never the only cue.
    for (const team of f.teams) expect(html).toContain(`${team.name}</span>`);
    expect(html).toContain("Paused");
  });

  it("keeps the Tactics numbers out of the scoreline", () => {
    expect(render(45_000)).not.toContain("Passes completed");
  });

  it("lists the Tactics numbers so far for both teams, named for screen readers", () => {
    const stats = statisticsAt(f, 45_000);
    const extra = proStatisticsAt(f, 45_000);
    const html = renderToStaticMarkup(<TacticsNumbers teams={f.teams} stats={stats} extra={extra} />);
    for (const label of ["Possession", "Passes completed", "Shots (on target)"]) expect(html).toContain(label);
    expect(html).toContain(`<b>${extra.home.passesCompleted}/${extra.home.passesAttempted}</b>`);
    expect(html).toContain(`<b>${stats.away.shots} (${extra.away.shotsOnTarget})</b>`);
    for (const team of f.teams) expect(html).toContain(team.name);
  });
});

describe("match set-up", () => {
  const draft = (patch: (d: SetupDraft) => void) => {
    const d = structuredClone(DEFAULT_DRAFT);
    patch(d);
    return d;
  };

  it("checks change times and the seed field by field", () => {
    expect(changeTimeError("30", 60)).toBeNull();
    expect(changeTimeError("59.9", 60)).toBeNull();
    for (const bad of ["", "0", "60", "75", "-5", "abc", "1.25"]) expect(changeTimeError(bad, 60), bad).not.toBeNull();
    expect(changeTimeError("75", 60)).toMatch(/between 0 and 60/);
    const errors = setupErrors(
      draft((d) => {
        d.changeOn.away = true;
        d.teams.away.changeAt = "75";
        d.seed = "4.5";
      }),
    );
    expect(Object.keys(errors).sort()).toEqual(["away", "seed"]);
    // An unticked change is ignored, whatever its text.
    expect(setupErrors(draft((d) => (d.teams.home.changeAt = "999")))).toEqual({});
  });

  it("recovers the set-up from a generated match, so unchanged settings are not 'pending'", () => {
    const loaded = draftFromFixture(f)!;
    expect(loaded).toMatchObject({ seed: "46", durationSeconds: 60, changeOn: { home: false, away: true } });
    expect(loaded.teams.away).toEqual({ formation: "4-3-3", changeAt: "30", changeTo: "4-2-3-1" });
    expect(sameSetup(loaded, structuredClone(loaded))).toBe(true);
    expect(sameSetup(loaded, { ...loaded, seed: "47" })).toBe(false);
    expect(draftFromFixture(sampleFixture)).toBeNull();
    // Regenerating from the recovered set-up gives the same match.
    const tactics = tacticsFromControls(controlsOf(loaded), loaded.durationSeconds);
    expect(generateMatch({ seed: 46, durationMs: 60_000, tactics }).matchId).toBe(f.matchId);
  });

  it("says when changes are not applied yet, and summarises errors in words", () => {
    const props = {
      teams: f.teams,
      watchingLabel: "Seed 46",
      onDraft: () => {},
      onGenerate: () => {},
      onScriptedDemo: () => {},
      onClose: () => {},
    };
    const loaded = draftFromFixture(f)!;
    expect(renderToStaticMarkup(<SetupDrawer {...props} loaded={loaded} draft={loaded} />)).not.toContain("Not applied yet");
    const changed = renderToStaticMarkup(<SetupDrawer {...props} loaded={loaded} draft={{ ...loaded, seed: "7" }} />);
    expect(changed).toContain("Not applied yet");
    expect(changed).toContain('role="dialog"');
    expect(changed).toContain('aria-modal="true"');
    const bad = structuredClone(loaded);
    bad.teams.away.changeAt = "75";
    expect(renderToStaticMarkup(<SetupDrawer {...props} loaded={loaded} draft={bad} />)).toContain("Pick a time between 0 and 60 seconds");
  });
});
