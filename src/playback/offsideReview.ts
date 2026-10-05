import type { MatchEvent, MatchFixture } from "@/match/contract";
import { frameAt, type PlaybackFrame } from "./derive";
import { PlaybackEngine } from "./engine";

export const REVIEW_MS = 3000;

export interface OffsideReview {
  event: MatchEvent;
  frame: PlaybackFrame;
  lineX: number;
  player: PlaybackFrame["players"][number];
  margin: number;
}

/** Only recorded contact frames can support a precise review. */
export function offsideReview(fixture: MatchFixture, event: MatchEvent): OffsideReview | null {
  if (
    event.type !== "offside" || event.startT === undefined || event.startT > event.t ||
    !fixture.snapshots.some(s => s.t === event.startT)
  ) return null;
  const team = fixture.teams.find(t => t.id === event.teamId);
  if (!team) return null;
  const frame = frameAt(fixture, event.startT);
  const player = frame.players.find(p => p.playerId === event.playerId);
  if (!player) return null;
  const sign = team.attacksTowards === "increasing-x" ? 1 : -1;
  const opponents = new Set(fixture.roster.filter(p => p.teamId !== team.id).map(p => p.id));
  const depths = frame.players.filter(p => opponents.has(p.playerId)).map(p => p.x * sign).sort((a, b) => b - a);
  if (depths.length < 2) return null;
  const depth = Math.max(depths[1]!, frame.ball.x * sign);
  return { event, frame, lineX: depth * sign, player, margin: player.x * sign - depth };
}

/** Holds the match clock at the whistle while the scene shows the earlier kick. */
export class OffsideReviewPlayback {
  review: OffsideReview | null = null;
  private elapsed = 0;
  private resume = false;

  constructor(readonly engine: PlaybackEngine) {}

  advance(delta: number): void {
    if (this.review) {
      this.elapsed += Math.max(0, delta);
      if (this.elapsed >= REVIEW_MS) this.finish();
      return;
    }
    const status = this.engine.status;
    if (status.playing && delta > 0) {
      const end = status.timeMs + delta * status.speed;
      for (const event of this.engine.fixture.events) {
        if (event.t <= status.timeMs || event.t > end) continue;
        const review = offsideReview(this.engine.fixture, event);
        if (!review) continue;
        this.engine.seek(event.t);
        this.resume = !this.engine.status.ended;
        this.engine.pause();
        this.review = review;
        this.elapsed = 0;
        return;
      }
    }
    this.engine.advance(delta);
  }

  finish(): void {
    if (!this.review) return;
    this.review = null;
    if (this.resume) this.engine.play();
    this.resume = false;
  }

  /** User navigation dismisses the review without changing play/pause intent. */
  cancel(): void {
    this.finish();
  }

  frame(): PlaybackFrame {
    return this.review?.frame ?? this.engine.frame();
  }
}
