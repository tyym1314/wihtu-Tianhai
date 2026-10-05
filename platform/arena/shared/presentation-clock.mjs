/** Presentation only. The server still owns turns, physics, deadlines and results. */
export function createPresentationClock({localNow=()=>performance.now(),maxExtrapolation=1500,correctionRate=.1}={}){
 let scope,ready=false,value=0,lastLocal=localNow(),sample=0,sampleLocal=lastLocal,knownUntil=0,needsResume=false;
 const suspended=new Set();
 function now(){
  const local=localNow(),dt=Math.max(0,local-lastLocal);lastLocal=local;
  if(!ready||suspended.size||needsResume)return value;
  const target=sample+Math.max(0,local-sampleLocal),ordinary=value+dt;
  // A late response must not rewind a shot or replay impact sounds. Slew a
  // small timing error rather than snapping to each response's arrival time.
  const correction=Math.max(-dt*correctionRate,Math.min(dt*correctionRate,target-ordinary));
  value=Math.max(value,Math.min(ordinary+correction,Math.max(sample+maxExtrapolation,knownUntil)));
  return value;
 }
 function sync(serverNow,{key='default',through=serverNow}={}){
  if(!Number.isFinite(serverNow))return false;
  const local=localNow();now();
  if(!ready||key!==scope){
   scope=key;ready=true;sample=value=serverNow;sampleLocal=lastLocal=local;knownUntil=Number.isFinite(through)?through:serverNow;needsResume=false;return true;
  }
  // React control changes can submit the same snapshot many times. Neither
  // those nor out-of-order responses are new clock observations.
  if(serverNow<=sample)return false;
  const wasStale=local-sampleLocal>maxExtrapolation;
  sample=serverNow;sampleLocal=local;knownUntil=Number.isFinite(through)?through:serverNow;
  if(!suspended.size&&(needsResume||wasStale))value=Math.max(value,serverNow);
  if(!suspended.size)needsResume=false;
  return true;
 }
 function suspend(reason,paused){
  now();const wasPaused=suspended.size>0;
  if(paused)suspended.add(reason);else suspended.delete(reason);
  if(wasPaused&&!suspended.size)needsResume=true;
 }
 return{now,sync,suspend};
}

const endOf=(p,tail)=>Number.isFinite(p?.shotStartedAt)&&Number.isFinite(p?.trajectory?.at(-1)?.t)?p.shotStartedAt+p.trajectory.at(-1).t+tail:0;

/** Full server-authored trajectories are known motion, not extrapolation. */
export function syncGamePresentationClock(clock,game,serverNow,roomId='scene'){
 if(!game)return;
 const tail=game.gameId==='bowling'?3400:game.gameId==='golf'?2600:1000;
 const actors=[game,...(game.players||[]),...(game.me?[game.me]:[])];
 const through=Math.max(0,...actors.map(p=>Math.max(endOf(p,tail),Number.isFinite(p.lastEvent?.at)?p.lastEvent.at+tail:0)));
 // Deadlines/hole start are fixed within a match/hole and shift together with
 // shot starts on a server-authoritative pause/recovery. That is a new timeline.
 const epoch=game.matchDeadlineAt??game.deadlineAt??game.holeStartedAt??0;
 const roster=(game.players||[]).map(p=>p.key).sort().join('|');
 clock.suspend('game',game.phase==='fault'||game.phase==='paused');
 clock.sync(serverNow??game.serverNow,{key:`${game.gameId}:${roomId}:${roster}:${epoch}`,through});
}

export function bindPresentationClock(clock,doc=document,win=window){
 const visibility=()=>clock.suspend('hidden',doc.hidden),blur=()=>clock.suspend('blur',true),focus=()=>clock.suspend('blur',false);
 visibility();doc.addEventListener('visibilitychange',visibility);win.addEventListener('blur',blur);win.addEventListener('focus',focus);
 return()=>{doc.removeEventListener('visibilitychange',visibility);win.removeEventListener('blur',blur);win.removeEventListener('focus',focus);clock.suspend('hidden',false);clock.suspend('blur',false);};
}
