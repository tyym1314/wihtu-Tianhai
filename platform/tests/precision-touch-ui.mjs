import {beginUiEvidence} from './ui-evidence-run.mjs';
/** Trusted Chrome touch and desktop WebKit pointer regression of current UIs. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
import {precisionTouchServer} from '../arena/darts/qa/precision-touch-server.mjs';

const evidence=await beginUiEvidence({"suite": "precision", "games": ["darts", "pool", "carrom"], "scope": "Isolated current UI + actual HTTP game engine. Native Chrome touch and desktop WebKit pointer; not physical iPhone Safari acceptance. Actions count every attempted HTTP request before engine validation."});
let server;const reports={darts:[],pool:[],carrom:[]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 server=evidence.server(await precisionTouchServer(),'precision');
 for(const engine of ['chromium','webkit']){
  const browser=evidence.browser(engine==='chromium'?await chromium.launch({channel:'chrome',headless:true}):await webkit.launch({headless:true}),engine);
  const context=evidence.context(await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}));
  await context.addInitScript(()=>{window.__touchEvents=[];for(const type of ['pointerdown','pointerup','pointercancel','lostpointercapture'])document.addEventListener(type,e=>{if(type==='pointerdown'&&e.isPrimary){window.__activeId=e.pointerId;window.__activeTarget=e.target;}window.__touchEvents.push({type,id:e.pointerId,primary:e.isPrimary,trusted:e.isTrusted,pointer:e.pointerType});},true);});
  const page=evidence.page(await context.newPage(),engine),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const cdp=engine==='chromium'?await context.newCDPSession(page):null;
  const method=cdp?'Chrome CDP Input.dispatchTouchEvent: browser-trusted native touch':'Desktop WebKit Playwright mouse: browser-trusted native pointer; not iPhone touch';
  const start=async at=>{if(cdp)await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...at,id:1}]});else{await page.mouse.move(at.x,at.y);await page.mouse.down();}};
  const move=async at=>{if(cdp)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...at,id:1}]});else await page.mouse.move(at.x,at.y);};
  const end=async()=>{if(cdp)await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});else await page.mouse.up();};
  const tap=async at=>{await start(at);await end();};
  async function loseCapture(){await page.evaluate(()=>{let target=window.__activeTarget;while(target&&!target.hasPointerCapture(window.__activeId))target=target.parentElement;if(!target)throw Error('Capture owner missing');target.releasePointerCapture(window.__activeId);});await delay(25);}
  async function cancel(){if(cdp)await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});else{await loseCapture();await end();}}
  async function secondFinger(at){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...at,id:1},{x:at.x+40,y:at.y,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:at.x-35,y:at.y-20,id:1},{x:at.x+65,y:at.y-40,id:2}]});}
  async function drag(at){await start({x:at.x,y:at.y+30});for(let i=1;i<=6;i++){await delay(60);await move({x:at.x,y:at.y+30-i*5});}await end();}
  async function unchanged(fn,label){const count=server.actions.length;await fn();await delay(160);assert.equal(server.actions.length,count,label+' must send no HTTP action');}
  async function center(selector){const locator=page.locator(selector);await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();return{x:box.x+box.width/2,y:box.y+box.height/2,box};}
  async function open(game,mode){evidence.stage({game,engine});server.reset(game,mode);await page.goto(server.origin+'/?game='+game);const selector={darts:'.da-board',pool:'[data-testid="pool-board"]',carrom:'[data-testid="carrom-board"]'}[game];await page.locator(selector).waitFor();await delay(150);assert.equal(await page.locator(selector).evaluate(el=>getComputedStyle(el).touchAction),'none');return center(selector);}
  async function record(game,checks){assert.deepEqual(errors,[]);const events=await page.evaluate(()=>window.__touchEvents);assert.ok(events.some(e=>e.trusted&&e.pointer===(cdp?'touch':'mouse')));reports[game].push({engine,method,checks,events,errors:[...errors]});const dir=evidence.path(game);await mkdir(dir,{recursive:true});await page.screenshot({path:new URL(engine+'.png',dir).pathname});}
  try{
   const checks=[];let at=await open('darts'),count=server.actions.length;
   await page.evaluate(()=>{window.__dartMotion=[];const until=performance.now()+2200;requestAnimationFrame(function sample(t){const dart=document.querySelector('[data-testid="darts-flight"]');if(dart)window.__dartMotion.push({at:t,x:Number(dart.dataset.tipX),y:Number(dart.dataset.tipY)});if(t<until)requestAnimationFrame(sample);});});
   const response=page.waitForResponse(r=>r.url().includes('/action?game=darts'));await drag(at);const result=await(await response).json();assert.ok(result.event?.hit);assert.equal(server.actions.length,count+1);assert.equal(server.state('darts').currentDarts.length,1);checks.push('Legal 6-move drag sends one HTTP throw; real Darts engine accepts it');await delay(760);
   const motion=await page.evaluate(()=>window.__dartMotion),positions=new Set(motion.map(p=>p.x.toFixed(5)+':'+p.y.toFixed(5)));assert.ok(positions.size>=12,'flight has at least 12 actual moving positions, not a 50ms parent-timer animation: '+positions.size);const diffs=motion.slice(1).map((p,i)=>({dt:p.at-motion[i].at,moved:Math.abs(p.y-motion[i].y)>1e-6||Math.abs(p.x-motion[i].x)>1e-6}));assert.ok(diffs.filter(d=>d.moved).length/diffs.length>.65,'rendered dart changes position on most animation frames');checks.push('Actual flight SVG tip updates independently of the 50ms HUD timer: '+positions.size+' distinct sampled positions');await mkdir(evidence.path('darts','motion/'),{recursive:true});await writeFile(evidence.path('darts','motion/'+engine+'.json'),JSON.stringify({motion,distinct_positions:positions.size,move_ratio:diffs.filter(d=>d.moved).length/diffs.length,scope:'Actual accepted HTTP throw; desktop engine, not physical iPhone'},null,2));

   await unchanged(async()=>{await start(at);await move({x:at.x,y:at.y-30});await cancel();},'darts cancellation');checks.push(cdp?'Native touchCancel never throws':'Capture loss never throws');
   await unchanged(async()=>{await start(at);await delay(100);await move({x:at.x,y:at.y-25});await loseCapture();await move({x:at.x,y:at.y-35});await end();},'darts lost capture');checks.push('Explicit capture release discards the drag before pointerup');
   await unchanged(()=>tap(at),'darts short tap');checks.push('Short tap is not a throw');
   if(cdp){await unchanged(async()=>{await start(at);await secondFinger(at);await delay(100);await end();},'darts two fingers');checks.push('Secondary touch cancels current throw; neither pointer can submit it');}
   await unchanged(async()=>{await start(at);await delay(100);await move({x:at.x,y:at.y-20});server.configure('darts',s=>{s.turnStartedAt=Date.now();s.turnDeadlineAt=Date.now()+20000;});await delay(220);await move({x:at.x,y:at.y-40});await end();},'darts changed turn');checks.push('A new server turn invalidates an in-progress throw even for the same player');
   await unchanged(async()=>{await start(at);await move({x:at.x,y:at.y-15});await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await delay(100);await move({x:at.x,y:at.y-30});await end();},'darts blur');checks.push('Window blur cancels the gesture');
   count=server.actions.length;await drag(at);await delay(120);assert.equal(server.actions.length,count+1);checks.push('Fresh legal throw after all cancellations still works once');await record('darts',checks);

   const poolChecks=[];at=await open('pool','free');
   const place={x:at.x-30,y:at.y+60};
   await unchanged(async()=>{await start(place);await move({x:place.x+20,y:place.y});await cancel();},'pool free ball cancellation');assert.equal(server.state('pool').cuePlaced,false);poolChecks.push('Canceled free-ball placement sends zero HTTP requests and cue remains unplaced');
   await unchanged(async()=>{await start(place);await move({x:place.x+20,y:place.y});await loseCapture();await end();},'pool free ball lost capture');poolChecks.push('Lost capture never places a cue ball');
   if(cdp){await unchanged(async()=>{await start(place);await secondFinger(place);await end();},'pool free ball two fingers');poolChecks.push('Two-finger placement cannot commit from either pointer');}
   await unchanged(async()=>{await start(place);await move({x:place.x+20,y:place.y});server.configure('pool',s=>{s.turnStartedAt=Date.now();s.turnDeadlineAt=Date.now()+20000;});await delay(220);await end();},'pool changed turn');poolChecks.push('Placement started in a previous server turn is discarded');
   count=server.actions.length;let request=page.waitForResponse(r=>r.url().includes('/action?game=pool'));await tap(place);let placed=await(await request).json();assert.equal(placed.room.game.cuePlaced,true);assert.equal(server.actions.length,count+1);assert.equal(server.actions.at(-1).action.type,'place');poolChecks.push('Next intentional tap sends one place action accepted by the Pool engine');
   at=await open('pool','eight');const pocket={x:at.box.x+(3.3+4.05)/8.1*at.box.width,y:at.y};
   await unchanged(async()=>{await start(pocket);await cancel();},'pool canceled pocket');assert.equal(server.state('pool').calledPocket,null);poolChecks.push('Pocket call waits for a valid release; canceled or lost-capture gesture never calls a pocket');
   count=server.actions.length;request=page.waitForResponse(r=>r.url().includes('/action?game=pool'));await tap(pocket);const called=await(await request).json();assert.equal(called.room.game.calledPocket,2);assert.equal(server.actions.length,count+1);poolChecks.push('Intentional pocket tap calls exactly one pocket through the real engine');
   const spin=await center('[data-testid="pool-spin"]');await start(spin);await move({x:spin.x+9,y:spin.y-5});await delay(40);const marker=()=>page.locator('[data-testid="pool-spin"] i').getAttribute('style');
   if(cdp){await secondFinger(spin);const held=await marker();await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:spin.x-10,y:spin.y+12,id:1},{x:spin.x+35,y:spin.y-18,id:2}]});await delay(50);assert.equal(await marker(),held);await end();poolChecks.push('Spin control cancels on second finger; neither finger keeps moving its marker');}else{await loseCapture();const held=await marker();await move({x:spin.x-10,y:spin.y+12});await delay(50);assert.equal(await marker(),held);await end();poolChecks.push('Spin control stops changing when capture is lost');}
   await record('pool',poolChecks);

   const carromChecks=[];at=await open('carrom');const aim={x:at.x,y:at.y-55};const updates=()=>page.evaluate(()=>window.__aimUpdates?.length||0);
   let before=await updates();await start(aim);await move({x:aim.x+35,y:aim.y+12});await delay(30);assert.ok(await updates()>before);carromChecks.push('Primary drag changes the live Carrom aim');
   if(cdp){await secondFinger(aim);before=await updates();await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:aim.x-55,y:aim.y+20,id:1},{x:aim.x+75,y:aim.y-15,id:2}]});await delay(50);assert.equal(await updates(),before);await end();carromChecks.push('Second finger cancels aiming; subsequent moves from both fingers produce zero angle updates');}else{await loseCapture();before=await updates();await move({x:aim.x-35,y:aim.y+20});await end();assert.equal(await updates(),before);carromChecks.push('Lost capture stops Carrom aim updates');}
   await start(aim);await cancel();before=await updates();await page.mouse.move(aim.x+55,aim.y+15);assert.equal(await updates(),before);carromChecks.push('Canceled drag does not leave sticky aiming');
   await start(aim);server.configure('carrom',s=>{s.phase='fault';});await delay(200);before=await updates();server.configure('carrom',s=>{s.phase='aiming';});await delay(200);await move({x:aim.x-50,y:aim.y+15});await end();assert.equal(await updates(),before);carromChecks.push('Transient non-aiming state cancels the old drag permanently');
   before=await updates();await tap(aim);assert.ok(await updates()>before);carromChecks.push('Fresh tap can aim after cancellation');
   await page.getByRole('button',{name:'玩法规则',exact:true}).click();assert.equal(await page.getByTestId('carrom-shoot').isDisabled(),true);await page.getByRole('button',{name:'开始挑战',exact:true}).click();assert.equal(await page.getByTestId('carrom-shoot').isEnabled(),true);carromChecks.push('Help modal disables shooting and restores input when closed');
   assert.equal(server.actions.filter(a=>a.game==='carrom').length,0);carromChecks.push('Aim-only gestures never submit a shot');await record('carrom',carromChecks);
  }catch(error){await evidence.failureScreenshot(page,engine);throw error;}finally{await evidence.closeBrowser(browser,context);}
 }
 console.log(JSON.stringify(Object.fromEntries(Object.entries(reports).map(([game,samples])=>[game,samples.map(({engine,checks,errors})=>({engine,checks,errors}))])),null,2));
}catch(error){evidence.fail(error);}finally{await evidence.closeServers();await evidence.finish(reports);}
