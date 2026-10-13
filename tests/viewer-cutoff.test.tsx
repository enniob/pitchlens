// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MatchViewer } from "@/components/MatchViewer";
import { PlaybackEngine } from "@/playback/engine";
import { sampleFixture } from "@/match/fixture";
import { ExplanationAccessContext } from "@/components/ExplanationAccessGate";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("removes full-time content and relocks recap on recap-to-match replay", async () => {
  let engine!: PlaybackEngine;
  let tick!: FrameRequestCallback;
  const original = PlaybackEngine.prototype.frame;
  vi.spyOn(PlaybackEngine.prototype, "frame").mockImplementation(function (this: PlaybackEngine) {
    engine = this;
    return original.call(this);
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { tick = cb; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  try {
    await act(async () => root.render(<ExplanationAccessContext.Provider value={false}><MatchViewer fixture={sampleFixture} /></ExplanationAccessContext.Provider>));
    await act(async () => { engine.seek(sampleFixture.durationMs); tick(performance.now()); });
    await act(async () => button("Recap").click());
    expect(container.textContent).toContain("The match, explained.");
    await act(async () => container.querySelector<HTMLButtonElement>(".recap__replay")!.click());
    expect(container.querySelector(".recap")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.appbar__tabs button:nth-child(2)')!.disabled).toBe(true);
    expect(engine.status.timeMs).toBeLessThan(sampleFixture.durationMs);
    await act(async () => { engine.seek(sampleFixture.durationMs); tick(performance.now()); });
    expect(button("Recap").disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
