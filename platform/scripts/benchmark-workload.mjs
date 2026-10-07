/** Public-snapshot-only plans for the isolated 13-game HTTP capacity probe. */
import {ARENA_IDS,LEGACY_IDS,RELEASED_IDS} from '../shared/games.mjs';
import {legalMoves as matchLegalMoves} from '../arena/match/engine.mjs';
import {nearestLegalOffset} from '../arena/carrom/geometry.mjs';
import {gestureToward} from '../arena/darts/geometry.mjs';
import {cueDefault} from '../arena/pool/geometry.mjs';

export const BENCHMARK_ARENA_GAMES=Object.freeze([...ARENA_IDS]);
export const BENCHMARK_PROBABILITY_GAMES=Object.freeze([...LEGACY_IDS]);
export const BENCHMARK_GAMES=Object.freeze([...RELEASED_IDS]);
const capacity=game=>game==='jackaroo'?4:2;

/** Every arena game gets a real human room before seats are distributed again. */
export function planArenaGroups(userCount){
 if(!Number.isSafeInteger(userCount)||userCount<100||userCount%20)throw Error('BENCHMARK_USERS_INVALID');
 const seats=userCount*4/5,plans=[];let remaining=seats,index=0;
 while(remaining>0){const game=BENCHMARK_ARENA_GAMES[index++%BENCHMARK_ARENA_GAMES.length],size=capacity(game);if(size>remaining)continue;plans.push({game,capacity:size,entry_minor:'1000',practice:false});remaining-=size;}
 if(new Set(plans.map(p=>p.game)).size!==BENCHMARK_ARENA_GAMES.length)throw Error('BENCHMARK_ARENA_COVERAGE');
 return plans;
}

/** A legal opportunity derived only from the player's server-issued view. */
export function benchmarkAction(room){
 const g=room?.game,game=room?.game_id,key=room?.me,now=room?.server_now;
 if(room?.status!=='active'||g?.status!=='active'||typeof key!=='string'||!Number.isFinite(now))return null;
 const ownTurn=g.turnKey===key,ready=!(Number.isFinite(g.busyUntil)&&now<g.busyUntil);
 switch(game){
  case 'run':{
   if(!['racing','finish-window'].includes(g.phase))return null;
   const p=g.players?.find(player=>player.key===key),tick=g.snapshotTick;
   return p&&!p.forfeited&&p.finishTick===null&&p.fallUntilTick===null&&p.stunUntilTick<=tick&&p.y===0&&!p.sliding&&p.inputNo===p.appliedInputNo?{type:'jump',observed_tick:tick}:null;
  }
  case 'bowling':{
   const p=g.me;return p&&!p.completed&&!p.forfeited&&!p.busyUntil&&p.shotDeadlineAt>now?{type:'roll',offset:0,angle:0,power:.78,spin:0}:null;
  }
  case 'towerlink':return g.legalActions?.find(action=>action.type==='link')||g.legalActions?.[0]||null;
  case 'match':{
   if(g.forfeited||!Array.isArray(g.board)||g.board.length!==36||now<g.busyUntil)return null;
   const move=matchLegalMoves(g.board)[0];return move?{type:'swap',from:move.from,to:move.to}:null;
  }
  case 'golf':return g.phase==='playing'&&g.me&&!g.me.forfeited&&!g.me.completed&&now>=g.me.busyUntil?{type:'shot',angle:0,power:.62}:null;
  case 'carrom':{
   if(!ownTurn||!ready||g.phase!=='aiming'||g.me?.forfeited)return null;
   const offset=Number.isFinite(g.defaultOffset)?g.defaultOffset:nearestLegalOffset(g.coins,g.me?.seatIndex,g.players?.length);
   return offset===null?null:{type:'shot',offset,angle:0,power:.72};
  }
  case 'darts':return ownTurn&&ready&&now-g.turnStartedAt>=400?{type:'throw',gesture:gestureToward(0,-.62)}:null;
  case 'ludo':return ownTurn&&ready?(g.legalActions?.find(a=>a.type==='roll')||g.legalActions?.[0]||null):null;
  case 'jackaroo':return ready?(g.phase==='exchange'?g.legalActions?.find(a=>a.type==='pass'):ownTurn?g.legalActions?.[0]:null)||null:null;
  case 'domino':{
   if(!ownTurn||!ready)return null;
   const move=g.legalMoves?.[0];return move?{type:'play',tileId:move.tileId,end:move.end}:g.canDraw?{type:'draw'}:g.canPass?{type:'pass'}:null;
  }
  case 'pool':{
   if(!ownTurn||!ready||g.phase!=='aiming'||g.me?.forfeited)return null;
   if(g.ballInHand&&!g.cuePlaced){const point=cueDefault(g.balls);return point?{type:'place',x:point.x,y:point.y}:null;}
   if(g.eightEligible&&g.calledPocket===null)return{type:'call',pocketId:0};
   return{type:'shot',angle:0,power:.72,spinX:0,spinY:0};
  }
  default:return null;
 }
}
