import {PHYSICS_VERSION,TRACK_LENGTH} from './level.mjs';
import {resolveRunCourse} from './courses.mjs';
import {runRequiresSceneReady} from './start-policy.mjs';
import {RUN_PROJECTION_LIMIT_MS} from './presentation.mjs';
import {RUN_RULES,runnerPose,stepRunnerInPlace} from './runner-physics.mjs';

export const RUN_SELF_PROJECTION_SCHEMA='run-self-projection-v1';
const HORIZON_TICKS=Math.round(RUN_PROJECTION_LIMIT_MS*RUN_RULES.hz/1000);
const LAST_TICK=RUN_RULES.durationMs*RUN_RULES.hz/1000;
const integer=(n,min=0,max=LAST_TICK)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const close=(a,b)=>Number.isFinite(a)&&Math.abs(a-b)<=1e-7;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exactKeys=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const held=value=>value===null||value==='shield'||value==='boost';
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
function units(value){
 if(!Number.isFinite(value)||value<0||value>TRACK_LENGTH)return null;
 const result=Math.round(value*RUN_RULES.distanceUnitsPerMeter);
 return close(result,value*RUN_RULES.distanceUnitsPerMeter)?result:null;
}
function uniqueMembers(values,allowed){
 return Array.isArray(values)&&values.length<=allowed.size&&new Set(values).size===values.length&&values.every(value=>allowed.has(value));
}
const sameInput=(a,b)=>a!==null&&b!==null&&a.type===b.type&&a.tick===b.tick&&a.no===b.no&&a.item===b.item;
function acceptedHistory(inputs,player,start,last){
 if(!Array.isArray(inputs)||inputs.length>HORIZON_TICKS)return null;
 const byTick=new Map();let nextNo=player.inputNo+1,lastTick=player.pendingInput?.tick??start,sawBasePending=false;
 for(const input of inputs){
  if(!exactKeys(input,['type','tick','no','item'])||!['left','right','jump','slide','item'].includes(input.type)||!integer(input.tick,start+1,last)||!integer(input.no,1,LAST_TICK+1)||!held(input.item)||(input.type==='item'?input.item===null:input.item!==null))return null;
  if(player.pendingInput!==null&&input.no===player.pendingInput.no){
   if(sawBasePending||byTick.size||!sameInput(input,player.pendingInput))return null;
   sawBasePending=true;continue;
  }
  if(input.no!==nextNo||input.tick<=lastTick)return null;
  byTick.set(input.tick,{...input});nextNo++;lastTick=input.tick;
 }
 return byTick;
}
// This is the admission rule at tick input.tick - 1, not the movement rule at
// input.tick. History supplied by the caller must come from received server
// events or the requesting player's pendingInput, never local input intents.
function canInject(player,input){
 const next=input.tick;
 if(player.pendingInput!==null||player.forfeited||player.finishTick!==null||input.no!==player.inputNo+1||next-player.lastInputTick<RUN_RULES.inputRateTicks||player.fallUntilTick!==null||next<player.stunUntilTick)return false;
 if(input.type==='left'||input.type==='right')return next>=player.changeEndTick&&integer(player.lane+(input.type==='left'?-1:1),0,2);
 if(input.type==='jump'||input.type==='slide')return(player.jumpStartTick===null||next>=player.jumpStartTick+RUN_RULES.jumpTicks)&&next>=player.slideUntilTick;
 return player.inventory!==null&&input.item===player.inventory&&(player.inventory!=='boost'||next>=player.boostUntilTick);
}
function ownedState(player,tick){
 return Object.freeze({tick,...player,claimedItems:Object.freeze([...player.claimedItems]),resolvedObstacles:Object.freeze([...player.resolvedObstacles]),pendingInput:player.pendingInput===null?null:Object.freeze({...player.pendingInput})});
}

// Reconstruct only the requesting player's complete, versioned simulation
// state. Public positions alone cannot tell whether an obstacle was already
// resolved or whether the server accepted an input for the next tick.
function restore(game,playerKey){
 if(!record(game)||game.gameId!=='run'||!runRequiresSceneReady(game.ruleVersion)||game.physicsVersion!==PHYSICS_VERSION||game.trackLength!==TRACK_LENGTH||game.me!==playerKey||game.status!=='active'||!['racing','finish-window'].includes(game.phase))return null;
 const tick=game.snapshotTick;
 if(!integer(tick)||!integer(game.startedAt,0,Number.MAX_SAFE_INTEGER)||!close(game.serverNow,game.startedAt+tick*1000/RUN_RULES.hz)||!Number.isFinite(game.deadlineAt))return null;
 const endTick=Math.round((game.deadlineAt-game.startedAt)*RUN_RULES.hz/1000);
 if(!integer(endTick,tick,LAST_TICK)||!close(game.deadlineAt,game.startedAt+endTick*1000/RUN_RULES.hz))return null;
 if(game.firstFinishTick===null){if(game.phase!=='racing'||endTick!==LAST_TICK)return null;}
 else if(!integer(game.firstFinishTick,0,tick)||game.phase!=='finish-window'||endTick!==Math.min(LAST_TICK,game.firstFinishTick+RUN_RULES.postFinishTicks))return null;
 let course;
 try{course=resolveRunCourse(game);}catch{return null;}
 if(course.physicsVersion!==game.physicsVersion||course.trackLength!==game.trackLength)return null;
 if(!Array.isArray(game.players)||game.players.length<2||game.players.length>4||game.players.some(p=>!record(p)||typeof p.key!=='string'||!p.key)||new Set(game.players.map(p=>p.key)).size!==game.players.length)return null;
 const source=game.players.find(p=>p.key===playerKey),privateState=game.selfPrediction;
 if(!source||!exactKeys(privateState,['schema','resolvedObstacles','pendingInput','lastInputTick'])||privateState.schema!==RUN_SELF_PROJECTION_SCHEMA)return null;
 const distanceU=units(source.distance),checkpointU=units(source.checkpoint);
 if(distanceU===null||checkpointU===null||checkpointU>distanceU||checkpointU%(30*RUN_RULES.distanceUnitsPerMeter)!==0)return null;
 if(!integer(source.lane,0,2)||!integer(source.fromLane,0,2)||!integer(source.changeStartTick,0,tick)||!integer(source.changeEndTick,source.changeStartTick,tick+RUN_RULES.changeTicks))return null;
 const changeDuration=source.changeEndTick-source.changeStartTick;
 if(changeDuration!==0&&changeDuration!==RUN_RULES.changeTicks||changeDuration===0&&source.fromLane!==source.lane||changeDuration!==0&&Math.abs(source.fromLane-source.lane)!==1)return null;
 if(source.jumpStartTick!==null&&!integer(source.jumpStartTick,0,tick))return null;
 for(const [key,duration] of [['slideUntilTick',RUN_RULES.slideTicks],['stunUntilTick',RUN_RULES.stunTicks],['immuneUntilTick',RUN_RULES.stunTicks+RUN_RULES.immuneTicks],['shieldUntilTick',RUN_RULES.shieldTicks],['boostUntilTick',RUN_RULES.boostTicks]])if(!integer(source[key],0,tick+duration))return null;
 if(source.fallStartTick!==null&&!integer(source.fallStartTick,0,tick))return null;
 if(source.fallUntilTick!==null&&(!integer(source.fallUntilTick,source.forfeited===true?0:tick+1,tick+RUN_RULES.respawnTicks)||source.fallStartTick===null||source.fallUntilTick-source.fallStartTick!==RUN_RULES.respawnTicks))return null;
 if(typeof source.forfeited!=='boolean'||!held(source.inventory)||!integer(source.hits,0,tick)||!integer(source.inputNo,0,LAST_TICK+1)||!integer(source.appliedInputNo,0,source.inputNo)||source.inputNo-source.appliedInputNo>1||!integer(privateState.lastInputTick,-RUN_RULES.inputRateTicks,tick+1))return null;
 if(source.finishTick===null){if(source.finishedAt!==null||distanceU>=TRACK_LENGTH*RUN_RULES.distanceUnitsPerMeter)return null;}
 else if(!integer(source.finishTick,0,tick)||distanceU!==TRACK_LENGTH*RUN_RULES.distanceUnitsPerMeter||!close(source.finishedAt,game.startedAt+source.finishTick*1000/RUN_RULES.hz)||source.forfeited)return null;
 const obstacleIds=new Set(course.obstacles.map(o=>o.id)),itemIds=new Set(course.items.map(item=>item.id));
 if(!uniqueMembers(privateState.resolvedObstacles,obstacleIds)||!uniqueMembers(source.claimedItems,itemIds))return null;
 const pending=privateState.pendingInput;
 if(pending!==null){
  if(!exactKeys(pending,['type','tick','no','item'])||!['left','right','jump','slide','item'].includes(pending.type)||pending.tick!==tick+1||pending.no!==source.inputNo||pending.no!==source.appliedInputNo+1||privateState.lastInputTick!==pending.tick||source.forfeited||source.finishTick!==null||source.fallUntilTick!==null||pending.tick<source.stunUntilTick)return null;
  if(pending.type==='left'||pending.type==='right'){
   if(pending.tick<source.changeEndTick||!integer(source.lane+(pending.type==='left'?-1:1),0,2))return null;
  }else if(pending.type==='jump'||pending.type==='slide'){
   if(source.jumpStartTick!==null&&pending.tick<source.jumpStartTick+RUN_RULES.jumpTicks||pending.tick<source.slideUntilTick)return null;
  }else if(source.inventory===null||pending.item!==source.inventory||source.inventory==='boost'&&pending.tick<source.boostUntilTick)return null;
  if(pending.type!=='item'&&pending.item!==null)return null;
 }else if(!source.forfeited&&(privateState.lastInputTick>tick||source.appliedInputNo!==source.inputNo))return null;
 if(source.inputNo===0&&privateState.lastInputTick!==-RUN_RULES.inputRateTicks||source.inputNo>0&&privateState.lastInputTick<1)return null;
 const posed=runnerPose(source,tick),speed=source.forfeited||source.finishTick!==null||source.fallUntilTick!==null||tick<source.stunUntilTick?0:tick<source.boostUntilTick?9.6:8;
 if(!close(source.x,posed.x)||!close(source.y,posed.y)||source.sliding!==posed.sliding||source.speed!==speed||!close(source.netDistance,Math.round((source.fallUntilTick!==null?checkpointU:distanceU)/3)/100))return null;
 return{course,tick,endTick,player:{
  key:source.key,distanceU,checkpointU,lane:source.lane,fromLane:source.fromLane,changeStartTick:source.changeStartTick,changeEndTick:source.changeEndTick,jumpStartTick:source.jumpStartTick,
  slideUntilTick:source.slideUntilTick,stunUntilTick:source.stunUntilTick,immuneUntilTick:source.immuneUntilTick,fallStartTick:source.fallStartTick,fallUntilTick:source.fallUntilTick,shieldUntilTick:source.shieldUntilTick,boostUntilTick:source.boostUntilTick,
  inventory:source.inventory,claimedItems:[...source.claimedItems],resolvedObstacles:[...privateState.resolvedObstacles],hits:source.hits,inputNo:source.inputNo,appliedInputNo:source.appliedInputNo,lastInputTick:privateState.lastInputTick,pendingInput:pending===null?null:{...pending},finishTick:source.finishTick,finishedAt:source.finishedAt,forfeited:source.forfeited,
 }};
}

function frame(player,tick,boundary=null,authoritativeFinishTick=player.finishTick){
 const pose=runnerPose(player,tick);
 let y=pose.y,scale=1;
 if(player.fallUntilTick!==null){const progress=clamp((tick-player.fallStartTick)/RUN_RULES.respawnTicks,0,1);y=-Math.min(2.4,progress*5);scale=Math.max(.15,1-progress*.9);}
 return{x:pose.x,y,distance:player.distanceU/RUN_RULES.distanceUnitsPerMeter,tick,scale,sliding:pose.sliding,boundary,
  checkpoint:player.checkpointU/RUN_RULES.distanceUnitsPerMeter,inventory:player.inventory,hits:player.hits,appliedInputNo:player.appliedInputNo,
  fallStartTick:player.fallStartTick,fallUntilTick:player.fallUntilTick,stunUntilTick:player.stunUntilTick,immuneUntilTick:player.immuneUntilTick,shieldUntilTick:player.shieldUntilTick,boostUntilTick:player.boostUntilTick,finishTick:player.finishTick,
  claimedItemCount:player.claimedItems.length,resolvedObstacleCount:player.resolvedObstacles.length,
  // Animation data is an owned, immutable copy. A predicted finish remains a
  // diagnostic above; only a received finish may select the victory clip.
  visualPlayer:Object.freeze({key:player.key,lane:player.lane,fromLane:player.fromLane,changeStartTick:player.changeStartTick,changeEndTick:player.changeEndTick,jumpStartTick:player.jumpStartTick,slideUntilTick:player.slideUntilTick,stunUntilTick:player.stunUntilTick,immuneUntilTick:player.immuneUntilTick,fallStartTick:player.fallStartTick,fallUntilTick:player.fallUntilTick,shieldUntilTick:player.shieldUntilTick,boostUntilTick:player.boostUntilTick,inventory:player.inventory,claimedItems:Object.freeze([...player.claimedItems]),forfeited:player.forfeited,finishTick:authoritativeFinishTick,predictionOnly:true})};
}

/** Bounded visual projection. This object has no clock, requests, events or authority writes. */
export function createRunSelfProjection(){
 let room=null,viewer=null,version=-1,sourceTick=-1,frames=null,states=null,profile=null;
 function invalidate(){frames=null;states=null;return false;}
 function clear(){room=null;viewer=null;version=-1;sourceTick=-1;frames=null;states=null;profile=null;}
 return{
  clear,
  update(game,playerKey,{roomId=null,roomVersion=-1,acceptedInputs=[]}={}){
   if(typeof roomId!=='string'||!roomId||typeof playerKey!=='string'||!playerKey||!integer(roomVersion,0,Number.MAX_SAFE_INTEGER))return invalidate();
   if(roomId!==room||playerKey!==viewer){clear();room=roomId;viewer=playerKey;}
   if(game?.me!==playerKey)return invalidate();
   if(roomVersion<=version||integer(game?.snapshotTick)&&game.snapshotTick<sourceTick)return false;
   version=roomVersion;
   const restored=restore(game,playerKey);
   if(!restored)return invalidate();
   const nextProfile=[game.ruleVersion,game.courseId,game.contentVersion,game.levelVersion,game.physicsVersion].join('/');
   if(profile!==null&&nextProfile!==profile)return invalidate();
   profile=nextProfile;
   const {course,tick,endTick,player}=restored,authoritativeFinishTick=player.finishTick;
   sourceTick=tick;
   const steps=Math.min(HORIZON_TICKS,endTick-tick);
   const history=acceptedHistory(acceptedInputs,player,tick,tick+steps);
   if(history===null)return invalidate();
   const nextFrames=[frame(player,tick)],nextStates=[ownedState(player,tick)];
   for(let offset=1;offset<=steps;offset++){
    const current=tick+offset,wasStunned=current-1<player.stunUntilTick,resolvedCount=player.resolvedObstacles.length;
    const input=history.get(current);
    if(input){
     if(!canInject(player,input))return invalidate();
     player.pendingInput={...input};player.inputNo=input.no;player.lastInputTick=current;
     // act accepts tick t at authority tick t-1. Save that exact accepted
     // state as well as the subsequent applied state for timeline comparison.
     nextStates[offset-1]=ownedState(player,current-1);
    }
    let boundary=null;
    stepRunnerInPlace(player,current,course,{at:game.startedAt+current*1000/RUN_RULES.hz,emit(type){if(['hit','shield_hit','fall','respawn','finish'].includes(type))boundary=type;}});
    if(boundary===null&&resolvedCount!==player.resolvedObstacles.length)boundary='collision';
    if(boundary===null&&wasStunned&&current>=player.stunUntilTick)boundary='recovery';
    nextFrames.push(frame(player,current,boundary,authoritativeFinishTick));
    nextStates.push(ownedState(player,current));
   }
   frames=nextFrames;states=nextStates;
   return true;
  },
  stateAtTick(tick){
   if(states===null||!integer(tick,sourceTick,sourceTick+states.length-1))return null;
   return states[tick-sourceTick];
  },
  sample(elapsed){
   if(frames===null||!Number.isFinite(elapsed))return null;
   let offset=Math.min(frames.length-1,clamp(elapsed,0,RUN_PROJECTION_LIMIT_MS)*RUN_RULES.hz/1000);
   // Converting n * 1000 / 60 back to ticks can yield n - one ULP. Snap only
   // that arithmetic noise so exact integer respawn/finish samples use n.
   const nearest=Math.round(offset);if(Math.abs(offset-nearest)<=Number.EPSILON*Math.max(1,offset)*4)offset=nearest;
   const index=Math.floor(offset),left=frames[index],right=frames[Math.min(index+1,frames.length-1)],fraction=offset-index;
   // A collision, respawn, recovery or finish is an integer simulation event.
   // Holding its left endpoint avoids blending through water, an obstacle or
   // a checkpoint teleport before that event has happened.
   const mix=right.boundary===null?fraction:0;
   return{...left,x:left.x+(right.x-left.x)*mix,y:left.y+(right.y-left.y)*mix,distance:left.distance+(right.distance-left.distance)*mix,scale:left.scale+(right.scale-left.scale)*mix,tick:sourceTick+offset,
    projected:true,sourceTick,sourceVersion:version,boundary:fraction>0&&right.boundary!==null?right.boundary:left.boundary};
  },
 };
}
