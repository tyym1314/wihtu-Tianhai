/** Desktop Chrome, real game components + local engine. Not a phone FPS test. */
import {chromium} from 'playwright';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.PRESENTATION_REVIEW_ORIGIN||'http://127.0.0.1:18112';
const out='review/presentation-clock';await mkdir(out,{recursive:true});
const source=(await readFile(new URL('../arena/shared/presentation-clock.mjs',import.meta.url),'utf8')).replace('export function createPresentationClock(','function originalCreatePresentationClock(')+`
export function createPresentationClock(options){
 const clock=originalCreatePresentationClock(options);let lastKey,lastSample=-1,index=0,lastNow=-1;
 const metrics=window.clockReview={reads:0,rewinds:0,maxStep:0,samples:[],values:[]},delays=[20,230,60,320,100];
 return {...clock,sync(serverNow,settings){
  if(settings?.key!==lastKey){lastKey=settings?.key;lastNow=-1;}
  if(serverNow!==lastSample){lastSample=serverNow;index++;}
  const delayed=serverNow-delays[index%delays.length];
  metrics.samples.push({actual:serverNow,delayed,key:settings?.key});
  return clock.sync(delayed,settings);
 },now(){const value=clock.now();metrics.reads++;if(lastNow>=0){if(value<lastNow)metrics.rewinds++;metrics.maxStep=Math.max(metrics.maxStep,value-lastNow);}lastNow=value;metrics.values.push(value);return value;}};
}
`;
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=metal']});
const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,hasTouch:true,isMobile:true}),page=await context.newPage(),report={scope:'Desktop Chrome real components with jitter injected into presentation clock samples; no wallet or physical device',checks:[],errors:[]};
page.on('pageerror',e=>report.errors.push(e.message));
await page.route('**/shared/presentation-clock.mjs*',route=>route.fulfill({status:200,contentType:'text/javascript',body:source}));
try{
 await page.goto(base+'/arena/review-preview.html?game=pool&locale=zh');await page.waitForFunction(()=>!!window.artReview&&!!window.clockReview);
 const shot=await page.evaluate(()=>window.artReview.move());assert(shot,'Pool fixture must submit real legal shot');
 await page.waitForFunction(()=>window.clockReview?.reads>50,null,{timeout:15000});
 const pool=await page.evaluate(()=>({metrics:window.clockReview,actions:window.artReview.actions(),shotId:window.artReview.room().game.shotId,phase:window.artReview.room().game.phase}));
 report.poolDiagnostic={reads:pool.metrics.reads,samples:pool.metrics.samples.length,shotId:pool.shotId,phase:pool.phase};assert.equal(pool.actions,1);assert(pool.shotId>0);assert(pool.metrics.reads>20);assert.equal(pool.metrics.rewinds,0);assert(pool.metrics.samples.some((s,i,a)=>i&&s.delayed<a[i-1].delayed),'fixture must include a backwards sample');
 report.checks.push({game:'pool',realAction:pool.actions,shotId:pool.shotId,reads:pool.metrics.reads,rewinds:pool.metrics.rewinds,sampleCount:pool.metrics.samples.length,maxObservedStepMs:pool.metrics.maxStep});
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.waitForTimeout(60);const frozen=await page.evaluate(()=>window.clockReview.values.at(-1));await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>window.clockReview.values.at(-1)),frozen);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(350);assert(await page.evaluate(()=>window.clockReview.values.at(-1))>frozen);report.checks.push('Real Pool component freezes on blur and resumes with a fresh sample');
 await page.goto(base+'/arena/golf/art-review.html?game=bowling&players=2');await page.waitForSelector('[data-bloom-size]');await page.waitForTimeout(400);
 const bloom=await page.locator('[data-bloom-size]').getAttribute('data-bloom-size');assert.equal(bloom,'64x96');
 await page.setViewportSize({width:430,height:932});await page.waitForTimeout(200);assert.equal(await page.locator('[data-bloom-size]').getAttribute('data-bloom-size'),'64x96');report.checks.push({game:'bowling',bloomApiSize:'128x192',actualBrightFramebuffer:bloom,afterResize:'64x96'});
 await page.getByTestId('bowling-roll').click();await page.waitForTimeout(1700);const bowling=await page.evaluate(()=>({reads:window.clockReview.reads,rewinds:window.clockReview.rewinds,actions:window.artReview.actions()}));assert.equal(bowling.actions,1);assert.equal(bowling.rewinds,0);report.checks.push({game:'bowling',...bowling});assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.failure={message:error.message,stack:error.stack};process.exitCode=1;}finally{await writeFile(out+'/browser.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
