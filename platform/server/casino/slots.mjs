/**
 * Slot engine v2 (config driven). Pay type "anywhere": a symbol pays when `minCount`+ copies land
 * anywhere on the grid (count bands), winning symbols tumble away and new ones drop in until no win.
 * Multiplier orbs add up per spin; scatters award free spins where orbs accumulate into a total
 * multiplier. One paid spin is a complete cycle: base spin plus every free spin it awards.
 * All pays are multiples of the stake; the cycle is capped at `maxWin` x stake.
 */
import {createHash} from 'node:crypto';
import {createRng} from './rng.mjs';

const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const MAX_TUMBLES=40;

export function slotModel(game){
 const s=game.slot;
 const config={family:'slot',pay:s.pay,columns:s.columns,rows:s.rows,symbols:s.symbols,scatter:s.scatter,orbs:s.orbs,freeSpins:s.freeSpins,maxWin:s.maxWin,weights:s.weights,buy:s.buy||null,rng:'HMAC-SHA256 counter',...(s.payScale&&s.payScale!==1?{payScale:s.payScale}:{})};
 const hash=createHash('sha256').update(canonical(config)).digest('hex');
 return Object.freeze({gameId:game.id,version:`${game.id}-slot-v1-${hash.slice(0,12)}`,hash,maxMultiplier:s.maxWin,targetRtp:s.targetRtp,config});
}

/** Pay in hundredths of stake for `count` copies of a symbol (0 when below the first band). */
function bandPay(symbol,count){let pay=0;for(const [min,x100] of symbol.bands)if(count>=min)pay=x100;return pay;}

/** `stakeMinor` is the base stake; with `buy` the cycle starts directly in the free spins feature. */
export function playSlotCycle(model,seedHex,stakeMinor,{buy=false}={}){
 const c=model.config,rng=createRng(seedHex,`${model.version}:cycle`),size=c.columns*c.rows;
 const pool=[...c.symbols.map(s=>({id:s.id,w:c.weights.base[s.id]})),{id:'scatter',w:c.weights.base.scatter},{id:'orb',w:c.weights.base.orb}];
 const freePool=[...c.symbols.map(s=>({id:s.id,w:c.weights.free[s.id]??c.weights.base[s.id]})),{id:'scatter',w:c.weights.free.scatter},{id:'orb',w:c.weights.free.orb}];
 const draw=(p,free)=>{const sym=p[rng.weighted(p.map(x=>x.w))].id;if(sym!=='orb')return{s:sym};const orbs=free?c.orbs.free:c.orbs.base;return{s:'orb',m:orbs[rng.weighted(orbs.map(o=>o.w))].x};};
 const capX100=c.maxWin*100;let totalX100=0,capped=false;
 // Return-rate tiers scale every pay (rounded to whole hundredths of the stake, unbiased).
 const scaled=x=>c.payScale?Math.round(x*c.payScale):x;
 function spin(free,totalMult){
  const p=free?freePool:pool;let grid=Array.from({length:size},()=>draw(p,free));
  const initial=grid.map(x=>({...x})),tumbles=[];let winX100=0;
  for(let n=0;n<MAX_TUMBLES;n++){
   const counts={};grid.forEach((x,i)=>{(counts[x.s]||=[]).push(i);});
   const wins=c.symbols.map(s=>({symbol:s.id,cells:counts[s.id]||[],pay:scaled(bandPay(s,(counts[s.id]||[]).length))})).filter(w=>w.pay>0);
   if(!wins.length)break;
   const removed=new Set(wins.flatMap(w=>w.cells));winX100+=wins.reduce((a,w)=>a+w.pay,0);
   // Columns collapse downward (index = row*columns+col, row 0 at the top); new symbols fill from the top.
   const next=grid.map(x=>x);
   for(let col=0;col<c.columns;col++){
    const keep=[];for(let row=c.rows-1;row>=0;row--){const i=row*c.columns+col;if(!removed.has(i))keep.push(grid[i]);}
    for(let row=c.rows-1,k=0;row>=0;row--,k++){const i=row*c.columns+col;next[i]=k<keep.length?keep[k]:draw(p,free);}
   }
   tumbles.push({wins:wins.map(w=>({symbol:w.symbol,cells:w.cells,pay_x100:w.pay})),grid:next.map(x=>({...x}))});grid=next;
  }
  const orbSum=winX100>0?grid.filter(x=>x.s==='orb').reduce((a,x)=>a+x.m,0):0;
  const scatters=grid.filter(x=>x.s==='scatter').length;
  let mult=1,nextTotal=totalMult;
  if(free){if(orbSum>0)nextTotal=totalMult+orbSum;if(winX100>0&&nextTotal>0)mult=nextTotal;}
  else if(orbSum>0)mult=orbSum;
  let spinX100=winX100*mult;
  const scatterPay=free?0:scaled(bandPay({bands:c.scatter.bands},scatters));spinX100+=scatterPay;
  if(totalX100+spinX100>=capX100){spinX100=capX100-totalX100;capped=true;}
  totalX100+=spinX100;
  return {free,initial,tumbles,scatters,orb_sum:orbSum,multiplier:mult,total_multiplier:nextTotal,scatter_pay_x100:scatterPay,win_x100:spinX100};
 }
 const spins=buy?[]:[spin(false,0)];
 let freeLeft=buy?c.freeSpins.award:!capped&&spins[0].scatters>=c.freeSpins.trigger?c.freeSpins.award:0,totalMult=0,played=0;
 while(freeLeft>0&&!capped&&played<c.freeSpins.maxPlayed){
  const s=spin(true,totalMult);spins.push(s);played++;freeLeft--;totalMult=s.total_multiplier;
  if(s.scatters>=c.freeSpins.retrigger)freeLeft+=c.freeSpins.retriggerAward;
 }
 const gross=BigInt(stakeMinor)*BigInt(totalX100)/100n;
 return {outcome:`${(totalX100/100).toFixed(2)}x`,mode:buy?'buy':'normal',base_stake_minor:String(stakeMinor),win_x100:totalX100,gross_payout_minor:String(gross),capped,free_spins:played,spins};
}
