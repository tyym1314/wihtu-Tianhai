import {RUN_PRACTICE_OUTBOX_LIMITS as OUTBOX_LIMITS} from './practice-input-outbox.mjs';

export const RUN_PRACTICE_TRANSPORT_LIMITS=Object.freeze({inFlight:2,timeoutMs:12000,retryBaseMs:250,retryMaxMs:4000,attempts:OUTBOX_LIMITS.attemptsPerBatch,rebaseLimit:8});
const L=RUN_PRACTICE_TRANSPORT_LIMITS,physical=new Set(),waitingForSlot=new Set();
const defaultNow=()=>performance.now();
const abortReason=kind=>new DOMException(`OASIS_RUN_PRACTICE_${kind}`,kind==='TIMEOUT'?'TimeoutError':'AbortError');
const fail=reason=>Object.freeze({ok:false,reason});
const revisionErrors=new Set(['BASE_REVISION_EXPIRED','UNKNOWN_BASE_REVISION']);

/** Owns only POST transport, never the controller's authority clock. The caller
 * owns controller.receive/suspend/resume/clear and calls pump after enqueue or
 * an accepted GET. send receives the exact immutable outbox handle and returns
 * the server's bare personal room (top-level request_id/run_inputs/id/game).
 * Only a validated POST receipt permits onRoom; GET is not an ACK operation.
 *
 * Physical slots survive abort/close until send actually settles, including
 * across replacement transport instances. A send that ignores abort can hold a
 * slot indefinitely; it can never cause an unbounded replacement-request pile.
 */
export function createRunPracticeTransport({controller,send,onRoom,onError,now=defaultNow,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 if(!controller?.transport||!['beginBatch','retry','resolve','release','retire'].every(k=>typeof controller.transport[k]==='function')
  ||typeof controller.state!=='function'||typeof send!=='function'||typeof onRoom!=='function'||typeof onError!=='function'
  ||typeof now!=='function'||typeof setTimer!=='function'||typeof clearTimer!=='function')throw new TypeError('INVALID_PRACTICE_TRANSPORT');
 const entries=new Map(),ownedPhysical=new Set();
 let closed=false,suspended=false,generation=0,wake=null,wakeAt=null,pumping=false,blocked=null,notBefore=0,waitRevision=null,rebases=0,lastThrough=0,batchCommands=OUTBOX_LIMITS.batchCommands;
 const counters={sends:0,retries:0,acknowledgements:0,failures:0,rebases:0,batchReductions:0,discarded:0,maxInFlight:0};
 const current=()=>controller.state();
 const activeCount=()=>ownedPhysical.size;
 function cancelWake(){if(wake!==null)clearTimer(wake);wake=null;wakeAt=null;waitingForSlot.delete(pump);}
 function schedule(at){
  if(closed||suspended||blocked||!Number.isFinite(at))return;
  if(wake!==null&&wakeAt<=at)return;
  if(wake!==null)clearTimer(wake);
  wakeAt=at;wake=setTimer(()=>{wake=null;wakeAt=null;pump();},Math.max(0,Math.min(0x7fffffff,at-now())));
 }
 function emit(error,entry,code=error?.code){
  const value=new Error(error?.message||code||'Practice input transport failed');
  Object.assign(value,{code:code||'RUN_PRACTICE_NETWORK_ERROR',...(Number.isFinite(error?.status)?{status:error.status}:{}),
   ...(Number.isFinite(error?.retryAfterMs)?{retryAfterMs:error.retryAfterMs}:{}),
   transport:Object.freeze({attempt:entry?.attempts??0,limit:L.attempts,stopped:!!blocked})});
  // Observer exceptions must not trigger another POST or leak a send slot.
  try{onError(value);}catch{}
 }
 function release(entry){
  if(entry.status!=='in-flight')return;
  controller.transport.release({token:entry.handle.token});entry.status='waiting';
 }
 function retire(entry){release(entry);controller.transport.retire({token:entry.handle.token});entry.status='retired';entries.delete(entry.handle.token);}
 function stop(entry,code,error){blocked={entry,code};if(entry)entry.status='halted';cancelWake();emit(error,entry,code);}
 function pendingSet(snapshot){return new Set(snapshot.outbox?.pendingCommands.map(c=>c.commandSeq)??[]);}
 function needed(entry,pending){return entry.handle.payload.commands.some(c=>pending.has(c.commandSeq));}
 function prune(snapshot){
  const through=snapshot.outbox?.processedThroughCommandSeq??0;
  if(through>lastThrough){lastThrough=through;rebases=0;}
  const pending=pendingSet(snapshot);
  for(const entry of entries.values())if(!entry.physical&&!needed(entry,pending)){
   if(blocked?.entry===entry)blocked=null;
   retire(entry);
  }
  return pending;
 }
 function failed(entry,error){
  release(entry);counters.failures++;
  const at=now(),snapshot=current(),status=Number(error?.status),code=error?.code;
  const rawRetry=error?.retryAfterMs;
  if(rawRetry!==undefined&&(!Number.isFinite(rawRetry)||rawRetry<0))return stop(entry,'INVALID_RETRY_AFTER',error);
  if(rawRetry>0)notBefore=Math.max(notBefore,at+rawRetry);
  if(status===422&&code==='WORK_BUDGET_EXCEEDED'){
   // This exact rejection has no durable decisions. Retire its capability and
   // shrink the next prefix, preserving every original command/tick/sequence.
   // The scope's ceiling only decreases (8 -> 4 -> 2 -> 1); an old overlapping
   // failure cannot increase it or reset another token's network attempt cap.
   if(entry.attempts>=L.attempts)return stop(entry,'RETRY_LIMIT',error);
   if(entry.handle.payload.commands.length===1)return stop(entry,code,error);
   const smaller=Math.max(1,Math.floor(Math.min(batchCommands,entry.handle.payload.commands.length)/2));
   if(smaller<batchCommands){batchCommands=smaller;counters.batchReductions++;}
   retire(entry);emit(error,entry);return;
  }
  if(revisionErrors.has(code)&&status===409){
   retire(entry);waitRevision=Math.max(waitRevision??-1,snapshot.revision??-1,entry.handle.payload.baseRevision);
   counters.rebases++;
   if(++rebases>=L.rebaseLimit)return stop(null,'REBASE_LIMIT',error);
   emit(error,entry);return;
  }
  const retryable=status===429||status>=500&&status<=599||(!error?.status&&typeof code!=='string');
  // Another exact overlapping POST receipt may already have decided this whole
  // batch. No repeat is needed, but authentication/rate-limit errors stay visible.
  if(!needed(entry,pendingSet(snapshot))&&!([401,403,429].includes(status)||rawRetry>0))return retire(entry);
  if(!retryable)return stop(entry,code||'RUN_PRACTICE_REQUEST_REJECTED',error);
  const delay=Math.min(L.retryMaxMs,L.retryBaseMs*2**(entry.attempts-1));
  entry.due=Math.max(at+delay,notBefore);notBefore=Math.max(notBefore,entry.due);
  if(entry.attempts>=L.attempts)return stop(entry,'RETRY_LIMIT',error);
  emit(error,entry);
 }
 function dispatch(handle,entry=null){
  if(!entry){entry={handle,status:'in-flight',attempts:1,due:0,physical:false,abort:null,timeout:null,generation};entries.set(handle.token,entry);}
  else{entry.status='in-flight';entry.attempts++;entry.generation=generation;counters.retries++;}
  entry.physical=true;entry.abort=new AbortController();physical.add(entry);ownedPhysical.add(entry);counters.sends++;counters.maxInFlight=Math.max(counters.maxInFlight,activeCount());
  entry.timeout=setTimer(()=>entry.abort.abort(abortReason('TIMEOUT')),L.timeoutMs);
  void execute(entry);
 }
 async function execute(entry){
  try{
   // Defer user code until the bounded pump has returned; a synchronous throw
   // cannot re-enter it to bypass a just-recorded revision/backoff gate.
   await Promise.resolve();
   if(closed||suspended||entry.generation!==generation)return;
   const response=await send(entry.handle,{signal:entry.abort.signal});
   if(closed||suspended||entry.generation!==generation){counters.discarded++;return;}
   if(entry.abort.signal.aborted)throw entry.abort.signal.reason;
   const resolved=controller.transport.resolve({token:entry.handle.token,receipt:response,now:now()});
   if(!resolved.ok){release(entry);stop(entry,resolved.reason,new Error('Practice input receipt was not validated'));return;}
   entry.status='resolved';entries.delete(entry.handle.token);counters.acknowledgements++;
   try{onRoom(response);}catch(error){emit(error,entry,'RUN_PRACTICE_ROOM_CALLBACK_FAILED');}
  }catch(error){
   if(!closed&&!suspended&&entry.generation===generation)failed(entry,error);
  }finally{
   if(entry.timeout!==null)clearTimer(entry.timeout);entry.timeout=null;entry.physical=false;physical.delete(entry);ownedPhysical.delete(entry);
   if(entry.status==='in-flight')release(entry);
   if(closed)retire(entry);
   else pump();
   for(const notify of [...waitingForSlot])notify();
  }
 }
 function pump(){
  if(pumping)return;
  cancelWake();if(closed||suspended)return;
  pumping=true;
  try{
   const at=now();if(!Number.isFinite(at)||at<0){stop(null,'INVALID_TRANSPORT_TIME');return;}
   let snapshot=current();if(snapshot.closed){close();return;}
   let pending=prune(snapshot);if(blocked)return;
   if(waitRevision!==null){if(!(snapshot.revision>waitRevision))return;waitRevision=null;}
   if(!pending.size)return;
   if(at<notBefore){schedule(notBefore);return;}
   // At most two dispatches in one pump, even for synchronous send failures.
   for(let dispatches=0;dispatches<L.inFlight;dispatches++){
    if(physical.size>=L.inFlight){waitingForSlot.add(pump);return;}
    snapshot=current();pending=prune(snapshot);if(!pending.size||blocked)return;
    const retryEntry=[...entries.values()].find(e=>!e.physical&&e.status==='waiting'&&needed(e,pending));
    if(retryEntry){
     if(retryEntry.due>at){schedule(retryEntry.due);return;}
     const handle=controller.transport.retry({token:retryEntry.handle.token,now:at});
     if(!handle.ok){if(handle.reason==='RETRY_LIMIT')stop(retryEntry,'RETRY_LIMIT');return;}
     dispatch(handle,retryEntry);continue;
    }
    const prefix=(snapshot.outbox?.pendingCommands??[]).slice(0,batchCommands);
    // Prefixes can overlap, but each fresh batch must contain a command not
    // already owned by an active/unresolved handle. A GET cannot clear this.
    const covered=new Set([...entries.values()].flatMap(e=>e.handle.payload.commands.map(c=>c.commandSeq)));
    if(!prefix.some(c=>!covered.has(c.commandSeq)))return;
    const handle=controller.transport.beginBatch(at,{maxCommands:batchCommands});
    if(!handle.ok)return;
    dispatch(handle);
   }
  }finally{pumping=false;}
 }
 function suspend(){
  if(closed||suspended)return;suspended=true;generation++;cancelWake();
  for(const entry of entries.values())if(entry.physical){if(entry.timeout!==null)clearTimer(entry.timeout);entry.timeout=null;entry.abort.abort(abortReason('BACKGROUND'));}
 }
 function resume(){if(closed||!suspended)return;suspended=false;pump();}
 function close(){
  if(closed)return;closed=true;suspended=true;generation++;cancelWake();
  for(const entry of [...entries.values()]){if(entry.timeout!==null)clearTimer(entry.timeout);entry.timeout=null;entry.abort?.abort(abortReason('CLOSED'));retire(entry);}
 }
 function retry(){
  if(closed)return fail('CLOSED');if(suspended)return fail('SUSPENDED');
  if(!blocked){pump();return Object.freeze({ok:true});}
  const entry=blocked.entry;
  if(!entry||entry.attempts>=L.attempts)return fail(blocked.code);
  entry.status='waiting';entry.due=Math.max(now(),notBefore);blocked=null;pump();return Object.freeze({ok:true});
 }
 function state(){return Object.freeze({closed,suspended,inFlight:activeCount(),retained:entries.size,blocked:blocked?.code??null,waitRevision,notBefore,nextWakeAt:wakeAt,batchCommands,...counters});}
 return Object.freeze({pump,suspend,resume,close,retry,state});
}
