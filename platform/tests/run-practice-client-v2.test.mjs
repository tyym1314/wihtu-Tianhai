import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {RUN_PRACTICE_PROFILES as P,runPracticeProfileCapability} from '../shared/run-practice-profiles.mjs';
import {createRunPracticeController} from '../arena/run/practice-controller.mjs';
import {createRunPracticeInputOutbox} from '../arena/run/practice-input-outbox.mjs';
import {selectRunPracticeInputRequest,readRunPracticeRoomProfile,matchesRunPracticeRequest} from '../arena/run/practice-profile-contract.mjs';
import {createRunPracticePresentationEvents} from '../arena/run/practice-presentation-events.mjs';
import {createRunPracticeFallHelp} from '../arena/run/practice-fall-help.mjs';
import {MS,ROOM,SELF,owned,start,advance,apply,publicRoom,knownFall} from './run-practice-client-v2-fixture.mjs';
const scope={roomId:ROOM,playerKey:SELF,clockEpoch:1};
const controller=(profile=P.v2)=>createRunPracticeController({...scope,profile,makeRequestId:()=> 'v2_request'});
function ready(e=start(),at=0){const m=controller(e.profileId?P.v2:P.v1);assert.equal(m.receive({room:publicRoom(e),receivedAt:at}).ok,true);return m;}
function ack(m,h,r,at){return m.transport.resolve({token:h.token,receipt:{request_id:h.requestId,run_inputs:publicRoom(r.envelope,r).run_inputs},now:at});}

test('negotiation requires the exact advertised tuple, while old scalar/old server remain unchanged',()=>{
 const capabilities=runPracticeProfileCapability(),context={run_practice_input_protocol:P.v1.protocol,run_practice_input_profiles:capabilities};
 assert.deepEqual(selectRunPracticeInputRequest(context),{run_input_protocol:P.v2.protocol,run_input_profile:P.v2.profileId});
 for(const tuple of [{...capabilities[1],rule_version:P.v1.ruleVersion},{...capabilities[1],profile_id:'caller-720'},{...capabilities[1],historyTicks:360}]){
  assert.deepEqual(selectRunPracticeInputRequest({...context,run_practice_input_profiles:[tuple]}),{run_input_protocol:P.v1.protocol});
 }
 assert.deepEqual(selectRunPracticeInputRequest({run_practice_input_protocol:P.v1.protocol}),{run_input_protocol:P.v1.protocol});
 assert.deepEqual(selectRunPracticeInputRequest({}),{});
 assert.equal(readRunPracticeRoomProfile(publicRoom(start())),P.v2);
 const old=publicRoom(start({profile:P.v1}));delete old.run_input_profile;
 assert.equal(readRunPracticeRoomProfile(old),P.v1,'restoration is selected by the old room, irrespective of new capabilities');
 const waiting=publicRoom(start());delete waiting.game;delete waiting.run_inputs;waiting.status='waiting';
 assert.equal(readRunPracticeRoomProfile(waiting),P.v2);
 assert.equal(matchesRunPracticeRequest(waiting,selectRunPracticeInputRequest(context)),true);
});

test('mixed tuples, paid/fee rooms, two humans, wrong capacity and malformed proof never enable v2',()=>{
 for(const mutate of [r=>delete r.run_input_profile,r=>r.run_inputs.profileId='other',r=>r.run_input_profile.rule_version=P.v1.ruleVersion,r=>r.entry_minor='1',r=>r.fee_bps=1,r=>r.game.players[1].isBot=false,r=>r.capacity=3,r=>r.run_inputs.selfReplay.anchorTick=-1]){
  const m=controller(),r=publicRoom(start());mutate(r);assert.equal(m.receive({room:r,receivedAt:0}).ok,false);assert.equal(m.sample(100).pose,null);
 }
 assert.throws(()=>controller({...P.v2,profileId:null}),/INVALID_CONTROLLER_PROFILE/);
});

test('v1 119/120/121 and v2 359/360/361 keep independent tick and wall deadlines',()=>{
 for(const profile of [P.v1,P.v2]){
  const m=ready(start({profile}));assert.equal(m.sample((profile.futureTicks-1)*MS).mode,'provisional');
  assert.equal(m.sample(profile.leaseMs-1).mode,'provisional');
  const stop=m.sample(profile.leaseMs);assert.equal(stop.mode,'hold');assert.equal(stop.provisionalTick,profile.futureTicks);assert.equal(stop.pose.visualSpeed,0);
  assert.deepEqual(m.sample((profile.futureTicks+1)*MS).pose,stop.pose);assert.deepEqual(m.sample(20000).pose,stop.pose);
  assert.equal(m.enqueue('jump',20000).reason,'provisional-budget-expired');assert.equal(m.state().statistics.maxFrames,profile.futureTicks+1);
 }
});

test('a three-second head gap retains real movement in v2 and honestly holds v1 after two seconds',()=>{
 for(const profile of [P.v1,P.v2]){
  const m=ready(start({profile}));let previous=m.sample(0),movement=0;
  for(let frame=1;frame<=180;frame++){
   const s=m.sample(frame*MS);if(s.pose.distance>previous.pose.distance)movement++;
   if(profile===P.v2){assert.equal(s.mode,'provisional');assert.ok(s.pose.distance-previous.pose.distance<=8*MS/1000+1e-7);}
   previous=s;
  }
  assert.equal(movement,profile===P.v2?179:119);assert.equal(previous.mode,profile===P.v2?'provisional':'hold');
 }
});

test('same head, exact ACK, duplicate retry and metadata cannot renew either v2 lease',()=>{
 let e=start();const m=ready(e);m.sample(500);assert.equal(m.enqueue('right',500).ok,true);const h=m.transport.beginBatch(500);
 const r=apply(e,h);assert.equal(r.decisions[0].code,'FUTURE_INPUT');assert.equal(ack(m,h,r,800).ok,true);
 assert.equal(m.receive({room:publicRoom(r.envelope,r),receivedAt:900}).ok,true);assert.equal(m.state().hardDeadline,6000);
 assert.equal(ack(m,h,apply(r.envelope,h),1000).ok,true);assert.equal(m.state().hardDeadline,6000);
 const repeated=publicRoom(r.envelope);repeated.version++;assert.equal(m.receive({room:repeated,receivedAt:1100}).reason,'old-authority');
 assert.equal(m.sample(6000).mode,'hold');
});

test('GET-before-ACK and late/rejected command revisions preserve exact outbox authority and causal rebuild',()=>{
 let e=start();const m=ready(e);assert.equal(m.enqueue('right',0).ok,true);const h=m.transport.beginBatch(0);
 e=advance(e,180);const r=apply(e,h);e=r.envelope;
 assert.equal(m.receive({room:publicRoom(e),receivedAt:3000}).ok,true);assert.equal(m.state().outbox.pendingCommands.length,1);assert.equal(m.state().outbox.acceptedInputNo,0);
 assert.equal(ack(m,h,r,3100).ok,true);assert.equal(m.state().outbox.pendingCommands.length,0);assert.equal(m.state().hardDeadline,9000);
 const snapshot=m.sample(3200),stats=m.state().statistics;
 assert.equal(ack(m,h,apply(e,h),3200).ok,true);assert.deepEqual(m.sample(3200).pose,snapshot.pose);assert.ok(m.state().statistics.maxReceiveSteps<=1080);
 assert.ok(m.state().statistics.frameRecordsAllocated-stats.frameRecordsAllocated<=360);
});

test('v2 outbox bounds64 unconfirmed commands,8 per immutable send and2 physical slots',()=>{
 const e=start(),box=createRunPracticeInputOutbox({scope:{...scope,protocol:P.v2.protocol,ruleVersion:P.v2.ruleVersion,profileId:P.v2.profileId,practice:true,entryMinor:'0',players:e.current.players},makeRequestId:()=> 'bounded_request'});
 for(let i=0;i<64;i++)assert.equal(box.enqueue({type:'jump',executeTick:i*6+1}).ok,true);
 assert.equal(box.enqueue({type:'jump',executeTick:385}).reason,'PENDING_LIMIT');
 const a=box.beginBatch({baseRevision:0}),b=box.beginBatch({baseRevision:0});assert.equal(a.payload.commands.length,8);assert.equal(b.payload.commands.length,8);assert.equal(box.beginBatch({baseRevision:0}).reason,'IN_FLIGHT_LIMIT');
 const before=box.state();assert.equal(box.resolve({token:a.token,receipt:{request_id:a.requestId,run_inputs:{protocol:P.v1.protocol}}}).reason,'INVALID_RECEIPT');assert.deepEqual(box.state(),before);
});

test('exact real terminal decisions acknowledge at each pinned server tick limit, never one tick beyond it',()=>{
 for(const profile of [P.v1,P.v2]){
  const e=advance(start({profile}),profile.serverMaxTick),box=createRunPracticeInputOutbox({scope:{...scope,protocol:profile.protocol,ruleVersion:profile.ruleVersion,...(profile.profileId?{profileId:profile.profileId}:{}),practice:true,entryMinor:'0',players:e.current.players},makeRequestId:()=> 'terminal_request',initial:{lastCommandSeq:0,acceptedInputNo:0,revision:e.revision}});
  assert.equal(box.enqueue({type:'jump',executeTick:1}).ok,true);const h=box.beginBatch({baseRevision:e.revision}),r=apply(e,h);
  assert.equal(r.decisions[0].code,'TERMINAL_COMMITTED');assert.equal(r.decisions[0].decidedAtServerTick,profile.serverMaxTick);
  const receipt={request_id:h.requestId,run_inputs:publicRoom(r.envelope,r).run_inputs},bad=structuredClone(receipt),before=box.state();bad.run_inputs.decisions[0].decidedAtServerTick++;
  assert.equal(box.resolve({token:h.token,receipt:bad}).reason,'INVALID_RECEIPT');assert.deepEqual(box.state(),before);
  assert.equal(box.resolve({token:h.token,receipt}).ok,true);assert.equal(box.state().pendingCommands.length,0);assert.equal(box.state().acceptedInputNo,0);
 }
});

test('v2 visibility and disposal preserve the new-head barrier and retire original input capabilities',()=>{
 let e=start();const m=ready(e),pose=m.sample(200).pose;m.suspend();assert.deepEqual(m.sample(500).pose,{...pose,visualSpeed:0});
 e=advance(e,15);assert.equal(m.receive({room:publicRoom(e),receivedAt:500}).ok,true);m.resume();assert.equal(m.sample(510).reason,'awaiting-new-head');
 assert.equal(m.receive({room:publicRoom(e),receivedAt:520}).reason,'old-authority');assert.equal(m.sample(520).reason,'awaiting-new-head');
 e=advance(e,16);assert.equal(m.receive({room:publicRoom(e),receivedAt:530}).ok,true);assert.equal(m.sample(530).mode,'provisional');
 assert.equal(m.enqueue('right',530).ok,true);const h=m.transport.beginBatch(530);m.clear();
 assert.equal(m.transport.resolve({token:h.token,receipt:{},now:540}).reason,'closed');assert.equal(m.sample(540).pose,null);assert.equal(m.stateAtTick(16),null);
});

test('v2 actual early BOT terminal waits for committed authority even though its six-second own trajectory exists',()=>{
 let e=advance(start({course:'rapid-bridges'}),4464);assert.equal(e.current.status,'finished');assert.ok(e.committedThroughTick<e.current.tick);
 const m=ready(e),early=m.sample(0);assert.equal(early.reason,'terminal-awaiting-commit');assert.equal(early.resultAuthorization,null);assert.notEqual(early.mode,'authoritative-terminal');
 e=advance(e,6360);const room=publicRoom(e);assert.equal(room.run_inputs.headTick,4464);assert.equal(room.run_inputs.committedThroughTick,6000);assert.equal(room.run_inputs.selfReplay.anchorTick,4464);
 assert.equal(m.receive({room,receivedAt:500}).ok,true);const committed=m.sample(500);assert.equal(committed.mode,'authoritative-terminal');assert.deepEqual(committed.resultAuthorization,room.run_inputs.resultAuthorization);
 assert.equal(m.enqueue('jump',500).reason,'authoritative-terminal');assert.ok(m.state().statistics.maxReceiveSteps<=1080);
 const events=createRunPracticePresentationEvents(scope),help=createRunPracticeFallHelp(scope);
 assert.ok(room.run_inputs.committedOwnEvents.some(e=>e.type==='fall'&&e.tick===3861));assert.ok(3861<room.run_inputs.committedThroughTick-720);
 assert.equal(events.receive(room),true);assert.equal(help.receive(room),true);
 assert.equal(events.drain(room.game.snapshotTick).filter(e=>e.type==='fall'&&e.tick===3861).length,1,'journal lower bound follows actual stopped anchor, not a later commit watermark');
});

test('steady v2 authority reuses immutable trajectory prefixes; all computed endpoints still equal the core',t=>{
 let e=advance(start(),360);const m=ready(e),initial=m.state().statistics;assert.equal(initial.maxReceiveSteps,1080);assert.equal(initial.maxFrames,721);
 const durations=[];let newRecords=0;
 for(let head=375;head<=720;head+=15){
  e=advance(e,head);const before=m.state().statistics,at=performance.now(),received=m.receive({room:publicRoom(e),receivedAt:(head-360)*MS});durations.push(performance.now()-at);
  assert.equal(received.ok,true,JSON.stringify(received));assert.ok(received.steps<=375);const after=m.state().statistics;
  newRecords+=after.frameRecordsAllocated-before.frameRecordsAllocated;assert.equal(after.frameRecordsAllocated-before.frameRecordsAllocated,15);
  assert.equal(after.frameRecordsReused-before.frameRecordsReused,706);
  const canonical=owned(e.current.players[0]),{tick,...predicted}=m.stateAtTick(head);assert.equal(tick,head);assert.deepEqual(predicted,canonical);
 }
 const before=m.state().statistics;for(let i=0;i<600;i++)m.sample(6000+i/100);const after=m.state().statistics;
 assert.equal(after.frameRecordsAllocated,before.frameRecordsAllocated);assert.equal(after.sampleHistoryCopies,0);
 assert.equal(newRecords,360,'24 receives allocate360 frame/state pairs, rather than17304 full rebuild pairs');
 t.diagnostic(JSON.stringify({scope:'Node CPU only; steady strict proof360 plus suffix15',receives:durations.length,maxReceiveMs:Math.max(...durations),meanReceiveMs:durations.reduce((a,b)=>a+b,0)/durations.length,newRecords,...after}));
});

test('six seconds of legal10Hz attempts with four players keeps immutable queued actions and all bounds',t=>{
 let e=start();const m=ready(e),durations=[],enqueues=[];let attempts=0,admitted=0;
 for(let tick=0;tick<=360;tick+=6){
  if(tick){e=advance(e,tick);const at=performance.now(),r=m.receive({room:publicRoom(e),receivedAt:tick*MS});durations.push(performance.now()-at);assert.equal(r.ok,true,JSON.stringify(r));}
  m.sample(tick*MS);attempts++;
  for(const type of ['right','left','jump','slide','item']){
   const at=performance.now(),input=m.enqueue(type,tick*MS);enqueues.push(performance.now()-at);if(!input.ok)continue;
   admitted++;const h=m.transport.beginBatch(tick*MS);assert.equal(h.ok,true);const r=apply(e,h);e=r.envelope;assert.equal(ack(m,h,r,tick*MS).ok,true);break;
  }
  assert.ok(m.state().statistics.maxFrames<=721);assert.ok(m.state().statistics.maxReceiveSteps<=1080);assert.ok(m.state().localCommands.length<=64);
 }
 const s=m.state();assert.ok(admitted>=20);assert.equal(s.outbox.pendingCommands.length,0);assert.equal(s.outbox.inFlight,0);assert.equal(s.statistics.sampleHistoryCopies,0);
 t.diagnostic(JSON.stringify({scope:'Node real core, one human and three deterministic BOTs, rate10Hz attempts',attempts,admitted,maxReceiveMs:Math.max(...durations),maxEnqueueMs:Math.max(...enqueues),...s.statistics}));
});

test('known natural tick3396 fall and checkpoint respawn survive the six-second trajectory without flattening',()=>{
 let e=advance(knownFall(),3271);const m=ready(e);assert.equal(m.stateAtTick(3396).distanceU,86400);assert.equal(m.stateAtTick(3396).fallStartTick,3396);assert.equal(m.stateAtTick(3396).fallUntilTick,3486);
 for(const tick of [3317,3318,3395,3396,3406,3485,3486]){
  const reference=advance(e,tick),{tick:actual,...state}=m.stateAtTick(tick);assert.equal(actual,tick);assert.deepEqual(state,owned(reference.current.players[0]));
 }
 const before=m.sample((3396-3271)*MS);assert.equal(before.pose.visualPlayer.fallUntilTick,null,'integer3396 still displays causal previous3395');
 const falling=m.sample((3397-3271)*MS);assert.equal(falling.mode,'provisional');assert.equal(falling.pose.visualPlayer.fallUntilTick,3486);assert.equal(falling.pose.visualSpeed,0);
 const boundary=m.sample((3486-3271)*MS);assert.equal(boundary.pose.visualPlayer.fallUntilTick,3486);assert.equal(boundary.pose.causalBoundary,'respawn');
 const respawn=m.sample((3487-3271)*MS);assert.equal(respawn.pose.visualPlayer.fallUntilTick,null);assert.equal(respawn.pose.checkpoint,270);assert.equal(respawn.pose.tick,3486);
});

test('actual committed own falls duplicated in both bounded tails sound/help once after lag',()=>{
 let e=advance(knownFall(),3756),room=publicRoom(e),events=createRunPracticePresentationEvents(scope),help=createRunPracticeFallHelp(scope);
 assert.ok(room.run_inputs.committedOwnEvents.some(e=>e.type==='fall'&&e.tick===3396));
 assert.ok(room.game.events.some(e=>e.playerKey===SELF&&e.type==='fall'&&e.tick===3396));assert.equal(room.game.events.length,48);
 assert.equal(events.receive(room),true);assert.equal(help.receive(room),true);
 const falls=events.drain(room.game.snapshotTick).filter(e=>e.type==='fall');assert.equal(falls.filter(e=>e.tick===3396).length,1);assert.ok(falls.length>=1);
 e=advance(e,3768);room=publicRoom(e);assert.equal(events.receive(room),true);assert.equal(help.receive(room),true);
 assert.equal(events.drain(room.game.snapshotTick).filter(e=>e.tick===3396).length,0);assert.ok(events.state().played<=304);assert.ok(help.state().seen<=64);
 const malformed=structuredClone(room);malformed.run_inputs.committedOwnEvents[0].playerKey='bot_0';const before=events.state();assert.equal(events.receive(malformed),false);assert.deepEqual(events.state(),before);
});
