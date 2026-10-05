/** Fixed-viewport gallery media capture, not a rerun of the complete QA suite. */
import {chromium} from 'playwright';
import {copyFile,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {motionReviewServer} from './motion-review-server.mjs';

const out=new URL('motion-v4/',import.meta.url);await mkdir(out,{recursive:true});
const server=await motionReviewServer(),browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-webgl','--use-angle=metal']});
let context;const errors=[];
function place(name,distance,offsets=[0,1.5,3,4.5]){
  server.configure(name,s=>{for(const[i,p]of s.players.entries()){
    p.distanceU=Math.round((distance+offsets[i])*300);p.checkpointU=Math.floor(p.distanceU/9000)*9000;
    p.lane=p.fromLane=i===0?1:i===1?0:2;p.changeStartTick=p.changeEndTick=s.tick;
    p.jumpStartTick=null;p.slideUntilTick=0;p.stunUntilTick=0;p.fallStartTick=p.fallUntilTick=null;
    p.immuneUntilTick=0;p.pendingInput=null;p.lastInputTick=s.tick-20;p.resolvedObstacles=[];
  }});
}
try{
  context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,recordVideo:{dir:new URL('gallery-raw/',out).pathname,size:{width:390,height:844}}});
  const page=await context.newPage(),started=Date.now();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.origin);await page.waitForSelector('[data-models-ready="4"][data-environment-ready="true"][data-background-ready="true"]');
  const renderer=await page.evaluate(()=>{const g=document.querySelector('[data-testid=run-track] canvas').getContext('webgl2'),ext=g.getExtension('WEBGL_debug_renderer_info');return ext?g.getParameter(ext.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER)});
  place('Gallery: visible running on legal unobstructed center lane',286);
  await page.waitForTimeout(1300);
  async function swipe(direction){
    const response=page.waitForResponse(r=>r.url().endsWith('/action')),cdp=await context.newCDPSession(page);
    const x=240,y=445,dy=direction==='up'?-96:96;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
    for(let step=1;step<=4;step++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+dy*step/4,id:1}]});await page.waitForTimeout(15);}
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
    const result=await response;assert.equal(result.status(),200);const body=await result.json();assert.equal(body.event.input,direction==='up'?'jump':'slide');
  }
  await swipe('up');await page.waitForTimeout(1050);
  await swipe('down');await page.waitForTimeout(850);
  place('Gallery: explicit near-finish fixture, p1 ahead; engine resolves actual second-place p0 finish',476,[0,2,-2,-4]);
  await page.waitForSelector('[data-cinematic="finish-front"]');
  await page.waitForFunction(()=>Number(document.querySelector('[data-testid=run-track]').dataset.finishElapsed)>1800);
  assert.equal(server.state().winnerKeys.includes('p0'),false);assert.ok(server.state().players[0].finishTick!==null);
  assert.equal(page.viewportSize().width,390);assert.equal(page.viewportSize().height,844);assert.deepEqual(errors,[]);
  await page.waitForTimeout(Math.max(0,9500-(Date.now()-started)));
  const video=await page.video().path();await context.close();context=null;
  await copyFile(video,new URL('run-v4-gallery-390.webm',out));
  await writeFile(new URL('gallery-390.json',out),JSON.stringify({capturedAt:new Date().toISOString(),viewport:{width:390,height:844},videoSize:{width:390,height:844},renderer,scope:'Fixed 390×844 throughout; newly rendered recording, not cropped or resized from the multi-viewport QA video. Isolated actual HTTP engine and touch input. Explicit legal position fixtures. No wallet. Capture verification only, not a repeated full QA suite.',actions:server.actions,fixtures:server.fixtures,winnerKeys:server.state().winnerKeys,errors,video:'run-v4-gallery-390.webm'},null,2));
  console.log(JSON.stringify({video:'run-v4-gallery-390.webm',viewport:page.viewportSize(),renderer,errors},null,2));
}finally{await context?.close();await browser.close();await server.close();}
