import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { plainDescription } from "@/components/eventCopy";
import { LiveFeed } from "@/components/LiveFeed";
import { MomentStrip, stripMoments } from "@/components/MomentStrip";
import { sampleFixture } from "@/match/fixture";
import { eventsAt } from "@/playback/derive";
import { liveFeed } from "@/playback/moments";

describe("shot presentation boundaries", () => {
  const shot = sampleFixture.events.find((e) => e.type === "shot")!;
  const goal = sampleFixture.events.find((e) => e.type === "goal")!;
  const feed = (time: number) => renderToStaticMarkup(<LiveFeed fixture={sampleFixture} events={liveFeed(sampleFixture, time, true)} pro />);
  const strip = (time: number) => renderToStaticMarkup(<MomentStrip fixture={sampleFixture} moments={stripMoments(eventsAt(sampleFixture, time))} selectedId={null} onSelect={() => {}} />);

  it("neutralizes stored shot outcomes without changing fixture events", () => {
    expect(shot.description).toContain("on target");
    expect(plainDescription(shot)).toBe("A strike at goal. The result is shown separately.");
    const actor = sampleFixture.roster.find((p) => p.id === shot.playerId)!;
    expect(plainDescription(shot, sampleFixture.roster)).toContain(`${actor.name} (#${actor.number})`);
    expect(plainDescription({ ...shot, description: "The shot will be saved" })).not.toContain("saved");
    expect(plainDescription(goal)).toContain("scores");
    expect(shot.description).toContain("on target");
  });

  it("feed and strip hide the result at the strike and again after backward seeking", () => {
    for (const view of [feed, strip]) {
      expect(view(shot.t)).not.toContain("on target");
      expect(view(shot.t)).not.toContain("scores");
      expect(view(goal.t)).toContain("scores");
      expect(view(shot.t)).not.toContain("scores");
      expect(view(shot.t)).toContain("The result is shown separately");
    }
  });
});
