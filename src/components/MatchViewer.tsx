"use client";

/**
 * Top-level match view: the 3D pitch with its overlays (current moment,
 * scoreline, camera switch, zoom and moment pop-ups), the playback bar and the
 * moment strip, with a tabbed dock beside them: Game moments (live insights
 * that appear as key moments happen, and asking about any moment) and Tactics (the numbers so far and a live feed of every touch). Owns the one requestAnimationFrame
 * loop: each frame it advances the playback engine by real elapsed time,
 * pushes the resulting frame into the 3D scene, and syncs the React UI when
 * displayed values change.
 *
 * Match overlays use the current playback time. After an offside whistle,
 * a brief review shows the earlier kick frame while holding that clock.
 * Seeking and restarting never show future events. Playback works without
 * WebGL — only the 3D view is replaced by a message.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { MatchEvent, MatchFixture, Score } from "@/match/contract";
import { validateFixture } from "@/match/validate";
import type { ActiveFormation } from "@/playback/derive";
import { PlaybackEngine, type PlaybackStatus, type Speed } from "@/playback/engine";
import { activeBanner, liveFeed } from "@/playback/moments";
import { proStatisticsAt } from "@/playback/proData";
import { statisticsAt } from "@/playback/statistics";
import { OffsideReviewPlayback, type OffsideReview } from "@/playback/offsideReview";
import { eventCopy } from "./eventCopy";
import { formatClock, shortClock } from "./format";
import type { CameraView, MatchScene } from "@/scene/MatchScene";
import { Icon } from "./Icon";
import type { Audience, ExplainSuccess } from "@/explain/api";
import { AppBar, type AppView } from "./AppBar";
import { ExplanationPanel, type SavedExplanation } from "./ExplanationPanel";
import { LiveFeed } from "./LiveFeed";
import { MomentBanner } from "./MomentBanner";
import { MomentStrip, nextStripMoment, previousStripMoment, stripMoments as pickStripMoments } from "./MomentStrip";
import { PlaybackControls, StageControls, ZoomControls } from "./PlaybackControls";
import { Recap } from "./Recap";
import { ExplanationSchedulerScope } from "./ExplanationScheduler";
import { ScoreBug, TacticsNumbers, type PlaybackPhase } from "./ScoreBug";
import { TeamName } from "./TeamBadge";
import { Timeline } from "./Timeline";
import { MatchFocus } from "./MatchFocus";
import { ALL_MATCH, type MatchFocus as Focus } from "@/playback/focus";
import { MatchPatterns } from "./MatchPatterns";
import { SettingsDialog } from "./SettingsDialog";
import { useOpenAccessSettings } from "./ExplanationAccessGate";

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
  /** Tactics (Pro data) tab: every touch with data chips in a live feed in the dock, extra numbers. Also starts explanations in Analyst. */
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
  // Keyed by fixture so a new fixture gets a fresh engine and scene, and a fresh
  // explanation scheduler shared by the insight feed, the panel and the recap.
  return (
    <ExplanationSchedulerScope key={props.fixture.matchId} minGapMs={3_000}>
      <PlaybackViewer {...props} />
    </ExplanationSchedulerScope>
  );
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
  const arenaRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new PlaybackEngine(fixture);
    if (autoPlay) engineRef.current.play();
  }
  const sceneRef = useRef<MatchScene | null>(null);
  const tacticsRef = useRef(pro);
  tacticsRef.current = pro;
  useEffect(() => { sceneRef.current?.setTactics(pro); }, [pro]);
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [synthOpen, setSynthOpen] = useState(false);
  const [appView, setAppView] = useState<AppView>("match");
  // One audience for the panel and the recap, so switching views keeps the choice.
  // A match starts in Analyst with Pro data on; toggling Tactics later leaves the
  // choice alone, since changing audience cancels a pending explanation.
  const [audience, setAudience] = useState<Audience>(pro ? "analyst" : "casual");
  const [focus, setFocus] = useState<Focus>(ALL_MATCH);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const openAccessSettings = useOpenAccessSettings();
  // Kept here, not in the panel or recap, so moving between Match and Recap never loses an answer.
  // The viewer is keyed by match, so these reset with a new match.
  const [explained, setExplained] = useState<SavedExplanation[]>([]);
  const [shownExplanation, setShownExplanation] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Partial<Record<Audience, ExplainSuccess>>>({});
  // A retried insight keeps its id, so its new answer replaces the old one.
  const onSavedExplanation = useCallback((s: SavedExplanation) => setExplained((list) => [...list.filter((x) => x.id !== s.id), s]), []);
  const onSummary = useCallback((a: Audience, result: ExplainSuccess) => setSummaries((m) => ({ ...m, [a]: result })), []);
  // Full-time content is available only at full time, including after a replay.
  const recapReady = ui.status.ended;

  const t = ui.status.timeMs;
  // Tactics numbers, only computed while Tactics is on.
  const stats = useMemo(() => (pro ? statisticsAt(fixture, t) : null), [fixture, t, pro]);
  const proStats = useMemo(() => (pro ? proStatisticsAt(fixture, t) : null), [fixture, t, pro]);
  const stripMoments = useMemo(() => pickStripMoments(ui.events), [ui.events]);
  const feed = useMemo(() => liveFeed(fixture, t, pro), [fixture, t, pro]);
  const banner = useMemo(() => activeBanner(fixture, t), [fixture, t]);
  // A selection is only shown once its moment has been reached.
  const selected = selectedId && ui.events.some((e) => e.id === selectedId) ? selectedId : null;
  // The pitch label names the selected moment, else the latest one reached.
  const current = (selected ? ui.events.find((e) => e.id === selected) : undefined) ?? stripMoments.at(-1);

  // Full screen shows the whole match column (score, pitch, bar and strip); null when unsupported.
  const [fullscreen, setFullscreen] = useState<boolean | null>(null);
  useEffect(() => {
    if (!document.fullscreenEnabled || !arenaRef.current?.requestFullscreen) return;
    const sync = () => setFullscreen(document.fullscreenElement === arenaRef.current);
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  const onToggleFullscreen = useCallback(() => {
    const request = document.fullscreenElement ? document.exitFullscreen() : arenaRef.current?.requestFullscreen();
    request?.catch((err: unknown) => console.error(err));
  }, []);

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
          sceneRef.current.setTactics(tacticsRef.current);
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
  // Selecting a moment (card, marker or previous/next) pauses on it.
  const onSelectMoment = useCallback(
    (event: MatchEvent | null) => {
      if (!event) return;
      setSelectedId(event.id);
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
  const onZoom = useCallback((direction: "in" | "out") => {
    sceneRef.current?.zoomBy(direction === "in" ? 1.35 : 1 / 1.35);
  }, []);

  const status: PlaybackPhase = ui.status.ended
    ? "ended"
    : ui.status.playing
      ? "playing"
      : t === 0
        ? "ready"
        : "paused";
  const showEnd = ui.status.ended && !review;
  const home = fixture.teams.find((x) => x.side === "home")!;
  const away = fixture.teams.find((x) => x.side === "away")!;
  const openView = (next: AppView) => {
    if (next === "recap" && !recapReady) return;
    if (next === "recap") act((e) => e.pause());
    setAppView(next);
  };

  return (
    <div className="app">
      <AppBar
        view={appView}
        recapReady={recapReady}
        onView={openView}
        synthOpen={synthOpen}
        onToggleSynth={() => setSynthOpen(!synthOpen)}
        onNewMatch={onOpenSetup}
        onOpenPreferences={() => setPreferencesOpen(true)}
        onOpenAccess={openAccessSettings}
      />
      <SettingsDialog open={preferencesOpen} title="Preferences" onClose={() => setPreferencesOpen(false)}>
        <MatchFocus fixture={fixture} timeMs={t} focus={focus} onFocus={setFocus} />
      </SettingsDialog>
      {synthOpen && (
        <p className="synth-note" id="synth-note" role="note">
          Everything here is made up: the teams, players and events come from a match simulator, not a real game. No real match data or club branding
          is used.
        </p>
      )}
      {appView === "recap" && recapReady && (
        <Recap
          fixture={fixture}
          audience={audience}
          onAudience={setAudience}
          onReplayFrom={(time) => {
            setAppView("match");
            act((e) => {
              e.seek(time);
              e.play();
            });
          }}
          explained={explained}
          onOpenExplanation={(s) => {
            // Back to the moment it was asked at, paused, with the answer showing.
            // An automatic insight is the newest card in the feed at its moment.
            setAudience(s.audience);
            if (!s.eventId) setShownExplanation(s.id);
            setAppView("match");
            act((e) => {
              e.pause();
              e.seek(s.atMs);
            });
          }}
          summaries={summaries}
          onSummary={onSummary}
          focus={focus}
        />
      )}
      {/* Hidden, not unmounted, during the recap so the 3D scene and playback survive. */}
      <div className="workspace" hidden={appView === "recap"}>
        <div className="arena" ref={arenaRef}>
        <div className="stage">
          {/* Over the top of the pitch: current moment, scoreline, view options. */}
          <div className="hud">
            {current && (
              <p className="hud__moment">
                <Icon name={eventCopy(current).icon} size={18} />
                <span>
                  <span className="hud__moment-title">{eventCopy(current).title.replace(/!$/, "")}</span>
                  <span className="hud__moment-sep" aria-hidden="true">
                    {" "}·{" "}
                  </span>
                  <time>{shortClock(current.t)}</time>
                </span>
              </p>
            )}
            <ScoreBug
              teams={fixture.teams}
              score={ui.score}
              timeMs={t}
              status={status}
              possessionTeamId={ui.possessionTeamId}
              formations={ui.formations}
            />
            <StageControls view={view} sceneAvailable={sceneState.kind === "ready"} onView={onView} />
          </div>

          <div className="stage__pitch">
            {/* The scene appends its canvas here; React never renders children into it. */}
            <div className="stage__canvas" ref={stageRef} />
            {!review && banner && !showEnd && <MomentBanner key={banner.event.id} fixture={fixture} event={banner.event} kind={banner.kind} score={ui.score} />}
            <ZoomControls sceneAvailable={sceneState.kind === "ready"} onZoom={onZoom} />
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
                  <p>The score, clock, timeline and key moments still work.</p>
                </div>
              </div>
            )}
          </div>

          {review && (
            <div className="offside-review" role="status">
              <strong>Offside review</strong>
              <span>Position when the pass was played · {formatClock(review.frame.timeMs)}</span>
              <span>Yellow: offside line · Orange: flagged player</span>
              <span>{review.margin > 0 ? `${(review.margin * 100).toFixed(0)} cm beyond the line` : "Recorded offside call"}</span>
              <button type="button" className="btn btn--primary" onClick={onTogglePlay}>Continue</button>
            </div>
          )}
          {showWelcome && (
            <div className="stage__scrim">
              <div className="card card--welcome" role="dialog" aria-labelledby="welcome-title">
                <p className="kicker">Demo match · synthetic</p>
                <div className="versus">
                  <TeamName team={home} />
                  <span className="versus__v">v</span>
                  <TeamName team={away} />
                </div>
                <h2 id="welcome-title">Watch it like a match on TV</h2>
                <p>
                  Big moments pop up as they happen, and the timeline lets you jump back to any of them.
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
                  <TeamName team={home} />
                  <span className="versus__score" aria-label={`${home.name} ${ui.score.home}, ${away.name} ${ui.score.away}`}>
                    {ui.score.home}
                    <span aria-hidden="true">–</span>
                    {ui.score.away}
                  </span>
                  <TeamName team={away} />
                </div>
                <div className="card__actions">
                  <button type="button" className="btn btn--accent" onClick={() => openView("recap")}>
                    <Icon name="spark" />
                    See the recap
                  </button>
                  <button type="button" className="btn" onClick={onTogglePlay}>
                    <Icon name="restart" />
                    Watch again
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

        </div>
        <PlaybackControls
          status={ui.status}
          fullscreen={fullscreen}
          hasPrevious={previousStripMoment(fixture, t) !== null}
          hasNext={nextStripMoment(fixture, t) !== null}
          onTogglePlay={onTogglePlay}
          onRestart={onRestart}
          onPreviousMoment={() => onSelectMoment(previousStripMoment(fixture, t))}
          onNextMoment={() => onSelectMoment(nextStripMoment(fixture, t))}
          onSpeed={onSpeed}
          onToggleFullscreen={onToggleFullscreen}
        >
          <Timeline
            timeMs={t}
            durationMs={fixture.durationMs}
            moments={stripMoments}
            teams={fixture.teams}
            selectedId={selected}
            onSeek={onSeek}
            onScrubStart={onScrubStart}
            onScrubEnd={onScrubEnd}
            onSelectMoment={onSelectMoment}
          />
        </PlaybackControls>
        <MomentStrip fixture={fixture} moments={stripMoments} selectedId={selected} onSelect={onSelectMoment} />
        </div>
        <aside className="dock" aria-label="Match panel">
          <DockTabs tab={pro ? "tactics" : "moments"} onTab={(next) => { if ((next === "tactics") !== pro) onTogglePro?.(); }} />
          {/* Hidden, not unmounted, on the Tactics tab so a pending explanation survives. */}
          <div className="dock__panel" id="dock-panel-moments" role="tabpanel" aria-labelledby="dock-tab-moments" hidden={pro}>
          <ExplanationPanel
            fixture={fixture}
            timeMs={t}
            playback={status}
            audience={audience}
            onAudience={setAudience}
            onPause={() => act((e) => { e.pause(); e.seek(t); })}
            onReplayFrom={(time) =>
              act((e) => {
                e.seek(time);
                e.play();
              })
            }
            saved={explained}
            shownId={shownExplanation}
            focus={focus}
            onSaved={onSavedExplanation}
            onShow={setShownExplanation}
          />
          </div>
          {/* Tactics tab: the numbers so far and every touch; on Game moments, the feed is a hidden live region. */}
          <div
            className={`dock__panel tactics${pro ? "" : " tactics--off"}`}
            id="dock-panel-tactics"
            role={pro ? "tabpanel" : undefined}
            aria-labelledby={pro ? "dock-tab-tactics" : undefined}
          >
            {stats && proStats && <TacticsNumbers teams={fixture.teams} stats={stats} extra={proStats} />}
            {pro && <MatchPatterns fixture={fixture} timeMs={t} favoriteTeamId={focus.teamId ?? undefined} favoritePlayerId={focus.playerId ?? undefined} onReplay={(time) => act((e) => { e.seek(time); e.play(); })} />}
            <LiveFeed fixture={fixture} events={feed} pro={pro} />
          </div>
        </aside>
      </div>
    </div>
  );
}

type DockTab = "moments" | "tactics";

const DOCK_TABS: readonly (readonly [DockTab, string])[] = [
  ["moments", "Game moments"],
  ["tactics", "Tactics"],
];

/** Tabs at the top of the dock; arrow keys move between them. */
function DockTabs({ tab, onTab }: { tab: DockTab; onTab: (tab: DockTab) => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const index = DOCK_TABS.findIndex(([id]) => id === tab);
    const next = DOCK_TABS[(index + (e.key === "ArrowRight" ? 1 : DOCK_TABS.length - 1)) % DOCK_TABS.length]![0];
    onTab(next);
    document.getElementById(`dock-tab-${next}`)?.focus();
  };
  return (
    <div className="dock__tabs" role="tablist" aria-label="Match panel" onKeyDown={onKeyDown}>
      {DOCK_TABS.map(([id, label]) => (
        <button
          type="button"
          key={id}
          id={`dock-tab-${id}`}
          role="tab"
          aria-selected={tab === id}
          aria-controls={`dock-panel-${id}`}
          tabIndex={tab === id ? 0 : -1}
          onClick={() => onTab(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
