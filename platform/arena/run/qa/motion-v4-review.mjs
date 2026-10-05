/** Real touch + HTTP engine + actual material sampling. Does not access platform wallets. */
import {chromium} from 'playwright';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {motionReviewServer} from './motion-review-server.mjs';

const out=new URL('motion-v4/',import.meta.url);await mkdir(out,{recursive:true});
const server=await motionReviewServer(),browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-webgl','--use-angle=metal']});
const errors=[],checks=[];let context,page,video;
function place(name,distance,lane=1,offsets=[0,1.5,3,4.5]){
  server.configure(name,s=>{for(const[i,p]of s.players.entries()){
    p.distanceU=Math.round((distance+offsets[i])*300);p.checkpointU=Math.floor(p.distanceU/9000)*9000;
    p.lane=p.fromLane=i===0?lane:i===1?0:2;p.changeStartTick=p.changeEndTick=s.tick;
    p.jumpStartTick=null;p.slideUntilTick=0;p.stunUntilTick=0;p.fallStartTick=p.fallUntilTick=null;
    p.immuneUntilTick=0;p.pendingInput=null;p.lastInputTick=s.tick-20;p.resolvedObstacles=[];
  }});
}
const samples=()=>page.evaluate(()=>window.__motionSamples);
async function screenshot(name){await page.screenshot({path:new URL(name,out).pathname});}
async function checkControls(target=page){
  const controls=await target.evaluate(()=>['run-item','run-jump','run-left','run-slide','run-right'].map(id=>{
    const el=document.querySelector(`[data-testid="${id}"]`),r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return{id,x:r.x,y:r.y,width:r.width,height:r.height,centerReceives:hit===el||el.contains(hit)};
  }));
  for(const c of controls){assert.ok(c.width>=43.9&&c.height>=43.9,`${c.id} must retain at least a 44px touch box`);assert.ok(c.centerReceives,`${c.id} center must not be covered by another element`);}
  for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){
    const a=controls[i],b=controls[j],overlapX=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x),overlapY=Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y);
    assert.ok(overlapX<=.1||overlapY<=.1,`${a.id} and ${b.id} touch boxes overlap`);
  }
  return controls;
}
async function touchSwipe(direction){
  const target=await page.getByTestId('run-track').boundingBox();
  const x=target.x+target.width*.60,y=target.y+target.height*.53,dy=direction==='up'?-96:96;
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
  for(let step=1;step<=4;step++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+dy*step/4,id:1}]});await page.waitForTimeout(15);}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
}
try{
  context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,recordVideo:{dir:new URL('raw-video/',out).pathname,size:{width:430,height:844}}});
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.origin);await page.waitForSelector('[data-models-ready="4"][data-environment-ready="true"][data-background-ready="true"]');
  const renderer=await page.evaluate(()=>{const g=document.querySelector('[data-testid=run-track] canvas').getContext('webgl2'),ext=g.getExtension('WEBGL_debug_renderer_info');return{vendor:ext?g.getParameter(ext.UNMASKED_VENDOR_WEBGL):null,renderer:ext?g.getParameter(ext.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER),renderInfo:window.__rendererStats};});
  place('eight-frame coverage: unobstructed approach',286);
  await page.waitForFunction(()=>window.__motionSamples.some(s=>s.key==='p0'&&s.authoritativeDistance>=286&&s.authoritativeDistance<300));
  await page.evaluate(()=>window.__motionSamples=[]);
  await page.waitForFunction(()=>['p0','p1','p2','p3'].every(key=>new Set(window.__motionSamples.filter(s=>s.key===key&&s.sheet==='run').map(s=>s.frame)).size===8),{},{timeout:7000});
  const running=await samples();
  const coverage=['p0','p1','p2','p3'].map(key=>{
    const list=running.filter(s=>s.key===key&&s.sheet==='run');
    assert.ok(list.every(s=>s.frameCount===8),'Each renderer must declare exactly eight running frames');
    assert.equal(new Set(list.map(s=>JSON.stringify(s.uv))).size,8,'Eight actual texture UV offsets are sampled');
    assert.ok(list.every(s=>Math.abs(s.repeat[0]-(.25-1/s.imageSize[0]))<1e-8&&Math.abs(s.repeat[1]-(.5-1/s.imageSize[1]))<1e-8),'Each new running atlas is 4 × 2 with its declared half-texel inset');
    const groups=new Map();for(const s of list){const v=groups.get(s.snapshotTick)||[];v.push(s);groups.set(s.snapshotTick,v);}
    const between=[...groups.values()].find(group=>new Set(group.map(s=>JSON.stringify(s.uv))).size>1&&new Set(group.map(s=>s.authoritativeDistance)).size===1);
    assert.ok(between,'Actual material UV must advance between receipt of HTTP snapshots');
    assert.ok(new Set(between.map(s=>s.visualDistance)).size>1,'The same-snapshot UV changes use projected display distance');
    return{key,character:list[0].character,frames:[...new Set(list.map(s=>s.frame))].sort(),source:list[0].source,sameSnapshot:between};
  });checks.push({check:'All four 8-frame atlases: actual UV coverage and continued rendering within one HTTP snapshot',coverage});
  await page.waitForTimeout(1000);
  const continuousRun=(await samples()).filter(s=>s.key==='p0'&&s.clip==='run');
  const frameMs=continuousRun.slice(1).map((s,i)=>s.time-continuousRun[i].time).filter(n=>n>0).sort((a,b)=>a-b);
  renderer.motionFrameTiming={samples:continuousRun.length,medianMs:frameMs[Math.floor(frameMs.length*.5)],p95Ms:frameMs[Math.floor(frameMs.length*.95)],maxMs:frameMs.at(-1)};
  await writeFile(new URL('running-samples.json',out),JSON.stringify(continuousRun,null,2));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const touchLayouts=[{width:390,locale:'en',controls:await checkControls()}];await screenshot('run-390.png');

  place('touch jump, unobstructed lane',153,2);
  await page.waitForTimeout(220);await page.evaluate(()=>window.__motionSamples=[]);
  let response=page.waitForResponse(r=>r.url().endsWith('/action'));
  await touchSwipe('up');const jumpResponse=await response;assert.equal(jumpResponse.status(),200);
  const jump=await jumpResponse.json();assert.equal(jump.event.type,'input_accepted');assert.equal(jump.event.input,'jump');
  await page.waitForFunction(()=>window.__motionSamples.some(s=>s.key==='p0'&&s.clip==='jump'&&s.visualHeight>.7));
  await screenshot('jump-390.png');
  await page.waitForFunction(()=>window.__motionSamples.some(s=>s.key==='p0'&&s.clip==='land'),{},{timeout:2500});
  await screenshot('land-390.png');
  await page.waitForFunction(()=>window.__motionSamples.some(s=>s.key==='p0'&&s.clip==='run'&&s.visualHeight===0),{},{timeout:2500});
  const jumping=(await samples()).filter(s=>s.key==='p0'&&s.clip==='jump'&&s.visualHeight>.5);
  assert.ok(jumping.length>1,'Actual jump contains multiple rendered airborne frames');
  assert.ok(jumping.every(s=>Math.abs(s.shadowWorldY)<.05&&Math.abs(s.ringWorldY)<.05),'Shadow and selection ring stay at world ground while runner rises');
  assert.ok(jumping.every(s=>Number.isFinite(s.groundShadowHeight)&&Math.abs(s.groundShadowHeight)<.05),'Reported shadow height agrees with real mesh world transform');
  const grounded=(await samples()).filter(s=>s.key==='p0'&&s.clip==='run'&&s.visualHeight===0).at(-1);
  assert.ok(jumping.some(s=>s.shadowScale<grounded.shadowScale&&s.shadowOpacity<grounded.shadowOpacity),'Airborne shadow shrinks and fades');
  assert.ok(server.state().events.some(e=>e.playerKey==='p0'&&e.type==='jump'&&e.inputNo===jump.event.inputNo));
  checks.push({check:'Real touch swipe accepted by HTTP engine, jump → land → run; actual ground shadow/ring stays grounded, shrinks and fades',accepted:jump.event,airborne:jumping,grounded});

  place('touch slide, clear lane',166,2);
  await page.waitForTimeout(200);await page.evaluate(()=>window.__motionSamples=[]);
  response=page.waitForResponse(r=>r.url().endsWith('/action'));
  await touchSwipe('down');const slideResponse=await response;assert.equal(slideResponse.status(),200);
  const slide=await slideResponse.json();assert.equal(slide.event.input,'slide');
  await page.waitForFunction(()=>window.__motionSamples.some(s=>s.key==='p0'&&s.clip==='slide'&&s.sheet==='action'));
  await screenshot('slide-390.png');
  await page.waitForFunction(()=>window.__motionSamples.some(s=>s.key==='p0'&&s.clip==='run'),{},{timeout:2500});
  assert.ok(server.state().events.some(e=>e.playerKey==='p0'&&e.type==='slide'&&e.inputNo===slide.event.inputNo));
  checks.push({check:'Real touch swipe down accepted by HTTP engine; actual action texture switches to slide and recovers',accepted:slide.event});

  for(const width of[360,430]){
    await page.setViewportSize({width,height:844});place(`viewport ${width}`,286);await page.waitForTimeout(300);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    touchLayouts.push({width,locale:'en',controls:await checkControls()});
    await screenshot(`run-${width}.png`);
  }
  const arabicContext=await browser.newContext({viewport:{width:360,height:844},hasTouch:true,isMobile:true});
  try{
    const ar=await arabicContext.newPage();ar.on('pageerror',e=>errors.push(e.message));place('Arabic 360 read-only layout',286);
    await ar.goto(server.origin+'/?locale=ar');await ar.waitForSelector('[data-models-ready="4"][data-environment-ready="true"][data-background-ready="true"]');
    assert.equal(await ar.getByTestId('run-scene').getAttribute('dir'),'rtl');
    assert.equal(await ar.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    touchLayouts.push({width:360,locale:'ar',controls:await checkControls(ar)});
    await ar.screenshot({path:new URL('run-ar-360.png',out).pathname});
  }finally{await arabicContext.close();}
  checks.push({check:'Rendered 390/360/430 and Arabic360 layouts: no overflow; five controls at least44px, distinct non-overlapping boxes and unobstructed hit centers',touchLayouts});
  await page.setViewportSize({width:390,height:844});
  place('actual second-place finish: p1 starts ahead',476,1,[0,2,-2,-4]);
  await page.evaluate(()=>window.__motionSamples=[]);
  await page.waitForSelector('[data-cinematic="finish-front"]');
  await screenshot('finish-turn-390.png');
  await page.waitForFunction(()=>Number(document.querySelector('[data-testid=run-track]').dataset.finishElapsed)>1800);
  await screenshot('finish-second-390.png');
  const finishes=(await samples()).filter(s=>s.key==='p0'&&s.sheet==='front');
  assert.equal(server.state().winnerKeys.includes('p0'),false,'The actual engine must finish another runner first');
  assert.ok(server.state().players[0].finishTick!==null);
  assert.ok(finishes.some(s=>s.clip==='finish'&&s.frame===0));
  assert.ok(finishes.some(s=>s.clip==='idle'&&s.frame===3));
  assert.ok(finishes.every(s=>s.frame===0||s.frame===3),'Non-winner never samples either front trophy pose');
  checks.push({check:'Real engine second-place finish: front camera transition, then neutral pose; no winner trophy frame',winnerKeys:server.state().winnerKeys,finishTicks:server.state().players.map(p=>({key:p.key,tick:p.finishTick})),sampledFrames:[...new Set(finishes.map(s=>s.frame))]});
  assert.deepEqual(errors,[]);
  video=await page.video().path();await context.close();context=null;
  await copyFile(video,new URL('run-v4-actions-finish.webm',out));
  const report={checkedAt:new Date().toISOString(),scope:'Isolated real HTTP server and unchanged Run engine, 150ms polling, true Chrome touch dispatch, read-only actual material/mesh observation. Explicit position fixtures, no wallet.',renderer,checks,errors,actions:server.actions,fixtures:server.fixtures,video:'run-v4-actions-finish.webm',limitations:'Desktop Chrome using the recorded WebGL renderer and mobile viewports; not a physical mobile GPU, production load, or WebView certification. High-detail characters remain animated 2.5D sprites on authoritative 3D trajectories.'};
  await writeFile(new URL('report.json',out),JSON.stringify(report,null,2));
  console.log(JSON.stringify({checks:checks.map(c=>c.check),errors,video:report.video},null,2));
}catch(e){
  await writeFile(new URL('failure.json',out),JSON.stringify({error:e.stack,errors,checks,actions:server.actions,samples:page?await samples().catch(()=>[]):[]},null,2));
  if(page)await screenshot('failure.png').catch(()=>{});throw e;
}finally{await context?.close();await browser.close();await server.close();}
