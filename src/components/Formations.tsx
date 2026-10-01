import type { Player, TacticalPosition, Team } from "@/match/contract";
import { FORMATIONS } from "@/match/formations";
import type { ActiveFormation } from "@/playback/derive";
import { formatClock } from "./format";

const LINES: [string, readonly TacticalPosition[]][] = [
  ["Attack", ["RW", "ST", "LW"]],
  ["Midfield", ["RM", "AM", "CM", "DM", "LM"]],
  ["Defence", ["RB", "CB", "LB"]],
];

interface FormationsProps {
  teams: [Team, Team];
  roster: Player[];
  /** Active formations at the playback time; null when the fixture has no formation data. */
  formations: ActiveFormation[] | null;
}

/** Each team's formation at the current playback time, with who fills which position. */
export function Formations({ teams, roster, formations }: FormationsProps) {
  if (!formations) return null;
  const byId = new Map(roster.map((p) => [p.id, p]));
  return (
    <section className="formations" aria-label="Formations">
      <h2 className="formations__heading">Formations</h2>
      {[...teams]
        .sort((a, b) => (a.side === "home" ? -1 : b.side === "home" ? 1 : 0))
        .map((team) => {
          const active = formations.find((f) => f.teamId === team.id);
          if (!active) return null;
          const playerIn = new Map(Object.entries(active.assignments).map(([playerId, slotId]) => [slotId, byId.get(playerId)]));
          const slots = FORMATIONS[active.formation].slots;
          return (
            <div key={team.id} className="formation" data-team={team.side}>
              <div className="formation__title">
                <span className="kit-dot" style={{ background: team.kit.primary }} aria-hidden="true" />
                <abbr title={team.name}>{team.shortName}</abbr>
                <strong className="formation__shape" data-testid={`formation-${team.side}`}>
                  {active.formation}
                </strong>
                <span className="formation__since">{active.since > 0 ? `since ${formatClock(active.since)}` : "starting"}</span>
              </div>
              <ul className="formation__lines">
                {LINES.map(([line, positions]) => {
                  const inLine = slots.filter((s) => positions.includes(s.position));
                  return (
                    <li key={line}>
                      <span className="formation__line">{line}</span>
                      {inLine.map((s) => (
                        <span key={s.id} className="formation__slot" title={playerIn.get(s.id)?.name}>
                          {s.id} #{playerIn.get(s.id)?.number ?? "?"}
                        </span>
                      ))}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      <p>Formation shapes are a simplified synthetic model.</p>
    </section>
  );
}
