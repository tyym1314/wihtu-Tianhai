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
export function wheelModel(game){
 const specials=game.specials||[];
 const groupSize=g=>game.options.filter(o=>o.group===g).length;
 const sumInverse=game.options.reduce((a,o)=>a+1/o.multiplier,0);
 const rtp=(1+specials.reduce((a,s)=>a+s.probability*(groupSize(s.covers)-1),0))/sumInverse;
 const special=g=>specials.filter(s=>s.covers===g).reduce((a,s)=>a+s.probability,0);
 const probs=[...game.options.map(o=>rtp/o.multiplier-special(o.group)),...specials.map(s=>s.probability)];
 if(probs.some(p=>p<=0))throw new Error('infeasible wheel');
 const weights=probs.map(p=>Math.round(p*TOTAL));
 weights[0]+=TOTAL-weights.reduce((a,b)=>a+b,0);
 const outcomes=[...game.options.map(o=>({id:o.id,covers:[o.id]})),...specials.map(s=>({id:s.id,covers:game.options.filter(o=>o.group===s.covers).map(o=>o.id)}))];
 const maxMultiplier=Math.max(...game.options.map(o=>o.multiplier));
 const config={family:'wheel',options:game.options,specials,weights,total:TOTAL,rng:'HMAC-SHA256 counter, rejection sampled'};
 const hash=createHash('sha256').update(canonical(config)).digest('hex');
 return Object.freeze({gameId:game.id,version:`${game.id}-wheel-v1`,hash,maxMultiplier,targetRtp:rtp,weights,outcomes,config});
}

export function drawWheel(model,seedHex){
 const index=createRng(seedHex,`${model.version}:outcome`).weighted(model.weights);
 return {outcome:model.outcomes[index].id,winners:model.outcomes[index].covers};
}

/** Gross payout for one bet (stake included); 0 when the option did not win. */
export function wheelPayout(game,result,optionId,stakeMinor){
 if(!result.winners.includes(optionId))return 0n;
 const option=game.options.find(o=>o.id===optionId);
 return BigInt(stakeMinor)*BigInt(option.multiplier);
}
