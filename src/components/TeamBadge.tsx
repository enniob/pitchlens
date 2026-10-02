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
