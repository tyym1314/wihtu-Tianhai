/**
 * Slot engine v2 — "lines" and "ways" pay types (the "anywhere" tumble type lives in slots.mjs).
 * Grids are column-major arrays: grid[col][row]. All pays are hundredths of the TOTAL stake.
 *
 * lines: fixed paylines (row index per column), left to right, at least `minCount` in a row;
 *   a wild substitutes on its allowed reels and a wild-led line pays the best symbol it can form.
 * ways:  any row on adjacent reels from the left (rows may differ per reel, e.g. 4-5-5-5-4 = 2000 ways);
 *   wins cascade: winning cells vanish (golden cells turn wild instead), symbols drop, and each
 *   cascade raises the multiplier along a ladder.
 * Both: scatters anywhere award free spins (more for each extra scatter) with their own multiplier.
 */
import {createHash} from 'node:crypto';
import {createRng} from './rng.mjs';

const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const MAX_CASCADES=30;

export function linesModel(game){
 const s=game.slot,config={family:'slot',...s,rng:'HMAC-SHA256 counter'};
 const hash=createHash('sha256').update(canonical(config)).digest('hex');
 return Object.freeze({gameId:game.id,version:`${game.id}-${s.pay}-v1`,hash,maxMultiplier:s.maxWin,targetRtp:s.targetRtp,config});
}

function drawCell(rng,c,col,free){
 const w=(free&&c.weights.free)||c.weights.base,ids=Object.keys(w);
 const weights=ids.map(id=>{const v=w[id];return Array.isArray(v)?v[col]:v;});
 const s=ids[rng.weighted(weights)];
 const cell={s};
 if(c.golden&&c.golden.reels.includes(col)&&s!==c.wild?.id&&s!==c.scatter.id&&rng.int(10000)<c.golden.chanceBp)cell.g=1;
 return cell;
}
function drawGrid(rng,c,free){
 const rows=c.rows,grid=[];
 for(let col=0;col<c.columns;col++){
  const n=Array.isArray(rows)?rows[col]:rows,reel=[];let wilds=0;
  for(let r=0;r<n;r++){let cell=drawCell(rng,c,col,free);
   // Wilds only on their reels, at most `maxPerReel` per reel.
   while(c.wild&&cell.s===c.wild.id&&(!c.wild.reels.includes(col)||wilds>=(c.wild.maxPerReel??99)))cell=drawCell(rng,c,col,free);
   if(c.wild&&cell.s===c.wild.id)wilds++;reel.push(cell);}
  grid.push(reel);
 }
 return grid;
}
const payOf=(sym,count,scale=1)=>{let p=0;for(const [n,x] of sym.pays)if(count>=n)p=x;return p*scale;};

function evalLines(c,grid){
 const wins=[],wild=c.wild?.id;
 c.lines.forEach((line,li)=>{
  const cells=line.map((row,col)=>grid[col][row].s);
  let best=null;
  for(const sym of c.symbols){
   let n=0;while(n<cells.length&&(cells[n]===sym.id||cells[n]===wild))n++;
   const pay=payOf(sym,n,c.payScale);if(pay&&(!best||pay>best.pay))best={line:li,symbol:sym.id,count:n,pay,cells:line.slice(0,n).map((row,col)=>[col,row])};
  }
  if(best)wins.push({...best,pay_x100:best.pay/c.lines.length});
 });
 return wins;
}

function evalWays(c,grid){
 const wins=[],wild=c.wild?.id;
 for(const sym of c.symbols){
  let ways=1,reels=0;const cells=[];
  for(let col=0;col<grid.length;col++){
   const hits=grid[col].map((x,row)=>[x,row]).filter(([x])=>x.s===sym.id||x.s===wild);
   if(!hits.length)break;ways*=hits.length;reels++;cells.push(...hits.map(([,row])=>[col,row]));
  }
  const pay=payOf(sym,reels,c.payScale);
  if(pay&&grid[0].some(x=>x.s===sym.id||x.s===wild))wins.push({symbol:sym.id,count:reels,ways,cells,pay_x100:pay*ways/c.waysDivisor});
 }
 return wins;
}

export function playLinesCycle(model,seedHex,stakeMinor,{buy=false}={}){
 const c=model.config,rng=createRng(seedHex,`${model.version}:cycle`),cap=c.maxWin*100;
 let total=0,capped=false;
 const scatterCount=g=>g.flat().filter(x=>x.s===c.scatter.id).length;
 function spin(free){
  let grid=drawGrid(rng,c,free);const initial=grid.map(r=>r.map(x=>({...x})));
  const steps=[];let win=0,cascade=0;
  if(c.pay==='lines'){const wins=evalLines(c,grid);win=wins.reduce((a,w)=>a+w.pay_x100,0);if(wins.length)steps.push({wins,multiplier:1});}
  else for(;cascade<MAX_CASCADES;cascade++){
   const wins=evalWays(c,grid);if(!wins.length)break;
   const ladder=free?c.cascade.free:c.cascade.base,mult=ladder[Math.min(cascade,ladder.length-1)];
   win+=wins.reduce((a,w)=>a+w.pay_x100,0)*mult;
   const hit=new Set(wins.flatMap(w=>w.cells.map(([col,row])=>col+':'+row)));
   const next=grid.map((reel,col)=>{
    // Golden winners become wild in place; other winners vanish; survivors fall; new symbols on top.
    const kept=reel.map((x,row)=>hit.has(col+':'+row)?(x.g?{s:c.wild.id}:null):x).filter(Boolean);
    const fill=[];while(fill.length+kept.length<reel.length)fill.push(drawCell(rng,c,col,free));
    return [...fill,...kept];
   });
   steps.push({wins,multiplier:mult,grid:next.map(r=>r.map(x=>({...x})))});grid=next;
  }
  const scatters=scatterCount(free&&c.pay==='lines'?grid:initial);
  const sc=payOf({pays:c.scatter.pays||[]},scatters)||0;
  let spinWin=(free?win*(c.freeSpins.multiplier||1):win)+sc;
  if(total+spinWin>=cap){spinWin=cap-total;capped=true;}
  total+=spinWin;
  return {free,initial,steps,scatters,scatter_pay_x100:sc,win_x100:spinWin};
 }
 const award=n=>n>=c.freeSpins.trigger?c.freeSpins.award+(n-c.freeSpins.trigger)*(c.freeSpins.perExtra||0):0;
 const spins=buy?[]:[spin(false)];
 let left=buy?c.freeSpins.award:award(spins[0].scatters),played=0;
 while(left>0&&!capped&&played<c.freeSpins.maxPlayed){const s=spin(true);spins.push(s);played++;left--;left+=c.freeSpins.retrigger&&s.scatters>=c.freeSpins.trigger?c.freeSpins.retrigger:0;}
 const totalX100=Math.floor(total);
 return {outcome:`${(totalX100/100).toFixed(2)}x`,mode:buy?'buy':'normal',base_stake_minor:String(stakeMinor),win_x100:totalX100,
  gross_payout_minor:String(BigInt(stakeMinor)*BigInt(totalX100)/100n),capped,free_spins:played,spins};
}
