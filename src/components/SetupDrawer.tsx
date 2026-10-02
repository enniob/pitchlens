"use client";

import { useEffect, useRef, useState } from "react";
import { FORMATION_IDS, type FormationId, type Team, type TeamSide } from "@/match/contract";
import { FORMATIONS } from "@/match/formations";
import { Icon } from "./Icon";
import { TeamBadge } from "./TeamBadge";
import { DURATIONS_SECONDS, sameSetup, setupErrors, type SetupDraft } from "./setup";

interface SetupDrawerProps {
  teams: [Team, Team];
  /** What is playing now, e.g. "Scripted demo". */
  watchingLabel: string;
  /** The set-up of the loaded match, or null when it was not generated (scripted demo). */
  loaded: SetupDraft | null;
  draft: SetupDraft;
  onDraft: (draft: SetupDraft) => void;
  onGenerate: () => void;
  onScriptedDemo: () => void;
  onClose: () => void;
}

/**
 * "Set up match" drawer. Changes here never touch the match being watched;
 * they apply only when a new match is generated, and the footer says so while
 * the draft differs from the loaded match. Errors are shown per field in plain
 * words, with a summary once Generate has been tried.
 */
export function SetupDrawer({ teams, watchingLabel, loaded, draft, onDraft, onGenerate, onScriptedDemo, onClose }: SetupDrawerProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [tried, setTried] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const errors = setupErrors(draft);
  const errorCount = Object.keys(errors).length;
  const dirty = !loaded || !sameSetup(draft, loaded);

  // Focus moves into the dialog and returns to whatever opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    titleRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  const update = (fn: (d: SetupDraft) => void) => {
    const next = structuredClone(draft);
    fn(next);
    onDraft(next);
  };
  const generate = () => {
    if (errorCount > 0) {
      setTried(true);
      if (errors.seed) setAdvanced(true);
      // Take the user to the first field that needs fixing (after the seed field has rendered, if it was hidden).
      const firstId = errors.home ? "setup-at-home" : errors.away ? "setup-at-away" : "setup-seed";
      window.requestAnimationFrame(() => {
        const field = document.getElementById(firstId);
        field?.focus();
        field?.scrollIntoView({ block: "center" });
      });
      return;
    }
    onGenerate();
  };
  // Keep Tab inside the dialog.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return onClose();
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input, select, [tabindex='0']");
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="drawer-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={dialogRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby="setup-title" onKeyDown={trapTab}>
        <div className="drawer__head">
          <h2 id="setup-title" ref={titleRef} tabIndex={-1}>
            Set up match
          </h2>
          <button type="button" className="btn btn--ghost btn--icon" aria-label="Close set-up" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer__body">
          <p className="now">
            <b>Now watching: {watchingLabel}</b>
            <span>Nothing here changes it. Your choices are used only when you press Generate match.</span>
          </p>
          {tried && errorCount > 0 && (
            <p className="alert" role="alert">
              <Icon name="warning" />
              Fix {errorCount} {errorCount === 1 ? "problem" : "problems"} to generate the match:{" "}
              {[
                errors.home && `${teams.find((t) => t.side === "home")!.name} change time`,
                errors.away && `${teams.find((t) => t.side === "away")!.name} change time`,
                errors.seed && "match seed (under Advanced options)",
              ]
                .filter(Boolean)
                .join(", ")}
              .
            </p>
          )}

          <fieldset className="fieldset">
            <legend>Match length</legend>
            <div className="seg" role="group" aria-label="Match length">
              {DURATIONS_SECONDS.map((s) => (
                <button key={s} type="button" aria-pressed={draft.durationSeconds === s} onClick={() => update((d) => (d.durationSeconds = s))}>
                  {s < 120 ? `${s} s` : `${s / 60} min`}
                </button>
              ))}
            </div>
            <span className="help">Matches are short, highlight-length sequences.</span>
          </fieldset>

          {(["home", "away"] as const).map((side) => (
            <TeamFieldset key={side} side={side} team={teams.find((t) => t.side === side)!} draft={draft} error={errors[side]} showError={tried} update={update} />
          ))}

          <div>
            <button type="button" className="disclosure" aria-expanded={advanced} aria-controls="setup-advanced" onClick={() => setAdvanced(!advanced)}>
              Advanced options
              <Icon name="chevron" className={advanced ? "icon--flip" : undefined} />
            </button>
            {advanced && (
              <div id="setup-advanced" className="fieldset">
                <div className={`field${errors.seed ? " field--error" : ""}`}>
                  <label htmlFor="setup-seed">Match seed</label>
                  <input
                    id="setup-seed"
                    inputMode="numeric"
                    value={draft.seed}
                    aria-invalid={!!errors.seed}
                    aria-describedby="setup-seed-help"
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      update((d) => (d.seed = v));
                    }}
                  />
                </div>
                {errors.seed && <span className="field-error">{errors.seed}</span>}
                <span className="help" id="setup-seed-help">
                  The seed decides every random choice in the simulation. The same seed with the same settings gives the same match every time.
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="drawer__foot">
          {dirty && <span className="pending">● Not applied yet. Generate a new match to see these settings.</span>}
          <div className="drawer__actions">
            <button type="button" className="btn btn--primary btn--large" onClick={generate}>
              Generate match
            </button>
            <button type="button" className="btn btn--large" onClick={onScriptedDemo}>
              Scripted demo
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function TeamFieldset({
  side,
  team,
  draft,
  error,
  showError,
  update,
}: {
  side: TeamSide;
  team: Team;
  draft: SetupDraft;
  error: string | undefined;
  showError: boolean;
  update: (fn: (d: SetupDraft) => void) => void;
}) {
  const controls = draft.teams[side];
  const on = draft.changeOn[side];
  // Errors show once Generate was tried, or as soon as a typed time is invalid.
  const visibleError = error && (showError || controls.changeAt.trim() !== "") ? error : null;
  return (
    <fieldset className="fieldset">
      <legend>
        <TeamBadge team={team} /> {team.name} <span className="help">({side})</span>
      </legend>
      <div className="formation-picker" role="group" aria-label={`${team.name} starting formation`}>
        {FORMATION_IDS.map((id) => (
          <button key={id} type="button" className="formation-option" aria-pressed={controls.formation === id} onClick={() => update((d) => (d.teams[side].formation = id))}>
            <FormationDiagram id={id} />
            {id}
          </button>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={on} onChange={() => update((d) => (d.changeOn[side] = !d.changeOn[side]))} />
        Change formation during the match
      </label>
      {on && (
        <>
          <div className="field-row">
            <div className={`field${visibleError ? " field--error" : ""}`}>
              <label htmlFor={`setup-at-${side}`}>At (seconds)</label>
              <input
                id={`setup-at-${side}`}
                inputMode="decimal"
                placeholder="e.g. 30"
                value={controls.changeAt}
                aria-invalid={!!visibleError}
                aria-describedby={visibleError ? `setup-at-${side}-error` : undefined}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  update((d) => (d.teams[side].changeAt = v));
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={`setup-to-${side}`}>Switch to</label>
              <select
                id={`setup-to-${side}`}
                value={controls.changeTo}
                onChange={(e) => {
                  const v = e.currentTarget.value as FormationId;
                  update((d) => (d.teams[side].changeTo = v));
                }}
              >
                {FORMATION_IDS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {visibleError && (
            <span className="field-error" id={`setup-at-${side}-error`}>
              <Icon name="warning" size={16} />
              {visibleError}
            </span>
          )}
          <span className="help">Same players, new positions. Players jog to their new spots; play doesn&apos;t stop.</span>
        </>
      )}
    </fieldset>
  );
}

/** Small dot diagram of a formation, attacking up. */
function FormationDiagram({ id }: { id: FormationId }) {
  return (
    <span className="formation-option__pitch" aria-hidden="true">
      {FORMATIONS[id].slots.map((s) => (
        <i key={s.id} style={{ left: `${((34 - s.lateral) / 68) * 100}%`, top: `${92 - (s.depth / 55) * 80}%` }} />
      ))}
    </span>
  );
}
