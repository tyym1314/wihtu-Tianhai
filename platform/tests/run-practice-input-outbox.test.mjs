import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunPracticeInputOutbox, RUN_PRACTICE_OUTBOX_LIMITS as L} from '../arena/run/practice-input-outbox.mjs';

const scope=()=>({protocol:'run-practice-inputs-v1',ruleVersion:'pvp-run-v2.3.0',practice:true,entryMinor:'0',roomId:'room-a',playerKey:'human-a',clockEpoch:1,players:[{key:'human-a',isBot:false},{key:'bot-a',isBot:true}]});
const create=(options={})=>createRunPracticeInputOutbox({scope:scope(),makeRequestId:()=> 'request',...options});
const enqueue=(o,type='jump',executeTick=1)=>{const r=o.enqueue({type,executeTick});assert.equal(r.ok,true);return r.command;};
const begin=(o,baseRevision=0)=>{const r=o.beginBatch({baseRevision});assert.equal(r.ok,true);return r;};
// These are synthetic transport receipts, not evidence of physics legality.
function receipt(handle,{revision=1,inputNoBefore=0,denials={},prior=new Map(),bound=scope(),through=handle.payload.commands.at(-1).commandSeq}={}){
 let inputNo=inputNoBefore;
 const decisions=handle.payload.commands.map(c=>{
  if(prior.has(c.commandSeq))return {...prior.get(c.commandSeq),duplicate:true};
  const code=denials[c.commandSeq]??null;
  return {...c,clockEpoch:bound.clockEpoch,outcome:code?'rejected':'accepted',code,acceptedInputNo:code?null:++inputNo,
   decidedAtServerTick:Math.max(...handle.payload.commands.map(c=>c.executeTick)),revision,duplicate:false};
 });
 return {request_id:handle.requestId,run_inputs:{protocol:bound.protocol,ruleVersion:bound.ruleVersion,roomId:bound.roomId,playerKey:bound.playerKey,clockEpoch:bound.clockEpoch,revision,processedThroughCommandSeq:through,decisions}};
}
const resolve=(o,h,r=receipt(h))=>o.resolve({token:h.token,receipt:r});

test('only explicit V2.3 free BOT scopes; owned immutable scope and commands',()=>{
 for(const edit of [s=>s.protocol='old',s=>s.ruleVersion='pvp-run-v2.2.0',s=>s.practice=false,s=>s.entryMinor='1',s=>s.entryMinor=0,s=>s.clockEpoch=0,s=>s.playerKey='bot-a',s=>s.players[1].isBot=false,s=>s.players[1].key='human-a',s=>s.players=[]]){
  const s=scope();edit(s);assert.throws(()=>create({scope:s}),/INVALID_PRACTICE_SCOPE/);
 }
 const s=scope(),o=create({scope:s});s.players[0].key='mutated';s.clockEpoch=55;
 const command={type:'jump',executeTick:7},r=o.enqueue(command);command.executeTick=99;
 assert.deepEqual(r.command,{commandSeq:1,type:'jump',executeTick:7});
 assert.equal(o.state().scope.clockEpoch,1);assert.equal(o.state().scope.players[0].key,'human-a');
 const h=begin(o);assert.ok(Object.isFrozen(h)&&Object.isFrozen(h.payload.commands)&&Object.isFrozen(h.payload.commands[0]));
 assert.throws(()=>{h.payload.commands[0].executeTick=8;},TypeError);
});

test('500ms ACK latency does not serialize two gestures 120ms apart',()=>{
 const o=create(),events=[];
 // Time belongs to the caller: the outbox has no timer or lease to advance.
 events.push({at:0,command:enqueue(o,'right',1)});const a=begin(o);
 events.push({at:120,command:enqueue(o,'jump',8)});const b=begin(o);
 assert.equal(events.length,2);assert.deepEqual(events.map(e=>e.command.commandSeq),[1,2]);
 assert.deepEqual(b.payload.commands.map(c=>c.executeTick),[1,8]);assert.equal(o.state().inFlight,2);
 const second=receipt(b,{revision:2});assert.equal(resolve(o,b,second).ok,true); // 500ms, batch B beats A.
 const prior=new Map(second.run_inputs.decisions.map(d=>[d.commandSeq,d]));
 assert.equal(resolve(o,a,receipt(a,{revision:2,prior,through:2})).ok,true);
 assert.equal(o.state().pendingCommands.length,0);assert.equal(o.state().acceptedInputNo,2);
 assert.equal(o.state().inFlight,0);assert.equal(o.state().retainedDecisions,0);
});

test('explicit smaller batches preserve fixed commands without consuming rejected batch identities',()=>{
 const o=create();for(let i=0;i<8;i++)enqueue(o,'jump',1+i*60);
 for(const maxCommands of [0,9,1.5,NaN])assert.equal(o.beginBatch({baseRevision:0,maxCommands}).reason,'INVALID_BATCH_SIZE');
 const original=begin(o);o.release({token:original.token});o.retire({token:original.token});
 const first=o.beginBatch({baseRevision:0,maxCommands:4});assert.equal(first.ok,true);
 assert.notEqual(first.requestId,original.requestId);assert.deepEqual(first.payload.commands,original.payload.commands.slice(0,4));
 assert.equal(resolve(o,first).ok,true);
 const tail=o.beginBatch({baseRevision:1,maxCommands:4});assert.deepEqual(tail.payload.commands,original.payload.commands.slice(4));
 assert.equal(resolve(o,tail,receipt(tail,{revision:2,inputNoBefore:4})).ok,true);assert.equal(o.state().pendingCommands.length,0);
 assert.equal(resolve(o,original).reason,'RETIRED_TOKEN');
});

test('later overlapping response can contain an older duplicate decision revision',()=>{
 const o=create();enqueue(o,'right',1);const a=begin(o);enqueue(o,'jump',8);const b=begin(o);
 const ra=receipt(a,{revision:1});assert.equal(resolve(o,a,ra).ok,true);
 assert.equal(o.state().retainedDecisions,1);
 const prior=new Map(ra.run_inputs.decisions.map(d=>[d.commandSeq,d]));
 const rb=receipt(b,{revision:3,inputNoBefore:1,prior});
 assert.equal(resolve(o,b,rb).ok,true);assert.equal(o.state().revision,3);
 const old=resolve(o,a,ra);assert.equal(old.ok,true);assert.deepEqual(old.newlyAcknowledged,[]);
 assert.equal(o.state().revision,3);assert.equal(o.state().acceptedInputNo,2);
});

test('lost ACK retries the identical immutable request and late ACK consumes once',()=>{
 const o=create();enqueue(o);const a=begin(o),body=JSON.stringify(a.payload);
 assert.equal(o.release({token:a.token}).ok,true);const retry=o.retry({token:a.token});
 assert.equal(retry,a);assert.equal(retry.requestId,a.requestId);assert.equal(JSON.stringify(retry.payload),body);
 const r=receipt(a);assert.equal(resolve(o,a,r).newlyAcknowledged.length,1);
 assert.equal(resolve(o,a,r).newlyAcknowledged.length,0);assert.equal(o.state().inFlight,0);
 assert.equal(o.retry({token:a.token}).ok,false);
});

test('business rejection consumes commandSeq, successful engine inputNo remains independent',()=>{
 const o=create();enqueue(o,'jump',1);enqueue(o,'right',8);const a=begin(o);
 const r=receipt(a,{denials:{1:'BUSY'}}),result=resolve(o,a,r);
 assert.equal(result.ok,true);assert.equal(result.acceptedInputNo,1);assert.equal(result.processedThroughCommandSeq,2);
 assert.equal(enqueue(o,'slide',15).commandSeq,3);
});

test('oldest prefix is at most eight, ninth command retains its exact tick',()=>{
 const o=create();for(let i=1;i<=12;i++)enqueue(o,'jump',i*6);
 const a=begin(o);assert.deepEqual(a.payload.commands.map(c=>c.commandSeq),[1,2,3,4,5,6,7,8]);
 assert.equal(resolve(o,a).ok,true);const b=begin(o,1);
 assert.deepEqual(b.payload.commands.map(c=>c.commandSeq),[9,10,11,12]);assert.equal(b.payload.commands[0].executeTick,54);
 assert.equal(resolve(o,b,receipt(b,{revision:2,inputNoBefore:8})).ok,true);
});

test('malformed, missing, foreign and structural-error receipts are atomic non-ACKs',()=>{
 const mutations=[
  r=>r.request_id='foreign',r=>r.run_inputs.protocol='old',r=>r.run_inputs.ruleVersion='pvp-run-v2.2.0',
  r=>r.run_inputs.roomId='room-b',r=>r.run_inputs.playerKey='human-b',r=>r.run_inputs.clockEpoch=2,
  r=>r.run_inputs.decisions.pop(),r=>r.run_inputs.decisions.reverse(),r=>r.run_inputs.decisions.push(r.run_inputs.decisions[0]),
  r=>r.run_inputs.decisions[0].type='slide',r=>r.run_inputs.decisions[0].executeTick=2,r=>r.run_inputs.decisions[0].commandSeq=9,
  r=>r.run_inputs.decisions[0].clockEpoch=2,r=>r.run_inputs.decisions[0].acceptedInputNo=3,
  r=>r.run_inputs.decisions[0].code='BUSY',r=>r.run_inputs.decisions[0].outcome='unknown',
  r=>r.run_inputs.decisions[0].decidedAtServerTick=-1,r=>r.run_inputs.decisions[0].duplicate=1,
  r=>r.run_inputs.decisions[0].revision=2,r=>r.run_inputs.decisions[0].extra='untrusted',
  r=>r.run_inputs.processedThroughCommandSeq=1,r=>r.run_inputs.processedThroughCommandSeq=3,
  r=>r.run_inputs.revision=-1,r=>r.run_inputs.decisions[1].acceptedInputNo=1,
  r=>Object.assign(r.run_inputs.decisions[0],{outcome:'rejected',code:'DECISION_CAPACITY',acceptedInputNo:null}),
  r=>Object.assign(r.run_inputs.decisions[0],{outcome:'rejected',code:'COMMAND_SEQUENCE_GAP',acceptedInputNo:null}),
 ];
 for(const mutate of mutations){
  const o=create();enqueue(o,'right',1);enqueue(o,'jump',8);const h=begin(o),before=o.state(),r=receipt(h);mutate(r);
  assert.equal(resolve(o,h,r).ok,false);assert.deepEqual(o.state(),before);
 }
 const o=create();enqueue(o);const h=begin(o),bad={get run_inputs(){throw new Error('hostile');}};
 assert.equal(resolve(o,h,bad).ok,false);assert.equal(o.state().pendingCommands.length,1);
});

test('duplicate conflicts never retroactively rewrite a decision or clear new commands',()=>{
 const o=create();enqueue(o);const a=begin(o),r=receipt(a);assert.equal(resolve(o,a,r).ok,true);
 enqueue(o,'right',8);const before=o.state(),conflict=structuredClone(r);
 Object.assign(conflict.run_inputs.decisions[0],{outcome:'rejected',code:'BUSY',acceptedInputNo:null});
 assert.equal(resolve(o,a,conflict).ok,false);assert.deepEqual(o.state(),before);
 r.run_inputs.decisions[0].duplicate=true;assert.equal(resolve(o,a,r).ok,true);
 assert.equal(o.state().pendingCommands.length,1);
});

test('a trusted processed-through cursor alone cannot consume uncovered pending commands',()=>{
 const o=create();enqueue(o,'right',1);const a=begin(o);enqueue(o,'jump',8);
 const r=receipt(a,{through:2});assert.equal(resolve(o,a,r).ok,true);
 assert.equal(o.state().processedThroughCommandSeq,1);assert.equal(o.state().acceptedInputNo,1);
 assert.deepEqual(o.state().pendingCommands.map(c=>c.commandSeq),[2]);
 const b=begin(o,1),missing=receipt(b,{revision:2,inputNoBefore:1});missing.run_inputs.decisions=[];
 const before=o.state();assert.equal(resolve(o,b,missing).ok,false);assert.deepEqual(o.state(),before);
});

test('suspend stops new inputs and sends, but may acknowledge an already sent batch',()=>{
 const o=create();enqueue(o);const a=begin(o);o.suspend();
 assert.equal(o.enqueue({type:'jump',executeTick:8}).reason,'SUSPENDED');
 assert.equal(o.beginBatch({baseRevision:0}).reason,'SUSPENDED');
 assert.equal(resolve(o,a).ok,true);o.resume();assert.equal(enqueue(o,'right',8).commandSeq,2);
 assert.equal(o.state().dispatchAttempts,1);assert.equal(o.state().revision,1);
});

test('clear/exit and new scope cannot reuse old or cloned token capabilities',()=>{
 const o=create();enqueue(o);const a=begin(o),r=receipt(a);o.clear();
 assert.equal(resolve(o,a,r).reason,'CLOSED');assert.equal(o.resume().reason,'CLOSED');
 const nextScope=scope();nextScope.clockEpoch=2;
 const next=create({scope:nextScope});enqueue(next);const b=begin(next);
 assert.equal(next.resolve({token:a.token,receipt:r}).reason,'UNKNOWN_TOKEN');
 assert.equal(next.resolve({token:{},receipt:receipt(b,{bound:nextScope})}).reason,'UNKNOWN_TOKEN');
 assert.equal(resolve(next,b,r).ok,false);assert.equal(next.state().pendingCommands.length,1);
 assert.equal(o.state().retainedBatches,0);assert.equal(o.state().retainedDecisions,0);
});

test('pending, inflight, retry and unresolved-history bounds are explicit',()=>{
 const o=create();for(let i=0;i<L.pendingCommands;i++)enqueue(o,'jump',1+i);
 assert.equal(o.enqueue({type:'jump',executeTick:99}).reason,'PENDING_LIMIT');assert.equal(o.state().lastCommandSeq,32);
 const a=begin(o),b=begin(o);assert.equal(o.beginBatch({baseRevision:0}).reason,'IN_FLIGHT_LIMIT');
 assert.equal(o.retire({token:a.token}).reason,'NOT_RETIRABLE');
 o.release({token:a.token});o.release({token:b.token});
 for(let i=1;i<L.attemptsPerBatch;i++){assert.equal(o.retry({token:a.token}),a);o.release({token:a.token});}
 assert.equal(o.retry({token:a.token}).reason,'RETRY_LIMIT');
 for(let i=2;i<L.retainedBatches;i++){const h=begin(o);o.release({token:h.token});}
 assert.equal(o.beginBatch({baseRevision:0}).reason,'BATCH_LIMIT');
 assert.equal(o.state().retainedBatches,L.retainedBatches);assert.equal(o.state().pendingCommands.length,32);
 assert.equal(o.retire({token:a.token}).ok,true);assert.equal(resolve(o,a).reason,'RETIRED_TOKEN');
 assert.equal(begin(o).ok,true);
});

test('retiring a failed transport preserves commands for a new request identity',()=>{
 const o=create();enqueue(o);const a=begin(o);o.release({token:a.token});o.retire({token:a.token});
 const b=begin(o);assert.notEqual(a.requestId,b.requestId);assert.deepEqual(a.payload,b.payload);
 assert.equal(resolve(o,a).reason,'RETIRED_TOKEN');assert.equal(resolve(o,b).ok,true);
});

test('at least 1000 sequential acknowledgements keep strong retained records constant',()=>{
 const o=create();let first;
 for(let i=1;i<=1001;i++){
  enqueue(o,'jump',Math.min(6001,i*6));const h=begin(o,i-1);const r=receipt(h,{revision:i,inputNoBefore:i-1});
  if(i===1)first={h,r};assert.equal(resolve(o,h,r).ok,true);
  assert.equal(o.state().pendingCommands.length,0);assert.equal(o.state().retainedBatches,0);assert.equal(o.state().retainedDecisions,0);
 }
 assert.equal(o.state().lastCommandSeq,1001);assert.equal(o.state().acceptedInputNo,1001);
 // A caller retaining an old capability may validate its own exact duplicate;
 // it cannot roll back the cursor or reopen a send slot.
 assert.equal(resolve(o,first.h,first.r).ok,true);assert.equal(o.state().acceptedInputNo,1001);
 assert.equal(o.state().revision,1001);assert.equal(o.state().inFlight,0);
});

test('one old in-flight response retains only its referenced decision during 1000 later ACKs',()=>{
 const o=create();enqueue(o,'right',1);const old=begin(o),copy=begin(o),first=receipt(copy);
 assert.equal(resolve(o,copy,first).ok,true);
 assert.equal(o.state().inFlight,1);assert.equal(o.state().retainedDecisions,1);
 for(let i=2;i<=1001;i++){
  enqueue(o,'jump',Math.min(6001,i*6));const h=begin(o,i-1);
  assert.equal(resolve(o,h,receipt(h,{revision:i,inputNoBefore:i-1})).ok,true);
  assert.equal(o.state().retainedBatches,1);assert.equal(o.state().retainedDecisions,1);
 }
 const prior=new Map(first.run_inputs.decisions.map(d=>[d.commandSeq,d]));
 assert.equal(resolve(o,old,receipt(old,{prior})).ok,true);
 assert.equal(o.state().acceptedInputNo,1001);assert.equal(o.state().retainedDecisions,0);assert.equal(o.state().inFlight,0);
});

test('authority baselines above 128 resume independent sequence cursors',()=>{
 const o=create({initial:{lastCommandSeq:900,acceptedInputNo:410,revision:2000}});
 assert.equal(enqueue(o,'right',5000).commandSeq,901);const h=begin(o,2000);
 const r=receipt(h,{revision:2001,inputNoBefore:410});assert.equal(resolve(o,h,r).ok,true);
 assert.equal(o.state().processedThroughCommandSeq,901);assert.equal(o.state().acceptedInputNo,411);
 for(const initial of [{lastCommandSeq:2,acceptedInputNo:3,revision:0},{lastCommandSeq:-1,acceptedInputNo:0,revision:0},{lastCommandSeq:1.5,acceptedInputNo:0,revision:0}])assert.throws(()=>create({initial}),/INVALID_INITIAL_SEQUENCE/);
 const max=create({initial:{lastCommandSeq:Number.MAX_SAFE_INTEGER,acceptedInputNo:0,revision:0}});
 assert.equal(max.enqueue({type:'jump',executeTick:1}).reason,'SEQUENCE_EXHAUSTED');
});

test('invalid command, revision and ID factory failures do not consume sequence or sends',()=>{
 const o=create();for(const command of [{type:'boost',executeTick:1},{type:'jump',executeTick:1.2},{type:'jump',executeTick:0},{type:'jump',executeTick:6002},{type:'jump',executeTick:1,seq:7}])assert.equal(o.enqueue(command).ok,false);
 assert.equal(o.state().lastCommandSeq,0);enqueue(o);assert.equal(o.beginBatch({baseRevision:-1}).ok,false);
 assert.equal(o.state().dispatchAttempts,0);
 for(const makeRequestId of [()=>{throw new Error('rng');},()=>'',()=> 'x',()=> 'x'.repeat(97)]){
  const q=create({makeRequestId});enqueue(q);assert.equal(q.beginBatch({baseRevision:0}).ok,false);
  assert.equal(q.state().pendingCommands.length,1);assert.equal(q.state().retainedBatches,0);assert.equal(q.state().dispatchAttempts,0);
 }
});
