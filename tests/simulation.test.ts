import {describe,it,expect} from 'vitest';
import {generateMatch,MAX_PLAYER_SPEED} from '@/simulation/generate';
import {validateFixture} from '@/match/validate';
import {PlaybackEngine} from '@/playback/engine';
import {sampleFixture} from '@/match/fixture';

describe('seeded simulator',()=>{
 it('is repeatable and varies by seed',()=>{
  expect(generateMatch({seed:42})).toEqual(generateMatch({seed:42}));
  expect(generateMatch({seed:43}).events).not.toEqual(generateMatch({seed:42}).events);
 });
 it.each([0,1,2,3,7,42,100,999,4294967295])('produces coherent data for seed %s',seed=>{
  const f=generateMatch({seed,durationMs:120000});
  expect(validateFixture(f)).toEqual([]);
  expect(f.events.some(e=>e.type==='pass')).toBe(true);
  for(let i=1;i<f.snapshots.length;i++) {
   const a=f.snapshots[i-1]!,b=f.snapshots[i]!;
   expect(b.t).toBeGreaterThan(a.t);
   if(b.discontinuity) continue;
   for(const p of b.players) {
    const prev=a.players.find(q=>q.playerId===p.playerId)!;
    expect(Math.hypot(p.x-prev.x,p.y-prev.y)/(b.t-a.t)*1000).toBeLessThanOrEqual(MAX_PLAYER_SPEED+1e-8);
   }
   if(b.possession?.playerId) {
    const p=b.players.find(q=>q.playerId===b.possession!.playerId)!;
    expect(Math.hypot(p.x-b.ball.x,p.y-b.ball.y)).toBeLessThan(2.5);
   }
  }
  for(const e of f.events) {
   const s=f.snapshots.find(s=>s.t===e.t)!;
   if(e.type==='pass'&&e.outcome==='complete') expect(s.possession?.playerId).toBe(e.recipientId);
   if(e.type==='goal') {
    expect(s.possession).toBeNull();
    const kickoff=f.events.find(k=>k.t>e.t&&k.type==='kickoff');
    if(kickoff) expect(kickoff.teamId).not.toBe(e.teamId);
   }
  }
  const engine=new PlaybackEngine(f);engine.play();engine.advance(f.durationMs);
  const home=f.teams.find(t=>t.side==='home')!.id;
  expect(engine.frame().score).toEqual({home:f.events.filter(e=>e.type==='goal'&&e.teamId===home).length,away:f.events.filter(e=>e.type==='goal'&&e.teamId!==home).length});
  engine.restart();expect(engine.frame().score).toEqual(f.startingState.score);
 });
 it('covers goals, saves, misses and interceptions across seeds',()=>{
  const outcomes=new Set<string>();
  for(let seed=0;seed<20;seed++) for(const e of generateMatch({seed,durationMs:120000}).events) outcomes.add(e.outcome);
  for(const outcome of ['scored','saved','missed','intercepted']) expect(outcomes.has(outcome),outcome).toBe(true);
 });
 it('does not mutate the original demo',()=>{
  const before=JSON.stringify(sampleFixture);generateMatch({seed:42});expect(JSON.stringify(sampleFixture)).toBe(before);
 });
 it('rejects invalid configuration',()=>{
  for(const seed of [-1,NaN,Infinity,1.5,4294967296]) expect(()=>generateMatch({seed})).toThrow();
  for(const durationMs of [0,9999,10001,180100,Infinity]) expect(()=>generateMatch({seed:1,durationMs})).toThrow();
 });
});
