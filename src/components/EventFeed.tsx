import type { MatchEvent, Team } from "@/match/contract";
import { formatClock } from "./format";

interface EventFeedProps {
  events: MatchEvent[];
  teams: [Team, Team];
}

/** Recent events, newest first. Receives only events whose timestamps have been reached. */
export function EventFeed({ events, teams }: EventFeedProps) {
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const newestFirst = [...events].reverse();
  return (
    <section className="events" aria-labelledby="events-heading">
      <h2 id="events-heading" className="events__heading">
        Recent events
      </h2>
      {newestFirst.length === 0 ? (
        <p className="events__empty">No events yet — press Play.</p>
      ) : (
        <ol className="events__list" aria-live="polite" aria-relevant="additions">
          {newestFirst.map((e) => {
            const team = teamById.get(e.teamId);
            return (
              <li key={e.id} className={`event event--${e.type}`}>
                <time className="event__time">{formatClock(e.t)}</time>
                <span className="kit-dot" style={{ background: team?.kit.primary }} aria-hidden="true" />
                <span className="event__text">{e.description}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
