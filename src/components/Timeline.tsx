import type { MatchEvent } from "@/match/contract";
import { formatClock } from "./format";

interface TimelineProps {
  timeMs: number;
  durationMs: number;
  events: readonly MatchEvent[];
  hasPrevious: boolean;
  hasNext: boolean;
  onSeek: (timeMs: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
  onPreviousEvent: () => void;
  onNextEvent: () => void;
}

const STEP_MS = 100;

/**
 * Scrub bar with previous/next event buttons. The slider is a native range
 * input, so arrow keys, Home/End and touch dragging work without extra code.
 * Event ticks are decorative; the whole fixture's event times are public data,
 * but their descriptions stay hidden until playback reaches them.
 */
export function Timeline({
  timeMs,
  durationMs,
  events,
  hasPrevious,
  hasNext,
  onSeek,
  onScrubStart,
  onScrubEnd,
  onPreviousEvent,
  onNextEvent,
}: TimelineProps) {
  return (
    <div className="timeline" role="group" aria-label="Timeline">
      <button type="button" className="btn" disabled={!hasPrevious} onClick={onPreviousEvent}>
        <span aria-hidden="true">⏮</span> Prev event
      </button>
      <div className="timeline__track">
        <input
          type="range"
          className="timeline__slider"
          aria-label="Seek"
          aria-valuetext={`${formatClock(timeMs)} of ${formatClock(durationMs)}`}
          min={0}
          max={durationMs}
          step={STEP_MS}
          value={Math.min(durationMs, Math.round(timeMs / STEP_MS) * STEP_MS)}
          onChange={(e) => onSeek(Number(e.currentTarget.value))}
          onPointerDown={onScrubStart}
          onPointerUp={onScrubEnd}
          onPointerCancel={onScrubEnd}
        />
        <div className="timeline__ticks" aria-hidden="true">
          {events.map((e) => (
            <span
              key={e.id}
              className={`timeline__tick${e.type === "goal" ? " timeline__tick--goal" : ""}`}
              style={{ left: `${(e.t / durationMs) * 100}%` }}
            />
          ))}
        </div>
      </div>
      <button type="button" className="btn" disabled={!hasNext} onClick={onNextEvent}>
        Next event <span aria-hidden="true">⏭</span>
      </button>
    </div>
  );
}
