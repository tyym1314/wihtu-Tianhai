import {randomBytes} from 'node:crypto';

const pending=new WeakMap();
const roomRead=/^\/api\/pvp\/rooms\/[A-Za-z0-9_-]+$/;
const entryReads=new Set(['/api/arena/session','/api/play/thunder/session','/api/play/tiger/session','/api/play/thunder/config','/api/play/tiger/config']);
const entryWrites=new Set(['/v1/launch/exchange','/api/pvp/rooms']);

/** Per-request diagnostics contain no room, player, token or caller-supplied ID. */
export function beginRoomReadTiming(req,res,options={}){
 if(req.method!=='GET'||!roomRead.test(req.url||''))return false;
 return beginTiming(res,options);
}

/** Bounded response-header diagnostics for the observed slow game-entry APIs.
 * No request data is inspected, and the opt-in room log sink is not expanded.
 * A query string, another verb or any other route remains outside this scope.
 */
export function beginGameEntryTiming(req,res,options={}){
 if(!(req.method==='GET'&&entryReads.has(req.url)||req.method==='POST'&&entryWrites.has(req.url)))return false;
 return beginTiming(res,{...options,sink:null});
}

function beginTiming(res,{now=()=>performance.now(),epoch=()=>Date.now(),makeId=()=>randomBytes(16).toString('hex'),sink=null}={}){
 if(pending.has(res))return false;
 try{
  const started=now(),requestId=makeId();
  if(!Number.isFinite(started)||!/^[a-f0-9]{32}$/.test(requestId))return false;
  const state={started,requestId,now,epoch,sink};
  pending.set(res,state);
  // The disabled path creates no listeners or wall-clock samples. A declined
  // entry (expired/full/broken sink) does not retain per-response observers.
  if(sink&&recordPhase(state,'entry',started)&&typeof res.once==='function'){
   let ended=false;
   const complete=phase=>{
    if(ended)return;ended=true;
    res.removeListener('finish',onFinish);res.removeListener('close',onClose);
    pending.delete(res);
    try{recordPhase(state,phase,now(),{status:res.statusCode});}catch{}
   };
   const onFinish=()=>complete('finish'),onClose=()=>complete('close');
   res.once('finish',onFinish);res.once('close',onClose);
  }else state.sink=null;
  return true;
 }catch{return false;}
}

function recordPhase(state,phase,time,extra={}){
 if(!state.sink||!Number.isFinite(time)||time<state.started)return false;
 try{return state.sink.record({phase,request_id:state.requestId,epoch_ms:state.epoch(),mono_ms:time,...extra})===true;}catch{return false;}
}

/** Completes room-read or game-entry timing after JSON serialization,
 * immediately before headers are committed. The historical export name is
 * retained for existing callers.
 * app measures handler-entry through response preparation only. It excludes
 * pre-handler event-loop/socket queueing, proxy time, transfer and client parse.
 * The server-generated ID lets controlled clients correlate proxy diagnostics.
 */
export function finishRoomReadTiming(res){
 const state=pending.get(res);
 if(!state)return false;
 pending.delete(res);
 if(res.headersSent||res.destroyed)return false;
 try{
  const time=state.now(),duration=time-state.started;
  if(!Number.isFinite(duration)||duration<0)return false;
  res.setHeader('X-Oasis-Request-Id',state.requestId);
  res.setHeader('Server-Timing',`app;dur=${duration.toFixed(3)}`);
  recordPhase(state,'headers',time,{app_ms:duration});
  return true;
 }catch{return false;}
}
