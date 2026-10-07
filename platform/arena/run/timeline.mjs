import {createRunSelfProjection} from './self-projection.mjs';
import {projectedPose,RUN_PROJECTION_LIMIT_MS} from './presentation.mjs';
import {runRequiresSceneReady} from './start-policy.mjs';
import {resolveRunCourse} from './courses.mjs';
import {COLLIDER} from './level.mjs';
import {runnerPose} from './runner-physics.mjs';

const HZ=60,MS_PER_TICK=1000/HZ,HORIZON=39,MAX_BASES=16,MAX_HISTORY=256,MAX_INPUTS=128;
// One small startup buffer lets accepted history arrive before its display tick.
// It is not a network estimate and does not extend the authority lease.
export const RUN_TIMELINE_STARTUP_BUFFER_MS=100;
export const RUN_MAX_BOOST_RETIME_MS=100;
const actions=new Set(['left','right','jump','slide','item']);
const collisionEvents=new Set(['hit','shield_hit','fall','respawn','collision','recovery','finish']);
const canonical=type=>type==='boost'||type==='shield'?'item':type;
const integer=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
const finite=n=>Number.isFinite(n)&&n>=0;
const own=(game,key)=>game?.players?.find(player=>player.key===key);
const inputEqual=(a,b)=>a.type===b.type&&a.tick===b.tick&&a.no===b.no&&a.item===b.item;
const profile=game=>JSON.stringify([game.ruleVersion,game.courseId,game.contentVersion,game.levelVersion,game.physicsVersion,game.startedAt]);
const active=game=>game?.status==='active'&&['racing','finish-window'].includes(game.phase);
const close=(a,b)=>Math.abs(a-b)<1e-7;
const poseEqual=(a,b)=>a&&b&&['distance','scale'].every(key=>close(a[key],b[key]));
function acceptedInput(value){
 return value&&actions.has(value.type)&&integer(value.tick,1)&&integer(value.no,1)
  &&(value.type==='item'?['shield','boost'].includes(value.item):value.item===null)
  ?{type:value.type,tick:value.tick,no:value.no,item:value.item}:null;
}

/** Continuous display time over bounded, independently replayed authority bases.
 * Only an accepted boost may retime display phase by at most 100 ms; its
 * position remains continuous and authoritative simulation time never changes.
 * Neither local dispatch nor this controller completes an HTTP request. */
export function createRunTimeline(){
 let scope=null,key=null,room=null,latest=null,latestVersion=-1,latestTick=-1,mapping=null,tickFirstObservedAt=null;
 let bases=[],history=new Map(),appliedTicks=new Map(),inputs=new Map(),seenTokens=new Set(),retimedInputs=new Set(),pendingReconciliation=null,animationPhase=null,lastPresentedPose=null;
 let displayTick=null,lastAt=null,lastObservedAt=-Infinity,lastPose=null,pendingResync=null,invalidReason=null,suspended=null,terminal=false,startupUntil=null;
 function clear(){scope=null;key=null;room=null;latest=null;latestVersion=-1;latestTick=-1;mapping=null;tickFirstObservedAt=null;bases=[];history=new Map();appliedTicks=new Map();inputs=new Map();seenTokens=new Set();retimedInputs=new Set();pendingReconciliation=null;animationPhase=null;lastPresentedPose=null;displayTick=null;lastAt=null;lastObservedAt=-Infinity;lastPose=null;pendingResync=null;invalidReason=null;suspended=null;terminal=false;startupUntil=null;}
 function build(game,version,receivedAtMs,firstReceivedAtMs=receivedAtMs,accepted=history){
  const projection=createRunSelfProjection(),source=own(game,key);
  const acceptedInputs=[...accepted.values()].filter(input=>input.tick>game.snapshotTick&&input.tick<=game.snapshotTick+HORIZON&&input.no>source.appliedInputNo).sort((a,b)=>a.tick-b.tick||a.no-b.no);
  if(!projection.update(game,key,{roomId:room,roomVersion:version,acceptedInputs}))return null;
  return {game,version,tick:game.snapshotTick,receivedAtMs,firstReceivedAtMs,projection,course:resolveRunCourse(game)};
 }
 function sourcePose(entry,tick){return entry.projection.sample((tick-entry.tick)*MS_PER_TICK);}
 function rebase(entry,at,reason){
  startupUntil=null;pendingReconciliation=null;animationPhase=null;
  bases=entry?[entry]:[];invalidReason=entry?null:reason;
  displayTick=entry?Math.max(entry.tick,Math.min(displayTick??entry.tick,entry.tick+HORIZON)):Math.max(displayTick??0,latest?.snapshotTick??0);
  lastAt=at;lastPose=entry?sourcePose(entry,displayTick):authorityPose();pendingResync=reason;
 }
 function authorityPose(){const p=own(latest,key);return p?projectedPose(p,latest,0):null;}
 function normalized(state){
  if(!state)return null;
  const {tick,inputNo,pendingInput,lastInputTick,...body}=state;
  const usedTick=lastInputTick<=tick?lastInputTick:state.appliedInputNo===0?-6:appliedTicks.get(state.appliedInputNo)??history.get(state.appliedInputNo)?.tick;
  if(!integer(usedTick,-6)||usedTick>tick)return null;
  return {...body,lastAppliedInputTick:usedTick};
 }
 function statesEqual(a,b){const x=normalized(a),y=normalized(b);return x!==null&&y!==null&&JSON.stringify(Object.keys(x).sort())===JSON.stringify(Object.keys(y).sort())&&Object.keys(x).every(field=>JSON.stringify(x[field])===JSON.stringify(y[field]));}
 function rememberApplied(game){const p=own(game,key),last=game.selfPrediction?.lastInputTick;if(p&&integer(p.appliedInputNo)&&integer(last,-6)&&last<=game.snapshotTick)appliedTicks.set(p.appliedInputNo,last);}
 function addHistory(input,map=history){
  const known=map.get(input.no);if(known)return inputEqual(known,input);
  if([...map.values()].some(value=>value.tick===input.tick&&value.no!==input.no))return false;
  map.set(input.no,input);return true;
 }
 function trim(){
  const minimum=bases[0]?.tick??latestTick;
  for(const [no,input]of history)if(history.size>MAX_HISTORY&&input.tick<minimum)history.delete(no);
  for(const [no]of appliedTicks)if(appliedTicks.size>MAX_HISTORY&&!history.has(no)&&no!==(own(latest,key)?.appliedInputNo))appliedTicks.delete(no);
  const applied=own(latest,key)?.appliedInputNo??-1;
  for(const [token,record]of inputs)if(record.state==='rejected'||record.state==='accepted'&&record.expectedInputNo<=applied)inputs.delete(token);
 }
 function gather(game){
  const next=new Map(history);if(!Array.isArray(game.events))return null;
  for(const event of game.events){
   if(!event||typeof event!=='object')return null;
   if(event.playerKey!==key||!['left','right','jump','slide','item_used'].includes(event.type))continue;
   const value=acceptedInput({type:event.type==='item_used'?'item':event.type,tick:event.tick,no:event.inputNo,item:event.item??null});
   if(!value||value.tick>game.snapshotTick||!addHistory(value,next))return null;
  }
  const pending=game.selfPrediction?.pendingInput;
  if(pending!==null&&pending!==undefined){const value=acceptedInput(pending);if(!value||!addHistory(value,next))return null;}
  return next;
 }
 function uncertain(){return [...inputs.values()].filter(record=>record.state!=='rejected'&&!history.has(record.expectedInputNo));}
 function retimeAcceptedBoost(prior,replacement){
  const tick=Math.floor(displayTick),oldState=prior.projection.stateAtTick(tick),newState=replacement.projection.stateAtTick(tick);
  const oldPose=lastPresentedPose??lastPose,newPose=sourcePose(replacement,displayTick);
  if(!oldState||!newState||!oldPose||!newPose||newPose.distance<=oldPose.distance+1e-7)return null;
  const boost=[...history.values()].find(input=>input.type==='item'&&input.item==='boost'&&input.no>oldState.appliedInputNo&&input.no<=newState.appliedInputNo&&input.tick<=tick&&newState.boostUntilTick===input.tick+180&&!retimedInputs.has(input.no));
  if(!boost)return null;
  const unsafe={ok:false,reason:'accepted-boost-unsafe-boundary'};
  const lower=Math.max(replacement.tick,displayTick-RUN_MAX_BOOST_RETIME_MS/MS_PER_TICK),lowerPose=sourcePose(replacement,lower);
  if(!lowerPose||lowerPose.distance>oldPose.distance+1e-7)return{ok:false,reason:'accepted-boost-retime-limit'};
  for(const state of [oldState,newState])if(state.fallUntilTick!==null||state.finishTick!==null||state.forfeited||state.stunUntilTick>tick)return unsafe;
  for(const field of ['hits','checkpointU','fallStartTick','fallUntilTick','stunUntilTick','finishTick','resolvedObstacles'])if(JSON.stringify(oldState[field])!==JSON.stringify(newState[field]))return unsafe;
  // Do not rewind a physical event or restart a jump/land/slide animation.
  // These are presentation boundaries even when their distance is continuous.
  for(const projection of [prior.projection,replacement.projection])for(let current=Math.floor(lower);current<=Math.ceil(displayTick);current++){
   const pose=projection.sample((current-replacement.tick)*MS_PER_TICK);
   if(pose&&collisionEvents.has(pose.boundary))return unsafe;
  }
  let low=lower,high=displayTick;
  for(let step=0;step<40;step++){const middle=(low+high)/2;if(sourcePose(replacement,middle).distance<oldPose.distance)low=middle;else high=middle;}
  const nextTick=(low+high)/2,nextPose=sourcePose(replacement,nextTick);
  if(!nextPose||!['distance','scale'].every(field=>close(nextPose[field],oldPose[field])))return unsafe;
  const animationBoundaries=[newState.jumpStartTick,newState.jumpStartTick===null?null:newState.jumpStartTick+48,newState.jumpStartTick===null?null:newState.jumpStartTick+58,newState.slideUntilTick-36,newState.slideUntilTick,newState.changeStartTick,newState.changeEndTick];
  if(animationBoundaries.some(boundary=>Number.isFinite(boundary)&&boundary>nextTick&&boundary<=displayTick))return unsafe;
  const fromTick=displayTick;
  const animationFields=['lane','fromLane','changeStartTick','changeEndTick','jumpStartTick','slideUntilTick'];
  if(animationFields.some(field=>oldState[field]!==newState[field])||animationPhase)return unsafe;
  const player=Object.fromEntries(animationFields.map(field=>[field,newState[field]]));
  const lane=fromTick<player.changeEndTick,jump=player.jumpStartTick!==null&&fromTick<player.jumpStartTick+58,slide=fromTick<player.slideUntilTick;
  const phase=lane||jump||slide?{player,offsetTicks:fromTick-nextTick,lane,jump,slide,hits:newState.hits,resolvedObstacleCount:newState.resolvedObstacles.length}:null;
  pendingReconciliation=Object.freeze({reason:'accepted-boost-retime',inputNo:boost.no,fromTick,toTick:nextTick,rewindMs:(fromTick-nextTick)*MS_PER_TICK,correctionDistanceMeters:newPose.distance-oldPose.distance,observedAtMs:lastObservedAt,...(phase?{preservedAnimation:Object.freeze({offsetTicks:phase.offsetTicks,lane,jump,slide})}:{})});
  animationPhase=phase;
  retimedInputs.add(boost.no);displayTick=nextTick;lastPose=nextPose;
  return{ok:true};
 }
 function rebuild(reason='history-correction'){
  if(!bases.length)return false;
  const next=bases.map(entry=>build(entry.game,entry.version,entry.receivedAtMs,entry.firstReceivedAtMs));
  if(next.some(entry=>!entry)){rebase(build(latest,latestVersion,lastObservedAt),lastObservedAt,'input-history-invalid');return false;}
  const prior=bases[0],replacement=next[0];
  if(displayTick!==null&&displayTick>=prior.tick&&displayTick<=prior.tick+HORIZON&&(!poseEqual(sourcePose(prior,displayTick),sourcePose(replacement,displayTick))||['hits','checkpointU','fallStartTick','fallUntilTick','stunUntilTick','finishTick','forfeited'].some(field=>prior.projection.stateAtTick(Math.floor(displayTick))?.[field]!==replacement.projection.stateAtTick(Math.floor(displayTick))?.[field]))){
   const retimed=retimeAcceptedBoost(prior,replacement);
   if(!retimed?.ok){rebase(next.at(-1),lastObservedAt,retimed?.reason??reason);return false;}
  }
  bases=next;return true;
 }
 function receive(game,playerKey,{roomId,roomVersion,receivedAtMs}={}){
  if(typeof roomId!=='string'||!roomId||typeof playerKey!=='string'||!playerKey||!integer(roomVersion)||!integer(game?.snapshotTick)||!finite(receivedAtMs))return false;
  const nextScope=JSON.stringify([roomId,playerKey]);
  if(scope!==nextScope){clear();scope=nextScope;room=roomId;key=playerKey;}
  if(receivedAtMs<lastObservedAt||roomVersion<=latestVersion||game.snapshotTick<latestTick)return false;
  const prior=latest,previousTick=latestTick,previousMapping=mapping;
  latest=game;latestVersion=roomVersion;latestTick=game.snapshotTick;lastObservedAt=receivedAtMs;
  terminal=game.status==='finished'||game.phase==='finished'||!!own(game,key)?.forfeited||own(game,key)?.finishTick!==null&&own(game,key)?.finishTick!==undefined;
  if(terminal){bases=[];pendingResync=null;invalidReason=null;lastPose=authorityPose();displayTick=Math.max(displayTick??game.snapshotTick,game.snapshotTick);lastAt=receivedAtMs;return true;}
  if(!runRequiresSceneReady(game.ruleVersion)||!active(game)||!Object.hasOwn(game,'selfPrediction')){bases=[];mapping=null;displayTick=game.snapshotTick;lastAt=receivedAtMs;lastPose=authorityPose();invalidReason=null;pendingResync=null;return true;}
  mapping=profile(game);
  const firstReceivedAtMs=game.snapshotTick===previousTick&&active(prior)&&tickFirstObservedAt!==null?tickFirstObservedAt:receivedAtMs;
  tickFirstObservedAt=firstReceivedAtMs;
  const plain=build(game,roomVersion,receivedAtMs,firstReceivedAtMs,new Map());
  if(!plain){rebase(null,receivedAtMs,'invalid-self-state');return true;}
  if(previousMapping!==null&&mapping!==previousMapping){history.clear();appliedTicks.clear();inputs.clear();rememberApplied(game);rebase(plain,receivedAtMs,'mapping-changed');return true;}
  const accepted=gather(game);if(!accepted){rebase(plain,receivedAtMs,'conflicting-input-history');return true;}
  history=accepted;rememberApplied(game);
  for(const record of inputs.values())if(own(game,key).inputNo<record.expectedInputNo)record.earliestTick=Math.max(record.earliestTick,game.snapshotTick+1);
  const next=build(game,roomVersion,receivedAtMs,firstReceivedAtMs);
  if(!next){rebase(plain,receivedAtMs,'input-history-invalid');return true;}
  if(suspended){
   if(game.snapshotTick<=suspended.afterTick){lastPose=authorityPose();return true;}
   const reason=suspended.reason;suspended=null;rebase(next,receivedAtMs,'resume-'+reason);trim();return true;
  }
  if(!bases.length){
   if(prior&&active(prior)&&previousMapping!==null)rebase(next,receivedAtMs,'authority-restored');
   else {bases=[next];displayTick=next.tick;lastAt=receivedAtMs;lastPose=sourcePose(next,next.tick);pendingResync=null;invalidReason=null;startupUntil=next.tick===0?receivedAtMs+RUN_TIMELINE_STARTUP_BUFFER_MS:null;}
   trim();return true;
  }
  if(!rebuild()){trim();return true;}
  const predecessor=bases.at(-1);
  if(next.tick>predecessor.tick+HORIZON){rebase(next,receivedAtMs,'authority-gap');trim();return true;}
  if(next.tick-displayTick>HORIZON){rebase(next,receivedAtMs,'display-lag');trim();return true;}
  const priorState=predecessor.projection.stateAtTick(next.tick),newState=next.projection.stateAtTick(next.tick);
  if(!statesEqual(priorState,newState)){rebase(next,receivedAtMs,'authority-divergence');trim();return true;}
  if(next.tick===predecessor.tick)bases[bases.length-1]=next;else bases.push(next);
  if(bases.length>MAX_BASES){rebase(next,receivedAtMs,'history-overflow');trim();return true;}
  while(bases.length>1&&bases[1].tick<=displayTick){bases.shift();lastPose=sourcePose(bases[0],displayTick);}
  invalidReason=null;trim();return true;
 }
 function noteInput(dispatch){
  const type=canonical(dispatch?.type),p=own(latest,key);
  if(!bases.length||terminal||suspended||!p||!actions.has(type)||typeof dispatch.token!=='string'||!dispatch.token||dispatch.token.length>512||seenTokens.has(dispatch.token)||seenTokens.size>=4096||inputs.size>=MAX_INPUTS)return false;
  if(dispatch.roomId!==room||dispatch.playerKey!==key||dispatch.ruleVersion!==latest.ruleVersion||typeof dispatch.request_id!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(dispatch.request_id)||!integer(dispatch.seq,1))return false;
  const at=dispatch.dispatchedAtMs??lastObservedAt;
  if(!finite(at)||at<lastObservedAt)return false;lastObservedAt=at;
  const expectedInputNo=Math.max(p.inputNo,...[...inputs.values()].filter(record=>record.state==='accepted').map(record=>record.expectedInputNo))+1;
  let itemEarliestTick=latest.snapshotTick+1,heldItem=p.inventory;
  if(type==='item'&&heldItem===null){
   // A held item cannot be used before its deterministic pickup. This is a
   // lower bound on a possible accepted tick, never a speculative use.
   itemEarliestTick=Infinity;
   const entry=bases.at(-1);
   for(let tick=entry.tick;tick<=entry.tick+HORIZON;tick++){
    const state=entry.projection.stateAtTick(tick);
    if(state?.inventory){itemEarliestTick=tick+1;heldItem=state.inventory;break;}
   }
  }
  seenTokens.add(dispatch.token);inputs.set(dispatch.token,{...dispatch,type,originalType:dispatch.type,expectedInputNo,baseTick:latest.snapshotTick,earliestTick:latest.snapshotTick+1,heldItem,itemEarliestTick,at,state:'unresolved'});return true;
 }
 function resolveInput({token,receipt,outcome='accepted',resolvedAtMs=Math.max(lastObservedAt,lastAt??lastObservedAt)}={}){
  const record=inputs.get(token);if(!record||!['accepted','rejected','unresolved'].includes(outcome)||!finite(resolvedAtMs)||resolvedAtMs<lastObservedAt)return false;lastObservedAt=resolvedAtMs;
  if(outcome==='unresolved'){record.state='unresolved';return true;}
  if(outcome==='rejected'){
   if(history.has(record.expectedInputNo)){rebase(bases.at(-1),lastObservedAt,'input-outcome-conflict');return false;}
   record.state='rejected';inputs.delete(token);return true;
  }
  if(!receipt||Object.keys(receipt).length!==8||!['roomId','playerKey','request_id','seq','ruleVersion'].every(field=>receipt[field]===record[field])||receipt.type!==record.type||receipt.inputNo!==record.expectedInputNo||!integer(receipt.acceptedTick,1)||receipt.acceptedTick<=record.baseTick||receipt.acceptedTick-record.baseTick>121)return false;
  const old=history.get(receipt.inputNo);
  if(old&&(old.type!==receipt.type||old.tick!==receipt.acceptedTick)){rebase(bases.at(-1),lastObservedAt,'receipt-history-conflict');return false;}
  const item=receipt.type==='item'?old?.item??(['boost','shield'].includes(record.originalType)?record.originalType:record.heldItem):null;
  record.state='accepted';record.receipt={...receipt};
  const input=acceptedInput({type:receipt.type,tick:receipt.acceptedTick,no:receipt.inputNo,item});
  if(input){if(!addHistory(input)){rebase(bases.at(-1),lastObservedAt,'receipt-history-conflict');return false;}rebuild();}
  trim();return true;
 }
 function hazard(entry,from,to){
  const low=Math.min(from.distance,to.distance),high=Math.max(from.distance,to.distance);
  return entry.course.obstacles.some(o=>high>=o.z-o.depth/2-COLLIDER.radius&&low<=o.z+o.depth/2+COLLIDER.radius)
   ||entry.course.gaps.some(g=>high+COLLIDER.radius*.35>g.start&&low-COLLIDER.radius*.35<g.end);
 }
 function displayedPose(mode){
  const pose=lastPose,phase=animationPhase,p=pose?.visualPlayer;
  if(!phase||!p)return pose;
  // boundary may name the next integer frame while interpolation still uses
  // the pre-impact state. Clear only when the displayed own state has changed.
  if(mode==='resync'||terminal||pose.hits!==phase.hits||pose.resolvedObstacleCount!==phase.resolvedObstacleCount||pose.fallUntilTick!==null||pose.finishTick!==null||pose.tick<pose.stunUntilTick){animationPhase=null;return pose;}
  const previous=phase.player;
  phase.lane=phase.lane&&pose.tick<previous.changeEndTick&&['lane','fromLane','changeStartTick','changeEndTick'].every(field=>p[field]===previous[field]);
  phase.jump=phase.jump&&pose.tick<previous.jumpStartTick+58&&p.jumpStartTick===previous.jumpStartTick&&p.slideUntilTick===previous.slideUntilTick;
  phase.slide=phase.slide&&pose.tick<previous.slideUntilTick&&p.slideUntilTick===previous.slideUntilTick&&p.jumpStartTick===previous.jumpStartTick;
  if(!phase.lane&&!phase.jump&&!phase.slide){animationPhase=null;return pose;}
  // This is only the already accepted animation, evaluated at its retained
  // phase. Integer interpolation matches shared projection; physical timers,
  // distance, collision decisions and the finite display budget stay intact.
  const at=pose.tick+phase.offsetTicks,lo=Math.floor(at),a=runnerPose(previous,lo),b=runnerPose(previous,lo+1),fraction=at-lo;
  const animationTick=phase.jump?Math.min(at,previous.jumpStartTick+58):phase.slide?Math.min(at,previous.slideUntilTick):null;
  return {...pose,x:phase.lane?a.x+(b.x-a.x)*fraction:pose.x,y:phase.jump?a.y+(b.y-a.y)*fraction:pose.y,...(animationTick!==null?{animationTick}:{}),...(phase.slide?{sliding:at<previous.slideUntilTick}:{})};
 }
 function result(mode,reason,entry=bases[0]){const reconciliation=pendingReconciliation;pendingReconciliation=null;const pose=displayedPose(mode);lastPresentedPose=pose;return{mode,pose,reason:reason??reconciliation?.reason??null,displayTick,baseTick:entry?.tick??latest?.snapshotTick??null,baseVersion:entry?.version??latestVersion,...(reconciliation?{reconciliation}:{})};}

 function sample(now){
  if(!finite(now))return result('hold','invalid-time');
  // HTTP/input callbacks can run after the current RAF timestamp. Their
  // observation time orders messages, but cannot accelerate display time.
  // Initial/resync bases already anchor lastAt at their real receive time.
  const at=Math.max(now,lastAt??now);
  if(terminal){lastAt=at;lastPose=authorityPose();return result('hold','authoritative-terminal');}
  if(suspended){lastAt=at;return result('hold',suspended.reason);}
  if(invalidReason){lastAt=at;return result('resync',invalidReason);}
  if(!bases.length){lastAt=at;return {...result('fallback','unsupported-or-inactive'),pose:null};}
  if(pendingResync){const reason=pendingResync;pendingResync=null;lastAt=at;lastPose=sourcePose(bases[0],displayTick);return result('resync',reason);}
  if(startupUntil!==null&&at<startupUntil){lastAt=at;return result('hold','startup-buffer');}
  if(startupUntil!==null){lastAt=Math.max(lastAt,startupUntil);startupUntil=null;}
  const fromAt=lastAt,fromTick=displayTick,target=displayTick+Math.max(0,at-lastAt)/MS_PER_TICK;lastAt=at;
  const unknown=uncertain();let reason=null;
  while(true){
   const entry=bases[0],successor=bases[1],endTick=Math.round((entry.game.deadlineAt-entry.game.startedAt)/MS_PER_TICK);
   let limit=Math.min(target,entry.tick+HORIZON,endTick,successor?.tick??Infinity);
   // A newer, reconciled authority proves the old trajectory through the
   // bridge endpoint. Its historical frames are not renewed extrapolation.
   if(at>=entry.firstReceivedAtMs+RUN_PROJECTION_LIMIT_MS&&!successor){
    const segmentAt=fromAt+(displayTick-fromTick)*MS_PER_TICK,remaining=Math.max(0,entry.firstReceivedAtMs+RUN_PROJECTION_LIMIT_MS-segmentAt);
    limit=Math.min(limit,displayTick+remaining/MS_PER_TICK);reason='projection-expired';
   }
   // Dispatch alone never enables boost. Continue the confirmed trajectory;
   // exact accepted history can reconcile its distance once, within 100 ms.
   // Unknown inputs still stop before an ambiguous physical contact below.
   if(limit>displayTick&&unknown.length){
    let safe=displayTick,previous=sourcePose(entry,safe);
    for(let tick=Math.min(Math.floor(safe)+1,limit);tick<=limit;tick=Math.min(Math.floor(tick)+1,limit)){
     const pose=sourcePose(entry,tick);
     if(!pose||unknown.some(record=>tick>=record.earliestTick)&&(collisionEvents.has(pose.boundary)||hazard(entry,previous,pose))){limit=safe;reason='input-collision-uncertain';break;}
     safe=tick;previous=pose;if(tick===limit)break;
    }
   }
   if(limit<displayTick){rebase(entry,at,'uncovered-display-time');return result('resync','uncovered-display-time');}
   displayTick=limit;lastPose=sourcePose(entry,displayTick);
   if(!lastPose){rebase(null,at,'invalid-projection');return result('resync','invalid-projection');}
   if(lastPose.finishTick!==null)return result('hold','projected-finish',entry);
   if(reason)return result('hold',reason,entry);
   if(successor&&displayTick>=successor.tick){bases.shift();if(displayTick<target)continue;lastPose=sourcePose(bases[0],displayTick);return result('project',null);}
   if(displayTick>=endTick)return result('hold','race-deadline',entry);
   if(displayTick>=entry.tick+HORIZON)return result('hold','projection-limit',entry);
   return result('project',null,entry);
  }
 }

 function suspend(reason='background'){
  inputs.clear();suspended={reason,afterTick:latestTick};pendingResync=null;
 }
 return{receive,noteInput,resolveInput,sample,suspend,clear};
}
