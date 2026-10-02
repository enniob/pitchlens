import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchViewer } from "@/components/MatchViewer";
import type { MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";

describe("MatchViewer with invalid data", () => {
  it("shows validation errors instead of crashing on an empty snapshot list", () => {
    const broken: MatchFixture = { ...sampleFixture, snapshots: [] };
    const html = renderToStaticMarkup(<MatchViewer fixture={broken} />);
    expect(html).toContain("Match data could not be loaded");
    expect(html).toContain("At least two snapshots are required");
  });

  it("shows validation errors for non-finite ball coordinates", () => {
    const [first, ...rest] = sampleFixture.snapshots;
    const broken: MatchFixture = {
      ...sampleFixture,
      snapshots: [{ ...first!, ball: { ...first!.ball, x: Number.NaN } }, ...rest],
    };
    const html = renderToStaticMarkup(<MatchViewer fixture={broken} />);
    expect(html).toContain("Match data could not be loaded");
  });

  it("renders the viewer for valid data", () => {
    const html = renderToStaticMarkup(<MatchViewer fixture={sampleFixture} />);
    expect(html).not.toContain("Match data could not be loaded");
    expect(html).toContain("Live feed");
    expect(html).toContain('aria-label="Match timeline"');
    expect(html).toContain("Synthetic match");
  });
});
