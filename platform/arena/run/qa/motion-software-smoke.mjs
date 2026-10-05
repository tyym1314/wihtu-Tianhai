/** Functional fallback check only; software rendering is not an animation performance target. */
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {motionReviewServer} from './motion-review-server.mjs';
const out=new URL('motion-v4/',import.meta.url);await mkdir(out,{recursive:true});
const server=await motionReviewServer(),browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const errors=[];
try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.origin);await page.waitForSelector('[data-models-ready="4"][data-environment-ready="true"][data-background-ready="true"]');
  server.configure('Software fallback only: unobstructed lane',s=>{for(const[i,p]of s.players.entries()){
    p.distanceU=153*300+i*450;p.lane=p.fromLane=2;p.changeStartTick=p.changeEndTick=s.tick;
    p.jumpStartTick=null;p.slideUntilTick=0;p.stunUntilTick=0;p.fallStartTick=p.fallUntilTick=null;
    p.pendingInput=null;p.lastInputTick=s.tick-20;
  }});
  await page.waitForTimeout(400);await page.evaluate(()=>window.__motionSamples=[]);
  const response=page.waitForResponse(r=>r.url().endsWith('/action'));await page.getByTestId('run-jump').tap();
  const accepted=await response;assert.equal(accepted.status(),200);const action=await accepted.json();assert.equal(action.event.input,'jump');
  const player=action.room.game.players.find(p=>p.key==='p0');
  assert.ok(player.jumpStartTick!==null&&player.y>0,'The HTTP response contains the accepted airborne engine state');
  await page.waitForFunction(()=>['p0','p1','p2','p3'].every(key=>new Set(window.__motionSamples.filter(s=>s.key===key&&s.sheet==='run').map(s=>s.frame)).size>=2),{},{timeout:7000});
  const report=await page.evaluate(()=>{const gl=document.querySelector('[data-testid=run-track] canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return{renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),renderInfo:window.__rendererStats,runFrames:['p0','p1','p2','p3'].map(key=>({key,frames:[...new Set(window.__motionSamples.filter(s=>s.key===key&&s.sheet==='run').map(s=>s.frame))]})),airborne:window.__motionSamples.filter(s=>s.key==='p0'&&s.clip==='jump'&&s.visualHeight>.3)};});
  assert.ok(report.airborne.every(s=>Math.abs(s.shadowWorldY-.012)<1e-7));assert.deepEqual(errors,[]);
  await writeFile(new URL('software-smoke.json',out),JSON.stringify({checkedAt:new Date().toISOString(),scope:'SwiftShader basic compatibility only: assets, at least two actual material frames per character, touch HTTP acceptance and actual airborne engine response. Transient rendering assertions are reserved for the complete Metal run. No claim of smooth software animation.',...report,accepted:action.event,authoritativeJump:{jumpStartTick:player.jumpStartTick,y:player.y},errors},null,2));
  console.log(JSON.stringify({renderer:report.renderer,passed:true,errors},null,2));
}finally{await browser.close();await server.close();}
