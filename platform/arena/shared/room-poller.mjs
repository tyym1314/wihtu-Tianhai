/** One request at a time, with cadence measured from its start, not response. */
export function startRoomPolling({read,onRoom,onError,interval,initialDelay=250,timeoutMs=8000,now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout,visibilityTarget=globalThis.document}) {
 let stopped=false,timer,controller,running=false,generation=0,resumeRequested=false,retryNotBefore=0;
 const paused=()=>!!visibilityTarget?.hidden;
 const poll=async()=>{
  if(stopped||paused()||running)return;
  running=true;const requestGeneration=generation,started=now();let failed=false,retryAfterMs=0;
  controller=new AbortController();
  const timeout=setTimer(()=>controller.abort(),timeoutMs);
  try{const room=await read(controller.signal);if(!stopped&&!paused()&&requestGeneration===generation)onRoom(room);}
  catch(error){failed=true;retryAfterMs=Math.max(0,Number(error.retryAfterMs)||0);retryNotBefore=Math.max(retryNotBefore,now()+retryAfterMs);if(!stopped&&!paused()&&requestGeneration===generation)onError(error);}
  finally{
   clearTimer(timeout);controller=null;running=false;
   if(!stopped&&!paused()){const period=interval(),delay=resumeRequested?0:failed?Math.max(period,retryAfterMs):Math.max(0,period-(now()-started));timer=setTimer(poll,Math.max(delay,retryNotBefore-now()));resumeRequested=false;}
  }
 };
 const visibility=()=>{
  clearTimer(timer);
  if(paused()){generation++;controller?.abort();}
  else if(running)resumeRequested=true;
  else timer=setTimer(poll,Math.max(0,retryNotBefore-now()));
 };
 visibilityTarget?.addEventListener('visibilitychange',visibility);
 if(!paused())timer=setTimer(poll,initialDelay);
 return()=>{stopped=true;clearTimer(timer);controller?.abort();visibilityTarget?.removeEventListener('visibilitychange',visibility);};
}

/** Bounded acceleration while a newly readied room enters play. */
export function createRoomPollCadence({game,readRoom,now=()=>performance.now()}) {
 let previousRoom,previousStatus,fundingUntil=-Infinity;
 return()=>{
  const room=readRoom(),id=room?.id,status=room?.status,at=now();
  if(id!==previousRoom||status!==previousStatus){
   fundingUntil=status==='funding'?at+2000:-Infinity;
   previousRoom=id;previousStatus=status;
  }
  if(status==='funding'&&at<fundingUntil)return 100;
  return game==='run'&&status==='active'?150:500;
 };
}
