import type { MatchEvent, MatchFixture, Score } from "@/match/contract";
import type { BannerKind } from "@/playback/moments";
import { eventCopy, plainDescription } from "./eventCopy";
import { Icon } from "./Icon";

interface MomentBannerProps {
  fixture: MatchFixture;
  event: MatchEvent;
  kind: BannerKind;
  score: Score;
}

/** Broadcast pop-up for a goal, a tactical change or a stoppage. Keyed by event, so each one animates in once. */
export function MomentBanner({ fixture, event, kind, score }: MomentBannerProps) {
  const team = fixture.teams.find((t) => t.id === event.teamId);
  const copy = eventCopy(event);
  let label: string = copy.title.replace(/!$/, "").toUpperCase();
  let title = plainDescription(event);
  let sub = copy.explain;
  if (kind === "goal") {
    label = "GOAL";
    const home = fixture.teams.find((t) => t.side === "home")!;
    const away = fixture.teams.find((t) => t.side === "away")!;
    sub = `${home.shortName} ${score.home} – ${score.away} ${away.shortName}`;
  } else if (kind === "tactic") {
    label = "TACTICAL CHANGE";
    const change = fixture.tactics?.applied.find((c) => c.eventId === event.id);
    if (change && team) title = `${team.name} · ${change.from} → ${change.to}`;
    sub = "Same players, new positions";
  }
  return (
    <div className="banner-wrap">
      <div className={`banner banner--${kind}`} role="status">
        <div className="banner__kind">
          <Icon name={copy.icon} size={28} />
          {label}
        </div>
        <div className="banner__body">
          <span className="banner__title">{title}</span>
          <span className="banner__sub">{sub}</span>
        </div>
      </div>
    </div>
  );
}
