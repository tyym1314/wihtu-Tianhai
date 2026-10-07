const MAX_EVENTS=48,MAX_AGE_TICKS=90;
const TYPES=new Set(['left','right','jump','slide','item_used','item_pickup','hit','shield_hit','fall','respawn','finish']);
const integer=value=>Number.isSafeInteger(value)&&value>=0;

/** Authority supplies events; the rendered tick determines when effects play.
 * This cursor has no requests, clocks, prediction or game-state writes. */
export function createRunPresentationEvents(){
 let scope=null,lastId=0,lastTick=-1,lastVersion=-1,pending=[],suspended=false,skipResumeSnapshot=false,deferredFinish=null;
 function clear(){scope=null;lastId=0;lastTick=-1;lastVersion=-1;pending=[];suspended=false;skipResumeSnapshot=false;deferredFinish=null;}
 function receive(game,key,{roomId,roomVersion=-1}={}){
  if(typeof roomId!=='string'||!roomId||typeof key!=='string'||!key||!integer(game?.snapshotTick)||!Array.isArray(game.events)||!Number.isSafeInteger(roomVersion)||roomVersion< -1)return false;
  const nextScope=JSON.stringify([roomId,key,game.ruleVersion,game.courseId]);
  if(scope!==nextScope){const hidden=suspended;clear();scope=nextScope;suspended=hidden;}
  if(game.snapshotTick<lastTick||roomVersion>=0&&roomVersion<lastVersion)return false;
  const suppress=suspended||skipResumeSnapshot;
  if(skipResumeSnapshot&&!suspended&&game.snapshotTick>lastTick)skipResumeSnapshot=false;
  lastTick=game.snapshotTick;lastVersion=Math.max(lastVersion,roomVersion);
  for(const event of [...game.events].sort((a,b)=>(a?.id??0)-(b?.id??0))){
   if(!event||!integer(event.id)||event.id<=lastId||!integer(event.tick)||event.tick>lastTick)continue;
   lastId=event.id;
   if(event.playerKey!==key||!TYPES.has(event.type)||event.type!=='finish'&&lastTick-event.tick>=MAX_AGE_TICKS)continue;
   const owned=Object.freeze({...event});
   if(suspended){if(event.type==='finish')deferredFinish=owned;}
   else if(!suppress||event.type==='finish')pending.push(owned);
  }
  pending=pending.filter(event=>event.type==='finish'||lastTick-event.tick<MAX_AGE_TICKS).slice(-MAX_EVENTS);
  return true;
 }
 function drain(displayTick,{resync=false}={}){
  if(suspended||!Number.isFinite(displayTick)||displayTick<0)return [];
  const ready=[],future=[];
  for(const event of pending){
   if(event.tick>displayTick){future.push(event);continue;}
   // A reconnect must not play a backlog of old movement/collision sounds.
   // A newly authoritative finish still announces the actual result.
   if(!resync||event.type==='finish'||event.tick>=Math.floor(displayTick)-1)ready.push(event);
  }
  pending=future;return ready;
 }
 return{receive,drain,clear,
  suspend(){deferredFinish=pending.findLast(event=>event.type==='finish')??deferredFinish;pending=[];suspended=true;},
  resume(){if(suspended){suspended=false;skipResumeSnapshot=true;if(deferredFinish){pending.push(deferredFinish);deferredFinish=null;}}}
 };
}
