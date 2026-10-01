/**
 * Playback engine: owns the single simulation clock. Rendering-agnostic — the
 * caller feeds it real elapsed time (e.g. from requestAnimationFrame) and reads
 * back frames. Nothing else in the app keeps its own simulation timer.
 */
import type { MatchEvent, MatchFixture } from "@/match/contract";
import { clampTime, eventsBetween, frameAt, nextEventTime, previousEventTime, type PlaybackFrame } from "./derive";

export const SPEEDS = [0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

export interface PlaybackStatus {
  timeMs: number;
  durationMs: number;
  playing: boolean;
  speed: Speed;
  ended: boolean;
}

export class PlaybackEngine {
  private time = 0;
  private isPlaying = false;
  private currentSpeed: Speed = 1;

  constructor(readonly fixture: MatchFixture) {}

  get status(): PlaybackStatus {
    return {
      timeMs: this.time,
      durationMs: this.fixture.durationMs,
      playing: this.isPlaying,
      speed: this.currentSpeed,
      ended: this.time >= this.fixture.durationMs,
    };
  }

  play(): void {
    // Playing from the end starts the sequence again.
    if (this.time >= this.fixture.durationMs) this.time = 0;
    this.isPlaying = true;
  }

  pause(): void {
    this.isPlaying = false;
  }

  togglePlay(): void {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  setSpeed(speed: Speed): void {
    if (!SPEEDS.includes(speed)) throw new Error(`Unsupported speed ${speed}`);
    this.currentSpeed = speed;
  }

  /** Back to t = 0: positions, score and event history return to the fixture's starting state. */
  restart(): void {
    this.time = 0;
  }

  /**
   * Jump to simulation time `t` (clamped to the fixture). Play/pause state and
   * speed are kept, except that seeking to the very end stops playback just as
   * reaching it naturally does. Non-finite input is ignored. Everything shown is
   * derived from the time alone, so seeking cannot reveal future events.
   */
  seek(t: number): void {
    if (!Number.isFinite(t)) return;
    this.time = clampTime(this.fixture, t);
    if (this.time >= this.fixture.durationMs) this.isPlaying = false;
  }

  /** Seek to the latest event before the current time. Returns false when there is none. */
  seekToPreviousEvent(): boolean {
    const t = previousEventTime(this.fixture, this.time);
    if (t === null) return false;
    this.seek(t);
    return true;
  }

  /** Seek to the earliest event after the current time. Returns false when there is none. */
  seekToNextEvent(): boolean {
    const t = nextEventTime(this.fixture, this.time);
    if (t === null) return false;
    this.seek(t);
    return true;
  }

  /**
   * Advance the clock by `realDeltaMs` of wall time scaled by the current speed.
   * Returns every event crossed by this step, in order, even if one step spans
   * several events. A paused engine does not move.
   */
  advance(realDeltaMs: number): MatchEvent[] {
    if (!this.isPlaying || !(realDeltaMs > 0)) return [];
    const prev = this.time;
    this.time = Math.min(this.fixture.durationMs, prev + realDeltaMs * this.currentSpeed);
    if (this.time >= this.fixture.durationMs) this.isPlaying = false;
    return eventsBetween(this.fixture, prev, this.time);
  }

  frame(): PlaybackFrame {
    return frameAt(this.fixture, this.time);
  }
}
