import type { MatchFixture } from "@/match/contract";
import { focusStatisticsAt, normalizeFocus, type MatchFocus as Focus } from "@/playback/focus";
import { formatClock } from "./format";
import styles from "./MatchFocus.module.css";

export function MatchFocus({ fixture, timeMs, focus, onFocus }: {
  fixture: MatchFixture; timeMs: number; focus: Focus; onFocus: (focus: Focus) => void;
}) {
  const valid = normalizeFocus(fixture, focus);
  const players = fixture.roster.filter((p) => !valid.teamId || p.teamId === valid.teamId);
  const stats = focusStatisticsAt(fixture, timeMs, valid);
  const active = Boolean(valid.teamId || valid.playerId);
  return <section className={styles.focus} aria-label="Favorite team and player">
    <div className={styles.controls}>
      <label>Favorite team<select value={valid.teamId ?? ""} onChange={(e) => onFocus(normalizeFocus(fixture, { teamId: e.target.value || null, playerId: valid.playerId }))}>
        <option value="">Both teams</option>
        {fixture.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select></label>
      <label>Favorite player<select value={valid.playerId ?? ""} onChange={(e) => onFocus({ ...valid, playerId: e.target.value || null })}>
        <option value="">All players</option>
        {players.map((p) => <option key={p.id} value={p.id}>#{p.number} {p.name}</option>)}
      </select></label>
    </div>
    <p>Filters insights, patterns and recap highlights. Explanations keep the same match evidence for both audiences.</p>
    {active && <>
      <p className={styles.stats} aria-live="polite">Up to {formatClock(timeMs)}: {stats.shots} shots · {stats.goals} goals · {stats.passesCompleted} completed passes{valid.playerId ? ` · ${stats.receptions} completed receptions` : ""}</p>
      <button type="button" className="link" onClick={() => onFocus({ teamId: null, playerId: null })}>Show whole match</button>
    </>}
  </section>;
}
