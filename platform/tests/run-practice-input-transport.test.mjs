import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../arena/run/engine.mjs';
import {createRunPracticeInputs,advanceRunPracticeInputs,applyRunPracticeInputs} from '../server/pvp/run-practice-inputs.mjs';
import {createRunPracticeController} from '../arena/run/practice-controller.mjs';
import {createRunPracticeTransport,RUN_PRACTICE_TRANSPORT_LIMITS as L} from '../arena/run/practice-input-transport.mjs';

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const fields=['key','distanceU','checkpointU','lane','fromLane','changeStartTick','changeEndTick','jumpStartTick','slideUntilTick','stunUntilTick','immuneUntilTick','fallStartTick','fallUntilTick','shieldUntilTick','boostUntilTick','inventory','claimedItems','resolvedObstacles','hits','inputNo','appliedInputNo','lastInputTick','pendingInput','finishTick','finishedAt','forfeited'];
function initial(){
 const state=engine.createState('0'.repeat(64),1000,{ruleVersion:engine.PRACTICE_INPUT_RULE_VERSION,startPolicy:engine.RUN_SCENE_READY_POLICY,players:[{key:'self',seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]});
 engine.armStart(state,1000);
 return createRunPracticeInputs({roomId:'room_test',playerKey:'self',practice:true,entryMinor:'0',clockEpoch:1,state}).envelope;
}
function to(e,tick){while(e.serverTick<tick)e=advanceRunPracticeInputs(e,Math.min(tick,e.serverTick+120)).envelope;return e;}
function room(e,{decisions=[],correction=null}={}){
 const authorized=e.current.status==='finished'&&e.current.tick<=e.committedThroughTick;
 const game=engine.view(e.current,'self');game.resultCommitted=authorized;if(!authorized)game.winnerKeys=[];
 return {id:'room_test',game_id:'run',practice:true,entry_minor:'0',status:authorized?'settled':'active',me:'self',version:e.revision+1,game,
  run_inputs:{protocol:e.protocol,ruleVersion:engine.PRACTICE_INPUT_RULE_VERSION,roomId:e.roomId,playerKey:e.playerKey,clockEpoch:e.clockEpoch,
   revision:e.revision,headTick:e.current.tick,serverTick:e.serverTick,committedThroughTick:e.committedThroughTick,processedThroughCommandSeq:e.lastCommandSeq,
   acceptedInputNo:e.current.players[0].inputNo,decisions:structuredClone(decisions),correction:structuredClone(correction),
   resultAuthorization:authorized?{key:`room_test/${e.clockEpoch}/${e.current.tick}`,clockEpoch:e.clockEpoch,terminalTick:e.current.tick,committedThroughTick:e.committedThroughTick,revision:e.revision}:null,
   selfReplay:{schema:'run-practice-self-replay-v1',anchorTick:e.anchor.tick,player:Object.fromEntries(fields.map(k=>[k,structuredClone(e.anchor.players[0][k])])),acceptedCommands:e.commands.map(({commandSeq,type,executeTick,acceptedInputNo})=>({commandSeq,type,executeTick,acceptedInputNo}))}}};
}
function clock(){
 let at=0,id=0;const timers=new Map();
 return {now:()=>at,setTimer:(fn,ms)=>{const n=++id;timers.set(n,{fn,at:at+ms});return n;},clearTimer:n=>timers.delete(n),count:()=>timers.size,
  set(value){assert.ok(value>=at);at=value;},
  async advance(ms,beforeTimer=()=>{}){const until=at+ms;let count=0;while(true){const next=[...timers.entries()].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>until)break;assert.ok(++count<100,'timer storm');at=next[1].at;timers.delete(next[0]);beforeTimer(at);next[1].fn();await flush();}at=until;await flush();}};
}
function setup(t,{clock:c=clock(),send:custom,onRoom}={}){
 let e=initial();const controller=createRunPracticeController({roomId:'room_test',playerKey:'self',clockEpoch:1,makeRequestId:()=> 'transport_request'});
 assert.equal(controller.receive({room:room(e),receivedAt:c.now()}).ok,true);
 const calls=[],errors=[],rooms=[];
 const send=custom??((handle,{signal})=>new Promise((resolve,reject)=>{calls.push({handle,signal,resolve,reject});}));
 const transport=createRunPracticeTransport({controller,send,onRoom:response=>{const pending=controller.state().outbox.pendingCommands;assert.ok(response.run_inputs.decisions.every(d=>!pending.some(c=>c.commandSeq===d.commandSeq)),'receipt resolves before onRoom');rooms.push(response);onRoom?.(response);},onError:error=>errors.push(error),now:c.now,setTimer:c.setTimer,clearTimer:c.clearTimer});
 t.after(async()=>{transport.close();for(const call of calls)call.reject(new Error('test cleanup'));await flush();controller.clear();});
 return {controller,transport,c,calls,errors,rooms,
  enqueue(type='right'){const q=controller.enqueue(type,c.now());assert.equal(q.ok,true,JSON.stringify(q));return q;},
  response(handle,tick=Math.floor(c.now()*.06),options){e=to(e,tick);const applied=applyRunPracticeInputs(e,handle.payload,tick,options);e=applied.envelope;return {...room(e,applied),request_id:handle.requestId};},
  get(tick=Math.floor(c.now()*.06)){e=to(e,tick);const r=room(e);assert.equal(controller.receive({room:r,receivedAt:c.now()}).ok,true);return r;},
  refreshBeforeTimer(at){e=to(e,Math.floor(at*.06));const got=controller.receive({room:room(e),receivedAt:at});assert.ok(got.ok||got.reason==='old-authority',JSON.stringify(got));},
 };
}
const error=(status,code,retryAfterMs)=>Object.assign(new Error(code??'network'),{...(status?{status}:{}),...(code?{code}:{}),...(retryAfterMs===undefined?{}:{retryAfterMs})});

test('exact immutable handle, bare server room, resolve-before-onRoom; ACK never renews controller budget',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();assert.equal(f.calls.length,1);
 const {handle}=f.calls[0];assert.ok(Object.isFrozen(handle)&&Object.isFrozen(handle.payload)&&Object.isFrozen(handle.payload.commands));
 f.c.set(500);const response=f.response(handle);f.calls[0].resolve(response);await flush();
 assert.equal(f.rooms[0],response);assert.equal(f.controller.state().firstReceivedAt,0);assert.equal(f.controller.state().hardDeadline,2000);
 assert.equal(f.controller.state().outbox.acceptedInputNo,1);assert.equal(f.transport.state().inFlight,0);assert.equal(f.c.count(),0);
});

test('covered pending prefix does not create duplicate flood; fresh command creates second overlapping prefix',async t=>{
 const f=setup(t);f.enqueue();for(let i=0;i<100;i++)f.transport.pump();await flush();assert.equal(f.calls.length,1);
 f.c.set(120);f.enqueue('jump');f.transport.pump();await flush();assert.equal(f.calls.length,2);
 assert.deepEqual(f.calls.map(c=>c.handle.payload.commands.map(v=>v.commandSeq)),[[1],[1,2]]);
 for(let i=0;i<100;i++)f.transport.pump();await flush();assert.equal(f.calls.length,2);assert.equal(f.controller.state().outbox.batchCount,2);
});

test('second overlapping real receipt wins; late original ACK is exact and never invents another command',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();f.c.set(120);f.enqueue('jump');f.transport.pump();await flush();
 f.c.set(750);const second=f.response(f.calls[1].handle);f.calls[1].resolve(second);await flush();assert.equal(f.controller.state().outbox.acceptedInputNo,2);
 const first=f.response(f.calls[0].handle);f.calls[0].resolve(first);await flush();
 assert.equal(f.rooms.length,2);assert.equal(f.errors.length,0);assert.equal(f.controller.state().outbox.batchCount,2);assert.equal(f.controller.state().firstReceivedAt,0);
});

test('lost ACK then GET does not acknowledge; automatic retry uses identical original handle/id/body',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();const first=f.calls[0],body=JSON.stringify(first.handle.payload);
 f.c.set(500);const response=f.response(first.handle);f.get(31);f.transport.pump();await flush();assert.equal(f.controller.state().outbox.pendingCommands.length,1);assert.equal(f.calls.length,1);
 first.reject(new TypeError('connection lost'));await flush();await f.c.advance(249);assert.equal(f.calls.length,1);await f.c.advance(1);assert.equal(f.calls.length,2);
 assert.equal(f.calls[1].handle,first.handle);assert.equal(JSON.stringify(f.calls[1].handle.payload),body);
 f.calls[1].resolve(response);await flush();assert.equal(f.rooms.length,1);assert.equal(f.controller.state().firstReceivedAt,500);assert.equal(f.controller.state().outbox.batchCount,1);
});

test('suspend cancels owned timers/fetch, discards late ACK and resume does not renew controller lease',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();const old=f.calls[0],reply=f.response(old.handle);
 f.controller.suspend();f.transport.suspend();assert.equal(f.c.count(),0);assert.equal(old.signal.reason.message,'OASIS_RUN_PRACTICE_BACKGROUND');
 f.c.set(500);f.controller.resume();f.transport.resume();await flush();assert.equal(f.calls.length,1);
 old.resolve(reply);await flush();assert.equal(f.rooms.length,0);assert.equal(f.controller.state().outbox.pendingCommands.length,1);assert.equal(f.calls.length,1);
 f.get(30);f.transport.pump();await flush();assert.equal(f.calls.length,2);assert.equal(f.calls[1].handle,old.handle);
 f.calls[1].resolve(reply);await flush();assert.equal(f.rooms.length,1);assert.equal(f.controller.state().firstReceivedAt,500);
});

test('close discards late receipts and abort-ignoring old sends keep the global two physical slots',async t=>{
 const a=setup(t);a.enqueue();a.transport.pump();await flush();a.c.set(120);a.enqueue('jump');a.transport.pump();await flush();assert.equal(a.calls.length,2);
 const late=a.response(a.calls[1].handle,8);a.transport.close();assert.equal(a.c.count(),0);assert.equal(a.transport.state().inFlight,2);
 const b=setup(t);b.enqueue();b.transport.pump();await flush();assert.equal(b.calls.length,0);
 a.calls[0].reject(new Error('old settled'));await flush();assert.equal(b.calls.length,1);assert.equal(a.rooms.length,0);
 a.calls[1].resolve(late);await flush();assert.equal(a.rooms.length,0);assert.equal(a.controller.state().outbox.pendingCommands.length,2);assert.equal(a.transport.state().inFlight,0);
});

test('429 preserves Retry-After for all sends across hide/resume, including newly queued commands',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();f.calls[0].reject(error(429,'RATE_LIMIT',900));await flush();
 f.c.set(120);f.enqueue('jump');f.transport.pump();await flush();assert.equal(f.calls.length,1);
 f.transport.suspend();assert.equal(f.c.count(),0);f.transport.resume();await f.c.advance(779);assert.equal(f.calls.length,1);await f.c.advance(1);assert.equal(f.calls.length,3);
 assert.equal(f.calls[1].handle,f.calls[0].handle);assert.equal(f.calls[2].handle.payload.commands.length,2);assert.equal(f.transport.state().maxInFlight,2);
});

for(const [status,code] of [[422,'UNRECOGNIZED_UNPROCESSABLE_BATCH'],[409,'STALE_CLOCK_EPOCH'],[409,'COMMAND_CONFLICT'],[401,'UNAUTHORIZED'],[403,'FORBIDDEN'],[400,'INVALID_BATCH']])test(`${status}/${code} stops automatic retry without minting replacement request IDs`,async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();f.calls[0].reject(error(status,code));await flush();
 await f.c.advance(1000);f.transport.pump();await flush();assert.equal(f.calls.length,1);assert.equal(f.transport.state().blocked,code);assert.equal(f.c.count(),0);assert.equal(f.controller.state().outbox.batchCount,1);
 assert.equal(f.controller.state().outbox.pendingCommands.length,1);assert.equal(f.errors.at(-1).code,code);
});

test('manual retry after a definite rejection preserves original capability/id/payload',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();const first=f.calls[0].handle;
 f.calls[0].reject(error(422,'UNRECOGNIZED_UNPROCESSABLE_BATCH'));await flush();assert.equal(f.transport.retry().ok,true);await flush();assert.equal(f.calls[1].handle,first);assert.equal(f.controller.state().outbox.batchCount,1);
});

for(const [status,code] of [[401,'UNAUTHORIZED'],[undefined,'SESSION_CHANGED']])test(`${code}: verified same-owner reauthorization can explicitly retry the exact retained request`,async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();const first=f.calls[0].handle,body=JSON.stringify(first.payload);
 f.calls[0].reject(error(status,code));await flush();assert.equal(f.transport.state().blocked,code);assert.equal(f.errors.at(-1).transport.stopped,true);
 // A new authorization object is an external verified event. The transport
 // keeps this controller and its sequence; ordinary pumping cannot authorize it.
 f.transport.pump();await flush();assert.equal(f.calls.length,1);assert.deepEqual(f.transport.retry(),{ok:true});await flush();
 assert.equal(f.transport.state().blocked,null);assert.equal(f.calls[1].handle,first);assert.equal(JSON.stringify(f.calls[1].handle.payload),body);
 assert.equal(f.controller.state().outbox.batchCount,1);assert.equal(f.controller.state().outbox.pendingCommands[0].commandSeq,1);
 const response=f.response(first);f.calls[1].resolve(response);await flush();assert.equal(f.rooms[0],response);assert.equal(f.controller.state().outbox.pendingCommands.length,0);
 assert.equal(f.errors.length,1,'success is delivered via onRoom, not a new onError');assert.equal(f.controller.state().firstReceivedAt,0);
});

test('repeated explicit authorization refresh cannot exceed eight attempts or reset the original request identity',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();const first=f.calls[0].handle;
 for(let i=0;i<8;i++){
  assert.equal(f.calls[i].handle,first);f.calls[i].reject(error(401,'UNAUTHORIZED'));await flush();
  const retried=f.transport.retry();assert.deepEqual(retried,i<7?{ok:true}:{ok:false,reason:'UNAUTHORIZED'});await flush();
 }
 assert.equal(f.transport.state().blocked,'UNAUTHORIZED');assert.equal(f.errors.at(-1).transport.attempt,8);
 assert.equal(f.calls.length,8);assert.equal(f.controller.state().outbox.dispatchAttempts,8);assert.equal(f.controller.state().outbox.batchCount,1);assert.equal(f.c.count(),0);
});

test('real core work-budget rejection shrinks 8/4/2/1 then exact prefix ACKs drain unchanged commands',async t=>{
 const f=setup(t);for(let i=0;i<8;i++){f.c.set(i*220);f.enqueue(i%2?'left':'right');}
 const commands=structuredClone(f.controller.state().outbox.pendingCommands);f.transport.pump();await flush();
 for(const [i,size] of [8,4,2].entries()){
  const handle=f.calls[i].handle;assert.equal(handle.payload.commands.length,size);assert.deepEqual(handle.payload.commands,commands.slice(0,size));
  let failure;try{f.response(handle,92,{maxWorkTicks:0});}catch(e){failure=e;}
  assert.equal(failure?.code,'WORK_BUDGET_EXCEEDED');failure.status=422;f.calls[i].reject(failure);await flush();
  assert.equal(f.controller.state().outbox.pendingCommands.length,8);assert.notEqual(f.calls[i+1].handle.requestId,handle.requestId);
 }
 assert.equal(f.transport.state().batchCommands,1);assert.equal(f.transport.state().batchReductions,3);
 for(let i=0;i<8;i++){
  const handle=f.calls[i+3].handle;assert.deepEqual(handle.payload.commands,[commands[i]]);f.calls[i+3].resolve(f.response(handle,92));await flush();
  assert.equal(f.controller.state().outbox.pendingCommands.length,7-i);
 }
 assert.equal(f.rooms.length,8);assert.equal(f.calls.length,11);assert.equal(f.transport.state().blocked,null);
 assert.equal(f.controller.state().outbox.processedThroughCommandSeq,8);assert.equal(f.controller.state().firstReceivedAt,0);assert.equal(f.c.count(),0);
});

test('one-command work-budget rejection stops automatically and manual retries retain its capped token',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();const first=f.calls[0].handle;
 for(let i=0;i<8;i++){
  f.calls[i].reject(error(422,'WORK_BUDGET_EXCEEDED'));await flush();f.transport.pump();await flush();assert.equal(f.calls.length,i+1);
  assert.equal(f.calls[i].handle,first);assert.equal(f.transport.state().blocked,i===7?'RETRY_LIMIT':'WORK_BUDGET_EXCEEDED');
  assert.deepEqual(f.transport.retry(),i<7?{ok:true}:{ok:false,reason:'RETRY_LIMIT'});await flush();
 }
 assert.equal(f.transport.state().batchReductions,0);assert.equal(f.controller.state().outbox.batchCount,1);assert.equal(f.calls.length,8);
});

test('shrunk batch network failure retries its exact token and does not shrink again',async t=>{
 const f=setup(t);f.enqueue();f.c.set(220);f.enqueue('left');f.transport.pump();await flush();
 f.calls[0].reject(error(422,'WORK_BUDGET_EXCEEDED'));await flush();const smaller=f.calls[1].handle;assert.equal(smaller.payload.commands.length,1);
 f.calls[1].reject(new TypeError('network lost'));await flush();await f.c.advance(250);
 assert.equal(f.calls[2].handle,smaller);assert.equal(f.transport.state().batchCommands,1);assert.equal(f.transport.state().batchReductions,1);
 assert.equal(f.controller.state().outbox.batchCount,2);
});

test('a work-budget error on the eighth network attempt cannot create a fresh request to escape the cap',async t=>{
 const f=setup(t);f.enqueue();f.c.set(220);f.enqueue('left');f.transport.pump();await flush();const first=f.calls[0].handle;
 for(let i=0;i<7;i++){
  f.calls[i].reject(new TypeError('offline'));await flush();await f.c.advance(Math.min(L.retryMaxMs,L.retryBaseMs*2**i),at=>f.refreshBeforeTimer(at));
 }
 assert.equal(f.calls[7].handle,first);f.calls[7].reject(error(422,'WORK_BUDGET_EXCEEDED'));await flush();
 assert.equal(f.transport.state().blocked,'RETRY_LIMIT');assert.equal(f.transport.retry().reason,'RETRY_LIMIT');
 assert.equal(f.calls.length,8);assert.equal(f.transport.state().batchReductions,0);assert.equal(f.controller.state().outbox.batchCount,1);
});

test('late oversized overlapping work-budget errors cannot enlarge the already reduced scope ceiling',async t=>{
 const f=setup(t);f.enqueue();f.c.set(220);f.enqueue('left');f.transport.pump();await flush();
 f.c.set(440);f.enqueue('right');f.transport.pump();await flush();assert.deepEqual(f.calls.map(c=>c.handle.payload.commands.length),[2,3]);
 f.calls[0].reject(error(422,'WORK_BUDGET_EXCEEDED'));await flush();assert.equal(f.calls.length,2);assert.equal(f.transport.state().batchCommands,1);
 f.calls[1].reject(error(422,'WORK_BUDGET_EXCEEDED'));await flush();assert.equal(f.calls.length,3);assert.equal(f.calls[2].handle.payload.commands.length,1);
 assert.equal(f.transport.state().batchCommands,1);assert.equal(f.transport.state().batchReductions,1);assert.equal(f.transport.state().maxInFlight,2);
});

test('BASE_REVISION_EXPIRED retires only its token and waits for a genuinely new accepted revision',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();const first=f.calls[0].handle;
 f.c.set(2200);f.get(132);f.calls[0].reject(error(409,'BASE_REVISION_EXPIRED'));await flush();for(let i=0;i<10;i++)f.transport.pump();await flush();assert.equal(f.calls.length,1);
 f.c.set(2250);f.get(135);f.transport.pump();await flush();assert.equal(f.calls.length,2);const next=f.calls[1].handle;
 assert.notEqual(next.requestId,first.requestId);assert.deepEqual(next.payload.commands,first.payload.commands);assert.ok(next.payload.baseRevision>first.payload.baseRevision);
 const answer=f.response(next,135);assert.equal(answer.run_inputs.decisions[0].code,'INPUT_EXPIRED');f.calls[1].resolve(answer);await flush();assert.equal(f.rooms.length,1);
});

test('malformed or GET-shaped response never resolves and is not delivered as a POST ACK',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();const raw=room(initial());f.calls[0].resolve(raw);await flush();
 assert.equal(f.rooms.length,0);assert.equal(f.controller.state().outbox.pendingCommands.length,1);assert.equal(f.transport.state().blocked,'INVALID_RECEIPT');assert.equal(f.calls.length,1);
});

test('eight total failed attempts stop; pump/manual retry cannot reset limit or manufacture new IDs',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();
 for(let i=0;i<8;i++){
  assert.equal(f.calls.length,i+1);f.calls[i].reject(new TypeError('lost'));await flush();
  if(i<7)await f.c.advance(Math.min(L.retryMaxMs,L.retryBaseMs*2**i),at=>f.refreshBeforeTimer(at));
 }
 assert.equal(f.transport.state().blocked,'RETRY_LIMIT');assert.equal(f.errors.at(-1).code,'RETRY_LIMIT');assert.equal(f.controller.state().outbox.dispatchAttempts,8);assert.equal(f.controller.state().outbox.batchCount,1);
 for(let i=0;i<10;i++){f.transport.pump();assert.equal(f.transport.retry().reason,'RETRY_LIMIT');}await flush();assert.equal(f.calls.length,8);assert.equal(f.c.count(),0);
});

test('even repeated structural rejections cannot create unlimited replacement IDs',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();
 for(let i=0;i<8;i++){
  f.calls[i].reject(error(409,'UNKNOWN_BASE_REVISION'));await flush();
  if(i<7){f.c.set((i+1)*250);f.get();f.transport.pump();await flush();}
 }
 assert.equal(f.calls.length,8);assert.equal(f.transport.state().blocked,'REBASE_LIMIT');assert.equal(f.transport.retry().reason,'REBASE_LIMIT');
 assert.equal(f.controller.state().outbox.pendingCommands.length,1);assert.equal(f.controller.state().outbox.batchCount,8);
});

test('synchronous send throw schedules bounded retry instead of recursive flooding',async t=>{
 let sends=0;const f=setup(t,{send(){sends++;throw new TypeError('offline');}});f.enqueue();f.transport.pump();await flush();
 assert.equal(sends,1);assert.equal(f.transport.state().inFlight,0);assert.equal(f.c.count(),1);await f.c.advance(250);assert.equal(sends,2);assert.equal(f.c.count(),1);
});

test('provisional expiry blocks retry until external controller GET, not transport resume',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();f.c.set(1900);f.calls[0].reject(new TypeError('offline'));await flush();await f.c.advance(250);
 assert.equal(f.calls.length,1);assert.equal(f.c.count(),0);assert.equal(f.controller.state().firstReceivedAt,0);
 f.transport.suspend();f.transport.resume();await flush();assert.equal(f.calls.length,1);
 f.get(129);f.transport.pump();await flush();assert.equal(f.calls.length,2);assert.equal(f.calls[1].handle,f.calls[0].handle);
});

test('throwing observers cannot resend a resolved POST or leak the physical slot',async t=>{
 const f=setup(t,{onRoom(){throw new Error('UI failed');}});f.enqueue();f.transport.pump();await flush();f.calls[0].resolve(f.response(f.calls[0].handle));await flush();
 assert.equal(f.calls.length,1);assert.equal(f.transport.state().inFlight,0);assert.equal(f.controller.state().outbox.pendingCommands.length,0);assert.equal(f.errors.at(-1).code,'RUN_PRACTICE_ROOM_CALLBACK_FAILED');
});

test('invalid Retry-After is a visible stop, never a zero-delay retry storm',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();f.calls[0].reject(error(429,'RATE_LIMIT',Infinity));await flush();
 assert.equal(f.transport.state().blocked,'INVALID_RETRY_AFTER');assert.equal(f.c.count(),0);assert.equal(f.calls.length,1);
});

test('12s timeout aborts owned send; ignoring abort retains the slot until real settlement',async t=>{
 const f=setup(t);f.enqueue();f.transport.pump();await flush();await f.c.advance(L.timeoutMs);
 assert.equal(f.calls[0].signal.reason.name,'TimeoutError');assert.equal(f.transport.state().inFlight,1);assert.equal(f.calls.length,1);
 f.calls[0].reject(f.calls[0].signal.reason);await flush();assert.equal(f.transport.state().inFlight,0);assert.equal(f.controller.state().outbox.pendingCommands.length,1);
});
