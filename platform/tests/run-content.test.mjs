import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../arena/run/engine.mjs';
import * as V1 from '../arena/run/engine-v1.mjs';
import {RUN_COURSES,RUN_COURSES_V21,SAFE_INTRO_CONTENT_VERSION,SAFE_INTRO_METERS,resolveRunCourse,courseGapAt} from '../arena/run/courses.mjs';
import {executeEngineTask} from '../server/pvp/engine-worker.mjs';
const clone=x=>JSON.parse(JSON.stringify(x));
const roster=n=>Array.from({length:n},(_,seatIndex)=>({key:`p${seatIndex}`,seatIndex,isBot:true}));
const seed=i=>i.toString(16).padStart(8,'0').padEnd(64,'0');
function race(index,{step=17,boost=true,worker=false,count=2,ruleVersion=E.PREVIOUS_RULE_VERSION}={}){
 const fair=ruleVersion===E.RULE_VERSION;
 let state=E.createState(seed(index),0,{players:roster(count),ruleVersion,...(fair?{startPolicy:E.RUN_SCENE_READY_POLICY}:{})}),bots=state.players.map(p=>({key:p.key,lastBotAt:0})),inputs=[];
 if(fair)E.armStart(state,0);
 for(let now=state.startedAt;now<=state.startedAt+100000&&state.status==='active';now+=step){
  if(worker){const result=executeEngineTask({kind:'advance',gameId:'run',ruleVersion:state.ruleVersion,state,now,bots});state=result.state;for(const update of result.botUpdates){bots.find(b=>b.key===update.key).lastBotAt=update.lastBotAt;inputs.push(update.lastEvent);}}
  else{E.tick(state,now);for(const p of state.players){const action=E.botAction(state,p.key,now);if(action&&(boost||!['boost','item'].includes(action.type))){const result=E.act(state,p.key,action,now);inputs.push(result.event);}}}
  if(now%170===0)state=clone(state);
 }
 return{state,inputs};
}
test('six authored courses remain distinct after mirror normalization, with three challenge paces',()=>{
 assert.equal(RUN_COURSES.length,6);assert.deepEqual([...new Set(RUN_COURSES.map(c=>c.difficulty))],[1,2,3]);
 const signature=(c,mirror)=>JSON.stringify({o:c.obstacles.map(o=>[o.z,o.type,mirror?2-o.lane:o.lane]).sort(),g:c.gaps.map(g=>[g.start,g.end,g.lanes.map(l=>mirror?2-l:l).sort()]).sort()});
 const normalized=RUN_COURSES.map(c=>[signature(c,false),signature(c,true)].sort()[0]);assert.equal(new Set(normalized).size,6);
 const density=RUN_COURSES.map(c=>({tier:c.difficulty,events:new Set(c.obstacles.map(o=>o.z)).size+c.gaps.length}));
 for(let tier=1;tier<3;tier++)assert.ok(Math.max(...density.filter(c=>c.tier===tier).map(c=>c.events))<Math.min(...density.filter(c=>c.tier===tier+1).map(c=>c.events)));
 for(const c of RUN_COURSES)for(const cp of c.checkpoints)for(const x of [-1.5,0,1.5]){assert.equal(courseGapAt(c,x,cp),undefined);assert.ok(!c.obstacles.some(o=>Math.abs(o.z-cp)<1&&Math.abs(o.x-x)<.4));}
});
test('all routes have complete legal zero-hit traces, both with and without boost, and meaningful idle failures',()=>{
 for(let i=0;i<6;i++)for(const boost of [false,true]){
  const {state,inputs}=race(i,{boost}),p=state.players[0];assert.ok(p.finishTick!==null,`${state.courseId} did not finish`);assert.equal(p.hits,0,state.courseId);assert.equal(state.status,'finished');assert.ok(inputs.some(x=>x.input==='jump'));assert.ok(inputs.some(x=>x.input==='slide'));
  const idle=E.createState(seed(i),0,{players:roster(2)});E.tick(idle,100000);assert.equal(idle.players[0].finishTick,null);assert.ok(idle.players[0].hits>0);
  assert.deepEqual(state.players.map(p=>p.finishTick),state.players.map(()=>p.finishTick));
 }
});
test('v2.1 intro is hazard-free for 30 m on all six routes, with six complete legal traces and idle failures',()=>{
 assert.equal(RUN_COURSES_V21.length,6);
 for(let i=0;i<6;i++){
  const old=RUN_COURSES[i],course=RUN_COURSES_V21[i];
  assert.equal(course.id,old.id);assert.equal(course.contentVersion,SAFE_INTRO_CONTENT_VERSION);
  assert.notEqual(course.levelVersion,old.levelVersion);assert.ok(course.obstacles.every(o=>o.z>=SAFE_INTRO_METERS));assert.ok(course.gaps.every(g=>g.start>=SAFE_INTRO_METERS));
  const first=Math.min(...course.obstacles.map(o=>o.z),...course.gaps.map(g=>g.start));assert.ok(first>=34,`${course.id} first danger at ${first}m`);
  assert.ok(old.obstacles.some(o=>o.z<SAFE_INTRO_METERS)||old.gaps.some(g=>g.start<SAFE_INTRO_METERS));
  for(const boost of [false,true]){const{state,inputs}=race(i,{ruleVersion:E.RULE_VERSION,boost}),p=state.players[0];
   assert.equal(state.contentVersion,SAFE_INTRO_CONTENT_VERSION);assert.equal(state.status,'finished',state.courseId);assert.ok(state.players.every(player=>player.finishTick!==null&&player.hits===0),state.courseId);
   assert.ok(inputs.some(event=>event.input==='jump'),state.courseId);assert.ok(inputs.some(event=>event.input==='slide'),state.courseId);
   assert.equal(resolveRunCourse(state),course);
  }
  const idle=E.createState(seed(i),0,{players:roster(2),ruleVersion:E.RULE_VERSION,startPolicy:E.RUN_SCENE_READY_POLICY});E.armStart(idle,0);E.tick(idle,idle.startedAt+100000);
  assert.ok(idle.players.every(player=>player.hits>0),`${idle.courseId} should punish no input after the safe intro`);
 }
});
test('v2.0 saved JSON retains its original course, pending input, and exact advancement after v2.1 addition',()=>{
 for(let i=0;i<6;i++){
  const old=E.createState(seed(i),1000,{players:roster(2),ruleVersion:E.PREVIOUS_RULE_VERSION});
  assert.equal(old.contentVersion,RUN_COURSES[i].contentVersion);assert.equal(old.levelVersion,RUN_COURSES[i].levelVersion);
  assert.equal(resolveRunCourse(old),RUN_COURSES[i]);assert.equal('startPolicy'in old,false);assert.equal('armingDeadlineAt'in old,false);
  E.act(old,'p0',{type:'jump'},1000);const restored=clone(old);
  for(const now of [1100,1250,1500,4000]){E.tick(old,now);E.tick(restored,now);assert.deepEqual(restored,old);}
  assert.equal(resolveRunCourse(restored),RUN_COURSES[i]);assert.equal('armingDeadlineAt'in E.view(restored,'p0'),false);
 }
});
test('real worker 250ms cadence completes every v2 course without rejected bot actions for 2/3/4 players',()=>{
 for(let i=0;i<6;i++)for(const count of [2,3,4]){const{state}=race(i,{worker:true,step:250,count});assert.equal(state.status,'finished');assert.ok(state.players.every(p=>p.finishTick!==null),state.courseId);assert.equal(new Set(state.players.map(p=>p.finishTick)).size,1);}
});
test('new course identity is immutable across snapshots, JSON recovery and all seats',()=>{
 for(let i=0;i<6;i++){const s=E.createState(seed(i),0,{players:roster(4)}),restored=clone(s);E.act(s,'p0',{type:'jump'},0);E.act(restored,'p0',{type:'jump'},0);for(let now=1;now<=4000;now++)E.tick(s,now);E.tick(restored,4000);assert.deepEqual(s,restored);for(const p of s.players){const v=E.view(s,p.key);assert.equal(v.courseId,resolveRunCourse(s).id);assert.equal(v.levelVersion,s.levelVersion);assert.deepEqual(v.visible.obstacles,resolveRunCourse(s).obstacles.filter(o=>o.z>=p.distanceU/300-8&&o.z<=p.distanceU/300+105));}}
});
test('v2.1 scene-ready gate keeps human and BOT motion at tick zero until the one server start instant',()=>{
 const state=E.createState(seed(0),1000,{players:roster(2),ruleVersion:E.RULE_VERSION,startPolicy:E.RUN_SCENE_READY_POLICY});
 assert.equal(state.phase,'arming');assert.equal(state.tick,0);assert.equal(state.armingDeadlineAt,1000+E.RUN_SCENE_READY_TIMEOUT_MS);
 assert.throws(()=>E.act(state,'p0',{type:'jump'},1100),{code:'NOT_STARTED'});
 const before=clone(state);const idle=executeEngineTask({kind:'advance',gameId:'run',ruleVersion:E.RULE_VERSION,state,now:2000,bots:[{key:'p1',lastBotAt:0}]});
 assert.equal(idle.state.tick,0);assert.deepEqual(idle.botUpdates,[]);assert.ok(idle.state.players.every(p=>p.distanceU===0));
 E.armStart(state,2000);const start=2000+E.RUN_START_COUNTDOWN_MS;assert.equal(state.startedAt,start);assert.equal(state.deadlineAt,start+100000);assert.equal(state.phase,'countdown');
 assert.throws(()=>E.act(state,'p0',{type:'jump'},start-1),{code:'NOT_STARTED'});
 E.tick(state,start-1);assert.equal(state.tick,0);assert.equal(E.botAction(state,'p1',start-1),null);
 E.tick(state,start);assert.equal(state.phase,'racing');assert.equal(state.tick,0);
 E.tick(state,start+100);assert.equal(state.tick,6);assert.ok(state.players.every(p=>p.distanceU===240));
 assert.throws(()=>E.armStart(state,start+100),{code:'NOT_ARMING'});
 assert.equal(before.phase,'arming');
});
test('v2.1 arming deadline remains absolute when a shared pause is requested',()=>{
 const state=E.createState(seed(0),1000,{players:roster(2),ruleVersion:E.RULE_VERSION,startPolicy:E.RUN_SCENE_READY_POLICY}),saved=clone(state);
 E.shiftTime(state,60000);assert.deepEqual(state,saved);
 assert.throws(()=>E.armStart(state,1000+E.RUN_SCENE_READY_TIMEOUT_MS),{code:'SCENE_READY_TIMEOUT'});
 const previous=E.createState(seed(0),1000,{players:roster(2),ruleVersion:E.PREVIOUS_RULE_VERSION});
 E.shiftTime(previous,500);assert.equal(previous.startedAt,1500);
});
test('legacy waiting-room construction and saved pending input use the original complete rules',()=>{
 const options={players:roster(2),ruleVersion:V1.RULE_VERSION},a=E.createState(seed(2),1000,options),b=V1.createState(seed(2),1000,options);assert.deepEqual(a,b);assert.deepEqual(E.act(a,'p0',{type:'left'},1000),V1.act(b,'p0',{type:'left'},1000));let saved=clone(a);
 for(let now=1100;now<12000;now+=250){E.tick(saved,now);V1.tick(b,now);for(const p of saved.players){const action=E.botAction(saved,p.key,now);assert.deepEqual(action,V1.botAction(b,p.key,now));if(action){assert.deepEqual(E.act(saved,p.key,action,now),V1.act(b,p.key,action,now));}}assert.deepEqual(saved,b);assert.deepEqual(E.view(saved,'p0'),V1.view(b,'p0'));}
 E.shiftTime(saved,1200);V1.shiftTime(b,1200);assert.deepEqual(saved,b);assert.deepEqual(E.rank(saved),V1.rank(b));assert.deepEqual(E.forfeit(saved,['p1'],14000),V1.forfeit(b,['p1'],14000));
 for(const version of [undefined,'','pvp-run-v3.0.0',V1.RULE_VERSION+'x'])assert.equal(E.supportsRuleVersion(version),false);assert.throws(()=>E.createState(seed(0),0,{players:roster(2),ruleVersion:'unknown'}),{code:'PINNED_RULE_UNAVAILABLE'});
});
