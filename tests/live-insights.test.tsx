// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Audience } from "@/explain/api";
import { extractMatchContext } from "@/explain/context";
import { recordedSummary } from "@/explain/recorded";
import { insufficientEvidence } from "@/explain/response";
import { ExplanationPanel, type SavedExplanation } from "@/components/ExplanationPanel";
import { formatClock } from "@/components/format";
import type { PlaybackPhase } from "@/components/ScoreBug";
import type { MatchEvent, MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import { insightMomentsBetween, isInsightMoment } from "@/playback/moments";
import { generateMatch } from "@/simulation/generate";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
const pause = vi.fn();
const replay = vi.fn();
let savedList: SavedExplanation[] = [];

function Harness({ fixture, timeMs, playback }: { fixture: MatchFixture; timeMs: number; playback: PlaybackPhase }) {
  const [audience, setAudience] = useState<Audience>("casual");
  const [saved, setSaved] = useState<SavedExplanation[]>([]);
  const [shownId, setShownId] = useState<string | null>(null);
  savedList = saved;
  return <ExplanationPanel fixture={fixture} timeMs={timeMs} playback={playback} audience={audience} onAudience={setAudience}
    onPause={pause} onReplayFrom={replay} saved={saved} shownId={shownId} onSaved={(x) => setSaved((list) => [...list.filter((y) => y.id !== x.id), x])} onShow={setShownId} />;
}
const render = (timeMs: number, playback: PlaybackPhase = "playing", fixture: MatchFixture = sampleFixture) =>
  act(async () => { root.render(<Harness fixture={fixture} timeMs={timeMs} playback={playback} />); });
/** Plays from `from` to `to` in natural steps, the way the viewer's clock advances. */
async function play(from: number, to: number, fixture: MatchFixture = sampleFixture) {
  for (let t = from; t < to; t = Math.min(to, t + 500)) await render(t, "playing", fixture);
  await render(to, "playing", fixture);
}
function button(text: string) {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
const click = (text: string) => act(async () => button(text).click());
const feedText = () => container.querySelector(".insights")?.textContent ?? "";
const requestOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as { timeMs: number; audience: Audience };

function response(fixture: MatchFixture, timeMs: number, audience: string, headline = `Insight at ${timeMs}`) {
  const explanation = insufficientEvidence(extractMatchContext(fixture, timeMs), "Only synthetic evidence is available.");
  explanation.headline = `${headline} (${audience})`;
  return { apiVersion: "1.0.0", ok: true, matchId: fixture.matchId, timeMs, audience, explanation };
}
function answering(fixture: MatchFixture = sampleFixture) {
  return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(response(fixture, request.timeMs, request.audience)));
  });
}
const goal = sampleFixture.events.find((e) => e.type === "goal")!;

beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  pause.mockClear(); replay.mockClear(); savedList = [];
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("insight moments", () => {
  const home = sampleFixture.teams.find((t) => t.attacksTowards === "increasing-x")!;
  const foul = (x: number, start = true): MatchEvent =>
    ({ id: "f", t: 1, type: "foul", teamId: home.id, outcome: "committed", description: "Foul", ...(start ? { start: { x, y: 34, z: 0 } } : {}) });

  it("picks the demo goal, not the shot it resolves", () => {
    expect(sampleFixture.events.filter((e) => isInsightMoment(sampleFixture, e)).map((e) => e.type)).toEqual(["goal"]);
  });

  it("counts every foul, wherever it happened", () => {
    // This team attacks towards x = 105, so it defends x = 0.
    for (const x of [12, 30, 52, 95]) expect(isInsightMoment(sampleFixture, foul(x))).toBe(true);
    expect(isInsightMoment(sampleFixture, foul(12, false))).toBe(true);
  });

  it("includes shot results and formation changes, and only moments inside the step", () => {
    const at = (type: MatchEvent["type"]): MatchEvent => ({ id: type, t: 1, type, teamId: home.id, outcome: "applied", description: "" });
    expect(isInsightMoment(sampleFixture, at("shot-result"))).toBe(true);
    expect(isInsightMoment(sampleFixture, at("formation-change"))).toBe(true);
    expect(isInsightMoment(sampleFixture, at("offside"))).toBe(true);
    expect(isInsightMoment(sampleFixture, at("shot"))).toBe(false);
    expect(insightMomentsBetween(sampleFixture, goal.t, 24_000)).toEqual([]);
    expect(insightMomentsBetween(sampleFixture, goal.t - 1, goal.t)).toEqual([goal]);
  });
});

describe("live insights", () => {
  it("explains a key moment as play reaches it, without pausing and cut off at the moment", async () => {
    const fetcher = answering();
    vi.stubGlobal("fetch", fetcher);
    await play(8_000, 10_000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(requestOf(fetcher.mock.calls[0]!)).toMatchObject({ timeMs: goal.t, audience: "casual" });
    expect(pause).not.toHaveBeenCalled();
    expect(feedText()).toContain(`Insight at ${goal.t} (casual)`);
    expect(feedText()).toContain(`evidence up to ${formatClock(goal.t)}`);
    expect(savedList.map((s) => s.eventId)).toEqual([goal.id]);
    // Play running on does not ask again.
    await play(10_000, 14_000);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not explain moments skipped by a seek or reached while paused", async () => {
    const fetcher = answering();
    vi.stubGlobal("fetch", fetcher);
    await render(8_000); await render(12_000);
    await render(8_000, "paused"); await render(10_000, "paused");
    expect(fetcher).not.toHaveBeenCalled();
    expect(feedText()).not.toContain("Goal");
  });

  it("never shows a card before its moment, and shows it again when play returns", async () => {
    const fetcher = answering();
    vi.stubGlobal("fetch", fetcher);
    await play(8_000, 10_000);
    await render(9_000);
    expect(feedText()).not.toContain("Insight at");
    await play(9_000, 10_000);
    expect(feedText()).toContain(`Insight at ${goal.t}`);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("abandons a request when seeking back before its moment", async () => {
    let resolve!: (r: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((r) => { resolve = r; }))
      .mockImplementation(answering());
    vi.stubGlobal("fetch", fetcher);
    await play(8_000, 10_000);
    expect(feedText()).toContain("Reading the evidence");
    await render(5_000);
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    await act(async () => resolve(new Response(JSON.stringify(response(sampleFixture, goal.t, "casual", "Old")))));
    expect(savedList).toEqual([]);
    // Reached again, it is asked for again.
    await play(9_000, 10_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(feedText()).toContain(`Insight at ${goal.t}`);
  });

  it("asks for the other audience only on request, from the same moment", async () => {
    const fetcher = answering();
    vi.stubGlobal("fetch", fetcher);
    await play(8_000, 10_000);
    await click("Analyst");
    expect(feedText()).not.toContain("Insight at");
    expect(fetcher).toHaveBeenCalledOnce();
    await click("Explain for Analyst");
    expect(requestOf(fetcher.mock.calls[1]!)).toMatchObject({ timeMs: goal.t, audience: "analyst" });
    expect(feedText()).toContain(`Insight at ${goal.t} (analyst)`);
    await click("Casual Fan");
    expect(feedText()).toContain(`Insight at ${goal.t} (casual)`);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shows a safe failure on the card and retries on request", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: "rate-limited" } }), { status: 429 }))
      .mockImplementation(answering());
    vi.stubGlobal("fetch", fetcher);
    await play(8_000, 10_000);
    expect(container.querySelector(".insights [role=alert]")?.textContent).toContain("Too many requests");
    await click("Try again");
    expect(feedText()).toContain(`Insight at ${goal.t}`);
  });

  it("automatically retries a busy model while keeping the card loading at its original moment", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: "upstream-rate-limited", retryAfterMs: 2_000 } }), { status: 503 }))
      .mockImplementation(answering());
    vi.stubGlobal("fetch", fetcher);
    await play(8_000, 10_000);
    expect(feedText()).toContain("Reading the evidence");
    expect(container.querySelector(".insights [role=alert]")).toBeNull();
    await render(11_000);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requestOf(fetcher.mock.calls[1]!)).toEqual(requestOf(fetcher.mock.calls[0]!));
    expect(feedText()).toContain(`Insight at ${goal.t}`);
  });

  it("drops an automatic retry when seeking backward before the moment", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: "upstream-rate-limited", retryAfterMs: 2_000 } }), { status: 503 }))
      .mockImplementation(answering());
    vi.stubGlobal("fetch", fetcher);
    await play(8_000, 10_000);
    await render(5_000);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(savedList).toEqual([]);
    expect(feedText()).not.toContain("Goal");
  });

  it("offers a retry on an insight that failed its checks and replaces it with the new answer", async () => {
    const fallback = { ...response(sampleFixture, goal.t, "casual"), verification: { outcome: "fallback" } };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(fallback)))
      .mockImplementation(answering());
    vi.stubGlobal("fetch", fetcher);
    await play(8_000, 10_000);
    expect(feedText()).toContain("didn't pass our checks");
    await click("Try again");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requestOf(fetcher.mock.calls[1]!).timeMs).toBe(goal.t);
    expect(feedText()).toContain(`Insight at ${goal.t}`);
    expect(feedText()).not.toContain("didn't pass our checks");
    expect(savedList).toHaveLength(1);
    expect(() => button("Try again")).toThrow();
  });

  it("shows recorded match facts as a separate kind of card, not an AI insight, until an AI answer replaces them", async () => {
    const facts = { ...response(sampleFixture, goal.t, "casual"), verification: { outcome: "fallback" },
      recordedSummary: recordedSummary(extractMatchContext(sampleFixture, goal.t))! };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(facts)))
      .mockImplementation(answering());
    vi.stubGlobal("fetch", fetcher);
    await play(8_000, 10_000);
    const card = () => container.querySelector(".insights .insight")!;
    expect(card().classList.contains("insight--facts")).toBe(true);
    expect(feedText()).toContain("Match facts, not AI");
    expect(feedText()).not.toContain("didn't pass our checks");
    // Collapsed, the card still says it is match facts, not an AI headline.
    await act(async () => card().querySelector<HTMLButtonElement>(".insight__head")!.click());
    expect(card().querySelector(".insight__headline")?.textContent).toBe(`Match facts, not AI${facts.recordedSummary.headline}`);
    await act(async () => card().querySelector<HTMLButtonElement>(".insight__head")!.click());
    await click("Get AI explanation");
    expect(requestOf(fetcher.mock.calls[1]!).timeMs).toBe(goal.t);
    expect(feedText()).toContain(`Insight at ${goal.t}`);
    expect(feedText()).not.toContain("Match facts, not AI");
    expect(card().classList.contains("insight--facts")).toBe(false);
  });

  it("collapses an open card when its title is clicked, and opens it again", async () => {
    vi.stubGlobal("fetch", answering());
    await play(8_000, 10_000);
    const head = () => container.querySelector<HTMLButtonElement>(".insight__head")!;
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".insight__answer")).not.toBeNull();
    await act(async () => head().click());
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".insight__answer")).toBeNull();
    expect(container.querySelector(".insight__headline")?.textContent).toContain(`Insight at ${goal.t}`);
    // Stays collapsed as play moves on.
    await play(10_000, 11_000);
    expect(container.querySelector(".insight__answer")).toBeNull();
    await act(async () => head().click());
    expect(container.querySelector(".insight__answer")).not.toBeNull();
  });

  it("keeps a card on screen while replaying its cited evidence", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const body = response(sampleFixture, request.timeMs, request.audience);
      body.explanation.status = "explained";
      body.explanation.facts = [{ text: "A goal was recorded.", evidence: [{ kind: "event", id: goal.id }] }];
      return new Response(JSON.stringify(body));
    });
    vi.stubGlobal("fetch", fetcher);
    await play(8_000, 12_000);
    await act(async () => container.querySelector<HTMLButtonElement>(`.insights [aria-label="Replay event at ${formatClock(goal.t)}"]`)!.click());
    expect(replay).toHaveBeenCalledWith(goal.t - 3_000);
    await render(goal.t - 3_000);
    expect(feedText()).toContain("Replaying cited evidence");
    expect(feedText()).toContain("A goal was recorded.");
    // Any other backward seek hides it.
    await render(2_000);
    expect(feedText()).not.toContain("A goal was recorded.");
  });

  it("runs one request at a time and only the newest waiting moment", async () => {
    const fixture = generateMatch({ seed: 5 });
    const moments = fixture.events.filter((e) => isInsightMoment(fixture, e));
    // Three moments inside 10 s, with none in the second of play before the first.
    const i = moments.findIndex((m, k) => k + 2 < moments.length && moments[k + 2]!.t - m.t < 10_000 &&
      (k === 0 || moments[k - 1]!.t < m.t - 1_000));
    expect(i).toBeGreaterThanOrEqual(0);
    const [first, second, third] = moments.slice(i, i + 3);
    const finish: ((r: Response) => void)[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((r) => {
      const request = JSON.parse(String(init?.body));
      finish.push(() => r(new Response(JSON.stringify(response(fixture, request.timeMs, request.audience)))));
    }));
    vi.stubGlobal("fetch", fetcher);
    await play(first!.t - 1_000, third!.t + 100, fixture);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(feedText()).toContain("Waiting for the previous insight");
    await act(async () => finish[0]!(undefined as never));
    expect(fetcher.mock.calls.map((c) => requestOf(c).timeMs)).toEqual([first!.t, third!.t]);
    // The moment passed over while busy can still be explained on request.
    expect(button("Explain for Casual Fan")).toBeTruthy();
    await act(async () => finish[1]!(undefined as never));
    expect(feedText()).toContain(`Insight at ${third!.t}`);
    expect(feedText()).toContain(`Insight at ${first!.t}`);
    expect(feedText()).not.toContain(`Insight at ${second!.t}`);
  });
});
