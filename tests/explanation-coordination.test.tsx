// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Audience } from "@/explain/api";
import { extractMatchContext } from "@/explain/context";
import { insufficientEvidence } from "@/explain/response";
import { ExplanationAccessContext } from "@/components/ExplanationAccessGate";
import { ExplanationPanel, type SavedExplanation } from "@/components/ExplanationPanel";
import { ExplanationSchedulerScope } from "@/components/ExplanationScheduler";
import { Recap } from "@/components/Recap";
import type { PlaybackPhase } from "@/components/ScoreBug";
import { sampleFixture } from "@/match/fixture";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
let savedList: SavedExplanation[] = [];
const END = sampleFixture.durationMs;
const goal = sampleFixture.events.find((e) => e.type === "goal")!;

interface Body { timeMs: number; audience: Audience; focus?: "match" }
interface Call { body: Body; signal: AbortSignal; answer: (override?: object, status?: number) => void }

function response(body: Body) {
  const explanation = insufficientEvidence(extractMatchContext(sampleFixture, body.timeMs), "Only synthetic evidence is available.");
  explanation.headline = `Insight at ${body.timeMs} (${body.audience})`;
  return { apiVersion: "1.0.0", ok: true, matchId: sampleFixture.matchId, ...body, explanation };
}
/** An explanation endpoint that answers only when the test says so. */
function heldServer() {
  const calls: Call[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise<Response>((resolve, reject) => {
    const { match: _match, ...body } = JSON.parse(String(init?.body)) as Body & { match: unknown };
    const signal = init!.signal!;
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    calls.push({ body, signal, answer: (override, status = 200) => resolve(new Response(JSON.stringify(override ?? response(body)), { status })) });
  }));
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, calls };
}

function Harness({ timeMs, playback, allowed, recap }: { timeMs: number; playback: PlaybackPhase; allowed: boolean; recap: boolean }) {
  const [audience, setAudience] = useState<Audience>("casual");
  const [saved, setSaved] = useState<SavedExplanation[]>([]);
  const [shownId, setShownId] = useState<string | null>(null);
  savedList = saved;
  return (
    <ExplanationAccessContext.Provider value={allowed}>
      {/* One scope for the whole viewer, as the match viewer provides. */}
      <ExplanationSchedulerScope>
        <ExplanationPanel fixture={sampleFixture} timeMs={timeMs} playback={playback} audience={audience} onAudience={setAudience}
          onPause={() => {}} onReplayFrom={() => {}} saved={saved} shownId={shownId}
          onSaved={(x) => setSaved((list) => [...list.filter((y) => y.id !== x.id), x])} onShow={setShownId} />
        {recap && <Recap fixture={sampleFixture} audience={audience} onAudience={setAudience} onReplayFrom={() => {}} />}
      </ExplanationSchedulerScope>
    </ExplanationAccessContext.Provider>
  );
}

let view = { timeMs: 0, playback: "ready" as PlaybackPhase, allowed: true, recap: false };
const render = (next: Partial<typeof view>) => {
  view = { ...view, ...next };
  return act(async () => { root.render(<Harness {...view} />); });
};
/** Plays from `from` to `to` in natural steps, the way the viewer's clock advances. */
async function play(from: number, to: number) {
  for (let t = from; t < to; t = Math.min(to, t + 500)) await render({ timeMs: t, playback: "playing" });
  await render({ timeMs: to, playback: "playing" });
}
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
function button(text: string) {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
const click = (text: string) => act(async () => button(text).click());
const text = () => container.textContent ?? "";
/** Pauses at `timeMs` and asks "Explain this moment". */
async function explainAt(timeMs: number) {
  await render({ timeMs, playback: "paused" });
  await click("Explain this moment");
}

beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  savedList = [];
  view = { timeMs: 0, playback: "ready", allowed: true, recap: false };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("shared explanation scheduling", () => {
  it("holds a manual explanation until the running automatic insight finishes", async () => {
    const { fetcher, calls } = heldServer();
    await play(8_000, 10_000);
    expect(calls.map((c) => c.body.timeMs)).toEqual([goal.t]);
    await explainAt(12_000);
    // Not sent alongside the insight, so the server never answers "busy".
    expect(fetcher).toHaveBeenCalledOnce();
    expect(text()).toContain("Waiting for the current insight");
    calls[0]!.answer();
    await flush();
    expect(calls.map((c) => c.body)).toEqual([{ timeMs: goal.t, audience: "casual" }, { timeMs: 12_000, audience: "casual" }]);
    expect(text()).toContain("Reading the evidence up to");
    calls[1]!.answer();
    await flush();
    expect(savedList.map((s) => s.atMs).sort()).toEqual([goal.t, 12_000].sort());
  });

  it("sends a waiting manual explanation and the recap before a waiting automatic insight", async () => {
    const { calls } = heldServer();
    await explainAt(8_000);
    expect(calls).toHaveLength(1);
    await play(8_000, 10_000);
    // The insight for the goal is waiting, not sent.
    expect(calls).toHaveLength(1);
    expect(text()).toContain("Waiting for another explanation to finish");
    await render({ recap: true });
    expect(calls).toHaveLength(1);
    // The running request is never interrupted for priority.
    expect(calls[0]!.signal.aborted).toBe(false);
    calls[0]!.answer(); await flush();
    expect(calls[1]!.body).toEqual({ timeMs: END, audience: "casual", focus: "match" });
    calls[1]!.answer(); await flush();
    expect(calls[2]!.body).toEqual({ timeMs: goal.t, audience: "casual" });
    calls[2]!.answer(); await flush();
    expect(calls).toHaveLength(3);
  });

  it("drops a waiting insight when seeking back before its moment", async () => {
    const { fetcher, calls } = heldServer();
    await explainAt(8_000);
    await play(8_000, 10_000);
    await render({ timeMs: 8_500, playback: "paused" });
    calls[0]!.answer(); await flush();
    // The manual answer arrives; the abandoned insight is never sent.
    expect(fetcher).toHaveBeenCalledOnce();
    expect(savedList.map((s) => s.atMs)).toEqual([8_000]);
  });

  it("drops a waiting manual explanation when seeking back before its time", async () => {
    const { fetcher, calls } = heldServer();
    await play(8_000, 10_000);
    await explainAt(12_000);
    await render({ timeMs: 11_000, playback: "paused" });
    expect(button("Explain this moment").disabled).toBe(false);
    calls[0]!.answer(); await flush();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(savedList.map((s) => s.atMs)).toEqual([goal.t]);
  });

  it("never sends a waiting manual explanation when seeking back before it and the running insight", async () => {
    const { fetcher, calls } = heldServer();
    await play(8_000, 10_000);
    await explainAt(12_000);
    // Seeking back abandons the insight first; the manual request it would free the slot for must not go out.
    await render({ timeMs: 5_000, playback: "paused" });
    await flush();
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    await click("Explain this moment");
    expect(calls[1]!.body).toEqual({ timeMs: 5_000, audience: "casual" });
  });

  it("drops running and waiting requests when AI access locks, and never sends the abandoned manual one", async () => {
    const { calls } = heldServer();
    await play(8_000, 10_000);
    await explainAt(12_000);
    await render({ recap: true });
    expect(calls).toHaveLength(1);
    await render({ allowed: false });
    await flush();
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls).toHaveLength(1);
    // Unlocking resumes the missed insight and the recap, one at a time; the cancelled manual request stays cancelled.
    await render({ allowed: true });
    expect(calls).toHaveLength(2);
    calls[1]!.answer(); await flush();
    calls[2]?.answer(); await flush();
    expect(calls.map((c) => c.body)).toEqual([
      { timeMs: goal.t, audience: "casual" },
      { timeMs: goal.t, audience: "casual" },
      { timeMs: END, audience: "casual", focus: "match" },
    ]);
  });

  it("moves on to the next request after a failure", async () => {
    const { calls } = heldServer();
    await play(8_000, 10_000);
    await explainAt(12_000);
    calls[0]!.answer({ ok: false, error: { code: "busy" } }, 503);
    await flush();
    expect(text()).toContain("The explanation service is busy. Try again shortly.");
    expect(calls[1]!.body).toEqual({ timeMs: 12_000, audience: "casual" });
    calls[1]!.answer(); await flush();
    expect(savedList.map((s) => s.atMs)).toEqual([12_000]);
  });

  it("moves on after Cancel, and a cancelled waiting request is never sent", async () => {
    const { fetcher, calls } = heldServer();
    await play(8_000, 10_000);
    await explainAt(12_000);
    await click("Cancel");
    calls[0]!.answer(); await flush();
    expect(fetcher).toHaveBeenCalledOnce();
    await click("Explain this moment");
    expect(calls[1]!.body).toEqual({ timeMs: 12_000, audience: "casual" });
    // Cancelling the running request frees the queue at once.
    await click("Cancel");
    expect(calls[1]!.signal.aborted).toBe(true);
    await click("Explain this moment");
    expect(calls).toHaveLength(3);
  });

  it("keeps the selected-time cutoff and response checks for a request that waited", async () => {
    const { calls } = heldServer();
    await play(8_000, 10_000);
    await explainAt(12_000);
    // Play moves on while the explanation waits; it still asks about 12 s only.
    await play(12_000, 14_000);
    calls[0]!.answer(); await flush();
    expect(calls[1]!.body.timeMs).toBe(12_000);
    // An answer for a later time is refused, not shown.
    calls[1]!.answer(response({ timeMs: 14_000, audience: "casual" }));
    await flush();
    expect(text()).toContain("The explanation does not match the selected moment.");
    expect(savedList.map((s) => s.atMs)).toEqual([goal.t]);
  });

  it("asks once per moment while an insight waits, replacing it with the newest", async () => {
    const { calls } = heldServer();
    await explainAt(8_000);
    await play(8_000, 10_000);
    // Asking for the same waiting insight again does not queue a duplicate.
    expect(calls).toHaveLength(1);
    calls[0]!.answer(); await flush();
    calls[1]!.answer(); await flush();
    await play(10_000, 12_000);
    expect(calls).toHaveLength(2);
  });
});
