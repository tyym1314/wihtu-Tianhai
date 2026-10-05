import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../arena/run/engine.mjs';
import * as V1 from '../arena/run/engine-v1.mjs';
import {RUN_COURSES,resolveRunCourse,courseGapAt} from '../arena/run/courses.mjs';
import {executeEngineTask} from '../server/pvp/engine-worker.mjs';
const clone=x=>JSON.parse(JSON.stringify(x));
const roster=n=>Array.from({length:n},(_,seatIndex)=>({key:`p${seatIndex}`,seatIndex,isBot:true}));
const seed=i=>i.toString(16).padStart(8,'0').padEnd(64,'0');
function race(index,{step=17,boost=true,worker=false,count=2}={}){
 let state=E.createState(seed(index),0,{players:roster(count)}),bots=state.players.map(p=>({key:p.key,lastBotAt:0})),inputs=[];
 for(let now=0;now<=100000&&state.status==='active';now+=step){
  if(worker){const result=executeEngineTask({kind:'advance',gameId:'run',ruleVersion:E.RULE_VERSION,state,now,bots});state=result.state;for(const update of result.botUpdates){bots.find(b=>b.key===update.key).lastBotAt=update.lastBotAt;inputs.push(update.lastEvent);}}
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
test('real worker 250ms cadence completes every v2 course without rejected bot actions for 2/3/4 players',()=>{
 for(let i=0;i<6;i++)for(const count of [2,3,4]){const{state}=race(i,{worker:true,step:250,count});assert.equal(state.status,'finished');assert.ok(state.players.every(p=>p.finishTick!==null),state.courseId);assert.equal(new Set(state.players.map(p=>p.finishTick)).size,1);}
});
test('new course identity is immutable across snapshots, JSON recovery and all seats',()=>{
 for(let i=0;i<6;i++){const s=E.createState(seed(i),0,{players:roster(4)}),restored=clone(s);E.act(s,'p0',{type:'jump'},0);E.act(restored,'p0',{type:'jump'},0);for(let now=1;now<=4000;now++)E.tick(s,now);E.tick(restored,4000);assert.deepEqual(s,restored);for(const p of s.players){const v=E.view(s,p.key);assert.equal(v.courseId,resolveRunCourse(s).id);assert.equal(v.levelVersion,s.levelVersion);assert.deepEqual(v.visible.obstacles,resolveRunCourse(s).obstacles.filter(o=>o.z>=p.distanceU/300-8&&o.z<=p.distanceU/300+105));}}
});
test('legacy waiting-room construction and saved pending input use the original complete rules',()=>{
 const options={players:roster(2),ruleVersion:V1.RULE_VERSION},a=E.createState(seed(2),1000,options),b=V1.createState(seed(2),1000,options);assert.deepEqual(a,b);assert.deepEqual(E.act(a,'p0',{type:'left'},1000),V1.act(b,'p0',{type:'left'},1000));let saved=clone(a);
 for(let now=1100;now<12000;now+=250){E.tick(saved,now);V1.tick(b,now);for(const p of saved.players){const action=E.botAction(saved,p.key,now);assert.deepEqual(action,V1.botAction(b,p.key,now));if(action){assert.deepEqual(E.act(saved,p.key,action,now),V1.act(b,p.key,action,now));}}assert.deepEqual(saved,b);assert.deepEqual(E.view(saved,'p0'),V1.view(b,'p0'));}
 E.shiftTime(saved,1200);V1.shiftTime(b,1200);assert.deepEqual(saved,b);assert.deepEqual(E.rank(saved),V1.rank(b));assert.deepEqual(E.forfeit(saved,['p1'],14000),V1.forfeit(b,['p1'],14000));
 for(const version of [undefined,'','pvp-run-v3.0.0',V1.RULE_VERSION+'x'])assert.equal(E.supportsRuleVersion(version),false);assert.throws(()=>E.createState(seed(0),0,{players:roster(2),ruleVersion:'unknown'}),{code:'PINNED_RULE_UNAVAILABLE'});
});
