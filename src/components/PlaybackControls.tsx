import type { ReactNode } from "react";
import { SPEEDS, type PlaybackStatus, type Speed } from "@/playback/engine";
import type { CameraView } from "@/scene/MatchScene";
import { Icon } from "./Icon";

interface PlaybackControlsProps {
  status: PlaybackStatus;
  view: CameraView;
  sceneAvailable: boolean;
  pro: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  /** The timeline, placed between the transport buttons and the view options. */
  children: ReactNode;
  onTogglePlay: () => void;
  onRestart: () => void;
  onPreviousMoment: () => void;
  onNextMoment: () => void;
  onSpeed: (speed: Speed) => void;
  onView: (view: CameraView) => void;
  onZoom: (direction: "in" | "out" | "reset") => void;
  onTogglePro: () => void;
}

/** One floating bar, like a video player: transport, timeline, speed, camera, zoom and the Pro data switch. */
export function PlaybackControls(p: PlaybackControlsProps) {
  const { status } = p;
  const playLabel = status.playing ? "Pause" : status.ended ? "Watch again" : "Play";
  const nextSpeed = SPEEDS[(SPEEDS.indexOf(status.speed) + 1) % SPEEDS.length]!;
  return (
    <div className="controls" role="group" aria-label="Playback controls">
      <div className="controls__transport">
        <button type="button" className="btn btn--ghost btn--icon" aria-label="Restart from kick-off" onClick={p.onRestart}>
          <Icon name="restart" />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" aria-label="Previous moment" disabled={!p.hasPrevious} onClick={p.onPreviousMoment}>
          <Icon name="prev" />
        </button>
        <button type="button" className="play" aria-label={playLabel} onClick={p.onTogglePlay}>
          <Icon name={status.playing ? "pause" : "play"} size={26} />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" aria-label="Next moment" disabled={!p.hasNext} onClick={p.onNextMoment}>
          <Icon name="next" />
        </button>
        <button
          type="button"
          className="btn btn--ghost controls__speed"
          aria-label={`Speed ${status.speed}×. Change to ${nextSpeed}×`}
          onClick={() => p.onSpeed(nextSpeed)}
        >
          {status.speed}×
        </button>
      </div>
      {p.children}
      <div className="controls__view">
        <div className="seg controls__camera" role="group" aria-label="Camera">
          <button type="button" aria-pressed={p.view === "angled"} disabled={!p.sceneAvailable} onClick={() => p.onView("angled")}>
            Broadcast
          </button>
          <button type="button" aria-pressed={p.view === "overhead"} disabled={!p.sceneAvailable} onClick={() => p.onView("overhead")}>
            Top
          </button>
        </div>
        <div className="seg controls__zoom" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" disabled={!p.sceneAvailable} onClick={() => p.onZoom("out")}>
            <Icon name="minus" />
          </button>
          <button type="button" aria-label="Zoom in" disabled={!p.sceneAvailable} onClick={() => p.onZoom("in")}>
            <Icon name="plus" />
          </button>
          <button type="button" aria-label="Fit the pitch" disabled={!p.sceneAvailable} onClick={() => p.onZoom("reset")}>
            <Icon name="fit" />
          </button>
        </div>
        <button type="button" className="switch" role="switch" aria-checked={p.pro} aria-describedby="pro-desc" onClick={p.onTogglePro}>
          <span className="switch__track" aria-hidden="true">
            <span className="switch__knob" />
          </span>
          Pro data
        </button>
        <span id="pro-desc" className="visually-hidden">
          Adds every touch, distances, positions and pitch zones to the feed, plus extra numbers.
        </span>
      </div>
    </div>
  );
}
