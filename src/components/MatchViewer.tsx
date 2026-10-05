"use client";

/**
 * Top-level viewer in "broadcast mode": the 3D pitch fills the stage, with a
 * TV-style score bug, moment pop-ups, a short live feed, a floating control
 * bar and a Match centre panel laid over it. Owns the one requestAnimationFrame
 * loop: each frame it advances the playback engine by real elapsed time,
 * pushes the resulting frame into the 3D scene, and syncs the React UI when
 * displayed values change.
 *
 * Match overlays use the current playback time. After an offside whistle,
 * a brief review shows the earlier kick frame while holding that clock.
 * Seeking and restarting never show future events. Playback works without
 * WebGL — only the 3D view is replaced by a message.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MatchEvent, MatchFixture, Score } from "@/match/contract";
import { validateFixture } from "@/match/validate";
import type { ActiveFormation } from "@/playback/derive";
import { PlaybackEngine, type PlaybackStatus, type Speed } from "@/playback/engine";
import { activeBanner, liveFeed, nextMomentTime, previousMomentTime, timelineMoments } from "@/playback/moments";
import { proStatisticsAt } from "@/playback/proData";
import { statisticsAt } from "@/playback/statistics";
import { OffsideReviewPlayback, type OffsideReview } from "@/playback/offsideReview";
import { formatClock } from "./format";
import type { CameraView, MatchScene } from "@/scene/MatchScene";
import { Icon } from "./Icon";
import { LiveFeed } from "./LiveFeed";
import { MatchCentre, type CentreTab } from "./MatchCentre";
import { MomentBanner } from "./MomentBanner";
import { PlaybackControls } from "./PlaybackControls";
import { ScoreBug } from "./ScoreBug";
import { TeamBadge } from "./TeamBadge";
import { Timeline } from "./Timeline";

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
  formations: ActiveFormation[] | null;
  possessionTeamId: string | null;
}

export interface MatchViewerProps {
  fixture: MatchFixture;
  /** Show Pro data (every touch with data chips, extra numbers). */
  pro?: boolean;
  onTogglePro?: () => void;
  /** Opens the "Set up match" drawer; the button is hidden without it. */
  onOpenSetup?: () => void;
  /** First-visit card over the pitch. */
  showWelcome?: boolean;
  onWelcomeDone?: () => void;
  /** Start playing as soon as the match loads (after Generate or Scripted demo). */
  autoPlay?: boolean;
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
  return {
    status: engine.status,
    score: frame.score,
    events: frame.events,
    formations: frame.formations,
    possessionTeamId: frame.possession?.teamId ?? null,
  };
}

/** Only re-render React when something visible changes (clock is shown to 0.1 s). */
function uiKey(ui: UiState): string {
  const s = ui.status;
  const shapes = ui.formations?.map((f) => `${f.formation}@${f.since}`).join(",") ?? "";
  return `${Math.floor(s.timeMs / 100)}|${s.playing}|${s.speed}|${ui.events.length}|${ui.score.home}-${ui.score.away}|${shapes}|${ui.possessionTeamId}`;
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
export function MatchViewer(props: MatchViewerProps) {
  const errors = useMemo(() => safeValidate(props.fixture), [props.fixture]);
  if (errors.length > 0) return <FixtureErrors errors={errors} />;
  // Keyed by fixture so a new fixture gets a fresh engine and scene.
  return <PlaybackViewer key={props.fixture.matchId} {...props} />;
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
function PlaybackViewer({ fixture, pro = false, onTogglePro, onOpenSetup, showWelcome = false, onWelcomeDone, autoPlay = false }: MatchViewerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new PlaybackEngine(fixture);
    if (autoPlay) engineRef.current.play();
  }
  const sceneRef = useRef<MatchScene | null>(null);
  const reviewPlaybackRef = useRef<OffsideReviewPlayback | null>(null);
  if (!reviewPlaybackRef.current) reviewPlaybackRef.current = new OffsideReviewPlayback(engineRef.current);
  const [review, setReview] = useState<OffsideReview | null>(null);
  const reviewUiRef = useRef<OffsideReview | null>(null);
  const [sceneState, setSceneState] = useState<SceneState>({ kind: "loading" });
  // "Broadcast" is the existing angled camera; Top is the overhead view.
  const [view, setView] = useState<CameraView>("angled");
  const viewRef = useRef(view);
  viewRef.current = view;
  const [ui, setUi] = useState<UiState>(() => readUi(engineRef.current!));
  const uiKeyRef = useRef(uiKey(ui));
  const [centreOpen, setCentreOpen] = useState(false);
  const [tab, setTab] = useState<CentreTab>("moments");
  const [keyOnly, setKeyOnly] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [synthOpen, setSynthOpen] = useState(false);

  const t = ui.status.timeMs;
  const stats = useMemo(() => statisticsAt(fixture, t), [fixture, t]);
  const proStats = useMemo(() => (pro ? proStatisticsAt(fixture, t) : null), [fixture, t, pro]);
  const moments = useMemo(() => timelineMoments(fixture, t), [fixture, t]);
  const feed = useMemo(() => liveFeed(fixture, t, pro), [fixture, t, pro]);
  const banner = useMemo(() => activeBanner(fixture, t), [fixture, t]);
  // A selection is only shown once its moment has been reached.
  const selected = selectedId && ui.events.some((e) => e.id === selectedId) ? selectedId : null;

  const syncUi = useCallback((force = false) => {
    const currentReview = reviewPlaybackRef.current!.review;
    if (currentReview !== reviewUiRef.current) {
      reviewUiRef.current = currentReview;
      setReview(currentReview);
    }
    const next = readUi(engineRef.current!);
    const key = uiKey(next);
    if (force || key !== uiKeyRef.current) {
      uiKeyRef.current = key;
      setUi(next);
    }
  }, []);

  // Animation loop + scene lifecycle.
  useEffect(() => {
    const stage = stageRef.current!;
    let cancelled = false;
    let raf = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const delta = Math.min(MAX_FRAME_MS, Math.max(0, now - last));
      last = now;
      const playback = reviewPlaybackRef.current!;
      playback.advance(delta);
      const scene = sceneRef.current;
      if (scene) {
        scene.update(playback.frame());
        scene.setOffsideReview(playback.review);
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
          sceneRef.current.setView(viewRef.current);
          sceneRef.current.update(reviewPlaybackRef.current!.frame());
          sceneRef.current.setOffsideReview(reviewPlaybackRef.current!.review);
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

  const act = useCallback(
    (fn: (engine: PlaybackEngine) => void) => {
      reviewPlaybackRef.current!.cancel();
      fn(engineRef.current!);
      syncUi(true);
    },
    [syncUi],
  );
  const onTogglePlay = useCallback(() => {
    if (reviewPlaybackRef.current!.review) {
      reviewPlaybackRef.current!.finish();
      syncUi(true);
    } else act((e) => e.togglePlay());
  }, [act, syncUi]);
  const onRestart = useCallback(() => {
    setSelectedId(null);
    act((e) => e.restart());
  }, [act]);
  const onSeek = useCallback(
    (timeMs: number) => {
      // Scrubbing leaves the selected moment behind.
      setSelectedId(null);
      act((e) => e.seek(timeMs));
    },
    [act],
  );
  // Dragging the slider holds playback so the clock doesn't fight the pointer.
  const wasPlayingRef = useRef<boolean | null>(null);
  const onScrubStart = useCallback(() => {
    act((e) => {
      wasPlayingRef.current = e.status.playing;
      e.pause();
    });
  }, [act]);
  const onScrubEnd = useCallback(() => {
    act((e) => {
      if (wasPlayingRef.current && !e.status.ended) e.play();
      wasPlayingRef.current = null;
    });
  }, [act]);
  const jumpTo = useCallback(
    (time: number | null) => {
      if (time === null) return;
      const event = fixture.events.find((e) => e.t === time);
      setSelectedId(event?.id ?? null);
      act((e) => {
        e.pause();
        e.seek(time);
      });
    },
    [act, fixture],
  );
  const onSelectMoment = useCallback(
    (event: MatchEvent) => {
      setSelectedId(event.id);
      setTab("moments");
      setCentreOpen(true);
      act((e) => {
        e.pause();
        e.seek(event.t);
      });
    },
    [act],
  );
  const onSpeed = useCallback((speed: Speed) => {
    engineRef.current!.setSpeed(speed);
    syncUi(true);
  }, [syncUi]);
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

  const status: "ready" | "playing" | "paused" | "ended" = ui.status.ended
    ? "ended"
    : ui.status.playing
      ? "playing"
      : t === 0
        ? "ready"
        : "paused";
  const showEnd = ui.status.ended && !centreOpen && !review;

  return (
    <div className="broadcast">
      <div className="stage">
        {/* The scene appends its canvas here; React never renders children into it. */}
        <div className="stage__canvas" ref={stageRef} />

        <div className="stage__top">
          <ScoreBug
            teams={fixture.teams}
            score={ui.score}
            timeMs={t}
            status={status}
            possessionTeamId={ui.possessionTeamId}
            formations={ui.formations}
            pro={pro && proStats ? { stats, extra: proStats } : null}
          />
          <div className="stage__actions">
            <button type="button" className="synth" aria-expanded={synthOpen} aria-controls="synth-note" onClick={() => setSynthOpen(!synthOpen)}>
              <Icon name="info" size={16} />
              Synthetic match
            </button>
            <button
              type="button"
              className="btn btn--glass"
              aria-expanded={centreOpen}
              aria-label="Match centre: moments, stats and formations"
              onClick={() => setCentreOpen(!centreOpen)}
            >
              <Icon name="list" />
              <span className="btn__label">Match centre</span>
            </button>
            {onOpenSetup && (
              <button type="button" className="btn btn--glass" aria-label="Set up match" onClick={onOpenSetup}>
                <Icon name="setup" />
                <span className="btn__label">Set up match</span>
              </button>
            )}
          </div>
        </div>
        {synthOpen && (
          <p className="synth-note" id="synth-note" role="note">
            Everything here is made up: the teams, players and events come from a match simulator, not a real game. No real match data or club branding
            is used.
          </p>
        )}

        {review && (
          <div className="offside-review" role="status">
            <strong>Offside review</strong>
            <span>Position when the pass was played · {formatClock(review.frame.timeMs)}</span>
            <span>Yellow: offside line · Orange: flagged player</span>
            <span>{review.margin > 0 ? `${(review.margin * 100).toFixed(0)} cm beyond the line` : "Recorded offside call"}</span>
            <button type="button" className="btn btn--primary" onClick={onTogglePlay}>Continue</button>
          </div>
        )}
        {!review && banner && !showEnd && <MomentBanner key={banner.event.id} fixture={fixture} event={banner.event} kind={banner.kind} score={ui.score} />}

        <LiveFeed fixture={fixture} events={feed} pro={pro} />

        {centreOpen && (
          <MatchCentre
            fixture={fixture}
            timeMs={t}
            events={ui.events}
            stats={stats}
            proStats={proStats}
            formations={ui.formations}
            pro={pro}
            tab={tab}
            keyOnly={keyOnly}
            selectedId={selected}
            onTab={setTab}
            onKeyOnly={setKeyOnly}
            onSelect={setSelectedId}
            onReplayFrom={(time) =>
              act((e) => {
                e.seek(time);
                e.play();
              })
            }
            onClose={() => setCentreOpen(false)}
          />
        )}

        {sceneState.kind === "loading" && (
          <div className="stage__message" role="status">
            <span className="spinner" aria-hidden="true" /> Loading 3D view…
          </div>
        )}
        {(sceneState.kind === "no-webgl" || sceneState.kind === "error") && (
          <div className="stage__message stage__message--card" role="alert">
            <div className="card">
              <h2>{sceneState.kind === "no-webgl" ? "The 3D view isn't available on this device" : "The 3D view stopped working"}</h2>
              <p>
                {sceneState.kind === "no-webgl"
                  ? "Your browser doesn't support WebGL, or it is turned off. Try a recent version of Chrome, Edge, Firefox or Safari with hardware acceleration on."
                  : sceneState.message}
              </p>
              <p>The score, clock, timeline, live feed and Match centre still work.</p>
            </div>
          </div>
        )}

        {showWelcome && (
          <div className="stage__scrim">
            <div className="card card--welcome" role="dialog" aria-labelledby="welcome-title">
              <p className="kicker">Demo match · synthetic</p>
              <div className="versus">
                <TeamBadge team={fixture.teams.find((x) => x.side === "home")!} />
                <span>v</span>
                <TeamBadge team={fixture.teams.find((x) => x.side === "away")!} />
              </div>
              <h2 id="welcome-title">Watch it like a match on TV</h2>
              <p>
                {fixture.teams.find((x) => x.side === "home")!.name} against {fixture.teams.find((x) => x.side === "away")!.name}. Big moments pop up as
                they happen, and the timeline lets you jump back to any of them.
              </p>
              <p className="small">The teams, players and events are made up by a simulator. No real match data is used.</p>
              <div className="card__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--large"
                  onClick={() => {
                    onWelcomeDone?.();
                    act((e) => {
                      e.restart();
                      e.play();
                    });
                  }}
                >
                  <Icon name="play" />
                  Kick off the demo
                </button>
                {onOpenSetup && (
                  <button type="button" className="btn btn--large" onClick={onOpenSetup}>
                    Set up your own match
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {showEnd && !showWelcome && (
          <div className="stage__scrim stage__scrim--light">
            <div className="card card--center">
              <p className="kicker">Full time</p>
              <div className="versus">
                <TeamBadge team={fixture.teams.find((x) => x.side === "home")!} />
                <span className="versus__score">
                  {ui.score.home} – {ui.score.away}
                </span>
                <TeamBadge team={fixture.teams.find((x) => x.side === "away")!} />
              </div>
              <div className="card__actions">
                <button type="button" className="btn btn--primary" onClick={onTogglePlay}>
                  <Icon name="restart" />
                  Watch again
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setTab("moments");
                    setKeyOnly(true);
                    setCentreOpen(true);
                  }}
                >
                  Key moments
                </button>
                {onOpenSetup && (
                  <button type="button" className="btn" onClick={onOpenSetup}>
                    New match
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        <PlaybackControls
          status={ui.status}
          view={view}
          sceneAvailable={sceneState.kind === "ready"}
          pro={pro}
          hasPrevious={previousMomentTime(fixture, t) !== null}
          hasNext={nextMomentTime(fixture, t) !== null}
          onTogglePlay={onTogglePlay}
          onRestart={onRestart}
          onPreviousMoment={() => jumpTo(previousMomentTime(fixture, t))}
          onNextMoment={() => jumpTo(nextMomentTime(fixture, t))}
          onSpeed={onSpeed}
          onView={onView}
          onZoom={onZoom}
          onTogglePro={() => onTogglePro?.()}
        >
          <Timeline
            timeMs={t}
            durationMs={fixture.durationMs}
            moments={moments}
            teams={fixture.teams}
            selectedId={selected}
            onSeek={onSeek}
            onScrubStart={onScrubStart}
            onScrubEnd={onScrubEnd}
            onSelectMoment={onSelectMoment}
          />
        </PlaybackControls>
      </div>
    </div>
  );
}
