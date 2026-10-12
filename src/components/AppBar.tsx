import { Icon } from "./Icon";

export type AppView = "match" | "recap";

interface Props {
  view: AppView;
  /** The recap describes the whole match, so it only opens once play has reached full time. */
  recapReady: boolean;
  onView: (view: AppView) => void;
  synthOpen: boolean;
  onToggleSynth: () => void;
  onNewMatch?: () => void;
}

export function AppBar({ view, recapReady, onView, synthOpen, onToggleSynth, onNewMatch }: Props) {
  return (
    <header className="appbar">
      <span className="brand">
        <Icon name="lens" size={26} className="brand__mark" />
        <span className="brand__name">
          Pitch<b>Lens</b>
        </span>
      </span>
      <nav className="appbar__tabs" aria-label="Views">
        <button type="button" aria-current={view === "match" ? "page" : undefined} onClick={() => onView("match")}>
          Match
        </button>
        <button
          type="button"
          aria-current={view === "recap" ? "page" : undefined}
          disabled={!recapReady}
          title={recapReady ? undefined : "The recap opens at full time"}
          onClick={() => onView("recap")}
        >
          Recap
          {!recapReady && <span className="visually-hidden"> (opens at full time)</span>}
        </button>
      </nav>
      <div className="appbar__actions">
        <button type="button" className="appbar__synth" aria-expanded={synthOpen} aria-controls="synth-note" onClick={onToggleSynth}>
          <Icon name="flask" size={18} />
          <span>
            Synthetic<span className="appbar__synth-long"> match</span>
          </span>
          <span className="dot dot--accent" aria-hidden="true" />
        </button>
        {onNewMatch && (
          <button type="button" className="btn btn--accent appbar__new" aria-label="New match" onClick={onNewMatch}>
            <Icon name="plus" />
            <span className="btn__label">New match</span>
          </button>
        )}
      </div>
    </header>
  );
}
