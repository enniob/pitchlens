"use client";

import { useState } from 'react';
import { FORMATION_IDS, type FormationId, type TeamSide } from '@/match/contract';
import { DEFAULT_FORMATION } from '@/match/formations';
import { sampleFixture } from '@/match/fixture';
import { generateMatch, type TacticsConfig } from '@/simulation/generate';
import { MatchViewer } from './MatchViewer';

interface TeamControls { formation: FormationId; changeAt: string; changeTo: FormationId }
const SIDES: [TeamSide, string][] = [['home', 'Home'], ['away', 'Away']];
const initialControls = (): Record<TeamSide, TeamControls> => ({
  home: { formation: DEFAULT_FORMATION, changeAt: '', changeTo: '4-2-3-1' },
  away: { formation: DEFAULT_FORMATION, changeAt: '', changeTo: '4-2-3-1' },
});

/**
 * Turns the form into a tactics configuration. A change time is optional, in
 * seconds with at most one decimal, and must fall strictly inside the match.
 */
export function tacticsFromControls(controls: Record<TeamSide, TeamControls>, durationSeconds: number): TacticsConfig {
  const tactics: TacticsConfig = {};
  for (const [side, label] of SIDES) {
    const c = controls[side];
    const raw = c.changeAt.trim();
    tactics[side] = { formation: c.formation };
    if (raw === '') continue;
    if (!/^\d+(\.\d)?$/.test(raw)) throw new Error(`${label} change time must be a number of seconds, e.g. 30 or 42.5`);
    const ms = Math.round(Number(raw) * 1000);
    if (ms <= 0 || ms >= durationSeconds * 1000)
      throw new Error(`${label} change time must be between 0 and ${durationSeconds} seconds (exclusive)`);
    tactics[side].changes = [{ t: ms, formation: c.changeTo }];
  }
  return tactics;
}

/** Keep the scripted fixture available alongside reproducible generated sequences. */
export function SampleMatchViewer() {
  const [fixture,setFixture]=useState(sampleFixture);
  const [seed,setSeed]=useState('42');
  const [duration,setDuration]=useState('60');
  const [controls,setControls]=useState(initialControls);
  const [revision,setRevision]=useState(0);
  const [error,setError]=useState('');
  const update=(side:TeamSide,patch:Partial<TeamControls>)=>setControls(c=>({...c,[side]:{...c[side],...patch}}));
  function generate() {
    try {
      if(!/^\d+$/.test(seed.trim())) throw new Error('Enter a whole-number seed from 0 to 4294967295');
      const tactics=tacticsFromControls(controls,Number(duration));
      const next=generateMatch({seed:Number(seed),durationMs:Number(duration)*1000,tactics});
      setFixture(next);setRevision(r=>r+1);setError('');
    } catch(e) {setError(e instanceof Error?e.message:'Could not generate match');}
  }
  const formationOptions=FORMATION_IDS.map(f=><option key={f} value={f}>{f}</option>);
  return <>
    <section className="generator" aria-label="Match generation">
      <label>Seed <input value={seed} onChange={e=>setSeed(e.target.value)} inputMode="numeric" /></label>
      <label>Duration <select value={duration} onChange={e=>setDuration(e.target.value)}>
        <option value="30">30 seconds</option><option value="60">60 seconds</option><option value="120">2 minutes</option>
      </select></label>
      {SIDES.map(([side,label])=><fieldset key={side} className="generator__team">
        <legend>{label}</legend>
        <label>Formation <select aria-label={`${label} starting formation`} value={controls[side].formation} onChange={e=>update(side,{formation:e.target.value as FormationId})}>{formationOptions}</select></label>
        <label>Change at (s) <input aria-label={`${label} formation change time in seconds`} value={controls[side].changeAt} onChange={e=>update(side,{changeAt:e.target.value})} inputMode="decimal" placeholder="none" size={5} /></label>
        <label>to <select aria-label={`${label} formation after the change`} value={controls[side].changeTo} onChange={e=>update(side,{changeTo:e.target.value as FormationId})}>{formationOptions}</select></label>
      </fieldset>)}
      <button type="button" onClick={generate}>Generate match</button>
      <button type="button" onClick={()=>{setFixture(sampleFixture);setRevision(r=>r+1);setError('');}}>Scripted demo</button>
      <p aria-live="polite">{fixture.title} · Generated play uses simplified football rules.</p>
      {error && <p role="alert">{error}</p>}
    </section>
    <MatchViewer key={revision} fixture={fixture}/>
  </>;
}
