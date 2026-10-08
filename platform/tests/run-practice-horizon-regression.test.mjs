import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../arena/run/engine.mjs';
import {createRunPracticeInputs,advanceRunPracticeInputs,applyRunPracticeInputs} from '../server/pvp/run-practice-inputs.mjs';
import {createRunPracticeController,RUN_PRACTICE_CONTROLLER_LIMITS as LIMITS} from '../arena/run/practice-controller.mjs';

// Mechanism fixture, not a replay of the Public01 browser command journal
// (that journal was not captured). The course and sole jump reproduce the
// observed own state naturally from tick zero. No position, timer, collision,
// score, or final pose is injected. The preceding receive clock is constructed
// to exercise a continuous display clock ahead of a newly received head.
const ROOM='horizon_room',SELF='self',MS=1000/60;
const OWN_FIELDS=['key','distanceU','checkpointU','lane','fromLane','changeStartTick','changeEndTick','jumpStartTick','slideUntilTick','stunUntilTick','immuneUntilTick','fallStartTick','fallUntilTick','shieldUntilTick','boostUntilTick','inventory','claimedItems','resolvedObstacles','hits','inputNo','appliedInputNo','lastInputTick','pendingInput','finishTick','finishedAt','forfeited'];
const copy=structuredClone;
const owned=p=>Object.fromEntries(OWN_FIELDS.map(key=>[key,copy(p[key])]));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const close=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1e-7,`${message}: ${actual} != ${expected}`);
const mine=e=>e.current.players.find(p=>p.key===SELF);
function advance(e,tick){
 while(e.serverTick<tick)e=advanceRunPracticeInputs(e,Math.min(tick,e.serverTick+120)).envelope;
 return e;
}
function submit(e,commands,baseRevision=e.revision){
 return applyRunPracticeInputs(e,{roomId:ROOM,playerKey:SELF,clockEpoch:1,baseRevision,commands},e.serverTick);
}
function fixture(){
 const state=engine.createState('00'.repeat(32),1000,{ruleVersion:engine.PRACTICE_INPUT_RULE_VERSION,
  startPolicy:engine.RUN_SCENE_READY_POLICY,practiceCourseId:'sunrise-arches',
  players:[{key:SELF,seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]});
 engine.armStart(state,1000);
 let e=createRunPracticeInputs({roomId:ROOM,playerKey:SELF,practice:true,entryMinor:'0',clockEpoch:1,state}).envelope;
 e=advance(e,37);
 const jump=submit(e,[{commandSeq:1,type:'jump',executeTick:13}]);
 assert.equal(jump.decisions[0].outcome,'accepted');
 assert.equal(jump.decisions[0].decidedAtServerTick,37);
 e=jump.envelope;
 const states=new Map();
 for(const tick of [3241,3270,3271,3317,3318,3390,3391,3393,3395,3396,3406,3485,3486]){
  e=advance(e,tick);states.set(tick,freeze(e));
 }
 return states;
}
const STATES=fixture();

// Same public own-proof shape as runInputAuthority, without importing its
// HTTP/security/worker dependency graph into a pure controller test.
function authority(e,version){
 const game=engine.view(e.current,SELF);game.resultCommitted=false;game.winnerKeys=[];
 return freeze({id:ROOM,game_id:'run',practice:true,entry_minor:'0',status:'active',me:SELF,version,game,
  run_inputs:{protocol:e.protocol,ruleVersion:engine.PRACTICE_INPUT_RULE_VERSION,roomId:ROOM,playerKey:SELF,clockEpoch:1,
   revision:e.revision,headTick:e.current.tick,serverTick:e.serverTick,committedThroughTick:e.committedThroughTick,
   processedThroughCommandSeq:e.lastCommandSeq,acceptedInputNo:mine(e).inputNo,decisions:[],correction:null,resultAuthorization:null,
   selfReplay:{schema:'run-practice-self-replay-v1',anchorTick:e.anchor.tick,player:owned(e.anchor.players.find(p=>p.key===SELF)),
    acceptedCommands:e.commands.map(({commandSeq,type,executeTick,acceptedInputNo})=>({commandSeq,type,executeTick,acceptedInputNo}))}}});
}
// Row times and room versions label the historical observation. Warm-up and
// recovery callback times below are synthetic, not inferred network arrivals.
const AT={warm:61226.56666666667,stale:62013,firstHold:63738.2,lastHold:64071.5,recovery:64088.2};
function controller(){
 const m=createRunPracticeController({roomId:ROOM,playerKey:SELF,clockEpoch:1,makeRequestId:()=> 'horizon_request'});
 assert.equal(m.receive({room:authority(STATES.get(3241),225),receivedAt:AT.warm}).ok,true);
 m.sample(AT.stale);
 assert.equal(m.receive({room:authority(STATES.get(3271),226),receivedAt:AT.stale}).ok,true);
 return m;
}

test('natural one-jump engine history produces the exact stun, cap position, and later real fall',()=>{
 const hit=STATES.get(3270),head=STATES.get(3271),p=mine(head);
 assert.equal(head.current.courseId,'sunrise-arches');
 assert.equal(p.inputNo,1);assert.equal(p.appliedInputNo,1);assert.equal(p.lastInputTick,13);
 assert.equal(p.distanceU,83240);assert.equal(p.stunUntilTick,3318);assert.equal(p.hits,15);
 assert.equal(p.fallUntilTick,null);assert.equal(p.finishTick,null);
 assert.ok(hit.current.events.some(e=>e.playerKey===SELF&&e.type==='hit'&&e.tick===3270));
 assert.equal(mine(STATES.get(3317)).distanceU,83240);
 assert.equal(mine(STATES.get(3318)).distanceU,83280,'stun ends at the shared physical tick, not before');
 assert.equal(mine(STATES.get(3390)).distanceU,86160);
 assert.equal(mine(STATES.get(3391)).distanceU,86200,'the engine itself can still move beyond visible tick3390');
 assert.equal(mine(STATES.get(3395)).fallUntilTick,null);
 const fall=mine(STATES.get(3396));
 assert.equal(fall.distanceU,86400);assert.equal(fall.fallStartTick,3396);assert.equal(fall.fallUntilTick,3486);assert.equal(fall.hits,16);
 assert.ok(STATES.get(3406).current.events.some(e=>e.playerKey===SELF&&e.type==='fall'&&e.tick===3396));
 assert.equal(mine(STATES.get(3485)).fallUntilTick,3486);
 assert.equal(mine(STATES.get(3486)).fallUntilTick,null,'real respawn still occurs at its original boundary');
});

test('head3271/v226 caps raw3391/visible3390 at287.2m for the observed333.3ms window',()=>{
 const m=controller(),before=JSON.stringify([...STATES]);
 const stale=m.sample(AT.stale+650);
 assert.equal(stale.authorityExpired,true);assert.equal(stale.mode,'provisional');assert.equal(stale.reason,null);
 assert.ok(stale.pose.visualSpeed>0,'650ms authority staleness is not the V2.3 motion cap');
 const moving=m.sample(63721.5);
 assert.equal(moving.mode,'provisional');assert.ok(moving.provisionalTick<3391);
 close(moving.pose.distance,287.1594666666667,'last moving distance');
 const samples=Array.from({length:21},(_,i)=>m.sample(AT.firstHold+(AT.lastHold-AT.firstHold)*i/20));
 close(AT.lastHold-AT.firstHold,333.3,'recorded plateau span');
 for(const sample of samples){
  assert.equal(sample.mode,'hold');assert.equal(sample.reason,'provisional-budget-expired');
  assert.equal(sample.headTick,3271);assert.equal(sample.provisionalTick,3391);assert.equal(sample.pose.tick,3390);
  assert.equal(sample.pose.distance,287.2);assert.equal(sample.pose.visualSpeed,0);
  assert.equal(sample.pose.visualPlayer.fallUntilTick,null);assert.equal(sample.pose.visualPlayer.hits,15);
  assert.equal(sample.resultAuthorization,null);
 }
 assert.ok(AT.firstHold<samples[0].hardDeadline,'tick cap expires before the wall deadline');
 assert.ok(AT.lastHold>samples[0].hardDeadline,'the same plateau later also spans the wall deadline');
 assert.equal(m.stateAtTick(3390).distanceU,86160);assert.equal(m.stateAtTick(3392),null);
 assert.equal(m.enqueue('jump',AT.lastHold).reason,'provisional-budget-expired');
 assert.equal(m.state().outbox.lastCommandSeq,1,'blocked gesture creates no command/receipt');
 assert.equal(JSON.stringify([...STATES]),before,'client simulation never mutates any authoritative history');
});

test('head3406/v235 resumes from the capped clock without a forward jump, then shows real tick3396 fall',()=>{
 const m=controller();const held=m.sample(AT.lastHold);
 assert.equal(m.receive({room:authority(STATES.get(3406),235),receivedAt:AT.recovery}).ok,true);
 const resume=m.sample(AT.recovery);
 assert.equal(resume.mode,'provisional');assert.equal(resume.reason,null);
 assert.equal(resume.clockReset.reason,'budget-resume');assert.equal(resume.provisionalTick,3391);
 assert.equal(resume.pose.distance,held.pose.distance,'new authority does not jump directly to its288m head');
 assert.equal(resume.hardDeadline,AT.recovery+2000);assert.equal(resume.resultAuthorization,null);
 for(const tick of [3390,3391,3395,3396,3406]){
  const {tick:projectedTick,...actual}=m.stateAtTick(tick);
  assert.equal(projectedTick,tick);assert.deepEqual(actual,owned(mine(STATES.get(tick))),`actual core state at tick${tick}`);
 }
 let previous=resume;
 for(let frame=1;frame<=5;frame++){
  const sample=m.sample(AT.recovery+frame*MS);
  assert.ok(sample.pose.distance>=previous.pose.distance);
  assert.ok(sample.pose.distance-previous.pose.distance<=8*MS/1000+1e-7,'no frozen-time catch-up speed');
  assert.equal(sample.pose.visualPlayer.fallUntilTick,null,'causal pose never shows the future fall early');
  previous=sample;
 }
 const fallen=m.sample(AT.recovery+6*MS);
 assert.equal(fallen.pose.tick,3396);assert.equal(fallen.pose.distance,288);
 assert.equal(fallen.pose.visualPlayer.fallUntilTick,3486);assert.equal(fallen.pose.visualPlayer.hits,16);
 assert.equal(fallen.mode,'provisional');assert.equal(fallen.reason,null,'real fall is not mislabelled as a budget hold');
 assert.equal(fallen.pose.visualSpeed,0);assert.equal(fallen.resultAuthorization,null);
});

test('duplicate head/room-version metadata cannot renew the exhausted trajectory',()=>{
 const m=controller(),held=m.sample(AT.lastHold),deadline=m.state().hardDeadline;
 const repeated=m.receive({room:authority(STATES.get(3271),227),receivedAt:AT.lastHold+1});
 assert.deepEqual(repeated,{ok:false,reason:'old-authority'});
 assert.equal(m.state().hardDeadline,deadline);
 const later=m.sample(AT.lastHold+500);
 assert.equal(later.mode,'hold');assert.equal(later.reason,'provisional-budget-expired');
 assert.deepEqual(later.pose,held.pose);
 assert.equal(m.enqueue('right',AT.lastHold+500).reason,'provisional-budget-expired');
});

test('the same server history keeps the120tick commit watermark and rejects expired/future input',()=>{
 const head=STATES.get(3406),before=JSON.stringify(head);
 assert.equal(head.committedThroughTick,3286);assert.equal(head.anchor.tick,3286);
 const denied=submit(head,[{commandSeq:2,type:'jump',executeTick:3286},{commandSeq:3,type:'jump',executeTick:3408}]);
 assert.deepEqual(denied.decisions.map(d=>[d.outcome,d.code,d.acceptedInputNo]),[
  ['rejected','INPUT_EXPIRED',null],['rejected','FUTURE_INPUT',null]]);
 assert.deepEqual(denied.envelope.current,head.current);
 assert.equal(denied.envelope.lastCommandSeq,3);assert.equal(mine(denied.envelope).inputNo,1);
 assert.equal(JSON.stringify(head),before);
 assert.throws(()=>submit(head,[{commandSeq:2,type:'jump',executeTick:3394}],STATES.get(3241).revision),{code:'BASE_REVISION_EXPIRED'});
 assert.equal(LIMITS.historyTicks,120);assert.equal(LIMITS.futureTicks,120);assert.equal(LIMITS.provisionalMs,2000);
});

test('a genuinely admissible late jump may repair the fall only before its execution tick commits',()=>{
 const command={commandSeq:2,type:'jump',executeTick:3394};
 const late=submit(STATES.get(3406),[command]);
 assert.equal(late.decisions[0].outcome,'accepted');assert.equal(late.decisions[0].acceptedInputNo,2);
 assert.equal(late.correction.fromTick,3394);assert.equal(mine(late.envelope).fallUntilTick,null);
 const onTime=advance(submit(STATES.get(3393),[command]).envelope,3406);
 assert.deepEqual(late.envelope.current,onTime.current,'late replay equals timely actual engine admission');
 const committed=advance(STATES.get(3406),3514);
 assert.equal(committed.committedThroughTick,3394);
 const denied=submit(committed,[command]);
 assert.equal(denied.decisions[0].code,'INPUT_EXPIRED');assert.equal(denied.decisions[0].acceptedInputNo,null);
 assert.deepEqual(denied.envelope.current,committed.current,'committed physics cannot be rewritten');
});
