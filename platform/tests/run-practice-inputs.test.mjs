import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as Engine from '../arena/run/engine.mjs';
import {createRunPracticeInputs,advanceRunPracticeInputs,applyRunPracticeInputs,compactRunPracticeDecisions,shiftRunPracticeInputs,RUN_PRACTICE_REPLAY_LIMITS as LIMITS,RUN_PRACTICE_WORK_LIMITS as WORK} from '../server/pvp/run-practice-inputs.mjs';

// Independently frozen complete old engine, not a second invocation of the new
// controller/shared step as the physics oracle. Only its import URLs relocate.
const source=await readFile(new URL('./fixtures/run-engine-before-runner-physics.mjs',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'0c102a4160114510e20959a9f276186be5867247e93c4d1bfe5c098706b4c5e8');
const resolved=source.replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL(path,new URL('../arena/run/engine.mjs',import.meta.url)).href}'`);
const E=await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);
const copy=structuredClone,freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const at=(s,t)=>Math.ceil(s.startedAt+t*1000/60);
function state(index=0){const s=E.createState(index.toString(16).padStart(8,'0').padEnd(64,'0'),1000,{ruleVersion:E.PRACTICE_RULE_VERSION,startPolicy:E.RUN_SCENE_READY_POLICY,players:[{key:'self',seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]});E.armStart(s,1000);return s;}
function start(index=0,options={}){return createRunPracticeInputs({roomId:'room_test',playerKey:'self',practice:true,entryMinor:'0',clockEpoch:1,state:state(index),...options}).envelope;}
const command=(commandSeq,type,executeTick)=>({commandSeq,type,executeTick});
function apply(e,commands,tick=e.serverTick,extra={}){return applyRunPracticeInputs(e,{roomId:e.roomId,playerKey:e.playerKey,clockEpoch:e.clockEpoch,baseRevision:e.revision,commands,...extra},tick);}
function to(e,tick,step=120){while(e.serverTick<tick)e=advanceRunPracticeInputs(e,Math.min(tick,e.serverTick+step)).envelope;return e;}
// New protocol BOT scheduling is explicit and independent of the controller:
// every 6th pre-step tick, human first, BOT seat order, one real engine tick.
function oracle(s,target,commands=[]){
 for(let next=s.tick+1;next<=target+1&&s.status==='active';next++){
  for(const c of commands.filter(c=>c.executeTick===next))E.act(s,'self',{type:c.type,observed_tick:next-1},at(s,next-1));
  if((next-1)%6===0)for(const p of s.players.filter(p=>p.isBot).sort((a,b)=>a.seatIndex-b.seatIndex)){
   const action=E.botAction(s,p.key,at(s,next-1));if(action)E.act(s,p.key,action,at(s,next-1));
  }
  if(next<=target)E.tick(s,at(s,next));
 }
 return s;
}

test('only explicit free, one-human, newly armed BOT practice scope can create history',()=>{
 for(const change of [{practice:false},{entryMinor:'1'},{playerKey:'bot'},{clockEpoch:0}])assert.throws(()=>start(0,change),{code:'INVALID_PRACTICE_SCOPE'});
 const paid=state();paid.ruleVersion=E.RULE_VERSION;assert.throws(()=>start(0,{state:paid}),{code:'INVALID_PRACTICE_SCOPE'});
 const multi=state();multi.players[1].isBot=false;assert.throws(()=>start(0,{state:multi}),{code:'INVALID_PRACTICE_SCOPE'});
 const running=state();E.tick(running,at(running,10));assert.throws(()=>start(0,{state:running}),{code:'MISSING_INITIAL_HISTORY'});
 assert.equal(start().protocol,'run-practice-inputs-v1');
});

test('real V2.3 armed state enters the core explicitly, while V2.2 fixtures remain and other pins reject',()=>{
 const s=Engine.createState('00'.repeat(32),1000,{ruleVersion:Engine.PRACTICE_INPUT_RULE_VERSION,startPolicy:Engine.RUN_SCENE_READY_POLICY,
  players:[{key:'self',seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]});
 assert.equal(s.ruleVersion,'pvp-run-v2.3.0');assert.equal(s.phase,'arming');
 assert.throws(()=>start(0,{state:s}),{code:'MISSING_INITIAL_HISTORY'});
 Engine.armStart(s,1000);assert.equal(s.phase,'racing');assert.equal(s.startedAt,1000);
 const base=start(0,{state:s}),r=apply(base,[command(1,'jump',1)]),e=to(r.envelope,120);
 assert.equal(r.decisions[0].outcome,'accepted');assert.equal(e.current.ruleVersion,Engine.PRACTICE_INPUT_RULE_VERSION);
 assert.equal(e.anchor.ruleVersion,Engine.PRACTICE_INPUT_RULE_VERSION);assert.equal(e.current.players[0].appliedInputNo,1);
 assert.equal(start().current.ruleVersion,'pvp-run-v2.2.0');
 for(const ruleVersion of [Engine.RULE_VERSION,Engine.PREVIOUS_RULE_VERSION,'pvp-run-v1.0.0','pvp-run-v9.0.0']){
  const other=copy(s);other.ruleVersion=ruleVersion;assert.throws(()=>start(0,{state:other}),{code:'INVALID_PRACTICE_SCOPE'});
 }
});

test('six real courses, fixed BOT decisions and full states match independent complete oracle',()=>{
 for(let i=0;i<6;i++){
  const e=to(start(i),720,37),reference=oracle(state(i),720);
  assert.deepEqual(e.current,reference,`course ${i}`);
  assert.equal(e.anchor.tick,600);assert.ok(e.commands.length<=21);
 }
});

test('late tick241 jump at258 repairs the actual canal fall, matching on-time engine, old rule stays BUSY',()=>{
 let base=to(start(2),240),late=to(base,258);
 assert.notEqual(late.current.players[0].fallUntilTick,null);
 const old=copy(late.current);assert.throws(()=>Engine.act(old,'self',{type:'jump'},old.now),{code:'BUSY'});
 const result=apply(late,[command(1,'jump',241)],258,{baseRevision:base.revision});
 assert.equal(result.decisions[0].outcome,'accepted');assert.equal(result.decisions[0].acceptedInputNo,1);
 assert.equal(result.envelope.current.players[0].fallUntilTick,null);
 assert.equal(result.envelope.current.players[0].hits,0);assert.equal(result.correction.fromTick,241);
 const early=to(apply(base,[command(1,'jump',241)]).envelope,258);
 assert.deepEqual(result.envelope.current,early.current);
 assert.deepEqual(result.envelope.current,oracle(state(2),258,[command(1,'jump',241)]));
 assert.equal(result.resultAuthorization,null);
});

test('lane, jump, slide and rejection at execution tick reuse exact engine admission',()=>{
 let e=start();e=apply(e,[command(1,'right',1)]).envelope;e=to(e,13);
 e=apply(e,[command(2,'left',13)]).envelope;e=to(e,19);
 e=apply(e,[command(3,'jump',19)]).envelope;e=to(e,67);
 const bad=apply(e,[command(4,'slide',25)]);assert.equal(bad.decisions[0].code,'AIRBORNE');
 assert.equal(bad.envelope.lastCommandSeq,4);assert.equal(bad.envelope.current.players[0].inputNo,3);
 const good=apply(bad.envelope,[command(5,'slide',67)]);assert.equal(good.decisions[0].acceptedInputNo,4);
 const final=to(good.envelope,120),accepted=[command(1,'right',1),command(2,'left',13),command(3,'jump',19),command(5,'slide',67)];
 assert.deepEqual(final.current,oracle(state(),120,accepted));
});

test('commandSeq consumes rejection, inputNo does not; no item, rate and track-edge failures persist',()=>{
 let r=apply(start(),[command(1,'item',1),command(2,'left',1)]);assert.equal(r.decisions[0].code,'NO_ITEM');assert.equal(r.decisions[1].acceptedInputNo,1);
 r=apply(r.envelope,[command(3,'jump',2)],1);assert.equal(r.decisions[0].code,'RATE_LIMIT');
 r=apply(to(r.envelope,12),[command(4,'left',13)]);assert.equal(r.decisions[0].code,'TRACK_EDGE');
 assert.equal(r.envelope.lastCommandSeq,4);assert.equal(r.envelope.current.players[0].inputNo,1);
});

test('lost ACK retransmits exact oldest prefix plus new commands once; conflict and gaps are atomic',()=>{
 let r=apply(start(),[command(1,'right',1)]),e=to(r.envelope,6);
 r=apply(e,[command(1,'right',1),command(2,'jump',7)]);
 assert.equal(r.decisions[0].duplicate,true);assert.equal(r.decisions[1].duplicate,false);assert.equal(r.envelope.current.players[0].inputNo,2);
 const duplicate=apply(r.envelope,[command(1,'right',1),command(2,'jump',7)]);
 assert.deepEqual(duplicate.envelope,r.envelope);assert.ok(duplicate.decisions.every(d=>d.duplicate));
 const before=JSON.stringify(r.envelope);
 assert.throws(()=>apply(r.envelope,[command(1,'left',1)]),{code:'COMMAND_CONFLICT'});
 assert.throws(()=>apply(r.envelope,[command(4,'slide',30)]),{code:'COMMAND_SEQUENCE_GAP'});
 assert.throws(()=>apply(r.envelope,[command(3,'item',8),command(5,'slide',30)]),{code:'COMMAND_SEQUENCE_GAP'});
 assert.equal(JSON.stringify(r.envelope),before);
});

test('expired/future/execution order are explicit consumed decisions; equality at watermark expires',()=>{
 let e=to(start(),240);let r=apply(e,[command(1,'jump',120),command(2,'jump',242)]);
 assert.equal(r.decisions[0].code,'INPUT_EXPIRED');assert.equal(r.decisions[1].code,'FUTURE_INPUT');
 r=apply(r.envelope,[command(3,'jump',200)]);assert.equal(r.decisions[0].outcome,'accepted');
 r=apply(r.envelope,[command(4,'right',190)]);assert.equal(r.decisions[0].code,'EXECUTION_ORDER');
 assert.equal(r.envelope.lastCommandSeq,4);assert.equal(r.envelope.current.players[0].inputNo,1);
});

test('wrong room/player/epoch/base and untrusted score fields fail without modifying history',()=>{
 const e=freeze(start());
 for(const extra of [{roomId:'other'},{playerKey:'bot'}])assert.throws(()=>apply(e,[command(1,'jump',1)],0,extra),{code:'INVALID_INPUT_SCOPE'});
 assert.throws(()=>apply(e,[command(1,'jump',1)],0,{clockEpoch:2}),{code:'STALE_CLOCK_EPOCH'});
 assert.throws(()=>apply(e,[command(1,'jump',1)],0,{baseRevision:2}),{code:'UNKNOWN_BASE_REVISION'});
 assert.throws(()=>apply(e,[{...command(1,'jump',1),score:999}]),{code:'INVALID_COMMAND'});
 assert.throws(()=>apply(e,[]),{code:'INVALID_BATCH'});
 assert.throws(()=>apply(e,Array.from({length:9},(_,i)=>command(i+1,'jump',1))),{code:'INVALID_BATCH'});
 assert.equal(e.current.players[0].inputNo,0);
});

test('missing/corrupted history fails; JSON persistence and caller state are isolated',()=>{
 const original=freeze(state()),e=start(0,{state:original}),saved=JSON.stringify(e);
 for(const mutate of [x=>x.commands.push(command(1,'jump',1)),x=>x.anchor.players[0].distanceU++,x=>delete x.current,x=>x.clockEpoch++]){
  const bad=copy(e);mutate(bad);assert.throws(()=>advanceRunPracticeInputs(bad,10),{code:'INVALID_HISTORY'});
 }
 const a=apply(freeze(e),[command(1,'jump',1)]),b=apply(JSON.parse(saved),[command(1,'jump',1)]);
 assert.deepEqual(a,b);assert.equal(JSON.stringify(e),saved);assert.equal(original.players[0].inputNo,0);
 a.envelope.current.players[0].distanceU=999;assert.equal(b.envelope.current.players[0].distanceU,0);
});

test('full race one-tick, 15-tick and irregular advance have identical states and committed rankings',()=>{
 const one=to(start(2),6120,1),fifteen=to(start(2),6120,15);
 let irregular=start(2);for(const step of Array.from({length:300},(_,i)=>[7,31,13,59][i%4]))if(irregular.serverTick<6120)irregular=to(irregular,Math.min(6120,irregular.serverTick+step));
 assert.equal(irregular.serverTick,6120);assert.deepEqual(one.current,fifteen.current);assert.deepEqual(one.current,irregular.current);
 assert.deepEqual(one.anchor,fifteen.anchor);assert.deepEqual(one.anchor,irregular.anchor);
 const reference=oracle(state(2),6000);assert.deepEqual(one.current,reference);
 const a=advanceRunPracticeInputs(one,6120).resultAuthorization,b=advanceRunPracticeInputs(irregular,6120).resultAuthorization;
 assert.ok(a);assert.equal(a.key,b.key);assert.deepEqual(a.ranks,E.rank(reference));assert.deepEqual(a.ranks,b.ranks);
});

test('advance and memory are bounded; decisions never silently evict retry evidence',()=>{
 let e=start();assert.throws(()=>advanceRunPracticeInputs(e,121),{code:'INVALID_SERVER_TICK'});
 assert.throws(()=>advanceRunPracticeInputs(to(e,10),9),{code:'INVALID_SERVER_TICK'});
 for(let seq=1;seq<=128;seq+=8)e=apply(e,Array.from({length:8},(_,i)=>command(seq+i,'item',1))).envelope;
 assert.equal(e.decisions.length,LIMITS.decisions);assert.equal(e.lastCommandSeq,128);
 assert.throws(()=>apply(e,[command(129,'jump',1)]),{code:'DECISION_CAPACITY'});
 const retry=apply(e,[command(1,'item',1)]);assert.equal(retry.decisions[0].duplicate,true);assert.equal(retry.decisions[0].code,'NO_ITEM');
 assert.ok(Buffer.byteLength(JSON.stringify(e))<LIMITS.envelopeBytes);
});

test('old base revision expires, but exact old receipt remains replayable without re-admission',()=>{
 let e=apply(start(),[command(1,'jump',1)]).envelope;e=to(e,240);
 assert.throws(()=>apply(e,[command(2,'slide',200)],240,{baseRevision:0}),{code:'BASE_REVISION_EXPIRED'});
 const r=apply(e,[command(1,'jump',1)],240,{baseRevision:0});assert.equal(r.decisions[0].duplicate,true);
 assert.deepEqual(r.envelope,e);
});

test('advance-before-input and combined advance enforce the same stale-base boundary',()=>{
 const e=to(start(),120),cmd=[command(1,'jump',241)];
 assert.throws(()=>apply(e,cmd,240,{baseRevision:0}),{code:'BASE_REVISION_EXPIRED'});
 assert.throws(()=>apply(to(e,240),cmd,240,{baseRevision:0}),{code:'BASE_REVISION_EXPIRED'});
 const known=apply(e,cmd,240),separate=apply(to(e,240),cmd,240,{baseRevision:e.revision});
 assert.deepEqual(known.envelope.current,separate.envelope.current);
});

test('same-tick advance and exact duplicate do not trim bounded revision history or increment revision',()=>{
 let e=start();
 // 120 advancing versions plus distinct decisions at the same tick fill the
 // bounded revision history, without reaching the independent decision cap.
 e=to(e,120,1);
 for(let seq=1;seq<=10;seq++)e=apply(e,[command(seq,'item',121)]).envelope;
 assert.equal(e.revisions.length,128);
 assert.deepEqual(advanceRunPracticeInputs(e,120).envelope,e);
 assert.deepEqual(apply(e,[command(1,'item',121)]).envelope,e);
 assert.throws(()=>apply(e,[command(2,'item',121),command(1,'item',121)]),{code:'COMMAND_SEQUENCE_GAP'});
});

test('natural race terminal stays provisional until watermark, then authorization is stable and cannot reopen',()=>{
 let e=start(),r;
 while(e.current.status!=='finished'){r=advanceRunPracticeInputs(e,Math.min(6000,e.serverTick+120));e=r.envelope;}
 const terminalTick=e.current.tick;assert.ok(terminalTick<=6000);assert.equal(r.resultAuthorization,null);
 while(e.serverTick<terminalTick+119)e=advanceRunPracticeInputs(e,Math.min(terminalTick+119,e.serverTick+120)).envelope;
 assert.equal(advanceRunPracticeInputs(e,e.serverTick).resultAuthorization,null);
 r=advanceRunPracticeInputs(e,terminalTick+120);assert.equal(r.resultAuthorization.terminalTick,terminalTick);
 const old=copy(r.envelope.current),key=r.resultAuthorization.key;
 const denied=apply(r.envelope,[command(1,'jump',terminalTick)]);assert.equal(denied.decisions[0].code,'TERMINAL_COMMITTED');
 assert.deepEqual(denied.envelope.current,old);assert.equal(denied.resultAuthorization.key,key);
 assert.deepEqual(denied.resultAuthorization.ranks,Engine.rank(old));
 assert.equal('payout'in denied.resultAuthorization,false);
});

function singles(base,commands,serverTick){
 const decisions=[];let e=base;
 for(const c of commands){const r=apply(e,[c],serverTick);e=r.envelope;decisions.push(...r.decisions);}
 return {envelope:e,decisions};
}
const decisionMeaning=({revision,...decision})=>decision;
function batchEqual(base,commands,serverTick){
 const r=apply(base,commands,serverTick),single=singles(base,commands,serverTick);
 assert.deepEqual(r.envelope.current,single.envelope.current);assert.deepEqual(r.envelope.anchor,single.envelope.anchor);
 assert.deepEqual(r.envelope.commands,single.envelope.commands);assert.equal(r.envelope.lastCommandSeq,single.envelope.lastCommandSeq);
 assert.deepEqual(r.decisions.map(decisionMeaning),single.decisions.map(decisionMeaning));
 return r;
}

test('8 legal ordered commands traverse history once, matching sequential submission with <=12 live states',()=>{
 const commands=Array.from({length:8},(_,i)=>command(i+1,i%2?'left':'right',1+i*12));
 const r=batchEqual(start(),commands,120);
 assert.ok(r.decisions.every(d=>d.outcome==='accepted'));
 assert.equal(r.work.ticks,120);assert.ok(r.work.temporaryStatesPeak<=12);
 assert.ok(r.work.stateCopies<=32,'only command boundaries are copied, not every tick');
 assert.equal(r.work.copiedStateBytes,null,'byte diagnostics are off by default');
});

test('8 mixed accepted/denied commands match sequential semantics with one monotone traversal',()=>{
 const commands=[command(1,'item',1),command(2,'right',1),command(3,'left',7),command(4,'left',13),
  command(5,'jump',19),command(6,'slide',25),command(7,'slide',67),command(8,'item',73)];
 const r=batchEqual(start(),commands,120);
 assert.deepEqual(r.decisions.map(d=>d.code),['NO_ITEM',null,'CHANGING_LANE',null,null,'AIRBORNE',null,'NO_ITEM']);
 assert.equal(r.work.ticks,120);assert.ok(r.work.stateCopies<=32);assert.ok(r.work.temporaryStatesPeak<=12);
});

test('committed-prefix movement is included in the exact 240-tick total batch work budget',()=>{
 const e=to(start(),120),commands=Array.from({length:8},(_,i)=>command(i+1,i%2?'left':'right',121+i*12));
 const request={roomId:e.roomId,playerKey:e.playerKey,clockEpoch:e.clockEpoch,baseRevision:e.revision,commands};
 const r=applyRunPracticeInputs(e,request,240,{measureWorkBytes:true});
 assert.ok(r.decisions.every(d=>d.outcome==='accepted'));assert.equal(r.work.ticks,240);
 assert.ok(r.work.admissions<=WORK.admissions);assert.ok(r.work.botDecisions<=WORK.botDecisions);
 assert.ok(r.work.stateCopies<=33);assert.ok(r.work.copiedStateBytes>0);assert.ok(r.work.temporaryStatesPeak<=WORK.temporaryStates);
 const before=JSON.stringify(e);assert.throws(()=>applyRunPracticeInputs(e,request,240,{maxWorkTicks:239}),{code:'WORK_BUDGET_EXCEEDED'});
 assert.equal(JSON.stringify(e),before);assert.equal(e.lastCommandSeq,0);
 assert.throws(()=>applyRunPracticeInputs(e,request,240,{maxWorkTicks:241}),{code:'INVALID_WORK_LIMIT'});
});

test('backward tick after a rejection preserves sequential decision semantics and charges replayed work',()=>{
 const commands=[command(1,'jump',1),command(2,'slide',45),command(3,'right',13),command(4,'item',100),command(5,'left',25)];
 const r=batchEqual(start(),commands,120);
 assert.equal(r.decisions[1].code,'AIRBORNE');assert.equal(r.decisions[3].code,'NO_ITEM');
 assert.ok(r.work.ticks>120&&r.work.ticks<=240);assert.ok(r.work.stateCopies<=32);
});

test('pathological lookahead/rewind exceeds the unified work budget without any partial state or decision',()=>{
 const e=freeze(start()),before=JSON.stringify(e),commands=[command(1,'item',119),command(2,'right',1),command(3,'item',119),
  command(4,'left',13),command(5,'item',119),command(6,'right',25),command(7,'item',119),command(8,'left',37)];
 assert.throws(()=>apply(e,commands,120),{code:'WORK_BUDGET_EXCEEDED'});
 assert.equal(JSON.stringify(e),before);assert.equal(e.lastCommandSeq,0);assert.deepEqual(e.decisions,[]);
 // This is a resource refusal of the atomic batch, not eight durable denials:
 // the same first command remains valid when retried as a smaller request.
 const first=apply(e,[commands[0]],120);assert.equal(first.decisions[0].code,'NO_ITEM');assert.equal(first.envelope.lastCommandSeq,1);
});

test('1000 decisions may be declared durable and compacted without a lifetime command cap or input replay',()=>{
 let e=start();const ledger=new Map();
 // This Map models the coordinator declaration ordering ONLY. It is not a DB
 // transaction/commit test; the pure function neither reads nor verifies it.
 for(let seq=1;seq<=1000;seq+=8){
  const commands=Array.from({length:8},(_,i)=>command(seq+i,seq+i===1?'right':'left',1));
  const r=apply(e,commands);e=r.envelope;
  for(const d of e.decisions){assert.equal(ledger.has(d.commandSeq),false);ledger.set(d.commandSeq,copy(d));}
  const previous=copy(e),compacted=compactRunPracticeDecisions(freeze(e),{throughSeq:e.lastCommandSeq},{maxWorkTicks:0});e=compacted.envelope;
  assert.equal(e.durableThrough,seq+7);assert.deepEqual(e.decisions,[]);assert.equal(e.lastCommandSeq,seq+7);
  assert.equal(e.current.players[0].inputNo,1);assert.deepEqual(e.commands,previous.commands);
  assert.deepEqual(e.current,previous.current);assert.deepEqual(e.anchor,previous.anchor);assert.equal(e.revision,previous.revision);
  assert.deepEqual(e.revisions,previous.revisions);assert.equal(compacted.work.ticks,0);assert.equal(compacted.work.admissions,0);
  assert.ok(compacted.work.temporaryStatesPeak<=2);assert.ok(compacted.work.stateCopies<=2);
 }
 assert.equal(ledger.size,1000);assert.equal(ledger.get(1).outcome,'accepted');assert.equal(ledger.get(1000).code,'EXECUTION_ORDER');
 const advanced=to(e,6),next=apply(advanced,[command(1001,'jump',7)]);
 assert.equal(next.decisions[0].acceptedInputNo,2);assert.equal(next.envelope.lastCommandSeq,1001);
 assert.equal(next.envelope.durableThrough,1000);assert.equal(next.envelope.decisions.length,1);
 assert.equal(next.envelope.current.players[0].lane,2,'compacted accepted command still replayed from real history');
});

test('partial durable compaction retains exact remaining duplicates and all accepted physics/history',()=>{
 const commands=[command(1,'item',1),command(2,'right',1),command(3,'left',7),command(4,'left',13),
  command(5,'jump',19),command(6,'slide',25),command(7,'slide',67),command(8,'item',73)];
 const original=freeze(apply(start(),commands,120).envelope),before=JSON.stringify(original);
 const partial=compactRunPracticeDecisions(original,{throughSeq:4}),e=partial.envelope;
 assert.equal(e.durableThrough,4);assert.deepEqual(e.decisions,original.decisions.slice(4));
 for(const field of ['lastCommandSeq','lastAcceptedExecuteTick','clockEpoch','revision','serverTick','committedThroughTick','commands','revisions','current','anchor'])assert.deepEqual(e[field],original[field],field);
 const duplicate=apply(e,[commands[5]]);assert.equal(duplicate.decisions[0].duplicate,true);assert.equal(duplicate.decisions[0].code,'AIRBORNE');
 assert.deepEqual(duplicate.envelope,e);assert.equal(JSON.stringify(original),before);
 assert.deepEqual(compactRunPracticeDecisions(e,{throughSeq:4}).envelope,e,'equal durable cursor is idempotent');
 const more=compactRunPracticeDecisions(e,{throughSeq:6}).envelope;
 assert.deepEqual(more.decisions,original.decisions.slice(6));assert.equal(more.durableThrough,6);
});

test('durable prefix bounds/shape are strict and failures cannot partially compact caller-owned state',()=>{
 const ready=apply(start(),[command(1,'right',1),command(2,'item',1)]).envelope;
 const e=freeze(compactRunPracticeDecisions(ready,{throughSeq:1}).envelope),before=JSON.stringify(e);
 for(const declaration of [{throughSeq:0},{throughSeq:3},{throughSeq:-1},{throughSeq:1.5},{throughSeq:'2'},null,{},
  {throughSeq:2,clientAck:true},{throughSeq:2,databaseCommitted:true}])assert.throws(()=>compactRunPracticeDecisions(e,declaration),{code:'INVALID_DURABLE_PREFIX'});
 assert.equal(JSON.stringify(e),before);assert.equal(e.durableThrough,1);assert.equal(e.decisions.length,1);
});

test('compacted old duplicate or altered old payload explicitly requires DB lookup, never auto-accepts',()=>{
 const accepted=apply(start(),[command(1,'right',1)]).envelope;
 const e=freeze(compactRunPracticeDecisions(accepted,{throughSeq:1}).envelope),before=JSON.stringify(e);
 for(const commands of [[command(1,'right',1)],[command(1,'left',1)],[command(1,'right',1),command(2,'jump',7)]]){
  assert.throws(()=>apply(e,commands,6),{code:'DECISION_EXPIRED'});
  assert.equal(JSON.stringify(e),before);assert.equal(e.lastCommandSeq,1);assert.equal(e.current.players[0].inputNo,1);
 }
 // Only AFTER exact old-prefix validation by the coordinator can a new tail be
 // submitted separately. No 'verified' boolean or fabricated decision bypass.
 const tail=apply(e,[command(2,'jump',7)],6);assert.equal(tail.decisions[0].acceptedInputNo,2);
 assert.equal(tail.envelope.durableThrough,1);assert.equal(tail.envelope.lastCommandSeq,2);
});

test('trusted pause shifts the anchor and replays BOTs, pending input and timestamps against the full oracle',()=>{
 const cmd=command(1,'jump',241),base=to(start(2),240),e=freeze(apply(base,[cmd]).envelope),before=JSON.stringify(e);
 assert.equal(e.current.players[0].pendingInput.tick,241);
 const pauseMs=1234,r=shiftRunPracticeInputs(e,{pauseMs}),next=r.envelope;
 const reference=oracle(state(2),e.anchor.tick);E.shiftTime(reference,pauseMs);oracle(reference,e.serverTick,[cmd]);
 assert.deepEqual(next.current,reference);
 assert.deepEqual(next.current.players[0].pendingInput,e.current.players[0].pendingInput);
 for(const field of ['serverTick','committedThroughTick','lastCommandSeq','durableThrough','lastAcceptedExecuteTick','commands','decisions'])assert.deepEqual(next[field],e[field],field);
 assert.equal(next.clockEpoch,2);assert.equal(next.revision,e.revision+1);
 assert.deepEqual(next.revisions,[{revision:next.revision,serverTick:240}]);
 assert.equal(next.current.players[0].inputNo,1);assert.equal(next.decisions[0].clockEpoch,1,'original receipt is immutable');
 assert.equal(r.work.ticks,120);assert.ok(r.work.temporaryStatesPeak<=WORK.temporaryStates);assert.equal(JSON.stringify(e),before);
 assert.throws(()=>apply(next,[command(2,'left',247)],246,{clockEpoch:1}),{code:'STALE_CLOCK_EPOCH'});
 assert.throws(()=>apply(next,[cmd]),{code:'DECISION_EPOCH_MISMATCH'});
 assert.throws(()=>apply(next,[command(2,'left',247)],246,{baseRevision:e.revision}),{code:'BASE_REVISION_EXPIRED'});
 const accepted=apply(to(next,246),[command(2,'left',247)]);
 assert.equal(accepted.decisions[0].acceptedInputNo,2);assert.equal(accepted.decisions[0].clockEpoch,2);
 assert.equal(accepted.envelope.lastCommandSeq,2);assert.equal(accepted.envelope.lastAcceptedExecuteTick,247);
});

test('speculative finished head is rebuilt on pause; a committed terminal must settle, never shift',()=>{
 let e=start();while(e.current.status!=='finished')e=advanceRunPracticeInputs(e,Math.min(6000,e.serverTick+120)).envelope;
 assert.equal(e.anchor.status,'active');assert.ok(e.current.tick>e.committedThroughTick);
 const r=shiftRunPracticeInputs(freeze(e),{pauseMs:2000,clockEpoch:2}),reference=oracle(state(),e.anchor.tick);
 E.shiftTime(reference,2000);oracle(reference,e.serverTick);
 assert.deepEqual(r.envelope.current,reference);assert.equal(r.envelope.current.status,'finished');
 assert.equal(r.envelope.current.finishedAt,e.current.finishedAt+2000);assert.equal(r.resultAuthorization,null);
 assert.ok(r.work.ticks<=120);assert.equal(r.envelope.serverTick,e.serverTick);
 let committed=to(r.envelope,r.envelope.current.tick+120);assert.ok(advanceRunPracticeInputs(committed,committed.serverTick).resultAuthorization);
 const before=JSON.stringify(committed);assert.throws(()=>shiftRunPracticeInputs(committed,{pauseMs:1}),{code:'TERMINAL_COMMITTED'});
 assert.equal(JSON.stringify(committed),before);
});

test('pause/epoch bounds and work exhaustion leave the original envelope atomic and unchanged',()=>{
 const e=freeze(to(start(),240)),before=JSON.stringify(e);
 for(const declaration of [null,{}, {pauseMs:0},{pauseMs:-1},{pauseMs:60001},{pauseMs:1.5},{pauseMs:'1'},{pauseMs:1,clientClock:true}]){
  assert.throws(()=>shiftRunPracticeInputs(e,declaration),{code:'INVALID_PAUSE'});
 }
 for(const clockEpoch of [null,0,1,3,1.5,'2',NaN,Infinity])assert.throws(()=>shiftRunPracticeInputs(e,{pauseMs:1,clockEpoch}),{code:'INVALID_CLOCK_EPOCH'});
 assert.throws(()=>shiftRunPracticeInputs(e,{pauseMs:60000},{maxWorkTicks:119}),{code:'WORK_BUDGET_EXCEEDED'});
 assert.equal(JSON.stringify(e),before);
 const r=shiftRunPracticeInputs(e,{pauseMs:60000});assert.equal(r.work.ticks,120);assert.equal(r.envelope.current.startedAt,e.current.startedAt+60000);
 assert.equal(r.envelope.serverTick-e.anchor.tick,120,'same two-second replay span');
 const compacted=compactRunPracticeDecisions(r.envelope,{throughSeq:0});assert.equal(compacted.envelope.clockEpoch,2);
});

test('deep object-key reordering like jsonb preserves history integrity and identical transitions',()=>{
 const reverseKeys=value=>Array.isArray(value)?value.map(reverseKeys):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reverseKeys(value[key])])):value;
 let e=apply(to(start(2),240),[command(1,'jump',241)]).envelope;
 e=shiftRunPracticeInputs(e,{pauseMs:500}).envelope;
 e=compactRunPracticeDecisions(e,{throughSeq:1}).envelope;
 const reordered=JSON.parse(JSON.stringify(reverseKeys(e)));
 assert.notEqual(JSON.stringify(reordered),JSON.stringify(e));assert.equal(reordered.integrity,e.integrity);
 assert.deepEqual(advanceRunPracticeInputs(reordered,246),advanceRunPracticeInputs(e,246));
 const request={roomId:e.roomId,playerKey:e.playerKey,clockEpoch:e.clockEpoch,baseRevision:e.revision,commands:[command(2,'right',247)]};
 assert.deepEqual(applyRunPracticeInputs(reordered,reverseKeys(request),246),applyRunPracticeInputs(e,request,246));
 assert.deepEqual(shiftRunPracticeInputs(reordered,{pauseMs:1}),shiftRunPracticeInputs(e,{pauseMs:1}));
 assert.deepEqual(compactRunPracticeDecisions(reordered,{throughSeq:1}),compactRunPracticeDecisions(e,{throughSeq:1}));
 const unchanged=advanceRunPracticeInputs(reordered,reordered.serverTick).envelope;
 assert.equal(unchanged.integrity,e.integrity,'same logical envelope seals to identical canonical digest');
});

test('canonical history hash still rejects changed fields and reordered arrays',()=>{
 const e=apply(start(),[command(1,'right',1),command(2,'item',1)]).envelope;
 for(const mutate of [x=>x.current.players[0].distanceU++,x=>x.anchor.players[0].inventory='boost',x=>x.decisions[0].code='NO_ITEM',
  x=>x.clockEpoch++,x=>x.current.players.reverse(),x=>x.decisions.reverse(),x=>x.current.players[0].claimedItems.push('invented')]){
  const bad=copy(e);mutate(bad);assert.throws(()=>advanceRunPracticeInputs(bad,1),{code:'INVALID_HISTORY'});
 }
});
