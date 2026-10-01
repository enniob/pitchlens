"use client";

import { useState } from 'react';
import { sampleFixture } from '@/match/fixture';
import { generateMatch } from '@/simulation/generate';
import { MatchViewer } from './MatchViewer';

/** Keep the scripted fixture available alongside reproducible generated sequences. */
export function SampleMatchViewer() {
  const [fixture,setFixture]=useState(sampleFixture);
  const [seed,setSeed]=useState('42');
  const [duration,setDuration]=useState('60');
  const [revision,setRevision]=useState(0);
  const [error,setError]=useState('');
  function generate() {
    try {
      if(!/^\d+$/.test(seed.trim())) throw new Error('Enter a whole-number seed from 0 to 4294967295');
      const next=generateMatch({seed:Number(seed),durationMs:Number(duration)*1000});
      setFixture(next);setRevision(r=>r+1);setError('');
    } catch(e) {setError(e instanceof Error?e.message:'Could not generate match');}
  }
  return <>
    <section className="generator" aria-label="Match generation">
      <label>Seed <input value={seed} onChange={e=>setSeed(e.target.value)} inputMode="numeric" /></label>
      <label>Duration <select value={duration} onChange={e=>setDuration(e.target.value)}>
        <option value="30">30 seconds</option><option value="60">60 seconds</option><option value="120">2 minutes</option>
      </select></label>
      <button type="button" onClick={generate}>Generate match</button>
      <button type="button" onClick={()=>{setFixture(sampleFixture);setRevision(r=>r+1);setError('');}}>Scripted demo</button>
      <p aria-live="polite">{fixture.title} · Generated play uses simplified football rules.</p>
      {error && <p role="alert">{error}</p>}
    </section>
    <MatchViewer key={revision} fixture={fixture}/>
  </>;
}
