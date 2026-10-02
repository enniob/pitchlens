import type { AppliedFormationChange, Player, TacticalPosition, Team } from "@/match/contract";
import { FORMATIONS } from "@/match/formations";
import type { ActiveFormation } from "@/playback/derive";
import { formatClock } from "./format";
import { TeamBadge } from "./TeamBadge";

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
  /** For the list of changes so far; omitted, the list is not shown. */
  applied?: readonly AppliedFormationChange[];
  timeMs?: number;
}

const short = (ms: number) => formatClock(ms).replace(/\.\d$/, "");

/**
 * Each team's formation at the current playback time: a mini pitch with shirt
 * numbers (attacking upwards), who plays where, and the changes so far.
 * Planned changes are never listed before they happen.
 */
export function Formations({ teams, roster, formations, applied, timeMs }: FormationsProps) {
  if (!formations) return null;
  const byId = new Map(roster.map((p) => [p.id, p]));
  const sorted = [...teams].sort((a, b) => (a.side === "home" ? -1 : b.side === "home" ? 1 : 0));
  const history = applied && timeMs !== undefined ? applied.filter((c) => c.t <= timeMs) : null;
  return (
    <section className="formations" aria-label="Formations">
      {sorted.map((team) => {
        const active = formations.find((f) => f.teamId === team.id);
        if (!active) return null;
        const playerIn = new Map(Object.entries(active.assignments).map(([playerId, slotId]) => [slotId, byId.get(playerId)]));
        const slots = FORMATIONS[active.formation].slots;
        return (
          <div key={team.id} className="formation" data-team={team.side}>
            <div className="formation__title">
              <TeamBadge team={team} />
              <strong className="formation__shape" data-testid={`formation-${team.side}`}>
                {active.formation}
              </strong>
              <span className="formation__since">{active.since > 0 ? `Since ${short(active.since)}` : "Starting shape"}</span>
            </div>
            <div className="formation__body">
              <div className="mini" role="img" aria-label={`${team.name} in ${active.formation}, attacking up the page`}>
                <span className="mini__half" aria-hidden="true" />
                {slots.map((s) => (
                  <span
                    key={s.id}
                    className={`mini__player mini__player--${team.side}`}
                    style={{
                      left: `${((34 - s.lateral) / 68) * 100}%`,
                      top: `${100 - (s.depth / 52) * 94}%`,
                      background: team.kit.primary,
                      color: team.kit.number,
                    }}
                    aria-hidden="true"
                  >
                    {playerIn.get(s.id)?.number ?? ""}
                  </span>
                ))}
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
          </div>
        );
      })}
      {history && (
        <p className="hint">
          Changes so far:{" "}
          {history.length === 0
            ? "none yet"
            : history
                .map((c) => `${short(c.t)} ${teams.find((t) => t.id === c.teamId)?.shortName} ${c.from} → ${c.to}`)
                .join("; ")}
          . Planned changes stay hidden until they happen.
        </p>
      )}
    </section>
  );
}
