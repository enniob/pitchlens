// @vitest-environment happy-dom
import { act, useState } from "react";
import type { Audience } from "@/explain/api";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplanationPanel, explanationsUpTo, type SavedExplanation } from "@/components/ExplanationPanel";
import { sampleFixture } from "@/match/fixture";
import { extractMatchContext } from "@/explain/context";
import { insufficientEvidence } from "@/explain/response";
import { recordedSummary } from "@/explain/recorded";
import { formatClock } from "@/components/format";
import type { PlaybackPhase } from "@/components/ScoreBug";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
const pause = vi.fn();
const replay = vi.fn();
// The viewer owns the audience and the saved explanations; this stands in for it.
function Harness({ timeMs, playback }: { timeMs: number; playback: PlaybackPhase }) {
  const [audience, setAudience] = useState<Audience>("casual");
  const [saved, setSaved] = useState<SavedExplanation[]>([]);
  const [shownId, setShownId] = useState<string | null>(null);
  return <ExplanationPanel fixture={sampleFixture} timeMs={timeMs} playback={playback} audience={audience} onAudience={setAudience}
    onPause={pause} onReplayFrom={replay} saved={saved} shownId={shownId} onSaved={(x) => setSaved((list) => [...list, x])} onShow={setShownId} />;
}
function render(timeMs = 9_400, playback: PlaybackPhase = "playing") {
  return act(async () => { root.render(<Harness timeMs={timeMs} playback={playback} />); });
}
function button(text: string) {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
const click = (text: string) => act(async () => button(text).click());
/** The answer on screen; the history list below it may name the same explanation. */
const answerText = () => container.querySelector(".explain__answer")?.textContent ?? "";
const historyText = () => container.querySelector(".explain__history")?.textContent ?? "";
function response(timeMs = 9_400, audience = "casual") {
  const explanation = insufficientEvidence(extractMatchContext(sampleFixture, timeMs), "Only synthetic evidence is available.");
  return { apiVersion: "1.0.0", ok: true, matchId: sampleFixture.matchId, timeMs, audience, explanation };
}

beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  pause.mockClear(); replay.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("explanation panel interaction", () => {
  it("pauses, shows insufficient evidence, and explicitly requests each audience", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(response(request.timeMs, request.audience)));
    });
    vi.stubGlobal("fetch", fetcher);
    await render(); await click("Pause and explain");
    expect(pause).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Not enough evidence");
    await click("Analyst");
    expect(answerText()).toBe("");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await click("Pause and explain");
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).audience).toBe("analyst");
  });

  it("aborts and ignores an old answer when seeking backwards", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((r) => { resolve = r; }));
    vi.stubGlobal("fetch", fetcher);
    await render(); await click("Pause and explain");
    expect(button("Explaining…").disabled).toBe(true);
    await render(9_000);
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    await act(async () => resolve(new Response(JSON.stringify(response()))));
    expect(container.textContent).not.toContain("Not enough evidence");
    expect(button("Pause and explain").disabled).toBe(false);
  });

  it("cancels on audience changes and on close", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetcher);
    await render(); await click("Pause and explain"); await click("Analyst");
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    await click("Pause and explain"); await act(async () => root.render(null));
    expect(fetcher.mock.calls[1]![1]?.signal?.aborted).toBe(true);
  });

  it("allows a new request after Cancel and ignores the cancelled response", async () => {
    let finishOld!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((r) => { finishOld = r; }))
      .mockImplementation(async () => {
        const body = response(); body.explanation.headline = "Current answer";
        return new Response(JSON.stringify(body));
      });
    vi.stubGlobal("fetch", fetcher);
    await render(); await click("Pause and explain"); await click("Cancel");
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    await click("Pause and explain");
    await act(async () => finishOld(new Response(JSON.stringify(response()))));
    expect(container.textContent).toContain("Current answer");
    expect(container.textContent).not.toContain("Not enough evidence to explain");
  });

  it("renders a safe failure and allows an explicit retry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: "timeout" } }), { status: 504 }))
      .mockImplementation(async () => new Response(JSON.stringify(response())));
    vi.stubGlobal("fetch", fetcher);
    await render(); await click("Pause and explain");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("took too long");
    await click("Try again"); expect(container.textContent).toContain("Not enough evidence");
  });

  it("distinguishes a verification failure from genuine insufficient evidence", async () => {
    const body = { ...response(), verification: { outcome: "fallback" } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await render(); await click("Pause and explain");
    expect(container.textContent).toContain("This explanation didn't pass our checks");
    expect(container.textContent).not.toContain("Not enough evidence");
    expect(button("Try again").disabled).toBe(false);
  });

  it("shows recorded facts and replay evidence when AI checks fail, and keeps retry available", async () => {
    const summary = recordedSummary(extractMatchContext(sampleFixture, 9_400))!;
    const body = { ...response(), verification: { outcome: "fallback" }, recordedSummary: summary };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await render(); await click("Pause and explain");
    expect(answerText()).toContain("Match data summary");
    expect(answerText()).toContain(summary.explanation);
    expect(answerText()).toContain("AI interpretation is unavailable");
    expect(answerText()).not.toContain("AI explanation.");
    expect(answerText()).not.toContain("Not shown: failed checks");
    expect(button("Try again").disabled).toBe(false);
    const event = sampleFixture.events.find(e => e.id === (summary.facts[0]!.evidence[0] as { id: string }).id)!;
    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="Replay event at ${formatClock(event.t)}"]`)!.click());
    expect(replay).toHaveBeenCalledWith(Math.max(0, event.t - 3_000));
  });

  it("replays a cited event and keeps interpretation separate from facts", async () => {
    const body = response();
    const event = sampleFixture.events.find((e) => e.type === "goal")!;
    body.explanation.status = "explained";
    body.explanation.facts = [{ text: "A goal was recorded.", evidence: [{ kind: "event", id: event.id }] }];
    body.explanation.interpretation = [{ text: "This may illustrate an attacking pattern.", evidence: [{ kind: "event", id: event.id }] }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await render(); await click("Pause and explain");
    expect(container.textContent).toContain("Observable facts"); expect(container.textContent).toContain("Tactical interpretation");
    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="Replay event at ${formatClock(event.t)}"]`)!.click());
    expect(replay).toHaveBeenCalledWith(Math.max(0, event.t - 3_000));
    // Replaying cited evidence rewinds playback but keeps the explanation on screen.
    await render(Math.max(0, event.t - 3_000));
    expect(container.textContent).toContain("A goal was recorded.");
    expect(container.textContent).toContain("Replaying cited evidence");
  });

  it("keeps the same button while the clock runs, so a click during playback lands", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response(9_700)))));
    await render(9_400);
    const before = button("Pause and explain");
    await render(9_550); await render(9_700);
    expect(button("Pause and explain")).toBe(before);
    await click("Pause and explain");
    expect(pause).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Not enough evidence");
  });

  it("marks an answer stale when play moves on and hides it on a backward seek", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response()))));
    await render(); await click("Pause and explain");
    await render(12_000);
    expect(container.textContent).toContain("Not enough evidence");
    expect(container.textContent).toContain("Play has moved on");
    await render(9_000);
    expect(container.textContent).not.toContain("Not enough evidence");
    // Hidden, not lost: back past its time it is listed again, but not reopened by itself.
    await render(12_000);
    expect(answerText()).toBe("");
    expect(historyText()).toContain("Casual Fan");
  });

  it("only offers to pause while the match is playing", async () => {
    await render(9_400, "playing"); button("Pause and explain");
    await render(9_400, "paused"); button("Explain this moment");
    await render(24_000, "ended"); button("Explain this moment");
    expect(container.textContent).toContain("Full time");
    expect(container.textContent).not.toContain("Pause and explain");
  });

  it("closes an answer on request and keeps it in the history", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response()))));
    await render(); await click("Pause and explain");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close explanation"]')!.click());
    expect(answerText()).toBe("");
    expect(historyText()).toContain(formatClock(9_400));
  });
});

describe("explanation history", () => {
  function headlined(headline: string) {
    return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const body = response(request.timeMs, request.audience); body.explanation.headline = `${headline} at ${request.timeMs}`;
      return new Response(JSON.stringify(body));
    });
  }
  const savedItem = (title: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>(".explain__saved")].find((b) => b.textContent?.includes(title));
    if (!found) throw new Error(`Missing saved explanation: ${title}`);
    return found;
  };

  it("keeps every explanation and reopens an earlier one", async () => {
    vi.stubGlobal("fetch", headlined("Answer"));
    await render(9_400); await click("Pause and explain");
    await render(12_000); await click("Pause and explain");
    expect(answerText()).toContain("Answer at 12000");
    await act(async () => savedItem("Answer at 9400").click());
    expect(answerText()).toContain("Answer at 9400");
    expect(answerText()).toContain("Play has moved on");
    expect(historyText()).toContain("Answer at 12000");
  });

  it("never lists an explanation asked for later than the current time", async () => {
    vi.stubGlobal("fetch", headlined("Answer"));
    await render(9_400); await click("Pause and explain");
    await render(9_000);
    expect(container.textContent).not.toContain("Answer at 9400");
    await render(9_400);
    expect(historyText()).toContain("Answer at 9400");
  });

  it("switching audience keeps the other audience's answer to switch back to", async () => {
    const fetcher = headlined("Answer");
    vi.stubGlobal("fetch", fetcher);
    await render(); await click("Pause and explain");
    await click("Analyst");
    expect(answerText()).toBe("");
    expect(historyText()).toContain("Casual Fan");
    await click("Casual Fan");
    expect(answerText()).toContain("Answer at 9400");
    // Opening a saved answer for the other audience switches to it, without asking again.
    await click("Analyst");
    await act(async () => savedItem("Answer at 9400").click());
    expect(answerText()).toContain("Casual Fan · explained at");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("filters saved explanations by time, newest first", () => {
    const item = (atMs: number) => ({ id: String(atMs), atMs, audience: "casual" as const, result: {} as SavedExplanation["result"] });
    expect(explanationsUpTo([item(5_000), item(12_000), item(9_000)], 9_000).map((s) => s.atMs)).toEqual([9_000, 5_000]);
  });
});
