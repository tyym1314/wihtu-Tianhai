import {rollPreparationProof,sameRollPreparation} from '../../arena/bowling/engine.mjs';
import {runEngineTask,registerBowlingPreparationStats} from './engine-pool.mjs';

// Request-scoped server capabilities, never a cache of particular shots. The
// bounded map retains a computation until both its worker and callers finish.
export function createBowlingPreparationManager({run=runEngineTask,maxActive=32}={}){
 if(!Number.isSafeInteger(maxActive)||maxActive<1||maxActive>32)throw new Error('Invalid preparation bound');
 const active=new Map(),tokens=new WeakMap();
 const counters={started:0,shared:0,hits:0,stale:0,failed:0,discarded:0,fallback:0,skipped:0,capacitySkipped:0,conflictSkipped:0,peakActive:0};
 const clean=entry=>{if(entry.settled&&entry.refs===0&&active.get(entry.key)===entry)active.delete(entry.key);};
 function snapshot({room,session,body,digest}){
  if(room?.app_id!==session.app_id||room.game_id!=='bowling'||session.game_id!=='bowling'||room.status!=='active'||room.rule_version!==room.game_state?.ruleVersion||typeof digest!=='string'||!Number.isSafeInteger(body.seq)||typeof body.request_id!=='string'||!Array.isArray(room.players))return null;
  const members=room.players.filter(p=>p?.external_user_id===session.external_user_id),member=members[0];
  if(members.length!==1||member.bot!==false||member.forfeited||!Number.isSafeInteger(member.last_seq)||body.seq!==member.last_seq+1)return null;
  const proof=rollPreparationProof(room.game_state,session.external_user_id,body.action);if(!proof)return null;
  const binding={app:session.app_id,room:room.id,player:session.external_user_id,request:body.request_id,digest,seq:body.seq,previousSeq:member.last_seq};
  return{proof,binding,key:JSON.stringify([binding.app,binding.room,binding.player,binding.seq])};
 }
 function begin(context){
  const captured=snapshot(context);if(!captured){counters.skipped++;return null;}
  let entry=active.get(captured.key);
  if(entry){
   if(!sameRollPreparation(entry.proof,captured.proof)||!sameRollPreparation(entry.binding,captured.binding)){counters.conflictSkipped++;return null;}
   counters.shared++;
  }else{
   if(active.size>=maxActive){counters.capacitySkipped++;return null;}
   entry={...captured,refs:0,settled:false,promise:null};active.set(entry.key,entry);counters.started++;counters.peakActive=Math.max(counters.peakActive,active.size);
   let computation;
   try{computation=run({kind:'prepare-bowling-roll',gameId:'bowling',ruleVersion:entry.proof.ruleVersion,physicsVersion:entry.proof.physicsVersion,standing:entry.proof.standing,action:entry.proof.action});}catch{computation=Promise.reject(new Error('Preparation unavailable'));}
   // Attach rejection immediately, including for replay/invalid requests that
   // leave before the worker returns. The ordinary locked act decides errors.
   entry.promise=Promise.resolve(computation).then(result=>result,()=>{counters.failed++;return null;}).finally(()=>{entry.settled=true;clean(entry);});
  }
  entry.refs++;const token=Object.freeze({});tokens.set(token,{entry,used:false});return token;
 }
 async function act(token,context,now){
  const {room,session,body}=context;
  const job={kind:'act',gameId:room.game_id,ruleVersion:room.rule_version,state:room.game_state,playerKey:session.external_user_id,action:body.action,now};
  const fallback=()=>{counters.fallback++;return run(job);};
  const capability=token&&tokens.get(token);if(!capability||capability.used)return fallback();capability.used=true;
  const current=snapshot(context),entry=capability.entry;
  if(!current||!sameRollPreparation(entry.binding,current.binding)||!sameRollPreparation(entry.proof,current.proof)){counters.stale++;return fallback();}
  const result=await entry.promise;if(!result)return fallback();
  // executeEngineTask clones the *locked current* state before applying. A
  // miss cannot mutate it or bring another player's old snapshot back to life.
  const applied=await run({...job,kind:'act-prepared',prepared:{proof:entry.proof,result}});
  if(!applied){counters.stale++;return fallback();}counters.hits++;return applied;
 }
 function release(token){const capability=token&&tokens.get(token);if(!capability)return;tokens.delete(token);if(!capability.used)counters.discarded++;capability.entry.refs--;clean(capability.entry);}
 const stats=()=>({initialized:true,maxActive,active:active.size,...counters});
 return{begin,act,release,stats};
}
export const bowlingPreparations=createBowlingPreparationManager();
registerBowlingPreparationStats(bowlingPreparations.stats);
