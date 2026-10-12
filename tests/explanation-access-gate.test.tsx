// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Audience, ExplainSuccess } from "@/explain/api";
import { extractMatchContext } from "@/explain/context";
import { insufficientEvidence } from "@/explain/response";
import { ExplanationAccessContext, ExplanationAccessGate, LOCKED_HINT, useExplanationAccess } from "@/components/ExplanationAccessGate";
import { ExplanationPanel, type SavedExplanation } from "@/components/ExplanationPanel";
import { Recap } from "@/components/Recap";
import type { PlaybackPhase } from "@/components/ScoreBug";
import { sampleFixture } from "@/match/fixture";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
const pause = vi.fn();
let savedList: SavedExplanation[] = [];
const END = sampleFixture.durationMs;
const goal = sampleFixture.events.find((e) => e.type === "goal")!;

function response(timeMs: number, audience: string, focus?: "match") {
  const explanation = insufficientEvidence(extractMatchContext(sampleFixture, timeMs), "Only synthetic evidence is available.");
  explanation.headline = `Insight at ${timeMs} (${audience})`;
  return { apiVersion: "1.0.0", ok: true, matchId: sampleFixture.matchId, timeMs, audience, ...(focus ? { focus } : {}), explanation };
}
/** Explanation requests only: the session endpoint is never called by the consumers. */
function explainServer(hold = false) {
  const pending: { signal?: AbortSignal | null; resolve: () => void }[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation((url, init) => {
    expect(url).toBe("/api/explain");
    const body = JSON.parse(String(init?.body)) as { timeMs: number; audience: string; focus?: "match" };
    const answer = () => new Response(JSON.stringify(response(body.timeMs, body.audience, body.focus)));
    if (!hold) return Promise.resolve(answer());
    return new Promise((resolve) => { pending.push({ signal: init?.signal, resolve: () => resolve(answer()) }); });
  });
  return { fetcher, pending };
}
const requestOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as { timeMs: number; audience: Audience };

function Panel({ timeMs, playback }: { timeMs: number; playback: PlaybackPhase }) {
  const [audience, setAudience] = useState<Audience>("casual");
  const [saved, setSaved] = useState<SavedExplanation[]>([]);
  const [shownId, setShownId] = useState<string | null>(null);
  savedList = saved;
  return <ExplanationPanel fixture={sampleFixture} timeMs={timeMs} playback={playback} audience={audience} onAudience={setAudience}
    onPause={pause} onReplayFrom={() => {}} saved={saved} shownId={shownId}
    onSaved={(x) => setSaved((list) => [...list.filter((y) => y.id !== x.id), x])} onShow={setShownId} />;
}
let state = { allowed: false, timeMs: 0, playback: "playing" as PlaybackPhase };
const render = (next: Partial<typeof state> = {}) => {
  state = { ...state, ...next };
  return act(async () => {
    root.render(<ExplanationAccessContext.Provider value={state.allowed}><Panel timeMs={state.timeMs} playback={state.playback} /></ExplanationAccessContext.Provider>);
  });
};
async function play(from: number, to: number) {
  for (let t = from; t < to; t = Math.min(to, t + 500)) await render({ timeMs: t, playback: "playing" });
  await render({ timeMs: to, playback: "playing" });
}
function button(text: string) {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
const text = () => container.textContent ?? "";
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  pause.mockClear(); savedList = []; state = { allowed: false, timeMs: 0, playback: "playing" };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("explanation access gate", () => {
  it("defaults to allowed for components rendered on their own", async () => {
    let seen: boolean | undefined;
    function Probe() { seen = useExplanationAccess(); return null; }
    await act(async () => root.render(<Probe />));
    expect(seen).toBe(true);
  });

  it("starts locked and opens only once the session check says this browser is signed in", async () => {
    let answer!: (r: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(new Promise((r) => { answer = r; }));
    vi.stubGlobal("fetch", fetcher);
    const seen: boolean[] = [];
    function Probe() { seen.push(useExplanationAccess()); return null; }
    await act(async () => root.render(<ExplanationAccessGate><Probe /></ExplanationAccessGate>));
    expect(seen.at(-1)).toBe(false);
    expect(container.querySelector("[aria-label='AI explanation access']")).not.toBeNull();
    await act(async () => answer(new Response(JSON.stringify({ ok: true, required: true, authenticated: true, available: true }))));
    expect(seen.at(-1)).toBe(true);
    // One status check for the whole page; consumers never fetch it themselves.
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("stays locked when the service is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, required: false, authenticated: true, available: false }))));
    const seen: boolean[] = [];
    function Probe() { seen.push(useExplanationAccess()); return null; }
    await act(async () => root.render(<ExplanationAccessGate><Probe /></ExplanationAccessGate>));
    await settle();
    expect(seen.every((v) => v === false)).toBe(true);
  });
});

describe("live insights while locked", () => {
  it("makes no request, disables the buttons and says why, while play continues", async () => {
    const { fetcher } = explainServer();
    vi.stubGlobal("fetch", fetcher);
    await play(8_000, 10_000);
    expect(fetcher).not.toHaveBeenCalled();
    expect(container.querySelector(".explain [role=status]")?.textContent).toBe(LOCKED_HINT);
    expect(button("Explain for Casual Fan").disabled).toBe(true);
    expect(button("Pause and explain").disabled).toBe(true);
    await act(async () => { button("Pause and explain").click(); button("Explain for Casual Fan").click(); });
    expect(fetcher).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it("explains the moment missed while locked once access is unlocked", async () => {
    const { fetcher } = explainServer();
    vi.stubGlobal("fetch", fetcher);
    await play(8_000, 10_000);
    await render({ allowed: true });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(requestOf(fetcher.mock.calls[0]!)).toMatchObject({ timeMs: goal.t, audience: "casual" });
    expect(text()).toContain(`Insight at ${goal.t} (casual)`);
    expect(text()).not.toContain(LOCKED_HINT);
    expect(button("Pause and explain").disabled).toBe(false);
  });

  it("does not resume a missed moment the viewer has since seeked back before", async () => {
    const { fetcher } = explainServer();
    vi.stubGlobal("fetch", fetcher);
    await play(8_000, 10_000);
    await render({ timeMs: 5_000 });
    await render({ allowed: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels an automatic request on lock, keeps saved answers, and resumes on unlock", async () => {
    const { fetcher, pending } = explainServer(true);
    vi.stubGlobal("fetch", fetcher);
    await render({ allowed: true });
    await play(8_000, 10_000);
    expect(pending).toHaveLength(1);
    expect(text()).toContain("Reading the evidence");
    await render({ allowed: false });
    expect(pending[0]!.signal?.aborted).toBe(true);
    expect(text()).not.toContain("Reading the evidence");
    // A late answer to the cancelled request is ignored.
    await act(async () => pending[0]!.resolve());
    expect(savedList).toEqual([]);
    // Playback carries on while locked without new requests.
    await play(10_000, 14_000);
    expect(pending).toHaveLength(1);

    await render({ allowed: true });
    expect(pending).toHaveLength(2);
    expect(requestOf(fetcher.mock.calls[1]!).timeMs).toBe(goal.t);
    await act(async () => pending[1]!.resolve());
    expect(text()).toContain(`Insight at ${goal.t} (casual)`);

    // Locking again keeps the answer already shown.
    await render({ allowed: false });
    expect(text()).toContain(`Insight at ${goal.t} (casual)`);
    expect(savedList).toHaveLength(1);
  });
});

describe("asking about a moment while locked", () => {
  it("cancels a pending explanation on lock and keeps earlier answers", async () => {
    const { fetcher, pending } = explainServer(true);
    vi.stubGlobal("fetch", fetcher);
    await render({ allowed: true, timeMs: 4_000, playback: "paused" });
    await act(async () => button("Explain this moment").click());
    await act(async () => pending[0]!.resolve());
    expect(text()).toContain("Insight at 4000 (casual)");

    await render({ timeMs: 5_000 });
    await act(async () => button("Explain this moment").click());
    expect(text()).toContain("Reading the evidence up to");
    await render({ allowed: false });
    expect(pending[1]!.signal?.aborted).toBe(true);
    expect(text()).not.toContain("Reading the evidence up to");
    await act(async () => pending[1]!.resolve());
    expect(savedList.map((s) => s.atMs)).toEqual([4_000]);
    expect(text()).toContain("Insight at 4000 (casual)");
    expect(button("Explain this moment").disabled).toBe(true);

    await render({ allowed: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(button("Explain this moment").disabled).toBe(false);
  });
});

describe("full-time summary while locked", () => {
  const renderRecap = (allowed: boolean, summaries?: Partial<Record<Audience, ExplainSuccess>>) => act(async () => {
    root.render(<ExplanationAccessContext.Provider value={allowed}>
      <Recap fixture={sampleFixture} audience="casual" onAudience={() => {}} onReplayFrom={() => {}} summaries={summaries} />
    </ExplanationAccessContext.Provider>);
  });

  it("asks for nothing while locked and asks once unlocked", async () => {
    const { fetcher } = explainServer();
    vi.stubGlobal("fetch", fetcher);
    await renderRecap(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(container.querySelector(".recap__story")?.textContent).toContain(LOCKED_HINT);
    // Replays are not AI requests and stay available.
    expect(container.querySelector<HTMLButtonElement>(".recap__replay")?.disabled).toBe(false);
    await renderRecap(true);
    await settle();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(requestOf(fetcher.mock.calls[0]!)).toMatchObject({ timeMs: END, focus: "match" });
    expect(text()).toContain(`Insight at ${END} (casual)`);
  });

  it("cancels a loading summary on lock, keeps a shown one, and disables Try again", async () => {
    const { fetcher, pending } = explainServer(true);
    vi.stubGlobal("fetch", fetcher);
    await renderRecap(true);
    expect(pending).toHaveLength(1);
    await renderRecap(false);
    expect(pending[0]!.signal?.aborted).toBe(true);
    expect(container.querySelector(".recap__story")?.textContent).toContain(LOCKED_HINT);

    await renderRecap(true);
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]!.resolve());
    expect(text()).toContain(`Insight at ${END} (casual)`);
    // The summary on screen stays and is not asked for again across lock and unlock.
    await renderRecap(false);
    expect(text()).toContain(`Insight at ${END} (casual)`);
    await renderRecap(true);
    expect(pending).toHaveLength(2);
  });

  it("reuses a saved summary without asking, even while locked", async () => {
    const { fetcher } = explainServer();
    vi.stubGlobal("fetch", fetcher);
    await renderRecap(false, { casual: response(END, "casual", "match") as unknown as ExplainSuccess });
    expect(text()).toContain(`Insight at ${END} (casual)`);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("disables Try again on a failed summary while locked", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code: "rate-limited" } }), { status: 429 })));
    await renderRecap(true);
    await settle();
    expect(button("Try again").disabled).toBe(false);
    await renderRecap(false);
    expect(button("Try again").disabled).toBe(true);
    expect(container.querySelector(".recap__story")?.textContent).toContain(LOCKED_HINT);
  });
});
