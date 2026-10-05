/** Real host/API; only response timing and one image failure are injected. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {playOneArenaAction} from '../scripts/android-game-actions.mjs';
import {waitForPlayable} from '../scripts/mobile-quality-metrics.mjs';
const origin=process.env.OASIS_PROFILE_ORIGIN;
assert(origin&&['localhost','127.0.0.1'].includes(new URL(origin).hostname),'isolated local harness only');
const out=resolve('review/deep-mobile-20260928/arena-recovery');await mkdir(out,{recursive:true});
const report={scope:'Production built UI and real isolated host/API; trusted Chrome touch. Controlled response delay and image failure; not a network/performance or physical-device measurement.',checks:[],errors:[]},browser=await chromium.launch({channel:'chrome',headless:true});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};},delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await delay(30);}throw Error('Timeout: '+label);}
async function setup(game){
 const context=await browser.newContext({viewport:{width:393,height:852},deviceScaleFactor:2,isMobile:true,hasTouch:true}),page=await context.newPage(),state={token:null,room:null,exchanges:0};
 page.on('pageerror',e=>report.errors.push(e.message));page.on('response',async r=>{try{const path=new URL(r.url()).pathname;if(path==='/v1/launch/exchange'&&r.ok()){state.token=(await r.json()).access_token;state.exchanges++;}else if(path.startsWith('/api/pvp/rooms')&&r.ok()){const b=await r.json();if(b.id&&b.game_id===game&&(!state.room||b.version>=state.room.version))state.room=b;}}catch{}});
 const frame=async()=>{await until(()=>page.frames().some(f=>new URL(f.url()).pathname==='/play/'+game),'game frame');return page.frames().find(f=>new URL(f.url()).pathname==='/play/'+game);};
 const close=async()=>{try{if(state.room&&state.token){const h={authorization:'Bearer '+state.token,origin,'content-type':'application/json'},r=await page.request.post(origin+`/api/pvp/rooms/${state.room.id}/leave`,{headers:h,data:{request_id:randomUUID().replaceAll('-','')}});assert(r.ok(),'owned free practice leave');const read=await page.request.get(origin+`/api/pvp/rooms/${state.room.id}`,{headers:h}),room=await read.json();assert(['cancelled','settled','voided'].includes(room.status)||room.players.some(p=>p.external_user_id===room.me&&p.forfeited),'owned seat released');}}finally{await context.close();}};
 await page.goto(origin+'/demo/native/'+game);const f=await frame();await f.getByRole('button',{name:'免费练习',exact:false}).click();await f.getByRole('button',{name:'确认规则 · 准备开局',exact:true}).click();await until(()=>state.room?.status==='active','active practice');await waitForPlayable(f,game,{readRoom:()=>state.room});return{context,page,state,frame,close};
}
try{
 const a=await setup('ludo');let release;
 try{
  const held=deferred();release=held.resolve;let once=true;
  await a.page.route('**/board-material-*.webp',async route=>{if(once){once=false;await held.promise;await route.abort('failed');}else await route.continue();});
  const id=a.state.room.id;await a.page.reload();const f=await a.frame();await f.getByTestId('active-assets-gate').waitFor();assert.equal(await f.locator('.ludo-scene').count(),0);assert(await f.getByRole('button',{name:'返回或离开房间'}).isEnabled());
  release();await f.getByRole('button',{name:'重新加载资源',exact:true}).waitFor();assert.equal(await f.locator('.ludo-scene').count(),0);await a.page.screenshot({path:resolve(out,'recovery-assets-failed.png')});
  await f.getByRole('button',{name:'重新加载资源',exact:true}).click();await f.locator('.ludo-scene').waitFor();await f.getByTestId('active-assets-gate').waitFor({state:'detached'});assert.equal(a.state.room.id,id);report.checks.push('Cold active-room recovery waits for essential board artwork; injected failure exposes retry/return; retry restores the same authoritative room');await a.page.screenshot({path:resolve(out,'recovery-assets-ready.png')});
 }finally{release?.();await a.close();}
 const b=await setup('match'),heldAction=deferred(),actionAccepted=deferred(),heldSession=deferred(),sessionHeld=deferred(),posts=[];let inject401=false,holdSession=false,firstAction=true;
 try{
  await b.page.route('**/api/arena/session',async route=>{if(holdSession){holdSession=false;const response=await route.fetch();sessionHeld.resolve();await heldSession.promise;return route.fulfill({response});}return route.continue();});
  await b.page.route('**/api/pvp/rooms/**',async route=>{
   const req=route.request();if(req.method()==='GET'&&inject401){inject401=false;return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:{code:'SESSION_EXPIRED'}})});}
   if(req.method()==='POST'&&new URL(req.url()).pathname.endsWith('/action')){posts.push(req.postDataJSON());if(firstAction){firstAction=false;const response=await route.fetch();assert(response.ok(),'original action was accepted');actionAccepted.resolve();await heldAction.promise;return route.fulfill({response});}}
   return route.continue();
  });
  const f=await b.frame(),action=playOneArenaAction(f,'match',()=>b.state.room,{touch:true});await actionAccepted.promise;holdSession=true;inject401=true;await sessionHeld.promise;await until(()=>b.state.exchanges===2,'fresh token exchange');
  heldAction.resolve();await action;await f.getByRole('button',{name:'重试原请求',exact:false}).waitFor();heldSession.resolve();await delay(400);const retry=f.getByRole('button',{name:'重试原请求',exact:false});assert(await retry.isVisible());assert(await retry.isEnabled());
  await retry.click();await until(()=>posts.length===2,'same intent replay');await f.locator('.arena-error').waitFor({state:'detached'});assert.deepEqual(posts[1],posts[0]);assert.equal(b.state.room.me_last_seq,posts[0].seq);assert.equal(b.state.exchanges,2);
  report.checks.push('Accepted old POST delayed across real host reauthorization is not adopted or automatically resent; pending prompt survives authorized event; user retry sends identical request/seq and resolves once');await b.page.screenshot({path:resolve(out,'reauth-pending-recovered.png')});
 }finally{heldAction.resolve();heldSession.resolve();await b.close();}
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(e){report.failure=e.message;process.exitCode=1;}finally{await browser.close();report.checked_at=new Date().toISOString();await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
