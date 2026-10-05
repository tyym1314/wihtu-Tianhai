import {chromium} from '../../../node_modules/playwright/index.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=new URL('../../../',import.meta.url);
const browser=await chromium.launch({channel:'chrome',headless:true}),reports=[];
try{
 for(const [game,port] of [['carrom',18107],['darts',18111],['pool',18108]])for(const width of [390]){
  const height=width===360?800:width===430?932:844,dir=new URL(`arena/${game}/review-v3/`,root);await mkdir(dir,{recursive:true});
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:2,isMobile:true,hasTouch:true,recordVideo:{dir:new URL('videos/',dir).pathname,size:{width,height}}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  // Isolated preview serves the exact shared atlas; this does not mock state, input, events or results.
  await page.route('**/arena/assets/restoration/*',async route=>{const name=new URL(route.request().url()).pathname.split('/').at(-1);assert(/^[a-zA-Z0-9_-]+\.(png|webp)$/.test(name));const body=await readFile(new URL('arena/public/assets/restoration/'+name,root));await route.fulfill({body,contentType:name.endsWith('.webp')?'image/webp':'image/png'});});
  await page.goto(`http://127.0.0.1:${port}/preview.html`);await page.waitForTimeout(1500);await page.evaluate(async()=>{const urls=new Set([...document.querySelectorAll('img,svg image')].map(n=>n.src||n.getAttribute('href')).filter(Boolean));for(const u of urls){const im=new Image();im.src=u;await im.decode();}});
  const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}));
  assert.equal(layout.scrollWidth,width);assert(layout.scrollHeight<=height,JSON.stringify({game,width,layout}));
  await page.screenshot({path:new URL(`${game}-${width}-before.png`,dir).pathname,fullPage:true});
  let evidence={};
  if(game==='darts'){
   const board=page.locator('.da-board'),box=await board.boundingBox(),x=box.x+box.width*.62,y=box.y+box.height*.34;
   await page.mouse.move(x,y+32);await page.mouse.down();for(let i=1;i<=7;i++){await page.waitForTimeout(54);await page.mouse.move(x,y+32-i*32/7);}await page.mouse.up();
   await page.waitForFunction(()=>window.review.actions.length===1);
   const event=await page.evaluate(()=>window.review.actions[0].event);assert(Math.abs(event.hit.x)>.2);assert(event.hit.y<-.2);
   const flight=page.getByTestId('darts-flight');await flight.waitFor();
   const first=await flight.evaluate(n=>Object.fromEntries(['hit-x','hit-y','tip-x','tip-y'].map(k=>[k,Number(n.getAttribute('data-'+k))])));
   assert.equal(first['hit-x'],event.hit.x);assert.equal(first['hit-y'],event.hit.y);
   await page.screenshot({path:new URL(`darts-${width}-flight.png`,dir).pathname,fullPage:true});
   await page.getByTestId('darts-landed').waitFor();await page.waitForTimeout(170);
   assert.equal(Number(await page.getByTestId('darts-landed').getAttribute('data-hit-x')),event.hit.x);assert.equal(Number(await page.getByTestId('darts-landed').getAttribute('data-hit-y')),event.hit.y);
   const player=await page.evaluate(()=>window.review.snapshot().players[0]);assert.equal(player.remaining,event.remaining);
   await page.screenshot({path:new URL(`darts-${width}-hit.png`,dir).pathname,fullPage:true});
   evidence={action:'actual recorded pointer gesture',hit:event.hit,remaining:event.remaining,flightOrigin:first,authoritativeFlightEndpoint:true,flightMs:event.busyUntil-event.at};
  }else if(game==='carrom'){
   const box=await page.getByTestId('carrom-board').boundingBox();await page.touchscreen.tap(box.x+box.width*.64,box.y+box.height*.23);
   await page.getByRole('slider',{name:'置位',exact:true}).fill('0.4');await page.getByRole('slider',{name:'力度',exact:true}).fill('0.85');await page.getByTestId('carrom-shoot').click();
   await page.waitForTimeout(320);const state=await page.evaluate(()=>window.carromQA.state());assert.equal(state.shotCount,1);assert.equal(state.lastAction.offset,.4);assert.equal(state.lastAction.power,.85);assert(state.trajectory.length>3);assert(await page.getByTestId('carrom-shoot').isDisabled());
   await page.screenshot({path:new URL(`carrom-${width}-motion.png`,dir).pathname,fullPage:true});
   evidence={action:'actual touch aim and shot',shotId:state.shotId,frames:state.trajectory.length,collisionEvents:state.events.length};
  }else{
   // A declared zero-value legal eight-ball scenario exercises the existing real physics/pocket event.
   await page.evaluate(()=>window.poolQA.fixture('eight'));await page.waitForTimeout(120);
   const box=await page.getByTestId('pool-board').boundingBox();await page.touchscreen.tap(box.x+box.width*(.5+3.22/8.1),box.y+box.height*(.5-6.47/14.8));
   const state=await page.evaluate(()=>window.poolQA.state()),cue=state.balls.find(b=>b.n===0),eight=state.balls.find(b=>b.n===8),dx=3.22-eight.x,dy=-6.47-eight.y,dist=Math.hypot(dx,dy),point={x:eight.x-dx/dist*.34,y:eight.y-dy/dist*.34};
   assert.equal(state.calledPocket,1);await page.touchscreen.tap(box.x+box.width*(.5+point.x/8.1),box.y+box.height*(.5+point.y/14.8));await page.getByTestId('pool-power').fill('0.64');
   await page.screenshot({path:new URL(`pool-${width}-eight-aim.png`,dir).pathname,fullPage:true});
   await page.getByTestId('pool-shoot').click();await page.waitForTimeout(280);
   const shot=await page.evaluate(()=>window.poolQA.state());assert.equal(shot.shotCount,1);assert(shot.trajectory.length>3);
   await page.screenshot({path:new URL(`pool-${width}-motion.png`,dir).pathname,fullPage:true});
   const pocket=shot.events.find(e=>e.type==='pocket');if(pocket){await page.waitForTimeout(Math.max(0,shot.shotStartedAt+pocket.t+90-Date.now()));await page.screenshot({path:new URL(`pool-${width}-pocket.png`,dir).pathname,fullPage:true});}
   await page.waitForTimeout(Math.max(0,shot.busyUntil-Date.now()+220));
   const result=await page.evaluate(()=>window.poolQA.state());assert.equal(result.finishReason,'called-eight');assert.deepEqual(result.winnerKeys,['player_0']);
   evidence={action:'actual touch called-pocket and eight-ball shot',fixture:'explicit zero-value eight-ball setup',frames:shot.trajectory.length,pocketEvents:shot.events.filter(e=>e.type==='pocket'),result:result.finishReason};
  }
  assert.deepEqual(errors,[]);reports.push({game,width,height,layout,evidence,errors});await page.waitForTimeout(3200);const video=page.video();await page.close();await video.saveAs(new URL(`${game}-motion-390.webm`,dir).pathname);
 }
 const report={at:new Date().toISOString(),scope:'Isolated actual-engine Chrome mobile emulation. No platform, wallet, or paid room requests. Shared portrait PNG/WebP only routed from its real local source. Not physical-device acceptance.',reports};
 for(const game of ['carrom','darts','pool'])await writeFile(new URL(`arena/${game}/review-v3/video-validation.json`,root),JSON.stringify({...report,reports:reports.filter(r=>r.game===game)},null,2));
 console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
