import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {runEngineTask,createEnginePool,enginePoolStats,closeEnginePool} from '../server/pvp/engine-pool.mjs';
import {executeEngineTask} from '../server/pvp/engine-worker.mjs';
import * as bowling from '../arena/bowling/engine.mjs';

const normal={type:'roll',offset:0,angle:0,power:.78,spin:0};
const make=(n=2)=>bowling.createState('12'.repeat(32),1000,{players:Array.from({length:n},(_,i)=>({key:'p'+i,seatIndex:i,isBot:i>0}))});
const worker=createEnginePool({size:1});
after(async()=>{await worker.close();await closeEnginePool();});
const submitted=()=>enginePoolStats().submitted||0;
let fixture;
function accepted(){
  if(!fixture){fixture=make();bowling.act(fixture,'p1',normal,2000);}
  return structuredClone(fixture);
}
function busyState(n=2){
  const base=accepted(),s=make(n);
  s.serverNow=base.serverNow;s.version=base.version;
  for(let i=1;i<n;i++)s.players[i]={...structuredClone(base.players[1]),key:'p'+i,seatIndex:i};
  return s;
}
function jobFor(state,now=state.players[1].busyUntil-1,{due=true,bots,forfeits=[]}={}){
  return{gameId:'bowling',ruleVersion:bowling.RULE_VERSION,kind:'advance',state,now,forfeits,bots:bots||state.players.filter(p=>p.isBot).map(p=>({key:p.key,lastBotAt:due?2000:now-100}))};
}
async function compare(job,expectWorker){
  const original=structuredClone(job),before=submitted();
  const expected=executeEngineTask(structuredClone(job));
  const dispatched=await runEngineTask(job);
  assert.equal(submitted()-before,expectWorker?1:0,'actual singleton worker dispatch count');
  assert.deepEqual(dispatched,expected,'shortcut must preserve both ticks, BOT order, updates and score');
  assert.deepEqual(dispatched,await worker.run(job),'real worker result must be identical');
  assert.deepEqual(job,original,'neither the local path nor worker path may mutate the admitted input');
  return dispatched;
}
for(const n of [2,3,4])for(const offset of [-1,0,1])for(const due of [false,true]){
  test(`Bowling ${n} players busyUntil ${offset} ms / BOT ${due?'due':'cooldown'}`,async()=>{
    const state=busyState(n),end=state.players[1].busyUntil;
    const result=await compare(jobFor(state,end+offset,{due}),due&&offset>=0);
    if(offset<0){assert.deepEqual(result.state.players[1].pending,state.players[1].pending);assert.deepEqual(result.state.players[1].trajectory,state.players[1].trajectory);assert.deepEqual(result.botUpdates,[]);}
    if(offset>=0)assert.equal(result.state.players[1].frames[0].length,1,'accepted score reveals once');
  });
}
for(const n of [3,4])test(`Bowling ${n} players: one ready BOT keeps the whole advance off-thread`,async()=>{
  const state=busyState(n);state.players[2]=make(n).players[2];
  const result=await compare(jobFor(state),true);
  assert.deepEqual(result.botUpdates.map(v=>v.key),['p2']);
  assert.equal(result.botUpdates[0].lastBotAt,result.state.serverNow);
});
test('Bowling restored JSON pending state preserves trajectory and boundary behavior',async()=>{
  const state=JSON.parse(JSON.stringify(busyState(4)));
  await compare(jobFor(state),false);
  await compare(jobFor(state,state.players[1].busyUntil),true);
});
test('Bowling direct act always remains off-thread, including BUSY rejection',async()=>{
  const state=busyState(),job={kind:'act',gameId:'bowling',ruleVersion:bowling.RULE_VERSION,state,now:state.players[1].busyUntil-1,playerKey:'p1',action:normal},before=submitted();
  await assert.rejects(runEngineTask(job),{code:'BUSY'});assert.equal(submitted()-before,1);
});
for(const mutate of [
  s=>{s.players[1].pending=true;},
  s=>{s.players[1].pending.gutter=undefined;},
  s=>{s.players[1].pending.down=[99];},
  s=>{s.players[1].pending.remaining=[...s.players[1].pending.remaining,...s.players[1].pending.remaining];},
  s=>{s.players[1].busyUntil=String(s.players[1].busyUntil);},
  s=>{s.players[1].isBot=false;},
  s=>{s.players[1].shotStartedAt=undefined;},
  s=>{s.players[1].completed=true;},
  s=>{s.players[1].forfeited=true;},
  s=>{s.phase='fault';s.fault={code:'PHYSICS_TIMEOUT',at:s.serverNow};},
  s=>{s.status='finished';s.phase='finished';},
])test(`uncertain or terminal Bowling state conservatively retains worker path ${String(mutate)}`,async()=>{
  const state=busyState(),at=state.players[1].busyUntil-1,job=jobFor(state,at);mutate(state);
  // Keep the admitted BOT roster fixed while corrupting its persisted state.
  await compare(job,true);
});
test('unknown pinned Bowling rule does not use the optimized local path',async()=>{
  const job=jobFor(busyState());job.ruleVersion=job.state.ruleVersion='pvp-bowling-future';const before=submitted();
  await assert.rejects(runEngineTask(job),{code:'PINNED_RULE_UNAVAILABLE'});assert.equal(submitted()-before,1);
});
for(const forfeits of [['p1'],['p0'],['p0','p1']])test(`pending Bowling forfeit ${forfeits.join(',')} preserves shared-executor result`,async()=>{
  await compare(jobFor(busyState(),undefined,{forfeits}),false);
});
test('pending shot across total deadline reveals its original score and never recomputes the accepted shot',async()=>{
  const state=make();state.players.forEach(p=>p.shotDeadlineAt=185000);
  bowling.act(state,'p1',normal,180500);const end=state.players[1].busyUntil;
  const before=await compare(jobFor(state,181000,{bots:[{key:'p1',lastBotAt:0}]}),false);
  assert.deepEqual(before.state.players[1].pending,state.players[1].pending);
  const at=await compare(jobFor(state,end,{bots:[{key:'p1',lastBotAt:0}]}),true);
  assert.equal(at.state.players[1].completed,true);assert.deepEqual(at.botUpdates,[]);
});
for(const setup of [[10,10,10],[0,0,0,0,7,3],[0,0,0,0,0]])test(`third-frame/fill-ball pending boundary ${setup.join(',')}`,async()=>{
  const state=make(3),p=state.players[1];
  for(const count of setup)bowling.recordRoll(p,count,p.standing.slice(count),1500);
  bowling.act(state,'p1',normal,2000);
  const bots=[{key:'p1',lastBotAt:0}];
  await compare(jobFor(state,p.busyUntil-1,{bots}),false);
  await compare(jobFor(state,p.busyUntil,{bots}),true);
});
