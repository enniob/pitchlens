import type { Team } from "@/match/contract";
import type { MatchStatistics } from "@/playback/statistics";

export function MatchStats({ teams, stats }: { teams: [Team, Team]; stats: MatchStatistics }) {
  const home = teams.find((team) => team.side === "home")!;
  const away = teams.find((team) => team.side === "away")!;
  const rows = [
    ["Possession", stats.home.possessionPercent === null ? "—" : `${stats.home.possessionPercent}%`, stats.away.possessionPercent === null ? "—" : `${stats.away.possessionPercent}%`],
    ["Completed passes", stats.home.completedPasses, stats.away.completedPasses],
    ["Shots", stats.home.shots, stats.away.shots],
    ["Saves", stats.home.saves, stats.away.saves],
    ["Goals", stats.home.goals, stats.away.goals],
    ["Corners", stats.home.corners, stats.away.corners],
    ["Fouls", stats.home.fouls, stats.away.fouls],
    ["Offsides", stats.home.offsides, stats.away.offsides],
  ] as const;
  return (
    <section className="match-stats" aria-label="Match statistics">
      <table>
        <caption>Match statistics</caption>
        <thead><tr><th scope="col">Statistic</th><th scope="col"><abbr title={home.name}>{home.shortName}</abbr></th><th scope="col"><abbr title={away.name}>{away.shortName}</abbr></th></tr></thead>
        <tbody>{rows.map(([label, h, a]) => <tr key={label}><th scope="row">{label}</th><td>{h}</td><td>{a}</td></tr>)}</tbody>
      </table>
      <p>Totals so far in this sequence. Possession excludes ball flight and dead-ball time.</p>
    </section>
  );
}
