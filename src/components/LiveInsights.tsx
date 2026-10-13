import { useEffect, useRef, useState } from "react";
import type { MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import type { Audience } from "@/explain/api";
import { requestExplanation } from "@/explain/client";
import { insightMomentsBetween } from "@/playback/moments";
import { ALL_MATCH, eventMatchesFocus, normalizeFocus, type MatchFocus } from "@/playback/focus";
import { eventCopy } from "./eventCopy";
import { useExplanationAccess } from "./ExplanationAccessGate";
import { ExplanationSchedulerScope, useExplanationScheduler } from "./ExplanationScheduler";
import { audienceName, ExplanationBody, MatchFactsChip, savedTitle, showsMatchFacts, type SavedExplanation } from "./ExplanationPanel";
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
  focus?: MatchFocus;
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
 * Requests share the viewer's scheduler, so an insight waits for a manual
 * explanation or the recap and, while it waits, a newer moment replaces it.
 * Answers arrive after the moment (typically 10–20 s) and are labelled with
 * its time. A card only shows once playback has reached its moment, so a
 * backward seek hides it again (and abandons a request for it).
 * While AI access is locked nothing is requested and pending work is dropped;
 * the newest moment missed that way is explained once access returns.
 */
export function LiveInsights(props: Props) {
  return <ExplanationSchedulerScope><Insights {...props} /></ExplanationSchedulerScope>;
}

function Insights({ fixture, timeMs, playback, audience, saved, onSaved, onReplayFrom, focus = ALL_MATCH }: Props) {
  const scheduler = useExplanationScheduler();
  const validFocus = normalizeFocus(fixture, focus);
  // Key moments that got, or were offered, an insight, oldest first.
  const [moments, setMoments] = useState<{ id: string; t: number }[]>([]);
  const [running, setRunning] = useState<Job | null>(null);
  const runningRef = useRef<Job | null>(null);
  // Whether the running job has been sent, or is still waiting for the scheduler.
  const [sent, setSent] = useState(false);
  const sentRef = useRef(false);
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
  const timeRef = useRef(timeMs);
  timeRef.current = timeMs;
  const allowed = useExplanationAccess();
  const allowedRef = useRef(allowed);
  allowedRef.current = allowed;
  // The newest automatic insight not asked for, or dropped, because access was locked.
  const missed = useRef<Job | null>(null);

  useEffect(() => () => { controller.current?.abort(); }, []);

  const setQueue = (job: Job | null) => { queued.current = job; setQueuedJob(job); };

  function abandonRunning() {
    controller.current?.abort();
    controller.current = null;
    runningRef.current = null;
    setRunning(null);
    markSent(false);
  }

  function markSent(value: boolean) { sentRef.current = value; setSent(value); }

  function startNext() {
    const next = queued.current;
    setQueue(null);
    if (next) start(next);
  }

  function start(job: Job) {
    // A checked answer is kept; one that failed its checks may be asked for again, and replaces it.
    const done = savedRef.current.find((s) => s.id === insightId(job.eventId, job.audience));
    if (!allowedRef.current || (done && !isFallback(done)) || sameJob(runningRef.current, job)) return;
    // Busy: wait, replacing anything older that was waiting. A job the scheduler
    // has not sent yet is waiting too, so the newer one takes its place.
    if (controller.current && sentRef.current) { setQueue(job); return; }
    if (controller.current) abandonRunning();
    const c = new AbortController();
    controller.current = c;
    runningRef.current = job;
    setRunning(job);
    setErrors((m) => {
      const { [insightId(job.eventId, job.audience)]: _cleared, ...rest } = m;
      return rest;
    });
    // Not sent once playback is back before the moment or access is locked; the effects below then drop it.
    const wanted = () => allowedRef.current && timeRef.current >= job.atMs;
    scheduler.schedule({ priority: "automatic", signal: c.signal, wanted, onStart: () => markSent(true) },
      () => requestExplanation(fixture, sampleFixture.matchId, job.atMs, job.audience, c.signal, fetch, "moment", delay => scheduler.defer(delay)))
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
        markSent(false);
        startNext();
      });
  }

  // Preference changes abandon hidden work before another queued request can start.
  useEffect(() => {
    const relevant = (job: Job) => {
      const event = fixture.events.find((e) => e.id === job.eventId);
      return Boolean(event && eventMatchesFocus(event, validFocus));
    };
    if (queued.current && !relevant(queued.current)) setQueue(null);
    if (runningRef.current && !relevant(runningRef.current)) {
      abandonRunning();
      startNext();
    }
  }, [validFocus.teamId, validFocus.playerId]);

  // Locking or expiry drops all pending work; unlocking picks up the newest missed moment if it still applies.
  useEffect(() => {
    if (!allowed) {
      const pending = queued.current ?? runningRef.current;
      if (pending) missed.current = pending;
      setQueue(null);
      abandonRunning();
      return;
    }
    const job = missed.current;
    missed.current = null;
    const event = job && fixture.events.find((e) => e.id === job.eventId);
    if (job && event && job.audience === audience && timeMs >= job.atMs && eventMatchesFocus(event, validFocus)) start(job);
    // Runs once per access change; the other values are read as they are at that moment.
  }, [allowed]);

  useEffect(() => {
    const from = prevTime.current;
    prevTime.current = timeMs;
    // Back before a moment: abandon its request or its place in the queue.
    if (missed.current && timeMs < missed.current.atMs) missed.current = null;
    if (queued.current && timeMs < queued.current.atMs) setQueue(null);
    if (runningRef.current && timeMs < runningRef.current.atMs) {
      abandonRunning();
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
    const latest = reached.filter((event) => eventMatchesFocus(event, validFocus)).at(-1);
    if (!latest) return;
    const job = { eventId: latest.id, atMs: latest.t, audience };
    if (allowedRef.current) start(job);
    else missed.current = job;
    // Runs once per clock change; the other values are read as they are at that moment.
  }, [timeMs]);

  const visible = moments
    .filter((m) => { const event = fixture.events.find((e) => e.id === m.id); return event && eventMatchesFocus(event, validFocus); })
    .filter((m) => m.t <= timeMs || (replay?.eventId === m.id && timeMs >= replay.floor))
    .reverse();
  const openEventId = openId === null ? null : openId && visible.some((m) => m.id === openId) ? openId : visible[0]?.id;

  return (
    <section className="insights" aria-labelledby="insights-title">
      <h3 id="insights-title" className="visually-hidden">Automatic insights</h3>
      {visible.length === 0 && (
        <p className="explain__empty">{validFocus.teamId || validFocus.playerId ? "No insights for this favorite yet. Open Preferences in the header and choose Show whole match to see other moments." : "Insights appear here as goals, shots, fouls, offsides and tactical changes happen. They only use what has happened so far."}</p>
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
            <li key={m.id} className={`insight insight--${copy.tone}${open ? " insight--open" : ""}${result && showsMatchFacts(result.result) ? " insight--facts" : ""}`}>
              <button type="button" className="insight__head" aria-expanded={open} onClick={() => setOpenId(open ? null : m.id)}>
                <Icon name={copy.icon} size={16} />
                <span className="insight__title">{copy.title.replace(/!$/, "")}</span>
                <time className="insight__time">{shortClock(m.t)}</time>
              </button>
              {sameJob(running, job) && !sent ? (
                <p className="insight__status">Queued. Waiting for the next explanation slot…</p>
              ) : sameJob(running, job) ? (
                <p className="insight__status" role="status"><span className="spinner spinner--small" aria-hidden="true" />Reading the evidence up to {formatClock(m.t)} and checking the answer…</p>
              ) : sameJob(queuedJob, job) ? (
                <p className="insight__status">Waiting for the previous insight…</p>
              ) : error ? (
                <div className="insight__status">
                  <p className="explain__error" role="alert"><Icon name="warning" size={16} />{error}</p>
                  <button type="button" className="btn btn--ghost btn--small" disabled={!allowed} onClick={() => start(job)}>Try again</button>
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
                  <p className="insight__headline">{showsMatchFacts(result.result) && <MatchFactsChip placement="lead" />}{savedTitle(result)}</p>
                )
              ) : (
                <button type="button" className="btn btn--ghost btn--small insight__ask" disabled={!allowed} onClick={() => start(job)}>
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
