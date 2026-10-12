import type { Team } from "@/match/contract";

/** Short name on the kit colour plus a shape (home circle, away square), so identity never relies on colour alone. */
export function TeamBadge({ team }: { team: Team }) {
  return (
    <span className={`badge badge--${team.side}`} style={{ background: team.kit.primary, color: team.kit.number }}>
      {team.side === "home" && <span className="marker marker--home" aria-hidden="true" />}
      <abbr title={team.name}>{team.shortName}</abbr>
      {team.side === "away" && <span className="marker marker--away" aria-hidden="true" />}
    </span>
  );
}

/**
 * The full team name after a kit-colour marker in the team's shape (home
 * circle, away square), as in the scoreline. `className` names the block, and
 * `${className}--home|away` is added.
 */
export function TeamName({ team, className = "teamname" }: { team: Team; className?: string }) {
  return (
    <span className={`${className} ${className}--${team.side}`}>
      <span className={`marker marker--${team.side}`} style={{ color: team.kit.primary }} aria-hidden="true" />
      {team.name}
    </span>
  );
}
