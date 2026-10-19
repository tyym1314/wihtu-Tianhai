import {CASINO_GAMES} from '../shared/casino-games.mjs';
import {roundModelFor} from './casino/rounds.mjs';
import {instantModelFor} from './casino/instant.mjs';
import {arcadeModelFor} from './casino/arcade.mjs';
import {RTP_TIERS} from './casino/rtp.mjs';
import {getProfile} from './math/index.ts';

const modelFor=(game,tier)=>game.family==='arcade'?arcadeModelFor(game.id,tier):game.kind==='instant'?instantModelFor(game.id,tier):roundModelFor(game.id,tier);
const pct=x=>Math.round(x*10000)/100;

/** Per game: the default model's target and the effective target for each App tier (96–99). */
export function rtpTiers(){
 const games=Object.values(CASINO_GAMES).map(g=>{
  const base=modelFor(g,null),tiers=Object.fromEntries(RTP_TIERS.map(t=>[t,pct(modelFor(g,t).targetRtp)]));
  return {game_id:g.id,name:g.name,family:g.family,default:pct(base.targetRtp),tiers,adjustable:RTP_TIERS.some(t=>modelFor(g,t)!==base)};
 });
 for(const id of ['thunder','tiger'])games.unshift({game_id:id,name:id==='thunder'?'Thunder Throne':'Golden Tiger',family:'legacy',default:99,tiers:Object.fromEntries(RTP_TIERS.map(t=>[t,pct(getProfile(id,t).targetRtp)])),adjustable:true});
 return {tiers:RTP_TIERS,games};
}
