/**
 * App-level return-rate tiers (96/97/98/99 %) for the casino games.
 * Each tier is a separate, pinned math model (own version + hash); the definition in
 * shared/casino-games.mjs stays the default model (used when an App has no tier).
 *
 * - crash / arcade: the configured rtp is the target.
 * - slots: pays scale linearly with payScale (each win is floored), so payScale × target / base.
 * - wheel with specials: the special (multi-winner) probability is the free parameter,
 *   R = (1 + k·Σ p_s(|group_s|−1)) / Σ 1/m_i, solved for k. Displayed multipliers never change.
 * - wheel without specials, fixed draws (roulette, SicBo) and three-hand cards: the return rate is
 *   fixed by the printed multipliers / physical odds, so these keep their default model.
 */
export const RTP_TIERS=Object.freeze(['96','97','98','99']);

const round4=x=>Math.round(x*1e4)/1e4;
/**
 * Return added by the mini-reel bonus at its defined weights (per unit of weight scale), measured over 2M draws
 * (.local/bonus-lift.mjs) at the defined bonus share, and the share of stakes fed into a jackpot pool and paid back.
 */
export const BONUS_LIFT=Object.freeze({fruitparty:{lift:0.02447,share:0.022,jackpot:0.02},footballleague:{lift:0.01651,share:0.0047},glorycup:{lift:0.01566,share:0.0047}});
const wheelBase=g=>{const o=g.options.filter(x=>!x.covers);return 1/o.reduce((a,x)=>a+1/x.multiplier,0);};
/** Long-run return of a game definition with a mini-reel bonus (draw + bonus + jackpot pool). */
export const bonusRtp=g=>BONUS_LIFT[g.id]?wheelBase(g)+BONUS_LIFT[g.id].lift*(1-g.bonus.table.find(x=>x.type==='none').weight/g.bonus.table.reduce((a,x)=>a+x.weight,0))/BONUS_LIFT[g.id].share+(BONUS_LIFT[g.id].jackpot||0):null;

/** Game definition for a tier, or null when the game's return rate cannot be changed this way. */
export function tierGame(game,tier){
 if(!RTP_TIERS.includes(tier))return null;
 const t=Number(tier)/100;
 if(game.family==='crash')return {...game,rtp:t};
 if(game.family==='arcade')return {...game,arcade:{...game.arcade,rtp:t}};
 if(game.family==='slot'){const s=game.slot,base=s.targetRtp||0.97;return {...game,slot:{...s,targetRtp:t,payScale:round4((s.payScale??1)*t/base)}};}
 if(game.family==='wheel'&&!game.draw&&BONUS_LIFT[game.id]&&game.bonus?.table){
  // Mini-reel bonus games: the bonus entries' weights scale so draw + bonus (+ jackpot pool) meets the tier.
  const base=wheelBase(game),k=(t-base-(BONUS_LIFT[game.id].jackpot||0))/BONUS_LIFT[game.id].lift;
  if(!(k>=0))return null;
  const total=game.bonus.table.reduce((a,x)=>a+x.weight,0),table=game.bonus.table.filter(x=>x.type!=='none').map(x=>({...x,weight:Math.round(x.weight*k)}));
  const none=total-table.reduce((a,x)=>a+x.weight,0);if(none<0)return null;
  return {...game,rtpTarget:t,bonus:{...game.bonus,table:[{type:'none',weight:none},...table]}};
 }
 if(game.family==='wheel'&&!game.draw&&game.specials?.length){
  const opts=game.options.filter(o=>!o.covers),inv=opts.reduce((a,o)=>a+1/o.multiplier,0);
  const size=s=>opts.filter(o=>o.group===s.covers).length,lift=game.specials.reduce((a,s)=>a+s.probability*(size(s)-1),0);
  const k=(t*inv-1)/lift;if(!(k>=0))return null;
  const specials=game.specials.map(s=>({...s,probability:s.probability*k}));
  // Every option keeps a positive own probability: R/m_i > its group's special probability.
  const special=g=>specials.filter(s=>s.covers===g).reduce((a,s)=>a+s.probability,0);
  if(opts.some(o=>t/o.multiplier-special(o.group)<=0))return null;
  return {...game,specials};
 }
 return null;
}
