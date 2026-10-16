/**
 * Wheel family (Greedy-style): one shared outcome per round, each option pays its multiplier
 * (stake included). Specials pay every option of a group. Weights give every option the same RTP.
 */
import {createHash} from 'node:crypto';
import {createRng} from './rng.mjs';

const TOTAL=1_000_000;
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;

/**
 * Per-option RTP R satisfies m_i * (p_i + p_group(i)) = R and sum(p) = 1, so
 * R = (1 + sum_s p_s * (|group_s| - 1)) / sum_i (1 / m_i).
 */
// Group bets (`covers`) win when the drawn outcome pays any covered option; they are not drawn themselves.
const drawable=game=>game.draw?[]:game.options.filter(o=>!o.covers);
export function wheelModel(game){
 const specials=game.specials||[];
 game={...game,options:drawable(game),groups:game.options.filter(o=>o.covers)};
 const groupSize=g=>game.options.filter(o=>o.group===g).length;
 const sumInverse=game.options.reduce((a,o)=>a+1/o.multiplier,0);
 const rtp=(1+specials.reduce((a,s)=>a+s.probability*(groupSize(s.covers)-1),0))/sumInverse;
 // Explicit draws (e.g. roulette 0-36): fixed outcome weights; every bet is a group bet over outcomes.
 if(game.draw){
  const weights=game.draw.map(o=>o.weight),total=weights.reduce((a,b)=>a+b,0),outcomes=game.draw.map(o=>({id:o.id,covers:[o.id]}));
  const rtp=Math.min(...game.groups.map(g=>g.multiplier*g.covers.reduce((a,c)=>a+game.draw.find(o=>o.id===c).weight,0)/total));
  const config={family:'wheel',draw:game.draw,groups:game.groups,total,rng:'HMAC-SHA256 counter, rejection sampled'};
  const hash=createHash('sha256').update(canonical(config)).digest('hex');
  return Object.freeze({gameId:game.id,version:`${game.id}-wheel-v1`,hash,maxMultiplier:Math.ceil(Math.max(...game.groups.map(g=>g.multiplier))),targetRtp:rtp,weights,outcomes,config:{...config,weights,options:[]}});
 }
 const special=g=>specials.filter(s=>s.covers===g).reduce((a,s)=>a+s.probability,0);
 const probs=[...game.options.map(o=>rtp/o.multiplier-special(o.group)),...specials.map(s=>s.probability)];
 if(probs.some(p=>p<=0))throw new Error('infeasible wheel');
 const weights=probs.map(p=>Math.round(p*TOTAL));
 weights[0]+=TOTAL-weights.reduce((a,b)=>a+b,0);
 const outcomes=[...game.options.map(o=>({id:o.id,covers:[o.id]})),...specials.map(s=>({id:s.id,covers:game.options.filter(o=>o.group===s.covers).map(o=>o.id)}))];
 // With a bonus (multiplier / jackpot share) the wallet reserve uses the configured liability cap.
 const maxMultiplier=game.bonus?.liabilityMultiplier||Math.ceil(Math.max(...game.options.map(o=>o.multiplier)));
 const bonus=game.bonus||null;
 const config={family:'wheel',options:game.options,groups:game.groups,specials,weights,total:TOTAL,bonus,rng:'HMAC-SHA256 counter, rejection sampled'};
 const hash=createHash('sha256').update(canonical(config)).digest('hex');
 return Object.freeze({gameId:game.id,version:`${game.id}-wheel-v1`,hash,maxMultiplier,targetRtp:rtp,weights,outcomes,config});
}

export function drawWheel(model,seedHex){
 const rng=createRng(seedHex,`${model.version}:outcome`),index=rng.weighted(model.weights);
 const result={outcome:model.outcomes[index].id,winners:[...model.outcomes[index].covers]};
 const b=model.config.bonus;if(!b)return result;
 // Mini-reel bonus after the draw: extra winning items (drawn by weight), a payout multiplier, or a jackpot share.
 const kind=b.table[rng.weighted(b.table.map(x=>x.weight))];
 result.bonus={type:kind.type,value:kind.value??null};
 if(kind.type==='extra'){
  const pool=model.outcomes.map((o,i)=>({id:o.id,w:model.weights[i]})).filter(o=>model.config.options.some(x=>x.id===o.id)&&!result.winners.includes(o.id));
  for(let n=0;n<kind.value&&pool.length;n++){const k=rng.weighted(pool.map(o=>o.w));result.winners.push(pool[k].id);pool.splice(k,1);}
 }
 return result;
}

/** Gross payout for one bet (stake included); 0 when the option did not win. */
export function wheelPayout(game,result,optionId,stakeMinor){
 const option=game.options.find(o=>o.id===optionId);
 if(option.covers?!option.covers.some(c=>result.winners.includes(c)):!result.winners.includes(optionId))return 0n;
 const mult=result.bonus?.type==='multiplier'?BigInt(result.bonus.value):1n;
 return BigInt(stakeMinor)*BigInt(Math.round(option.multiplier*100))*mult/100n;
}
