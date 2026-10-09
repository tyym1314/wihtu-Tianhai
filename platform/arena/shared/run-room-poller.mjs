// A slow Run GET may occupy one spare slot, but never block an otherwise healthy
// primary chain. Slots survive disposal until the physical read actually settles:
// abort-ignoring reads cannot accumulate across authorization/room changes.
const physicalReads=new Set();
const defaultNow=()=>performance.now(),retryStates=new WeakMap(),MAX_RETRY_SCOPES=128;
const reason=kind=>new DOMException(`OASIS_ROOM_POLL_${kind.toUpperCase()}`,kind==='timeout'?'TimeoutError':'AbortError');
const validVersion=value=>Number.isSafeInteger(value)&&value>=0;
function budget(now,scope){
 if(typeof scope!=='string'||!scope||scope.length>1024)throw new TypeError('Invalid Run rate scope');
 let state=retryStates.get(now);if(!state){state={scopes:new Map(),overflowUntil:0};retryStates.set(now,state);}
 const prune=()=>{const at=now();for(const [key,until] of state.scopes)if(until<=at)state.scopes.delete(key);if(state.overflowUntil<=at)state.overflowUntil=0;};
 return {
  deadline(){prune();return Math.max(state.scopes.get(scope)||0,state.overflowUntil);},
  remember(until){prune();if(state.scopes.has(scope)||state.scopes.size<MAX_RETRY_SCOPES)state.scopes.set(scope,Math.max(state.scopes.get(scope)||0,until));else state.overflowUntil=Math.max(state.overflowUntil,until);}
 };
}
const retryDelay=error=>{const value=Number(error?.retryAfterMs);return Number.isFinite(value)?Math.max(0,value):0;};

// Recovery reads share the same slots and quota; they never create a hedge.
// Check identity again after queueing, before read() can capture a new token.
export async function readRunRoomOnce({read,rateScope,signal,isCurrent=()=>true,timeoutMs=12000,now=defaultNow,setTimer=setTimeout,clearTimer=clearTimeout,visibilityTarget=globalThis.document}){
 if(typeof read!=='function'||typeof isCurrent!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new TypeError('Invalid Run recovery read');
 const quota=budget(now,rateScope),controller=new AbortController();
 const changed=()=>Object.assign(new Error('Run read identity changed'),{code:'SESSION_CHANGED'});
 const guard=()=>{controller.signal.throwIfAborted();if(!isCurrent())throw changed();};
 const abort=()=>controller.abort(signal.reason??reason('stopped'));
 const visibility=()=>{if(visibilityTarget?.hidden)controller.abort(reason('background'));};
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 visibilityTarget?.addEventListener('visibilitychange',visibility);
 const wait=delay=>new Promise((resolve,reject)=>{
  const cancelled=()=>{clearTimer(timer);reject(controller.signal.reason);};
  const timer=setTimer(()=>{controller.signal.removeEventListener('abort',cancelled);resolve();},delay);
  controller.signal.addEventListener('abort',cancelled,{once:true});
 });
 try{
  while(true){guard();const delay=Math.max(0,quota.deadline()-now(),physicalReads.size>=2||visibilityTarget?.hidden?150:0);if(!delay)break;await wait(delay);}
  guard();const request={controller};physicalReads.add(request);quota.remember(now()+150);
  const timeout=setTimer(()=>controller.abort(reason('timeout')),timeoutMs);
  try{const result=await read(controller.signal);guard();return result;}
  catch(error){if(isCurrent()&&(!controller.signal.aborted||controller.signal.reason?.name==='TimeoutError'))quota.remember(now()+Math.max(150,retryDelay(error)));throw error;}
  finally{clearTimer(timeout);physicalReads.delete(request);}
 }finally{signal?.removeEventListener('abort',abort);visibilityTarget?.removeEventListener('visibilitychange',visibility);}
}

export function startRunRoomPolling({read,onRoom,onError,roomId,playerKey,gameId='run',readVersion=()=>-1,readRoom=()=>null,
 rateScope=JSON.stringify([roomId,playerKey]),interval=()=>150,initialDelay=250,hedgeAfterMs=350,timeoutMs=8000,now=defaultNow,
 setTimer=setTimeout,clearTimer=clearTimeout,visibilityTarget=globalThis.document}){
 if(typeof read!=='function'||typeof onRoom!=='function'||typeof onError!=='function'||typeof roomId!=='string'||!roomId||typeof playerKey!=='string'||!playerKey)throw new TypeError('Invalid Run polling scope');
 if(!['run','towerlink'].includes(gameId))throw new TypeError('Invalid motion polling game');
 if(!Number.isFinite(initialDelay)||initialDelay<0||!Number.isFinite(hedgeAfterMs)||hedgeAfterMs<150||!Number.isFinite(timeoutMs)||timeoutMs<=hedgeAfterMs)throw new TypeError('Invalid Run polling timing');
 // Never evict an unexpired quota for identity churn: retain at most 128 scopes
 // plus one conservative overflow deadline, scoped to this monotonic clock.
 const quota=budget(now,rateScope);
 let stopped=false,timer=null,generation=0,sequence=0,primary=null,lastSent=-Infinity,nextDue=now()+initialDelay,retryUntil=0,deliveredVersion=-1,deliveredSequence=0,deliveredServerNow=-Infinity,lastSuccess=0;
 const owned=new Set(),paused=()=>!!visibilityTarget?.hidden;
 const period=()=>{const value=interval();return Number.isFinite(value)?Math.max(150,value):150;};
 const current=request=>!stopped&&!paused()&&request.generation===generation;
 function schedule(){
  clearTimer(timer);timer=null;if(stopped||paused())return;
  const at=now();let due;
  if(physicalReads.size>=2)due=at+150;
  else if(primary){
   if(primary.hedged||owned.size!==1)due=at+150;
   else due=primary.started+hedgeAfterMs;
  }else due=nextDue;
  timer=setTimer(dispatch,Math.max(0,Math.max(due,lastSent+150,retryUntil,quota.deadline())-at));
 }
 function dispatch(){
  timer=null;if(stopped||paused())return;
  const at=now();
  if(physicalReads.size>=2||at<lastSent+150||at<Math.max(retryUntil,quota.deadline())||primary&&(primary.hedged||owned.size!==1||at<primary.started+hedgeAfterMs)){schedule();return;}
  if(primary)primary.hedged=true;
  const request={sequence:++sequence,generation,started:at,controller:new AbortController(),hedged:false,timeout:null};
  primary=request;owned.add(request);physicalReads.add(request);lastSent=at;nextDue=at+period();quota.remember(at+150);
  request.timeout=setTimer(()=>request.controller.abort(reason('timeout')),timeoutMs);
  void execute(request);schedule();
 }
 async function execute(request){
  try{
   const raw=await read(request.controller.signal);
   if(!current(request))return;
   request.controller.signal.throwIfAborted();
   const room=raw?.room??raw;
   if(room?.id!==roomId||room.me!==playerKey||room.game_id!==gameId||!validVersion(room.version))throw Object.assign(new Error('Motion polling response scope is invalid'),{code:gameId==='run'?'RUN_POLL_SCOPE_MISMATCH':'TOWER_POLL_SCOPE_MISMATCH'});
   lastSuccess=Math.max(lastSuccess,request.sequence);
   const live=readRoom(),liveVersion=readVersion(),watermark=Math.max(deliveredVersion,validVersion(liveVersion)?liveVersion:-1,live?.id===roomId&&live.me===playerKey&&validVersion(live.version)?live.version:-1);
   if(room.version<watermark)return;
   if(room.version===watermark){
    // Presence is not versioned. Allow fresh equal-version reads through the
    // caller's exact presence comparison, without an old hedge undoing them.
    const stamp=room.server_now,liveStamp=live?.id===roomId&&live.me===playerKey&&live.version===room.version?live.server_now:-Infinity;
    if(deliveredVersion===room.version&&request.sequence<=deliveredSequence||!Number.isFinite(stamp)||stamp<0||Number.isFinite(liveStamp)&&stamp<liveStamp||deliveredVersion===room.version&&stamp<deliveredServerNow)return;
   }
   deliveredVersion=room.version;deliveredSequence=request.sequence;deliveredServerNow=Number.isFinite(room.server_now)?room.server_now:-Infinity;onRoom(raw);
  }catch(error){
   if(current(request)){
    const retryAfterMs=retryDelay(error);
    const mandatory=[401,403,429].includes(error?.status)||retryAfterMs>0;
    // An obsolete ordinary failure says nothing about a newer successful read.
    // Authorization/rate-limit failures always retain their control semantics.
    if(mandatory||request.sequence>=lastSuccess){
     retryUntil=Math.max(retryUntil,now()+Math.max(period(),retryAfterMs));quota.remember(retryUntil);onError(error);
    }
   }
  }finally{
   clearTimer(request.timeout);owned.delete(request);physicalReads.delete(request);
   if(primary===request)primary=null;schedule();
  }
 }
 function visibility(){
  clearTimer(timer);timer=null;
  if(paused()){generation++;primary=null;for(const request of owned)request.controller.abort(reason('background'));}
  else{nextDue=now();schedule();}
 }
 visibilityTarget?.addEventListener('visibilitychange',visibility);schedule();
 return()=>{if(stopped)return;stopped=true;generation++;clearTimer(timer);timer=null;for(const request of owned)request.controller.abort(reason('stopped'));visibilityTarget?.removeEventListener('visibilitychange',visibility);};
}
