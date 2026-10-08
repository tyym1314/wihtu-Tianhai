import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../arena/run/engine.mjs';
import {createRunSelfProjection} from '../arena/run/self-projection.mjs';
import {createRunTimeline} from '../arena/run/timeline.mjs';
import {resolveRunCourse} from '../arena/run/courses.mjs';
const STEP=1000/60,ROOM='causal-room',KEY='self';
const near=(a,b,message='')=>assert.ok(Math.abs(a-b)<1e-7,`${message}: ${a} != ${b}`);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
function initial(distance=31){
 const s=E.createState('00000000'.padEnd(64,'0'),1000,{ruleVersion:E.PRACTICE_RULE_VERSION,startPolicy:E.RUN_SCENE_READY_POLICY,players:[{key:KEY,seatIndex:0},{key:'other',seatIndex:1,isBot:true}]});
 E.armStart(s,1000);E.tick(s,s.startedAt);s.tick=500;s.now=s.startedAt+Math.ceil(s.tick*STEP);const p=s.players[0];p.distanceU=Math.round(distance*300);p.checkpointU=Math.floor(distance/30)*9000;return s;
}
function game(s){return freeze(structuredClone(E.view(s,KEY)));}
function projection(s,version=1){const p=createRunSelfProjection();assert.equal(p.update(game(s),KEY,{roomId:ROOM,roomVersion:version}),true);return p;}
function advance(s,tick){while(s.tick<tick)E.testing.step(s);return game(s);}
const receive=(t,g,version,at)=>assert.equal(t.receive(g,KEY,{roomId:ROOM,roomVersion:version,receivedAtMs:at}),true);
const sample=(p,t,base=500,options)=>p.sampleCausal((t-base)*STEP,options);

test('causal recovery has no early travel, reset jump or overspeed across three RAF phases and periods',()=>{
 for(const boostUntil of [0,503,505,650]){
  const s=initial();s.players[0].stunUntilTick=503;s.players[0].boostUntilTick=boostUntil;
  const p=projection(s),before=JSON.stringify(game(s));
  for(const dt of [8.3,16.6,33])for(const phase of [.01,.38,.96]){
   let last=sample(p,501+phase);
   for(let tick=501+phase+dt/STEP;tick<514;tick+=dt/STEP){
    const now=sample(p,tick);assert.ok(now.distance>=last.distance-1e-8);assert.ok(now.distance-last.distance<=9.6*dt/1000+1e-8);
    if(tick<503)near(now.distance,31);near(now.controlTick-now.tick,1);near(now.eventTick,now.tick);last=now;
   }
  }
  near(sample(p,503).distance,31);near(sample(p,503).visualSpeed,boostUntil>503?9.6:8);
  const raw=p.stateAtTick(503);near(sample(p,504).distance,raw.distanceU/300);assert.ok(raw.distanceU>31*300);
  assert.equal(sample(p,503.5).visualPlayer.stunUntilTick,503);assert.equal(sample(p,503.5).controlTick<503,false);assert.equal(sample(p,503.5).tick<503,true);
  assert.equal(JSON.stringify(game(s)),before);
 }
});

test('causal two-frame predecessor preserves exact recovery phase across newer and same-tick bases',()=>{
 for(const fraction of [-.01,0,.01,.38,.96]){
  const s=initial();s.players[0].stunUntilTick=503;const g=game(s),before=JSON.stringify(g),t=createRunTimeline(),p=projection(s);receive(t,g,1,0);t.sample(0);
  const at=(3+fraction)*STEP,expected=sample(p,503+fraction);t.sample(at);
  receive(t,advance(s,503),2,at);const first=t.sample(at);assert.equal(first.mode,'project');near(first.pose.distance,expected.distance);near(first.pose.x,expected.x);near(first.pose.y,expected.y);
  receive(t,game(s),3,at);const same=t.sample(at);near(same.pose.distance,expected.distance);assert.equal(same.mode,'project');
  assert.equal(t.receive(g,KEY,{roomId:ROOM,roomVersion:2,receivedAtMs:at}),false);near(t.sample(at).pose.distance,expected.distance);
  const later=t.sample(at+STEP);near(later.pose.distance,sample(p,504+fraction).distance);assert.equal(later.mode,'project');assert.equal(JSON.stringify(g),before);
 }
});

test('owned causal endpoints and all clocks stay frozen at the existing 650ms/39tick cap',()=>{
 const p=projection(initial());const end=p.sampleCausal(650);assert.equal(end.controlTick,539);assert.equal(end.tick,538);assert.equal(end.visualSpeed,0);assert.deepEqual(p.sampleCausal(1e6),end);
 assert.equal(p.stateAtTick(540),null);assert.equal(p.frameAtTick(540),null);assert.ok(Object.isFrozen(p.frameAtTick(539)));assert.ok(Object.isFrozen(p.frameAtTick(539).visualPlayer));
 const s=initial(),t=createRunTimeline();receive(t,game(s),1,0);t.sample(640);receive(t,game(s),2,640);const stopped=t.sample(650);assert.equal(stopped.reason,'projection-expired');assert.deepEqual(t.sample(1000).pose,stopped.pose);
});

test('pickup remains continuous and contact metadata changes only at the causal endpoint',()=>{
 const s=initial(59.5),p=projection(s);let T=null;
 for(let tick=501;tick<539;tick++)if(p.frameAtTick(tick).claimedItemCount>p.frameAtTick(tick-1).claimedItemCount){T=tick;break;}
 assert.ok(T);const before=sample(p,T-.9),after=sample(p,T+.096);near(after.distance-before.distance,.996*40/300);assert.equal(after.claimedItemCount,0);assert.deepEqual(after.visualPlayer.claimedItems,[]);
 const reached=sample(p,T+1);assert.equal(reached.claimedItemCount,1);assert.equal(reached.visualPlayer.claimedItems.length,1);assert.equal(reached.eventTick,T);
});

test('finish-only approach is continuous at 120Hz with no early predicted winner or 480m overshoot',()=>{
 const s=initial(479.8),p=projection(s),T=502;assert.equal(p.frameAtTick(T).boundary,'finish');assert.deepEqual(p.frameAtTick(T).boundaryEvents,['finish']);
 let last=sample(p,500);for(let tick=500.498;tick<506;tick+=.498){const now=sample(p,tick);assert.ok(now.distance-last.distance<=9.6*.498/60+1e-8);assert.ok(now.distance<=480);if(tick<T+1)assert.equal(now.finishTick,null);assert.equal(now.visualPlayer.finishTick,null);last=now;}
 assert.equal(sample(p,T+1).distance,480);assert.equal(sample(p,T+1).finishTick,T);assert.equal(sample(p,T+1).visualSpeed,0);
});

test('proved received finish continues to the causal endpoint instead of snapping to latest authority',()=>{
 const s=initial(479.8),t=createRunTimeline();receive(t,game(s),1,0);t.sample(0);const at=.75*STEP,before=t.sample(at);receive(t,advance(s,502),2,at);
 const same=t.sample(at);assert.equal(same.mode,'project');near(same.pose.distance,before.pose.distance);assert.equal(same.pose.visualPlayer.finishTick,null);
 let last=same;for(let now=at+8.3;now<100;now+=8.3){const next=t.sample(now);assert.ok(next.pose.distance-last.pose.distance<=9.6*8.3/1000+1e-8);assert.ok(next.pose.distance<=480);if(next.pose.eventTick<502)assert.equal(next.pose.visualPlayer.finishTick,null);last=next;}
 assert.equal(last.reason,'authoritative-terminal');assert.equal(last.pose.visualPlayer.finishTick,502);assert.equal(last.pose.distance,480);
});

test('recovery coincident with a real gap keeps the stronger physical boundary and never blends across it',()=>{
 const s=initial(),gap=resolveRunCourse(s).gaps[0],p=s.players[0];p.distanceU=Math.round((gap.start-.27*.35-.04)*300);p.checkpointU=Math.floor(p.distanceU/9000)*9000;p.lane=p.fromLane=gap.lanes[0];p.stunUntilTick=501;
 const projected=projection(s);assert.equal(projected.frameAtTick(501).boundary,'fall');assert.deepEqual(projected.frameAtTick(501).boundaryEvents,['fall']);
 const left=sample(projected,501),half=sample(projected,501.5),right=sample(projected,502);for(const field of ['x','y','distance','scale','hits','fallUntilTick'])assert.equal(half[field],left[field]);
 assert.equal(half.eventTick,500.5);assert.equal(half.visualSpeed,0);assert.equal(right.eventTick,501);assert.notEqual(right.fallUntilTick,null);assert.equal(right.hits,1);
});
