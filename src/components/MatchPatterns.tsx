import { useMemo } from "react";
import type { MatchFixture } from "@/match/contract";
import { eventsAt } from "@/playback/derive";
import { measureEvents } from "@/playback/patterns";
import { formatClock } from "./format";
import styles from "./MatchPatterns.module.css";

export function MatchPatterns({ fixture, timeMs, onReplay, favoriteTeamId, favoritePlayerId }: {
  fixture: MatchFixture;
  timeMs: number;
  onReplay: (timeMs: number) => void;
  favoriteTeamId?: string | null;
  favoritePlayerId?: string | null;
}) {
  const measurements = useMemo(() => measureEvents(eventsAt(fixture, timeMs), fixture.teams, timeMs), [fixture, timeMs]);
  const patterns = measurements.patterns.filter((p) => {
    if (favoriteTeamId && p.teamId !== favoriteTeamId) return false;
    return !favoritePlayerId || p.eventIds.some((id) => {
      const e = fixture.events.find((event) => event.id === id);
      return e?.playerId === favoritePlayerId || (e?.type === "pass" && e.outcome === "complete" && e.recipientId === favoritePlayerId);
    });
  });
  return <section className={styles.panel} aria-label="Measured match patterns">
    <div className={styles.heading}><h3>Patterns so far</h3><span>Recorded events · synthetic</span></div>
    <p className={styles.note}>Last 30 seconds. Counts describe actions, not pressure or player intent.</p>
    {patterns.length === 0 ? <p className={styles.empty}>No qualifying pattern in the available events{favoriteTeamId || favoritePlayerId ? " for this focus" : ""}.</p> :
      <ul className={styles.list}>{patterns.map((p) => <li key={p.id}>
        <strong>{fixture.teams.find((t) => t.id === p.teamId)?.shortName} · {p.kind === "turnover-to-shot" ? "Turnover to shot" : p.kind === "repeated-flank" ? "Repeated flank actions" : "Activity comparison"}</strong>
        <p>{p.summary}</p>
        <div className={styles.evidence}>
          <span>{formatClock(p.fromMs)}–{formatClock(p.toMs)} · {p.eventIds.length} supporting events</span>
          <button type="button" onClick={() => onReplay(p.fromMs)} aria-label={`Replay ${p.kind} evidence from ${formatClock(p.fromMs)}`}>Replay evidence</button>
        </div>
        <details><summary>Supporting events</summary><ol>{p.eventIds.map((id) => {
          const e = fixture.events.find((event) => event.id === id)!;
          return <li key={id}><button type="button" onClick={() => onReplay(e.t)}>{formatClock(e.t)} · {e.type.replaceAll("-", " ")}</button></li>;
        })}</ol></details>
      </li>)}</ul>}
  </section>;
}
