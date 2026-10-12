// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MiniPitch } from "@/components/MiniPitch";
import { sampleFixture } from "@/match/fixture";

function draw(timeMs: number, highlight?: (typeof sampleFixture.events)[number]) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<MiniPitch fixture={sampleFixture} timeMs={timeMs} highlight={highlight} />);
  return host.querySelector("svg")!;
}

describe("mini pitch", () => {
  it("draws the latest positions at or before the time, never a later snapshot", () => {
    const [first, second] = sampleFixture.snapshots;
    const between = Math.floor((first!.t + second!.t) / 2);
    const ball = draw(between).querySelector(".minipitch__ball")!;
    const [x, y] = ball.getAttribute("d")!.slice(1).split(/[ h]/).map(Number) as [number, number];
    expect(x).toBeCloseTo(first!.ball.x);
    expect(y).toBeCloseTo(first!.ball.y);
  });

  it("colours players with the fixture's kits and stays decorative", () => {
    const svg = draw(sampleFixture.snapshots[0]!.t);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    const fills = new Set([...svg.querySelectorAll(".minipitch__kit")].map((p) => p.getAttribute("stroke")));
    expect(fills).toEqual(new Set(sampleFixture.teams.map((t) => t.kit.primary)));
  });

  it("frames a close-up on a highlighted pass that keeps both ends in view", () => {
    const pass = sampleFixture.events.find((e) => e.type === "pass" && e.start && e.end)!;
    const svg = draw(pass.t, pass);
    const [x, y, w, h] = svg.getAttribute("viewBox")!.split(" ").map(Number) as [number, number, number, number];
    expect(w).toBeLessThan(105);
    for (const p of [pass.start!, pass.end!]) {
      expect(p.x).toBeGreaterThanOrEqual(x); expect(p.x).toBeLessThanOrEqual(x + w);
      expect(p.y).toBeGreaterThanOrEqual(y); expect(p.y).toBeLessThanOrEqual(y + h);
    }
    expect(svg.querySelector(".minipitch__path")).not.toBeNull();
  });
});
