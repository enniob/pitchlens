// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExplainApiResponse, ExplainSuccess } from "@/explain/api";
import { requestExplanation } from "@/explain/client";
import { extractMatchContext } from "@/explain/context";
import { EvidenceSession } from "@/explain/evidence";
import { checkGrounding } from "@/explain/grounding";
import { analystInstructions } from "@/explain/prompts";
import type { ExplanationResponse } from "@/explain/response";
import { sampleFixture } from "@/match/fixture";
import { recapMoments } from "@/playback/recap";
import { statisticsAt } from "@/playback/statistics";
import { generateMatch } from "@/simulation/generate";
import { handleExplain, type ExplainDeps } from "@/server/explainHandler";
import { AnswerCache, RequestGuard } from "@/server/guard";
import { MatchViewer } from "@/components/MatchViewer";
import { Recap } from "@/components/Recap";
import { formatClock } from "@/components/format";
import { answer, approve, FakeModel } from "./support/fakeModel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const END = sampleFixture.durationMs;
/** A valid full-time summary of the scripted demo. */
const summary = (): ExplanationResponse => ({
  explanationVersion: "1.0.0",
  matchId: sampleFixture.matchId,
  timeMs: END,
  status: "explained",
  headline: "Harbor City win 1–0",
  explanation: "Harbor City's number 9 scored at 9.4 s, and the match finished 1–0.",
  facts: [{ text: "#9 scored at 9.4 s, making it 1–0.", evidence: [{ kind: "event", id: "e6-goal" }] }],
  interpretation: [],
  limitations: [],
});

// A three-minute match whose goals (0:59 and 1:25) are far outside the normal 30 s window at full time.
const long = generateMatch({ seed: 0, durationMs: 180_000 });
const longGoals = long.events.filter((e) => e.type === "goal");

describe("recap moments", () => {
  it("picks the goal and the turnover that started the demo's move, oldest first", () => {
    expect(recapMoments(sampleFixture).map((e) => e.id)).toEqual(["e1-turnover", "e6-goal"]);
  });

  it("keeps one card per passage of play, prefers goals and stops at three", () => {
    const picked = recapMoments(long);
    expect(picked.length).toBeLessThanOrEqual(3);
    for (const goal of longGoals) expect(picked).toContain(goal);
    for (let i = 1; i < picked.length; i++) expect(picked[i]!.t - picked[i - 1]!.t).toBeGreaterThanOrEqual(3_000);
  });
});

describe("full-time summary evidence", () => {
  it("starts from the key events of the whole match, not just the last 30 seconds", () => {
    const moment = new EvidenceSession(long, long.durationMs);
    const match = new EvidenceSession(long, long.durationMs, "match");
    for (const goal of longGoals) {
      expect(moment.base.events.some((e) => e.id === goal.id)).toBe(false);
      expect(match.base.events.some((e) => e.id === goal.id)).toBe(true);
    }
    expect(match.base.events.every((e) => e.type !== "pass")).toBe(true);
    expect(match.base.limitations.map((l) => l.code)).toContain("events-filtered");
    expect(match.floorMs).toBe(0);
  });

  it("still never includes anything after the selected time", () => {
    const at = longGoals[0]!.t - 1;
    const session = new EvidenceSession(long, at, "match");
    expect(session.base.events.every((e) => e.t <= at)).toBe(true);
    const listed = session.call("list_events", JSON.stringify({ fromMs: 0 }));
    expect(listed.ok && listed.events.every((id) => long.events.find((e) => e.id === id)!.t <= at)).toBe(true);
  });

  it("rejects a window start outside the match", () => {
    expect(() => extractMatchContext(sampleFixture, 9_000, { windowStartMs: 9_001 })).toThrow(RangeError);
    expect(() => extractMatchContext(sampleFixture, 9_000, { windowStartMs: -1 })).toThrow(RangeError);
  });

  it("lets a summary mention a score the match passed through, but a moment only the current score", () => {
    const context = new EvidenceSession(long, long.durationMs, "match").context();
    const draft: ExplanationResponse = {
      ...summary(),
      matchId: long.matchId,
      timeMs: long.durationMs,
      headline: "A 1–0 lead",
      explanation: "The first goal made it 1–0.",
      facts: [{ text: "A goal was scored.", evidence: [{ kind: "event", id: longGoals[0]!.id }] }],
    };
    expect(checkGrounding(draft, context, "casual", "match")).toEqual([]);
    expect(checkGrounding(draft, context, "casual").join("\n")).toMatch(/mentions the score 1–0/);
  });

  it("asks the analyst to tell the match in order instead of focusing on the latest event", () => {
    expect(analystInstructions("casual", "match")).toMatch(/full-time summary/);
    expect(analystInstructions("casual", "match")).not.toMatch(/most recent revealed event/);
    expect(analystInstructions("casual")).toMatch(/most recent revealed event/);
  });
});

describe("POST /api/explain with focus", () => {
  const ENV = { FOUNDRY_ENDPOINT: "https://r.openai.azure.com", FOUNDRY_API_KEY: "k", FOUNDRY_DEPLOYMENT: "d" };
  const setup = (steps: ReturnType<typeof answer>[] = []) => {
    const model = new FakeModel(steps);
    const deps: ExplainDeps = { env: ENV, createClient: () => model, guard: new RequestGuard(), cache: new AnswerCache(), log: () => {} };
    return { model, deps };
  };
  const post = (body: unknown) =>
    new Request("https://pitchlens.example/api/explain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const base = { match: { kind: "sample", matchId: sampleFixture.matchId }, audience: "casual" };

  it("answers a full-time summary and says which focus it answered", async () => {
    const draft = summary();
    const { deps, model } = setup([answer(draft), approve(draft)]);
    const response = await handleExplain(post({ ...base, timeMs: END, focus: "match" }), deps);
    const json = (await response.json()) as ExplainApiResponse;
    expect(response.status).toBe(200);
    expect(json).toMatchObject({ ok: true, focus: "match", timeMs: END, verification: { outcome: "verified" } });
    expect(String(model.requests[0]!.messages[0]!.content)).toMatch(/full-time summary/);
  });

  it("refuses a summary before full time, so it cannot describe play not yet reached", async () => {
    const { deps, model } = setup();
    const response = await handleExplain(post({ ...base, timeMs: END - 1, focus: "match" }), deps);
    expect(response.status).toBe(400);
    expect(((await response.json()) as ExplainApiResponse).ok).toBe(false);
    expect(model.requests).toHaveLength(0);
  });

  it("rejects an unknown focus and defaults to the moment", async () => {
    const { deps } = setup();
    expect((await handleExplain(post({ ...base, timeMs: END, focus: "season" }), deps)).status).toBe(400);
    const draft = { ...summary(), timeMs: 9_400, headline: "A goal", explanation: "#9 scored at 9.4 s, making it 1–0." };
    const moment = setup([answer(draft), approve(draft)]);
    const json = (await (await handleExplain(post({ ...base, timeMs: 9_400 }), moment.deps)).json()) as ExplainApiResponse;
    expect(json).toMatchObject({ ok: true, focus: "moment" });
  });
});

describe("browser client focus", () => {
  const ok = (focus?: string) => ({ apiVersion: "1.0.0", ok: true, matchId: sampleFixture.matchId, timeMs: END, audience: "casual", ...(focus ? { focus } : {}), explanation: summary(), verification: { outcome: "verified" } });

  it("sends focus only for a summary and checks the answer is for the same focus", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(ok("match"))));
    await requestExplanation(sampleFixture, sampleFixture.matchId, END, "casual", new AbortController().signal, fetcher, "match");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).focus).toBe("match");
    const wrong = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(ok("moment"))));
    await expect(requestExplanation(sampleFixture, sampleFixture.matchId, END, "casual", new AbortController().signal, wrong, "match")).rejects.toThrow(/does not match/);
  });
});

describe("recap view", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is locked until play reaches full time", () => {
    const html = renderToStaticMarkup(<MatchViewer fixture={sampleFixture} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="The recap opens at full time"[^>]*>Recap/);
    expect(html).toContain("Understand this moment");
  });

  it("shows the defining moments and final numbers, and summarises the match from full-time evidence", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      apiVersion: "1.0.0", ok: true, matchId: sampleFixture.matchId, timeMs: END, audience: "casual", focus: "match",
      explanation: summary(), verification: { outcome: "verified" },
    })));
    vi.stubGlobal("fetch", fetcher);
    const replay = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Recap fixture={sampleFixture} audience="casual" onAudience={() => {}} onReplayFrom={replay} />));
    expect(container.textContent).toContain("Two moments that shaped the result.");
    expect(container.textContent).toContain("Harbor City win 1–0");
    expect(container.textContent).toContain("Evidence checked");
    const request = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(request).toMatchObject({ timeMs: END, focus: "match" });
    const goal = sampleFixture.events.find((e) => e.id === "e6-goal")!;
    await act(async () => [...container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Replay moment"))[1]!.click());
    expect(replay).toHaveBeenCalledWith(goal.t - 3_000);
    await act(async () => root.unmount());
    container.remove();
  });

  it("lays out the scoreline, labelled replays, the cited events and real full-time numbers", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      apiVersion: "1.0.0", ok: true, matchId: sampleFixture.matchId, timeMs: END, audience: "analyst", focus: "match",
      explanation: summary(), verification: { outcome: "verified" },
    }))));
    const replay = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Recap fixture={sampleFixture} audience="analyst" onAudience={() => {}} onReplayFrom={replay} />));

    const switchGroup = container.querySelector('[aria-label="Explanation audience"]')!;
    expect(switchGroup.querySelector('[aria-pressed="true"]')!.textContent).toBe("Analyst");
    expect(switchGroup.querySelectorAll("svg")).toHaveLength(2);

    const replays = [...container.querySelectorAll<HTMLButtonElement>(".recap__replay")];
    expect(replays.map((b) => b.getAttribute("aria-label"))).toEqual(
      recapMoments(sampleFixture).map((e) => expect.stringMatching(new RegExp(`^Replay moment: .+ at ${formatClock(e.t)}$`))),
    );

    // Snapshot values are computed from the events, not taken from the model.
    const stats = statisticsAt(sampleFixture, END);
    const shots = [...container.querySelectorAll(".recap__snapshot tr")].find((r) => r.querySelector("th")?.textContent === "Shots")!;
    expect([...shots.querySelectorAll(".recap__value")].map((td) => td.textContent)).toEqual([String(stats.home.shots), String(stats.away.shots)]);

    // "View supporting events" reveals the cited events, each replayable; nothing is a dead link.
    const toggle = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("View supporting events"))!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("#recap-evidence")).toBeNull();
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const evidence = container.querySelector("#recap-evidence")!;
    expect(evidence.textContent).toContain("#9 scored at 9.4 s");
    await act(async () => evidence.querySelector<HTMLButtonElement>("button.cite")!.click());
    const goal = sampleFixture.events.find((e) => e.id === "e6-goal")!;
    expect(replay).toHaveBeenCalledWith(goal.t - 3_000);
    expect(container.textContent).toContain("Generated from synthetic match events");
    await act(async () => root.unmount());
    container.remove();
  });
  it("lists the moments explained during the match and reuses a fetched summary", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const result = { apiVersion: "1.0.0", ok: true, matchId: sampleFixture.matchId, timeMs: END, audience: "casual", focus: "match",
      explanation: summary(), verification: { outcome: "verified" } } as unknown as ExplainSuccess;
    const asked = { id: "casual-9400-0", atMs: 9_400, audience: "casual" as const,
      result: { ...result, timeMs: 9_400, explanation: { ...summary(), timeMs: 9_400, headline: "The opener" } } as ExplainSuccess };
    const open = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Recap fixture={sampleFixture} audience="casual" onAudience={() => {}} onReplayFrom={() => {}}
      explained={[asked]} onOpenExplanation={open} summaries={{ casual: result }} />));
    // The summary fetched on an earlier visit shows straight away, with no new request.
    expect(container.textContent).toContain("Harbor City win 1–0");
    expect(fetcher).not.toHaveBeenCalled();
    const item = container.querySelector<HTMLButtonElement>(".recap__asked-item")!;
    expect(item.textContent).toContain(formatClock(9_400));
    expect(item.textContent).toContain("The opener");
    await act(async () => item.click());
    expect(open).toHaveBeenCalledWith(asked);
    await act(async () => root.unmount());
    container.remove();
  });
});
