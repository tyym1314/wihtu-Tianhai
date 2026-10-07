/** Component-level mobile browser evidence for the new Run start gate. */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {reviewServer} from '../arena/run/review-harness.mjs';

const launch=()=>chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const until=async(predicate,timeout=5000)=>{const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw Error('Timed out waiting for server state');await new Promise(resolve=>setTimeout(resolve,30));}};
const browser=await launch(),errors=[];
let fair,leased,broken,legacy;
try{
 fair=await reviewServer({fairStart:true});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 let releaseAssets,releaseAck;const assets=new Promise(resolve=>{releaseAssets=resolve;}),ack=new Promise(resolve=>{releaseAck=resolve;});
 await page.route('**/*.glb',async route=>{await assets;await route.continue();});
 await page.route('**/scene-ready',async route=>{await ack;await route.continue();});
 await page.goto(fair.origin+'?locale=zh',{waitUntil:'domcontentloaded'});
 await page.getByTestId('run-loading').waitFor();await page.waitForTimeout(350);
 assert.equal(fair.sceneReadyAcks.length,0);assert.equal(fair.state().tick,0);
 assert.equal(await page.getByTestId('run-jump').isDisabled(),true);
 releaseAssets();await page.waitForSelector('[data-testid=run-track][data-rendered=true]');
 await page.getByTestId('run-start-overlay').waitFor();
 assert.equal(await page.getByTestId('run-start-countdown').textContent(),'0 / 1');
 await page.waitForTimeout(1100);
 assert.equal(fair.sceneReadyAcks.length,0);assert.equal(fair.state().phase,'arming');assert.equal(fair.state().tick,0);
 assert.equal(await page.getByTestId('run-jump').isDisabled(),true);
 releaseAck();await until(()=>fair.sceneReadyAcks.length===1);await page.waitForFunction(()=>window.__readySentAfterRender===true);
 await page.waitForFunction(()=>document.querySelector('[data-testid=run-start-overlay]')?.textContent.includes('统一起跑'));
 assert.equal(fair.state().phase,'countdown');assert.equal(fair.state().tick,0);
 assert.equal(await page.getByTestId('run-jump').isDisabled(),true);
 await until(()=>fair.state().phase==='racing',6000);
 await page.waitForSelector('[data-testid=run-scene][data-input-ready=true]',{timeout:5000});
 assert.ok(fair.state().tick>0);assert.equal(fair.sceneReadyAcks.length,1);
 await context.close();

 for(const [locale,expected,dir] of [['en','Waiting for every player to load','ltr'],['ar','بانتظار جهوزية جميع اللاعبين','rtl']]){
  fair.reset();const localeContext=await browser.newContext({viewport:{width:402,height:623},isMobile:true,hasTouch:true});
  const localePage=await localeContext.newPage();localePage.on('pageerror',error=>errors.push(error.message));
  let release;const held=new Promise(resolve=>{release=resolve;});await localePage.route('**/scene-ready',async route=>{await held;await route.continue();});
  await localePage.goto(fair.origin+`?locale=${locale}`,{waitUntil:'domcontentloaded'});
  await localePage.getByTestId('run-start-overlay').waitFor();
  const label=await localePage.getByTestId('run-start-overlay').textContent(),box=await localePage.getByTestId('run-start-overlay').boundingBox();
  assert.ok(label.includes(expected),`${locale} start copy`);assert.doesNotMatch(label,/[\u3400-\u9fff]/);
  assert.equal(await localePage.getByTestId('run-scene').getAttribute('dir'),dir);
  assert.ok(box&&box.y>=0&&box.y+box.height<=623,`${locale} short-screen start overlay fits`);
  release();await localePage.waitForTimeout(200);await localeContext.close();
 }

 leased=await reviewServer({fairStart:true,waitForPeer:true});
 const leaseContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const leasePage=await leaseContext.newPage();leasePage.on('pageerror',error=>errors.push(error.message));
 await leasePage.addInitScript(()=>{window.__testHidden=false;window.__lastSceneFrameAt=0;Object.defineProperty(document,'hidden',{get:()=>window.__testHidden,configurable:true});const native=requestAnimationFrame.bind(window);window.requestAnimationFrame=callback=>native(time=>{if(/^render/.test(callback.name))window.__lastSceneFrameAt=performance.now();callback(time);});});
 await leasePage.goto(leased.origin+'?locale=en',{waitUntil:'domcontentloaded'});
 await leasePage.getByTestId('run-start-overlay').waitFor();await until(()=>leased.sceneReadyAcks.length>=2,6000);
 let timeline=await leasePage.evaluate(()=>window.__readyTimeline);
 assert.ok(timeline[0].visible&&timeline[0].lastSceneFrameAt>0,'first ACK follows a real scene frame');
 assert.ok(timeline[1].generation>timeline[0].generation,'foreground readiness refresh uses a new request generation');
 await leasePage.evaluate(()=>{window.__testHidden=true;document.dispatchEvent(new Event('visibilitychange'));});
 await leasePage.waitForTimeout(250);const hiddenAckCount=leased.sceneReadyAcks.length;
 await leasePage.waitForTimeout(2000);assert.equal(leased.sceneReadyAcks.length,hiddenAckCount,'hidden scene cannot renew ready lease');
 await leasePage.evaluate(()=>{window.__resumeAt=performance.now();window.__testHidden=false;document.dispatchEvent(new Event('visibilitychange'));});
 await until(()=>leased.sceneReadyAcks.length>hiddenAckCount,4000);
 timeline=await leasePage.evaluate(()=>({calls:window.__readyTimeline,resumeAt:window.__resumeAt}));
 const resumed=timeline.calls.at(-1);assert.ok(resumed.visible&&resumed.lastSceneFrameAt>=timeline.resumeAt&&resumed.at>=resumed.lastSceneFrameAt,'resume ACK follows the first new foreground WebGL frame');
 await leasePage.evaluate(()=>fetch('/peer-ready',{method:'POST'}));await until(()=>leased.state().phase==='countdown',3000);
 await leaseContext.close();

 broken=await reviewServer({fairStart:true});
 const brokenContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const brokenPage=await brokenContext.newPage();brokenPage.on('pageerror',error=>errors.push(error.message));
 await brokenPage.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...args){if(String(kind).startsWith('webgl'))return null;return original.call(this,kind,...args);};});
 await brokenPage.goto(broken.origin,{waitUntil:'domcontentloaded'});
 await brokenPage.getByTestId('run-retry').waitFor({timeout:10000});
 assert.equal(broken.sceneReadyAcks.length,0);assert.equal(broken.state().tick,0);
 await brokenContext.close();

 legacy=await reviewServer();
 const oldContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const oldPage=await oldContext.newPage();oldPage.on('pageerror',error=>errors.push(error.message));
 await oldPage.goto(legacy.origin,{waitUntil:'domcontentloaded'});
 await oldPage.waitForSelector('[data-testid=run-track][data-rendered=true]');
 assert.equal(legacy.state().ruleVersion,'pvp-run-v2.0.0');assert.equal(legacy.sceneReadyAcks.length,0);
 assert.equal(await oldPage.getByTestId('run-start-overlay').count(),0);
 await oldContext.close();
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({scope:'Isolated Chrome mobile emulation, actual RunGame/WebGL component and in-process authoritative engine; not physical-device or public-host acceptance',checks:['delayed assets cannot ACK','rendered first frame precedes ACK','held ACK keeps tick zero and controls locked','one server ACK starts visible countdown','countdown keeps tick zero and controls locked','foreground ready lease refreshes with new generation','hidden scene stops readiness refresh','resume ACK follows a newly rendered WebGL frame','English/Arabic short-screen start copy has no Chinese and fits RTL','WebGL failure cannot ACK','historical v2.0 room has no new gate'],pageErrors:errors},null,2));
}finally{await browser.close();await Promise.all([fair?.close(),leased?.close(),broken?.close(),legacy?.close()].filter(Boolean));}
