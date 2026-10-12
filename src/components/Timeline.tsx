import type { CSSProperties } from "react";
import type { MatchEvent, Team } from "@/match/contract";
import { eventCopy } from "./eventCopy";
import { formatClock, shortClock } from "./format";
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

/**
 * Scrub track with a marker button for every key moment reached so far. The
 * slider is a native range input, so arrow keys, Home/End and touch dragging
 * work without extra code; the visible track and playhead are drawn behind it
 * on the same inset rail, so marker and playhead positions line up. Markers
 * are real buttons with a spoken label (the accessible alternative to
 * hovering, which also shows a small tag): goals and shots show a ball, other
 * moments a dot in the team's kit colour. The selected moment is named on the
 * pitch itself, so the tag is never needed. Like the feed and score, markers
 * only appear once playback has reached them, so nothing is spoiled.
 */
export function Timeline({ timeMs, durationMs, moments, teams, selectedId, onSeek, onScrubStart, onScrubEnd, onSelectMoment }: TimelineProps) {
  const pct = durationMs > 0 ? Math.min(100, (timeMs / durationMs) * 100) : 0;
  return (
    <div className="timeline" role="group" aria-label="Timeline">
      <input
        type="range"
        className="timeline__slider"
        aria-label="Match timeline"
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
      <div className="timeline__rail" aria-hidden="true">
        <span className="timeline__track" />
        <span className="timeline__fill" style={{ width: `${pct}%` }} />
        <span className="timeline__head" style={{ left: `${pct}%` }} />
      </div>
      <div className="timeline__markers">
        {moments.map((e) => {
          const copy = eventCopy(e);
          const team = teams.find((t) => t.id === e.teamId);
          const selected = e.id === selectedId;
          const ball = e.type === "goal" || e.type === "shot";
          const style: CSSProperties & { "--team"?: string } = { left: `${(e.t / durationMs) * 100}%` };
          if (team) style["--team"] = team.kit.primary;
          return (
            <button
              key={e.id}
              type="button"
              className={`timeline__marker timeline__marker--${copy.tone}${ball ? " timeline__marker--ball" : ""}${selected ? " timeline__marker--selected" : ""}`}
              style={style}
              aria-label={`${shortClock(e.t)} ${copy.title.replace(/!$/, "")}${team ? `, ${team.name}` : ""}`}
              aria-pressed={selected}
              onClick={() => onSelectMoment(e)}
            >
              {ball ? <Icon name="goal" size={16} /> : <span className="timeline__dot" />}
              <span className="timeline__label" aria-hidden="true">
                {shortClock(e.t)} {copy.title.replace(/!$/, "")}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
