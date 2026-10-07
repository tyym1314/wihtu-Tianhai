import {runRequiresSceneReady} from '../arena/run/start-policy.mjs';

const fields=['roomId','playerKey','request_id','seq','type','inputNo','acceptedTick','ruleVersion'];
const inputs=new Set(['left','right','jump','slide','item']);
const canonical=type=>type==='boost'||type==='shield'?'item':type;
const identifier=(value,min,max)=>typeof value==='string'&&new RegExp(`^[A-Za-z0-9_-]{${min},${max}}$`).test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const supported=version=>version==='pvp-run-v1.0.0'||version==='pvp-run-v2.0.0'||runRequiresSceneReady(version);
function expectedValid(value){return value&&identifier(value.roomId,8,64)&&identifier(value.playerKey,1,128)
 &&identifier(value.request_id,8,128)&&positive(value.seq)&&inputs.has(canonical(value.type))&&supported(value.ruleVersion);}
function matches(receipt,expected){return receipt&&typeof receipt==='object'&&!Array.isArray(receipt)
 &&Object.keys(receipt).length===fields.length&&fields.every(key=>Object.hasOwn(receipt,key))
 &&expectedValid(expected)&&['roomId','playerKey','request_id','seq','ruleVersion'].every(key=>receipt[key]===expected[key])
 &&receipt.type===canonical(expected.type)&&positive(receipt.inputNo)&&positive(receipt.acceptedTick);}

/** Pure projection of the engine's accepted event. Never advances or mutates state. */
export function makeRunActionReceipt({event,...expected}){
 const receipt={roomId:expected.roomId,playerKey:expected.playerKey,request_id:expected.request_id,seq:expected.seq,
  type:event?.input,inputNo:event?.inputNo,acceptedTick:event?.acceptedTick,ruleVersion:expected.ruleVersion};
 if(!matches(receipt,expected)||event?.type!=='input_accepted'||event.playerKey!==expected.playerKey){
  const error=new Error('RUN_ACTION_RECEIPT_INVALID');error.code='RUN_ACTION_RECEIPT_INVALID';error.status=503;throw error;
 }
 return receipt;
}

/**
 * Read only the ORIGINAL successful POST room, with the original intent's scope.
 * Missing historical receipts and invalid receipts are a presentation fallback,
 * never an action rejection or permission to resend. The caller separately owns
 * room/session lifetime, current snapshot freshness and per-input replay guards.
 */
export function readRunActionReceipt(rawRoom,expected){
 const receipt=rawRoom?.action_receipt;
 if(!matches(receipt,expected)||rawRoom.id!==expected.roomId||rawRoom.me!==expected.playerKey
  ||rawRoom.game_id!=='run'||rawRoom.me_last_seq!==expected.seq||rawRoom.status!=='active')return null;
 const game=rawRoom.game;
 if(!game||game.gameId!=='run'||game.me!==expected.playerKey||game.ruleVersion!==expected.ruleVersion
  ||game.status!=='active'||!Number.isSafeInteger(game.snapshotTick)||game.snapshotTick<0
  ||receipt.acceptedTick!==game.snapshotTick+1||!Array.isArray(game.players))return null;
 const mine=game.players.filter(player=>player?.key===expected.playerKey);
 if(mine.length!==1||mine[0].inputNo!==receipt.inputNo||!Number.isSafeInteger(mine[0].appliedInputNo)
  ||mine[0].appliedInputNo<0||mine[0].appliedInputNo>=receipt.inputNo||mine[0].forfeited||mine[0].finishTick!==null)return null;
 return Object.fromEntries(fields.map(key=>[key,receipt[key]]));
}
