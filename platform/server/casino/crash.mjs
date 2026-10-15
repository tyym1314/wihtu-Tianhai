/**
 * Crash family: one shared crash point per round. The multiplier grows as e^(k*t) from 1.00x;
 * a bet pays stake * cash-out multiplier if cashed out (manually or automatically) before the crash.
 * P(crash >= x) = rtp / x for x >= 1, so every cash-out target has the same expected return.
 */
import {createHash} from 'node:crypto';
import {createRng} from './rng.mjs';

export const GROWTH_PER_MS=Math.log(2)/8000; // doubles every 8 s
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;

/** Multiplier (x100, floored) after `ms` of flight. */
export const multiplierAt=ms=>Math.floor(100*Math.exp(GROWTH_PER_MS*Math.max(0,ms))+1e-9);
/** Flight time (ms) until the multiplier first reaches x100. */
export const timeToReach=x100=>x100<=100?0:Math.ceil(Math.log(x100/100)/GROWTH_PER_MS);

export function crashModel(game){
 const config={family:'crash',rtp:game.rtp,cap_x100:game.maxMultiplier*100,growth:'e^(ln2/8000*ms)',rng:'HMAC-SHA256 counter, 32-bit uniform'};
 const hash=createHash('sha256').update(canonical(config)).digest('hex');
 return Object.freeze({gameId:game.id,version:`${game.id}-crash-v1`,hash,maxMultiplier:game.maxMultiplier,targetRtp:game.rtp,config});
}

export function drawCrash(model,seedHex){
 const u=createRng(seedHex,`${model.version}:crash`).uint32()/2**32;
 const x100=Math.min(model.config.cap_x100,Math.max(100,Math.floor(100*model.targetRtp/(1-u))));
 return {outcome:(x100/100).toFixed(2),crash_x100:x100};
}

/** Gross payout: manual cash-out wins, else an auto cash-out at or below the crash point. */
export function crashPayout(game,result,bet){
 const x=bet.cashout_x100??(bet.auto_x100&&bet.auto_x100<=result.crash_x100?bet.auto_x100:null);
 return x?BigInt(bet.stake_minor)*BigInt(x)/100n:0n;
}
