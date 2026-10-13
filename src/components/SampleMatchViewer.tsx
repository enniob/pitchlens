"use client";

import { useEffect, useState } from "react";
import type { MatchFixture } from "@/match/contract";
import { sampleFixture } from "@/match/fixture";
import { generateMatch } from "@/simulation/generate";
import { MatchViewer } from "./MatchViewer";
import { SetupDrawer } from "./SetupDrawer";
import { Icon } from "./Icon";
import { controlsOf, DEFAULT_DRAFT, draftFromFixture, setupErrors, tacticsFromControls, type SetupDraft } from "./setup";

export { tacticsFromControls } from "./setup";

const PRO_KEY = "pitchlens.pro";

/** Per-viewer conveniences only; storage may be unavailable (private windows, blocked site data). */
function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeFlag(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Not remembered; the app works the same.
  }
}

export function matchLabel(fixture: MatchFixture): string {
  const draft = draftFromFixture(fixture);
  if (!draft) return fixture === sampleFixture ? "Scripted demo" : fixture.title;
  return `Seed ${draft.seed} · ${draft.teams.home.formation} v ${draft.teams.away.formation} · ${draft.durationSeconds} s`;
}

/**
 * The app shell: which match is loaded, the "Set up match" drawer, the Pro
 * data preference and the startup choices. The scripted demo stays one
 * click away, and generated matches are reproducible from seed and set-up.
 */
export function SampleMatchViewer() {
  const [fixture, setFixture] = useState<MatchFixture | null>(null);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<SetupDraft>(DEFAULT_DRAFT);
  const [setupOpen, setSetupOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [pro, setPro] = useState(false);

  useEffect(() => {
    setPro(readFlag(PRO_KEY));
  }, []);

  const load = (next: MatchFixture) => {
    setError("");
    setFixture(next);
    setRevision((r) => r + 1);
  };
  const generate = () => {
    if (Object.keys(setupErrors(draft)).length > 0) return;
    setSetupOpen(false);
    setGenerating(true);
    setError("");
    // Let the "Simulating" overlay paint before the synchronous simulation runs.
    window.setTimeout(() => {
      try {
        const tactics = tacticsFromControls(controlsOf(draft), draft.durationSeconds);
        load(generateMatch({ seed: Number(draft.seed.trim()), durationMs: draft.durationSeconds * 1000, tactics }));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not generate the match");
      } finally {
        setGenerating(false);
      }
    }, 30);
  };
  return (
    <div className="shell">
      {fixture ? <MatchViewer
        key={revision}
        fixture={fixture}
        pro={pro}
        onTogglePro={() => {
          writeFlag(PRO_KEY, !pro);
          setPro(!pro);
        }}
        onOpenSetup={() => {
          setSetupOpen(true);
        }}
        autoPlay
      /> : (
        <section className="shell__welcome" aria-labelledby="welcome-title">
          <div className="card card--welcome">
            <p className="brand"><Icon name="lens" size={26} className="brand__mark" /><span>Pitch<b>Lens</b></span></p>
            <p className="kicker">Synthetic football</p>
            <h2 id="welcome-title">Watch it like a match on TV</h2>
            <p>Choose the demo or set up your own match. Big moments pop up as they happen, and the timeline lets you jump back to them.</p>
            <p className="small">The teams, players and events are made up by a simulator. No real match data is used.</p>
            <div className="card__actions">
              <button type="button" className="btn btn--primary btn--large" onClick={() => load(sampleFixture)}>
                <Icon name="play" />Kick off the demo
              </button>
              <button type="button" className="btn btn--large" onClick={() => setSetupOpen(true)}>Set up your own match</button>
            </div>
          </div>
        </section>
      )}
      {generating && (
        <div className="shell__overlay" role="status">
          <div className="card card--center">
            <span className="spinner" aria-hidden="true" />
            <h2>Simulating your match…</h2>
            <p>The same settings always produce the same match.</p>
          </div>
        </div>
      )}
      {error && (
        <p className="shell__error" role="alert">
          {error}
        </p>
      )}
      {setupOpen && (
        <SetupDrawer
          teams={(fixture ?? sampleFixture).teams}
          watchingLabel={fixture ? matchLabel(fixture) : null}
          loaded={fixture ? draftFromFixture(fixture) : null}
          draft={draft}
          onDraft={setDraft}
          onGenerate={generate}
          onScriptedDemo={() => {
            setSetupOpen(false);
            load(sampleFixture);
          }}
          onClose={() => setSetupOpen(false)}
        />
      )}
    </div>
  );
}
