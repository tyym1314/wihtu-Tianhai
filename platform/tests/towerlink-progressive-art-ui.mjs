/** Local browser acceptance for optional Tower art; no wallet or public host. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';

const server=spawn(process.execPath,['arena/towerlink/performance/ui-server.mjs'],{stdio:['ignore','pipe','pipe']});
let browser,releaseImages=()=>{};
try{
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Tower fixture did not start')),15000);
  server.once('exit',code=>reject(new Error(`Tower fixture exited ${code}`)));
  server.stdout.on('data',chunk=>{if(String(chunk).includes('isolated Tower UI')){clearTimeout(timer);resolve();}});
  server.stderr.on('data',chunk=>process.stderr.write(chunk));
 });
 browser=await chromium.launch({headless:true});
 const base='http://127.0.0.1:18126/__tower-ui?players=2';
 const context=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true,deviceScaleFactor:1});
 const page=await context.newPage(),errors=[],held=[];
 page.on('pageerror',error=>errors.push(error.message));
 const imageGate=new Promise(resolve=>releaseImages=resolve);
 await page.route('**/towerlink/assets/v2/*.webp*',async route=>{if(route.request().resourceType()!=='image')return route.continue();held.push(route.request().url());await imageGate;await route.continue();});
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.locator('[data-testid="towerlink-game"][data-state="active"]').waitFor();
 await page.waitForFunction(()=>document.querySelector('[data-testid="towerlink-game"]')?.dataset.artLoaded==='0');
 await page.waitForFunction(()=>window.towerReview?.room()?.game?.owners?.includes('p0'));
 const geometry=await page.evaluate(()=>{
  const game=window.towerReview.room().game,from=game.owners.indexOf('p0'),to=game.towers[from].neighbors[0];
  const point=id=>{const r=document.querySelector(`[data-tower="${id}"]`).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};};
  return{from,to,start:point(from),end:point(to)};
 });
 const cdp=await context.newCDPSession(page),touch=p=>({...p,id:1,radiusX:4,radiusY:4,force:.5});
 async function drag(){
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch(geometry.start)]});
  for(const fraction of [.33,.67,1])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch({x:geometry.start.x+(geometry.end.x-geometry.start.x)*fraction,y:geometry.start.y+(geometry.end.y-geometry.start.y)*fraction})]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 }
 await drag();
 await page.waitForFunction(()=>window.towerReview.actions().length===1);
 assert.deepEqual(await page.evaluate(()=>window.towerReview.actions()),[{type:'link',from:geometry.from,to:geometry.to}]);
 assert.equal(await page.locator('[data-testid="towerlink-game"]').getAttribute('data-art-loaded'),'0','the legal action completed while all art responses were held');
 assert.ok(held.length>=5,`expected all five optional image requests, saw ${held.length}`);
 releaseImages();
 await page.waitForFunction(()=>document.querySelector('[data-testid="towerlink-game"]')?.dataset.artLoaded==='5',null,{timeout:20000});
 await page.waitForTimeout(700);
 assert.equal(await page.locator('[data-testid="towerlink-game"]').getAttribute('data-art-failed'),'0');
 assert.ok(await page.locator('.tl-atlas-portrait').count()>0,'decoded art replaces the CSS portrait fallback');
 await drag();
 await page.waitForFunction(()=>window.towerReview.actions().length===2);
 assert.deepEqual(await page.evaluate(()=>window.towerReview.actions().at(-1)),{type:'unlink',from:geometry.from,to:geometry.to});
 assert.deepEqual(errors,[]);
 await context.close();

 const retryContext=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true,deviceScaleFactor:1});
 const retryPage=await retryContext.newPage();let terrainRequests=0;
 retryPage.on('pageerror',error=>errors.push(error.message));
 await retryPage.route('**/towerlink/assets/v2/*battlefield.webp*',route=>{if(route.request().resourceType()!=='image')return route.continue();terrainRequests++;return terrainRequests===1?route.abort('failed'):route.continue();});
 await retryPage.goto(base,{waitUntil:'domcontentloaded'});
 await retryPage.locator('[data-testid="towerlink-game"][data-state="active"]').waitFor();
 await retryPage.waitForFunction(()=>document.querySelector('[data-testid="towerlink-game"]')?.dataset.artFailed==='1');
 assert.equal(await retryPage.locator('[data-testid="towerlink-game"]').getAttribute('data-state'),'active');
 const retryBounds=await retryPage.getByRole('button',{name:'重试画面资源',exact:true}).evaluate(button=>{const box=button.getBoundingClientRect();return{height:box.height,right:box.right,bottom:box.bottom,screenWidth:innerWidth,screenHeight:innerHeight};});
 assert.ok(retryBounds.height>=44&&retryBounds.right<=retryBounds.screenWidth&&retryBounds.bottom<=retryBounds.screenHeight,`resource retry keeps a 44px target on screen: ${JSON.stringify(retryBounds)}`);
 await retryPage.setViewportSize({width:320,height:680});
 const narrowButtons=await retryPage.locator('.tl-header button').evaluateAll(buttons=>buttons.map(button=>{const box=button.getBoundingClientRect();return{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height};}));
 assert.ok(narrowButtons.every(button=>button.width>=44&&button.height>=44&&button.left>=0&&button.right<=320),`all header actions stay tappable at 320px: ${JSON.stringify(narrowButtons)}`);
 assert.ok(narrowButtons.every((button,index)=>index===0||button.left>=narrowButtons[index-1].right-1),'header buttons do not overlap at 320px');
 await retryPage.getByRole('button',{name:'重试画面资源',exact:true}).click();
 await retryPage.waitForFunction(()=>document.querySelector('[data-testid="towerlink-game"]')?.dataset.artLoaded==='5');
 assert.equal(await retryPage.locator('[data-testid="towerlink-game"]').getAttribute('data-art-failed'),'0');
 assert.equal(terrainRequests,2);
 assert.deepEqual(errors,[]);
 await retryContext.close();
 console.log(JSON.stringify({passed:true,heldImages:held.length,actionsBeforeImages:1,actionsAfterImages:2,failedImageRetried:true,scope:'local Chromium touch fixture'}));
}finally{
 releaseImages();
 if(browser)await browser.close();
 server.kill('SIGTERM');
 await new Promise(resolve=>{if(server.exitCode!==null)return resolve();server.once('exit',resolve);});
}
