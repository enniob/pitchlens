import type { MatchEvent, Team } from "@/match/contract";
import { eventCopy } from "./eventCopy";
import { formatClock } from "./format";
import { Icon } from "./Icon";

interface TimelineProps {
  timeMs: number;
  durationMs: number;
  /** Key moments already reached (see timelineMoments). */
  moments: readonly MatchEvent[];
  teams: [Team, Team];
  selectedId: string | null;
  onSeek: (timeMs: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
  onSelectMoment: (event: MatchEvent) => void;
}

const STEP_MS = 100;
const short = (ms: number) => formatClock(ms).replace(/\.\d$/, "");

/**
 * Scrub bar with a marker button for every key moment reached so far. The
 * slider is a native range input, so arrow keys, Home/End and touch dragging
 * work without extra code. Markers are real buttons with a spoken label (the
 * accessible alternative to hovering), and like the feed and score they only
 * appear once playback has reached them, so nothing is spoiled.
 */
export function Timeline({ timeMs, durationMs, moments, teams, selectedId, onSeek, onScrubStart, onScrubEnd, onSelectMoment }: TimelineProps) {
  const pct = durationMs > 0 ? (timeMs / durationMs) * 100 : 0;
  return (
    <div className="timeline" role="group" aria-label="Timeline">
      <div className="timeline__markers">
        {moments.map((e) => {
          const copy = eventCopy(e);
          const team = teams.find((t) => t.id === e.teamId);
          const selected = e.id === selectedId;
          return (
            <button
              key={e.id}
              type="button"
              className={`timeline__marker timeline__marker--${copy.tone}${selected ? " timeline__marker--selected" : ""}`}
              style={{ left: `${(e.t / durationMs) * 100}%` }}
              aria-label={`${short(e.t)} ${copy.title.replace(/!$/, "")}${team ? `, ${team.name}` : ""}`}
              aria-pressed={selected}
              onClick={() => onSelectMoment(e)}
            >
              <Icon name={copy.icon} size={15} />
              {selected && (
                <span className="timeline__label" aria-hidden="true">
                  {short(e.t)} {copy.title.replace(/!$/, "")}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <input
        type="range"
        className="timeline__slider"
        aria-label="Match timeline"
        aria-valuetext={`${formatClock(timeMs)} of ${formatClock(durationMs)}`}
        min={0}
        max={durationMs}
        step={STEP_MS}
        value={Math.min(durationMs, Math.round(timeMs / STEP_MS) * STEP_MS)}
        style={{ background: `linear-gradient(to right, var(--text) ${pct}%, var(--track) ${pct}%)` }}
        onChange={(e) => onSeek(Number(e.currentTarget.value))}
        onPointerDown={onScrubStart}
        onPointerUp={onScrubEnd}
        onPointerCancel={onScrubEnd}
      />
      <div className="timeline__times">
        <time>{formatClock(timeMs)}</time>
        <time>{formatClock(durationMs)}</time>
      </div>
    </div>
  );
}
