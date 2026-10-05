/** Replay captured public receipt clocks at 60Hz; does not simulate rendering cost. */
import {readFile,writeFile} from 'node:fs/promises';
import {createTowerClock} from '../presentation-clock.mjs';
const input=process.argv[2]||'review/performance-20260928/towerlink-clocks-before/towerlink-cpu1-clocks.json';
const rows=JSON.parse(await readFile(input,'utf8')).filter(r=>r.status==='active'&&Number.isFinite(r.simulation_at));
const start=rows[0].receipt_epoch_ms,initial=rows[0].server_now,startAt=rows[0].simulation_at;
function replay(mode,framePhase=0){
 let latest=rows[0],next=1,offset=initial,lastVisual=-Infinity,held=[],jumps=[],frames=0,maxAdvanceMs=0;
 const clock=createTowerClock(initial,0);
 const end=rows.at(-1).receipt_epoch_ms-start;
 for(let local=framePhase;local<end;local+=1000/60){
  while(next<rows.length&&rows[next].receipt_epoch_ms-start<=local){
   const row=rows[next++];if(row.version<latest.version)continue;
   const receipt=row.receipt_epoch_ms-start;
   if(mode==='before'){const delta=row.server_now-receipt-offset;offset+=Math.abs(delta)>2000?delta:delta*.16;}else clock.receive(row.server_now,row.simulation_at,receipt);
   latest=row;
  }
  const current=mode==='before'?local+offset:clock.now(local),visual=Math.max(lastVisual,latest.simulation_at,Math.min(current,latest.server_now+1400));
  if(local+start>startAt+100&&Number.isFinite(lastVisual)){
   frames++;const delta=visual-lastVisual;maxAdvanceMs=Math.max(maxAdvanceMs,delta);
   if(delta<1)held.push({local,delta,visual,serverNow:latest.server_now,simulationAt:latest.simulation_at});
   if(delta>1000/60+5)jumps.push({local,delta});
  }
  lastVisual=visual;
 }
 return{framePhase,frames,heldFrames:held.length,heldMs:held.length*1000/60,maxAdvanceMs,jumpsOverNominalPlus5Ms:jumps.length,held,jumps};
}
const before=[0,4,8,12].map(phase=>replay('before',phase)),after=[0,4,8,12].map(phase=>replay('after',phase));
const report={input,scope:'Model replay of actual captured public server_now/simulationAt and response receipt times, at four synthetic 60Hz frame phases. Excludes initial countdown. Captured receipt order approximates React commit order; these are inferred visual-clock stalls, not directly observed on the user phone.',samples:rows.length,before,after};
await writeFile(new URL('./public-clock-replay.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({samples:rows.length,before:before.map(({held,jumps,...r})=>r),after:after.map(({held,jumps,...r})=>r)},null,2));
