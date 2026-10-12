import type { Score, Team } from "@/match/contract";
import type { ActiveFormation } from "@/playback/derive";
import type { ProStatistics } from "@/playback/proData";
import type { MatchStatistics } from "@/playback/statistics";
import { shortClock } from "./format";
import { TeamName } from "./TeamBadge";

export type PlaybackPhase = "ready" | "playing" | "paused" | "ended";

interface ScoreBugProps {
  teams: [Team, Team];
  score: Score;
  timeMs: number;
  status: PlaybackPhase;
  /** Team in control of the ball right now, if any. */
  possessionTeamId: string | null;
  formations: ActiveFormation[] | null;
}

const STATUS_TEXT = { ready: "Ready", playing: "Live", paused: "Paused", ended: "Full time" } as const;

/**
 * The scoreline, a glass pill at the top of the pitch: full team names, score,
 * then clock, playback status and both teams' current shapes when the fixture
 * has them. Team identity never relies on colour alone: each name sits next to
 * its kit-colour marker in the team's shape (home circle, away square).
 */
export function ScoreBug({ teams, score, timeMs, status, possessionTeamId, formations }: ScoreBugProps) {
  const home = teams.find((t) => t.side === "home")!;
  const away = teams.find((t) => t.side === "away")!;
  const shape = (team: Team) => formations?.find((f) => f.teamId === team.id)?.formation;
  const holder = possessionTeamId === home.id ? home : possessionTeamId === away.id ? away : null;
  return (
    <section className="scoreline" aria-label="Score and clock">
      <div className="scoreline__main">
        <TeamName team={home} className="scoreline__team" />
        <output className="scoreline__score" aria-label={`Score: ${home.name} ${score.home}, ${away.name} ${score.away}`}>
          <span>{score.home}</span>
          <span className="scoreline__dash" aria-hidden="true">
            –
          </span>
          <span>{score.away}</span>
        </output>
        <TeamName team={away} className="scoreline__team" />
      </div>
      <p className="scoreline__meta">
        <span className="scoreline__clock">
          <span className="visually-hidden">Match clock </span>
          <time>{shortClock(timeMs)}</time>
        </span>
        <span className={`scoreline__status scoreline__status--${status}`}>{STATUS_TEXT[status]}</span>
        {formations && (
          <span className="scoreline__shapes">
            Shape <b>{shape(home)}</b> v <b>{shape(away)}</b>
          </span>
        )}
        <span className="visually-hidden">{holder ? `${holder.name} have the ball` : "Nobody has the ball"}</span>
      </p>
    </section>
  );
}

/**
 * Tactics numbers so far, shown with the Tactics feed: one row per figure,
 * a column per team (home first), headed by each team's marker and short name.
 */
export function TacticsNumbers({
  teams,
  stats,
  extra,
}: {
  teams: [Team, Team];
  stats: MatchStatistics;
  extra: Record<"home" | "away", ProStatistics>;
}) {
  const home = teams.find((t) => t.side === "home")!;
  const away = teams.find((t) => t.side === "away")!;
  const percent = (v: number | null) => (v === null ? "–" : `${v}%`);
  const rows: [string, string, string][] = [
    ["Possession", percent(stats.home.possessionPercent), percent(stats.away.possessionPercent)],
    ["Passes completed", `${extra.home.passesCompleted}/${extra.home.passesAttempted}`, `${extra.away.passesCompleted}/${extra.away.passesAttempted}`],
    ["Shots (on target)", `${stats.home.shots} (${extra.home.shotsOnTarget})`, `${stats.away.shots} (${extra.away.shotsOnTarget})`],
  ];
  const head = (team: Team) => (
    <span className="tactics-numbers__team">
      <span className={`marker marker--${team.side}`} style={{ color: team.kit.primary }} />
      {team.shortName}
    </span>
  );
  return (
    <ul className="tactics-numbers" aria-label="Tactics data so far">
      <li className="tactics-numbers__head" aria-hidden="true">
        <span />
        {head(home)}
        {head(away)}
      </li>
      {rows.map(([label, hv, av]) => (
        <li key={label}>
          <span>{label}</span>
          <span>
            <span className="visually-hidden">{home.name} </span>
            <b>{hv}</b>
          </span>
          <span>
            <span className="visually-hidden">, {away.name} </span>
            <b>{av}</b>
          </span>
        </li>
      ))}
    </ul>
  );
}
