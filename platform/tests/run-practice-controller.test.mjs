import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import * as engine from '../arena/run/engine.mjs';
import {createRunPracticeInputs,advanceRunPracticeInputs,applyRunPracticeInputs,compactRunPracticeDecisions} from '../server/pvp/run-practice-inputs.mjs';
import {createRunPracticeController,RUN_PRACTICE_CONTROLLER_LIMITS as L} from '../arena/run/practice-controller.mjs';

const fields=['key','distanceU','checkpointU','lane','fromLane','changeStartTick','changeEndTick','jumpStartTick','slideUntilTick','stunUntilTick','immuneUntilTick','fallStartTick','fallUntilTick','shieldUntilTick','boostUntilTick','inventory','claimedItems','resolvedObstacles','hits','inputNo','appliedInputNo','lastInputTick','pendingInput','finishTick','finishedAt','forfeited'];
const copy=structuredClone;
const owned=p=>Object.fromEntries(fields.map(k=>[k,copy(p[k])]));
const freeze=o=>{if(o&&typeof o==='object'){Object.values(o).forEach(freeze);Object.freeze(o);}return o;};
function start(index=0){
 const state=engine.createState(index.toString(16).padStart(8,'0').padEnd(64,'0'),1000,{ruleVersion:engine.PRACTICE_INPUT_RULE_VERSION,startPolicy:engine.RUN_SCENE_READY_POLICY,
  players:[{key:'self',seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]});
 engine.armStart(state,1000);
 return createRunPracticeInputs({roomId:'room_test',playerKey:'self',practice:true,entryMinor:'0',clockEpoch:1,state}).envelope;
}
function to(e,tick){while(e.serverTick<tick)e=advanceRunPracticeInputs(e,Math.min(tick,e.serverTick+120)).envelope;return e;}
function publicRoom(e,{decisions=[],correction=null}={}){
 const p=e.current.players[0],authorized=e.current.status==='finished'&&e.current.tick<=e.committedThroughTick;
 const resultAuthorization=authorized?{key:`room_test/${e.clockEpoch}/${e.current.tick}`,clockEpoch:e.clockEpoch,terminalTick:e.current.tick,committedThroughTick:e.committedThroughTick,revision:e.revision}:null;
 const game=engine.view(e.current,'self');game.resultCommitted=authorized;if(!authorized)game.winnerKeys=[];
 return {id:'room_test',game_id:'run',practice:true,entry_minor:'0',status:authorized?'settled':'active',me:'self',version:e.revision+1,game,
  run_inputs:{protocol:e.protocol,ruleVersion:engine.PRACTICE_INPUT_RULE_VERSION,roomId:e.roomId,playerKey:e.playerKey,clockEpoch:e.clockEpoch,
   revision:e.revision,headTick:e.current.tick,serverTick:e.serverTick,committedThroughTick:e.committedThroughTick,processedThroughCommandSeq:e.lastCommandSeq,
   acceptedInputNo:p.inputNo,decisions:copy(decisions),correction:copy(correction),resultAuthorization,
   selfReplay:{schema:'run-practice-self-replay-v1',anchorTick:e.anchor.tick,player:owned(e.anchor.players[0]),acceptedCommands:e.commands.map(({commandSeq,type,executeTick,acceptedInputNo})=>({commandSeq,type,executeTick,acceptedInputNo}))}}};
}
const controller=(overrides={})=>createRunPracticeController({roomId:'room_test',playerKey:'self',clockEpoch:1,makeRequestId:()=> 'practice_request',...overrides});
function ready(e=start(),at=0){const m=controller(),r=publicRoom(e);assert.equal(m.receive({room:freeze(r),receivedAt:at}).ok,true);return m;}
function action(m,type,at){const result=m.enqueue(type,at);assert.equal(result.ok,true,JSON.stringify(result));return result.command;}
function batch(m,at){const handle=m.transport.beginBatch(at);assert.equal(handle.ok,true,JSON.stringify(handle));return handle;}
function apply(e,h,tick=e.serverTick){return applyRunPracticeInputs(e,h.payload,tick);}
function acknowledge(m,h,result,now){
 return m.transport.resolve({token:h.token,receipt:{request_id:h.requestId,run_inputs:publicRoom(result.envelope,result).run_inputs},now});
}

test('six actual courses: canonical own states equal the engine at every first 120 ticks',()=>{
 for(let course=0;course<6;course++){
  const e=start(course),m=ready(e),reference=copy(e.current);
  for(let tick=0;tick<=120;tick++){
   if(tick)engine.testing.step(reference);
   const {tick:actualTick,...actual}=m.stateAtTick(tick);assert.equal(actualTick,tick);assert.deepEqual(actual,owned(reference.players[0]),`course ${course}, tick ${tick}`);
  }
 }
});

test('119/120/121 ticks and 1999/2000ms enforce the independent hard provisional budget',()=>{
 const m=ready(),t119=m.sample(119*1000/60);
 assert.equal(t119.mode,'provisional');assert.equal(t119.provisionalTick,119);assert.equal(t119.authorityExpired,true);
 const t1999=m.sample(1999);assert.equal(t1999.mode,'provisional');
 const t120=m.sample(2000);assert.equal(t120.mode,'hold');assert.equal(t120.reason,'provisional-budget-expired');assert.equal(t120.provisionalTick,120);
 assert.equal(t120.pose.visualSpeed,0);assert.deepEqual(m.sample(121*1000/60).pose,t120.pose);assert.deepEqual(m.sample(9000).pose,t120.pose);
 assert.equal(m.enqueue('jump',9000).reason,'provisional-budget-expired');
 const before=ready();assert.equal(before.sample(649).authorityExpired,false);assert.equal(before.sample(650).authorityExpired,true);assert.equal(before.sample(750).mode,'provisional');
});

test('local lane and jump gestures are admitted immediately without authority input numbers',()=>{
 const m=ready();assert.equal(action(m,'right',0).executeTick,1);const a=batch(m,0);
 assert.equal(action(m,'jump',120).executeTick,8);const b=batch(m,120);
 assert.equal(m.state().outbox.acceptedInputNo,0);assert.equal(m.state().outbox.pendingCommands.length,2);
 assert.equal(m.stateAtTick(20).inputNo,2,'private predicted counter, not a receipt');
 assert.equal(m.sample(500).mode,'provisional');assert.notEqual(m.sample(501).pose.x,0);
 assert.equal(a.payload.commands.length,1);assert.equal(b.payload.commands.length,2);
 assert.equal(m.enqueue('slide',501).reason,'AIRBORNE');assert.equal(m.state().outbox.lastCommandSeq,2);
});

for(const delay of [500,750,1000])test(`${delay}ms delay: second overlapping batch response wins, exact ACKs do not renew authority`,()=>{
 let e=start();const m=ready(e);action(m,'right',0);const a=batch(m,0);action(m,'jump',120);const b=batch(m,120);
 m.sample(delay);e=to(e,Math.round(delay*.06));const result=apply(e,b);e=result.envelope;
 assert.equal(acknowledge(m,b,result,delay).ok,true);assert.equal(m.state().firstReceivedAt,0);assert.equal(m.state().hardDeadline,2000);
 assert.equal(m.state().outbox.acceptedInputNo,2);assert.equal(m.receive({room:publicRoom(e,result),receivedAt:delay}).ok,true);
 const firstSeen=m.state().firstReceivedAt,older=apply(e,a);
 assert.equal(acknowledge(m,a,older,delay+50).ok,true);assert.equal(m.state().firstReceivedAt,firstSeen);
 assert.equal(m.state().outbox.pendingCommands.length,0);assert.equal(m.state().outbox.acceptedInputNo,2);
 assert.deepEqual(b.payload.commands.map(c=>c.executeTick),[1,8]);assert.equal(m.sample(delay+100).mode,'provisional');
});

test('GET before lost ACK uses the accepted replay tail but does not acknowledge the outbox',()=>{
 let e=start();const m=ready(e);action(m,'right',0);const h=batch(m,0);e=to(e,45);const result=apply(e,h);e=result.envelope;
 assert.equal(m.receive({room:publicRoom(e),receivedAt:750}).ok,true);
 assert.equal(m.state().outbox.pendingCommands.length,1);assert.equal(m.state().outbox.acceptedInputNo,0);
 assert.equal(m.stateAtTick(60).inputNo,1);assert.equal(m.sample(800).mode,'provisional');
 m.transport.release({token:h.token});assert.equal(m.transport.retry({token:h.token,now:800}),h);
 assert.equal(acknowledge(m,h,result,850).ok,true);assert.equal(m.state().firstReceivedAt,750);assert.equal(m.state().outbox.acceptedInputNo,1);
});

test('same-head higher revision may correct a rejected local action without renewing either budget',()=>{
 const e=start(),m=ready(e);m.sample(500);action(m,'right',500);const h=batch(m,500);const before=m.sample(800);
 // Real core decision: this fixed executeTick is in the future of the server
 // state used here. This tests correction mechanics, not a network A/B claim.
 const rejected=apply(e,h);assert.equal(rejected.decisions[0].code,'FUTURE_INPUT');
 assert.equal(acknowledge(m,h,rejected,800).ok,true);const corrected=m.sample(800);
 assert.notEqual(corrected.pose.x,before.pose.x);assert.equal(corrected.correction.cause,'input-receipt');
 assert.equal(corrected.authorityExpired,true);assert.equal(m.state().outbox.acceptedInputNo,0);
 assert.equal(m.receive({room:publicRoom(rejected.envelope,rejected),receivedAt:900}).ok,true);
 assert.equal(m.state().firstReceivedAt,0);assert.equal(m.state().hardDeadline,2000);assert.equal(m.sample(2000).mode,'hold');
});

test('new head does not erase an unacknowledged input executed before that head',()=>{
 let e=start(2);e=to(e,240);const m=ready(e);action(m,'jump',0);const h=batch(m,0);
 const local=m.stateAtTick(258);assert.equal(local.fallUntilTick,null);
 e=to(e,258);assert.notEqual(e.current.players[0].fallUntilTick,null);
 const received=m.receive({room:publicRoom(e),receivedAt:300});assert.equal(received.ok,true,JSON.stringify(received));
 assert.equal(m.stateAtTick(258).fallUntilTick,null,'replay from committed anchor retains the earlier local jump');
 assert.equal(m.state().outbox.pendingCommands.length,1);assert.equal(m.state().outbox.acceptedInputNo,0);
 const accepted=apply(e,h);assert.equal(accepted.decisions[0].outcome,'accepted');
 assert.equal(acknowledge(m,h,accepted,400).ok,true);assert.equal(m.receive({room:publicRoom(accepted.envelope,accepted),receivedAt:400}).ok,true);
 assert.equal(m.state().firstReceivedAt,300,'same tick correction does not renew');
});

test('processed-but-missing outcome holds until the exact rejected receipt arrives',()=>{
 const e=start(),m=ready(e);m.sample(500);action(m,'right',500);const h=batch(m,500);m.sample(800);
 const rejected=apply(e,h);assert.equal(m.receive({room:publicRoom(rejected.envelope),receivedAt:800}).ok,true);
 assert.equal(m.sample(800).reason,'processed-outcome-unknown');assert.equal(m.state().outbox.pendingCommands.length,1);
 assert.equal(m.enqueue('jump',800).reason,'processed-outcome-unknown');
 assert.equal(acknowledge(m,h,rejected,850).ok,true);assert.equal(m.sample(850).mode,'provisional');
 assert.equal(m.state().outbox.pendingCommands.length,0);assert.equal(m.state().hardDeadline,2000);
});

test('room, epoch, mapping, revision and clear isolate authority and opaque old tokens',()=>{
 const e=start(),m=ready(e);action(m,'right',0);const h=batch(m,0),before=m.state();
 const other=publicRoom(e);other.id='other_room';other.run_inputs.roomId='other_room';
 assert.equal(m.receive({room:other,receivedAt:10}).reason,'scope-mismatch');assert.deepEqual(m.state(),before);
 assert.equal(m.receive({room:publicRoom(e),receivedAt:20}).reason,'old-authority');
 const anotherCourse=publicRoom(start(1));anotherCourse.run_inputs.revision=1;anotherCourse.version=2;
 assert.equal(m.receive({room:anotherCourse,receivedAt:30}).reason,'mapping-mismatch');
 const epoch=publicRoom(e);epoch.run_inputs.clockEpoch=2;
 assert.equal(m.receive({room:epoch,receivedAt:40}).reason,'epoch-mismatch');assert.equal(m.sample(50).reason,'epoch-mismatch');
 assert.equal(acknowledge(m,h,apply(e,h),60).ok,false);
 const fresh=controller();assert.equal(fresh.receive({room:publicRoom(e),receivedAt:0}).ok,true);
 assert.equal(fresh.transport.resolve({token:h.token,receipt:{},now:1}).reason,'UNKNOWN_TOKEN');
 fresh.clear();assert.equal(fresh.receive({room:publicRoom(e),receivedAt:100}).reason,'closed');assert.equal(fresh.sample(100).pose,null);
});

test('hidden/resume and same-head publications cannot grant a new lease',()=>{
 let e=start();const m=ready(e);const pose=m.sample(200).pose;m.suspend();assert.deepEqual(m.sample(500).pose,{...pose,visualSpeed:0});
 e=to(e,15);assert.equal(m.receive({room:publicRoom(e),receivedAt:500}).ok,true);m.resume();
 assert.equal(m.sample(510).reason,'awaiting-new-head');assert.equal(m.enqueue('jump',510).ok,false);
 const sameHead=publicRoom(e);sameHead.run_inputs.revision++;sameHead.version++;
 assert.equal(m.receive({room:sameHead,receivedAt:600}).ok,true);assert.equal(m.sample(601).reason,'awaiting-new-head');
 e=to(e,30);e=to(e,31);assert.equal(m.receive({room:publicRoom(e),receivedAt:700}).ok,true);
 assert.equal(m.sample(710).mode,'provisional');assert.equal(m.state().firstReceivedAt,700);
});

test('strict head progress renews wall freshness but never removes the 120-tick bound',()=>{
 let e=start();const m=ready(e);m.sample(1900);e=to(e,1);
 assert.equal(m.receive({room:publicRoom(e),receivedAt:1900}).ok,true);assert.equal(m.state().hardDeadline,3900);
 assert.equal(m.sample(2000).mode,'provisional');assert.equal(m.sample(121*1000/60).reason,'provisional-budget-expired');
 assert.equal(m.sample(3000).provisionalTick,121);assert.equal(m.sample(3000).authorityExpired,true);
 assert.equal(m.enqueue('jump',3000).reason,'provisional-budget-expired');
});

test('corrupt replay proofs and clocks cannot replace or renew a verified authority base',()=>{
 const e=to(start(),120),next=publicRoom(to(e,132)),m=ready(e);m.sample(100);
 const mutations=[
  r=>delete r.run_inputs.selfReplay,
  r=>r.run_inputs.selfReplay.player.distanceU++,
  r=>r.run_inputs.selfReplay.player.resolvedObstacles.push('not_an_obstacle'),
  r=>r.run_inputs.selfReplay.anchorTick=0,
  r=>r.run_inputs.selfReplay.acceptedCommands.push({commandSeq:1,type:'jump',executeTick:13,acceptedInputNo:1}),
  r=>r.game.serverNow++,r=>r.game.deadlineAt++,r=>r.run_inputs.headTick++,
  r=>r.run_inputs.acceptedInputNo++,r=>r.game.players[0].isBot=true,
 ];
 for(const mutate of mutations){const malformed=copy(next);mutate(malformed);const before=m.state();
  assert.equal(m.receive({room:freeze(malformed),receivedAt:500}).ok,false);assert.deepEqual(m.state(),before);
 }
 assert.equal(m.sample(2000).reason,'provisional-budget-expired');
});

test('past-watermark unacknowledged commands expire explicitly without being rewritten or acknowledged',()=>{
 let e=start();const m=ready(e);action(m,'right',0);const h=batch(m,0);m.sample(500);e=to(e,132);
 assert.equal(m.receive({room:publicRoom(e),receivedAt:1000}).ok,true);
 assert.equal(m.sample(1000).reason,'input-expired');assert.equal(m.state().outbox.pendingCommands[0].executeTick,1);
 assert.equal(m.state().outbox.acceptedInputNo,0);assert.equal(m.enqueue('jump',1000).ok,false);
 assert.throws(()=>apply(e,h),{code:'BASE_REVISION_EXPIRED'});
 m.transport.release({token:h.token});m.transport.retire({token:h.token});const current=batch(m,1000);
 assert.deepEqual(current.payload.commands,h.payload.commands);
 const result=apply(e,current);assert.equal(result.decisions[0].code,'INPUT_EXPIRED');
 assert.equal(acknowledge(m,current,result,1100).ok,true);assert.equal(m.sample(1100).mode,'provisional');
 assert.equal(m.state().firstReceivedAt,1000);assert.equal(m.state().outbox.pendingCommands.length,0);
});

test('natural terminal is held until the server commitment watermark authorizes the result',()=>{
 let e=start();while(e.current.status!=='finished')e=to(e,e.serverTick+60);
 const terminal=e.current.tick;assert.ok(terminal>0);assert.ok(e.committedThroughTick<terminal);
 const m=ready(e);assert.equal(m.sample(0).reason,'terminal-awaiting-commit');assert.equal(m.sample(0).resultAuthorization,null);
 assert.equal(m.enqueue('jump',0).reason,'terminal-awaiting-commit');
 const malformed=publicRoom(e);malformed.game.serverNow++;
 assert.equal(controller().receive({room:malformed,receivedAt:0}).reason,'invalid-game-clock');
 e=to(e,terminal+120);const committed=publicRoom(e);assert.ok(committed.run_inputs.resultAuthorization);
 const result=m.receive({room:freeze(committed),receivedAt:1000});assert.equal(result.ok,true,JSON.stringify(result));
 const displayed=m.sample(1000);assert.equal(displayed.mode,'authoritative-terminal');
 assert.deepEqual(displayed.resultAuthorization,committed.run_inputs.resultAuthorization);assert.equal(m.state().firstReceivedAt,0);
 assert.equal(m.sample(3000).pose.visualSpeed,0);assert.equal(m.enqueue('jump',3000).ok,false);
});

test('natural stun recovery remains continuous across a verified snapshot handoff',()=>{
 let e=start();while(e.current.players[0].stunUntilTick<=e.current.tick)e=to(e,e.serverTick+6);
 const recovery=e.current.players[0].stunUntilTick;e=to(e,recovery-3);const m=ready(e),received=copy(publicRoom(e));
 const a=m.sample(3*1000/60);e=to(e,recovery);
 const r=m.receive({room:freeze(publicRoom(e)),receivedAt:50});assert.equal(r.ok,true,JSON.stringify(r));
 const b=m.sample(50),c=m.sample(50+1000/60);const {sourceTick:as,sourceVersion:av,...ap}=a.pose,{sourceTick:bs,sourceVersion:bv,...bp}=b.pose;assert.deepEqual(ap,bp);assert.notEqual(as,bs);assert.notEqual(av,bv);
 assert.ok(c.pose.distance-b.pose.distance<=8/60+1e-8);assert.ok(c.pose.distance>b.pose.distance);
 assert.equal(c.pose.controlTick,recovery+1);assert.deepEqual(received.game.players,publicRoom(to(start(),recovery-3)).game.players);
});

test('60 seconds at 60 Hz with 5 Hz real-core publications stays within work and storage bounds',t=>{
 let e=start();const m=ready(e),heapBefore=process.memoryUsage().heapUsed,startTime=performance.now();
 let receiveMs=0,sampleMs=0,maxReceiveMs=0,maxSampleMs=0;
 for(let frame=0;frame<=3600;frame++){
  const now=frame*1000/60;
  if(frame&&frame%12===0){e=to(e,frame);const room=freeze(publicRoom(e)),startReceive=performance.now();const result=m.receive({room,receivedAt:now});
   const cost=performance.now()-startReceive;receiveMs+=cost;maxReceiveMs=Math.max(maxReceiveMs,cost);assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.steps<=L.receiveSteps);
  }
  const startSample=performance.now(),result=m.sample(now),cost=performance.now()-startSample;sampleMs+=cost;maxSampleMs=Math.max(maxSampleMs,cost);
  assert.ok(result.pose.distance>=0&&result.pose.distance<=480);assert.equal(result.authorityExpired,false);
 }
 const s=m.state();assert.equal(s.statistics.samples,3601);assert.equal(s.statistics.receives,301);assert.equal(s.statistics.maxReceiveSteps,360);
 assert.equal(s.statistics.maxFrames,241);assert.equal(s.statistics.sampleHistoryCopies,0);assert.equal(s.localCommands.length,0);
 assert.equal(s.outbox.pendingCommands.length,0);assert.ok(Object.isFrozen(m.sample(60000).pose.visualPlayer));
 const a=m.sample(60001),b=m.sample(60002);assert.equal(a.pose.visualPlayer,b.pose.visualPlayer,'RAF reuses immutable frame state, without copying history');
 t.diagnostic(JSON.stringify({scope:'local Node CPU only, not phone GPU or network',simulatedMs:60000,samples:3601,publications:301,
  wallMs:performance.now()-startTime,receiveMs,maxReceiveMs,sampleMs,maxSampleMs,
  retainedHeapDeltaBytes:process.memoryUsage().heapUsed-heapBefore,heapMeaning:'observed net heap, not total allocation',...s.statistics}));
});


test('renewal after a hard stop does not replay the frozen wall-time as a forward jump',()=>{
 let e=start();const m=ready(e);const frozen=m.sample(2000);assert.equal(frozen.provisionalTick,120);
 e=to(e,90);assert.equal(m.receive({room:publicRoom(e),receivedAt:3000}).ok,true);
 const resumed=m.sample(3000);assert.equal(resumed.provisionalTick,120);assert.equal(resumed.pose.distance,frozen.pose.distance);
 assert.equal(m.sample(3000+1000/60).provisionalTick,121);assert.equal(m.state().hardDeadline,5000);
 assert.equal(Object.isFrozen(m.scope),true);assert.deepEqual(m.scope,{roomId:'room_test',playerKey:'self',clockEpoch:1});
});

test('naturally reached own finish remains provisional and cannot select a victory animation',()=>{
 let e=start(),near=null;
 // Genuine legal actions chosen by the engine helper; no injected inventory,
 // positions or finish ticks. Pure core compaction models persisted decisions.
 while(e.current.players[0].distanceU<477*300&&e.current.status==='active'){
  const next=engine.botAction(e.current,'self',e.current.now);
  if(next){e=applyRunPracticeInputs(e,{roomId:'room_test',playerKey:'self',clockEpoch:1,baseRevision:e.revision,
   commands:[{commandSeq:e.lastCommandSeq+1,type:next.type,executeTick:e.current.tick+1}]},e.serverTick).envelope;
   e=compactRunPracticeDecisions(e,{throughSeq:e.lastCommandSeq}).envelope;
  }
  e=to(e,e.serverTick+6);
 }
 assert.equal(e.current.status,'active');assert.equal(e.current.players[0].finishTick,null);near=e;
 const m=ready(near);const forecast=m.sample(1000);
 assert.ok(forecast.pose.distance<=480);assert.equal(forecast.pose.provisionalFinish,true);
 assert.equal(forecast.pose.visualPlayer.finishTick,null);assert.equal(forecast.resultAuthorization,null);assert.equal(forecast.mode,'provisional');
 e=to(e,e.serverTick+60);assert.ok(e.current.players[0].finishTick!==null);
 const received=m.receive({room:freeze(publicRoom(e)),receivedAt:1000});assert.equal(received.ok,true,JSON.stringify(received));
 const shown=m.sample(1000);assert.equal(shown.pose.visualPlayer.finishTick,null);assert.equal(shown.resultAuthorization,null);
 assert.ok(m.state().outbox.lastCommandSeq>0,'reload cursor starts after completed commands');
});


test('HUD peek reads the last immutable renderer result without advancing time or reconciliation',()=>{
 const m=ready();assert.equal(m.peek(),null);const rendered=m.sample(1000),before=m.state();
 // HUD work may execute at wall time 1008 before a queued RAF timestamped
 // 1004. It reads no wall clock and cannot push that RAF forward to 1008.
 for(let i=0;i<10;i++)assert.equal(m.peek(),rendered);
 assert.deepEqual(m.state(),before);assert.equal(Object.isFrozen(m.peek()),true);
 const next=m.sample(1004);assert.ok(Math.abs(next.pose.distance-rendered.pose.distance-.032)<1e-9);
 assert.equal(next.correction,rendered.correction);assert.equal(m.state().statistics.samples,before.statistics.samples+1);
 assert.equal(m.peek(),next);m.clear();assert.equal(m.peek(),null);
});
