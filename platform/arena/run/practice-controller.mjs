import {act} from './engine.mjs';
import {RUN_RULES,runnerPose,stepRunnerInPlace} from './runner-physics.mjs';
import {restoreRunSelfState} from './self-projection.mjs';
import {sampleRunCausalFrames} from './causal-sampling.mjs';
import {createRunPracticeInputOutbox,RUN_PRACTICE_OUTBOX_PROTOCOL,RUN_PRACTICE_OUTBOX_RULE_VERSION} from './practice-input-outbox.mjs';
import {resolveRunPracticeProfile} from '../../shared/run-practice-profiles.mjs';
import {readRunPracticeRoomProfile} from './practice-profile-contract.mjs';

// An explicit V2.3 free-BOT controller. This is NOT an increased V2.2 lease.
// Only its own runner is simulated. No transport, sounds, winners or payments.
export const RUN_PRACTICE_CONTROLLER_LIMITS=Object.freeze({authorityMs:650,provisionalMs:2000,historyTicks:120,futureTicks:120,receiveSteps:360,frames:241,localCommands:64});
const L=RUN_PRACTICE_CONTROLLER_LIMITS,HZ=RUN_RULES.hz,MS=1000/HZ,END=6000;
const fields=['key','distanceU','checkpointU','lane','fromLane','changeStartTick','changeEndTick','jumpStartTick','slideUntilTick','stunUntilTick','immuneUntilTick','fallStartTick','fallUntilTick','shieldUntilTick','boostUntilTick','inventory','claimedItems','resolvedObstacles','hits','inputNo','appliedInputNo','lastInputTick','pendingInput','finishTick','finishedAt','forfeited'];
const mappingFields=['ruleVersion','courseId','contentVersion','levelVersion','physicsVersion','startedAt'];
const types=new Set(['left','right','jump','slide','item']);
const physicalEvents=new Set(['hit','shield_hit','fall','respawn','finish']);
const integer=(n,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const time=n=>Number.isFinite(n)&&n>=0;
const id=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s);
const exact=(o,keys)=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const clone=structuredClone;
function freeze(o){if(o&&typeof o==='object'&&!Object.isFrozen(o)){for(const v of Object.values(o))freeze(v);Object.freeze(o);}return o;}
function same(a,b){if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));}
const own=p=>Object.fromEntries(fields.map(k=>[k,clone(p[k])]));
const fail=reason=>Object.freeze({ok:false,reason});
const matches=(a,b)=>a.commandSeq===b.commandSeq&&a.type===b.type&&a.executeTick===b.executeTick;

function publicOwn(p,tick){
 const at=runnerPose(p,tick);
 return {...p,distance:p.distanceU/300,checkpoint:p.checkpointU/300,netDistance:Math.round((p.fallUntilTick!==null?p.checkpointU:p.distanceU)/3)/100,
  x:at.x,y:at.y,sliding:at.sliding,speed:p.forfeited||p.finishTick!==null||p.fallUntilTick!==null||tick<p.stunUntilTick?0:tick<p.boostUntilTick?9.6:8};
}
// Reuse the existing strict own-state validator, without asking its projection
// to precompute another 39 ticks. Derived metadata here is for validation of a
// server-supplied anchor only; it never changes the authoritative room status.
function validationGame(game,tick,player=null){
 const first=game.firstFinishTick!==null&&game.firstFinishTick<=tick?game.firstFinishTick:null;
 return {...game,status:'active',phase:first===null?'racing':'finish-window',snapshotTick:tick,
  serverNow:game.startedAt+tick*1000/HZ,firstFinishTick:first,deadlineAt:game.startedAt+(first===null?END:Math.min(END,first+RUN_RULES.postFinishTicks))*MS,
  ...(player?{players:game.players.map(p=>p.key===game.me?publicOwn(player,tick):p),
   selfPrediction:{schema:'run-self-projection-v1',resolvedObstacles:player.resolvedObstacles,pendingInput:player.pendingInput,lastInputTick:player.lastInputTick}}:{})};
}
function makeFrame(p,tick,boundary,boundaryEvents,resultAuthorized,snapshot){
 const at=runnerPose(p,tick),fall=p.fallUntilTick!==null,progress=fall?Math.max(0,Math.min(1,(tick-p.fallStartTick)/RUN_RULES.respawnTicks)):0;
 const visualPlayer=freeze({...snapshot,finishTick:resultAuthorized?p.finishTick:null,finishedAt:resultAuthorized?p.finishedAt:null,predictionOnly:true});
 return freeze({x:at.x,y:fall?-Math.min(2.4,progress*5):at.y,distance:p.distanceU/300,tick,scale:fall?Math.max(.15,1-progress*.9):1,sliding:at.sliding,
  hits:p.hits,fallUntilTick:p.fallUntilTick,fallStartTick:p.fallStartTick,stunUntilTick:p.stunUntilTick,checkpoint:p.checkpointU/300,
  claimedItemCount:p.claimedItems.length,resolvedObstacleCount:p.resolvedObstacles.length,boundary,boundaryEvents,visualPlayer});
}
function admit(player,command,tick,game){
 if(player.pendingInput&&player.pendingInput.tick===command.executeTick&&player.pendingInput.type===command.type
  &&command.acceptedInputNo===player.pendingInput.no)return null;
 const at=Math.ceil(game.startedAt+tick*1000/HZ);
 // Opponents have no physical interaction. Do not borrow their later finish
 // state while admitting an older own command at an anchor checkpoint.
 const shell={...game,status:'active',phase:'racing',tick,now:at,endTick:Math.round((game.deadlineAt-game.startedAt)/MS),events:[],eventSerial:0,winnerKeys:[],
  players:[player,{key:'__practice_other',forfeited:false,finishTick:null}]};
 try{act(shell,player.key,{type:command.type,observed_tick:tick},at);}catch(error){return error.code??'ADMISSION_FAILED';}
 if(shell.tick!==tick)return 'ADMISSION_ADVANCED_PHYSICS';
 if(command.acceptedInputNo!==undefined&&command.acceptedInputNo!==player.inputNo)return 'ACCEPTED_INPUT_NUMBER_CONFLICT';
 return null;
}
// Immutable scalar records share unchanged owned arrays. Physics always receives
// its own mutable copy; a later push/respawn cannot mutate a retained frame.
function snapshotter(){
 let claimed=null,resolved=null,pending=null;
 const array=(source,previous)=>previous&&source.length===previous.length&&source.every((v,i)=>v===previous[i])?previous:Object.freeze([...source]);
 return (p,tick)=>{
  claimed=array(p.claimedItems,claimed);resolved=array(p.resolvedObstacles,resolved);
  pending=same(p.pendingInput,pending)?pending:p.pendingInput===null?null:Object.freeze({...p.pendingInput});
  const snapshot={tick};for(const key of fields)snapshot[key]=key==='claimedItems'?claimed:key==='resolvedObstacles'?resolved:key==='pendingInput'?pending:p[key];
  return Object.freeze(snapshot);
 };
}
function replay(base,end,commands,work,{capture=true,authorized=false,strict=false,prefix=null}={}){
 const retained=prefix?.states.length??0,start=retained?prefix.states.at(-1).tick:base.anchorTick;
 const p=own(retained?prefix.states.at(-1):base.anchor),byTick=new Map(),frames=prefix?.frames.slice()??[],states=prefix?.states.slice()??[],issues=prefix?.issues.slice()??[],snapshot=snapshotter();
 for(const command of commands){const group=byTick.get(command.executeTick)??[];group.push(command);byTick.set(command.executeTick,group);}
 let boundary=null,boundaryEvents=[];
 for(let tick=start;tick<=end;tick++){
  // A reused endpoint already contains the identical tick+1 admission. Never
  // admit it twice or recapture it; only extend its deterministic suffix.
  if(tick!==start||!retained){
   for(const command of byTick.get(tick+1)??[]){
    const error=admit(p,command,tick,base.game);
    if(error){if(strict||command.acceptedInputNo!==undefined)throw new Error('accepted-history-invalid');issues.push({commandSeq:command.commandSeq,reason:error});}
   }
   if(capture){const state=snapshot(p,tick);states.push(state);frames.push(makeFrame(p,tick,boundary,boundaryEvents,authorized,state));work.framesAllocated=(work.framesAllocated??0)+1;}
  }
  if(tick===end)break;
  if(++work.steps>(work.limit??L.receiveSteps))throw new Error('work-limit');
  const next=tick+1,stunned=tick<p.stunUntilTick,resolved=p.resolvedObstacles.length;boundary=null;boundaryEvents=[];
  stepRunnerInPlace(p,next,base.course,{at:base.game.startedAt+next*1000/HZ,emit(type){if(physicalEvents.has(type)){boundary=type;boundaryEvents.push(type);}}});
  if(boundary===null&&resolved!==p.resolvedObstacles.length){boundary='collision';boundaryEvents.push('collision');}
  if(boundary===null&&stunned&&next>=p.stunUntilTick)boundary='recovery';
 }
 work.framesReused=(work.framesReused??0)+retained;
 return {player:p,frames,states,issues};
}

/** Fixed room/viewer/epoch lifetime. Auth-owner changes must dispose this
 * instance even if the visible player key is reused. Host time is monotonic
 * performance.now(), not server epoch time. This object has no internal clock.
 *
 * `receive` validates the complete own replay proof before refreshing a budget.
 * `transport.resolve` only acknowledges exact batch receipts; it cannot renew
 * authority freshness. A GET cursor never acknowledges the outbox.
 * Only the actual renderer calls sample(RAF timestamp). HUD consumers use
 * peek(), which reads the last immutable result without advancing that clock.
 */
export function createRunPracticeController({roomId,playerKey,clockEpoch,makeRequestId,profile:requestedProfile={ruleVersion:RUN_PRACTICE_OUTBOX_RULE_VERSION,protocol:RUN_PRACTICE_OUTBOX_PROTOCOL}}={}){
 if(!id(roomId)||!id(playerKey)||!integer(clockEpoch,1)||typeof makeRequestId!=='function')throw new TypeError('INVALID_CONTROLLER_SCOPE');
 const profile=resolveRunPracticeProfile(requestedProfile);if(!profile)throw new TypeError('INVALID_CONTROLLER_PROFILE');
 const L={...RUN_PRACTICE_CONTROLLER_LIMITS,historyTicks:profile.historyTicks,futureTicks:profile.futureTicks,provisionalMs:profile.leaseMs,receiveSteps:profile.clientWorkTicks,frames:profile.trajectoryFrames};
 const scope=Object.freeze({roomId,playerKey,clockEpoch});
 let base=null,outbox=null,local=new Map(),trajectory=null,mapping=null,closed=false,epochLost=false;
 let firstReceivedAt=null,highestHead=-1,lastReceiveAt=-Infinity,clockTick=0,clockAt=0,lastSampleAt=-Infinity,lastRaw=null,lastPose=null,lastSample=null;
 let hidden=false,resumeAfter=null,replayFailure=null,reason='no-authority',correction=null,correctionSerial=0,lastWorkSteps=0,clockReset=null;
 const statistics={receives:0,rebuilds:0,samples:0,stepCalls:0,maxReceiveSteps:0,maxFrames:0,sampleHistoryCopies:0,frameRecordsAllocated:0,stateRecordsAllocated:0,frameRecordsReused:0};

 function parse(room){
  const a=room?.run_inputs,g=room?.game;
  if(room?.id!==roomId||room?.me!==playerKey||a?.roomId!==roomId||a?.playerKey!==playerKey)return fail('scope-mismatch');
  if(a.clockEpoch!==clockEpoch)return fail('epoch-mismatch');
  if(readRunPracticeRoomProfile(room)!==profile||g?.ruleVersion!==profile.ruleVersion
   ||a.protocol!==profile.protocol||a.ruleVersion!==g.ruleVersion||g.me!==playerKey
   ||!Array.isArray(g.players)||g.players.length<2||g.players.length>4||g.players.some(p=>typeof p?.isBot!=='boolean')
   ||g.players.filter(p=>!p.isBot).length!==1||!g.players.some(p=>p.key===playerKey&&!p.isBot))return fail('unsupported-profile');
  if(profile.profileId!==null&&g.players.length!==room.capacity)return fail('unsupported-profile');
  if(!integer(room.version)||!integer(a.revision)||!integer(a.headTick,0,END)||g.snapshotTick!==a.headTick
   ||!integer(a.serverTick,a.headTick,profile.serverMaxTick)||!integer(a.committedThroughTick,0,a.serverTick)
   ||!integer(a.processedThroughCommandSeq)||!integer(a.acceptedInputNo,0,a.processedThroughCommandSeq))return fail('invalid-authority');
  if(!['active','settling','settled'].includes(room.status)||!['active','finished'].includes(g.status)
   ||(g.status==='active'&&!['racing','finish-window'].includes(g.phase))||(g.status==='finished'&&g.phase!=='finished'))return fail('unsupported-phase');
  const endTick=g.firstFinishTick===null?END:Math.min(END,g.firstFinishTick+RUN_RULES.postFinishTicks);
  if(!integer(g.startedAt)||!Number.isFinite(g.serverNow)||Math.abs(g.serverNow-(g.startedAt+a.headTick*MS))>1e-7
   ||g.firstFinishTick!==null&&!integer(g.firstFinishTick,0,a.headTick)||!Number.isFinite(g.deadlineAt)
   ||Math.abs(g.deadlineAt-(g.startedAt+endTick*MS))>1e-7)return fail('invalid-game-clock');
  const proof=a.selfReplay;
  if(!exact(proof,['schema','anchorTick','player','acceptedCommands'])||proof.schema!=='run-practice-self-replay-v1'
   ||!integer(proof.anchorTick,Math.max(0,a.headTick-L.historyTicks),a.headTick)||proof.anchorTick>a.committedThroughTick
   ||!exact(proof.player,fields)||proof.player.key!==playerKey||!Array.isArray(proof.acceptedCommands)||proof.acceptedCommands.length>128)return fail('replay-required');
  const head=restoreRunSelfState(g.status==='finished'?validationGame(g,a.headTick):g,playerKey);
  const anchor=restoreRunSelfState(validationGame(g,proof.anchorTick,proof.player),playerKey);
  if(!head||!anchor||!same(anchor.player,proof.player)||head.player.inputNo!==a.acceptedInputNo)return fail('invalid-self-state');
  const map=mappingFields.map(key=>g[key]);
  if(mapping&&!same(mapping,map))return fail('mapping-mismatch');
  let priorSeq=0,priorTick=proof.anchorTick,priorNo=anchor.player.inputNo;
  for(const c of proof.acceptedCommands){
   if(!exact(c,['commandSeq','type','executeTick','acceptedInputNo'])||!integer(c.commandSeq,priorSeq+1,a.processedThroughCommandSeq)
    ||!types.has(c.type)||!integer(c.executeTick,priorTick+1,Math.min(END+1,a.headTick+1))||!integer(c.acceptedInputNo,1))return fail('invalid-accepted-tail');
   const pending=anchor.player.pendingInput;
   if(!(priorSeq===0&&pending&&c.acceptedInputNo===priorNo&&c.executeTick===pending.tick&&c.type===pending.type)&&c.acceptedInputNo!==priorNo+1)return fail('invalid-accepted-tail');
   priorSeq=c.commandSeq;priorTick=c.executeTick;priorNo=c.acceptedInputNo;
  }
  let authorization=null;
  if(a.resultAuthorization!==null){
   const r=a.resultAuthorization;
   if(!exact(r,['key','clockEpoch','terminalTick','committedThroughTick','revision'])||g.status!=='finished'
    ||r.key!==`${roomId}/${clockEpoch}/${a.headTick}`||r.clockEpoch!==clockEpoch||r.terminalTick!==a.headTick
    ||r.committedThroughTick!==a.committedThroughTick||r.committedThroughTick<r.terminalTick||r.revision!==a.revision)return fail('invalid-result-authorization');
   authorization=freeze({...r});
  }
  const correction=a.correction;
  if(correction!==null&&(!exact(correction,['revision','previousRevision','fromTick','toTick','stateChanged','eventsRequireRevision'])
   ||correction.revision!==a.revision||!integer(correction.previousRevision,0,a.revision-1)||!integer(correction.fromTick,1,a.headTick)
   ||correction.toTick!==a.headTick||typeof correction.stateChanged!=='boolean'||correction.eventsRequireRevision!==true))return fail('invalid-correction');
  if(base&&(a.revision<=base.revision||a.serverTick<base.serverTick||a.processedThroughCommandSeq<base.processedThroughCommandSeq||a.acceptedInputNo<base.acceptedInputNo))return fail('old-authority');
  if(base&&a.headTick<base.headTick&&!correction)return fail('unproved-head-rewind');
  if(outbox&&a.processedThroughCommandSeq>outbox.state().lastCommandSeq)return fail('foreign-command-sequence');
  return {ok:true,game:clone(g),course:head.course,anchor:anchor.player,anchorTick:proof.anchorTick,head:head.player,headTick:a.headTick,serverTick:a.serverTick,
   revision:a.revision,roomVersion:room.version,processedThroughCommandSeq:a.processedThroughCommandSeq,acceptedInputNo:a.acceptedInputNo,
   committedThroughTick:a.committedThroughTick,accepted:clone(proof.acceptedCommands),authorization,mapping:map,correction:clone(correction),terminal:g.status==='finished'};
 }
 function commandsFor(candidate,records){
  const commands=new Map(candidate.accepted.map(c=>[c.commandSeq,c]));let blocked=null;const issues=[];
  for(const [seq,input]of records){
   const known=commands.get(seq),d=input.decision;
   if(known){if(!matches(known,input)||d&&(d.outcome!=='accepted'||d.acceptedInputNo!==known.acceptedInputNo))throw new Error('command-history-conflict');continue;}
   if(d?.outcome==='rejected')continue;
   if(input.executeTick<=candidate.anchorTick){
    if(d?.outcome==='accepted'&&d.acceptedInputNo<=candidate.anchor.inputNo)continue;
    blocked??=seq<=candidate.processedThroughCommandSeq?'processed-outcome-unknown':'input-expired';issues.push({commandSeq:seq,reason:blocked});continue;
   }
   if(seq<=candidate.processedThroughCommandSeq){
    // Absence from the accepted tail does NOT prove a rejection. The exact
    // original response may still be needed, even after a GET advanced head.
    if(d?.outcome!=='rejected'){blocked??='processed-outcome-unknown';issues.push({commandSeq:seq,reason:'processed-outcome-unknown'});}continue;
   }
   if(input.executeTick<=candidate.committedThroughTick){blocked??='input-expired';issues.push({commandSeq:seq,reason:'input-expired'});continue;}
   commands.set(seq,{commandSeq:seq,type:input.type,executeTick:input.executeTick,...(d?.outcome==='accepted'?{acceptedInputNo:d.acceptedInputNo}:{})});
  }
  return {commands:[...commands.values()].sort((a,b)=>a.executeTick-b.executeTick||a.commandSeq-b.commandSeq),blocked,issues};
 }
 function build(candidate,records,work){
  work.limit=L.receiveSteps;
  const plan=commandsFor(candidate,records),end=Math.min(END,Math.round((candidate.game.deadlineAt-candidate.game.startedAt)/MS),candidate.headTick+L.futureTicks);
  let prefix=null;
  const offset=base?candidate.anchorTick-base.anchorTick:-1,finalTick=candidate.terminal?candidate.headTick:end;
  const first=own(candidate.anchor);
  for(const command of plan.commands.filter(c=>c.executeTick===candidate.anchorTick+1)){
   const error=admit(first,command,candidate.anchorTick,candidate.game);
   if(error&&command.acceptedInputNo!==undefined)throw new Error('accepted-history-invalid');
  }
  if(profile.profileId!==null&&trajectory&&offset>=0&&offset<trajectory.states.length&&same(candidate.mapping,base.mapping)
   &&!!candidate.authorization===!!base.authorization&&same(own(trajectory.states[offset]),first)){
   const previous=trajectory.commands.filter(c=>c.executeTick>candidate.anchorTick),next=plan.commands;
   const prior=new Map(previous.map(c=>[c.commandSeq,c])),current=new Map(next.map(c=>[c.commandSeq,c]));
   let changedAt=Infinity;
   for(const seq of new Set([...prior.keys(),...current.keys()]))if(!same(prior.get(seq),current.get(seq)))changedAt=Math.min(changedAt,prior.get(seq)?.executeTick??Infinity,current.get(seq)?.executeTick??Infinity);
   // Captured states contain the next tick's admission. Stop one complete
   // interval before a changed command, preserving all hard event boundaries.
   const through=Math.min(finalTick,trajectory.states.at(-1).tick,changedAt-2),count=through-candidate.anchorTick+1;
   if(count>0){const sequences=new Set(next.filter(c=>c.executeTick<=through+1).map(c=>c.commandSeq));prefix={states:trajectory.states.slice(offset,offset+count),frames:trajectory.frames.slice(offset,offset+count),issues:trajectory.issues.filter(i=>sequences.has(i.commandSeq))};}
  }
  const built=replay(candidate,finalTick,plan.commands,work,{authorized:!!candidate.authorization,prefix});
  if(built.frames.length>L.frames)throw new Error('frame-limit');
  // Enqueue/receipt rebuilds of this exact anchor can only change commands
  // after it. Retain its already verified causal predecessor, including when
  // a new pending input changes the anchor's admission metadata.
  return {...built,...(candidate===base&&trajectory?.predecessor?{predecessor:trajectory.predecessor}:{}),
   commands:plan.commands,blocked:plan.blocked,issues:[...plan.issues,...built.issues]};
 }
 function rawAt(now,candidate=base){
  if(!candidate)return null;
  const deadline=firstReceivedAt+L.provisionalMs;
  const raw=Math.min(candidate.headTick+L.futureTicks,Math.round((candidate.game.deadlineAt-candidate.game.startedAt)/MS),
   clockTick+Math.max(0,Math.min(now,deadline)-clockAt)/MS);
  const nearest=Math.round(raw);
  return Math.abs(raw-nearest)<=Number.EPSILON*Math.max(1,Math.abs(raw))*4?nearest:raw;
 }
 function poseAt(raw,built=trajectory,candidate=base){
  if(!built?.frames.length)return null;
  const elapsed=Math.max(0,(raw-candidate.anchorTick)*MS),limit=Math.max(0,(built.frames.length-1)*MS);
  const pose=sampleRunCausalFrames(built.frames,candidate.anchorTick,candidate.revision,elapsed,limit,built.predecessor??null);
  return pose?{...pose,predictionOnly:true,provisionalFinish:pose.visualPlayer.finishTick===null&&built.states[Math.min(built.states.length-1,Math.max(0,Math.floor(raw-candidate.anchorTick)))].finishTick!==null}:null;
 }
 function changed(before,after,cause){
  if(!before||!after)return;
  const delta={x:after.x-before.x,y:after.y-before.y,distance:after.distance-before.distance,scale:after.scale-before.scale};
  if(Object.values(delta).some(n=>Math.abs(n)>1e-9))correction=freeze({id:++correctionSerial,cause,revision:base.revision,fromTick:before.tick,toTick:after.tick,delta});
 }
 function gate(now){
  if(closed)return 'closed';if(epochLost)return 'epoch-mismatch';if(!base)return 'no-authority';
  if(replayFailure)return replayFailure;
  if(hidden||resumeAfter!==null)return 'awaiting-new-head';
  if(now>=firstReceivedAt+L.provisionalMs||rawAt(now)>=base.headTick+L.futureTicks)return 'provisional-budget-expired';
  if(base.terminal)return base.authorization?'authoritative-terminal':'terminal-awaiting-commit';
  if(trajectory.blocked)return trajectory.blocked;
  return null;
 }
 function refreshOutbox(now){if(!outbox)return;const why=gate(now);if(why&&why!=='processed-outcome-unknown'&&why!=='input-expired')outbox.suspend();else outbox.resume();}
 function recordWork(work){statistics.frameRecordsAllocated+=work.framesAllocated??0;statistics.stateRecordsAllocated+=work.framesAllocated??0;statistics.frameRecordsReused+=work.framesReused??0;lastWorkSteps=work.steps;statistics.stepCalls+=work.steps;statistics.maxReceiveSteps=Math.max(statistics.maxReceiveSteps,work.steps);statistics.maxFrames=Math.max(statistics.maxFrames,trajectory?.frames.length??0);}
 function receive({room,receivedAt}={}){
  if(closed)return fail('closed');if(epochLost)return fail('epoch-mismatch');if(!time(receivedAt)||receivedAt<lastReceiveAt)return fail('invalid-time');
  let candidate,built;const work={steps:0,limit:L.receiveSteps};
  try{
   candidate=parse(room);if(!candidate.ok){if(candidate.reason==='epoch-mismatch'){epochLost=true;outbox?.clear();reason='epoch-mismatch';}return candidate;}
   const proof=replay(candidate,candidate.headTick,candidate.accepted,work,{capture:false,strict:true});
   if(!same(proof.player,candidate.head))return fail('authority-endpoint-mismatch');
   built=build(candidate,local,work);
  }catch(error){return fail(error.message??'invalid-authority');}
  const oldPose=lastPose,previousRaw=base?rawAt(receivedAt):candidate.headTick,advanced=candidate.headTick>highestHead;
  if(!outbox)outbox=createRunPracticeInputOutbox({scope:{protocol:profile.protocol,ruleVersion:profile.ruleVersion,...(profile.profileId?{profileId:profile.profileId}:{}),roomId,playerKey,clockEpoch,practice:true,entryMinor:'0',players:candidate.game.players.map(p=>({key:p.key,isBot:p.isBot}))},makeRequestId,
   initial:{lastCommandSeq:candidate.processedThroughCommandSeq,acceptedInputNo:candidate.acceptedInputNo,revision:candidate.revision}});
  // A fresher authority is not a new presentation time. In particular, less
  // network delay must not move the camera forward, and a receive callback
  // must not pull an older timestamped RAF up to performance.now(). Keep the
  // same affine clock while its displayed interval remains in the new proof.
  // One immutable predecessor preserves causal sampling at an anchor rollover;
  // inherit it only when the full canonical endpoint is exactly unchanged.
  if(base){
   const index=candidate.anchorTick-base.anchorTick;
   if(index>=0&&same(trajectory.states[index],built.states[0])){
    if(index>0)built.predecessor={previous:trajectory.frames[index-1],endpoint:trajectory.frames[index]};
    else if(trajectory.predecessor)built.predecessor=trajectory.predecessor;
   }
  }
  const coverageTick=lastRaw??previousRaw;
  const historyGap=base&&(coverageTick<candidate.anchorTick
   ||Math.floor(coverageTick)===candidate.anchorTick&&!built.predecessor&&candidate.anchorTick!==base.anchorTick);
  const resumed=base&&!hidden&&resumeAfter!==null&&candidate.headTick>resumeAfter;
  const expired=base&&(receivedAt>=firstReceivedAt+L.provisionalMs||previousRaw>=base.headTick+L.futureTicks);
  clockReset=null;
  if(!base||historyGap||resumed){
   clockTick=candidate.headTick;clockAt=receivedAt;
   if(base)clockReset=freeze({reason:historyGap?'history-gap-resync':'visibility-resync',revision:candidate.revision,fromTick:coverageTick,toTick:clockTick});
  }else if(advanced&&expired){
   // Resume from the phase reached under the old budget; frozen wall time is
   // never instant catch-up. Both authority leases retain their old rules.
   clockTick=previousRaw;clockAt=receivedAt;
   clockReset=freeze({reason:'budget-resume',revision:candidate.revision,fromTick:previousRaw,toTick:previousRaw});
  }
  if(advanced){highestHead=candidate.headTick;firstReceivedAt=receivedAt;}
  base=candidate;trajectory=built;replayFailure=null;mapping=candidate.mapping;lastReceiveAt=receivedAt;statistics.receives++;statistics.rebuilds++;recordWork(work);
  if(!hidden&&resumeAfter!==null&&candidate.headTick>resumeAfter)resumeAfter=null;
  for(const [seq,input]of local)if(input.decision&&seq<=candidate.processedThroughCommandSeq&&(input.decision.outcome==='rejected'||input.executeTick<=candidate.headTick))local.delete(seq);
  if(lastRaw!==null)changed(oldPose,poseAt(historyGap||resumed?clockTick:lastRaw),clockReset?.reason??'authority-revision');
  reason=gate(receivedAt);refreshOutbox(receivedAt);return Object.freeze({ok:true,reason,steps:work.steps});
 }
 function sample(now){
  statistics.samples++;
  if(!time(now))return null;
  const at=Math.max(now,lastSampleAt);lastSampleAt=at;
  let why=gate(at),raw=base?rawAt(at):null;
  if(base&&trajectory){
   if(!hidden&&resumeAfter===null&&!epochLost&&!replayFailure&&why!=='processed-outcome-unknown'&&why!=='input-expired'){
    lastRaw=raw;lastPose=poseAt(raw);
   }
   if(!lastPose){lastRaw=base.headTick;lastPose=poseAt(base.headTick);}
  }
  if(why&&lastPose)lastPose={...lastPose,visualSpeed:0};
  reason=why;refreshOutbox(at);
  return lastSample=Object.freeze({mode:closed?'closed':base?.authorization?'authoritative-terminal':why?'hold':'provisional',reason:why,
   pose:lastPose?Object.freeze({...lastPose}):null,authorityExpired:base?at-firstReceivedAt>=L.authorityMs:true,
   headTick:base?.headTick??null,revision:base?.revision??null,provisionalTick:lastRaw,firstReceivedAt,hardDeadline:firstReceivedAt===null?null:firstReceivedAt+L.provisionalMs,
   correction,clockReset,resultAuthorization:base?.authorization??null});
 }
 function enqueue(type,now){
  if(!time(now)||now<lastSampleAt)return fail('invalid-time');const why=gate(now);if(why)return fail(why);
  if(!types.has(type))return fail('invalid-command');if(local.size>=L.localCommands)return fail('local-history-limit');
  const raw=rawAt(now),executeTick=Math.floor(raw)+1,current=trajectory.states[Math.floor(raw)-base.anchorTick];
  if(executeTick<=base.committedThroughTick)return fail('input-expired');
  if(!current||executeTick>Math.min(END,base.headTick+L.futureTicks))return fail('provisional-budget-expired');
  const p=own(current),error=admit(p,{type,executeTick},executeTick-1,base.game);if(error)return fail(error);
  const queued=outbox.enqueue({type,executeTick});if(!queued.ok)return queued;
  local.set(queued.command.commandSeq,{...queued.command,decision:null});const work={steps:0};
  try{trajectory=build(base,local,work);}catch(error){replayFailure=reason=error.message;outbox.suspend();return fail(reason);}
  statistics.rebuilds++;recordWork(work);return Object.freeze({ok:true,command:queued.command,transportOutcome:'unresolved',localAdmission:'predicted'});
 }
 const transport=Object.freeze({
  beginBatch(now,{maxCommands}={}){if(!time(now))return fail('invalid-time');refreshOutbox(now);return outbox?outbox.beginBatch({baseRevision:base.revision,maxCommands}):fail('no-authority');},
  retry({token,now}={}){if(!time(now))return fail('invalid-time');refreshOutbox(now);return outbox?outbox.retry({token}):fail('no-authority');},
  release(args){return outbox?outbox.release(args):fail('no-authority');},retire(args){return outbox?outbox.retire(args):fail('no-authority');},
  resolve({token,receipt,now}={}){
   if(closed||epochLost)return fail(closed?'closed':'epoch-mismatch');if(!time(now))return fail('invalid-time');if(!outbox)return fail('no-authority');
   const result=outbox.resolve({token,receipt});if(!result.ok)return result;
   if(profile.profileId!==null&&result.newlyAcknowledged.length===0){reason=gate(now);refreshOutbox(now);return result;}
   for(const d of result.newlyAcknowledged){const input=local.get(d.commandSeq);if(input)input.decision=d;}
   const before=lastPose,work={steps:0};
   try{trajectory=build(base,local,work);}catch(error){replayFailure=reason=error.message;outbox.suspend();return fail(reason);}
   statistics.rebuilds++;recordWork(work);if(lastRaw!==null)changed(before,poseAt(lastRaw),'input-receipt');
   reason=gate(now);refreshOutbox(now);return result;
  },
 });
 function suspend(){if(closed)return;hidden=true;resumeAfter=highestHead;outbox?.suspend();reason='awaiting-new-head';}
 function resume(){if(closed)return;hidden=false;resumeAfter=highestHead;outbox?.suspend();reason='awaiting-new-head';}
 function clear(){closed=true;outbox?.clear();base=null;local.clear();trajectory=null;lastPose=null;lastRaw=null;lastSample=null;reason='closed';}
 function state(){return freeze({scope:{roomId,playerKey,clockEpoch},closed,reason,hidden,resumeAfter,headTick:base?.headTick??null,revision:base?.revision??null,
  firstReceivedAt,hardDeadline:firstReceivedAt===null?null:firstReceivedAt+L.provisionalMs,lastWorkSteps,localCommands:[...local.values()].map(i=>({...i})),issues:trajectory?.issues??[],
  outbox:outbox?.state()??null,statistics:{...statistics}});}
 return Object.freeze({scope,profile,receive,enqueue,sample,peek:()=>lastSample,suspend,resume,clear,state,transport,
  stateAtTick(tick){return base&&integer(tick,base.anchorTick,base.anchorTick+(trajectory?.states.length??0)-1)?trajectory.states[tick-base.anchorTick]:null;}});
}
