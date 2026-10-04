import type { Team } from "@/match/contract";
import type { ProStatistics } from "@/playback/proData";
import type { MatchStatistics } from "@/playback/statistics";

interface MatchStatsProps {
  teams: [Team, Team];
  stats: MatchStatistics;
  /** Extra rows shown with Pro data on. */
  pro?: Record<"home" | "away", ProStatistics> | null;
}

export function MatchStats({ teams, stats, pro }: MatchStatsProps) {
  const home = teams.find((team) => team.side === "home")!;
  const away = teams.find((team) => team.side === "away")!;
  const percent = (v: number | null) => (v === null ? "—" : `${v}%`);
  const rows: (readonly [string, string | number, string | number])[] = [
    ["Possession", percent(stats.home.possessionPercent), percent(stats.away.possessionPercent)],
    ["Shots", stats.home.shots, stats.away.shots],
    ["Goals", stats.home.goals, stats.away.goals],
    ["Saves", stats.home.saves, stats.away.saves],
    ["Completed passes", stats.home.completedPasses, stats.away.completedPasses],
    ["Corners", stats.home.corners, stats.away.corners],
    ["Fouls", stats.home.fouls, stats.away.fouls],
    ["Offsides", stats.home.offsides, stats.away.offsides],
  ];
  const metres = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} m`);
  const proRows: (readonly [string, string | number, string | number])[] = pro
    ? [
        ["Pass completion", percent(pro.home.passCompletion), percent(pro.away.passCompletion)],
        ["Average completed pass", metres(pro.home.averagePassLength), metres(pro.away.averagePassLength)],
        ["Shots on target", pro.home.shotsOnTarget, pro.away.shotsOnTarget],
        ["Balls won", pro.home.ballsWon, pro.away.ballsWon],
      ]
    : [];
  const h = stats.home.possessionPercent;
  return (
    <section className="match-stats" aria-label="Match statistics">
      <table>
        <caption>Match statistics</caption>
        <thead>
          <tr>
            <th scope="col">Statistic</th>
            <th scope="col">
              <abbr title={home.name}>{home.shortName}</abbr>
            </th>
            <th scope="col">
              <abbr title={away.name}>{away.shortName}</abbr>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, hv, av]) => (
            <tr key={label}>
              <th scope="row">
                {label}
                {label === "Possession" && h !== null && (
                  <span className="split" aria-hidden="true">
                    <span style={{ width: `${h}%`, background: home.kit.primary }} />
                    <span style={{ width: `${100 - h}%`, background: away.kit.primary }} />
                  </span>
                )}
              </th>
              <td>{hv}</td>
              <td>{av}</td>
            </tr>
          ))}
          {proRows.length > 0 && (
            <tr className="match-stats__group">
              <th scope="rowgroup" colSpan={3}>
                <span className="protag">PRO</span> Extra numbers
              </th>
            </tr>
          )}
          {proRows.map(([label, hv, av]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{hv}</td>
              <td>{av}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Totals so far in this match. Possession excludes ball flight and dead-ball time.</p>
      {!pro && <p>Turn on Pro data for pass completion, pass length, shots on target and balls won.</p>}
      <details className="glossary">
        <summary>What do these mean?</summary>
        <dl>
          <dt>Possession</dt>
          <dd>Share of the time each team had the ball under control.</dd>
          <dt>Saves</dt>
          <dd>Shots the goalkeeper stopped, credited to the goalkeeper&apos;s team.</dd>
          <dt>Corners</dt>
          <dd>Restarts from the corner after a defender sent the ball over their own goal line.</dd>
          <dt>Offsides</dt>
          <dd>Times a player was caught too far forward when a teammate passed to them.</dd>
        </dl>
      </details>
    </section>
  );
}
