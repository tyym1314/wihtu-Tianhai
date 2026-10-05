import {beginUiEvidence} from './ui-evidence-run.mjs';
/** Chrome native touch + WebKit native pointer actions against isolated real engines. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
import {matchTouchServer} from '../arena/match/qa/touch-review-server.mjs';
import {reviewServer} from '../arena/run/review-harness.mjs';

const evidence=await beginUiEvidence({"suite": "swipe", "games": ["match", "run"], "scope": "Isolated real HTTP engines and current UI. Chrome trusted touch and desktop WebKit trusted pointer. Explicit legal positions for Run. Every attempted HTTP action is counted before engine validation. No platform wallet, public deployment or physical phone acceptance."});
let match,run;
const reports={match:[],run:[]};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const target=async(page,selector)=>{const box=await page.locator(selector).boundingBox();assert.ok(box,selector);return{x:box.x+box.width/2,y:box.y+box.height/2};};
async function idleMatch(page){await page.waitForFunction(()=>document.querySelector('.match-board')?.classList.contains('match-phase-idle')&&!document.querySelector('[data-cell="0"]').disabled);}
function setupRun(lane=1,extras={}){run.configure(state=>{for(const p of state.players){Object.assign(p,{distanceU:0,checkpointU:0,lane,fromLane:lane,changeStartTick:state.tick,changeEndTick:state.tick,jumpStartTick:null,slideUntilTick:0,stunUntilTick:0,fallStartTick:null,fallUntilTick:null,pendingInput:null,lastInputTick:state.tick-20,finishTick:null,forfeited:false,inventory:null,...extras});}});}
try{
 match=evidence.server(await matchTouchServer(),'match');run=evidence.server(await reviewServer(),'run');
 for(const engine of ['chromium','webkit']){
  const browser=evidence.browser(engine==='chromium'?await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=metal']}):await webkit.launch({headless:true}),engine);
  const context=evidence.context(await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}));
  await context.addInitScript(()=>{window.__gestureEvents=[];for(const type of ['pointerdown','pointerup','pointercancel','lostpointercapture','click'])document.addEventListener(type,event=>{if(type==='pointerdown'){window.__activePointerId=event.pointerId;window.__activePointerTarget=event.target;}if(window.__gestureEvents.length<500)window.__gestureEvents.push({type,pointerType:event.pointerType,pointerId:event.pointerId,isPrimary:event.isPrimary,trusted:event.isTrusted,detail:event.detail,cell:event.target?.dataset?.cell});},true);});
  const page=evidence.page(await context.newPage(),engine),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const cdp=engine==='chromium'?await context.newCDPSession(page):null;
  async function start(at){if(cdp)await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...at,id:1}]});else{await page.mouse.move(at.x,at.y);await page.mouse.down();}}
  async function move(at){if(cdp)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...at,id:1}]});else await page.mouse.move(at.x,at.y);}
  async function end(){if(cdp)await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});else await page.mouse.up();}
  async function swipe(from,to){await start(from);for(let i=1;i<=4;i++){await move({x:from.x+(to.x-from.x)*i/4,y:from.y+(to.y-from.y)*i/4});await delay(18);}await end();}
  async function tap(at){await start(at);await end();}
  async function loseCapture(){await page.evaluate(()=>{let target=window.__activePointerTarget;while(target&&!target.hasPointerCapture(window.__activePointerId))target=target.parentElement;if(!target)throw Error('Missing actual capture owner');target.releasePointerCapture(window.__activePointerId);});}
  async function cancel(from,to){await start(from);await move(to);if(cdp)await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});else{await page.evaluate(()=>{let target=window.__activePointerTarget;while(target&&!target.hasPointerCapture(window.__activePointerId))target=target.parentElement;if(!target)throw Error('Missing actual capture owner');target.releasePointerCapture(window.__activePointerId);});await end();}}
  async function unchanged(server,fn,label){const count=server.actions.length,scroll=await page.evaluate(()=>scrollY);await fn();await delay(220);assert.equal(server.actions.length,count,label);assert.equal(await page.evaluate(()=>scrollY),scroll,label+' must not scroll the page');}
  const method=cdp?'Chrome Input.dispatchTouchEvent (trusted native touch)':'Desktop WebKit Playwright mouse (trusted native pointer; not iPhone touch)';
  try{
   const checks=[];evidence.stage({game:'match',engine,checks});await page.goto(match.origin);await idleMatch(page);
   assert.equal(await page.locator('.match-board').evaluate(el=>getComputedStyle(el).touchAction),'none');
   let legal=match.legal()[0],from=await target(page,`[data-cell="${legal.from}"]`),to=await target(page,`[data-cell="${legal.to}"]`);
   let count=match.actions.length,response=page.waitForResponse(r=>r.url()===match.origin+'/action');
   await swipe(from,to);let result=await(await response).json();assert.equal(result.event.valid,true);await idleMatch(page);assert.equal(match.actions.length,count+1);
   assert.equal(await page.locator('.match-cell-selected').count(),0);checks.push('Legal finger/pointer swipe is exactly one real HTTP swap with valid engine result; its compatibility click does not select or swap again');
   for(const [name,dx,dy] of [['short-drag',10,0],['diagonal',27,26],['out-and-back',0,0]]){
    legal=match.legal()[0];from=await target(page,`[data-cell="${legal.from}"]`);to=await target(page,`[data-cell="${legal.to}"]`);await tap(from);
    assert.equal(await page.locator(`[data-cell="${legal.from}"]`).getAttribute('aria-pressed'),'true');
    await unchanged(match,async()=>{if(name==='out-and-back'){await start(to);await move({x:to.x+40,y:to.y});await move(to);await end();}else await swipe(to,{x:to.x+dx,y:to.y+dy});},name);
    assert.equal(await page.locator('.match-cell-selected').count(),0);checks.push(name+' does not accidentally activate the selected adjacent pair');
   }
   from=await target(page,'[data-cell="14"]');await unchanged(match,()=>cancel(from,{x:from.x+45,y:from.y}),'cancel');checks.push(cdp?'Native touchCancel never swaps':'Real lostpointercapture never swaps');
   if(cdp){await unchanged(match,async()=>{await start(from);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...from,id:1},{x:from.x+45,y:from.y,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x+50,y:from.y,id:1},{x:from.x+60,y:from.y,id:2}]});await end();},'two fingers');checks.push('Two actual touch pointers cannot overwrite or complete one another');}
   legal=match.legal()[0];from=await target(page,`[data-cell="${legal.from}"]`);to=await target(page,`[data-cell="${legal.to}"]`);count=match.actions.length;response=page.waitForResponse(r=>r.url()===match.origin+'/action');await tap(from);await tap(to);result=await(await response).json();assert.equal(result.event.valid,true);await idleMatch(page);assert.equal(match.actions.length,count+1);checks.push('Two intentional taps remain a working auxiliary input after canceled drags');
   await page.getByRole('button',{name:'玩法说明',exact:true}).click();await unchanged(match,()=>swipe(from,to),'help overlay');await page.getByRole('button',{name:'知道了',exact:true}).last().click();checks.push('Open help prevents board input');
   legal=match.legal()[0];from=await target(page,`[data-cell="${legal.from}"]`);to=await target(page,`[data-cell="${legal.to}"]`);await unchanged(match,async()=>{await start(from);await loseCapture();await move(to);await end();},'pending capture release match');checks.push('Capture released before its first move cannot turn the later pointerup into a swap');
   if(cdp){await unchanged(match,async()=>{await start(from);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...from,id:1},{x:5,y:5,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...to,id:1},{x:5,y:5,id:2}]});await end();},'second touch outside board');checks.push('Second finger outside the board cancels the active swipe');}
   const matchEvents=await page.evaluate(()=>window.__gestureEvents);assert.deepEqual(errors,[]);reports.match.push({engine,method,checks,events:matchEvents,errors:[...errors]});
   await mkdir(evidence.path('match'),{recursive:true});await page.screenshot({path:evidence.path('match',`${engine}.png`).pathname});

   const runChecks=[];evidence.stage({game:'run',engine,checks:runChecks});let releaseAssets;const hold=new Promise(resolve=>{releaseAssets=resolve;});await page.route('**/*.glb',async route=>{await hold;await route.continue();});
   await page.goto(run.origin+'?locale=zh',{waitUntil:'domcontentloaded'});await page.getByTestId('run-loading').waitFor();
   const track={x:195,y:405};await unchanged(run,()=>swipe(track,{x:track.x-70,y:track.y}),'loading run swipe');releaseAssets();
   await page.waitForSelector('[data-testid="run-scene"][data-input-ready="true"]');runChecks.push('Swipe begun during cold asset/GPU loading never queues a later input');
   for(const [dx,dy,input] of [[-75,0,'left'],[75,0,'right'],[0,-80,'jump'],[0,80,'slide']]){
    setupRun();await delay(260);await page.waitForSelector('[data-testid="run-scene"][data-input-ready="true"]');count=run.actions.length;response=page.waitForResponse(r=>r.url()===run.origin+'/action');await swipe(track,{x:track.x+dx,y:track.y+dy});result=await(await response).json();assert.equal(result.event.input,input);await delay(180);assert.equal(run.actions.length,count+1);runChecks.push('Real '+input+' swipe accepted once by HTTP engine');
   }
   setupRun();await delay(260);
   for(const [name,dx,dy] of [['short',15,0],['diagonal',65,64]])await unchanged(run,()=>swipe(track,{x:track.x+dx,y:track.y+dy}),name+' run');
   await unchanged(run,()=>cancel(track,{x:track.x-70,y:track.y}),'cancel run');runChecks.push('Short, diagonal and canceled/lost-capture swipes never send a run action');
   if(cdp){await unchanged(run,async()=>{await start(track);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...track,id:1},{x:track.x+45,y:track.y,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:track.x-65,y:track.y,id:1},{x:track.x+20,y:track.y,id:2}]});await end();},'two-finger run');runChecks.push('Two-finger run gesture is discarded');}
   setupRun(0);await delay(260);await unchanged(run,()=>swipe(track,{x:track.x-70,y:track.y}),'track edge');
   setupRun(1,{fallUntilTick:run.state().tick+300,fallStartTick:run.state().tick});await delay(260);await unchanged(run,()=>swipe(track,{x:track.x,y:track.y-80}),'falling runner');runChecks.push('Lane edge and confirmed fall block swipe dispatch locally');
   setupRun();await delay(260);count=run.actions.length;response=page.waitForResponse(r=>r.url()===run.origin+'/action');await page.getByTestId('run-jump').tap();result=await(await response).json();assert.equal(result.event.input,'jump');assert.equal(run.actions.length,count+1);runChecks.push('Auxiliary touch jump button still works');
   setupRun();await delay(260);await unchanged(run,async()=>{await start(track);await loseCapture();await move({x:track.x-70,y:track.y});await end();},'pending capture release run');runChecks.push('Pending capture released before first move never queues a run action');
   if(cdp){await unchanged(run,async()=>{await start(track);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...track,id:1},{x:5,y:5,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:track.x-70,y:track.y,id:1},{x:5,y:5,id:2}]});await end();},'second touch outside track');runChecks.push('Second finger outside the track cancels the active swipe');}
   assert.deepEqual(errors,[]);reports.run.push({engine,method,checks:runChecks,events:await page.evaluate(()=>window.__gestureEvents),errors:[...errors]});
   await mkdir(evidence.path('run'),{recursive:true});await page.screenshot({path:evidence.path('run',`${engine}.png`).pathname});
  }catch(error){await evidence.failureScreenshot(page,engine);throw error;}finally{await evidence.closeBrowser(browser,context);}
 }
 console.log(JSON.stringify(Object.fromEntries(Object.entries(reports).map(([game,list])=>[game,list.map(({engine,checks,errors})=>({engine,checks,errors}))])),null,2));
}catch(error){evidence.fail(error);}finally{await evidence.closeServers();await evidence.finish(reports);}
