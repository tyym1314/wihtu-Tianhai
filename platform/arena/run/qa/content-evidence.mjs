/** Reproducible content witnesses through production engines, no state patching. */
import {mkdir,writeFile} from 'node:fs/promises';
import * as R from '../engine.mjs';import * as M from '../../match/engine.mjs';import {RUN_COURSES} from '../courses.mjs';import {executeEngineTask} from '../../../server/pvp/engine-worker.mjs';
const players=[{key:'a',seatIndex:0,isBot:true},{key:'b',seatIndex:1,isBot:true}],seed=i=>i.toString(16).padStart(8,'0').padEnd(64,'0');
const run=[];
for(let i=0;i<6;i++){
 const cases=[];
 for(const boost of [false,true]){
  let state=R.createState(seed(i),0,{players});const trace=[];
  for(let now=0;now<=100000&&state.status==='active';now+=17){R.tick(state,now);for(const p of state.players){const a=R.botAction(state,p.key,now);if(a&&(boost||a.type!=='item')){R.act(state,p.key,a,now);if(p.key==='a')trace.push({at:now,action:a});}}}
  cases.push({boost,trace,finishTick:state.players[0].finishTick,hits:state.players[0].hits,ranks:R.rank(state)});
 }
 let worker=R.createState(seed(i),0,{players}),bots=players.map(p=>({key:p.key,lastBotAt:0}));for(let now=0;now<=100000&&worker.status==='active';now+=250){const result=executeEngineTask({kind:'advance',gameId:'run',ruleVersion:R.RULE_VERSION,state:worker,now,bots});worker=result.state;for(const u of result.botUpdates)bots.find(b=>b.key===u.key).lastBotAt=u.lastBotAt;}
 const idle=R.createState(seed(i),0,{players});R.tick(idle,100000);const c=RUN_COURSES[i];run.push({seed:seed(i),courseId:c.id,difficulty:c.difficulty,segments:c.segments,obstacleCount:c.obstacles.length,gapCount:c.gaps.length,hazardEvents:new Set(c.obstacles.map(o=>o.z)).size+c.gaps.length,cases,worker250ms:{finishTick:worker.players[0].finishTick,hits:worker.players[0].hits},idle:{finishTick:idle.players[0].finishTick,hits:idle.players[0].hits,distance:idle.players[0].distanceU/300}});
}
const match=[];
for(let i=0;i<3;i++){const state=M.createState(seed(i),0,{players}),trace=[];let now=0;while(now<90000){const a=M.botAction(state,'a',now),r=M.act(state,'a',a,now);trace.push({at:now,action:a,valid:r.event.valid,score:r.event.totalScore,objectiveProgress:r.event.objectiveProgress,waves:r.event.waves.length});now=r.event.busyUntil;}M.tick(state,now);match.push({seed:seed(i),objective:state.objective,trace,final:M.view(state,'a')});}
for(const[game,data]of[['run',run],['match',match]]){const url=new URL(`../../${game}/qa/content-20260928/`,import.meta.url);await mkdir(url,{recursive:true});await writeFile(new URL('engine-traces.json',url),JSON.stringify({scope:'Pure authoritative engine replay. Human skill, device performance and production acceptance remain separate.',generatedAt:new Date().toISOString(),cases:data},null,2));}
console.log(JSON.stringify({run:run.map(x=>({id:x.courseId,tier:x.difficulty,events:x.hazardEvents,actions:x.cases[0].trace.length,finish:x.cases[0].finishTick,idle:x.idle,worker:x.worker250ms})),match:match.map(x=>({id:x.objective.id,progress:x.final.objectiveProgress,complete:x.final.objectiveComplete,moves:x.trace.length}))},null,2));
