// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatchPatterns } from "@/components/MatchPatterns";
import { sampleFixture } from "@/match/fixture";
import { eventsAt } from "@/playback/derive";
import { measureEvents } from "@/playback/patterns";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
const replay = vi.fn();
const shot = sampleFixture.events.find((e) => e.type === "shot")!;
const turnover = sampleFixture.events.find((e) => e.type === "turnover")!;
const render = (timeMs: number, favoriteTeamId?: string, favoritePlayerId?: string) => act(async () => {
  root.render(<MatchPatterns fixture={sampleFixture} timeMs={timeMs} onReplay={replay} favoriteTeamId={favoriteTeamId} favoritePlayerId={favoritePlayerId} />);
});

beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); replay.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("measured pattern cards", () => {
  it("appears when the shot is revealed, shows supporting events and replays from the turnover", async () => {
    await render(shot.t - 1);
    expect(container.textContent).not.toContain("Turnover to shot");
    await render(shot.t);
    expect(container.textContent).toContain("Turnover to shot");
    const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Replay turnover-to-shot"]')!;
    expect(button).not.toBeNull();
    await act(async () => button.click());
    expect(replay).toHaveBeenCalledWith(turnover.t);
    expect(container.querySelector("details ol")?.children.length).toBe(5);
    await render(shot.t - 1);
    expect(container.textContent).not.toContain("Turnover to shot");
  });

  it("shows no card for an activity comparison, which stays in the measurements", async () => {
    const end = sampleFixture.durationMs;
    const measured = measureEvents(eventsAt(sampleFixture, end), sampleFixture.teams, end).patterns;
    expect(measured.some((p) => p.kind === "activity-change")).toBe(true);
    await render(end);
    expect(container.textContent).not.toContain("Activity comparison");
    expect(container.querySelector('button[aria-label^="Replay activity-change"]')).toBeNull();
    expect(container.textContent).toContain("Turnover to shot");
  });

  it("filters cards by team and participant without changing measurements", async () => {
    await render(shot.t, turnover.teamId, turnover.playerId);
    expect(container.textContent).toContain("Turnover to shot");
    const summary = container.querySelector("li p")?.textContent;
    const opponent = sampleFixture.teams.find((t) => t.id !== turnover.teamId)!;
    await render(shot.t, opponent.id);
    expect(container.textContent).not.toContain("Turnover to shot");
    await render(shot.t, turnover.teamId, turnover.playerId);
    expect(container.querySelector("li p")?.textContent).toBe(summary);
  });
});
