/** Isolated production renderer benchmark; deterministic battle, no API or wallet. */
import {chromium,webkit} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const label=process.argv[2]||'measurement',base=process.env.TOWER_PERF_ORIGIN||'http://127.0.0.1:18126';
const browserName=process.env.TOWER_PERF_BROWSER||'chromium';
const baselineSource=process.env.TOWER_PERF_BASELINE_SOURCE?await readFile(process.env.TOWER_PERF_BASELINE_SOURCE,'utf8'):null;
const fixture=JSON.parse(await readFile(new URL('./fixture.json',import.meta.url),'utf8'));
const browser=await (browserName==='webkit'?webkit:chromium).launch({headless:true});
try{
 const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
 const page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 if(baselineSource)await page.route('**/arena/towerlink/troop-presentation.mjs*',route=>route.fulfill({contentType:'text/javascript',body:baselineSource}));
 await page.route(base+'/__tower-perf',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}canvas{display:block;width:390px;height:500px}</style><canvas></canvas>'}));
 await page.goto(base+'/__tower-perf');
 if(browserName==='chromium'){const session=await context.newCDPSession(page);await session.send('Emulation.setCPUThrottlingRate',{rate:6});}
 const report=await page.evaluate(async ({fixture,browserName})=>{
  const {createTowerScene}=await import('/arena/towerlink/tower-scene.js');
  const {preloadTowerAssets}=await import('/arena/towerlink/tower-assets.mjs');
  const {createTroopProjection}=await import('/arena/towerlink/troop-presentation.mjs');
  await preloadTowerAssets();
  const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return{n:sorted.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],p99:sorted[Math.floor(sorted.length*.99)],max:sorted.at(-1),mean:values.reduce((a,b)=>a+b,0)/values.length};};
  // Keep the same 500 ms snapshot window as the production polling interval.
  let cpu=[],returnedArrays=new Set(),returnedArmies=new Set(),checksum=0;
  for(let i=0;i<1000;i++){
   const projection=createTroopProjection(fixture),start=performance.now();
   for(let frame=0;frame<30;frame++){
    const view=projection.at(fixture.serverNow+frame*(500/30));
    if(i===0){returnedArrays.add(view.armies);for(const army of view.armies)returnedArmies.add(army);}
    checksum+=view.armies.length;
   }
   cpu.push(performance.now()-start);
  }
  const projection={thirtyFramesMs:stats(cpu),distinctArraysFirstSnapshot:returnedArrays.size,distinctArmyObjectsFirstSnapshot:returnedArmies.size,checksum};
  const nativeRaf=window.requestAnimationFrame.bind(window),frameCpu=[],frameIntervals=[];
  let lastTs=0;
  window.requestAnimationFrame=fn=>nativeRaf(ts=>{const start=performance.now();fn(ts);frameCpu.push(performance.now()-start);if(lastTs)frameIntervals.push(ts-lastTs);lastTs=ts;});
  let g=fixture,epoch=performance.now(),serverAt=fixture.serverNow;
  const renew=()=>{
   const shift=performance.now()-epoch;
   g={...fixture,serverNow:fixture.serverNow+shift,simulationAt:fixture.simulationAt+shift,armies:fixture.armies.map(a=>({...a,departedAt:a.departedAt+shift,arrivesAt:a.arrivesAt+shift})),recentEvents:[]};
   serverAt=g.serverNow;
  };
  const timer=setInterval(renew,500),dispose=createTowerScene(document.querySelector('canvas'),()=>({game:g,roomId:'benchmark',selected:0,aim:null,me:'p0',reduced:false,rotation:0,serverAt,serverTime:()=>fixture.serverNow+performance.now()-epoch}));
  await new Promise(r=>setTimeout(r,1500));frameCpu.length=0;frameIntervals.length=0;lastTs=0;
  await new Promise(r=>setTimeout(r,10000));dispose();clearInterval(timer);window.requestAnimationFrame=nativeRaf;
  return{scope:`Mac ${browserName} headless, mobile viewport 390x844 DPR 3 (renderer caps 2), ${browserName==='chromium'?'CDP CPU slowdown 6x':'native CPU speed'}, real production renderer/WebP textures, repeat 500ms snapshot fixture, no API or physical-device acceptance.`,workload:{towers:fixture.towers.length,armies:fixture.armies.length,orders:fixture.orders.length},projection,render:{frameCpuMs:stats(frameCpu),rafIntervalsMs:stats(frameIntervals),over33ms:frameIntervals.filter(v=>v>33.4).length}};
 },{fixture,browserName});
 report.at=new Date().toISOString();report.label=label;report.errors=errors;report.sources={};
 for(const file of ['tower-scene.js','TowerLinkGame.jsx','troop-presentation.mjs'])report.sources[file]=createHash('sha256').update(await readFile(new URL('../'+file,import.meta.url))).digest('hex');
 if(baselineSource){report.sources['troop-presentation.mjs']=createHash('sha256').update(baselineSource).digest('hex');report.baselineViaTestRoute=true;}
 await writeFile(new URL('./'+label+'.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
