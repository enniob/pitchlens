import { describe, expect, it } from "vitest";
import { sampleFixture } from "@/match/fixture";
import { completedPassAt } from "@/scene/evidence";

describe("observed pass trail", () => {
  const pass = sampleFixture.events.find((event) => event.type === "pass")!;
  it("never shows a pass before its reception, even with future events supplied", () => {
    expect(completedPassAt([pass], pass.t - 1)).toBeNull();
    expect(completedPassAt([pass], pass.t)).toBe(pass);
  });
  it("expires by playback time and clears immediately on a later action", () => {
    expect(completedPassAt([pass], pass.t + 1801)).toBeNull();
    expect(completedPassAt([pass, { ...pass, t: pass.t + 1, type: "turnover" }], pass.t + 1)).toBeNull();
  });
  it("reconstructs the same evidence when seeking backward", () => {
    expect(completedPassAt(sampleFixture.events, pass.t)).toBe(pass);
    expect(completedPassAt(sampleFixture.events, 0)).toBeNull();
    expect(completedPassAt(sampleFixture.events, pass.t)).toBe(pass);
  });
  it("does not infer endpoints or show an intercepted pass as completed", () => {
    expect(completedPassAt([{ ...pass, start: undefined }], pass.t)).toBeNull();
    expect(completedPassAt([{ ...pass, outcome: "intercepted" }], pass.t)).toBeNull();
    expect(completedPassAt([{ ...pass, end: pass.start }], pass.t)).toBeNull();
  });
});
