import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../arena/run/engine.mjs';
import {RUN_COURSES_V21} from '../arena/run/courses.mjs';
import {RUN_PRACTICE_PROFILES as P} from '../shared/run-practice-profiles.mjs';
import {createRunPracticeInputs,advanceRunPracticeInputs,applyRunPracticeInputs,compactRunPracticeDecisions,shiftRunPracticeInputs} from '../server/pvp/run-practice-inputs.mjs';
import {runEngineTask,closeEnginePool} from '../server/pvp/engine-pool.mjs';
after(closeEnginePool);
const copy=structuredClone,at=(s,t)=>Math.ceil(s.startedAt+t*1000/60);
const command=(commandSeq,type,executeTick)=>({commandSeq,type,executeTick});
function state(index=0,profile=P.v2,bots=3){
 const s=engine.createState(index.toString(16).padStart(8,'0').padEnd(64,'0'),1000,{ruleVersion:profile.ruleVersion,startPolicy:engine.RUN_SCENE_READY_POLICY,players:[{key:'human',seatIndex:0,isBot:false},...Array.from({length:bots},(_,i)=>({key:'bot_'+i,seatIndex:i+1,isBot:true}))]});
 engine.armStart(s,1000);return s;
}
function start(index=0,profile=P.v2,bots=3,extra={}){
 return createRunPracticeInputs({roomId:'room_v2',playerKey:'human',practice:true,entryMinor:'0',clockEpoch:1,state:state(index,profile,bots),protocol:profile.protocol,...(profile.profileId?{profileId:profile.profileId,feeBps:0}:{}),...extra}).envelope;
}
function to(e,tick,chunk=120){while(e.serverTick<tick)e=advanceRunPracticeInputs(e,Math.min(tick,e.serverTick+chunk)).envelope;return e;}
const payload=(e,commands,extra={})=>({roomId:e.roomId,playerKey:e.playerKey,clockEpoch:e.clockEpoch,baseRevision:e.revision,commands,...extra});
const apply=(e,commands,tick=e.serverTick,extra={})=>applyRunPracticeInputs(e,payload(e,commands,extra),tick);
const physics=s=>{const {ruleVersion,practiceOwnEvents,...rest}=s;return rest;};

test('v2 requires explicit free scope, fee, tuple and exactly one human; v1 is not widened',()=>{
 assert.equal(start().anchor.ruleVersion,'pvp-run-v2.4.0');assert.equal(start().profileId,'free-bot-360-v1');
 for(const extra of [{protocol:P.v1.protocol},{profileId:undefined},{profileId:'bad'},{feeBps:1},{feeBps:undefined},{entryMinor:'1000'},{practice:false},{playerKey:'bot_0'}])assert.throws(()=>start(0,P.v2,3,extra),{code:'INVALID_PRACTICE_SCOPE'});
 const multiplayer=state();multiplayer.players[1].isBot=false;assert.throws(()=>start(0,P.v2,3,{state:multiplayer}),{code:'INVALID_PRACTICE_SCOPE'});
 assert.throws(()=>advanceRunPracticeInputs(start(),121),{code:'INVALID_SERVER_TICK'});
 for(const [profile,head,ages]of [[P.v1,240,[119,120,121]],[P.v2,600,[359,360,361]]]){
  const e=to(start(0,profile),head);
  const decisions=apply(e,ages.map((age,i)=>command(i+1,'jump',head-age))).decisions;
  assert.equal(decisions[0].outcome,'accepted');assert.deepEqual(decisions.slice(1).map(d=>d.code),['INPUT_EXPIRED','INPUT_EXPIRED']);
  const future=apply(e,[command(1,'jump',head+2)]);assert.equal(future.decisions[0].code,'FUTURE_INPUT');
  assert.equal(apply(e,[command(1,'jump',head+1)]).decisions[0].outcome,'accepted');
 }
});

test('late input359 ticks behind repairs a real fall, retaining exact on-time full state and reversible events',()=>{
 const base=to(start(2),240),late=to(base,600);assert.ok(late.current.players[0].hits>0);
 const correction=apply(late,[command(1,'jump',241)],600,{baseRevision:base.revision});
 assert.equal(correction.decisions[0].outcome,'accepted');assert.equal(correction.correction.fromTick,241);
 const early=to(apply(base,[command(1,'jump',241)]).envelope,600);
 assert.deepEqual(correction.envelope.current,early.current);assert.deepEqual(correction.envelope.anchor,early.anchor);
 assert.equal(correction.envelope.current.practiceOwnEvents.some(e=>e.type==='fall'&&e.tick<300),false);
 assert.equal(correction.resultAuthorization,null);
});

test('anchor120 plus suffix360 uses exactly480 ticks, and repeated high/low replay cannot escape that budget',()=>{
 const e=to(start(),360),commands=Array.from({length:8},(_,i)=>command(i+1,i%2?'left':'right',121+i*12));
 const r=applyRunPracticeInputs(e,payload(e,commands),480,{measureWorkBytes:true});
 assert.ok(r.decisions.every(d=>d.outcome==='accepted'));assert.equal(r.work.ticks,480);
 assert.ok(r.work.temporaryStatesPeak<=12);assert.ok(r.work.stateCopies<=33);assert.ok(r.work.admissions<=1024);assert.ok(r.work.botDecisions<=768);
 assert.ok(Buffer.byteLength(JSON.stringify(r.envelope))<262144);
 assert.throws(()=>applyRunPracticeInputs(e,payload(e,commands),480,{maxWorkTicks:479}),{code:'WORK_BUDGET_EXCEEDED'});
 assert.throws(()=>applyRunPracticeInputs(e,payload(e,commands),480,{maxWorkTicks:481}),{code:'INVALID_WORK_LIMIT'});
 const pathological=[['item',479],['right',121],['item',479],['left',133],['item',479],['right',145],['item',479],['left',157]].map(([type,tick],i)=>command(i+1,type,tick));
 const before=copy(e);assert.throws(()=>apply(e,pathological,480),{code:'WORK_BUDGET_EXCEEDED'});assert.deepEqual(e,before);
});

test('exact receipt, JSONB roundtrip, trusted durable compaction and epoch recovery never reset input authority',()=>{
 let e=to(start(),360),r=apply(e,[command(1,'right',121),command(2,'jump',133)]);
 assert.ok(r.decisions.every(d=>d.outcome==='accepted'));e=r.envelope;
 const retry=apply(JSON.parse(JSON.stringify(e)),[command(1,'right',121),command(2,'jump',133)]);
 assert.ok(retry.decisions.every(d=>d.duplicate));assert.deepEqual(retry.envelope,e);
 assert.throws(()=>apply(e,[command(1,'left',121)]),{code:'COMMAND_CONFLICT'});
 const compact=compactRunPracticeDecisions(e,{throughSeq:2}).envelope;assert.equal(compact.decisions.length,0);assert.equal(compact.durableThrough,2);
 assert.throws(()=>apply(compact,[command(1,'right',121)]),{code:'DECISION_EXPIRED'});
 const shifted=shiftRunPracticeInputs(JSON.parse(JSON.stringify(compact)),{pauseMs:6000,clockEpoch:2}).envelope;
 assert.equal(shifted.lastCommandSeq,2);assert.equal(shifted.current.players[0].inputNo,2);assert.equal(shifted.clockEpoch,2);assert.equal(shifted.current.startedAt,e.current.startedAt+6000);
 assert.throws(()=>apply(shifted,[command(3,'left',145)],shifted.serverTick,{clockEpoch:1}),{code:'STALE_CLOCK_EPOCH'});
 assert.equal(shifted.anchor.practiceOwnEvents.every(event=>event.at>=e.anchor.startedAt+6000),true);
});

test('all six old course mappings and complete physical states survive coarse/fine v2 replay',()=>{
 for(let i=0;i<6;i++){
  const coarse=to(start(i),720),fine=to(start(i),720,17),old=to(start(i,P.v1),720);
  assert.deepEqual(coarse.current,fine.current);assert.equal(coarse.current.courseId,old.current.courseId);assert.deepEqual(physics(coarse.current),physics(old.current));
  assert.equal(coarse.anchor.tick,360);assert.equal(old.anchor.tick,600);
 }
});

test('own real fall survives48 global events and commits after360 ticks, with bounded journal under legal10Hz inputs',()=>{
 let e=start(2),seq=0,firstFall;
 // Drive authentic engine-admitted lane changes on the safe first meters,
 // then allow the real canal fall and BOT events to advance without synthesis.
 for(let t=0;t<240;t+=12){const r=apply(e,[command(++seq,seq%2?'right':'left',t+1)]);e=to(r.envelope,t+12);}
 e=to(e,1200);firstFall=e.current.practiceOwnEvents.find(event=>event.type==='fall');
 assert.ok(firstFall);assert.ok(e.current.events.length<=48);
 const target=Math.min(6000,firstFall.tick+360);e=to(start(2),target);
 const committed=e.anchor.practiceOwnEvents.find(event=>event.type==='fall'&&event.tick<=e.committedThroughTick);
 assert.ok(committed,'actual own fall is available from committed anchor');
 assert.ok(e.anchor.practiceOwnEvents.length<=256);assert.ok(e.current.practiceOwnEvents.length<=256);
 assert.ok(RUN_COURSES_V21.every(c=>c.items.length+Math.ceil(720/6)+Math.ceil(720/90)*2+Math.ceil(720/108)+2<256),'legal input/item/recovery event bound fits the journal');
 const previous=copy(e);const shifted=shiftRunPracticeInputs(e,{pauseMs:1000}).envelope;
 assert.deepEqual(shifted.anchor.practiceOwnEvents,previous.anchor.practiceOwnEvents.map(event=>({...event,at:event.at+1000})));
 assert.equal(to(start(2,P.v1),1200).current.practiceOwnEvents,undefined);
});

test('authentic dense human and3BOT events evict the own fall from global48 while committed anchor still delivers it',()=>{
 let e=start(2),fall=null,seq=0,evicted=false;
 for(let head=6;head<=900;head+=6){
  if(fall){
   // Choose a genuinely admissible action using the same unchanged engine;
   // protocol execution still performs its own admission and actual replay.
   for(const type of ['left','right','jump','slide','item']){
    try{engine.act(copy(e.current),'human',{type,observed_tick:e.current.tick},at(e.current,e.current.tick));}
    catch{continue;}
    const r=apply(e,[command(++seq,type,e.current.tick+1)]);assert.equal(r.decisions[0].outcome,'accepted');e=r.envelope;break;
   }
  }
  e=to(e,head);fall??=e.current.practiceOwnEvents.find(event=>event.type==='fall');
  if(fall&&!e.current.events.some(event=>event.id===fall.id)){
   assert.ok(e.committedThroughTick>=fall.tick);assert.ok(e.anchor.practiceOwnEvents.some(event=>event.id===fall.id&&event.type==='fall'));
   assert.equal(e.current.events.length,48);assert.ok(e.current.practiceOwnEvents.length<=256);assert.ok(Buffer.byteLength(JSON.stringify(e))<262144);evicted=true;break;
  }
 }
 assert.ok(evicted,'the regression exercises a real global-tail eviction, not an invented event');
});

test('provisional finished head can still reconcile an uncommitted late input and rotates epoch by replay, not by flattening state',()=>{
 let e=start(2);while(e.current.status!=='finished')e=advanceRunPracticeInputs(e,e.serverTick+120).envelope;
 assert.ok(e.current.tick>e.committedThroughTick);assert.equal(e.anchor.status,'active');
 const before=copy(e),admission=copy(e.anchor);let executeTick=null;
 while(admission.tick<e.current.tick){try{engine.act(copy(admission),'human',{type:'right',observed_tick:admission.tick},at(admission,admission.tick));executeTick=admission.tick+1;break;}catch{}engine.tick(admission,at(admission,admission.tick+1));}
 assert.ok(executeTick>e.committedThroughTick);const r=apply(e,[command(1,'right',executeTick)]);
 assert.equal(r.decisions[0].outcome,'accepted');assert.equal(r.correction.fromTick,executeTick);assert.equal(r.resultAuthorization,null);
 const shifted=shiftRunPracticeInputs(r.envelope,{pauseMs:2000}).envelope;
 assert.equal(shifted.clockEpoch,2);assert.equal(shifted.serverTick,e.serverTick);assert.equal(shifted.current.finishedAt,r.envelope.current.finishedAt+2000);assert.equal(shifted.current.tick,r.envelope.current.tick);
 assert.deepEqual(e,before);assert.equal(advanceRunPracticeInputs(shifted,shifted.serverTick).resultAuthorization,null);
});

test('100-second head cannot publish results until6360, then terminal authority is immutable',()=>{
 // Explicit trusted clock-limit fixture: both runners are stunned through
 // the limit, so the actual shared engine takes its100-second terminal path.
 // Normal BOT races finish earlier; their countdown/window is not changed.
 const clockState=state(2);for(const player of clockState.players)player.stunUntilTick=6001;
 let e=start(2,P.v2,3,{state:clockState}),sawProvisional=false;
 while(e.serverTick<6360){const r=advanceRunPracticeInputs(e,Math.min(6360,e.serverTick+120));e=r.envelope;
  if(e.current.status==='finished'&&e.current.tick>e.committedThroughTick){sawProvisional=true;assert.equal(r.resultAuthorization,null);}
 }
 assert.ok(sawProvisional);assert.equal(e.current.tick,6000);assert.equal(e.committedThroughTick,6000);
 const authorized=advanceRunPracticeInputs(e,6360).resultAuthorization;assert.equal(authorized.terminalTick,6000);
 const denied=apply(e,[command(1,'jump',6000)]);assert.equal(denied.decisions[0].code,'TERMINAL_COMMITTED');assert.deepEqual(denied.envelope.current,e.current);assert.equal(denied.resultAuthorization.key,authorized.key);
 assert.throws(()=>advanceRunPracticeInputs(e,6361),{code:'INVALID_SERVER_TICK'});
 assert.throws(()=>shiftRunPracticeInputs(e,{pauseMs:1000}),{code:'TERMINAL_COMMITTED'});
});

test('worker admits only matching pinned public tuples and retains the queue path without widening v1',async()=>{
 const e=start(),job={kind:'run-practice-inputs',gameId:'run',ruleVersion:P.v2.ruleVersion,operation:'advance',envelope:e,serverTick:120};
 assert.deepEqual(await runEngineTask(job),advanceRunPracticeInputs(e,120));
 for(const bad of [{...job,ruleVersion:P.v1.ruleVersion},{...job,envelope:{...e,profileId:null}},{...job,envelope:{...e,protocol:P.v1.protocol}}])await assert.rejects(runEngineTask(bad),{code:'PINNED_RULE_UNAVAILABLE'});
});

test('six complete races preserve fine/coarse physics and enforce actual envelope, work and retained-state bounds',t=>{
 const bounds={courses:6,maxTicks:0,maxAdmissions:0,maxBotDecisions:0,maxStateCopies:0,maxTemporaryStates:0,maxCopiedStateBytes:0,maxTemporaryStateBytes:0,maxEnvelopeBytes:0,maxOwnEvents:0};
 for(let index=0;index<6;index++){
  let coarse=start(index);
  while(coarse.serverTick<6360){const r=advanceRunPracticeInputs(coarse,Math.min(6360,coarse.serverTick+120),{measureWorkBytes:true});coarse=r.envelope;
   for(const [key,value]of Object.entries({maxTicks:r.work.ticks,maxAdmissions:r.work.admissions,maxBotDecisions:r.work.botDecisions,maxStateCopies:r.work.stateCopies,maxTemporaryStates:r.work.temporaryStatesPeak,maxCopiedStateBytes:r.work.copiedStateBytes,maxTemporaryStateBytes:r.work.temporaryStateBytesPeak,maxEnvelopeBytes:Buffer.byteLength(JSON.stringify(coarse)),maxOwnEvents:Math.max(coarse.anchor.practiceOwnEvents.length,coarse.current.practiceOwnEvents.length)}))bounds[key]=Math.max(bounds[key],value);
   assert.ok(coarse.commands.length<=128&&coarse.decisions.length<=128&&coarse.revisions.length<=128);
  }
  const fine=to(start(index),6360,37),old=to(start(index,P.v1),6120);
  assert.deepEqual(coarse.current,fine.current);assert.deepEqual(coarse.anchor,fine.anchor);assert.deepEqual(physics(coarse.current),physics(old.current));
  assert.deepEqual(engine.rank(coarse.current),engine.rank(old.current));assert.ok(advanceRunPracticeInputs(coarse,6360).resultAuthorization);
 }
 assert.ok(bounds.maxTicks<=480);assert.ok(bounds.maxAdmissions<=1024);assert.ok(bounds.maxBotDecisions<=768);assert.ok(bounds.maxTemporaryStates<=12);assert.ok(bounds.maxEnvelopeBytes<=262144);assert.ok(bounds.maxOwnEvents<=256);
 t.diagnostic(JSON.stringify(bounds));
});
