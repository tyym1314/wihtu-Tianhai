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

// Receipt timing here is a deterministic local schedule, not a network measurement.
for(const receivedAt of [400,500,600])test(`ordinary head 60 -> 90 at ${receivedAt}ms preserves the same display phase`,()=>{
 const e=to(start(),60),m=ready(e);const before=m.sample(receivedAt),next=to(e,90),snapshot=freeze(publicRoom(next)),saved=copy(snapshot);
 assert.equal(m.receive({room:snapshot,receivedAt}).ok,true);const after=m.sample(receivedAt);
 assert.equal(after.provisionalTick,before.provisionalTick);assert.ok(Math.abs(after.pose.distance-before.pose.distance)<1e-9);
 assert.equal(after.clockReset,null);assert.equal(after.correction,null);assert.equal(after.pose.hits,0);assert.equal(after.pose.fallUntilTick,null);
 assert.ok(Math.abs(m.sample(receivedAt+1000/60).pose.distance-after.pose.distance-8/60)<1e-9);assert.deepEqual(snapshot,saved);
});

test('a receive callback at 505ms does not move the older 500ms RAF timestamp',()=>{
 const e=to(start(),60),m=ready(e),before=m.sample(500-1000/60);
 assert.equal(m.receive({room:publicRoom(to(e,90)),receivedAt:505}).ok,true);
 const a=m.sample(500),b=m.sample(500+1000/60);
 for(const [left,right]of [[before,a],[a,b]])assert.ok(Math.abs((right.pose.distance-left.pose.distance)*60-8)<1e-8);
 assert.equal(a.provisionalTick,90);assert.equal(a.clockReset,null);
});

test('repeated shorter/longer response delays retain 8m/s across anchor rollovers',()=>{
 let e=to(start(),60);const m=ready(e),schedule=[[75,80],[90,400],[105,450],[120,850],[135,1100],[150,1200],[165,1350],[180,1700]];let index=0,previous=m.sample(0);
 for(let frame=1;frame<=120;frame++){
  const now=frame*1000/60;
  while(index<schedule.length&&schedule[index][1]<=now+5){const[tick,receivedAt]=schedule[index++];e=to(e,tick);assert.equal(m.receive({room:publicRoom(e),receivedAt}).ok,true);}
  const current=m.sample(now);assert.equal(current.mode,'provisional');assert.equal(current.clockReset,null);
  assert.ok(Math.abs(current.pose.distance-previous.pose.distance-8/60)<1e-8,JSON.stringify({frame,previous,current}));previous=current;
 }
 assert.equal(index,schedule.length);
});

test('one verified predecessor retains the causal interval when new anchor equals display tick',()=>{
 const e=to(start(),60),m=ready(e),before=m.sample(0),next=to(e,180);
 assert.equal(next.anchor.tick,60);assert.equal(m.receive({room:publicRoom(next),receivedAt:0}).ok,true);
 const after=m.sample(0);assert.equal(after.clockReset,null);assert.equal(after.provisionalTick,60);
 assert.equal(after.pose.distance,before.pose.distance);assert.equal(after.pose.causalFromTick,59);assert.equal(after.pose.causalToTick,60);
 assert.ok(Math.abs(m.sample(5).pose.distance-after.pose.distance-.04)<1e-9);
});

test('enqueue and exact ACK preserve the inherited anchor interval rather than jumping one tick',()=>{
 let e=to(start(),60);const m=ready(e),before=m.sample(0);e=to(e,180);
 assert.equal(m.receive({room:publicRoom(e),receivedAt:0}).ok,true);
 const command=action(m,'jump',0);assert.equal(command.executeTick,61);assert.equal(m.sample(0).pose.distance,before.pose.distance);
 const h=batch(m,0),accepted=apply(e,h);assert.equal(accepted.decisions[0].outcome,'accepted');
 assert.equal(acknowledge(m,h,accepted,0).ok,true);assert.equal(m.sample(0).pose.distance,before.pose.distance);
 assert.equal(m.receive({room:publicRoom(accepted.envelope,accepted),receivedAt:0}).ok,true);
 assert.equal(m.sample(0).pose.distance,before.pose.distance);assert.equal(m.sample(0).clockReset,null);
});

test('a head beyond retained history is an explicit resync, not a claimed smooth handoff',()=>{
 const e=to(start(),60),m=ready(e);m.sample(0);
 assert.equal(m.receive({room:publicRoom(to(e,181)),receivedAt:0}).ok,true);
 const after=m.sample(0);assert.equal(after.clockReset.reason,'history-gap-resync');assert.equal(after.clockReset.fromTick,60);assert.equal(after.clockReset.toTick,181);
 assert.equal(after.provisionalTick,181);assert.equal(after.correction.cause,'history-gap-resync');
});

test('input tick follows displayed history behind head, never silently reassigned to head',()=>{
 let e=to(start(),60);const m=ready(e);m.sample(400);e=to(e,90);assert.equal(m.receive({room:publicRoom(e),receivedAt:400}).ok,true);
 const command=action(m,'jump',400);assert.equal(command.executeTick,85);assert.equal(m.sample(400).provisionalTick,84);
 const h=batch(m,400),accepted=apply(e,h);assert.equal(accepted.decisions[0].outcome,'accepted');assert.equal(accepted.decisions[0].executeTick,85);
 assert.equal(acknowledge(m,h,accepted,450).ok,true);assert.equal(m.receive({room:publicRoom(accepted.envelope,accepted),receivedAt:450}).ok,true);
 assert.equal(m.state().firstReceivedAt,400);assert.equal(m.sample(450).provisionalTick,87);assert.equal(m.state().outbox.pendingCommands.length,0);
});

test('same-head higher revision keeps both budgets and late old RAF never reverses display',()=>{
 const e=to(start(),60),m=ready(e);m.sample(400);const next=publicRoom(e);next.run_inputs.revision++;next.version++;
 assert.equal(m.receive({room:next,receivedAt:405}).ok,true);assert.equal(m.state().firstReceivedAt,0);
 assert.equal(m.sample(400).provisionalTick,84);assert.equal(m.sample(399).provisionalTick,84);
 assert.equal(m.sample(650).authorityExpired,true);const expired=m.sample(2000);assert.equal(expired.reason,'provisional-budget-expired');assert.equal(expired.provisionalTick,180);
 assert.deepEqual(m.sample(9000).pose,expired.pose);
});

test('real fall/respawn and recovery metadata are not smoothed away by a faster authority',()=>{
 let e=start(2);e=to(e,240);const m=ready(e);const before=m.sample(100);e=to(e,258);assert.notEqual(e.current.players[0].fallUntilTick,null);
 assert.equal(m.receive({room:publicRoom(e),receivedAt:100}).ok,true);assert.equal(m.sample(100).pose.distance,before.pose.distance);
 const reference=ready(to(start(2),240));
 for(let time=100;time<=1900;time+=1000/60){const actual=m.sample(time).pose,expected=reference.sample(time).pose;for(const key of ['distance','x','y','scale','fallUntilTick','stunUntilTick','causalBoundary','causalFromTick','causalToTick'])assert.equal(actual[key],expected[key],`${key} at ${time}`);}
});

test('naturally acquired and accepted boost stays at 9.6m/s through a faster snapshot',()=>{
 let e=start();
 while(e.current.players[0].inventory!=='boost'&&e.current.status==='active'){
  const input=engine.botAction(e.current,'self',e.current.now);
  if(input){e=applyRunPracticeInputs(e,{roomId:'room_test',playerKey:'self',clockEpoch:1,baseRevision:e.revision,
   commands:[{commandSeq:e.lastCommandSeq+1,type:input.type,executeTick:e.current.tick+1}]},e.serverTick).envelope;
   e=compactRunPracticeDecisions(e,{throughSeq:e.lastCommandSeq}).envelope;}
  e=to(e,e.serverTick+6);
 }
 assert.equal(e.current.players[0].inventory,'boost');
 e=applyRunPracticeInputs(e,{roomId:'room_test',playerKey:'self',clockEpoch:1,baseRevision:e.revision,
  commands:[{commandSeq:e.lastCommandSeq+1,type:'item',executeTick:e.current.tick+1}]},e.serverTick).envelope;
 e=to(e,e.serverTick+6);const initialTick=e.current.tick,m=ready(e),before=m.sample(50);
 const next=to(e,initialTick+6);assert.equal(m.receive({room:publicRoom(next),receivedAt:50}).ok,true);const after=m.sample(50);
 assert.equal(after.pose.distance,before.pose.distance);assert.equal(after.clockReset,null);
 const later=m.sample(50+1000/60);assert.ok(Math.abs((later.pose.distance-after.pose.distance)*60-9.6)<1e-8);
});
