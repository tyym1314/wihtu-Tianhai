import {LANES} from './level.mjs';
import {RUN_INPUT_FRESH_MS} from './input-readiness.mjs';
import {runRequiresSceneReady} from './start-policy.mjs';

export const RUN_INPUT_RECONCILE_MS=100;
export const RUN_INPUT_CONFIRM_MS=650;
const supported=g=>g?.physicsVersion==='run-60hz-v1.0.0'&&(['pvp-run-v1.0.0','pvp-run-v2.0.0'].includes(g.ruleVersion)||runRequiresSceneReady(g.ruleVersion));
const axisOf=type=>type==='left'||type==='right'?'x':type==='jump'||type==='slide'?'y':null;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n)),mix=(a,b,t)=>a+(b-a)*t;
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const interrupted=p=>!p||p.forfeited||p.finishTick!==null||p.fallUntilTick!==null;
const interruptEvents=new Set(['hit','fall','respawn','finish']);
const visualActionTypes=new Set(['jump','land','slide','run']);
export function readRunVisualAction(action){return action&&visualActionTypes.has(action.type)&&Number.isFinite(action.elapsedMs)&&action.elapsedMs>=0?action:null;}

/** A bounded, local-runner render overlay. It never writes to a game snapshot. */
export function createRunInputPresentation({now=()=>performance.now()}={}){
 let game=null,player=null,scope=null,playerKey=null,authorityUntil=-Infinity,lastTick=-1,lastEventId=0;
 let dead=false,lastBase=null,lastVisual=null,correction=null,correctNext=0,lastReason=null;
 const records=new Map(),seenTokens=new Set();
 const bit=axis=>axis==='x'?1:2;
 const clear=(reason)=>{records.clear();correction=null;correctNext=0;lastReason=reason;};
 const removeAxis=axis=>{records.delete(axis);correctNext&=~bit(axis);if(correction){delete correction[axis];if(!Object.keys(correction).length)correction=null;}};
 const stale=at=>at>=authorityUntil;
 function prune(at){
  if(stale(at)){clear('stale');return;}
  for(const [axis,record] of records)if(record.state==='predicted'&&at>=record.at+RUN_INPUT_CONFIRM_MS){removeAxis(axis);lastReason='unconfirmed-expired';}
 }
 function update(g,key,{roomId,at=now(),inputFreshUntil=-Infinity}={}){
  if(dead||typeof roomId!=='string'||!roomId||typeof key!=='string'||!Number.isFinite(at)||!integer(g?.snapshotTick))return false;
  const nextScope=JSON.stringify([roomId,key,g.ruleVersion,g.startedAt]);
  if(nextScope!==scope){clear('scope');seenTokens.clear();scope=nextScope;lastTick=-1;lastEventId=0;lastBase=null;lastVisual=null;authorityUntil=-Infinity;}
  if(g.snapshotTick<lastTick)return false;
  const prior=player;game=g;playerKey=key;player=g.players?.find(p=>p.key===key);
  // Input admission includes the server's snapshot age. Forward projection's
  // carried phase is a different clock: its 650 ms hold must not erase a legal
  // local jump before the first frame. Duplicates never renew either budget.
  if(g.snapshotTick>lastTick){lastTick=g.snapshotTick;authorityUntil=Number.isFinite(inputFreshUntil)&&inputFreshUntil<=at+RUN_INPUT_FRESH_MS?inputFreshUntil:-Infinity;}
  let interrupt=false;
  for(const event of g.events||[]){if(integer(event.id)&&event.id>lastEventId&&event.playerKey===key&&interruptEvents.has(event.type))interrupt=true;if(integer(event.id))lastEventId=Math.max(lastEventId,event.id);}
  if(!supported(g)||g.status!=='active'||['arming','countdown','finished'].includes(g.phase)||interrupted(player)||prior&&player.hits>prior.hits||interrupt){clear('authority-interruption');return true;}
  for(const [axis,record] of records){
   // A new applied input always takes visual priority. This does not confirm an
   // HTTP request: only its exact receipt can do that in the host controller.
   const watermark=record.inputNo??record.expectedInputNo;
   if(integer(player.appliedInputNo)&&player.appliedInputNo>=watermark){records.delete(axis);correctNext|=bit(axis);}
   else if(record.state==='confirmed'&&g.snapshotTick>=record.acceptedTick){removeAxis(axis);lastReason='inconsistent-authority';}
  }
  prune(at);return true;
 }
 function beginInput(input){
  const at=now(),axis=axisOf(input?.type);prune(at);
  if(dead||!axis||!supported(game)||game.status!=='active'||['arming','countdown','finished'].includes(game.phase)||interrupted(player)||!lastBase||stale(at)||lastBase.controlTick<player.stunUntilTick)return false;
  if(typeof input.token!=='string'||!input.token||input.token.length>512||seenTokens.has(input.token)||seenTokens.size>=4096||typeof input.request_id!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(input.request_id)||!integer(input.seq)||input.seq===0)return false;
  if(input.playerKey!==playerKey||input.ruleVersion!==game.ruleVersion||JSON.stringify([input.roomId,input.playerKey,input.ruleVersion,game.startedAt])!==scope||!integer(player.inputNo)||!integer(player.appliedInputNo))return false;
  if([...records.values()].some(record=>record.state==='predicted'))return false;
  const previous=records.get(axis),baseInputNo=Math.max(player.inputNo,...[...records.values()].map(record=>record.inputNo??0));
  let targetLane=null;
  if(axis==='x'){
   const lane=previous?.state==='confirmed'?previous.targetLane:player.lane;
   if(!integer(lane)||lane>2)return false;
   targetLane=lane+(input.type==='left'?-1:1);if(targetLane<0||targetLane>2)return false;
  }
  seenTokens.add(input.token);
  removeAxis(axis);records.set(axis,{...input,axis,at,state:'predicted',expectedInputNo:baseInputNo+1,baseTick:game.snapshotTick,targetLane,fromX:lastVisual?.x??lastBase.x});
  lastReason=null;return true;
 }
 function acceptInput({token,receipt}={}){
  const at=now();prune(at);const record=[...records.values()].find(record=>record.token===token);
  if(dead||!record||record.state!=='predicted')return false;
  const invalid=()=>{removeAxis(record.axis);lastReason='invalid-receipt';return false;};
  if(!receipt)return invalid();
  for(const key of ['roomId','playerKey','request_id','seq','type','ruleVersion'])if(receipt[key]!==record[key])return invalid();
  if(!integer(receipt.inputNo)||receipt.inputNo!==record.expectedInputNo||!integer(receipt.acceptedTick)||receipt.acceptedTick<=record.baseTick||receipt.acceptedTick-record.baseTick>121)return invalid();
  record.state='confirmed';record.inputNo=receipt.inputNo;record.acceptedTick=receipt.acceptedTick;
  if(player.appliedInputNo>=record.inputNo){records.delete(record.axis);correctNext|=bit(record.axis);}
  else if(game.snapshotTick>=record.acceptedTick){removeAxis(record.axis);lastReason='inconsistent-authority';}
  return true;
 }
 function cancelInput(token,reason='cancelled'){
  if(token===undefined){clear(reason);return;}
  for(const [axis,record] of records)if(record.token===token){
   if(['background','dispose','disconnect','stale','unresolved'].includes(reason))clear(reason);
   else{removeAxis(axis);lastReason=reason;}
   return;
  }
 }
 function sample(base,{at=now()}={}){
  const result={x:base.x,y:base.y,visualAction:null,feedback:null};
  if(!Number.isFinite(at)||!Number.isFinite(base.x)||!Number.isFinite(base.y)||!Number.isFinite(base.tick))return result;
  // RAF can carry an older frame timestamp. Animation uses that timestamp,
  // but it must not keep an expired input alive when the callback runs late.
  // The causal transform is up to one fixed step behind control admission.
  // Only stun expiry uses control time; vertical animation remains causal.
  const controlTick=Number.isFinite(base.controlTick)?base.controlTick:base.tick;
  lastBase={x:base.x,y:base.y,tick:base.tick,controlTick};prune(Math.max(at,now()));
  if(dead||!supported(game)||interrupted(player)||controlTick<player.stunUntilTick){clear('authority-interruption');lastVisual={x:base.x,y:base.y};return result;}
  for(const record of records.values()){
   const elapsedMs=Math.max(0,at-record.at);
   if(record.axis==='x')result.x=mix(record.fromX,LANES[record.targetLane],clamp(elapsedMs/200,0,1));
   else if(record.type==='jump'){
    const phase=clamp(elapsedMs/800,0,1);result.y=4*1.2*phase*(1-phase);
    result.visualAction={type:phase<1?'jump':'land',elapsedMs:phase<1?elapsedMs:elapsedMs-800};
   }else{result.y=0;result.visualAction={type:elapsedMs<600?'slide':'run',elapsedMs};}
   if(!result.feedback||record.at>=result.feedback.startedAt)result.feedback={token:record.token,type:record.type,state:record.state,startedAt:record.at};
  }
  if(correctNext){
   if(lastVisual){correction??={};for(const axis of ['x','y'])if(correctNext&bit(axis))correction[axis]={at,offset:lastVisual[axis]-result[axis]};}correctNext=0;
  }
  if(correction){for(const [axis,offset] of Object.entries(correction)){const weight=1-clamp((at-offset.at)/RUN_INPUT_RECONCILE_MS,0,1);result[axis]+=offset.offset*weight;if(weight===0)delete correction[axis];}if(!Object.keys(correction).length)correction=null;}
  lastVisual={x:result.x,y:result.y};return result;
 }
 return{update,beginInput,acceptInput,cancelInput,sample,
  suspend(reason='background'){clear(reason);lastBase=null;lastVisual=null;},
  dispose(){dead=true;clear('dispose');lastBase=null;lastVisual=null;},
  state(){return{active:records.size,records:[...records.values()].map(({token,type,state,inputNo,expectedInputNo,acceptedTick})=>({token,type,state,inputNo,expectedInputNo,acceptedTick})),reason:lastReason,correcting:!!correction||!!correctNext,disposed:dead};}};
}
