import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const out='review/visual-restoration';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=metal']}),report={source:'isolated local engine fixtures, no wallet requests',shots:[],errors:[],events:[]};
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('favicon.ico'))report.errors.push(r.status()+' '+r.url());});page.on('request',r=>{assert(!r.url().includes('/api/')&&!r.url().includes('/v1/'),'Unexpected backend request');});
const base='http://127.0.0.1:18112/arena/review-preview.html';
// Polling fixtures are never network-idle; await mounted UI and fonts instead.
try {
for(const width of [390,360,430]){
 await page.setViewportSize({width,height:width===390?844:width===360?800:932});
 for(const game of ['match','golf','carrom','darts','ludo','jackaroo','domino','pool','bowling','run']){
  await page.goto(base+'?game='+game,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!window.artReview);await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(500);if(game==='run'){await page.waitForTimeout(1600);report.renderer=await page.locator('[data-testid=run-track] canvas').evaluate(el=>{const gl=el.getContext('webgl2'),ext=gl?.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'unavailable'});}
  const bounds=await page.evaluate(()=>({width:innerWidth,docWidth:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}));assert(bounds.docWidth<=width,'overflow '+game+' '+width);
  const file=`${game}-restored-${width}.png`;await page.screenshot({path:out+'/'+file,fullPage:true});report.shots.push({game,width,mode:'play',file,bounds});
  if(width===390){await page.goto(base+'?game='+game+'&mode=result',{waitUntil:'domcontentloaded'});await page.locator('.theme-result').waitFor();await page.waitForTimeout(800);if(game==='run')await page.waitForFunction(()=>document.querySelector('.run-podium')?.dataset.modelsReady==='4');const rb=await page.evaluate(()=>({width:innerWidth,docWidth:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}));assert(rb.docWidth<=width,'result overflow '+game);const file=`${game}-result-restored-${width}.png`;await page.screenshot({path:out+'/'+file,fullPage:true});report.shots.push({game,width,mode:'result',file});}
 }
}
await page.setViewportSize({width:390,height:844});await page.goto(base+'?game=match',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!window.artReview);await page.evaluate(()=>window.artReview.fixture('combo'));
await page.locator('[data-cell="14"]').click();await page.locator('[data-cell="15"]').click();await page.waitForTimeout(190);await page.screenshot({path:out+'/match-moment-restored-390.png',fullPage:true});
assert(await page.locator('.match-fox-cheer').count(),'No actual event cheer');assert(await page.locator('.match-hero-shards').count(),'No actual event shards');await page.waitForTimeout(1600);
const played=await page.evaluate(()=>({actions:window.artReview.actions(),score:window.artReview.room().game.score,sounds:window.artReview.sounds}));assert.equal(played.actions,1);assert(played.score>0);report.events.push({match:played});
// Presentation must keep the same mounted board while the authoritative status is settled.
await page.evaluate(()=>{document.querySelector('.match-board').dataset.mountProof='retained';window.artReview.finish();});await page.waitForTimeout(150);assert.equal(await page.locator('.match-board').getAttribute('data-mount-proof'),'retained');assert(await page.locator('.match-cell:disabled').count()===36);await page.waitForTimeout(1250);assert.equal(await page.locator('.theme-result').count(),1);report.events.push({finalActionRetained:true,controlsLocked:true,resultRevealed:true});
await page.emulateMedia({reducedMotion:'reduce'});await page.goto(base+'?game=match',{waitUntil:'domcontentloaded'});const motion=await page.locator('.match-fox-actor').evaluate(e=>getComputedStyle(e).animationName);assert.equal(motion,'none');report.events.push({reducedMotion:motion});
await writeFile(out+'/restoration-ui.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.equal(report.errors.length,0,'Browser errors');
} catch(error) { report.failure={message:error.message,stack:error.stack};await writeFile(out+'/restoration-ui.json',JSON.stringify(report,null,2));throw error; } finally { await browser.close(); }
