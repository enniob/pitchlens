import type { ReactNode } from "react";
import { SPEEDS, type PlaybackStatus, type Speed } from "@/playback/engine";
import type { CameraView } from "@/scene/MatchScene";
import { shortClock } from "./format";
import { Icon } from "./Icon";

interface PlaybackControlsProps {
  status: PlaybackStatus;
  hasPrevious: boolean;
  hasNext: boolean;
  /** Null hides the button (the browser can't show the match full screen). */
  fullscreen: boolean | null;
  /** The timeline, placed between the clock and the speed menu. */
  children: ReactNode;
  onTogglePlay: () => void;
  onRestart: () => void;
  onPreviousMoment: () => void;
  onNextMoment: () => void;
  onSpeed: (speed: Speed) => void;
  onToggleFullscreen: () => void;
}

/** The bar under the pitch, like a video player: transport, clock, timeline, speed and full screen. */
export function PlaybackControls(p: PlaybackControlsProps) {
  const { status } = p;
  const playLabel = status.playing ? "Pause" : status.ended ? "Watch again" : "Play";
  return (
    <div className="controls" role="group" aria-label="Playback controls">
      <div className="controls__transport">
        <button type="button" className="ctl ctl--small" aria-label="Restart from kick-off" onClick={p.onRestart}>
          <Icon name="restart" size={16} />
        </button>
        <button type="button" className="ctl" aria-label="Previous moment" disabled={!p.hasPrevious} onClick={p.onPreviousMoment}>
          <Icon name="prev" />
        </button>
        <button type="button" className="ctl ctl--play" aria-label={playLabel} onClick={p.onTogglePlay}>
          <Icon name={status.playing ? "pause" : "play"} size={24} />
        </button>
        <button type="button" className="ctl" aria-label="Next moment" disabled={!p.hasNext} onClick={p.onNextMoment}>
          <Icon name="next" />
        </button>
      </div>
      <p className="controls__clock">
        <time>{shortClock(status.timeMs)}</time>
        <span aria-hidden="true"> / </span>
        <span className="visually-hidden"> of </span>
        <time className="controls__total">{shortClock(status.durationMs)}</time>
      </p>
      {p.children}
      <label className="controls__speed">
        <span className="visually-hidden">Playback speed</span>
        <select value={status.speed} onChange={(e) => p.onSpeed(Number(e.currentTarget.value) as Speed)}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <Icon name="chevron" size={16} />
      </label>
      {p.fullscreen !== null && (
        <button
          type="button"
          className="ctl controls__full"
          aria-label={p.fullscreen ? "Exit full screen" : "Full screen"}
          aria-pressed={p.fullscreen}
          onClick={p.onToggleFullscreen}
        >
          <Icon name="fullscreen" size={18} />
        </button>
      )}
    </div>
  );
}

interface StageControlsProps {
  view: CameraView;
  sceneAvailable: boolean;
  pro: boolean;
  onView: (view: CameraView) => void;
  onTogglePro: () => void;
}

/** Camera and Tactics switches, laid over the top-right corner of the pitch. */
export function StageControls(p: StageControlsProps) {
  return (
    <div className="hud__options">
      <div className="hud__seg" role="group" aria-label="Camera">
        <button type="button" aria-pressed={p.view === "angled"} disabled={!p.sceneAvailable} onClick={() => p.onView("angled")}>
          3D
        </button>
        <button type="button" aria-pressed={p.view === "overhead"} disabled={!p.sceneAvailable} onClick={() => p.onView("overhead")}>
          Top view
        </button>
      </div>
      <span className="hud__divider" aria-hidden="true" />
      <button type="button" className="switch" role="switch" aria-checked={p.pro} aria-describedby="tactics-desc" onClick={p.onTogglePro}>
        Tactics
        <span className="switch__track" aria-hidden="true">
          <span className="switch__knob" />
        </span>
      </button>
      <span id="tactics-desc" className="visually-hidden">
        Shows a live feed of every touch with distances, positions and pitch zones, plus extra match numbers over the pitch.
      </span>
    </div>
  );
}

/** Zoom buttons, tucked into the bottom-right corner of the pitch. */
export function ZoomControls({ sceneAvailable, onZoom }: { sceneAvailable: boolean; onZoom: (direction: "in" | "out") => void }) {
  return (
    <div className="hud__zoom" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" disabled={!sceneAvailable} onClick={() => onZoom("out")}>
        <Icon name="minus" size={16} />
      </button>
      <button type="button" aria-label="Zoom in" disabled={!sceneAvailable} onClick={() => onZoom("in")}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}
