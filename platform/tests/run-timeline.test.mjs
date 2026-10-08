import test from 'node:test';
import assert from 'node:assert/strict';
import * as Engine from '../arena/run/engine.mjs';
import {createRunTimeline,RUN_MAX_BOOST_RETIME_MS} from '../arena/run/timeline.mjs';
import {createRunHeldBoostFixture} from './fixtures/run-timeline-race-fixture.mjs';
const ROOM='timeline-room',KEY='human',RULE=Engine.PRACTICE_RULE_VERSION,clone=structuredClone;
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
function state(course=0){const s=Engine.createState(course.toString(16).padStart(8,'0').padEnd(64,'a'),1000,{ruleVersion:RULE,startPolicy:Engine.RUN_SCENE_READY_POLICY,players:[{key:KEY,seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]});Engine.armStart(s,1000);return s;}
const at=(s,tick)=>s.startedAt+Math.ceil(tick*1000/60);
function viewAt(s,tick){Engine.tick(s,at(s,tick));return clone(Engine.view(s,KEY));}
const receive=(t,g,version,receivedAtMs)=>t.receive(g,KEY,{roomId:ROOM,roomVersion:version,receivedAtMs});
function dispatch(token,type,dispatchedAtMs=0,seq=1){return{token,roomId:ROOM,playerKey:KEY,request_id:'request-'+token,seq,type,ruleVersion:RULE,dispatchedAtMs};}
const receipt=(d,no,tick)=>({roomId:d.roomId,playerKey:d.playerKey,request_id:d.request_id,seq:d.seq,type:['boost','shield'].includes(d.type)?'item':d.type,ruleVersion:d.ruleVersion,inputNo:no,acceptedTick:tick});

test('authority tick 120 arriving when display is 112 preserves continuous display and adopts only at 120',()=>{
 const s=state(),t=createRunTimeline();receive(t,viewAt(s,100),1,0);near(t.sample(0).displayTick,100);near(t.sample(200).displayTick,112);
 receive(t,viewAt(s,120),2,200);const after=t.sample(200);assert.equal(after.mode,'project');near(after.displayTick,112);near(after.pose.tick,111);near(after.pose.distance,111*40/300);assert.equal(after.baseTick,100);
 const adopted=t.sample(1000/3);near(adopted.displayTick,120);assert.equal(adopted.baseTick,120);near(adopted.pose.tick,119);near(adopted.pose.distance,119*40/300);
});

test('same tick higher version pending rebuilds accepted history without renewing the original lease',()=>{
 const s=state(),t=createRunTimeline(),initial=viewAt(s,100);receive(t,initial,1,0);
 Engine.act(s,KEY,{type:'jump'},s.now);const pending=clone(Engine.view(s,KEY));assert.equal(pending.snapshotTick,100);receive(t,pending,2,10);
 assert.equal(t.sample(10).mode,'project');assert.equal(t.sample(100).pose.appliedInputNo,1);
 const duplicate=clone(pending);assert.equal(receive(t,duplicate,3,640),true);const expired=t.sample(651);assert.equal(expired.mode,'hold');assert.equal(expired.reason,'projection-expired');assert.ok(expired.displayTick<=139);
 assert.equal(receive(t,initial,1,652),false);
});

test('accepted jump in authoritative history prevents the old no-input projection from falling in a gap',()=>{
 const s=state(2),t=createRunTimeline();receive(t,viewAt(s,240),1,0);const sent=dispatch('jump-history','jump',0);assert.equal(t.noteInput(sent),true);
 Engine.tick(s,at(s,248));Engine.act(s,KEY,{type:'jump'},s.now);const next=viewAt(s,250);assert.equal(next.players[0].hits,0);receive(t,next,2,100);
 const before=t.sample(100);assert.equal(before.mode,'project');near(before.displayTick,246);
 const jumped=t.sample(250);assert.equal(jumped.mode,'project');assert.equal(jumped.pose.appliedInputNo,1);assert.equal(jumped.pose.fallUntilTick,null);near(jumped.pose.tick,254);near(jumped.pose.y,Engine.pose(s.players[0],jumped.pose.tick).y);assert.ok(jumped.pose.y>0);
 // The event is enough for replay, but only the exact original HTTP receipt may resolve the dispatch.
 assert.equal(t.resolveInput({token:sent.token,receipt:{...receipt(sent,1,249),request_id:'different-request'},resolvedAtMs:250}),false);
 assert.equal(t.resolveInput({token:sent.token,receipt:receipt(sent,1,249),resolvedAtMs:250}),true);
});

test('unconfirmed jump holds before a dangerous interval and never expires into presumed rejection',()=>{
 const s=state(2),t=createRunTimeline();receive(t,viewAt(s,248),1,0);const sent=dispatch('jump-unknown','jump');assert.equal(t.noteInput(sent),true);
 const stopped=t.sample(200);assert.equal(stopped.mode,'hold');assert.equal(stopped.reason,'input-collision-uncertain');assert.equal(stopped.pose.fallUntilTick,null);const stoppedTick=stopped.displayTick;
 const later=t.sample(800);assert.equal(later.mode,'hold');near(later.displayTick,stoppedTick);assert.equal(later.pose.fallUntilTick,null);
 assert.equal(t.resolveInput({token:sent.token,outcome:'unresolved',resolvedAtMs:800}),true);assert.equal(t.sample(810).mode,'hold');
});

test('a definite rejected input releases collision uncertainty, while a real authority fall is never hidden',()=>{
 const s=state(2),t=createRunTimeline();receive(t,viewAt(s,248),1,0);const sent=dispatch('jump-rejected','jump');t.noteInput(sent);assert.equal(t.sample(160).mode,'hold');
 assert.equal(t.resolveInput({token:sent.token,outcome:'rejected',resolvedAtMs:160}),true);
 receive(t,viewAt(s,264),2,170);let sample=t.sample(170);assert.notEqual(sample.reason,'input-collision-uncertain');
 sample=t.sample(400);assert.notEqual(sample.pose.fallUntilTick,null);assert.ok(sample.pose.y<0);assert.equal(sample.pose.hits,1);
});

test('authoritative physical divergence produces explicit resync and takes the corrected hit state',()=>{
 const s=state(0),t=createRunTimeline(),old=viewAt(s,270);receive(t,old,1,0);t.sample(0);
 // Separate real engine branch: accepted slide clears the first beam; omitted
 // input history leaves that branch unprovable and must not be hidden in queue.
 Engine.act(s,KEY,{type:'slide'},s.now);const corrected=viewAt(s,286);corrected.events=[];
 receive(t,corrected,2,100);const output=t.sample(100);assert.equal(output.mode,'resync');assert.match(output.reason,/divergence|history/);assert.equal(output.pose.hits,corrected.players[0].hits);
});

test('an actual hit remains visible even when display tick is intentionally behind newer authority',()=>{
 const s=state(),t=createRunTimeline();receive(t,viewAt(s,270),1,0);t.sample(0);const hit=viewAt(s,286);assert.ok(hit.players[0].hits>0);receive(t,hit,2,100);
 const before=t.sample(100);assert.equal(before.mode,'project');assert.equal(before.pose.hits,0);
 const contact=t.sample(300);assert.equal(contact.pose.hits,1);assert.ok(contact.pose.stunUntilTick>contact.displayTick);assert.equal(contact.pose.distance,hit.players[0].distance);
});

test('a network authority gap larger than the 39 tick bridge explicitly resynchronizes',()=>{
 const s=state(),t=createRunTimeline();receive(t,viewAt(s,100),1,0);const held=t.sample(650);assert.equal(held.mode,'hold');receive(t,viewAt(s,180),2,900);
 const restored=t.sample(900);assert.equal(restored.mode,'resync');assert.equal(restored.reason,'authority-gap');assert.equal(restored.baseTick,180);assert.equal(restored.displayTick,180);
});

test('backdated RAF, duplicate versions and same-tick refresh cannot revive a stale budget',()=>{
 const s=state(),t=createRunTimeline(),g=viewAt(s,100);receive(t,g,1,10);near(t.sample(0).displayTick,100);near(t.sample(110).displayTick,106);
 assert.equal(receive(t,g,1,200),false);assert.equal(receive(t,g,2,200),true);assert.equal(t.sample(700).mode,'hold');const stopped=t.sample(700).displayTick;
 receive(t,g,3,1000);near(t.sample(1000).displayTick,stopped);assert.equal(t.sample(1000).reason,'projection-expired');
});

test('suspend preserves version/tick watermarks and requires a strictly newer simulation tick',()=>{
 const s=state(),t=createRunTimeline(),g=viewAt(s,100);receive(t,g,1,0);t.sample(100);t.suspend('background');receive(t,g,2,200);assert.equal(t.sample(200).mode,'hold');assert.equal(t.sample(200).reason,'background');
 receive(t,viewAt(s,101),3,300);const resumed=t.sample(300);assert.equal(resumed.mode,'resync');assert.equal(resumed.reason,'resume-background');assert.equal(resumed.baseTick,101);
 t.suspend('disconnect');assert.equal(receive(t,g,4,400),false);assert.equal(t.sample(400).reason,'disconnect');
});

test('initial arming time is not donated to racing; pause mappings cause explicit resynchronization',()=>{
 const s=Engine.createState('00'.repeat(32),1000,{ruleVersion:RULE,startPolicy:Engine.RUN_SCENE_READY_POLICY,players:[{key:KEY,seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]}),t=createRunTimeline();
 receive(t,Engine.view(s,KEY),1,0);assert.equal(t.sample(2000).mode,'fallback');Engine.armStart(s,3000);receive(t,Engine.view(s,KEY),2,2100);near(t.sample(2100).displayTick,0);
 Engine.shiftTime(s,1000);receive(t,Engine.view(s,KEY),3,2200);assert.equal(t.sample(2200).reason,'mapping-changed');
});

test('missing new self contract on a rollback uses legacy fallback with no overriding pose',()=>{
 const s=state(),t=createRunTimeline(),g=viewAt(s,100);delete g.selfPrediction;receive(t,g,1,0);const result=t.sample(100);assert.equal(result.mode,'fallback');assert.equal(result.pose,null);
 const bad=viewAt(s,101);bad.selfPrediction.schema='unknown';receive(t,bad,2,110);assert.equal(t.sample(110).mode,'resync');
});

test('all five dispatch types are tracked, scoped receipts are mandatory, and unknown item is not treated as successful',()=>{
 for(const type of ['left','right','jump','slide','item']){
  const s=state(),t=createRunTimeline();
  if(type==='item'){for(let tick=0;tick<=6000;tick++){Engine.tick(s,at(s,tick));if(s.players[0].inventory==='boost')break;for(const p of s.players){const action=Engine.botAction(s,p.key,s.now);if(action)Engine.act(s,p.key,action,s.now);}}assert.equal(s.players[0].inventory,'boost');receive(t,clone(Engine.view(s,KEY)),1,0);}else receive(t,viewAt(s,100),1,0);
  const d=dispatch(type,type);assert.equal(t.noteInput(d),true);assert.equal(t.noteInput(d),false);
  assert.equal(t.resolveInput({token:d.token,receipt:{...receipt(d,1,101),playerKey:'wrong'}}),false);
  if(type==='item'){const initial=clone(s.players[0]),moving=t.sample(100);assert.equal(moving.mode,'project');near(moving.pose.distance,initial.distanceU/300+5*40/300);assert.equal(moving.pose.appliedInputNo,initial.appliedInputNo);assert.equal(moving.pose.inventory,'boost');assert.equal(moving.reconciliation,undefined);}
  assert.equal(t.resolveInput({token:d.token,outcome:'rejected'}),true);
 }
});

test('authoritative completion immediately stops prediction and cannot be reopened by old versions',()=>{
 const s=state(),t=createRunTimeline();receive(t,viewAt(s,100),1,0);const old=clone(Engine.view(s,KEY));Engine.forfeit(s,[KEY,'bot'],s.now+1);const done=Engine.view(s,KEY);receive(t,done,2,200);
 const result=t.sample(200);assert.equal(result.mode,'hold');assert.equal(result.reason,'authoritative-terminal');assert.equal(receive(t,old,1,300),false);assert.equal(t.sample(300).reason,'authoritative-terminal');
});

test('natural zero-hit engine finish never projects distance beyond 480 m or beyond the race deadline',()=>{
 const s=state(),t=createRunTimeline();let version=0,previous=null;
 for(let tick=0;tick<=6000&&s.status==='active';tick++){
  Engine.tick(s,at(s,tick));
  if(s.players[0].distanceU>=478*300&&!previous){previous=clone(Engine.view(s,KEY));receive(t,previous,++version,0);}
  for(const p of s.players){const action=Engine.botAction(s,p.key,s.now);if(action)Engine.act(s,p.key,action,s.now);}
 }
 assert.ok(previous);assert.equal(s.players[0].finishTick!==null,true);
 for(let ms=0;ms<=1000;ms+=10){const result=t.sample(ms);assert.ok(result.pose.distance<=480);assert.ok(result.displayTick<=Math.round((previous.deadlineAt-previous.startedAt)*.06));}
 const done=Engine.view(s,KEY);receive(t,done,++version,1001);const result=t.sample(1001);assert.equal(result.reason,'authoritative-terminal');near(result.pose.distance,480);
});


test('verified historical bridge crosses an expired old lease without renewing unverified extrapolation',()=>{
 const s=state(),t=createRunTimeline();receive(t,viewAt(s,100),1,0);near(t.sample(200).displayTick,112);
 receive(t,viewAt(s,130),2,600);const bridge=t.sample(700);assert.equal(bridge.mode,'project');near(bridge.displayTick,142);assert.equal(bridge.baseTick,130);
 const expired=t.sample(1300);assert.equal(expired.mode,'hold');assert.ok(expired.displayTick<=169);const frozen=expired.displayTick;
 receive(t,Engine.view(s,KEY),3,1400);near(t.sample(1500).displayTick,frozen);assert.equal(t.sample(1500).reason,'projection-expired');
});

test('a late first frame reaches only the original 39 tick endpoint, never a newly renewed horizon',()=>{
 const s=state(),t=createRunTimeline(),game=viewAt(s,100);receive(t,game,1,0);const late=t.sample(1000);assert.equal(late.mode,'hold');near(late.displayTick,139);
 receive(t,game,2,1100);near(t.sample(1200).displayTick,139);
});

test('applied lastInputTick differences cannot be hidden by ignoring future input metadata',()=>{
 const s=state(),t=createRunTimeline();Engine.tick(s,at(s,100));Engine.act(s,KEY,{type:'jump'},s.now);const original=viewAt(s,107);receive(t,original,1,0);
 const inconsistent=clone(original);inconsistent.selfPrediction.lastInputTick=106;receive(t,inconsistent,2,10);assert.equal(t.sample(10).mode,'resync');assert.equal(t.sample(10).baseVersion,2);
});

test('completed accepted input records are retired so a full race cannot exhaust 128 tracked inputs',()=>{
 const s=state(),t=createRunTimeline();let version=0,accepted=0;
 for(let tick=0;tick<=6000&&s.status==='active'&&accepted<140;tick++){
  const game=viewAt(s,tick),now=tick*1000/60;receive(t,game,++version,now);t.sample(now);
  const p=s.players[0],type=p.lane===0?'right':'left',probe=clone(s);
  try{Engine.act(probe,KEY,{type},probe.now);}catch{continue;}
  const d=dispatch('capacity-'+(accepted+1),type,now,accepted+1);assert.equal(t.noteInput(d),true,`input ${accepted+1} was not tracked`);
  const result=Engine.act(s,KEY,{type},s.now);accepted++;
  assert.equal(t.resolveInput({token:d.token,receipt:receipt(d,result.event.inputNo,result.event.acceptedTick),resolvedAtMs:now}),true);
  receive(t,clone(Engine.view(s,KEY)),++version,now);
 }
 assert.equal(accepted,140);
});


test('the tick-zero startup buffer occurs once and never extends the first authority lease',()=>{
 const s=state(),t=createRunTimeline(),g=Engine.view(s,KEY);receive(t,g,1,0);const initial=t.sample(50);assert.equal(initial.mode,'hold');assert.equal(initial.reason,'startup-buffer');near(initial.displayTick,0);
 receive(t,g,2,80);near(t.sample(100).pose.tick,0);near(t.sample(200).pose.tick,6);const expired=t.sample(650);assert.equal(expired.mode,'hold');near(expired.displayTick,34);near(expired.pose.tick,33);
 receive(t,g,3,1000);near(t.sample(1000).displayTick,34);assert.equal(t.sample(1000).reason,'projection-expired');
});


for(const animation of ['right','jump'])test(`accepted boost during a legal ${animation} preserves its visible phase without forward correction`,t=>{
 const {state:s}=createRunHeldBoostFixture();const originalTick=s.tick;
 // Both inputs go through normal engine admission, including the six-tick rate
 // limit. The source already contains the first animation, not a local guess.
 Engine.act(s,KEY,{type:animation},s.now);const g=viewAt(s,originalTick+2),timeline=createRunTimeline();receive(timeline,g,1,0);timeline.sample(0);
 const d=dispatch('animate-'+animation,'item',0);assert.equal(timeline.noteInput(d),true);
 Engine.tick(s,at(s,originalTick+6));const accepted=Engine.act(s,KEY,{type:'item'},s.now);assert.equal(s.players[0].pendingInput.item,'boost');
 const before=timeline.sample(100);assert.equal(before.mode,'project');near(before.displayTick,originalTick+8);
 assert.equal(timeline.resolveInput({token:d.token,receipt:receipt(d,accepted.event.inputNo,accepted.event.acceptedTick),resolvedAtMs:100}),true);
 const after=timeline.sample(100);assert.equal(after.mode,'project');assert.equal(after.reason,'accepted-boost-retime');for(const field of ['distance','x','y'])near(after.pose[field],before.pose[field]);assert.equal(after.reconciliation.preservedAnimation[animation==='jump'?'jump':'lane'],true);if(animation==='jump')near(after.pose.animationTick,before.pose.tick);
 t.diagnostic(JSON.stringify({animation,baseTick:g.snapshotTick,acceptedTick:accepted.event.acceptedTick,displayTick:after.displayTick,distanceCorrection:after.pose.distance-before.pose.distance,xBefore:before.pose.x,xAfter:after.pose.x,yBefore:before.pose.y,yAfter:after.pose.y}));
 assert.ok(after.pose.controlTick>=accepted.event.acceptedTick);assert.equal(after.pose.appliedInputNo,accepted.event.inputNo-1,'contact state is still before the causal input endpoint');assert.equal(timeline.sample(100+1000/60).pose.appliedInputNo,accepted.event.inputNo);assert.equal(after.pose.hits,0);
});

test('accepted boost needing more than six display ticks correction explicitly resynchronizes',()=>{
 const {state:s,game}=createRunHeldBoostFixture(),timeline=createRunTimeline();receive(timeline,game,1,0);timeline.sample(0);
 const d=dispatch('late-boost-limit','item',0);timeline.noteInput(d);const accepted=Engine.act(s,KEY,{type:'item'},s.now);
 // Just before the unchanged 650ms lease expires, a no-delay server accept has
 // accumulated > 100ms of phase difference. Never stretch the retime limit.
 const before=timeline.sample(640);assert.equal(before.mode,'project');
 assert.equal(timeline.resolveInput({token:d.token,receipt:receipt(d,accepted.event.inputNo,accepted.event.acceptedTick),resolvedAtMs:640}),true);
 const after=timeline.sample(640);assert.equal(after.mode,'resync');assert.equal(after.reason,'accepted-boost-retime-limit');assert.equal(after.reconciliation,undefined);
 assert.equal(RUN_MAX_BOOST_RETIME_MS,100);assert.equal(timeline.sample(651).reason,'projection-expired');
});

test('accepted boost correction keeps position exactly continuous and cannot renew the original time lease',()=>{
 const {state:s,game}=createRunHeldBoostFixture(),timeline=createRunTimeline();receive(timeline,game,1,0);timeline.sample(0);
 const d=dispatch('continuous-boost','item',0);timeline.noteInput(d);Engine.tick(s,at(s,s.tick+3));const accepted=Engine.act(s,KEY,{type:'item'},s.now);
 const before=timeline.sample(150);assert.equal(before.mode,'project');assert.equal(before.pose.inventory,'boost');
 timeline.resolveInput({token:d.token,receipt:receipt(d,accepted.event.inputNo,accepted.event.acceptedTick),resolvedAtMs:150});const after=timeline.sample(150);
 assert.equal(after.mode,'project');assert.equal(after.reason,'accepted-boost-retime');for(const field of ['distance','x','y','scale'])near(after.pose[field],before.pose[field]);
 assert.ok(after.reconciliation.rewindMs>0&&after.reconciliation.rewindMs<=100);assert.ok(after.displayTick<before.displayTick);assert.equal(after.reconciliation.observedAtMs,150);
 const moving=timeline.sample(250);near(moving.displayTick-after.displayTick,6);near(moving.pose.distance-after.pose.distance,.96);
 const expired=timeline.sample(650);assert.equal(expired.reason,'projection-expired');const stopped=expired.pose.distance;near(timeline.sample(900).pose.distance,stopped);
});

function airborneBoost({acceptedOffset=4,ackMs=100,dispatchMs=0}={}){
 const {state:s}=createRunHeldBoostFixture(),origin=s.tick;
 Engine.act(s,KEY,{type:'jump'},s.now);const game=viewAt(s,origin+2),timeline=createRunTimeline();receive(timeline,game,1,0);timeline.sample(0);
 const d=dispatch('airborne-phase','item',dispatchMs);timeline.noteInput(d);Engine.tick(s,at(s,game.snapshotTick+acceptedOffset));const accepted=Engine.act(s,KEY,{type:'item'},s.now);
 timeline.sample(ackMs);timeline.resolveInput({token:d.token,receipt:receipt(d,accepted.event.inputNo,accepted.event.acceptedTick),resolvedAtMs:ackMs});const corrected=timeline.sample(ackMs);
 assert.equal(corrected.mode,'project');assert.ok(corrected.pose.animationTick>corrected.pose.tick);return{s,timeline,game,corrected};
}

test('an expired retained jump phase stays frozen and continues safely from compatible new authority',()=>{
 const {s,timeline,game}=airborneBoost({acceptedOffset:30,ackMs:640,dispatchMs:500});
 const expired=timeline.sample(650);assert.equal(expired.reason,'projection-expired');assert.deepEqual(timeline.sample(900).pose,expired.pose);
 const newest=viewAt(s,game.snapshotTick+39);assert.equal(receive(timeline,newest,2,900),true);const restored=timeline.sample(900);assert.equal(restored.mode,'project');
 for(const field of ['x','y','distance','animationTick'])near(restored.pose[field],expired.pose[field]);
 let previous=restored,last;
 for(let elapsed=1000/60;elapsed<=400+1e-7;elapsed+=1000/60){
  last=timeline.sample(900+elapsed);assert.equal(last.mode,'project');assert.ok(last.pose.distance>=previous.pose.distance);assert.ok(last.pose.distance-previous.pose.distance<=.16+1e-7);assert.ok(last.pose.y>=0);
  assert.ok((last.pose.animationTick??last.pose.tick)>=(previous.pose.animationTick??previous.pose.tick));previous=last;
 }
 assert.equal(last.pose.y,0);assert.equal(last.pose.animationTick,undefined,'the old jump/land phase is removed only once its raw timeline reaches the natural end');
});

test('a newly accepted jump has its own animation identity and does not inherit the previous jump phase',()=>{
 const {s,timeline}=airborneBoost();let version=1;
 for(const [tick,ms]of [[1367,250],[1382,500]]){receive(timeline,viewAt(s,tick),++version,ms);assert.equal(timeline.sample(ms).mode,'project');}
 Engine.tick(s,at(s,1398));const next=Engine.act(s,KEY,{type:'jump'},s.now);assert.equal(next.event.acceptedTick,1399);
 receive(timeline,clone(Engine.view(s,KEY)),++version,750);assert.equal(timeline.sample(750).mode,'project');
 const newJump=timeline.sample(800+1000/60);assert.equal(newJump.mode,'project');assert.equal(newJump.pose.visualPlayer.jumpStartTick,1399);assert.equal(newJump.pose.animationTick,undefined);assert.ok(newJump.pose.y>0);
});

test('authoritative forfeiture clears retained visual animation immediately',()=>{
 const {s,timeline}=airborneBoost();Engine.forfeit(s,[KEY],s.now+1);receive(timeline,Engine.view(s,KEY),2,110);
 const ended=timeline.sample(110);assert.equal(ended.reason,'authoritative-terminal');assert.equal(ended.pose.animationTick,undefined);assert.equal(ended.pose.visualPlayer?.forfeited??true,true);
});


test('a real beam clears retained jump phase at impact, never at its fractional lookahead boundary',()=>{
 const {state:s}=createRunHeldBoostFixture();Engine.tick(s,at(s,1617));assert.equal(s.players[0].hits,0);assert.equal(s.players[0].inventory,'boost');
 // Continue normally in the safe left lane to the next beam, then admit jump
 // and boost through the real engine. No position, inventory or timer is set.
 Engine.act(s,KEY,{type:'jump'},s.now);const initial=viewAt(s,1619),timeline=createRunTimeline();receive(timeline,initial,1,0);timeline.sample(0);
 const d=dispatch('beam-phase','item',0);timeline.noteInput(d);Engine.tick(s,at(s,1623));const accepted=Engine.act(s,KEY,{type:'item'},s.now);
 timeline.sample(100);timeline.resolveInput({token:d.token,receipt:receipt(d,accepted.event.inputNo,accepted.event.acceptedTick),resolvedAtMs:100});const corrected=timeline.sample(100);assert.ok(corrected.pose.animationTick);
 let hitTick=null;for(let tick=s.tick+1;tick<=initial.snapshotTick+39;tick++){Engine.tick(s,at(s,tick));if(s.players[0].hits){hitTick=tick;break;}}
 assert.equal(hitTick,1630);assert.equal(s.players[0].lastEvent.type,'hit');assert.equal(s.players[0].lastEvent.tick,hitTick);
 const offset=corrected.reconciliation.preservedAnimation.offsetTicks,toMs=tick=>(tick+1-initial.snapshotTick+offset)*1000/60;
 const before=timeline.sample(toMs(hitTick-1));assert.ok(before.pose.animationTick);
 for(const fraction of [.006,.25,.5,.99]){
  const frame=timeline.sample(toMs(hitTick-1+fraction));assert.equal(frame.pose.boundary,'hit');assert.equal(frame.pose.hits,0);assert.equal(frame.pose.stunUntilTick,0);
  near(frame.pose.animationTick,frame.pose.tick+offset);assert.ok(frame.pose.y>=before.pose.y,'the future collision must not rewind the still-rising jump');
 }
 const impact=timeline.sample(toMs(hitTick));assert.equal(impact.pose.hits,1);assert.ok(impact.pose.stunUntilTick>impact.pose.tick);assert.equal(impact.pose.animationTick,undefined);
 near(impact.pose.y,Engine.pose(s.players[0],hitTick).y);const after=timeline.sample(toMs(hitTick+1));assert.equal(after.pose.animationTick,undefined);assert.equal(after.pose.hits,1);
});


test('ordinary receive, dispatch and accepted ACK after a RAF timestamp never accelerate its presentation clock',()=>{
 const {state:s}=createRunHeldBoostFixture();Engine.act(s,KEY,{type:'item'},s.now);const base=viewAt(s,s.tick+2),timeline=createRunTimeline();receive(timeline,base,1,0);timeline.sample(0);
 let previous=timeline.sample(16.7),previousAt=16.7;
 function frame(now){const next=timeline.sample(now);assert.equal(next.mode,'project');near(next.pose.distance-previous.pose.distance,9.6*(now-previousAt)/1000);near(next.displayTick-previous.displayTick,(now-previousAt)*.06);previous=next;previousAt=now;return next;}
 // Actual callback time is 1.6ms later than this RAF's timestamp. A fresh
 // authority still gets reconciled, without donating those 1.6ms to motion.
 const newer=viewAt(s,base.snapshotTick+1);receive(timeline,newer,2,35);frame(33.4);frame(50.1);
 const d=dispatch('future-raf-input','right',52);assert.equal(timeline.noteInput(d),true);frame(51);
 Engine.tick(s,at(s,base.snapshotTick+4));const accepted=Engine.act(s,KEY,{type:'right'},s.now);
 assert.equal(timeline.resolveInput({token:d.token,receipt:receipt(d,accepted.event.inputNo,accepted.event.acceptedTick),resolvedAtMs:70}),true);frame(66.8);frame(83.5);
 // A backdated callback cannot rewind time; same-tick authority cannot renew
 // the second basis's original35+650ms lease either.
 const held=timeline.sample(80);near(held.displayTick,previous.displayTick);const expired=timeline.sample(750);assert.equal(expired.reason,'projection-expired');assert.ok(expired.displayTick<=newer.snapshotTick+39);
 receive(timeline,newer,3,850);const refreshed=timeline.sample(900);assert.equal(refreshed.reason,'projection-expired');near(refreshed.displayTick,expired.displayTick);near(refreshed.pose.distance,expired.pose.distance);
});


test('wall lease expiry before raw39 stops visual speed without consuming another interval',()=>{
 const {state:s,game}=createRunHeldBoostFixture(),timeline=createRunTimeline();receive(timeline,game,1,0);timeline.sample(0);
 const d=dispatch('wall-speed-hold','item',0);timeline.noteInput(d);Engine.tick(s,at(s,s.tick+3));const accepted=Engine.act(s,KEY,{type:'item'},s.now);
 timeline.sample(150);timeline.resolveInput({token:d.token,receipt:receipt(d,accepted.event.inputNo,accepted.event.acceptedTick),resolvedAtMs:150});timeline.sample(150);
 const moving=timeline.sample(640);assert.equal(moving.mode,'project');near(moving.pose.visualSpeed,9.6);
 const frozen=timeline.sample(650);assert.equal(frozen.reason,'projection-expired');assert.ok(frozen.displayTick<game.snapshotTick+39);assert.equal(frozen.pose.visualSpeed,0);
 assert.deepEqual(timeline.sample(2000).pose,frozen.pose);assert.equal(frozen.pose.controlTick,frozen.displayTick);
});

test('suspension and unknown-contact hold stop animation speed while preserving exact transform and clocks',()=>{
 const s=state(),timeline=createRunTimeline();receive(timeline,viewAt(s,100),1,0);const moving=timeline.sample(100);assert.equal(moving.mode,'project');near(moving.pose.visualSpeed,8);
 timeline.suspend('background');const paused=timeline.sample(110);assert.equal(paused.mode,'hold');assert.equal(paused.reason,'background');assert.equal(paused.pose.visualSpeed,0);
 for(const field of ['x','y','distance','scale','tick','controlTick','eventTick'])assert.equal(paused.pose[field],moving.pose[field]);assert.deepEqual(timeline.sample(900).pose,paused.pose);
 const danger=state(2),waiting=createRunTimeline();receive(waiting,viewAt(danger,248),1,0);waiting.noteInput(dispatch('visual-speed-unknown','jump'));
 const held=waiting.sample(200);assert.equal(held.reason,'input-collision-uncertain');assert.equal(held.pose.visualSpeed,0);assert.equal(held.pose.fallUntilTick,null);
 const later=waiting.sample(800);assert.equal(later.pose.visualSpeed,0);for(const field of ['x','y','distance','scale','tick','controlTick','eventTick'])assert.equal(later.pose[field],held.pose[field]);
});
