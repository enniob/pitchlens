import type { Score, Team } from "@/match/contract";
import type { ActiveFormation } from "@/playback/derive";
import type { ProStatistics } from "@/playback/proData";
import type { MatchStatistics } from "@/playback/statistics";
import { formatClock } from "./format";

interface ScoreBugProps {
  teams: [Team, Team];
  score: Score;
  timeMs: number;
  status: "ready" | "playing" | "paused" | "ended";
  /** Team in control of the ball right now, if any. */
  possessionTeamId: string | null;
  formations: ActiveFormation[] | null;
  /** Shown only with Pro data on. */
  pro: { stats: MatchStatistics; extra: Record<"home" | "away", ProStatistics> } | null;
}

const STATUS_TEXT = { ready: "Ready", playing: "Playing", paused: "Paused", ended: "Full time" } as const;

/** Minutes and seconds, as on a TV score bug. */
const shortClock = (ms: number) => formatClock(ms).replace(/\.\d$/, "");

/**
 * TV-style score bug: team names with their marker shape, score, clock, who
 * has the ball and both teams' current shapes. Team identity never relies on
 * colour alone: short name plus circle (home) or square (away).
 */
export function ScoreBug({ teams, score, timeMs, status, possessionTeamId, formations, pro }: ScoreBugProps) {
  const home = teams.find((t) => t.side === "home")!;
  const away = teams.find((t) => t.side === "away")!;
  const shape = (team: Team) => formations?.find((f) => f.teamId === team.id)?.formation;
  const holder = possessionTeamId === home.id ? home : possessionTeamId === away.id ? away : null;
  return (
    <section className="bug" aria-label="Score and clock">
      <div className="bug__main">
        <span className="bug__team bug__team--home" style={{ background: home.kit.primary, color: home.kit.number }}>
          <span className="marker marker--home" aria-hidden="true" />
          <abbr title={home.name}>{home.shortName}</abbr>
          <span className={`bug__ball${holder === home ? " bug__ball--on" : ""}`} aria-hidden="true" />
        </span>
        <output className="bug__score" aria-label={`Score: ${home.name} ${score.home}, ${away.name} ${score.away}`}>
          <span>{score.home}</span>
          <span>{score.away}</span>
        </output>
        <span className="bug__team bug__team--away" style={{ background: away.kit.primary, color: away.kit.number }}>
          <span className={`bug__ball${holder === away ? " bug__ball--on" : ""}`} aria-hidden="true" />
          <abbr title={away.name}>{away.shortName}</abbr>
          <span className="marker marker--away" aria-hidden="true" />
        </span>
        <span className="bug__clock">
          <span className="visually-hidden">Match clock </span>
          <time>{shortClock(timeMs)}</time>
        </span>
      </div>
      <div className="bug__sub">
        <span className="bug__status">
          <span className={`dot${status === "playing" ? " dot--live" : ""}`} aria-hidden="true" />
          {STATUS_TEXT[status]}
        </span>
        {formations && (
          <span>
            Shape <b>{shape(home)}</b> v <b>{shape(away)}</b>
          </span>
        )}
        <span className="visually-hidden">{holder ? `${holder.name} have the ball` : "Nobody has the ball"}</span>
      </div>
      {pro && <ProPanel home={home} away={away} {...pro} />}
    </section>
  );
}

function ProPanel({
  home,
  away,
  stats,
  extra,
}: {
  home: Team;
  away: Team;
  stats: MatchStatistics;
  extra: Record<"home" | "away", ProStatistics>;
}) {
  const h = stats.home.possessionPercent;
  const a = stats.away.possessionPercent;
  const rows: [string, string, string][] = [
    ["Passes completed", `${extra.home.passesCompleted}/${extra.home.passesAttempted}`, `${extra.away.passesCompleted}/${extra.away.passesAttempted}`],
    ["Shots (on target)", `${stats.home.shots} (${extra.home.shotsOnTarget})`, `${stats.away.shots} (${extra.away.shotsOnTarget})`],
  ];
  return (
    <table className="propanel">
      <caption className="visually-hidden">Pro data so far</caption>
      <thead className="visually-hidden">
        <tr>
          <th scope="col">{home.name}</th>
          <th scope="col">Statistic</th>
          <th scope="col">{away.name}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{h === null ? "–" : `${h}%`}</td>
          <th scope="row">
            Possession
            <span className="propanel__bar" aria-hidden="true">
              <span style={{ width: `${h ?? 50}%`, background: home.kit.primary }} />
              <span style={{ width: `${a ?? 50}%`, background: away.kit.primary }} />
            </span>
          </th>
          <td>{a === null ? "–" : `${a}%`}</td>
        </tr>
        {rows.map(([label, hv, av]) => (
          <tr key={label}>
            <td>{hv}</td>
            <th scope="row">{label}</th>
            <td>{av}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
