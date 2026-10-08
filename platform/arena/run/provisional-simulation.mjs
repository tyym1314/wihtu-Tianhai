import {act} from './engine.mjs';
import {RUN_RULES,runnerPose,stepRunnerInPlace} from './runner-physics.mjs';
import {createRunSelfProjection} from './self-projection.mjs';
import {resolveRunCourse} from './courses.mjs';
import {RUN_PRACTICE_RULE_VERSION} from './start-policy.mjs';
import {RUN_PROJECTION_LIMIT_MS} from './presentation.mjs';
import {readRunActionReceipt} from '../../shared/run-action-receipt.mjs';

// An isolated model, not wired to the renderer or transport. This cap is NOT
// permission to submit stale server inputs or to extend the authority lease.
export const RUN_PROVISIONAL_MAX_TICKS=120;
export const RUN_PROVISIONAL_MAX_INTENTS=128;
const HZ=RUN_RULES.hz,MAX_TICK=RUN_RULES.durationMs*HZ/1000;
const types=new Set(['left','right','jump','slide','item']);
const integer=(n,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const identifier=(s,min=1,max=128)=>typeof s==='string'&&new RegExp(`^[A-Za-z0-9_-]{${min},${max}}$`).test(s);
const copy=value=>structuredClone(value);
function immutable(value){if(value&&typeof value==='object'){Object.values(value).forEach(immutable);Object.freeze(value);}return value;}
function physical(player){
 const {tick,...result}=player;
 return copy(result);
}
function eligible(room){
 const g=room?.game,players=g?.players;
 return room?.game_id==='run'&&room.practice===true&&room.entry_minor==='0'&&identifier(room.id,8,64)&&identifier(room.me)
  &&integer(room.version)&&integer(room.me_last_seq)&&g?.ruleVersion===RUN_PRACTICE_RULE_VERSION&&g.me===room.me
  &&Array.isArray(players)&&players.filter(p=>p.isBot===false).length===1&&players.some(p=>p.key===room.me&&p.isBot===false)
  &&players.filter(p=>p.isBot===true).length===players.length-1;
}
function restore(room){
 const model=createRunSelfProjection();
 if(!model.update(room.game,room.me,{roomId:room.id,roomVersion:room.version}))return null;
 const own=model.stateAtTick(room.game.snapshotTick);
 return own?physical(own):null;
}
function pose(player,tick,authoritativeFinishTick){
 const at=runnerPose(player,tick);
 let y=at.y,scale=1;
 if(player.fallUntilTick!==null){const progress=Math.max(0,Math.min(1,(tick-player.fallStartTick)/RUN_RULES.respawnTicks));y=-Math.min(2.4,progress*5);scale=Math.max(.15,1-progress*.9);}
 return {x:at.x,y,scale,distance:player.distanceU/RUN_RULES.distanceUnitsPerMeter,tick,sliding:at.sliding,
  hits:player.hits,fallStartTick:player.fallStartTick,fallUntilTick:player.fallUntilTick,stunUntilTick:player.stunUntilTick,
  provisionalFinish:player.finishTick!==null&&authoritativeFinishTick===null,predictionOnly:true,
  // Never select a winner/victory clip from speculative finish or input counts.
  visualPlayer:{...physical(player),finishTick:authoritativeFinishTick,finishedAt:null,predictionOnly:true}};
}

/** Free BOT practice own-player model. `seq` is a LOCAL intent sequence;
 * `wireSeq` is the successful-action sequence used by the existing HTTP API.
 * A denial consumes the former, never the latter. No method sends a request,
 * emits a game event, awards a score, or fabricates a successful receipt.
 *
 * Local actions use their submitted execution ticks. If newer authority has
 * already passed an unresolved tick, replay cannot backdate that action into
 * the received state: it is retained as unresolved with an explicit issue.
 * Fixing this timing disagreement needs a new server-authoritative practice
 * input protocol, not a larger client lease or smoothing away collisions.
 */
export function createRunProvisionalSimulation({maxPredictionTicks=RUN_PROVISIONAL_MAX_TICKS}={}){
 if(!integer(maxPredictionTicks,1,RUN_PROVISIONAL_MAX_TICKS))throw new RangeError('Invalid provisional horizon');
 let base=null,course=null,states=[],frames=[],intents=new Map(),lastSeq=0,lastSubmittedTick=-1;
 let clockTick=0,clockAt=0,lastNow=null,lastDisplayTick=null,lastPose=null;
 let firstReceivedAt=0,mode='unsupported',reason='no-authority',suspended=false,hidden=false,resumeTick=-1,terminalScope=null;
 let correction=null,correctionSerial=0,issues=[];
 const fail=why=>({ok:false,reason:why});
 function clear(){base=null;course=null;states=[];frames=[];intents=new Map();lastSeq=0;lastSubmittedTick=-1;clockTick=0;clockAt=0;lastNow=null;lastDisplayTick=null;lastPose=null;firstReceivedAt=0;mode='unsupported';reason='no-authority';suspended=false;hidden=false;resumeTick=-1;terminalScope=null;correction=null;correctionSerial=0;issues=[];}
 function diagnostics(){return immutable([...intents.values()].map(record=>({seq:record.seq,type:record.type,submittedTick:record.submittedTick,
  wireSeq:record.binding?.wireSeq??null,outcome:record.outcome,incorporated:record.incorporated,localAdmission:record.localAdmission,
  receipt:record.receipt?copy(record.receipt):null})));}
 function correctionFrom(before,after,cause,extra={}){
  if(!before||!after)return;
  const changed=['x','y','distance','hits','fallUntilTick','stunUntilTick'].filter(key=>before[key]!==after[key]);
  if(changed.length||Object.keys(extra).length)correction=immutable({id:++correctionSerial,cause,changed,
   fromTick:before.tick,toTick:after.tick,distanceDelta:after.distance-before.distance,xDelta:after.x-before.x,yDelta:after.y-before.y,
   authoritativeCollision:after.hits>before.hits||after.fallUntilTick!==null&&before.fallUntilTick===null,...extra});
 }
 // Use the real engine admission without copying its rules. At this exact
 // tick act() must not advance physics; all movement uses the shared runner
 // function below. Opponents participate only in received terminal flags.
 function admit(player,input,current){
  const g=base.room.game,now=Math.ceil(g.startedAt+current*1000/HZ);
  const shell={...g,tick:current,now,endTick:base.endTick,eventSerial:0,events:[],winnerKeys:[],
   players:g.players.map(p=>p.key===base.room.me?player:{key:p.key,forfeited:p.forfeited,finishTick:p.finishTick})};
  try{act(shell,base.room.me,{type:input.type,observed_tick:current},now);}
  catch(error){if(shell.tick!==current)throw new Error('Provisional admission advanced physics');return error.code??'ADMISSION_FAILED';}
  if(shell.tick!==current)throw new Error('Provisional admission advanced physics');
  return null;
 }
 function rebuild(){
  states=[];frames=[];issues=[];
  if(!base||mode!=='provisional')return;
  const player=physical(base.player),byTick=new Map(),end=Math.min(base.tick+maxPredictionTicks,base.endTick);
  for(const input of intents.values()){
   input.localAdmission=null;
   if(input.incorporated||input.outcome==='rejected')continue;
   if(input.submittedTick<=base.tick){input.localAdmission='unacked-input-before-authority';issues.push({seq:input.seq,reason:input.localAdmission});continue;}
   const list=byTick.get(input.submittedTick)??[];list.push(input);byTick.set(input.submittedTick,list);
  }
  states.push(immutable({tick:base.tick,...physical(player)}));frames.push(immutable(pose(player,base.tick,base.player.finishTick)));
  for(let tick=base.tick+1;tick<=end;tick++){
   for(const input of byTick.get(tick)??[]){
    const error=admit(player,input,tick-1);input.localAdmission=error??'predicted';
    if(error)issues.push({seq:input.seq,reason:error});
   }
   const events=[];
   stepRunnerInPlace(player,tick,course,{at:base.room.game.startedAt+tick*1000/HZ,emit:type=>events.push(type)});
   states.push(immutable({tick,...physical(player)}));frames.push(immutable({...pose(player,tick,base.player.finishTick),localEvents:events}));
   if(player.finishTick!==null||player.forfeited)break;
  }
 }
 function poseAt(tick){
  if(!frames.length)return null;
  const offset=Math.max(0,Math.min(frames.length-1,tick-base.tick)),index=Math.floor(offset),fraction=offset-index;
  const left=frames[index],right=frames[Math.min(index+1,frames.length-1)];
  // Hard physical transitions happen at the shared integer tick, never early.
  const hard=(right.localEvents??[]).some(type=>['hit','shield_hit','fall','respawn','finish'].includes(type));
  const mix=hard?0:fraction;
  return immutable({...copy(left),x:left.x+(right.x-left.x)*mix,y:left.y+(right.y-left.y)*mix,
   distance:left.distance+(right.distance-left.distance)*mix,scale:left.scale+(right.scale-left.scale)*mix,tick:base.tick+offset});
 }
 function receive(room,receivedAtMs){
  if(!Number.isFinite(receivedAtMs)||receivedAtMs<0)return fail('invalid-time');
  if(!eligible(room)){clear();reason='not-free-bot-practice';return fail(reason);}
  if(terminalScope===`${room.id}/${room.me}`)return fail('terminal-room');
  const sameScope=base&&room.id===base.room.id&&room.me===base.room.me;
  if(sameScope&&(room.version<=base.room.version||room.game.snapshotTick<base.tick))return fail('old-authority');
  if(!sameScope)clear();
  if(room.status!=='active'||room.game.status!=='active'){
   terminalScope=`${room.id}/${room.me}`;mode='authoritative-terminal';reason='server-terminal';states=[];frames=[];lastPose=null;intents.clear();return {ok:true,mode};
  }
  const own=restore(room);
  if(!own){mode='reconcile-required';reason='invalid-authority';return fail(reason);}
  const tick=room.game.snapshotTick,endTick=Math.round((room.game.deadlineAt-room.game.startedAt)*HZ/1000);
  if(sameScope&&['ruleVersion','courseId','contentVersion','levelVersion','physicsVersion','startedAt'].some(key=>room.game[key]!==base.room.game[key])){mode='reconcile-required';reason='mapping-changed';return fail(reason);}
  if(sameScope&&(receivedAtMs<firstReceivedAt||room.me_last_seq<base.room.me_last_seq||own.inputNo<base.player.inputNo||own.inputNo-base.player.inputNo!==room.me_last_seq-base.room.me_last_seq)){mode='reconcile-required';reason='authority-sequence-conflict';return fail(reason);}
  if(sameScope){
   const incorporated=[];
   for(let wireSeq=base.room.me_last_seq+1;wireSeq<=room.me_last_seq;wireSeq++){
    const matches=[...intents.values()].filter(input=>input.binding?.wireSeq===wireSeq&&input.outcome!=='rejected');
    if(matches.length!==1){mode='reconcile-required';reason='unmapped-authoritative-input';return fail(reason);}
    const input=matches[0],inputNo=base.player.inputNo+wireSeq-base.room.me_last_seq;
    if(input.receipt&&input.receipt.inputNo!==inputNo){mode='reconcile-required';reason='receipt-sequence-conflict';return fail(reason);}
    incorporated.push(input);
   }
   incorporated.forEach(input=>{input.incorporated=true;});
  }
  const before=lastPose,priorTick=base?.tick??-1;
  if(!base||tick>clockTick+(receivedAtMs-clockAt)*HZ/1000){clockTick=tick;clockAt=receivedAtMs;}
  if(tick>priorTick)firstReceivedAt=receivedAtMs;
  base={room:copy(room),tick,endTick,player:own};course=resolveRunCourse(base.room.game);
  if(suspended&&(hidden||tick<=resumeTick)){mode='suspended';reason='awaiting-new-authority';return {ok:true,mode};}
  suspended=false;mode='provisional';reason=null;rebuild();
  if(lastDisplayTick!==null)correctionFrom(before,poseAt(lastDisplayTick),'authoritative-state');
  // Bounded live intent storage; old exact receipts are ignored via local seq
  // watermarks after pruning, not replayed into a later room.
  for(const [seq,input]of intents)if(input.incorporated&&input.outcome!=='unresolved'||input.outcome==='rejected'&&input.submittedTick<=base.tick)intents.delete(seq);
  return {ok:true,mode};
 }
 function submit({seq,type,submittedTick}={}){
  if(mode!=='provisional'||!base||suspended)return fail('not-predicting');
  if(!integer(seq,1)||seq!==lastSeq+1||!types.has(type)||!integer(submittedTick,base.tick+1,Math.min(base.endTick,base.tick+maxPredictionTicks))||submittedTick<lastSubmittedTick||lastDisplayTick!==null&&submittedTick<=Math.floor(lastDisplayTick))return fail('invalid-local-intent');
  if(lastNow!==null&&lastNow-firstReceivedAt>=maxPredictionTicks*1000/HZ)return fail('prediction-horizon-exhausted');
  if(intents.size>=RUN_PROVISIONAL_MAX_INTENTS)return fail('intent-capacity');
  const input={seq,type,submittedTick,binding:null,receipt:null,outcome:'unresolved',incorporated:false,localAdmission:null};
  intents.set(seq,input);lastSeq=seq;lastSubmittedTick=submittedTick;rebuild();
  return {ok:true,seq,localAdmission:input.localAdmission,transportOutcome:'unresolved'};
 }
 function bindDispatch({seq,requestId,wireSeq}={}){
  const input=intents.get(seq);
  if(!base||!input||input.binding||input.outcome!=='unresolved'||!identifier(requestId,8,128)||wireSeq!==base.room.me_last_seq+1)return fail('invalid-dispatch');
  if([...intents.values()].some(other=>other.binding&&(other.binding.requestId===requestId||other.binding.wireSeq===wireSeq&&other.outcome!=='rejected')))return fail('duplicate-dispatch');
  input.binding={requestId,wireSeq};
  // Opaque identity binds even rejection/network failure to this model's
  // current room lifetime. A late old-room failure cannot reject a reused seq.
  input.token=Object.freeze({roomId:base.room.id,playerKey:base.room.me,seq,requestId,wireSeq});
  return {ok:true,token:input.token};
 }
 function resolve({token,outcome,room=null,resolvedAtMs}={}){
  const seq=token?.seq;
  const input=intents.get(seq);
  if(!base||!input||!input.binding||input.token!==token||input.outcome!=='unresolved'||!['accepted','rejected','unresolved'].includes(outcome))return fail('unmatched-resolution');
  if(outcome==='unresolved')return {ok:true,outcome:'unresolved'};
  const before=lastPose;
  if(outcome==='accepted'){
   const receipt=readRunActionReceipt(room,{roomId:base.room.id,playerKey:base.room.me,request_id:input.binding.requestId,
    seq:input.binding.wireSeq,type:input.type,ruleVersion:base.room.game.ruleVersion});
   if(!receipt||!Number.isFinite(resolvedAtMs)||resolvedAtMs<0)return fail('invalid-receipt');
   input.receipt=receipt;input.outcome='accepted';
   const result=receive(room,resolvedAtMs);
   if(!result.ok&&result.reason!=='old-authority')return result;
   const mismatch=receipt.acceptedTick!==input.submittedTick;
   if(mismatch)correctionFrom(before,poseAt(lastDisplayTick??base.tick),'execution-tick-mismatch',
    {seq,submittedTick:input.submittedTick,acceptedTick:receipt.acceptedTick});
   return {ok:true,outcome:'accepted',executionTickMismatch:mismatch};
  }
  if(input.incorporated)return fail('rejection-conflicts-with-authority');
  input.outcome='rejected';rebuild();correctionFrom(before,poseAt(lastDisplayTick??base.tick),'input-rejected',{seq});
  return {ok:true,outcome:'rejected'};
 }
 function sample(now){
  if(!Number.isFinite(now)||now<0)return null;
  const time=Math.max(now,lastNow??now);lastNow=time;
  if(base&&mode==='provisional'){
   const requested=Math.max(base.tick,clockTick+(time-clockAt)*HZ/1000,lastDisplayTick??base.tick);
   const at=Math.min(requested,base.tick+maxPredictionTicks,base.endTick,states.at(-1)?.tick??base.tick);
   lastDisplayTick=at;lastPose=poseAt(at);
  }
  const expired=base!==null&&(time-firstReceivedAt>=maxPredictionTicks*1000/HZ||lastDisplayTick>=base.tick+maxPredictionTicks);
  return immutable({mode:mode==='provisional'&&expired?'disconnected':mode,reason:expired?'prediction-horizon-exhausted':reason,
   pose:lastPose?copy(lastPose):null,displayTick:lastDisplayTick,nextInputTick:lastDisplayTick===null?null:Math.floor(lastDisplayTick)+1,
   authority:base?{snapshotTick:base.tick,version:base.room.version,inputNo:base.player.inputNo,appliedInputNo:base.player.appliedInputNo,
    receivedAtMs:firstReceivedAt,leaseExpired:time-firstReceivedAt>=RUN_PROJECTION_LIMIT_MS}:null,
   correction:copy(correction),issues:copy(issues),intents:diagnostics()});
 }
 function suspend(){hidden=true;suspended=true;resumeTick=base?.tick??-1;mode='suspended';reason='awaiting-new-authority';}
 function resume(){hidden=false;resumeTick=base?.tick??-1;suspended=true;mode='suspended';reason='awaiting-new-authority';}
 return {receive,submit,bindDispatch,resolve,sample,suspend,resume,clear,
  stateAtTick(tick){return base&&integer(tick,base.tick,base.tick+states.length-1)?states[tick-base.tick]:null;}};
}
