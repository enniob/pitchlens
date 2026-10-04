import { useEffect, useRef } from "react";
import type { MatchEvent, MatchFixture } from "@/match/contract";
import type { ActiveFormation } from "@/playback/derive";
import { isKeyEvent } from "@/playback/moments";
import { proChips, type ProStatistics } from "@/playback/proData";
import type { MatchStatistics } from "@/playback/statistics";
import { eventCopy, plainDescription } from "./eventCopy";
import { formatClock } from "./format";
import { Formations } from "./Formations";
import { Icon } from "./Icon";
import { MatchStats } from "./MatchStats";
import { TeamBadge } from "./TeamBadge";

export type CentreTab = "moments" | "stats" | "formations";

interface MatchCentreProps {
  fixture: MatchFixture;
  timeMs: number;
  /** Events reached so far, oldest first. */
  events: MatchEvent[];
  stats: MatchStatistics;
  proStats: Record<"home" | "away", ProStatistics> | null;
  formations: ActiveFormation[] | null;
  pro: boolean;
  tab: CentreTab;
  keyOnly: boolean;
  selectedId: string | null;
  onTab: (tab: CentreTab) => void;
  onKeyOnly: (keyOnly: boolean) => void;
  onSelect: (id: string | null) => void;
  onReplayFrom: (timeMs: number) => void;
  onClose: () => void;
}

const TABS: [CentreTab, string][] = [
  ["moments", "Moments"],
  ["stats", "Stats"],
  ["formations", "Formations"],
];

/** Moments, statistics and formations in one panel that floats over the pitch instead of shrinking it. */
export function MatchCentre(props: MatchCentreProps) {
  const { fixture, tab, onTab, onClose } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <section className="centre" aria-labelledby="centre-title" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="centre__head">
        <h2 id="centre-title" ref={headingRef} tabIndex={-1}>
          Match centre
        </h2>
        <button type="button" className="btn btn--ghost btn--icon" aria-label="Close match centre" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="tabs" role="tablist" aria-label="Match centre">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`centre-tab-${id}`}
            aria-controls="centre-panel"
            aria-selected={tab === id}
            className="tab"
            onClick={() => onTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="centre__body" role="tabpanel" id="centre-panel" aria-labelledby={`centre-tab-${tab}`}>
        {tab === "moments" && <Moments {...props} />}
        {tab === "stats" && <MatchStats teams={fixture.teams} stats={props.stats} pro={props.pro ? props.proStats : null} />}
        {tab === "formations" &&
          (props.formations ? (
            <Formations
              teams={fixture.teams}
              roster={fixture.roster}
              formations={props.formations}
              applied={fixture.tactics?.applied}
              timeMs={props.timeMs}
            />
          ) : (
            <p className="empty">
              <strong>No formation data for this match</strong>
              The scripted demo is a short hand-made scene. Set up a match to choose each team&apos;s shape.
            </p>
          ))}
      </div>
    </section>
  );
}

function Moments({ fixture, events, pro, keyOnly, selectedId, onKeyOnly, onSelect, onReplayFrom }: MatchCentreProps) {
  const shown = (keyOnly ? events.filter(isKeyEvent) : events).slice().reverse();
  return (
    <>
      <div className="centre__filter">
        <div className="seg" role="group" aria-label="Which moments">
          <button type="button" aria-pressed={keyOnly} onClick={() => onKeyOnly(true)}>
            Key moments
          </button>
          <button type="button" aria-pressed={!keyOnly} onClick={() => onKeyOnly(false)}>
            Every touch
          </button>
        </div>
        <span className="hint">Newest first</span>
      </div>
      {shown.length === 0 ? (
        <p className="empty">
          <strong>Nothing yet</strong>Press play. Moments appear here as they happen.
        </p>
      ) : (
        <ol className="moments">
          {shown.map((e) => {
            const copy = eventCopy(e);
            const team = fixture.teams.find((t) => t.id === e.teamId);
            const selected = e.id === selectedId;
            return (
              <li key={e.id}>
                <button
                  type="button"
                  className={`moment moment--${copy.tone}${selected ? " moment--selected" : ""}`}
                  aria-expanded={selected}
                  onClick={() => onSelect(selected ? null : e.id)}
                >
                  <time className="moment__time">{formatClock(e.t)}</time>
                  <span className="moment__icon">
                    <Icon name={copy.icon} size={17} />
                  </span>
                  <span className="moment__text">
                    <span className="moment__title">{copy.title}</span>
                    <span className="moment__desc">{plainDescription(e)}</span>
                  </span>
                  {team && <TeamBadge team={team} />}
                </button>
                {selected && (
                  <div className="moment__detail">
                    <p className="moment__full">{plainDescription(e)}</p>
                    <p>{copy.explain}</p>
                    {pro && (
                      <ul className="chips" aria-label="Pro data">
                        {proChips(fixture, e).map((c) => (
                          <li key={c} className="chip">
                            {c}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="moment__actions">
                      <button type="button" className="btn" onClick={() => onReplayFrom(Math.max(0, e.t - 3_000))}>
                        <Icon name="play" />
                        Replay from 3 s before
                      </button>
                      <span className="concept">Explain this moment · coming later</span>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
