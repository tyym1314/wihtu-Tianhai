import {mkdir,writeFile} from 'node:fs/promises';
import {GOLF_HOLES} from '../content.mjs';
import {simulateShot,PHYSICS} from '../engine.mjs';

// Offline deterministic guide search, never imported by the live game/server.
// Each edge is an ordinary fixed-step shot with aim 0.01 rad and power 0.01.
function progress(h,ball){let best=h.samples[0],distance=Infinity;for(const p of h.samples){const d=Math.hypot(p.x-ball.x,p.z-ball.z);if(d<distance){distance=d;best=p;}}return best.progress;}
function candidates(h,start){
 const before=progress(h,start),targets=[h.cup];
 for(let i=0;i<h.samples.length;i+=6){const p=h.samples[i];if(p.progress<before+.025)continue;for(const offset of[-.9,-.45,0,.45,.9])targets.push({x:p.x+p.nx*offset,z:p.z+p.nz*offset});}
 const result=[],seen=new Set();
 for(const target of targets)for(const scale of[.93,1,1.07]){
  const d=Math.hypot(target.x-start.x,target.z-start.z),angle=Number(Math.atan2(target.x-start.x,start.z-target.z).toFixed(2)),power=Number(Math.max(.02,Math.min(1,Math.sqrt(2*PHYSICS.friction*(d+.1))/PHYSICS.maxSpeed*scale)).toFixed(2)),key=angle+':'+power;
  if(seen.has(key))continue;seen.add(key);const action={type:'shot',angle,power},shot=simulateShot(h,start,angle,power);if(shot.outcome==='water'||shot.outcome==='fault')continue;
  result.push({action,shot,score:progress(h,shot.ball)*100-Math.hypot(shot.ball.x-h.cup.x,shot.ball.z-h.cup.z)*.1});
 }
 return result;
}
function solve(h){
 let frontier=[{ball:h.tee,actions:[],shots:[]}];
 for(let depth=0;depth<7;depth++){
  const next=[];for(const state of frontier)for(const candidate of candidates(h,state.ball)){
   const branch={ball:candidate.shot.ball,actions:[...state.actions,candidate.action],shots:[...state.shots,{outcome:candidate.shot.outcome,ball:candidate.shot.ball,duration:candidate.shot.duration,bounces:candidate.shot.events.filter(e=>e.type==='bounce').length}],score:candidate.score};
   if(candidate.shot.outcome==='hole')return branch;next.push(branch);
  }
  const bins=new Set();frontier=next.sort((a,b)=>b.score-a.score).filter(state=>{const key=Math.round(state.ball.x*4)+':'+Math.round(state.ball.z*4);if(bins.has(key))return false;bins.add(key);return true;}).slice(0,5);
 }
 throw Error('No ordinary guide solution: '+h.id);
}
const report={scope:'Offline guide via unchanged authoritative physics. No position edits, hidden assistance or random outcomes. UI and physical phone acceptance are separate.',holes:[]};
for(const h of GOLF_HOLES){
 const solution=solve(h);let ball={...h.tee},defaultShots=[],defaultOutcome='stopped',score=0;const angle=Math.atan2(h.cup.x-h.tee.x,h.tee.z-h.cup.z);
 while(score<10&&defaultOutcome!=='hole'){const shot=simulateShot(h,ball,angle,.58);score+=shot.outcome==='water'?2:1;defaultShots.push({outcome:shot.outcome,ball:shot.ball});ball=shot.ball;defaultOutcome=shot.outcome;}
 report.holes.push({id:h.id,name:h.name,difficulty:h.difficulty,artIndex:h.artIndex,tee:h.tee,bumpers:h.bumpers,guide:solution,defaultRepeated:{angle,power:.58,score:defaultOutcome==='hole'?score:12,outcome:defaultOutcome,shots:defaultShots}});console.log(h.id,solution.actions.length,defaultOutcome==='hole'?score:12);
}
const out='review/deep-mobile-20260928/golf-content';await mkdir(out,{recursive:true});await writeFile(out+'/solutions.json',JSON.stringify(report,null,2));
