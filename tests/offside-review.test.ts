import { describe, expect, it } from "vitest";
import { generateMatch } from "@/simulation/generate";
import { PlaybackEngine, SPEEDS } from "@/playback/engine";
import { offsideReview, OffsideReviewPlayback, REVIEW_MS } from "@/playback/offsideReview";

const fixture = generateMatch({ seed: 42, durationMs: 60_000, tactics: { home: { formation: "4-4-2" }, away: { formation: "4-3-3" } } });
const flag = fixture.events.find(e => e.type === "offside")!;

describe("offside review evidence", () => {
  it("shows the reported marginal offside at the kick, rather than the whistle", () => {
    const review = offsideReview(fixture, flag)!;
    expect(review.frame.timeMs).toBe(26640);
    expect(flag.t).toBe(28480);
    expect(review.lineX).toBeCloseTo(17.026959);
    expect(review.margin).toBeCloseTo(0.189283);
    expect(review.player.playerId).toBe("nvr-9");
  });

  it.each(["increasing-x", "decreasing-x"] as const)("uses the ball when it is beyond the second-last opponent (%s)", direction => {
    const copy = structuredClone(fixture);
    const team = copy.teams.find(t => t.id === flag.teamId)!;
    team.attacksTowards = direction;
    const snapshot = copy.snapshots.find(s => s.t === flag.startT)!;
    const sign = direction === "increasing-x" ? 1 : -1;
    const x = sign === 1 ? 90 : 15;
    snapshot.ball.x = x;
    for (const p of snapshot.players) p.x = x - sign * 10;
    snapshot.players.find(p => p.playerId === flag.playerId)!.x = x + sign;
    expect(offsideReview(copy, flag)).toMatchObject({ lineX: x, margin: 1 });
  });

  it("skips calls without a recorded kick frame instead of inventing evidence", () => {
    expect(offsideReview(fixture, { ...flag, startT: undefined })).toBeNull();
    expect(offsideReview(fixture, { ...flag, startT: 26641 })).toBeNull();
    expect(offsideReview(fixture, { ...flag, startT: flag.t + 1 })).toBeNull();
    expect(offsideReview(fixture, { ...flag, type: "foul" })).toBeNull();
  });
});

describe("offside review playback", () => {
  it.each(SPEEDS)("holds exactly at the whistle and resumes after three real seconds at %sx", speed => {
    const engine = new PlaybackEngine(fixture);
    const playback = new OffsideReviewPlayback(engine);
    engine.seek(flag.t - 10);
    engine.setSpeed(speed);
    engine.play();
    playback.advance(250);
    expect(engine.status).toMatchObject({ timeMs: flag.t, playing: false, speed });
    expect(engine.frame().events).toContainEqual(flag);
    expect(engine.frame().events.every(e => e.t <= flag.t)).toBe(true);
    expect(playback.frame().timeMs).toBe(flag.startT);
    playback.advance(REVIEW_MS - 1);
    expect(playback.review).not.toBeNull();
    expect(engine.status.timeMs).toBe(flag.t);
    playback.advance(1);
    expect(playback.review).toBeNull();
    expect(engine.status).toMatchObject({ playing: true, timeMs: flag.t, speed });
    expect(playback.frame().timeMs).toBe(flag.t);
    playback.advance(100);
    expect(engine.status.timeMs).toBe(flag.t + 100 * speed);
    expect(playback.review).toBeNull();
  });

  it("Continue ends the hold immediately without replaying the same whistle", () => {
    const engine = new PlaybackEngine(fixture);
    const playback = new OffsideReviewPlayback(engine);
    engine.seek(flag.t - 1);
    engine.play();
    playback.advance(10);
    playback.finish();
    playback.advance(10);
    expect(playback.review).toBeNull();
    expect(engine.status.timeMs).toBe(flag.t + 10);
  });

  it("does not review paused playback or seeking, but reviews again on a replay", () => {
    const engine = new PlaybackEngine(fixture);
    const playback = new OffsideReviewPlayback(engine);
    engine.seek(flag.t);
    playback.advance(100);
    expect(playback.review).toBeNull();
    engine.seek(flag.t - 1);
    engine.play();
    playback.advance(10);
    playback.cancel();
    engine.seek(0);
    expect(playback.frame().timeMs).toBe(0);
    engine.seek(flag.t - 1);
    playback.advance(10);
    expect(playback.review?.event.id).toBe(flag.id);
  });

  it("does not restart a match when a review occurs at its end", () => {
    const short = { ...fixture, durationMs: flag.t };
    const engine = new PlaybackEngine(short);
    const playback = new OffsideReviewPlayback(engine);
    engine.seek(flag.t - 1);
    engine.play();
    playback.advance(10);
    playback.advance(REVIEW_MS);
    expect(engine.status).toMatchObject({ ended: true, playing: false, timeMs: flag.t });
  });
});
