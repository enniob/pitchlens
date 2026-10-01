import { SPEEDS, type PlaybackStatus, type Speed } from "@/playback/engine";
import type { CameraView } from "@/scene/MatchScene";

interface PlaybackControlsProps {
  status: PlaybackStatus;
  view: CameraView;
  sceneAvailable: boolean;
  onTogglePlay: () => void;
  onRestart: () => void;
  onSpeed: (speed: Speed) => void;
  onView: (view: CameraView) => void;
  onZoom: (direction: "in" | "out" | "reset") => void;
}

export function PlaybackControls({
  status,
  view,
  sceneAvailable,
  onTogglePlay,
  onRestart,
  onSpeed,
  onView,
  onZoom,
}: PlaybackControlsProps) {
  const playLabel = status.playing ? "Pause" : status.ended ? "Replay" : "Play";
  return (
    <div className="controls" role="toolbar" aria-label="Playback controls">
      <div className="controls__group">
        <button type="button" className="btn btn--primary" onClick={onTogglePlay} aria-label={playLabel}>
          <span aria-hidden="true">{status.playing ? "❚❚" : "▶"}</span> {playLabel}
        </button>
        <button type="button" className="btn" onClick={onRestart}>
          <span aria-hidden="true">↺</span> Restart
        </button>
      </div>

      <div className="controls__group" role="group" aria-label="Playback speed">
        {SPEEDS.map((speed) => (
          <button
            key={speed}
            type="button"
            className="btn btn--toggle"
            aria-pressed={status.speed === speed}
            onClick={() => onSpeed(speed)}
          >
            {speed}×
          </button>
        ))}
      </div>

      <div className="controls__group" role="group" aria-label="Camera">
        <button
          type="button"
          className="btn btn--toggle"
          aria-pressed={view === "angled"}
          disabled={!sceneAvailable}
          onClick={() => onView(view === "overhead" ? "angled" : "overhead")}
        >
          {view === "overhead" ? "Angled view" : "Overhead view"}
        </button>
        <button type="button" className="btn btn--icon" disabled={!sceneAvailable} onClick={() => onZoom("out")} aria-label="Zoom out">
          −
        </button>
        <button type="button" className="btn btn--icon" disabled={!sceneAvailable} onClick={() => onZoom("in")} aria-label="Zoom in">
          +
        </button>
        <button type="button" className="btn" disabled={!sceneAvailable} onClick={() => onZoom("reset")}>
          Fit
        </button>
      </div>
    </div>
  );
}
