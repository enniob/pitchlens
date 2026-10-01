/** Deterministic, simplified event simulator. No renderer, wall clock or network dependencies. */
import type { MatchEvent, MatchFixture, PlayerState, Snapshot, Vec3 } from '@/match/contract';
import { sampleFixture } from '@/match/fixture';

export interface SimulationOptions { seed: number; durationMs?: number }
export const STEP_MS = 100;
export const MAX_PLAYER_SPEED = 7;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const distance = (a: {x:number;y:number}, b: {x:number;y:number}) => Math.hypot(a.x-b.x,a.y-b.y);

/** Mulberry32: all stochastic choices use this one seeded stream. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let n = Math.imul(state ^ state >>> 15, state | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
}

type Flight = {
  kind: 'pass' | 'shot'; from: string; target?: string; intended?: string;
  startT: number; endT: number; start: Vec3; end: Vec3;
  result: 'complete' | 'intercepted' | 'scored' | 'saved' | 'missed';
};

export function generateMatch({seed, durationMs = 60_000}: SimulationOptions): MatchFixture {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Seed must be an integer from 0 to 4294967295');
  if (!Number.isInteger(durationMs) || durationMs < 10_000 || durationMs > 180_000 || durationMs % STEP_MS !== 0)
    throw new Error('Duration must be 10–180 seconds in 100 ms steps');
  const rng = random(seed);
  const teams = structuredClone(sampleFixture.teams);
  const roster = structuredClone(sampleFixture.roster);
  const teamOf = (id: string) => roster.find(p => p.id === id)!.teamId;
  const sign = (id: string) => teams.find(t => t.id === teamOf(id))!.attacksTowards === 'increasing-x' ? 1 : -1;
  const opponent = (team: string) => teams.find(t => t.id !== team)!.id;
  const keeper = (team: string) => roster.find(p => p.teamId === team && p.role === 'GK')!.id;
  const striker = (team: string) => roster.find(p => p.teamId === team && p.number === 9)!.id;
  const base = new Map<string, {x:number;y:number}>();
  const shape = [[5,34],[27,56],[25,42],[25,26],[27,12],[37,34],[41,23],[41,45],[49,58],[50,34],[49,10]];
  teams.forEach(team => roster.filter(p=>p.teamId===team.id).forEach((p,i)=> {
    const [x,y] = shape[i]!;
    base.set(p.id, {x:team.attacksTowards==='increasing-x'?x!:105-x!, y:y!});
  }));
  const players: PlayerState[] = roster.map(p=>({playerId:p.id,...base.get(p.id)!,facing:sign(p.id)>0?0:Math.PI}));
  const player = (id: string) => players.find(p=>p.playerId===id)!;
  let owner: string | null = striker(teams[seed % 2]!.id);
  let ball: Vec3 = {x:52.5,y:34,z:0.11};
  const state: { flight: Flight | null } = { flight: null };
  let deadUntil = 0;
  let restartTeam = '';
  let restartKind: 'kickoff' | 'goal-kick' = 'kickoff';
  let nextAction = 1000;
  let t = 0;
  const events: MatchEvent[] = [];
  const snapshots: Snapshot[] = [];
  const emit = (e: Omit<MatchEvent,'id'|'t'>) => events.push({...e,id:`sim-${events.length+1}`,t});
  const atFeet = (id: string): Vec3 => {
    const p = player(id);
    return {x:p.x+Math.cos(p.facing)*0.55,y:p.y+Math.sin(p.facing)*0.55,z:0.11};
  };
  const reset = (team: string, kind: 'kickoff' | 'goal-kick') => {
    // Deliberate dead-ball cut; never interpolated across by the viewer.
    for (const p of players) Object.assign(p,base.get(p.playerId),{facing:sign(p.playerId)>0?0:Math.PI});
    owner = kind==='kickoff'?striker(team):keeper(team);
    const p = player(owner);
    if (kind==='kickoff') {
      p.x = 52.5-sign(owner)*0.55; p.y=34;
      // Non-kicking opponents must stay outside the centre circle.
      for (const q of players) if (teamOf(q.playerId)!==team && distance(q,{x:52.5,y:34})<9.15) q.x=52.5-sign(q.playerId)*10;
    }
    ball=atFeet(owner); nextAction=t+1000;
  };
  reset(teamOf(owner), 'kickoff');
  const startingState = {score:{home:0,away:0},possession:{teamId:teamOf(owner!),playerId:owner}};
  const snap = (discontinuity=false) => snapshots.push({t,players:players.map(p=>({...p})),ball:{...ball},
    possession:owner?{teamId:teamOf(owner),playerId:owner}:null,...(discontinuity?{discontinuity:true}:{})});
  snap();

  const launch = (f: Omit<Flight,'startT'|'endT'|'start'>) => {
    const start = {...ball};
    const travel = Math.max(300,Math.ceil(distance(start,f.end)/(f.kind==='shot'?24:15)*1000/STEP_MS)*STEP_MS);
    state.flight={...f,start,startT:t,endT:t+travel}; owner=null;
    if (f.kind==='shot') emit({type:'shot',teamId:teamOf(f.from),playerId:f.from,outcome:'pending',start,
      description:`Shot by ${roster.find(p=>p.id===f.from)!.name}`});
  };

  for (t=STEP_MS;t<=durationMs;t+=STEP_MS) {
    let cut=false;
    if (deadUntil) {
      if (t>=deadUntil) {
        reset(restartTeam,restartKind); deadUntil=0; cut=true;
        emit({type:restartKind,teamId:restartTeam,playerId:owner!,outcome:'taken',start:{...ball},description:restartKind==='kickoff'?'Kickoff by the conceding team':'Goal kick after a missed shot'});
      }
      snap(cut); continue;
    }
    // Formation support follows the ball; the carrier progresses towards goal.
    for (const p of players) {
      const home=base.get(p.playerId)!;
      let target={x:clamp(home.x+(ball.x-52.5)*0.55+(owner && teamOf(owner)===teamOf(p.playerId)?sign(p.playerId)*14:0),2,103),y:clamp(home.y+(ball.y-34)*0.25,2,66)};
      if (p.playerId===owner) target={x:clamp(p.x+sign(p.playerId)*5,2,103),y:clamp(p.y+(34-p.y)*0.15,3,65)};
      if (state.flight?.target===p.playerId) target={x:state.flight.end.x,y:state.flight.end.y};
      // Goalkeepers hold their line except when receiving a save/pass.
      if (roster.find(r=>r.id===p.playerId)!.role==='GK' && state.flight?.target!==p.playerId)
        target={x:home.x,y:clamp(ball.y,30.5,37.5)};
      const d=distance(p,target), step=Math.min(d,MAX_PLAYER_SPEED*STEP_MS/1000);
      if (d>0.001) {p.facing=Math.atan2(target.y-p.y,target.x-p.x);p.x+=(target.x-p.x)/d*step;p.y+=(target.y-p.y)/d*step;}
    }
    if (state.flight) {
      const f: Flight=state.flight, k=clamp((t-f.startT)/(f.endT-f.startT),0,1);
      ball={x:f.start.x+(f.end.x-f.start.x)*k,y:f.start.y+(f.end.y-f.start.y)*k,z:0.11+Math.sin(Math.PI*k)*(f.kind==='shot'?0.7:0.25)};
      if (t>=f.endT) {
        ball={...f.end}; state.flight=null;
        const team=teamOf(f.from);
        if (f.kind==='pass') {
          owner=f.target!;
          emit({type:'pass',teamId:team,playerId:f.from,recipientId:f.intended,outcome:f.result==='complete'?'complete':'intercepted',startT:f.startT,start:f.start,end:{...ball},description:f.result==='complete'?'Completed pass':'Pass intercepted'});
          if(f.result==='intercepted') emit({type:'turnover',teamId:teamOf(owner),playerId:owner,outcome:'won',start:{...ball},description:'Possession won by interception'});
        } else {
          emit({type:f.result==='scored'?'goal':'shot-result',teamId:team,playerId:f.from,outcome:f.result as 'scored'|'saved'|'missed',startT:f.startT,end:{...ball},description:f.result==='scored'?'Goal!':f.result==='saved'?'Shot saved':'Shot missed'});
          if(f.result==='saved') owner=f.target!;
          else {restartTeam=opponent(team);restartKind=f.result==='scored'?'kickoff':'goal-kick';deadUntil=t+2000;}
        }
        nextAction=t+800+Math.floor(rng()*8)*100;
      }
    } else if (owner) {
      ball=atFeet(owner);
      if(t>=nextAction) {
        const from=owner, p=player(from), direction=sign(from), team=teamOf(from);
        const defenders=players.filter(q=>teamOf(q.playerId)!==team);
        const near=defenders.filter(q=>distance(q,p)<1.8);
        if(near.length && rng()<0.4) {
          owner=near[0]!.playerId;
          emit({type:'turnover',teamId:teamOf(owner),playerId:owner,outcome:'won',start:{...ball},description:'Defender wins possession'});
          nextAction=t+900;
        } else if ((direction>0?105-p.x:p.x)<27 && Math.abs(p.y-34)<24 && rng()<0.65) {
          const roll=rng(), result=roll<0.35?'scored':roll<0.72?'saved':'missed';
          const gk=keeper(opponent(team));
          const end=result==='saved'?{x:player(gk).x,y:player(gk).y,z:0.11}:
            {x:direction>0?105.2:-0.2,y:result==='scored'?32+rng()*4:(rng()<0.5?27:41),z:0.11};
          launch({kind:'shot',from,target:result==='saved'?gk:undefined,result,end});
        } else if (rng()<0.4) {
          // Carry into space before reconsidering a pass.
          nextAction=t+1200;
        } else {
          const candidates=players.filter(q=>teamOf(q.playerId)===team && q.playerId!==from && distance(q,p)>3 && distance(q,p)<35);
          candidates.sort((a,b)=>(b.x-p.x)*direction-(a.x-p.x)*direction);
          const receiver=candidates[Math.floor(rng()*Math.min(3,candidates.length))];
          if(receiver) {
            // Interceptions only by defenders close to the actual pass corridor.
            const dx=receiver.x-p.x,dy=receiver.y-p.y,len2=dx*dx+dy*dy;
            const interceptor=defenders.find(q=>{const u=((q.x-p.x)*dx+(q.y-p.y)*dy)/len2;return u>0.1&&u<0.9&&distance(q,{x:p.x+u*dx,y:p.y+u*dy})<3;});
            const target=interceptor && rng()<0.65?interceptor:receiver;
            launch({kind:'pass',from,target:target.playerId,intended:receiver.playerId,result:target===receiver?'complete':'intercepted',end:{x:target.x,y:target.y,z:0.11}});
          } else nextAction=t+600;
        }
      }
    }
    snap();
  }
  return {schemaVersion:'1.1.0',matchId:`sim-v1-${seed}-${durationMs}`,title:`Generated match · seed ${seed}`,synthetic:true,durationMs,teams,roster,startingState,snapshots,events};
}
