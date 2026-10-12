import type { MatchEvent, MatchFixture } from "@/match/contract";
import { proChips } from "@/playback/proData";
import { eventCopy, plainDescription } from "./eventCopy";
import { shortClock } from "./format";
import { Icon } from "./Icon";
import { TeamBadge } from "./TeamBadge";

interface LiveFeedProps {
  fixture: MatchFixture;
  /** Newest first; already limited to what has happened (see liveFeed). */
  events: MatchEvent[];
  pro: boolean;
}

/**
 * Short broadcast-style feed of recent moments. It is shown over the pitch
 * only with Tactics (Pro data) on, listing every touch with its data chips;
 * otherwise it stays visually hidden but still announces new key moments to
 * screen readers.
 */
export function LiveFeed({ fixture, events, pro }: LiveFeedProps) {
  return (
    <section className={`feed${events.length === 0 ? " feed--empty" : ""}${pro ? "" : " visually-hidden"}`} aria-label="Live feed">
      <h2 className="feed__head">Live feed</h2>
      {events.length === 0 && <p className="feed__empty">Moments appear here as they happen.</p>}
      {/* Always rendered, so screen readers hear new moments as they are added. */}
      <ol className="feed__list" aria-live="polite" aria-relevant="additions">
        {events.map((e, i) => {
          const copy = eventCopy(e);
          const team = fixture.teams.find((t) => t.id === e.teamId);
          return (
            <li key={e.id} className={`fc fc--${copy.tone}${i > 0 ? " fc--old" : ""}`}>
              <span className="fc__icon">
                <Icon name={copy.icon} size={18} />
              </span>
              <div className="fc__body">
                <div className="fc__top">
                  {team && <TeamBadge team={team} />}
                  <span className="fc__title">{copy.title}</span>
                  <time className="fc__time">{shortClock(e.t)}</time>
                </div>
                <p className="fc__desc">{plainDescription(e)}</p>
                {pro && (
                  <ul className="chips" aria-label="Pro data">
                    {proChips(fixture, e).map((c) => (
                      <li key={c} className="chip">
                        {c}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
