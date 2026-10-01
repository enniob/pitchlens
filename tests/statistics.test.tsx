import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import { generateMatch } from "@/simulation/generate";
import { PlaybackEngine } from "@/playback/engine";
import { statisticsAt } from "@/playback/statistics";
import { MatchStats } from "@/components/MatchStats";

const home = sampleFixture.teams.find((team) => team.side === "home")!.id;
const away = sampleFixture.teams.find((team) => team.side === "away")!.id;

describe("possession duration", () => {
  const first = sampleFixture.snapshots[0]!;
  const fixture: MatchFixture = {
    ...sampleFixture, durationMs: 4000, events: [],
    snapshots: [
      { ...first, t: 0, possession: { teamId: home, playerId: null } },
      { ...first, t: 1000, possession: null },
      { ...first, t: 2000, discontinuity: true, possession: { teamId: away, playerId: null } },
      { ...first, t: 4000, possession: null },
    ],
  };
  it("has no percentage until controlled time has elapsed", () => {
    expect(statisticsAt(fixture, 0).home.possessionPercent).toBeNull();
  });
  it("excludes flight/dead time and integrates a partial interval", () => {
    const stats = statisticsAt(fixture, 2500);
    expect(stats.home.possessionMs).toBe(1000);
    expect(stats.away.possessionMs).toBe(500);
    expect(stats.home.possessionPercent).toBe(67);
    expect(stats.away.possessionPercent).toBe(33);
    expect(statisticsAt(fixture, 1500).away.possessionMs).toBe(0);
  });
  it("clamps time at both ends", () => {
    expect(statisticsAt(fixture, -1)).toEqual(statisticsAt(fixture, 0));
    expect(statisticsAt(fixture, 9000)).toEqual(statisticsAt(fixture, 4000));
  });
});

describe.each([
  ["scripted schema 1.0", sampleFixture],
  ["generated schema 1.1", generateMatch({ seed: 7, durationMs: 120000 })],
] as const)("statistics: %s", (_name, fixture) => {
  it("counts each event at its timestamp, with saves credited to the opponent", () => {
    for (const time of [0, ...fixture.events.map((e) => e.t - 1), ...fixture.events.map((e) => e.t), fixture.durationMs]) {
      const stats = statisticsAt(fixture, time);
      for (const team of fixture.teams) {
        const reached = fixture.events.filter((e) => e.t <= Math.max(0, time));
        const own = reached.filter((e) => e.teamId === team.id);
        expect(stats[team.side].completedPasses).toBe(own.filter((e) => e.type === "pass" && e.outcome === "complete").length);
        expect(stats[team.side].shots).toBe(own.filter((e) => e.type === "shot").length);
        expect(stats[team.side].goals).toBe(own.filter((e) => e.type === "goal").length);
        expect(stats[team.side].saves).toBe(reached.filter((e) => e.teamId !== team.id && e.type === "shot-result" && e.outcome === "saved").length);
      }
    }
  });
  it("produces the same totals through playback, seek, reverse seek and restart", () => {
    const engine = new PlaybackEngine(fixture);
    engine.setSpeed(4);
    engine.play();
    engine.advance(1000);
    const expected = statisticsAt(fixture, 4000);
    expect(statisticsAt(fixture, engine.status.timeMs)).toEqual(expected);
    engine.seek(fixture.durationMs);
    engine.seek(4000);
    expect(statisticsAt(fixture, engine.status.timeMs)).toEqual(expected);
    engine.restart();
    expect(statisticsAt(fixture, engine.status.timeMs)).toEqual(statisticsAt(fixture, 0));
  });
});

it("does not count a starting score as goals in this sequence", () => {
  const fixture = { ...sampleFixture, startingState: { ...sampleFixture.startingState, score: { home: 3, away: 2 } } };
  expect(statisticsAt(fixture, 0).home.goals).toBe(0);
  expect(statisticsAt(fixture, fixture.durationMs).home.goals).toBe(1);
});

it("renders an accessible comparison table with empty possession", () => {
  const html = renderToStaticMarkup(<MatchStats teams={sampleFixture.teams} stats={statisticsAt(sampleFixture, 0)} />);
  expect(html).toContain("<caption>Match statistics</caption>");
  expect(html).toContain('scope="row"');
  expect(html).toContain("Completed passes");
  expect(html).toContain("—");
  expect(html).not.toContain("NaN");
});
