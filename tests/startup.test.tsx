// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SampleMatchViewer } from "@/components/SampleMatchViewer";
import { sampleFixture } from "@/match/fixture";
import { generateMatch } from "@/simulation/generate";

vi.mock("@/components/MatchViewer", () => ({
  MatchViewer: ({ fixture, autoPlay, onOpenSetup }: { fixture: typeof sampleFixture; autoPlay: boolean; onOpenSetup: () => void }) => (
    <div data-testid="viewer" data-match={fixture.matchId} data-playing={autoPlay}>
      <button onClick={onOpenSetup}>New match</button>
    </div>
  ),
}));
vi.mock("@/simulation/generate", () => ({ generateMatch: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(generateMatch).mockReset();
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const mount = () => act(async () => root.render(<SampleMatchViewer />));
const click = (label: string) => act(async () => {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  expect(button, label).toBeDefined();
  button!.click();
});
const viewer = () => container.querySelector('[data-testid="viewer"]');

describe("match startup", () => {
  it("keeps startup choices visible through mount and reload with the old welcome flag", async () => {
    localStorage.setItem("pitchlens.welcomed", "1");
    expect(renderToString(<SampleMatchViewer />)).toContain("Kick off the demo");
    await mount();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(container.textContent).toContain("Kick off the demo");
    expect(viewer()).toBeNull();
    await click("Kick off the demo");
    expect(viewer()?.getAttribute("data-match")).toBe(sampleFixture.matchId);
    expect(viewer()?.getAttribute("data-playing")).toBe("true");
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(viewer()).toBeNull();
    expect(container.textContent).toContain("Kick off the demo");
  });

  it("opens and closes setup without loading a match", async () => {
    await mount();
    await click("Set up your own match");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain("No match loaded yet");
    expect(viewer()).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close set-up"]')!.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("Kick off the demo");
    expect(viewer()).toBeNull();
  });

  it("loads a generated match only after Generate and preserves it when setup is reopened", async () => {
    vi.mocked(generateMatch).mockReturnValue({ ...sampleFixture, matchId: "generated-startup" });
    await mount();
    await click("Set up your own match");
    expect(generateMatch).not.toHaveBeenCalled();
    await click("Generate match");
    expect(container.textContent).toContain("Simulating your match");
    expect(viewer()).toBeNull();
    await act(async () => vi.advanceTimersByTime(30));
    expect(viewer()?.getAttribute("data-match")).toBe("generated-startup");
    await click("New match");
    expect(container.textContent).toContain("Now watching:");
    expect(viewer()?.getAttribute("data-match")).toBe("generated-startup");
    await click("Scripted demo");
    expect(viewer()?.getAttribute("data-match")).toBe(sampleFixture.matchId);
  });

  it("keeps startup choices available after generation fails", async () => {
    vi.mocked(generateMatch).mockImplementation(() => { throw new Error("Simulation failed"); });
    await mount();
    await click("Set up your own match");
    await click("Generate match");
    await act(async () => vi.advanceTimersByTime(30));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Simulation failed");
    expect(viewer()).toBeNull();
    await click("Kick off the demo");
    expect(viewer()).not.toBeNull();
  });

  it("works when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    await mount();
    expect(viewer()).toBeNull();
    await click("Set up your own match");
    await click("Scripted demo");
    expect(viewer()?.getAttribute("data-match")).toBe(sampleFixture.matchId);
  });
});
