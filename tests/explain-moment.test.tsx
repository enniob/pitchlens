// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatchViewer } from "@/components/MatchViewer";
import { ExplanationAccessContext } from "@/components/ExplanationAccessGate";
import { formatClock } from "@/components/format";
import type { MatchFixture } from "@/match/contract";
import { PlaybackEngine } from "@/playback/engine";
import { generateMatch } from "@/simulation/generate";
import { extractMatchContext } from "@/explain/context";
import { insufficientEvidence } from "@/explain/response";

// "Explain this moment" inside the full viewer: citation replay into the
// offside review, a new match while a request is pending, and the audience a
// match starts with. All match data is synthetic.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const match = (seed: number) => generateMatch({ seed, durationMs: 60_000, tactics: { home: { formation: "4-4-2" }, away: { formation: "4-3-3" } } });
const fixture = match(42);
const flag = fixture.events.find((e) => e.type === "offside")!;

let container: HTMLDivElement;
let root: Root;
let engine!: PlaybackEngine;
let tick!: FrameRequestCallback;
let clock = 0;

function view(f: MatchFixture, pro = false) {
  return act(async () => root.render(
    <ExplanationAccessContext.Provider value={true}>
      {/* Keyed like the app shell, so a new match is a fresh viewer. */}
      <MatchViewer key={f.matchId} fixture={f} pro={pro} />
    </ExplanationAccessContext.Provider>));
}
/** Seeks while paused, as the timeline does, then lets one frame sync the UI. */
const seekTo = (timeMs: number) => act(async () => { engine.pause(); engine.seek(timeMs); tick(clock); });
/** Advances real time frame by frame, so the offside review can start on its own. */
async function play(ms: number) {
  for (let left = ms; left > 0; left -= 100) await act(async () => { clock += 100; tick(clock); });
}
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
function answer(timeMs: number, audience: string, evidence: { facts: object[] }) {
  const explanation = insufficientEvidence(extractMatchContext(fixture, timeMs), "Only synthetic evidence is available.");
  if (evidence.facts.length) Object.assign(explanation, { status: "explained", interpretation: [] }, evidence);
  return { apiVersion: "1.0.0", ok: true, matchId: fixture.matchId, timeMs, audience, explanation };
}

beforeEach(() => {
  const original = PlaybackEngine.prototype.frame;
  vi.spyOn(PlaybackEngine.prototype, "frame").mockImplementation(function (this: PlaybackEngine) {
    engine = this;
    return original.call(this);
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { tick = cb; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  clock = performance.now();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("explain this moment in the viewer", () => {
  it("replays an offside citation through the kick-frame review without revealing later play", async () => {
    const at = flag.t + 2_000;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(answer(request.timeMs, request.audience, {
        facts: [{ text: "An offside was called.", evidence: [{ kind: "event", id: flag.id }, { kind: "snapshot", t: flag.startT }] }],
      })));
    });
    vi.stubGlobal("fetch", fetcher);
    await view(fixture);
    await seekTo(at);
    await act(async () => button("Explain this moment")!.click());
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ timeMs: at, audience: "casual" });
    expect(container.textContent).toContain(`explained at ${formatClock(at)}`);

    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="Replay event at ${formatClock(flag.t)}"]`)!.click());
    // Replay starts three seconds before the whistle and is playing.
    expect(engine.status.timeMs).toBe(flag.t - 3_000);
    expect(engine.status.playing).toBe(true);
    // The answer was asked later in the match, so it is hidden during the replay.
    expect(container.textContent).not.toContain("An offside was called.");

    await play(3_200);
    const review = container.querySelector(".offside-review")!;
    expect(review.textContent).toContain(`Position when the pass was played · ${formatClock(flag.startT!)}`);
    // The clock holds at the whistle: nothing after the call is shown.
    expect(engine.status.timeMs).toBe(flag.t);
    expect(container.textContent).not.toContain("An offside was called.");
  });

  it("drops a pending explanation when a new match is generated", async () => {
    let resolve!: (r: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise((r) => { resolve = r; });
    }));
    await view(fixture);
    await seekTo(20_000);
    await act(async () => button("Explain this moment")!.click());
    expect(container.querySelector(".explain__loading")).not.toBeNull();

    const next = match(43);
    await view(next);
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve(new Response(JSON.stringify(answer(20_000, "casual", { facts: [] })))));
    expect(container.querySelector(".explain__loading")).toBeNull();
    expect(container.querySelector(".explain__answer")).toBeNull();
    expect(container.textContent).not.toContain("Your explanations");
  });

  it.each([[false, "Casual Fan"], [true, "Analyst"]] as const)("starts a match with Pro data %s in %s", async (pro, name) => {
    vi.stubGlobal("fetch", vi.fn());
    await view(fixture, pro);
    const pressed = [...container.querySelectorAll('[aria-label="Explanation audience"] [aria-pressed="true"]')].map((b) => b.textContent);
    expect(pressed).toEqual([name]);
  });
});

describe("keyboard use of the explanation panel", () => {
  it("keeps focus on Explain while loading, after Cancel and after closing an answer", async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() => new Promise((r) => { resolve = r; })));
    await view(fixture);
    await seekTo(20_000);
    const go = () => container.querySelector<HTMLButtonElement>(".explain__go")!;
    go().focus();
    await act(async () => go().click());
    expect(document.activeElement).toBe(go());
    expect(go().getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector(".explain__loading")!.getAttribute("role")).toBe("status");

    await act(async () => resolve(new Response(JSON.stringify(answer(20_000, "casual", { facts: [] })))));
    expect(container.querySelector(".explain__answer")!.getAttribute("aria-live")).toBe("polite");
    container.querySelector<HTMLButtonElement>('[aria-label="Close explanation"]')!.focus();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close explanation"]')!.click());
    expect(document.activeElement).toBe(go());

    // The next request waits for the viewer's gap between requests; Cancel works while it waits.
    await act(async () => go().click());
    button("Cancel")!.focus();
    await act(async () => button("Cancel")!.click());
    expect(document.activeElement).toBe(go());
    expect(go().hasAttribute("aria-disabled")).toBe(false);
  });

  it("ignores a second activation while loading", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetcher);
    await view(fixture);
    await seekTo(20_000);
    await act(async () => button("Explain this moment")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".explain__go")!.click());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
