import test from 'node:test';
import assert from 'node:assert/strict';
import * as Engine from '../arena/run/engine.mjs';
import {createRunTimeline} from '../arena/run/timeline.mjs';
import {makeRunActionReceipt} from '../shared/run-action-receipt.mjs';
import {createRunHeldBoostFixture} from './fixtures/run-timeline-race-fixture.mjs';
import {createRunAnimatedBoostFixture} from './fixtures/run-timeline-animation-fixture.mjs';
import {LANES} from '../arena/run/level.mjs';

const FRAME=1000/60,KEY='human',ROOM='pvp_mid_race_boost';
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const clone=structuredClone;
function runScenario({resume=false,ackMs=150,outcome='accepted',courseIndex=0,roomId=ROOM,timeline=createRunTimeline(),duplicate=false,durationMs=450,poll=false}={}){
 const {state,game,previousPublication}=createRunHeldBoostFixture({courseIndex}),baseGame=freeze(game),sourceBytes=JSON.stringify(baseGame),serverOrigin=state.now;
 let start=0,version=1,receipt=null,ackGame=null,engineResult=null,serverActed=false,delivered=false,lastPublication=0;
 const publications=[],observations=[],responses=[],authorityCopies=[baseGame];
 if(resume){
  timeline.receive(freeze(previousPublication),KEY,{roomId,roomVersion:version++,receivedAtMs:0});timeline.sample(0);timeline.sample(100);timeline.suspend('background');start=250;
 }
 assert.equal(timeline.receive(baseGame,KEY,{roomId,roomVersion:version++,receivedAtMs:start}),true);
 const initial=timeline.sample(start);if(resume)assert.equal(initial.reason,'resume-background');
 const expected={roomId,playerKey:KEY,request_id:`mid_race_${outcome}_${resume?'resume':'entry'}`,seq:1,type:outcome==='rejected'?'shield':'item',ruleVersion:state.ruleVersion};
 const dispatch={token:'mid-race-input',...expected,dispatchedAtMs:start};
 assert.equal(timeline.noteInput(dispatch),true,'inventory was obtained and delivered before local dispatch');
 let duplicateSent=false;
 for(let frame=0;frame*FRAME<=durationMs+1e-7;frame++){
  const elapsed=frame*FRAME,at=start+elapsed;
  if(!serverActed&&elapsed>=60){
   serverActed=true;
   try{
    const accepted=Engine.act(state,KEY,{type:expected.type,observed_tick:baseGame.snapshotTick},serverOrigin+60);
    engineResult='accepted';receipt=freeze(makeRunActionReceipt({...expected,event:accepted.event}));ackGame=freeze(Engine.view(state,KEY));authorityCopies.push(ackGame);
   }catch(error){engineResult=error.code;assert.equal(outcome,'rejected');assert.equal(error.code,'WRONG_ITEM','the real engine refuses shield when the runner holds boost');}
  }
  Engine.tick(state,serverOrigin+Math.ceil(elapsed));
  if(poll&&elapsed>=lastPublication+250){lastPublication+=250;const publication=freeze(Engine.view(state,KEY));authorityCopies.push(publication);publications.push({at:start+lastPublication+100,version:version++,game:publication});}
  if(!delivered&&elapsed>=ackMs&&outcome!=='unresolved'){
   delivered=true;
   if(outcome==='accepted'){
    responses.push({at:start+ackMs,kind:'accepted',ok:timeline.resolveInput({token:dispatch.token,receipt,resolvedAtMs:start+ackMs})});
    responses.push({at:start+ackMs,kind:'room',ok:timeline.receive(ackGame,KEY,{roomId,roomVersion:version++,receivedAtMs:start+ackMs})});
   }else responses.push({at:start+ackMs,kind:'rejected',ok:timeline.resolveInput({token:dispatch.token,outcome:'rejected',resolvedAtMs:start+ackMs})});
  }
  while(publications[0]?.at<=at){const publication=publications.shift();timeline.receive(publication.game,KEY,{roomId,roomVersion:publication.version,receivedAtMs:publication.at});}
  if(duplicate&&delivered&&!duplicateSent&&elapsed>=ackMs+100){
   duplicateSent=true;timeline.resolveInput({token:dispatch.token,receipt,resolvedAtMs:at});timeline.receive(ackGame,KEY,{roomId,roomVersion:version++,receivedAtMs:at});
  }
  const sample=timeline.sample(at);observations.push({at,elapsed,...sample});
 }
 assert.equal(JSON.stringify(baseGame),sourceBytes,'visual processing changed an authoritative base');
 for(const authority of authorityCopies)assert.ok(Object.isFrozen(authority)&&Object.isFrozen(authority.selfPrediction));
 return{timeline,state,baseGame,start,observations,responses,engineResult,receipt,ackGame,version};
}
function movementStats(run,{through=Infinity}={}){
 let previous=null,holdStart=null;
 const stats={forward:0,backward:0,maxHoldMs:0,maxForwardStep:0,resyncs:0,retimes:[],reasons:{}};
 for(const sample of run.observations){
  if(sample.elapsed>through)break;
  assert.ok(sample.pose&&sample.pose.distance>=0&&sample.pose.distance<=480);
  if(sample.mode==='resync')stats.resyncs++;
  if(sample.reconciliation)stats.retimes.push(sample.reconciliation);
  if(sample.reason)stats.reasons[sample.reason]=(stats.reasons[sample.reason]??0)+1;
  if(previous){
   const delta=sample.pose.distance-previous.pose.distance,dt=sample.at-previous.at;
   stats.maxForwardStep=Math.max(stats.maxForwardStep,delta);
   if(delta>9.6*dt/1000+1/300+1e-7)stats.forward++;
   if(delta<-1e-7)stats.backward++;
   if(Math.abs(delta)<1e-7){holdStart??=previous.at;stats.maxHoldMs=Math.max(stats.maxHoldMs,sample.at-holdStart);}else holdStart=null;
  }
  previous=sample;
 }
 return stats;
}

test('held boost fixture is a complete legal 180m engine history, with no injected inventory',()=>{
 const fixture=createRunHeldBoostFixture(),player=fixture.state.players[0];
 assert.equal(fixture.state.tick,1350);assert.equal(player.distanceU,180*300);assert.equal(player.inventory,'boost');assert.equal(player.hits,0);assert.equal(player.pendingInput,null);
 assert.deepEqual(player.claimedItems,['shield-60','boost-180']);assert.equal(fixture.previousPublication.snapshotTick,1335);assert.equal(fixture.previousPublication.players[0].inventory,null);
 assert.ok(fixture.acceptedActions.some(event=>event.input==='item'&&event.item==='shield'));assert.ok(fixture.acceptedActions.some(event=>event.input==='jump'));assert.ok(fixture.acceptedActions.some(event=>event.input==='slide'));
});
for(const resume of [false,true])for(const ackMs of [150,300]){
 test(`${resume?'background resume':'mid-race entry'} with real held boost and ${ackMs}ms ACK keeps visible forward motion`,t=>{
  const run=runScenario({resume,ackMs}),stats=movementStats(run);t.diagnostic(JSON.stringify({resume,ackMs,...stats}));
  assert.equal(run.engineResult,'accepted');assert.ok(run.responses.every(response=>response.ok));
  assert.equal(stats.forward,0);assert.equal(stats.backward,0);assert.ok(stats.maxHoldMs<100,JSON.stringify(stats));assert.equal(stats.resyncs,0,JSON.stringify(stats));
  assert.ok(stats.retimes.length<=1);for(const retime of stats.retimes){assert.ok(retime.rewindMs>0&&retime.rewindMs<=100+1e-7);assert.ok(retime.fromTick-retime.toTick<=6+1e-7);assert.equal(retime.inputNo,run.receipt.inputNo);}
  assert.equal(run.baseGame.players[0].inventory,'boost');assert.equal(run.state.players[0].inventory,null);
 });
}
test('duplicate receipt and duplicate same-tick room cannot apply the visual boost correction twice',()=>{
 const run=runScenario({duplicate:true,ackMs:150}),stats=movementStats(run);assert.equal(stats.forward,0);assert.equal(stats.backward,0);assert.ok(stats.maxHoldMs<100);
 assert.equal(stats.retimes.length,1,'one accepted input receives exactly one bounded display correction');
 const at=run.start+1200;run.timeline.sample(at);const held=run.timeline.sample(at+100);
 run.timeline.receive(run.ackGame,KEY,{roomId:ROOM,roomVersion:run.version++,receivedAtMs:at+200});
 const refreshed=run.timeline.sample(at+300),{sourceVersion:oldVersion,...oldPose}=held.pose,{sourceVersion:newVersion,...newPose}=refreshed.pose;
 assert.ok(newVersion>oldVersion,'the diagnostic version may record the actual newly received room version');
 assert.deepEqual(newPose,oldPose,'the duplicate cannot renew the original finite authority lease');
});
test('unresolved boost continues confirmed base motion, never forges applied input, then holds at the unchanged budget',()=>{
 const run=runScenario({outcome:'unresolved',durationMs:1000}),stats=movementStats(run,{through:600});
 assert.equal(run.engineResult,'accepted','the actual server accepted it but no receipt or resulting snapshot was delivered');
 assert.equal(stats.forward,0);assert.equal(stats.backward,0);assert.ok(stats.maxHoldMs<100);assert.equal(stats.retimes.length,0);
 for(const sample of run.observations){assert.equal(sample.pose.appliedInputNo,run.baseGame.players[0].appliedInputNo);assert.equal(sample.pose.inventory,'boost');}
 const end=run.observations.at(-1),previous=run.observations.at(-10);assert.equal(end.mode,'hold');assert.deepEqual(end.pose,previous.pose);assert.ok(end.pose.tick<=run.baseGame.snapshotTick+39);
});
test('real WRONG_ITEM rejection preserves ordinary base speed without inventing success or retrying',()=>{
 const run=runScenario({outcome:'rejected',ackMs:150}),stats=movementStats(run);assert.equal(run.engineResult,'WRONG_ITEM');assert.ok(run.responses.every(response=>response.ok));
 assert.equal(stats.forward,0);assert.equal(stats.backward,0);assert.ok(stats.maxHoldMs<100);assert.equal(stats.retimes.length,0);assert.equal(stats.resyncs,0);
 assert.equal(run.state.players[0].inputNo,run.baseGame.players[0].inputNo);assert.equal(run.state.players[0].inventory,'boost');
});
test('a second real boost in a new room resets scope without reusing the old receipt or correction allowance',()=>{
 const timeline=createRunTimeline(),first=runScenario({timeline,roomId:ROOM}),second=runScenario({timeline,roomId:'pvp_mid_race_other'});
 for(const run of [first,second]){const stats=movementStats(run);assert.ok(stats.maxHoldMs<100);assert.equal(stats.forward,0);assert.equal(stats.backward,0);assert.equal(stats.retimes.length,1);}
 assert.equal(timeline.resolveInput({token:'mid-race-input',receipt:first.receipt,resolvedAtMs:second.start+500}),false,'old room receipt cannot resolve the new room');
});
test('later real obstacle hits still stop the own runner after a smoothed accepted boost',()=>{
 const run=runScenario({ackMs:150,poll:true,durationMs:6500}),hit=run.observations.find(sample=>sample.pose.hits>run.baseGame.players[0].hits);
 assert.ok(run.state.players[0].hits>0,'real no-steering continuation must encounter an obstacle');assert.ok(hit,'the renderer must show the true hit');
 const stopped=run.observations.filter(sample=>sample.at>hit.at&&sample.at<hit.at+500);assert.ok(stopped.length>20);assert.ok(stopped.every(sample=>Math.abs(sample.pose.distance-hit.pose.distance)<1e-7));
 assert.ok(run.observations.every(sample=>sample.pose.distance<=480));
});

const animationCases=[
 {name:'lane motion',animation:'right',ackMs:100},
 {name:'rising jump',animation:'jump',ackMs:100},
 {name:'lane arrival',animation:'right',ackMs:1000/6},
 {name:'descending landing',animation:'jump',baseOffset:40,ackMs:100},
 {name:'late ACK before lease expiry',animation:'jump',acceptedOffset:30,dispatchMs:500,ackMs:640},
];
function animatedBoostSamples(options,{duplicate=false}={}){
 const fixture=createRunAnimatedBoostFixture(options),{state,dispatch,receipt}=fixture,game=freeze(fixture.game),bytes=JSON.stringify(game);
 const timeline=createRunTimeline(),frames=[],times=new Set([0,options.ackMs,options.ackMs+50,650,700,900]);
 for(let frame=0;frame<=54;frame++)times.add(frame*FRAME);
 assert.equal(timeline.receive(game,dispatch.playerKey,{roomId:dispatch.roomId,roomVersion:1,receivedAtMs:0}),true);
 let noted=false,acked=false,duplicated=false;
 for(const at of [...times].sort((a,b)=>a-b)){
  if(!noted&&at>=dispatch.dispatchedAtMs){assert.equal(timeline.noteInput(dispatch),true);noted=true;}
  if(!acked&&at>=options.ackMs){
   frames.push({at:options.ackMs,kind:'before-ack',...timeline.sample(options.ackMs)});
   assert.equal(timeline.resolveInput({token:dispatch.token,receipt,resolvedAtMs:options.ackMs}),true);acked=true;
  }
  if(duplicate&&acked&&!duplicated&&at>=options.ackMs+50){
   assert.equal(timeline.resolveInput({token:dispatch.token,receipt,resolvedAtMs:options.ackMs+50}),true);duplicated=true;
  }
  frames.push({at,kind:'frame',...timeline.sample(at)});
 }
 assert.equal(JSON.stringify(game),bytes,'authority snapshot was changed by presentation');
 assert.ok(Object.isFrozen(game)&&Object.isFrozen(game.players[0]));
 // The actual engine reaches the same ordinary safe segment without a hit or
 // fall: these cases cannot exempt a jump/hold as a physical transition.
 Engine.tick(state,game.startedAt+Math.ceil((game.snapshotTick+39)*FRAME));
 assert.equal(state.players[0].hits,game.players[0].hits);assert.equal(state.players[0].fallUntilTick,null);
 return {fixture,frames};
}
function animationStats(run){
 const stats={forward:0,backward:0,maxHoldMs:0,maxAbsInstantStep:0,maxXStep:0,maxYStep:0,minY:Infinity,maxLaneOvershoot:0,resyncs:[],retimes:[],firstViolation:null};
 const player=run.fixture.game.players[0],minimumX=Math.min(LANES[player.fromLane],LANES[player.lane]),maximumX=Math.max(LANES[player.fromLane],LANES[player.lane]);
 let previous=null,holdStart=null;
 for(const sample of run.frames){
  const pose=sample.pose;assert.ok(pose&&pose.distance>=0&&pose.distance<=480);
  stats.minY=Math.min(stats.minY,pose.y);stats.maxLaneOvershoot=Math.max(stats.maxLaneOvershoot,minimumX-pose.x,pose.x-maximumX);
  if(sample.mode==='resync')stats.resyncs.push({at:sample.at,reason:sample.reason});
  if(sample.reconciliation)stats.retimes.push(sample.reconciliation);
  if(previous){
   const dt=sample.at-previous.at,delta=pose.distance-previous.pose.distance;
   stats.maxXStep=Math.max(stats.maxXStep,Math.abs(pose.x-previous.pose.x));stats.maxYStep=Math.max(stats.maxYStep,Math.abs(pose.y-previous.pose.y));
   if(dt<1e-7)stats.maxAbsInstantStep=Math.max(stats.maxAbsInstantStep,Math.abs(delta),Math.abs(pose.x-previous.pose.x),Math.abs(pose.y-previous.pose.y));
   if(delta>9.6*dt/1000+1/300+1e-7){stats.forward++;stats.firstViolation??={previous,sample};}
   if(delta<-1e-7){stats.backward++;stats.firstViolation??={previous,sample};}
   // The unchanged 650ms projection expiry is deliberately outside the normal
   // motion interval. No input-unknown or resync label exempts a pre-expiry stop.
   if(sample.at<650&&Math.abs(delta)<1e-7){holdStart??=previous.at;stats.maxHoldMs=Math.max(stats.maxHoldMs,sample.at-holdStart);}else holdStart=null;
  }
  previous=sample;
 }
 return stats;
}
for(const options of animationCases)test(`real ${options.name} plus boost remains continuous and respects animation boundaries`,t=>{
 const run=animatedBoostSamples(options),stats=animationStats(run),repeated=animatedBoostSamples(options,{duplicate:true}),repeatStats=animationStats(repeated);
 t.diagnostic(JSON.stringify({case:options.name,sourceTick:run.fixture.game.snapshotTick,acceptedTick:run.fixture.receipt.acceptedTick,ackMs:options.ackMs,...stats}));
 assert.equal(stats.forward,0,'ordinary forward correction cannot be relabeled resync');assert.equal(stats.backward,0);assert.ok(stats.maxHoldMs<100,JSON.stringify(stats));
 assert.ok(stats.maxAbsInstantStep<1e-7,'receiving ACK cannot teleport any visible axis');assert.equal(stats.resyncs.length,0);
 assert.ok(stats.minY>=-1e-7,'a completed jump must not sink below the ground');assert.ok(stats.maxLaneOvershoot<1e-7,'lane animation cannot overshoot its known target');
 assert.equal(stats.retimes.length,1);assert.equal(repeatStats.retimes.length,1,'duplicate ACK must not restart reconciliation');
 const beforeAck=run.frames.find(sample=>sample.kind==='before-ack'),afterAck=run.frames.find(sample=>sample.kind==='frame'&&sample.at===options.ackMs);
 // Jump/landing clips use simulation phase; running during a lane change uses
 // visual distance, so the latter needs position continuity but no clip clock.
 if(options.animation==='jump'){
  assert.ok(Number.isFinite(afterAck.pose.animationTick),'the renderer needs the preserved jump phase as well as corrected position');
  assert.ok(Math.abs(afterAck.pose.animationTick-(beforeAck.pose.animationTick??beforeAck.pose.tick))<1e-7,'the receipt must not rewind the sprite animation');
 }
 assert.ok(stats.retimes[0].preservedAnimation?.offsetTicks>0&&stats.retimes[0].preservedAnimation.offsetTicks<=6+1e-7);
 for(const sample of run.frames)if(sample.pose.animationTick!==undefined)assert.ok(sample.pose.animationTick>=sample.pose.tick-1e-7&&sample.pose.animationTick<=sample.pose.tick+6+1e-7,'animation phase preservation stays within the bounded correction');
 assert.deepEqual(repeated.frames.map(({at,pose})=>({at,pose})),run.frames.map(({at,pose})=>({at,pose})),'duplicate ACK must not restart a positional correction');
 const cap=run.frames.find(sample=>sample.kind==='frame'&&sample.at===650),expired=run.frames.find(sample=>sample.kind==='frame'&&sample.at===900);
 assert.equal(cap.mode,'hold');assert.equal(cap.reason,'projection-expired');assert.deepEqual(expired.pose,cap.pose,'neither forward nor animation correction may extend the 650ms authority budget');
 assert.ok(expired.pose.tick<=run.fixture.game.snapshotTick+39);
});
