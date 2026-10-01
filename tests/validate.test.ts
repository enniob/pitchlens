import { describe, expect, it } from "vitest";
import type { MatchFixture, Snapshot } from "@/match/contract";
import { sampleFixture as f } from "@/match/fixture";
import { validateFixture } from "@/match/validate";

/** Replace snapshot `i` with a modified copy. */
function withSnapshot(i: number, change: (s: Snapshot) => Snapshot): MatchFixture {
  return { ...f, snapshots: f.snapshots.map((s, j) => (j === i ? change(s) : s)) };
}

const expectInvalid = (fixture: MatchFixture, pattern: RegExp) => {
  const errors = validateFixture(fixture);
  expect(errors.some((e) => pattern.test(e)), errors.join("\n")).toBe(true);
};

describe("validateFixture rejects", () => {
  it("an empty snapshot list", () => {
    expectInvalid({ ...f, snapshots: [] }, /At least two snapshots/);
  });

  it.each(["x", "y", "z"] as const)("a NaN ball %s coordinate", (axis) => {
    expectInvalid(withSnapshot(5, (s) => ({ ...s, ball: { ...s.ball, [axis]: Number.NaN } })), /ball/);
  });

  it("an infinite ball coordinate", () => {
    expectInvalid(withSnapshot(5, (s) => ({ ...s, ball: { ...s.ball, x: Number.POSITIVE_INFINITY } })), /ball/);
  });

  it.each(["x", "y", "facing"] as const)("a NaN player %s", (key) => {
    expectInvalid(
      withSnapshot(5, (s) => ({ ...s, players: s.players.map((p, i) => (i === 0 ? { ...p, [key]: Number.NaN } : p)) })),
      /player/,
    );
  });

  it("a NaN snapshot timestamp", () => {
    expectInvalid(withSnapshot(5, (s) => ({ ...s, t: Number.NaN })), /timestamp/);
  });

  it("a NaN event timestamp or position", () => {
    expectInvalid({ ...f, events: f.events.map((e, i) => (i === 1 ? { ...e, t: Number.NaN } : e)) }, /timestamp/);
    expectInvalid(
      { ...f, events: f.events.map((e, i) => (i === 1 ? { ...e, end: { x: Number.NaN, y: 1, z: 0 } } : e)) },
      /position/,
    );
  });

  it("a non-finite duration", () => {
    expectInvalid({ ...f, durationMs: Number.NaN }, /durationMs/);
  });

  it("two teams both marked home", () => {
    const [home, away] = f.teams;
    expectInvalid({ ...f, teams: [home, { ...away, side: "home" }] }, /one home team and one away team/);
  });

  it("two teams both marked away", () => {
    const [home, away] = f.teams;
    expectInvalid({ ...f, teams: [{ ...home, side: "away" }, away] }, /one home team and one away team/);
  });

  it("an unknown team side", () => {
    const [home, away] = f.teams;
    // @ts-expect-error — deliberately invalid input, as untyped simulator JSON could contain
    expectInvalid({ ...f, teams: [home, { ...away, side: "neutral" }] }, /side/);
  });

  it("an unknown attacking direction", () => {
    const [home, away] = f.teams;
    // @ts-expect-error — deliberately invalid input
    expectInvalid({ ...f, teams: [home, { ...away, attacksTowards: "sideways" }] }, /attacksTowards/);
  });

  it("a non-integer starting score", () => {
    expectInvalid({ ...f, startingState: { ...f.startingState, score: { home: Number.NaN, away: 0 } } }, /score/);
  });
});

describe("validateFixture accepts", () => {
  it("the sample fixture", () => {
    expect(validateFixture(f)).toEqual([]);
  });
});
