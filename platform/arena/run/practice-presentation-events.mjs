const TYPES=new Set(['left','right','jump','slide','item_used','item_pickup','hit','shield_hit','fall','respawn','finish']);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
// Global event serials can change when a delayed input rebuilds the suffix.
// The same physical self event must not sound twice merely because a BOT's
// earlier event changed its serial or a new revision was published.
const identity=e=>JSON.stringify([e.playerKey,e.tick,e.type,e.inputNo??null,e.item??null,e.obstacleId??null,e.checkpoint??null]);
export function createRunPracticePresentationEvents({roomId,playerKey,clockEpoch}){
 let revision=-1,head=-1,committed=-1,pending=new Map(),played=new Map(),playedFinish=null,deferredFinish=null,lastFingerprint=null,suspended=false,closed=false,skipThrough=-1;
 function receive(room){
  const a=room?.run_inputs,g=room?.game;
  if(closed||room?.id!==roomId||room.me!==playerKey||a?.roomId!==roomId||a.playerKey!==playerKey||a.clockEpoch!==clockEpoch
    ||a.protocol!=='run-practice-inputs-v1'||a.ruleVersion!=='pvp-run-v2.3.0'||g?.ruleVersion!==a.ruleVersion
    ||!integer(a.revision)||a.revision<revision||!integer(a.headTick)||a.headTick!==g.snapshotTick
    ||!integer(a.committedThroughTick)||a.committedThroughTick<committed||!Array.isArray(g.events)||g.events.length>48)return false;
  // Validate before changing the cursor. Unknown event kinds belonging to
  // other presentation systems are ignored; malformed self events refuse.
  const self=g.events.filter(e=>e?.playerKey===playerKey&&TYPES.has(e.type));
  if(self.some(e=>!integer(e.tick)||e.tick>a.headTick))return false;
  const fingerprint=JSON.stringify([a.headTick,a.committedThroughTick,self.map(identity).sort()]);
  if(a.revision===revision)return fingerprint===lastFingerprint;
  const next=new Map([...pending].filter(([,e])=>e.tick<=a.committedThroughTick));
  for(const e of self){
   const key=identity(e);
   if(!played.has(key)&&key!==playedFinish&&(e.type==='finish'||e.tick>skipThrough&&a.headTick-e.tick<90))next.set(key,Object.freeze({...e}));
  }
  revision=a.revision;head=a.headTick;committed=a.committedThroughTick;lastFingerprint=fingerprint;
  pending=new Map([...next].filter(([,e])=>e.type==='finish'||head-e.tick<90).slice(-48));
  for(const [key,tick]of played)if(tick<committed-180)played.delete(key);
  // Absolute memory ceiling, independent of a race's duration or revisions.
  while(played.size>256)played.delete(played.keys().next().value);
  for(const [key,e]of pending)if(e.type==='finish'&&e.tick<=committed&&key!==playedFinish)deferredFinish=e;
  if(suspended){skipThrough=Math.max(skipThrough,head);pending.clear();}
  return true;
 }
 function drain(displayTick,{resync=false}={}){
  if(closed||suspended||!Number.isFinite(displayTick))return [];
  const ready=[];
  for(const [key,e]of pending){
   if(e.tick>displayTick||e.type==='finish'&&e.tick>committed)continue;
   pending.delete(key);played.set(key,e.tick);if(e.type==='finish'){playedFinish=key;deferredFinish=null;}
   if(!resync||e.type==='finish'||e.tick>=Math.floor(displayTick)-1)ready.push(e);
  }
  while(played.size>256)played.delete(played.keys().next().value);
  return ready;
 }
 return {receive,drain,suspend(){suspended=true;skipThrough=Math.max(skipThrough,head);pending.clear();},resume(){suspended=false;if(deferredFinish&&identity(deferredFinish)!==playedFinish)pending.set(identity(deferredFinish),deferredFinish);},clear(){closed=true;deferredFinish=null;pending.clear();played.clear();},
  state(){return{revision,headTick:head,committedThroughTick:committed,pending:pending.size,played:played.size,suspended,closed};}};
}
