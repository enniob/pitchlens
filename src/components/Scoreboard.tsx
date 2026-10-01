import type { Score, Team } from "@/match/contract";
import { formatClock } from "./format";

interface ScoreboardProps {
  teams: [Team, Team];
  score: Score;
  timeMs: number;
  durationMs: number;
}

export function Scoreboard({ teams, score, timeMs, durationMs }: ScoreboardProps) {
  const home = teams.find((t) => t.side === "home")!;
  const away = teams.find((t) => t.side === "away")!;
  return (
    <section className="scoreboard" aria-label="Score and clock">
      <div className="scoreboard__teams">
        <span className="team team--home">
          <span className="kit-dot" style={{ background: home.kit.primary }} aria-hidden="true" />
          <span className="team__name">{home.name}</span>
          <abbr className="team__short" title={home.name}>
            {home.shortName}
          </abbr>
        </span>
        <output className="scoreboard__score" aria-live="polite" aria-label={`Score: ${home.name} ${score.home}, ${away.name} ${score.away}`}>
          {score.home} – {score.away}
        </output>
        <span className="team team--away">
          <abbr className="team__short" title={away.name}>
            {away.shortName}
          </abbr>
          <span className="team__name">{away.name}</span>
          <span className="kit-dot" style={{ background: away.kit.primary }} aria-hidden="true" />
        </span>
      </div>
      <div className="scoreboard__clock">
        <span className="visually-hidden">Simulation time </span>
        <time>{formatClock(timeMs)}</time>
        <span className="scoreboard__duration"> / {formatClock(durationMs)}</span>
      </div>
    </section>
  );
}
