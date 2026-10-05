/** Isolated native-shell + real SDK browser contract. No live API, wallet, or device. */
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {access} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createDemoHost} from '../deploy/demo-host.mjs';

const origin='https://native-fixture.example.test',launches=[],browserErrors=[],checks=[];
const backend={games:async()=>({games:[]}),launch:async(guest,body)=>{
 launches.push({guest,body});
 return{session_id:body.resume_session_id||'native_fixture_session',entry_url:origin+'/play/'+body.game_id,launch_code:'fixture_launch_code_'+launches.length,expires_at:new Date(Date.now()+60000).toISOString()};
}};
const server=await createDemoHost({origin},{key:Buffer.alloc(32,41),backend});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 const macChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 let executablePath=process.env.CHROME_PATH;
 if(!executablePath&&process.platform==='darwin'){await access(macChrome);executablePath=macChrome;}
 browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const page=await context.newPage();page.on('pageerror',e=>browserErrors.push(e.message));
 const apiRequests=[];
 await context.route(origin+'/**',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.pathname==='/play/match')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><button id="reauth">Restore session</button><dialog><button id="cancel">Cancel</button><button id="confirm">Confirm return</button></dialog><script src="/fixture-game.js"></script>'});
  if(url.pathname==='/fixture-game.js')return route.fulfill({contentType:'text/javascript',body:`
   const nonce='native_fixture_nonce_12345678',base={protocol_version:1,game_id:'match',bridge_nonce:nonce};
   window.fixture={loaded:0,back:0};
   const post=(type,extra={})=>parent.postMessage({...base,type,...extra},location.origin);
   addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==parent||e.data?.bridge_nonce!==nonce)return;
    if(e.data.type==='oasis.launch'){window.fixture.loaded++;post('oasis.loaded');}
    if(e.data.type==='oasis.back'){window.fixture.back++;document.querySelector('dialog').showModal();}
   });
   document.querySelector('#reauth').onclick=()=>post('oasis.reauth_required');
   document.querySelector('#cancel').onclick=()=>document.querySelector('dialog').close();
   document.querySelector('#confirm').onclick=()=>post('oasis.return_requested',{reason:'user',status:'lobby',return_url:'https://evil.test'});
   post('oasis.ready');
  `});
  if(url.pathname.startsWith('/api/'))apiRequests.push({path:url.pathname,method:req.method()});
  const response=await new Promise((resolve,reject)=>{
   const headers={...req.headers(),host:new URL(origin).host};delete headers['content-length'];
   const r=request({host:'127.0.0.1',port:server.address().port,path:url.pathname+url.search,method:req.method(),headers},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
   });r.on('error',reject);r.end(req.postDataBuffer());
  });
  const headers=Object.fromEntries(Object.entries(response.headers).filter(([k])=>!['connection','keep-alive','transfer-encoding','content-length'].includes(k)).map(([k,v])=>[k,Array.isArray(v)?v.join('\n'):String(v)]));
  await route.fulfill({status:response.status,headers,body:response.body});
 });
 await page.goto(origin+'/demo/native/match');
 await page.locator('#native-status').waitFor({state:'hidden'});
 const frame=page.frames().find(f=>f.url()===origin+'/play/match');assert.ok(frame);
 const layout=await page.evaluate(()=>{const b=document.querySelector('iframe').getBoundingClientRect();return{width:innerWidth,height:innerHeight,frame:{x:b.x,y:b.y,w:b.width,h:b.height},scroll:document.documentElement.scrollHeight,body:document.body.scrollHeight,bridge:Object.keys(window.OasisNativeHost),header:!!document.querySelector('header'),cards:document.querySelectorAll('[data-game]').length};});
 assert.deepEqual(layout.frame,{x:0,y:0,w:layout.width,h:layout.height});assert.equal(layout.scroll,layout.height);assert.equal(layout.body,layout.height);assert.equal(layout.header,false);assert.equal(layout.cards,1);assert.deepEqual(layout.bridge,['requestBack']);
 assert.deepEqual(apiRequests,[{path:'/api/demo/config',method:'GET'},{path:'/api/demo/launch',method:'POST'}]);
 checks.push('390px native shell is exactly viewport sized, has no lobby/toolbar/scroll, only config + launch');
 await page.evaluate(()=>window.postMessage({type:'oasis.return_requested',protocol_version:1,game_id:'match',bridge_nonce:'native_fixture_nonce_12345678'},location.origin));
 await frame.evaluate(()=>parent.postMessage({type:'oasis.return_requested',protocol_version:1,game_id:'match',bridge_nonce:'wrong_fixture_nonce_12345678'},location.origin));
 // An evaluation round trip flushes these posted-message tasks without sleeps.
 await frame.evaluate(()=>new Promise(resolve=>setTimeout(resolve,50)));
 assert.equal(page.url(),origin+'/demo/native/match');assert.equal(await page.locator('iframe').count(),1);
 checks.push('real OasisHost rejects wrong source and wrong nonce return messages');
 await page.evaluate(()=>window.OasisNativeHost.requestBack());await frame.locator('dialog').waitFor();
 assert.equal(page.url(),origin+'/demo/native/match');await frame.locator('#cancel').click();assert.equal(await page.locator('iframe').count(),1);
 checks.push('native back invokes actual oasis.back; cancelling retains the game');
 await frame.locator('#reauth').click();await frame.waitForFunction(()=>window.fixture.loaded===2);await page.locator('#native-status').waitFor({state:'hidden'});
 assert.equal(launches.length,2);assert.equal(launches[1].body.resume_session_id,'native_fixture_session');assert.equal(launches[0].guest,launches[1].guest);
 checks.push('reauthorization reuses original session and secure guest identity');
 await page.evaluate(()=>window.OasisNativeHost.requestBack());await frame.locator('#confirm').click();await page.waitForURL(origin+'/demo/native-return');
 assert.equal(await page.locator('iframe').count(),0);checks.push('authenticated return_requested navigates only to fixed native-return');
 assert.deepEqual(browserErrors,[]);
 console.log(JSON.stringify({passed:true,checks,scope:'isolated host + actual SDK browser fixture; no live game/device'},null,2));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
