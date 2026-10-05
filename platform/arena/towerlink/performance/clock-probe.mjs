/** Deterministic clock-correction regression using actual production soldier draw transforms. */
import {chromium} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const mode=process.argv[2]||'before',base=process.env.TOWER_PERF_ORIGIN||'http://127.0.0.1:18126',browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:760},deviceScaleFactor:1});
 await page.route(base+'/__tower-clock',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><style>body{margin:0}canvas{width:390px;height:500px}</style><canvas></canvas>'}));
 await page.goto(base+'/__tower-clock');
 const result=await page.evaluate(async mode=>{
  const {createTowerScene,towerPoint}=await import('/arena/towerlink/tower-scene.js'),{preloadTowerAssets}=await import('/arena/towerlink/tower-assets.mjs'),{createTowerClock}=await import('/arena/towerlink/presentation-clock.mjs');await preloadTowerAssets();
  const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),drawImage=ctx.drawImage.bind(ctx),pending=new Map();
  let local=0,offset=1000,serverAt=1000,rafId=0,draws=[];const clock=createTowerClock(1000,0),serverTime=()=>mode==='after'?clock.now(local):local+offset;
  window.requestAnimationFrame=fn=>{pending.set(++rafId,fn);return rafId;};window.cancelAnimationFrame=id=>pending.delete(id);
  ctx.drawImage=(...args)=>{if(args[0]?.src?.includes('soldiers-atlas'))draws.push({x:ctx.getTransform().e,y:ctx.getTransform().f});return drawImage(...args);};
  const towers=[{id:0,x:.15,y:.5,ring:'inner',level:1,neighbors:[1]},{id:1,x:.85,y:.5,ring:'inner',level:1,neighbors:[0]}];
  let game={status:'active',startedAt:1000,simulationAt:1000,serverNow:1000,deadlineAt:100000,level:{id:'clock-probe'},players:[{key:'p0'},{key:'p1'}],towers,owners:['p0','p1'],edges:[[0,1]],orders:[],recentEvents:[],armies:[{id:'one',ownerKey:'p0',from:0,to:1,count:1,departedAt:1000,arrivesAt:4000}]};
  const dispose=createTowerScene(canvas,()=>({game,roomId:'clock-probe',selected:null,me:'p0',reduced:false,rotation:0,serverAt,serverTime}));
  await new Promise(resolve=>setTimeout(resolve,50));
  const left=towerPoint(towers[0],390,500),right=towerPoint(towers[1],390,500),frames=[];
  for(let step=0;step<20;step++){
   local=550+step*(1000/60);
   if(step===3){ // RTT becomes 240 ms shorter, making this server timestamp newer than the old estimate.
    const value=1840,proposed=value-local,delta=proposed-offset;offset+=Math.abs(delta)>2000?delta:delta*.16;serverAt=value;game={...game,serverNow:value,simulationAt:1750};clock.receive(value,game.simulationAt,local);
   }
   draws=[];const next=[...pending.values()];pending.clear();for(const draw of next)draw(local);
   const inferredVisualAt=1000+(draws[0].x-left.x)/(right.x-left.x)*3000;
   frames.push({local,estimatedServerAt:serverTime(),snapshotSimulationAt:game.simulationAt,inferredVisualAt,soldierX:draws[0].x});
  }
  dispose();return frames;
 },mode);
 let heldFrames=0;for(let i=1;i<result.length;i++)if(Math.abs(result[i].inferredVisualAt-result[i-1].inferredVisualAt)<1e-7)heldFrames++;
 const report={mode,scope:'Synthetic receipt timing passed through the exact current 0.16 clock correction. Actual production Canvas drawImage transforms establish visual motion independently of RAF. A 240 ms RTT improvement is a controlled input, not a claim about the public run.',heldFrames,heldMs:heldFrames*(1000/60),frames:result};
 assert.equal(heldFrames,mode==='after'?0:6,'Clock correction must not stall rendered soldiers after a fresh snapshot');
 await writeFile(new URL('./clock-'+mode+'.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({heldFrames,heldMs:report.heldMs,frames:result.slice(2,12)},null,2));
}finally{await browser.close();}
