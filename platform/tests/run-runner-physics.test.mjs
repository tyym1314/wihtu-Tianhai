import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as Engine from '../arena/run/engine.mjs';
import * as V1 from '../arena/run/engine-v1.mjs';
import {RUN_RULES,runnerPose,stepRunnerInPlace} from '../arena/run/runner-physics.mjs';
import {resolveRunCourse} from '../arena/run/courses.mjs';
import {runRequiresSceneReady} from '../arena/run/start-policy.mjs';

// Keep the oracle byte-for-byte frozen. Only its relative import specifiers are
// resolved in memory, so it executes the old independent single-player logic.
const frozen = await readFile(new URL('./fixtures/run-engine-before-runner-physics.mjs', import.meta.url), 'utf8');
const ORIGINAL_SHA='0c102a4160114510e20959a9f276186be5867247e93c4d1bfe5c098706b4c5e8';
const executable=frozen.replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL(path,new URL('../arena/run/engine.mjs',import.meta.url)).href}'`);
const Before=await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);
const sha=value=>createHash('sha256').update(value).digest('hex');
const clone=structuredClone;
const versions=[Engine.PREVIOUS_RULE_VERSION,Engine.RULE_VERSION,Engine.PRACTICE_RULE_VERSION];
const seed=(index,suffix='0')=>index.toString(16).padStart(8,'0')+suffix.repeat(56);
const roster=count=>Array.from({length:count},(_,seatIndex)=>({key:`p${seatIndex}`,seatIndex,isBot:seatIndex>0}));
const tickTime=(state,tick)=>state.startedAt+Math.ceil(tick*1000/60);
function makePair(index=0,version=Engine.RULE_VERSION,count=4,suffix='0'){
 const options={players:roster(count),ruleVersion:version,...(runRequiresSceneReady(version)?{startPolicy:Engine.RUN_SCENE_READY_POLICY}:{})};
 const actual=Engine.createState(seed(index,suffix),1000,options),expected=Before.createState(seed(index,suffix),1000,options);
 if(runRequiresSceneReady(version)){Engine.armStart(actual,1001);Before.armStart(expected,1001);Engine.tick(actual,actual.startedAt);Before.tick(expected,expected.startedAt);}
 assert.deepEqual(actual,expected);
 return{actual,expected};
}
function compareViews(actual,expected){
 assert.deepEqual(Engine.rank(actual),Before.rank(expected));
 for(const p of actual.players){
  const view=Engine.view(actual,p.key),old=Before.view(expected,p.key);
  if(runRequiresSceneReady(actual.ruleVersion)){
   assert.deepEqual(view.selfPrediction,{schema:'run-self-projection-v1',resolvedObstacles:p.resolvedObstacles,pendingInput:p.pendingInput,lastInputTick:p.lastInputTick});
   delete view.selfPrediction;
  }else assert.equal('selfPrediction' in view,false);
  assert.deepEqual(view,old);
 }
}
function stepPair(pair,tick){
 const {actual,expected}=pair,at=tickTime(actual,tick);
 assert.deepEqual(Engine.tick(actual,at),Before.tick(expected,at));
 assert.deepEqual(actual,expected);
 if(tick%60===0||actual.status!=='active')compareViews(actual,expected);
}
const place=(p,distance,lane=1)=>Object.assign(p,{distanceU:Math.round(distance*300),checkpointU:Math.floor(distance/30)*9000,lane,fromLane:lane,changeStartTick:0,changeEndTick:0});

// Full internal state equality includes integer distance, global event serials,
// ordered event tails, finish times, rank, deadlines, and terminal outcomes.
test('frozen oracle and V1 bytes are fixed; aliases retain exact rule values',async()=>{
 assert.equal(sha(frozen),ORIGINAL_SHA);
 assert.equal(sha(await readFile(new URL('../arena/run/engine-v1.mjs',import.meta.url))),'ba76faf8b498288dddf9fb2d6c8848cca11e19b0517bceef0ad63b36dea0ad21');
 assert.equal(Engine.RULES,RUN_RULES);assert.equal(Engine.pose,runnerPose);assert.ok(Object.isFrozen(RUN_RULES));assert.deepEqual(RUN_RULES,Before.RULES);
});

for(const version of versions)for(let courseIndex=0;courseIndex<6;courseIndex++){
 test(`${version} course ${courseIndex}: every tick and legal bot input matches frozen engine through finish`,()=>{
  let pair=makePair(courseIndex,version,2+courseIndex%3,courseIndex%2?'a':'f');
  for(let tick=0;tick<=6000&&pair.actual.status==='active';tick++){
   stepPair(pair,tick);
   for(const player of pair.expected.players){
    const action=Before.botAction(pair.expected,player.key,pair.expected.now);
    assert.deepEqual(Engine.botAction(pair.actual,player.key,pair.actual.now),action);
    if(action){assert.deepEqual(Engine.act(pair.actual,player.key,action,pair.actual.now),Before.act(pair.expected,player.key,action,pair.expected.now));assert.deepEqual(pair.actual,pair.expected);}
   }
   if(tick%179===0)pair={actual:JSON.parse(JSON.stringify(pair.actual)),expected:JSON.parse(JSON.stringify(pair.expected))};
  }
  assert.equal(pair.actual.status,'finished');assert.ok(pair.actual.players.every(p=>p.finishTick!==null&&p.hits===0));compareViews(pair.actual,pair.expected);
 });
}

for(const version of versions)test(`${version}: idle full race on six independently seeded routes preserves falls, respawns and timeout`,()=>{
 for(let course=0;course<6;course++){
  const pair=makePair(course+6,version,2,'7');
  for(let tick=1;tick<=6000&&pair.actual.status==='active';tick++)stepPair(pair,tick);
  assert.equal(pair.actual.status,'finished');assert.ok(pair.actual.players.every(p=>p.hits>0));compareViews(pair.actual,pair.expected);
 }
});

const scenarios={
 hit:(p,c)=>{const o=c.obstacles[0];place(p,o.z-.4,o.lane);},
 immune:(p,c)=>{scenarios.hit(p,c);p.immuneUntilTick=110;},
 shield:(p,c)=>{scenarios.hit(p,c);p.inventory='shield';p.pendingInput={type:'item',tick:1,no:1,item:'shield'};},
 expiredShield:(p,c)=>{scenarios.hit(p,c);p.shieldUntilTick=1;},
 jump:(p,c)=>{const o=c.obstacles.find(o=>o.type==='crate');place(p,o.z-.4,o.lane);p.jumpStartTick=-23;},
 slide:(p,c)=>{const o=c.obstacles.find(o=>o.type==='beam');place(p,o.z-.4,o.lane);p.pendingInput={type:'slide',tick:1,no:1,item:null};},
 gap:(p,c)=>{const g=c.gaps[0];place(p,g.start-.02,g.lanes[0]);p.shieldUntilTick=500;},
 respawn:(p,c)=>{const g=c.gaps[0];place(p,g.start+1,g.lanes[0]);p.fallStartTick=-89;p.fallUntilTick=1;p.resolvedObstacles=c.obstacles.slice(0,9).map(o=>o.id);p.jumpStartTick=-2;p.slideUntilTick=50;},
 stun:(p,c)=>{place(p,10);p.stunUntilTick=49;p.pendingInput={type:'left',tick:1,no:2,item:null};},
 futureInput:p=>{place(p,10);p.pendingInput={type:'jump',tick:12,no:1,item:null};},
 boost:p=>{place(p,10);p.inventory='boost';p.pendingInput={type:'item',tick:1,no:1,item:'boost'};},
 expiredBoost:p=>{place(p,10);p.boostUntilTick=1;},
 pickup:(p,c)=>place(p,c.items[0].z-.02),
 skippedItem:(p,c)=>{scenarios.pickup(p,c);p.inventory='boost';},
 claimedItem:(p,c)=>{scenarios.pickup(p,c);p.claimedItems.push(c.items[0].id);},
 finish:(p,c)=>place(p,c.trackLength-40/300),
 alreadyFinished:(p,c)=>{place(p,c.trackLength);p.finishTick=0;p.finishedAt=1000;},
 forfeited:p=>{p.forfeited=true;p.pendingInput={type:'right',tick:1,no:1,item:null};},
};
for(const version of versions)test(`${version}: isolated hazard, item and finish boundaries match frozen per-player behavior`,()=>{
 for(let courseIndex=0;courseIndex<6;courseIndex++)for(const [name,configure] of Object.entries(scenarios)){
  const pair=makePair(courseIndex,version),course=resolveRunCourse(pair.actual);
  configure(pair.actual.players[0],course);configure(pair.expected.players[0],course);
  for(let tick=1;tick<=185&&pair.actual.status==='active';tick++){
   stepPair(pair,tick);
   assert.deepEqual(runnerPose(pair.actual.players[0],tick+.375),Before.pose(pair.expected.players[0],tick+.375),`${name} fractional pose`);
  }
  compareViews(pair.actual,pair.expected);
 }
});

test('single-player step owns only supplied player; callbacks preserve ordering and exact fractional finish time',()=>{
 const {actual}=makePair(),course=resolveRunCourse(actual),stateBefore=clone(actual),owned=clone(actual.players[0]),events=[];
 owned.distanceU=course.trackLength*300-40;owned.checkpointU=450*300;owned.inventory='shield';owned.pendingInput={type:'item',tick:1,no:1,item:'shield'};
 const exactAt=actual.startedAt+1000/60;
 stepRunnerInPlace(owned,1,course,{at:exactAt,emit:(type,extra)=>events.push({type,...extra})});
 assert.deepEqual(actual,stateBefore);assert.equal(owned.distanceU,course.trackLength*300);assert.equal(owned.finishedAt,exactAt);
 assert.deepEqual(events,[{type:'item_used',inputNo:1,item:'shield'},{type:'finish'}]);assert.equal(owned.lastEvent,null);
 const saved=clone(owned);stepRunnerInPlace(owned,2,course,{at:exactAt+1000/60,emit:()=>assert.fail('finished runner emitted')});assert.deepEqual(owned,saved);
});

for(const version of [Engine.RULE_VERSION,Engine.PRACTICE_RULE_VERSION])test(`${version}: prediction fields are own-only, detached and refresh after same-tick acceptance`,()=>{
 const {actual}=makePair(0,version),own=actual.players[0],other=actual.players[1];
 own.resolvedObstacles.push('own-resolved');other.resolvedObstacles.push('other-private');other.lastInputTick=91;other.pendingInput={type:'left',tick:99,no:81,item:null};
 const initial=Engine.view(actual,own.key),beforeTick=initial.snapshotTick;
 assert.deepEqual(Object.keys(initial.selfPrediction).sort(),['lastInputTick','pendingInput','resolvedObstacles','schema']);
 assert.equal(initial.selfPrediction.pendingInput,null);assert.equal(initial.selfPrediction.lastInputTick,-RUN_RULES.inputRateTicks);
 assert.ok(!JSON.stringify(initial.selfPrediction).includes('other-private'));
 for(const player of initial.players){assert.equal('pendingInput' in player,false);assert.equal('resolvedObstacles' in player,false);assert.equal('lastInputTick' in player,false);}
 const accepted=Engine.act(actual,own.key,{type:'jump',observed_tick:beforeTick},actual.now),updated=Engine.view(actual,own.key);
 assert.equal(updated.snapshotTick,beforeTick);assert.equal(accepted.event.acceptedTick,beforeTick+1);
 assert.deepEqual(updated.selfPrediction.pendingInput,{type:'jump',tick:beforeTick+1,no:1,item:null});assert.equal(updated.selfPrediction.lastInputTick,beforeTick+1);
 assert.equal(updated.players[0].appliedInputNo,0);assert.equal(updated.players[0].jumpStartTick,null);
 updated.selfPrediction.pendingInput.type='slide';updated.selfPrediction.resolvedObstacles.push('foreign');updated.selfPrediction.lastInputTick=999;
 assert.equal(own.pendingInput.type,'jump');assert.deepEqual(own.resolvedObstacles,['own-resolved']);assert.equal(own.lastInputTick,beforeTick+1);
 assert.equal(initial.selfPrediction.pendingInput,null);assert.deepEqual(Engine.view(actual,other.key).selfPrediction.resolvedObstacles,['other-private']);
 Engine.tick(actual,tickTime(actual,1));const applied=Engine.view(actual,own.key);
 assert.equal(applied.selfPrediction.pendingInput,null);assert.equal(applied.players[0].appliedInputNo,1);assert.equal(applied.players[0].jumpStartTick,1);
});

test('legacy and v2.0 public views retain exactly their frozen contract',()=>{
 for(const version of [V1.RULE_VERSION,Engine.PREVIOUS_RULE_VERSION]){
  const pair=makePair(3,version,2);compareViews(pair.actual,pair.expected);
  assert.deepEqual(Engine.act(pair.actual,'p0',{type:'jump'},pair.actual.now),Before.act(pair.expected,'p0',{type:'jump'},pair.expected.now));
  compareViews(pair.actual,pair.expected);for(let tick=1;tick<180;tick++)stepPair(pair,tick);
 }
});

for(const version of versions)test(`${version}: tied finishes, terminal forfeits, finish window and clock shifts retain outer engine behavior`,()=>{
 for(const mode of ['ties','forfeit-all','finish-and-forfeit','finish-window']){
  const pair=makePair(4,version),course=resolveRunCourse(pair.actual);
  if(mode!=='forfeit-all')for(const s of [pair.actual,pair.expected]){
   place(s.players[0],course.trackLength-40/300);
   if(mode==='ties')place(s.players[1],course.trackLength-40/300);
  }
  if(mode==='forfeit-all'||mode==='finish-and-forfeit'){
   const keys=pair.actual.players.map(p=>p.key),now=tickTime(pair.actual,1);
   assert.deepEqual(Engine.forfeit(pair.actual,keys,now),Before.forfeit(pair.expected,keys,now));
  }else{
   stepPair(pair,1);Engine.shiftTime(pair.actual,1234);Before.shiftTime(pair.expected,1234);assert.deepEqual(pair.actual,pair.expected);
   for(let tick=2;tick<=901&&pair.actual.status==='active';tick++)stepPair(pair,tick);
  }
  assert.equal(pair.actual.status,'finished');assert.deepEqual(pair.actual,pair.expected);compareViews(pair.actual,pair.expected);
 }
});
