/** Tower Link v2 browser acceptance: real local engine, no wallet, no phone claims. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createState} from '../arena/towerlink/engine.mjs';

const output=fileURLToPath(new URL('../review/towerlink-v2.1-ui/',import.meta.url));
const base=process.env.TOWERLINK_REVIEW_URL||'http://127.0.0.1:18118/arena/review-preview.html';
await mkdir(output,{recursive:true});
const report={at:new Date().toISOString(),base,scope:'Desktop Chromium emulates phone viewports and actual touch events against a local authoritative v2 engine fixture. No wallet, live deployment, real device or performance acceptance.',checks:[],screenshots:[],errors:[],passed:false};
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:1});
const page=await context.newPage();
page.setDefaultTimeout(10000);
page.on('pageerror',e=>report.errors.push(e.message));
page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))report.errors.push('Unexpected production API request: '+request.url());});
const current=()=>page.evaluate(()=>window.artReview.room().game);
async function open(players=2,extra=''){
 await page.goto(`${base}?game=towerlink&locale=zh&players=${players}${extra}`);
 await page.waitForSelector('[data-testid="towerlink-game"]');
 await page.waitForFunction(()=>Boolean(window.artReview?.room()?.game?.towers?.length));
 const assets=await page.evaluate(async()=>{const module=await import('/arena/towerlink/tower-assets.mjs');const result=await module.preloadTowerAssets();return{count:result.images.size,files:result.manifest.files};});
 assert.equal(assets.count,5,'All five texture atlases must decode before acceptance');
 assert(Object.values(assets.files).every(file=>file.endsWith('.webp')),'Runtime textures should be compressed WebP');
 await page.waitForSelector('[data-state="active"]');
 // Let ResizeObserver publish the final canvas / DOM hit-target coordinates.
 await page.waitForTimeout(150);
 assert.equal((await current()).ruleVersion,'towerlink-v2.1.0');
 return assets;
}
async function screenshot(name){await page.screenshot({path:output+name});report.screenshots.push(name);}
async function layout(label){
 const bounds=await page.evaluate(()=>{const scene=document.querySelector('.towerlink-game').getBoundingClientRect(),board=document.querySelector('.towerlink-stage').getBoundingClientRect(),controls=document.querySelector('.tl-control-panel').getBoundingClientRect();return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,scene:{left:scene.left,top:scene.top,right:scene.right,bottom:scene.bottom},board:{width:board.width,height:board.height},controls:{top:controls.top,bottom:controls.bottom},targets:[...document.querySelectorAll('[data-tower]')].map(el=>{const r=el.getBoundingClientRect();return{id:el.dataset.tower,width:r.width,height:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom};})};});
 assert(bounds.scrollWidth<=bounds.width+1,`${label}: horizontal page overflow`);
 assert(bounds.scrollHeight<=bounds.height+1,`${label}: vertical page overflow`);
 assert(bounds.scene.bottom<=bounds.height+1,`${label}: full screen bounds`);
 assert(bounds.controls.bottom<=bounds.height+1,`${label}: controls clipped`);
 assert(bounds.targets.every(t=>t.width>=44&&t.height>=44),`${label}: all tower targets are at least 44 CSS px`);
 assert(bounds.board.height>250,`${label}: battlefield remains usable`);
 return bounds;
}
async function position(id){const b=await page.locator(`[data-tower="${id}"]`).boundingBox();assert(b);return{x:b.x+b.width/2,y:b.y+b.height*.7};}
async function drag(from,to){
 await page.waitForFunction(()=>{const g=window.artReview.room().game;return g.serverNow>=g.busyUntil;});
 const start=await position(from),end=typeof to==='number'?await position(to):to,cdp=await context.newCDPSession(page);
 try{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:start.x,y:start.y,id:1}]});for(let i=1;i<=10;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+(end.x-start.x)*i/10,y:start.y+(end.y-start.y)*i/10,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}finally{await cdp.detach();}
}
function firstRoute(g){const from=g.owners.indexOf('p0');return{from,to:g.towers[from].neighbors[0]};}

try{
 for(const [width,height,players] of [[360,740,2],[390,844,2],[390,844,3],[360,740,4],[430,932,4]]){
  await page.setViewportSize({width,height});const assets=await open(players),g=await current();
  assert.equal(g.players.length,players);assert.equal(g.towers.length,13);assert.equal(await page.locator('.tl-banner').count(),players);
  assert.equal(g.orders.length,0);assert.equal(g.armies.length,0);
  report.checks.push({kind:'mobile-layout',viewport:`${width}x${height}`,players,assets,bounds:await layout(`${width}/${players}`)});
  await screenshot(`battle-${players}p-${width}x${height}.png`);
 }
 // Verify all six authoritative map variants, instead of the obsolete three-map v1 assumption.
 await page.setViewportSize({width:390,height:844});
 for(const count of [2,3,4]){
  const seeds=new Map();for(let i=1;i<120&&seeds.size<2;i++){const seed=i.toString(16).padStart(64,'0'),state=createState(seed,1000,{players:Array.from({length:count},(_,seatIndex)=>({key:`p${seatIndex}`,seatIndex}))});seeds.set(state.level.id,seed);}
  assert.equal(seeds.size,2);for(const [level,seed]of seeds){await open(count,`&seed=${seed}`);assert.equal((await current()).level.id,level);report.checks.push({kind:'map',players:count,level});}
 }
 await open(2);let g=await current(),route=firstRoute(g),beforeActions=await page.evaluate(()=>window.artReview.actions());
 const invalid=g.towers.findIndex((node,i)=>i!==route.from&&!g.towers[route.from].neighbors.includes(i));
 await drag(route.from,invalid);await page.waitForTimeout(120);
 assert.equal(await page.evaluate(()=>window.artReview.actions()),beforeActions,'Invalid target must not submit an action');
 assert((await page.locator('.towerlink-tip').innerText()).includes('道路'));
 await drag(route.from,{x:390/2,y:150});await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>window.artReview.actions()),beforeActions,'Releasing on blank ground must cancel');
 report.checks.push('Invalid / blank release does not mutate routes or troops');
 await drag(route.from,route.to);
 await page.waitForFunction(({from,to})=>window.artReview.room().game.orders.some(o=>o.from===from&&o.to===to),route);
 assert.equal((await current()).owners[route.to],null,'A link does not instantly conquer a tower');
 await page.waitForFunction(()=>window.artReview.room().game.armies.length>0);
 await screenshot('continuous-troops.png');
 await page.waitForFunction(id=>window.artReview.room().game.owners[id]==='p0',route.to,{timeout:22000});
 assert((await current()).players.find(p=>p.key==='p0').towers>=2,'Arriving troops can occupy a neutral tower');
 const presentationTiming=await page.evaluate(()=>new Promise(resolve=>{
  const started=performance.now(),intervals=[],longTasks=[],armyCountAtStart=window.artReview.room().game.armies.length;
  let previous=null,frame=0,finished=false,observer=null;
  const longTaskSupported=PerformanceObserver.supportedEntryTypes?.includes('longtask')===true;
  if(longTaskSupported){observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())if(entry.startTime>=started)longTasks.push(entry.duration);});observer.observe({entryTypes:['longtask']});}
  const finish=()=>{if(finished)return;finished=true;cancelAnimationFrame(frame);clearTimeout(timeout);observer?.disconnect();const sorted=[...intervals].sort((a,b)=>a-b),percentile=p=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]??null,mean=intervals.reduce((a,b)=>a+b,0)/Math.max(1,intervals.length);resolve({scope:'Desktop Chromium mobile viewport, actual continuing army routes, five image assets decoded. This is NOT physical-phone FPS or server capacity acceptance.',durationMs:performance.now()-started,samples:intervals.length,meanRafMs:mean,p95RafMs:percentile(.95),p99RafMs:percentile(.99),maxRafMs:sorted.at(-1)??null,estimatedRafFps:mean?1000/mean:null,framesOver50ms:intervals.filter(value=>value>50).length,longTaskSupported,longTaskCount:longTasks.length,maxLongTaskMs:longTasks.length?Math.max(...longTasks):0,armyCountAtStart,armyCountAtEnd:window.artReview.room().game.armies.length});};
  const timeout=setTimeout(finish,12000),sample=now=>{if(previous!==null)intervals.push(now-previous);previous=now;if(now-started>=10000)finish();else frame=requestAnimationFrame(sample);};frame=requestAnimationFrame(sample);
 }));
 assert(presentationTiming.samples>0,'Animation-frame sampling ran');report.checks.push({kind:'desktop-presentation-timing',...presentationTiming});
 await screenshot('battle-action-390x844.png');
 await page.locator('[data-action="tower-manage"]').click();await page.locator('[data-action="tower-stop"]').click();await page.waitForFunction(()=>window.artReview.room().game.orders.length===0);await page.locator('.tl-routes-shade .tl-modal-close').click();
 report.checks.push('Real touch drag creates a persistent order; real travelling armies arrive and capture; stop clears the order');

 // Grade-bound dispatch and route limits, with visible upgrade eligibility.
 await open(2);g=await current();const multiFrom=g.owners.indexOf('p0'),targets=g.towers[multiFrom].neighbors;
 assert(targets.length>=3);assert.equal(g.towers[multiFrom].level,1);
 const ownNode=page.locator(`[data-tower="${multiFrom}"]`);
 assert.equal(await ownNode.getAttribute('data-upgrade-ready'),'true');
 assert(await ownNode.locator('.tl-upgrade-ready').isVisible());
 assert.equal(await page.locator('[data-owner="neutral"] .tl-upgrade-ready').count(),0);
 await screenshot('upgrade-ready-over-tower.png');
 await drag(multiFrom,targets[0]);await page.waitForFunction(()=>window.artReview.room().game.orders.length===1);
 let submitted=await page.evaluate(()=>window.artReview.actions());
 await drag(multiFrom,targets[1]);await page.waitForTimeout(120);
 assert.equal(await page.evaluate(()=>window.artReview.actions()),submitted,'Level 1 cannot add a second route');
 assert((await page.locator('.towerlink-tip').innerText()).includes('方向已满'));
 await page.locator('[data-action="tower-upgrade"]').click();await page.locator('[data-action="tower-upgrade-confirm"]').click();
 await page.waitForFunction(id=>Boolean(window.artReview.room().game.towers[id].upgrade),multiFrom);
 assert.equal(await ownNode.locator('.tl-upgrade-ready').count(),0,'Upgrade badge hides during construction');
 await page.waitForFunction(id=>window.artReview.room().game.towers[id].level===2,multiFrom,{timeout:5000});
 assert.equal((await current()).towers[multiFrom].routeLimit,2);assert.equal((await current()).towers[multiFrom].dispatchRate,2);
 await drag(multiFrom,targets[1]);await page.waitForFunction(()=>window.artReview.room().game.orders.length===2);
 submitted=await page.evaluate(()=>window.artReview.actions());await drag(multiFrom,targets[2]);await page.waitForTimeout(120);
 assert.equal(await page.evaluate(()=>window.artReview.actions()),submitted,'Level 2 cannot add a third route');
 await screenshot('level-2-two-routes.png');
 await page.locator('[data-action="tower-manage"]').click();await page.getByRole('dialog',{name:'管理出兵路线'}).waitFor();
 assert.equal(await page.locator('[data-unlink]').count(),2);assert((await page.locator('.tl-routes-budget').innerText()).includes('1／2／3'));
 await screenshot('manage-routes.png');await page.locator(`[data-unlink="${targets[0]}"]`).click();
 await page.waitForFunction(({from,to})=>!window.artReview.room().game.orders.some(o=>o.from===from&&o.to===to),{from:multiFrom,to:targets[0]});
 assert.equal((await current()).orders.length,1);
 await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).last().click();
 await drag(multiFrom,targets[1]);await page.waitForFunction(()=>window.artReview.room().game.orders.length===0);
 await page.waitForFunction(id=>window.artReview.room().game.towers[id].troops>=35,multiFrom,{timeout:25000});
 assert.equal(await ownNode.getAttribute('data-upgrade-ready'),'true');
 await page.locator('[data-action="tower-upgrade"]').click();await page.locator('[data-action="tower-upgrade-confirm"]').click();
 await page.waitForFunction(id=>window.artReview.room().game.towers[id].level===3,multiFrom,{timeout:6000});
 assert.equal(await ownNode.locator('.tl-upgrade-ready').count(),0,'Maximum level has no upgrade badge');
 assert.equal((await current()).towers[multiFrom].routeLimit,3);assert.equal((await current()).towers[multiFrom].dispatchRate,3);
 for(const to of targets.slice(0,3)){await drag(multiFrom,to);await page.waitForFunction(({from,to})=>window.artReview.room().game.orders.some(o=>o.from===from&&o.to===to),{from:multiFrom,to});}
 await screenshot('level-3-three-routes.png');await layout('level 3 route controls');
 await page.locator('[data-action="tower-manage"]').click();await page.locator('[data-action="tower-stop"]').click();await page.waitForFunction(()=>window.artReview.room().game.orders.length===0);await page.locator('.tl-routes-shade .tl-modal-close').click();
 await drag(multiFrom,targets[2]);await page.waitForFunction(()=>window.artReview.room().game.orders.length===1);
 report.checks.push('Level 1/2/3 permit 1/2/3 routes and dispatch 1/2/3 per second; excess routes reject; badge appears when affordable, hides during construction and at max; single cancel, stop-all and redirect work');

 await open(3);g=await current();const owned=g.owners.indexOf('p0');
 await page.locator('[data-action="tower-upgrade"]').click();
 assert.equal(await page.getByRole('dialog').count(),1);await screenshot('upgrade-available.png');
 await page.locator('[data-action="tower-upgrade-confirm"]').click();
 await page.waitForFunction(id=>Boolean(window.artReview.room().game.towers[id].upgrade),owned);
 const underConstruction=(await current()).towers[owned];await page.waitForTimeout(600);
 assert.equal((await current()).towers[owned].troops,underConstruction.troops,'Construction pauses production without incoming reinforcements');
 await screenshot('upgrade-construction.png');
 await page.waitForFunction(id=>window.artReview.room().game.towers[id].level===2,owned,{timeout:5000});
 g=await current();assert.equal(g.towers[owned].upgrade,null);assert.equal(g.towers[owned].productionRate,2);assert.equal(g.towers[owned].productionCap,60);
 report.checks.push('Upgrade dialog submits the real cost, construction pauses production, completion changes level and production');

 await open(2);g=await current();route=firstRoute(g);let reject=true;
 await page.route('**/__art-match',async request=>{if(request.request().postDataJSON()?.op==='act'&&reject){reject=false;return request.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'测试：指令未确认，请重试'})});}return request.continue();});
 await drag(route.from,route.to);await page.waitForFunction(()=>document.querySelector('.towerlink-tip').textContent.includes('指令未确认'));
 assert.equal((await current()).orders.length,0);assert.equal((await current()).owners[route.to],null);
 await screenshot('rejected-command.png');await page.unroute('**/__art-match');await drag(route.from,route.to);
 await page.waitForFunction(()=>window.artReview.room().game.orders.length===1);
 report.checks.push('Rejected command gives local feedback without optimistic conquest; retry succeeds');
 await page.locator('[data-action="tower-manage"]').click();await context.setOffline(true);await page.waitForSelector('[data-state="offline"]');assert(await page.locator('[data-action="tower-stop"]').isDisabled());assert((await page.locator('.towerlink-tip').innerText()).includes('网络已断开'));await screenshot('offline.png');
 await context.setOffline(false);await page.waitForSelector('[data-state="active"]');assert((await current()).orders.length>0);report.checks.push('Offline locks commands and visibly warns; reconnection preserves existing routes');
 await page.emulateMedia({reducedMotion:'reduce'});await open(4);
 assert.equal(await page.locator('.tl-cloud-one').evaluate(el=>getComputedStyle(el).animationName),'none');await screenshot('reduced-motion.png');
 report.checks.push('Reduced motion disables decorative cloud animation; authoritative troops remain visible');
 await page.emulateMedia({reducedMotion:'no-preference'});
 // A controlled presentation fixture verifies the player-visible troop count.
 // It does not derive an expected value from the renderer's compression logic.
 const troopLabels=await page.evaluate(async()=>{
  const {createTowerScene}=await import('/arena/towerlink/tower-scene.js');
  const source=structuredClone(window.artReview.room().game),from=source.owners.indexOf('p0'),to=source.towers[from].neighbors[0],time=source.serverNow;
  const canvas=document.createElement('canvas');canvas.width=390;canvas.height=440;canvas.style.cssText='position:fixed;left:0;top:0;width:390px;height:440px;z-index:9999;background:#91c8dc';canvas.dataset.testid='troop-count-visual-fixture';document.body.append(canvas);
  const ctx=canvas.getContext('2d'),fill=ctx.fillText.bind(ctx),visible=[];ctx.fillText=(text,...args)=>{visible.push(String(text));return fill(text,...args);};
  let game={...source,recentEvents:[],lastEvent:null,orders:[],armies:[{id:'review-three',ownerKey:'p0',from,to,count:3,departedAt:time-1000,arrivesAt:time+1000}]};
  const stop=createTowerScene(canvas,()=>({game,me:'p0',selected:null,aim:null,reduced:true,rotation:0,serverAt:time,serverTime:()=>time}));
  const drawFrames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
  await drawFrames();const threeVisible=visible.includes('×3');
  game={...game,armies:Array.from({length:81},(_,i)=>({id:`review-packet-${i}`,ownerKey:'p0',from,to,count:2,departedAt:time-1000,arrivesAt:time+1000}))};visible.length=0;
  await drawFrames();const denseTwoVisible=visible.includes('×2');stop();canvas.remove();return{threeVisible,denseTwoVisible};
 });
 assert(troopLabels.threeVisible,'A three-troop formation must visibly label its real count when simplified');
 assert(troopLabels.denseTwoVisible,'Dense armies must keep the two-troop count visible even with simplified silhouettes');
 report.checks.push({kind:'visible-formation-count',...troopLabels,scope:'Controlled renderer fixture; verifies visible canvas text for semantic 3-troop and dense 2-troop formations'});
 // The UI clock uses server timestamps rather than a misconfigured device wall clock.
 await page.addInitScript(()=>{const original=Date.now;Date.now=()=>original()+3*60*60*1000;});await open(2);
 assert(/^0[23]:/.test(await page.locator('.tl-timer b').innerText()));report.checks.push('Countdown tolerates a +3 hour client wall-clock offset');
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.failure={message:error.message,stack:error.stack};process.exitCode=1;}
finally{await writeFile(output+'report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,screenshots:report.screenshots.length,report:output+'report.json',failure:report.failure?.message}));await browser.close();}
