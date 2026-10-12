import { useEffect, useRef, useState } from "react";
import type { MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import type { Audience } from "@/explain/api";
import { requestExplanation } from "@/explain/client";
import { insightMomentsBetween } from "@/playback/moments";
import { eventCopy } from "./eventCopy";
import { audienceName, ExplanationBody, FALLBACK_TITLE, type SavedExplanation } from "./ExplanationPanel";
import { formatClock, shortClock } from "./format";
import { Icon } from "./Icon";
import type { PlaybackPhase } from "./ScoreBug";

/**
 * Largest clock step still treated as play running on. A bigger jump is a
 * seek: moments skipped over are not explained, nor are moments reached while
 * paused or by selecting them.
 */
export const NATURAL_STEP_MS = 2_000;

interface Props {
  fixture: MatchFixture;
  timeMs: number;
  playback: PlaybackPhase;
  audience: Audience;
  saved: SavedExplanation[];
  onSaved: (explanation: SavedExplanation) => void;
  onReplayFrom: (timeMs: number) => void;
}

/** One automatic insight to ask for: a key moment, cut off at that moment's own time. */
interface Job {
  eventId: string;
  atMs: number;
  audience: Audience;
}

export const insightId = (eventId: string, audience: Audience) => `auto-${audience}-${eventId}`;
const isFallback = (s: SavedExplanation | undefined) => s?.result.verification?.outcome === "fallback";
const sameJob = (a: Job | null, b: Job) => a !== null && a.eventId === b.eventId && a.audience === b.audience;

/**
 * Automatic insights: when play runs into a key moment (see isInsightMoment),
 * an explanation is requested for that moment's time through the same service,
 * checks and client validation as "Explain this moment", without pausing.
 * Bounded: one request at a time and at most one waiting, the newest; a moment
 * passed over while busy keeps a card with an explicit "Explain" instead.
 * Answers arrive after the moment (typically 10–20 s) and are labelled with
 * its time. A card only shows once playback has reached its moment, so a
 * backward seek hides it again (and abandons a request for it).
 */
export function LiveInsights({ fixture, timeMs, playback, audience, saved, onSaved, onReplayFrom }: Props) {
  // Key moments that got, or were offered, an insight, oldest first.
  const [moments, setMoments] = useState<{ id: string; t: number }[]>([]);
  const [running, setRunning] = useState<Job | null>(null);
  const runningRef = useRef<Job | null>(null);
  const controller = useRef<AbortController | null>(null);
  const queued = useRef<Job | null>(null);
  const [queuedJob, setQueuedJob] = useState<Job | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Which card is open: undefined means the newest one shown, null means all are collapsed.
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  // Replaying a card's cited evidence may rewind before its moment without hiding it.
  const [replay, setReplay] = useState<{ eventId: string; floor: number } | null>(null);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const prevTime = useRef(timeMs);

  useEffect(() => () => { controller.current?.abort(); }, []);

  const setQueue = (job: Job | null) => { queued.current = job; setQueuedJob(job); };

  function startNext() {
    const next = queued.current;
    setQueue(null);
    if (next) start(next);
  }

  function start(job: Job) {
    // A checked answer is kept; one that failed its checks may be asked for again, and replaces it.
    const done = savedRef.current.find((s) => s.id === insightId(job.eventId, job.audience));
    if ((done && !isFallback(done)) || sameJob(runningRef.current, job)) return;
    // Busy: wait, replacing anything older that was waiting.
    if (controller.current) { setQueue(job); return; }
    const c = new AbortController();
    controller.current = c;
    runningRef.current = job;
    setRunning(job);
    setErrors((m) => {
      const { [insightId(job.eventId, job.audience)]: _cleared, ...rest } = m;
      return rest;
    });
    requestExplanation(fixture, sampleFixture.matchId, job.atMs, job.audience, c.signal)
      .then((result) => {
        if (!c.signal.aborted) onSaved({ id: insightId(job.eventId, job.audience), atMs: job.atMs, audience: job.audience, eventId: job.eventId, result });
      })
      .catch((e: unknown) => {
        if (c.signal.aborted) return;
        const message = e instanceof Error && !(e instanceof TypeError || e instanceof SyntaxError)
          ? e.message : "The insight could not be loaded. Check your connection and try again.";
        setErrors((m) => ({ ...m, [insightId(job.eventId, job.audience)]: message }));
      })
      .finally(() => {
        if (controller.current !== c) return;
        controller.current = null;
        runningRef.current = null;
        setRunning(null);
        startNext();
      });
  }

  useEffect(() => {
    const from = prevTime.current;
    prevTime.current = timeMs;
    // Back before a moment: abandon its request or its place in the queue.
    if (queued.current && timeMs < queued.current.atMs) setQueue(null);
    if (runningRef.current && timeMs < runningRef.current.atMs) {
      controller.current?.abort();
      controller.current = null;
      runningRef.current = null;
      setRunning(null);
      startNext();
    }
    if (replay) {
      const t = moments.find((m) => m.id === replay.eventId)?.t ?? 0;
      if (timeMs < replay.floor || timeMs >= t) setReplay(null);
    }
    if (playback !== "playing" || timeMs <= from || timeMs - from > NATURAL_STEP_MS) return;
    const reached = insightMomentsBetween(fixture, from, timeMs);
    if (reached.length === 0) return;
    setMoments((list) => [...list, ...reached.filter((e) => !list.some((m) => m.id === e.id)).map((e) => ({ id: e.id, t: e.t }))]);
    setOpenId(undefined);
    // Only the latest moment reached in one step is explained automatically.
    const latest = reached.at(-1)!;
    start({ eventId: latest.id, atMs: latest.t, audience });
    // Runs once per clock change; the other values are read as they are at that moment.
  }, [timeMs]);

  const visible = moments
    .filter((m) => m.t <= timeMs || (replay?.eventId === m.id && timeMs >= replay.floor))
    .reverse();
  const openEventId = openId === null ? null : openId && visible.some((m) => m.id === openId) ? openId : visible[0]?.id;

  return (
    <section className="insights" aria-labelledby="insights-title">
      <h3 id="insights-title" className="visually-hidden">Automatic insights</h3>
      {visible.length === 0 && (
        <p className="explain__empty">Insights appear here as goals, shots, fouls near goal and tactical changes happen. They only use what has happened so far.</p>
      )}
      <ol className="insights__list" aria-live="polite" aria-relevant="additions">
        {visible.map((m) => {
          const event = fixture.events.find((e) => e.id === m.id)!;
          const copy = eventCopy(event);
          const job = { eventId: m.id, atMs: m.t, audience };
          const result = saved.find((s) => s.id === insightId(m.id, audience));
          const error = errors[insightId(m.id, audience)];
          const open = m.id === openEventId;
          const replayFrom = (t: number) => {
            const floor = Math.max(0, t - 3_000);
            setOpenId(m.id);
            setReplay({ eventId: m.id, floor });
            onReplayFrom(floor);
          };
          return (
            <li key={m.id} className={`insight insight--${copy.tone}${open ? " insight--open" : ""}`}>
              <button type="button" className="insight__head" aria-expanded={open} onClick={() => setOpenId(open ? null : m.id)}>
                <Icon name={copy.icon} size={16} />
                <span className="insight__title">{copy.title.replace(/!$/, "")}</span>
                <time className="insight__time">{shortClock(m.t)}</time>
              </button>
              {sameJob(running, job) ? (
                <p className="insight__status" role="status"><span className="spinner spinner--small" aria-hidden="true" />Reading the evidence up to {formatClock(m.t)} and checking the answer…</p>
              ) : sameJob(queuedJob, job) ? (
                <p className="insight__status">Waiting for the previous insight…</p>
              ) : error ? (
                <div className="insight__status">
                  <p className="explain__error" role="alert"><Icon name="warning" size={16} />{error}</p>
                  <button type="button" className="btn btn--ghost btn--small" onClick={() => start(job)}>Try again</button>
                </div>
              ) : result ? (
                open ? (
                  <article className="insight__answer">
                    <p className="explain__meta"><span>{audienceName(audience)} · evidence up to {formatClock(m.t)}</span></p>
                    {replay?.eventId === m.id && <p className="explain__notice">Replaying cited evidence up to {formatClock(m.t)}.</p>}
                    <ExplanationBody fixture={fixture} result={result.result} audience={audience} onReplay={replayFrom}
                      onRetry={isFallback(result) ? () => start(job) : undefined} />
                  </article>
                ) : (
                  <p className="insight__headline">{isFallback(result) ? FALLBACK_TITLE : result.result.explanation.headline}</p>
                )
              ) : (
                <button type="button" className="btn btn--ghost btn--small insight__ask" onClick={() => start(job)}>
                  <Icon name="spark" size={14} />Explain for {audienceName(audience)}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
