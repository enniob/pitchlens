"use client";

/**
 * Top-level viewer. Owns the one requestAnimationFrame loop: each frame it
 * advances the playback engine by real elapsed time, pushes the resulting
 * frame into the 3D scene, and syncs the React UI when displayed values change.
 *
 * Playback works without WebGL — only the 3D view is replaced by a message.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MatchEvent, MatchFixture, Score } from "@/match/contract";
import { validateFixture } from "@/match/validate";
import { nextEventTime, previousEventTime } from "@/playback/derive";
import { PlaybackEngine, type PlaybackStatus, type Speed } from "@/playback/engine";
import type { CameraView, MatchScene } from "@/scene/MatchScene";
import { EventFeed } from "./EventFeed";
import { Timeline } from "./Timeline";
import { PlaybackControls } from "./PlaybackControls";
import { Scoreboard } from "./Scoreboard";
import { MatchStats } from "./MatchStats";
import { statisticsAt } from "@/playback/statistics";

/** Longest real-time step fed to the engine, so a backgrounded tab doesn't jump on return. */
const MAX_FRAME_MS = 250;

type SceneState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "no-webgl" }
  | { kind: "error"; message: string };

interface UiState {
  status: PlaybackStatus;
  score: Score;
  events: MatchEvent[];
}

function detectWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function readUi(engine: PlaybackEngine): UiState {
  const frame = engine.frame();
  return { status: engine.status, score: frame.score, events: frame.events };
}

/** Only re-render React when something visible changes (clock is shown to 0.1 s). */
function uiKey(ui: UiState): string {
  const s = ui.status;
  return `${Math.floor(s.timeMs / 100)}|${s.playing}|${s.speed}|${ui.events.length}|${ui.score.home}-${ui.score.away}`;
}

function safeValidate(fixture: MatchFixture): string[] {
  try {
    return validateFixture(fixture);
  } catch (err) {
    // Structurally malformed data (e.g. missing arrays) can make validation itself throw.
    return [`Fixture is malformed: ${err instanceof Error ? err.message : String(err)}`];
  }
}

/**
 * Validates the fixture before anything reads from it; invalid data shows the
 * errors and never reaches the playback engine or the scene.
 */
export function MatchViewer({ fixture }: { fixture: MatchFixture }) {
  const errors = useMemo(() => safeValidate(fixture), [fixture]);
  if (errors.length > 0) return <FixtureErrors errors={errors} />;
  // Keyed by fixture so a new fixture gets a fresh engine and scene.
  return <PlaybackViewer key={fixture.matchId} fixture={fixture} />;
}

function FixtureErrors({ errors }: { errors: string[] }) {
  return (
    <div className="notice notice--error" role="alert">
      <h2>Match data could not be loaded</h2>
      <p>The fixture failed validation{errors.length > 10 ? ` (showing 10 of ${errors.length} problems)` : ""}:</p>
      <ul>
        {errors.slice(0, 10).map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
    </div>
  );
}

/** Only ever rendered with a fixture that passed validation. */
function PlaybackViewer({ fixture }: { fixture: MatchFixture }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  engineRef.current ??= new PlaybackEngine(fixture);
  const sceneRef = useRef<MatchScene | null>(null);
  const [sceneState, setSceneState] = useState<SceneState>({ kind: "loading" });
  const [view, setView] = useState<CameraView>("overhead");
  const [ui, setUi] = useState<UiState>(() => readUi(engineRef.current!));
  const uiKeyRef = useRef(uiKey(ui));
  const stats = useMemo(() => statisticsAt(fixture, ui.status.timeMs), [fixture, ui.status.timeMs]);

  const syncUi = useCallback((force = false) => {
    const next = readUi(engineRef.current!);
    const key = uiKey(next);
    if (force || key !== uiKeyRef.current) {
      uiKeyRef.current = key;
      setUi(next);
    }
  }, []);

  // Animation loop + scene lifecycle.
  useEffect(() => {
    const engine = engineRef.current!;
    const stage = stageRef.current!;
    let cancelled = false;
    let raf = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const delta = Math.min(MAX_FRAME_MS, Math.max(0, now - last));
      last = now;
      engine.advance(delta);
      const scene = sceneRef.current;
      if (scene) {
        scene.update(engine.frame());
        scene.render();
      }
      syncUi();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    if (!detectWebGL()) {
      setSceneState({ kind: "no-webgl" });
    } else {
      setSceneState({ kind: "loading" });
      import("@/scene/MatchScene")
        .then(({ MatchScene }) => {
          if (cancelled) return;
          sceneRef.current = new MatchScene({
            container: stage,
            fixture,
            onContextLost: () =>
              setSceneState({
                kind: "error",
                message: "The graphics context was lost. Reload the page to restore the 3D view.",
              }),
          });
          sceneRef.current.update(engine.frame());
          setSceneState({ kind: "ready" });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          console.error(err);
          setSceneState({
            kind: "error",
            message: `The 3D view failed to start: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, [fixture, syncUi]);

  const onTogglePlay = useCallback(() => {
    engineRef.current!.togglePlay();
    syncUi(true);
  }, [syncUi]);
  const onRestart = useCallback(() => {
    engineRef.current!.restart();
    syncUi(true);
  }, [syncUi]);
  const wasPlayingRef = useRef<boolean | null>(null);
  const onSeek = useCallback(
    (timeMs: number) => {
      engineRef.current!.seek(timeMs);
      syncUi(true);
    },
    [syncUi],
  );
  // Dragging the slider holds playback so the clock doesn't fight the pointer.
  const onScrubStart = useCallback(() => {
    const engine = engineRef.current!;
    wasPlayingRef.current = engine.status.playing;
    engine.pause();
    syncUi(true);
  }, [syncUi]);
  const onScrubEnd = useCallback(() => {
    const engine = engineRef.current!;
    if (wasPlayingRef.current && !engine.status.ended) engine.play();
    wasPlayingRef.current = null;
    syncUi(true);
  }, [syncUi]);
  const onPreviousEvent = useCallback(() => {
    engineRef.current!.seekToPreviousEvent();
    syncUi(true);
  }, [syncUi]);
  const onNextEvent = useCallback(() => {
    engineRef.current!.seekToNextEvent();
    syncUi(true);
  }, [syncUi]);
  const onSpeed = useCallback(
    (speed: Speed) => {
      engineRef.current!.setSpeed(speed);
      syncUi(true);
    },
    [syncUi],
  );
  const onView = useCallback((next: CameraView) => {
    setView(next);
    sceneRef.current?.setView(next);
  }, []);
  const onZoom = useCallback((direction: "in" | "out" | "reset") => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (direction === "reset") scene.resetZoom();
    else scene.zoomBy(direction === "in" ? 1.35 : 1 / 1.35);
  }, []);

  return (
    <div className="viewer">
      <div className="viewer__main">
        <Scoreboard teams={fixture.teams} score={ui.score} timeMs={ui.status.timeMs} durationMs={fixture.durationMs} />
        <div className="stage">
          {/* The scene appends its canvas here; React never renders children into it. */}
          <div className="stage__canvas" ref={stageRef} />
          <span className="stage__badge">Synthetic data</span>
          {sceneState.kind === "loading" && (
            <div className="stage__overlay" role="status">
              <span className="spinner" aria-hidden="true" /> Loading 3D view…
            </div>
          )}
          {sceneState.kind === "no-webgl" && (
            <div className="stage__overlay" role="alert">
              <div>
                <strong>3D view unavailable.</strong> Your browser or device doesn’t support WebGL, or it is disabled.
                Playback, the score and the event list below still work. Try a current version of Chrome, Edge,
                Firefox or Safari with hardware acceleration enabled.
              </div>
            </div>
          )}
          {sceneState.kind === "error" && (
            <div className="stage__overlay" role="alert">
              <div>
                <strong>3D view error.</strong> {sceneState.message} Playback, the score and the event list still
                work.
              </div>
            </div>
          )}
        </div>
        <Timeline
          timeMs={ui.status.timeMs}
          durationMs={fixture.durationMs}
          events={fixture.events}
          hasPrevious={previousEventTime(fixture, ui.status.timeMs) !== null}
          hasNext={nextEventTime(fixture, ui.status.timeMs) !== null}
          onSeek={onSeek}
          onScrubStart={onScrubStart}
          onScrubEnd={onScrubEnd}
          onPreviousEvent={onPreviousEvent}
          onNextEvent={onNextEvent}
        />
        <PlaybackControls
          status={ui.status}
          view={view}
          sceneAvailable={sceneState.kind === "ready"}
          onTogglePlay={onTogglePlay}
          onRestart={onRestart}
          onSpeed={onSpeed}
          onView={onView}
          onZoom={onZoom}
        />
      </div>
      <aside className="viewer__side">
        <MatchStats teams={fixture.teams} stats={stats} />
        <EventFeed events={ui.events} teams={fixture.teams} />
      </aside>
    </div>
  );
}
