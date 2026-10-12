import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchViewer } from "@/components/MatchViewer";
import { nextStripMoment, previousStripMoment, stripMoments } from "@/components/MomentStrip";
import { PlaybackControls, StageControls, ZoomControls } from "@/components/PlaybackControls";
import { sampleFixture } from "@/match/fixture";
import { eventsAt } from "@/playback/derive";
import type { PlaybackStatus } from "@/playback/engine";
import { generateMatch } from "@/simulation/generate";

const status = (over: Partial<PlaybackStatus> = {}): PlaybackStatus => ({ timeMs: 62_000, durationMs: 90_000, playing: false, speed: 1, ended: false, ...over });
const noop = () => {};
const bar = (over: Partial<Parameters<typeof PlaybackControls>[0]> = {}) =>
  renderToStaticMarkup(
    <PlaybackControls
      status={status()}
      hasPrevious
      hasNext={false}
      fullscreen={null}
      onTogglePlay={noop}
      onRestart={noop}
      onPreviousMoment={noop}
      onNextMoment={noop}
      onSpeed={noop}
      onToggleFullscreen={noop}
      {...over}
    >
      <div />
    </PlaybackControls>,
  );

describe("playback bar", () => {
  it("shows the clock against the fixture duration and labels every button", () => {
    const html = bar();
    expect(html).toContain("1:02</time>");
    expect(html).toContain("1:30</time>");
    for (const label of ["Restart from kick-off", "Previous moment", "Play", "Next moment"]) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toMatch(/aria-label="Next moment" disabled=""/);
    expect(bar({ status: status({ playing: true }) })).toContain('aria-label="Pause"');
  });

  it("offers every speed in a labelled native select", () => {
    const html = bar({ status: status({ speed: 2 }) });
    expect(html).toContain("Playback speed");
    expect(html).toMatch(/<option value="2" selected="">2×<\/option>/);
    expect(html.match(/<option /g)).toHaveLength(4);
  });

  it("hides full screen when the browser can't do it, and reflects its state otherwise", () => {
    expect(bar()).not.toContain("ull screen");
    expect(bar({ fullscreen: false })).toContain('aria-label="Full screen" aria-pressed="false"');
    expect(bar({ fullscreen: true })).toContain('aria-label="Exit full screen" aria-pressed="true"');
  });
});

describe("pitch overlays", () => {
  it("maps 3D and Top view to the camera views and disables them without a scene", () => {
    const off = renderToStaticMarkup(<StageControls view="angled" sceneAvailable={false} onView={noop} />);
    expect(off).toMatch(/aria-pressed="true" disabled="">3D</);
    expect(off).toMatch(/aria-pressed="false" disabled="">Top view</);
    const on = renderToStaticMarkup(<StageControls view="overhead" sceneAvailable onView={noop} />);
    expect(on).toMatch(/aria-pressed="true">Top view</);
  });

  it("keeps Tactics off the pitch: it is a dock tab, not a switch", () => {
    const html = renderToStaticMarkup(<StageControls view="angled" sceneAvailable onView={noop} />);
    expect(html).not.toContain("Tactics");
    expect(html).not.toContain('role="switch"');
  });

  it("labels the zoom buttons", () => {
    const html = renderToStaticMarkup(<ZoomControls sceneAvailable onZoom={noop} />);
    for (const label of ["Zoom out", "Zoom in"]) expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toContain("Fit the pitch");
  });

  it("floats the scoreline in the top row of the pitch, between the moment and the view options", () => {
    const html = renderToStaticMarkup(<MatchViewer fixture={sampleFixture} />);
    const hud = html.slice(html.indexOf('class="hud"'));
    expect(hud.indexOf('aria-label="Score and clock"')).toBeGreaterThan(-1);
    expect(hud.indexOf('aria-label="Score and clock"')).toBeLessThan(hud.indexOf('aria-label="Camera"'));
    expect(html.indexOf('class="hud"')).toBeLessThan(html.indexOf('class="stage__pitch"'));
    expect(html).not.toContain("scorerow");
  });

  it("docks Game moments and Tactics as tabs, Game moments first", () => {
    const off = renderToStaticMarkup(<MatchViewer fixture={sampleFixture} />);
    const tabs = off.slice(off.indexOf('role="tablist"'));
    expect(tabs.indexOf(">Game moments<")).toBeLessThan(tabs.indexOf(">Tactics<"));
    expect(off).toContain('id="dock-tab-moments" role="tab" aria-selected="true"');
    expect(off).toContain('id="dock-tab-tactics" role="tab" aria-selected="false"');
    expect(off).not.toContain('role="switch"');
  });

  it("shows the Tactics numbers with the feed only on the Tactics tab, keeping the explanation panel mounted", () => {
    const off = renderToStaticMarkup(<MatchViewer fixture={sampleFixture} />);
    expect(off).toContain('class="dock__panel tactics tactics--off"');
    expect(off).not.toContain("Tactics data so far");
    expect(off).toMatch(/id="dock-panel-moments" role="tabpanel" aria-labelledby="dock-tab-moments">/);
    const on = renderToStaticMarkup(<MatchViewer fixture={sampleFixture} pro />);
    expect(on).toContain('class="dock__panel tactics"');
    expect(on).toContain('aria-label="Tactics data so far"');
    expect(on).toContain('id="dock-tab-tactics" role="tab" aria-selected="true"');
    expect(on).toMatch(/id="dock-panel-moments" role="tabpanel" aria-labelledby="dock-tab-moments" hidden="">/);
    expect(on).toContain('id="explain-title"');
  });

  it("names no moment on the pitch before any is reached", () => {
    const html = renderToStaticMarkup(<MatchViewer fixture={sampleFixture} />);
    expect(html).not.toContain("hud__moment");
  });
});

describe("moment strip", () => {
  it("keeps balls won and key moments, without shot results or routine restarts", () => {
    const f = generateMatch({ seed: 46, durationMs: 60_000 });
    const picked = stripMoments(f.events);
    expect(picked.some((e) => e.type === "turnover")).toBe(true);
    expect(picked.some((e) => e.type === "shot" || e.type === "goal")).toBe(true);
    for (const e of picked) expect(["shot-result", "throw-in", "goal-kick", "pass"]).not.toContain(e.type);
  });

  const f = generateMatch({ seed: 46, durationMs: 60_000 });
  const probes = Array.from({ length: 61 }, (_, i) => i * 1_000);

  it("never includes a moment that hasn't been reached (the timeline markers use the same set)", () => {
    for (const t of probes) for (const e of stripMoments(eventsAt(f, t))) expect(e.t).toBeLessThanOrEqual(t);
    expect(stripMoments(eventsAt(f, 2_000)).some((e) => e.type === "turnover")).toBe(true);
  });

  it("steps previous and next through exactly the strip moments", () => {
    const times = [...new Set(stripMoments(f.events).map((e) => e.t))];
    const visited: number[] = [];
    for (let e = nextStripMoment(f, -1); e; e = nextStripMoment(f, e.t)) visited.push(e.t);
    expect(visited).toEqual(times);
    const back: number[] = [];
    for (let e = previousStripMoment(f, f.durationMs + 1); e; e = previousStripMoment(f, e.t)) back.push(e.t);
    expect(back).toEqual([...times].reverse());
    expect(previousStripMoment(f, times[0]!)).toBeNull();
  });
});
