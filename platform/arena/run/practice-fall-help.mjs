import {RUN_PRACTICE_INPUT_PROTOCOL,RUN_PRACTICE_INPUT_RULE_VERSION} from './start-policy.mjs';
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const identity=e=>JSON.stringify([e.playerKey,e.tick,e.type,e.checkpoint]);
// Help observes committed authority only. It owns neither a simulation clock
// nor an input queue, and checking visibility never consumes an event/sample.
export function createRunPracticeFallHelp({roomId,playerKey,clockEpoch}){
 let revision=-1,committed=-1,checkpoint=null,count=0,fingerprint=null;
 const seen=new Set();
 function receive(room){
  const a=room?.run_inputs,g=room?.game,anchor=a?.selfReplay;
  if(room?.id!==roomId||room.me!==playerKey||room.game_id!=='run'||room.practice!==true||room.entry_minor!=='0'
   ||a?.roomId!==roomId||a.playerKey!==playerKey||a.clockEpoch!==clockEpoch||a.protocol!==RUN_PRACTICE_INPUT_PROTOCOL
   ||a.ruleVersion!==RUN_PRACTICE_INPUT_RULE_VERSION||g?.ruleVersion!==a.ruleVersion||g.me!==playerKey
   ||!integer(a.revision)||a.revision<revision||!integer(a.headTick)||a.headTick!==g.snapshotTick
   ||!integer(a.committedThroughTick)||a.committedThroughTick<committed
   ||anchor?.schema!=='run-practice-self-replay-v1'||!integer(anchor.anchorTick)||anchor.anchorTick>a.committedThroughTick
   ||anchor.player?.key!==playerKey||!integer(anchor.player.checkpointU)||anchor.player.checkpointU%9000!==0
   ||!Array.isArray(g.events)||g.events.length>48)return false;
  const falls=g.events.filter(e=>e?.playerKey===playerKey&&e.type==='fall');
  if(falls.some(e=>!integer(e.tick)||e.tick>a.headTick||!integer(e.checkpoint)||e.checkpoint%30!==0))return false;
  const nextFingerprint=JSON.stringify([a.headTick,a.committedThroughTick,anchor.anchorTick,anchor.player.checkpointU,falls.map(identity).sort()]);
  if(a.revision===revision)return fingerprint===nextFingerprint;
  const advanced=anchor.player.checkpointU/300;
  if(checkpoint!==null&&advanced>checkpoint){checkpoint=null;count=0;}
  for(const event of falls.sort((a,b)=>a.tick-b.tick)){
   const key=identity(event);
   if(event.tick>a.committedThroughTick||event.tick<=committed||event.checkpoint<advanced||seen.has(key))continue;
   seen.add(key);count=checkpoint===event.checkpoint?Math.min(2,count+1):1;checkpoint=event.checkpoint;
  }
  // Older committed ticks can never be admitted again, even after eviction.
  while(seen.size>64)seen.delete(seen.values().next().value);
  revision=a.revision;committed=a.committedThroughTick;fingerprint=nextFingerprint;return true;
 }
 function hint({pose,canJump,course}){
  if(!canJump||count<2||!pose||pose.checkpoint!==checkpoint||!Number.isFinite(pose.distance))return null;
  const gap=course?.gaps.find(g=>g.lanes.includes(pose.visualPlayer?.lane)&&g.start>=checkpoint&&g.start<checkpoint+30&&pose.distance<g.end);
  return gap?{checkpoint,gapEnd:gap.end}:null;
 }
 return {receive,hint,state:()=>({revision,committedThroughTick:committed,checkpoint,count,seen:seen.size})};
}
