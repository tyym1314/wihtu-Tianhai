import {chromium} from '../../../node_modules/playwright/index.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=new URL('../../../',import.meta.url),reports=[];
const browser=await chromium.launch({channel:'chrome',headless:true});
async function touchDrag(page,points,delay=45){const cdp=await page.context().newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...points[0],id:1,radiusX:3,radiusY:3}]});for(const p of points.slice(1)){await page.waitForTimeout(delay);await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...p,id:1,radiusX:3,radiusY:3}]});}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}
try{
 for(const [game,port] of [['carrom',18107],['darts',18111]])for(const width of [390,360,430]){
  const height=width===360?800:width===430?932:844,dir=new URL(`arena/${game}/review-v4/`,root);await mkdir(new URL('videos/',dir),{recursive:true});
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,isMobile:true,hasTouch:true,...(width===390?{recordVideo:{dir:new URL('videos/',dir).pathname,size:{width,height}}}:{})}),page=await context.newPage(),errors=[],badAssets=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)badAssets.push({status:r.status(),url:r.url()});});
  page.on('request',r=>assert(!new URL(r.url()).pathname.startsWith('/api/'),'Local visual QA must not contact platform APIs'));
  await page.route('**/arena/assets/restoration/*',async route=>{const name=new URL(route.request().url()).pathname.split('/').at(-1);assert(/^[a-zA-Z0-9_-]+\.(png|webp)$/.test(name));await route.fulfill({body:await readFile(new URL('arena/public/assets/restoration/'+name,root)),contentType:name.endsWith('.webp')?'image/webp':'image/png'});});
  await page.goto(`http://127.0.0.1:${port}/preview.html`);await page.waitForTimeout(750);
  await page.evaluate(async()=>{const urls=new Set([...document.querySelectorAll('*')].flatMap(n=>[...(getComputedStyle(n).backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g))].map(m=>m[1])));for(const n of document.querySelectorAll('img,svg image')){const u=n.src||n.getAttribute('href');if(u)urls.add(u);}await Promise.all([...urls].map(async u=>{const im=new Image();im.src=u;await im.decode();}));});
  const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}));assert.equal(layout.scrollWidth,width);assert(layout.scrollHeight<=height);
  await page.screenshot({path:new URL(`${game}-after-${width}.png`,dir).pathname,fullPage:true});let evidence;
  if(game==='darts'){
   const held=page.getByTestId('darts-ready-dart'),heldBox=await held.boundingBox();assert(heldBox.width>140&&heldBox.height>130);assert.equal(await held.evaluate(n=>n.naturalWidth),720);
   const box=await page.locator('.da-board').boundingBox(),x=box.x+box.width*.62,y=box.y+box.height*.34;
   await touchDrag(page,Array.from({length:8},(_,i)=>({x,y:y+32-i*32/7})),54);await page.waitForFunction(()=>window.review.actions.length===1);
   const event=await page.evaluate(()=>window.review.actions[0].event);assert(Math.abs(event.hit.x)>.2);assert(event.hit.y<-.2);assert.equal(event.busyUntil-event.at,650);
   const flight=page.getByTestId('darts-flight');await flight.waitFor();assert.equal(Number(await flight.getAttribute('data-hit-x')),event.hit.x);assert.equal(Number(await flight.getAttribute('data-hit-y')),event.hit.y);
   await page.waitForFunction(()=>getComputedStyle(document.querySelector('.da-held-stage')).opacity==='0');assert.equal(await held.evaluate(n=>getComputedStyle(n.parentElement).opacity),'0');
   await page.screenshot({path:new URL(`darts-flight-${width}.png`,dir).pathname,fullPage:true});
   const landed=page.getByTestId('darts-landed');await landed.waitFor();assert.equal(Number(await landed.getAttribute('data-hit-x')),event.hit.x);assert.equal(Number(await landed.getAttribute('data-hit-y')),event.hit.y);await page.waitForTimeout(170);
   assert.equal(await page.evaluate(()=>window.review.snapshot().players[0].remaining),event.remaining);await page.screenshot({path:new URL(`darts-hit-${width}.png`,dir).pathname,fullPage:true});
   await page.waitForTimeout(2400);assert.equal(await held.evaluate(n=>getComputedStyle(n.parentElement).opacity),'1');
   evidence={input:'CDP touchStart/move/end; gesture processed by real engine',heldBox,hit:event.hit,remaining:event.remaining,flightMs:650,heldHiddenDuringFlight:true,heldRestoredAfterImpact:true,authoritativeEndpoint:true};
  }else{
   const board=page.getByTestId('carrom-board'),position=page.getByRole('slider',{name:'置位',exact:true}),power=page.getByRole('slider',{name:'力度',exact:true}),box=await board.boundingBox();
   const cx=box.x+box.width/2,cy=box.y+box.height*(.5+3.36/10.7);await touchDrag(page,Array.from({length:5},(_,i)=>({x:cx+i*box.width*.026,y:cy})));assert(Number(await position.inputValue())>.35,'Canvas striker touch drag still updates native position');
   await position.focus();const before=Number(await position.inputValue());await position.press('ArrowRight');assert.equal(Math.round(Number(await position.inputValue())*100),Math.round(before*100)+1,'Native range keyboard still works');
   await page.getByRole('button',{name:'向左瞄准',exact:true}).click();await page.getByRole('button',{name:'向右瞄准',exact:true}).click();
   await page.evaluate(()=>window.carromQA.pocketFixture());await page.waitForTimeout(180);await position.fill('1');await power.fill('0.4');
   await page.touchscreen.tap(box.x+box.width*(.5+4.27/10.7),box.y+box.height*(.5-4.27/10.7));await page.screenshot({path:new URL(`carrom-pocket-aim-${width}.png`,dir).pathname,fullPage:true});
   await page.getByTestId('carrom-shoot').click();await page.waitForTimeout(160);const state=await page.evaluate(()=>window.carromQA.state());assert.equal(state.shotCount,1);assert.equal(state.lastAction.offset,1);assert.equal(state.lastAction.power,.4);assert(Math.abs(state.lastAction.angle-Math.atan2(1.49,7.63))<.006);assert(state.trajectory.length>3);assert(await page.getByTestId('carrom-shoot').isDisabled());assert(await position.isDisabled());assert(await power.isDisabled());
   const pocket=state.events.find(e=>e.type==='pocket'&&e.id==='w0');assert(pocket,'Real physics must pocket the white coin');await page.screenshot({path:new URL(`carrom-motion-${width}.png`,dir).pathname,fullPage:true});
   await page.waitForTimeout(Math.max(0,state.shotStartedAt+pocket.t+40-Date.now()));await page.screenshot({path:new URL(`carrom-pocket-${width}.png`,dir).pathname,fullPage:true});
   await page.waitForFunction(()=>window.carromQA.state().phase==='aiming');const settled=await page.evaluate(()=>window.carromQA.state());assert.equal(settled.lastEvent.type,'score');assert.equal(settled.lastEvent.captured,1);assert.equal(settled.lastEvent.foul,false);assert.equal(settled.coins.find(c=>c.id==='w0').pocketed,true);assert(settled.teams.some(t=>t.captured.includes('w0')));assert.equal(settled.turnKey,'p0');assert(await position.isEnabled());assert(await power.isEnabled());await page.screenshot({path:new URL(`carrom-scored-${width}.png`,dir).pathname,fullPage:true});
   evidence={input:'CDP touch drag, native keyboard/slider and actual shoot button',fixture:'explicit zero-value legal pocket setup, all original coins retained',shot:state.lastAction,frames:state.trajectory.length,pocket,event:settled.lastEvent,retainedTurn:true,controlsLockedDuringPhysics:true};
  }
  assert.deepEqual(errors,[]);assert.deepEqual(badAssets,[]);reports.push({game,width,height,layout,evidence,errors,badAssets});
  await page.waitForTimeout(width===390?2000:100);const video=page.video();await context.close();if(video)await video.saveAs(new URL(`${game}-motion-390.webm`,dir).pathname);
 }
 const report={at:new Date().toISOString(),scope:'Actual engines in isolated Chrome mobile emulation. Explicit local zero-value Carrom pocket arrangement; no platform/wallet requests or physical-device claims.',reports};
 for(const game of ['carrom','darts'])await writeFile(new URL(`arena/${game}/review-v4/ui-validation.json`,root),JSON.stringify({...report,reports:reports.filter(r=>r.game===game)},null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
