// Keep the server's observed tick intact. This guard only decides whether the
// client has a recent enough snapshot to send it; it never predicts input ticks.
export const RUN_INPUT_FRESH_MS = 1500;
export function createRunInputGuard(){
 let snapshot=null,sceneReady=false,afterTick=-1;
 return{
  receive(game,serverNow,at){
   const tick=game?.snapshotTick,gameNow=game?.serverNow;
   if(!Number.isSafeInteger(tick)||tick<0||!Number.isFinite(gameNow)||!Number.isFinite(at))return false;
   // Repeated HTTP snapshots do not make an old simulation tick fresh again.
   if(snapshot&&tick<=snapshot.tick)return false;
   snapshot={tick,at,age:Math.max(0,(Number.isFinite(serverNow)?serverNow:gameNow)-gameNow)};
   return true;
  },
  sceneReady(value){
   if(value&&!sceneReady)afterTick=Math.max(afterTick,snapshot?.tick??-1);
   sceneReady=value;
  },
  rejectStale(){afterTick=Math.max(afterTick,snapshot?.tick??-1);},
  current(at){
   const age=snapshot?Math.max(0,at-snapshot.at)+snapshot.age:Infinity;
   // Leave 500 ms of the server's existing 2 s limit for request delivery.
   return{ready:sceneReady&&!!snapshot&&snapshot.tick>afterTick&&age<RUN_INPUT_FRESH_MS,
    sceneReady,waiting:!!snapshot&&snapshot.tick<=afterTick,age,tick:snapshot?.tick??null};
  }
 };
}
