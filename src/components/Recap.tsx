import { useEffect, useMemo, useRef, useState } from "react";
import type { MatchFixture, Team } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import type { Audience, ExplainSuccess } from "@/explain/api";
import { requestExplanation } from "@/explain/client";
import { matchReferenceOf } from "@/explain/matchRef";
import { scoreAt } from "@/playback/derive";
import { proStatisticsAt } from "@/playback/proData";
import { recapMoments } from "@/playback/recap";
import { statisticsAt } from "@/playback/statistics";
import { ExplanationDetails } from "./Evidence";
import { LOCKED_HINT, useExplanationAccess } from "./ExplanationAccessGate";
import { eventCopy, plainDescription } from "./eventCopy";
import { AudienceSwitch, audienceName, CheckRow, savedTitle, type SavedExplanation } from "./ExplanationPanel";
import { formatClock } from "./format";
import { ALL_MATCH, eventMatchesFocus, normalizeFocus, type MatchFocus as Focus } from "@/playback/focus";
import { MatchFocus } from "./MatchFocus";
import { Icon } from "./Icon";
import { MiniPitch } from "./MiniPitch";

interface Props {
  /** Only rendered once playback has reached full time. */
  fixture: MatchFixture;
  audience: Audience;
  focus?: Focus;
  onFocus?: (focus: Focus) => void;
  onAudience: (audience: Audience) => void;
  /** Back to the match, replaying from this time. */
  onReplayFrom: (timeMs: number) => void;
  /** Explanations asked for during the match; at full time all of them are in the past. */
  explained?: SavedExplanation[];
  /** Back to the match at that moment, with the explanation showing. */
  onOpenExplanation?: (explanation: SavedExplanation) => void;
  /** Summaries already fetched this match, by audience, so returning to the recap does not ask again. */
  summaries?: Partial<Record<Audience, ExplainSuccess>>;
  onSummary?: (audience: Audience, result: ExplainSuccess) => void;
}

const COUNT_WORDS = ["No moments", "One moment", "Two moments", "Three moments"];

const subtitleOf = (count: number) =>
  count === 0 ? "The final numbers, and how the match unfolded." : `${COUNT_WORDS[count] ?? `${count} moments`} that shaped the result.`;

/** "The match, explained.": the defining moments, an AI summary of how the match unfolded and the final numbers. */
export function Recap({ fixture, audience, onAudience, onReplayFrom, explained = [], onOpenExplanation, summaries = {}, onSummary, focus = ALL_MATCH, onFocus }: Props) {
  const end = fixture.durationMs;
  const validFocus = normalizeFocus(fixture, focus);
  const focused = Boolean(validFocus.teamId || validFocus.playerId);
  const moments = useMemo(() => recapMoments({ ...fixture, events: fixture.events.filter((e) => eventMatchesFocus(e, validFocus)) }), [fixture, validFocus.teamId, validFocus.playerId]);
  const score = scoreAt(fixture, end);
  const home = fixture.teams.find((t) => t.side === "home")!;
  const away = fixture.teams.find((t) => t.side === "away")!;
  const replay = (t: number) => onReplayFrom(Math.max(0, t - 3_000));

  return (
    <section className="recap" aria-labelledby="recap-title">
      <header className="recap__head">
        <h2 id="recap-title">The match, explained.</h2>
        <p>{subtitleOf(moments.length)}</p>
      </header>

      <div className="recap__scoreline">
        <div className="recap__result">
          <TeamName team={home} />
          <div className="recap__score">
            <output aria-label={`Final score: ${home.name} ${score.home}, ${away.name} ${score.away}`}>
              {score.home} – {score.away}
            </output>
            <span>Full time</span>
          </div>
          <TeamName team={away} />
        </div>
        <AudienceSwitch audience={audience} onAudience={onAudience} className="recap__audience" withIcons />
      </div>

      {onFocus && <MatchFocus fixture={fixture} timeMs={end} focus={focus} onFocus={onFocus} />}
      {focused && <p className="recap__foot">{moments.length ? "Highlights for your favorite. The summary and final score cover the whole match." : "No defining moments for this favorite. Open Preferences in the header and choose Show whole match to see other highlights."}</p>}
      {moments.length > 0 && (
        <ol className="recap__moments" aria-label="Defining moments">
          {moments.map((e) => {
            const copy = eventCopy(e);
            const clock = formatClock(e.t);
            return (
              <li key={e.id} className="recap__moment">
                <div className="recap__thumb">
                  <MiniPitch fixture={fixture} timeMs={e.t} highlight={e} />
                  <time>{clock}</time>
                </div>
                <h3>{copy.title}</h3>
                <p>{plainDescription(e, fixture.roster)}</p>
                <button type="button" className="recap__replay" aria-label={`Replay moment: ${copy.title} at ${clock}`} onClick={() => replay(e.t)}>
                  <span className="recap__play" aria-hidden="true"><Icon name="play" size={14} /></span>
                  Replay moment
                  <Icon name="chevron" size={18} className="recap__go" />
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <div className="recap__lower">
        <Story key={audience} fixture={fixture} audience={audience} onReplay={replay} cached={summaries[audience]} onSummary={onSummary} />
        <Snapshot fixture={fixture} home={home} away={away} />
      </div>
      {explained.length > 0 && onOpenExplanation && (
        <section className="recap__asked" aria-labelledby="recap-asked-title">
          <h3 id="recap-asked-title">Explained moments</h3>
          {focused && <p>Saved explanations from the whole match, including both teams.</p>}
          <ol>
            {[...explained].sort((a, b) => a.atMs - b.atMs).map((s) => (
              <li key={s.id}>
                <button type="button" className="recap__asked-item" onClick={() => onOpenExplanation(s)}>
                  <span className="recap__asked-meta"><time>{formatClock(s.atMs)}</time> · {audienceName(s.audience)}</span>
                  <span className="recap__asked-title">{savedTitle(s)}</span>
                  <span className="recap__asked-go">Open in match<Icon name="arrow" size={16} /></span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className="recap__foot">Generated from synthetic match events</p>
    </section>
  );
}

function TeamName({ team }: { team: Team }) {
  return (
    <span className={`recap__team recap__team--${team.side}`}>
      <span className={`marker marker--${team.side}`} style={{ color: team.kit.primary, background: team.kit.primary }} aria-hidden="true" />
      <span className="recap__team-name">{team.name}</span>
    </span>
  );
}

/**
 * "How the match unfolded": one full-time summary from the explanation service,
 * requested when the recap opens, or once AI access is unlocked. Locking
 * abandons a summary still loading; one already shown stays.
 */
function Story({ fixture, audience, onReplay, cached, onSummary }:
  { fixture: MatchFixture; audience: Audience; onReplay: (t: number) => void; cached?: ExplainSuccess; onSummary?: (a: Audience, r: ExplainSuccess) => void }) {
  const supported = matchReferenceOf(fixture, sampleFixture.matchId) !== null;
  const allowed = useExplanationAccess();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "done"; result: ExplainSuccess }>(
    cached ? { kind: "done", result: cached } : { kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  // The attempt whose summary is on screen: a summary fetched earlier this match is reused; Try again always asks afresh.
  const answered = useRef<number | null>(cached ? 0 : null);
  const [showEvidence, setShowEvidence] = useState(false);

  useEffect(() => {
    if (!supported || !allowed || answered.current === attempt) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    requestExplanation(fixture, sampleFixture.matchId, fixture.durationMs, audience, controller.signal, fetch, "match")
      .then((result) => {
        if (controller.signal.aborted) return;
        answered.current = attempt;
        setState({ kind: "done", result });
        onSummary?.(audience, result);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setState({ kind: "error", message: e instanceof Error && !(e instanceof TypeError || e instanceof SyntaxError)
            ? e.message : "The summary could not be loaded. Check your connection and try again." });
      });
    return () => controller.abort();
    // `answered` is read as it is when an attempt starts, and onSummary is a stable callback from the viewer.
  }, [fixture, audience, supported, attempt, allowed]);

  if (!supported)
    return <article className="recap__story"><h3>How the match unfolded</h3><p>Summaries are unavailable for this match. Try the demo or generate a new match.</p></article>;
  if (!allowed && state.kind === "loading")
    return <article className="recap__story"><h3>How the match unfolded</h3><p role="status" className="recap__status">{LOCKED_HINT}</p></article>;
  if (state.kind === "loading")
    return (
      <article className="recap__story" aria-busy="true">
        <h3>How the match unfolded</h3>
        <p role="status" className="recap__status">Reading the whole match and checking the summary…</p>
        <div className="skeleton" aria-hidden="true"><span /><span /><span /></div>
      </article>
    );
  if (state.kind === "error")
    return (
      <article className="recap__story">
        <h3>How the match unfolded</h3>
        <p role="alert" className="explain__error"><Icon name="warning" size={16} />{state.message}</p>
        {!allowed && <p className="recap__status">{LOCKED_HINT}</p>}
        <button type="button" className="btn btn--small" disabled={!allowed} onClick={() => setAttempt((n) => n + 1)}>Try again</button>
      </article>
    );

  const { explanation, verification } = state.result;
  const fallback = verification?.outcome === "fallback";
  return (
    <article className="recap__story" aria-live="polite">
      <h3>How the match unfolded</h3>
      {fallback ? (
        <>
          <p>We could not produce a checked summary of this match.</p>
          {!allowed && <p className="recap__status">{LOCKED_HINT}</p>}
          <button type="button" className="btn btn--small" disabled={!allowed} onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </>
      ) : (
        <>
          <p className="recap__headline">{explanation.headline}</p>
          <p>{explanation.explanation}</p>
        </>
      )}
      <div className="recap__check">
        <CheckRow outcome={verification?.outcome} status={explanation.status} atMs={fixture.durationMs} label="Whole match, up to full time" />
        {!fallback && (explanation.facts.length > 0 || explanation.limitations.length > 0) && (
          <button type="button" className="link" aria-expanded={showEvidence} aria-controls="recap-evidence" onClick={() => setShowEvidence(!showEvidence)}>
            {showEvidence ? "Hide supporting events" : "View supporting events"}
            <Icon name="arrow" size={18} />
          </button>
        )}
      </div>
      {showEvidence && !fallback && <div className="recap__evidence" id="recap-evidence"><ExplanationDetails explanation={explanation} fixture={fixture} onReplay={onReplay} /></div>}
      <p className="explain__disclaimer">AI summary. Automated checks reduce mistakes; citations identify evidence and do not prove a claim.</p>
    </article>
  );
}

/** Final numbers, computed from the events, not by the model. */
function Snapshot({ fixture, home, away }: { fixture: MatchFixture; home: Team; away: Team }) {
  const stats = statisticsAt(fixture, fixture.durationMs);
  const pro = proStatisticsAt(fixture, fixture.durationMs);
  const rows: { label: string; h: number; a: number; format?: (v: number) => string }[] = [
    { label: "Shots", h: stats.home.shots, a: stats.away.shots },
    ...(stats.home.possessionPercent !== null && stats.away.possessionPercent !== null
      ? [{ label: "Possession", h: stats.home.possessionPercent, a: stats.away.possessionPercent, format: (v: number) => `${v}%` }]
      : []),
    { label: "Passes completed", h: pro.home.passesCompleted, a: pro.away.passesCompleted },
  ];
  return (
    <aside className="recap__snapshot" aria-labelledby="snapshot-title">
      <h3 id="snapshot-title">Match snapshot</h3>
      <table>
        <caption className="visually-hidden">Final match statistics</caption>
        <thead className="visually-hidden">
          <tr><th scope="col">Statistic</th><th scope="col">{home.name}</th><th scope="col">Comparison</th><th scope="col">{away.name}</th></tr>
        </thead>
        <tbody>
          {rows.map(({ label, h, a, format = String }) => {
            const even = h + a === 0;
            return (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td className="recap__value recap__value--home">{format(h)}</td>
                <td className="recap__bar" aria-hidden="true">
                  <span>
                    <span style={{ flexGrow: even ? 1 : h, background: home.kit.primary }} />
                    <span style={{ flexGrow: even ? 1 : a, background: away.kit.primary }} />
                  </span>
                </td>
                <td className="recap__value">{format(a)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </aside>
  );
}
