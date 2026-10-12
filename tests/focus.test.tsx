// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ALL_MATCH, eventMatchesFocus, focusStatisticsAt, normalizeFocus } from "@/playback/focus";
import { sampleFixture } from "@/match/fixture";
import { LiveInsights } from "@/components/LiveInsights";
import { MatchFocus } from "@/components/MatchFocus";
import { Recap } from "@/components/Recap";
import { renderToStaticMarkup } from "react-dom/server";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const goal = sampleFixture.events.find((e) => e.type === "goal")!;
const pass = sampleFixture.events.find((e) => e.type === "pass")!;

describe("match-scoped favorites", () => {
  it("clears unknown IDs and a player outside the chosen team", () => {
    expect(normalizeFocus(sampleFixture, { teamId: "unknown", playerId: "unknown" })).toEqual(ALL_MATCH);
    const other = sampleFixture.teams.find((t) => t.id !== goal.teamId)!;
    expect(normalizeFocus(sampleFixture, { teamId: other.id, playerId: goal.playerId! })).toEqual({ teamId: other.id, playerId: null });
  });

  it("counts a recipient only for completed passes", () => {
    const focus = { teamId: null, playerId: pass.recipientId! };
    expect(eventMatchesFocus({ ...pass, outcome: "complete" }, focus)).toBe(true);
    expect(eventMatchesFocus({ ...pass, outcome: "intercepted" }, focus)).toBe(false);
  });

  it("removes future totals after backward seeking without mutating the fixture", () => {
    const focus = { teamId: goal.teamId, playerId: goal.playerId! };
    expect(focusStatisticsAt(sampleFixture, goal.t, focus).goals).toBe(1);
    expect(focusStatisticsAt(sampleFixture, goal.t - 1, focus).goals).toBe(0);
    expect(focusStatisticsAt(sampleFixture, -1, focus).goals).toBe(0);
  });

  it("resets incompatible players when the favorite team changes", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const change = vi.fn();
    const other = sampleFixture.teams.find((t) => t.id !== goal.teamId)!;
    try {
      await act(async () => root.render(<MatchFocus fixture={sampleFixture} timeMs={goal.t} focus={{ teamId: goal.teamId, playerId: goal.playerId! }} onFocus={change} />));
      const select = host.querySelector("select")!;
      await act(async () => { select.value = other.id; select.dispatchEvent(new Event("change", { bubbles: true })); });
      expect(change).toHaveBeenCalledWith({ teamId: other.id, playerId: null });
    } finally { await act(async () => root.unmount()); }
  });

  it("offers an explicit empty state for recap favorites with no defining moments", () => {
    const keeper = sampleFixture.roster.find((p) => p.role === "GK")!;
    const html = renderToStaticMarkup(<Recap fixture={sampleFixture} audience="casual" onAudience={() => {}} onReplayFrom={() => {}} focus={{ teamId: keeper.teamId, playerId: keeper.id }} onFocus={() => {}} />);
    expect(html).toContain("No defining moments for this favorite");
    expect(html).toContain("Show whole match");
    expect(html).not.toContain('aria-label="Defining moments"');
  });

  it("skips unrelated automatic requests and restores offered cards when showing the whole match", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const host = document.createElement("div");
    const root = createRoot(host);
    const other = sampleFixture.teams.find((t) => t.id !== goal.teamId)!;
    const render = (timeMs: number, teamId: string | null) => act(async () => root.render(<LiveInsights fixture={sampleFixture} timeMs={timeMs} playback="playing" audience="casual" saved={[]} onSaved={() => {}} onReplayFrom={() => {}} focus={{ teamId, playerId: null }} />));
    try {
      await render(goal.t - 100, other.id);
      await render(goal.t, other.id);
      expect(fetcher).not.toHaveBeenCalled();
      expect(host.textContent).toContain("No insights for this favorite yet");
      await render(goal.t, null);
      expect(host.querySelectorAll(".insight")).toHaveLength(1);
      await render(goal.t - 100, null);
      expect(host.querySelectorAll(".insight")).toHaveLength(0);
    } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
  });

  it("abandons an unrelated pending request and its queued job when favorites change", async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const fixture = { ...sampleFixture, events: [...sampleFixture.events, { ...goal, id: "another-goal", t: goal.t + 500 }].sort((a, b) => a.t - b.t) };
    const host = document.createElement("div");
    const root = createRoot(host);
    const other = fixture.teams.find((t) => t.id !== goal.teamId)!;
    const render = (timeMs: number, teamId: string | null) => act(async () => root.render(<LiveInsights fixture={fixture} timeMs={timeMs} playback="playing" audience="casual" saved={[]} onSaved={() => {}} onReplayFrom={() => {}} focus={{ teamId, playerId: null }} />));
    try {
      await render(goal.t - 100, null);
      await render(goal.t, null);
      await render(goal.t + 500, null);
      expect(fetcher).toHaveBeenCalledOnce();
      const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(request[1].signal?.aborted).toBe(false);
      await render(goal.t + 500, other.id);
      expect(request[1].signal?.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(host.textContent).toContain("No insights for this favorite yet");
      await render(goal.t + 500, null);
      expect(host.textContent).not.toContain("Waiting for the previous insight");
      expect(host.textContent).not.toContain("Reading the evidence");
    } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
  });
});
