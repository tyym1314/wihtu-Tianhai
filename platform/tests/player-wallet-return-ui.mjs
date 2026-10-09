import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
import {createPlayerWalletHttpsFixture} from './player-wallet-https-fixture.mjs';

// Engineering validation only: real isolated production PG/BFF/wallet/room,
// synthetic iframe presentation. Never contacts a public deployment or device.
const fixture=await createPlayerWalletHttpsFixture(),out=new URL('../review/player-wallet-return-tls-20261010/',import.meta.url);
const paths=['server/player-routes.mjs','src/pages/PlayerClient.mjs','src/pages/Player.jsx'];
const sourceSha256=Object.fromEntries(await Promise.all(paths.map(async path=>[path,createHash('sha256').update(await readFile(new URL('../'+path,import.meta.url))).digest('hex')])));
const bundle=await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import Player from './src/pages/Player.jsx';import{OasisHost}from'./public/sdk/oasis-h5.mjs';const send=OasisHost.prototype.sendLaunch;OasisHost.prototype.sendLaunch=function(){if(window.__qaThrowLaunch&&this.sessionId)throw Error('QA send after accepted session');return send.call(this);};createRoot(document.getElementById('root')).render(<React.StrictMode><Player/></React.StrictMode>);",resolveDir:new URL('../',import.meta.url).pathname,loader:'jsx'},bundle:true,write:false,format:'esm',platform:'browser',outdir:'fixture'});
const javascript=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text,css=bundle.outputFiles.find(file=>file.path.endsWith('.css')).text;
let browser;
try{
 for(const [name,type]of [['chromium',chromium],['webkit',webkit]].filter(([name])=>!process.env.PLAYER_QA_BROWSER||process.env.PLAYER_QA_BROWSER===name)){
  const errors=[],checks=[],requests=[],requestTrace=[],dir=new URL(name+'/',out);await mkdir(dir,{recursive:true});
  let heldWallet=[],holdWallet=false,walletFails=false,heldLaunch=[],holdLaunch=false,withholdLoaded=true;
  const waitHeld=async predicate=>{for(let i=0;i<1000;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('QA held request timeout');};
  browser=await type.launch({headless:true,...(name==='chromium'&&process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
  // Only this owned loopback fixture uses a freshly generated self-signed cert.
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,ignoreHTTPSErrors:true}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  fixture.setHandler(async(req,res)=>{
   const url=new URL(req.url,fixture.origin);assert.equal(url.origin,fixture.origin);requests.push(url.pathname);
   res.on('finish',()=>requestTrace.push({path:url.pathname,status:res.statusCode,cookiePresent:Boolean(req.headers.cookie),originPresent:Boolean(req.headers.origin)}));
   const html=(contentType,body)=>{res.writeHead(200,{'content-type':contentType,'cache-control':'no-store'});res.end(body);return true;};
   if(url.pathname==='/player')return html('text/html','<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');
   if(url.pathname==='/fixture.js')return html('text/javascript',javascript);
   if(url.pathname==='/fixture.css')return html('text/css',css);
   if(url.pathname==='/play/match')return html('text/html','<!doctype html><h1>隔离返回流程测试</h1><script src="/fixture-game.js"></script>');
   if(url.pathname==='/fixture-game.js')return html('text/javascript',`
    const nonce='wallet_return_nonce_12345678',base={protocol_version:1,game_id:'match',bridge_nonce:nonce};
    window.fixture={backRequests:0,roomId:null};let token;
    const api=async(path,body)=>{const r=await fetch(path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error('Fixture API '+r.status);return r.json();};
    const post=(type,extra={})=>parent.postMessage({...base,type,...extra},location.origin);
    addEventListener('message',async event=>{if(event.origin!==location.origin||event.source!==parent||event.data?.bridge_nonce!==nonce)return;
     if(event.data.type==='oasis.launch'){
      const r=await fetch('/v1/launch/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({launch_code:event.data.launch_code,game_id:'match',host_origin:location.origin,client_instance_id:'wallet_return_instance'})});
      const result=await r.json();if(!r.ok){post('oasis.error',{code:'EXCHANGE_FAILED'});return;}
      token=result.access_token;const state=await api('/api/arena/session');
      if(state.active_room_id)window.fixture.roomId=state.active_room_id;
      else{const room=await api('/api/pvp/rooms',{request_id:crypto.randomUUID().replaceAll('-',''),game_id:'match',capacity:2,practice:true});window.fixture.roomId=room.id;await api('/api/pvp/rooms/'+room.id+'/ready',{request_id:crypto.randomUUID().replaceAll('-','')});}
      if(${withholdLoaded})post('oasis.error',{code:'FIXTURE_BEFORE_LOADED'});else post('oasis.loaded');
     }
     if(event.data.type==='oasis.back')window.fixture.backRequests++;
    });
    window.fixture.finishReturn=async()=>{const result=await api('/api/pvp/rooms/'+window.fixture.roomId+'/leave',{request_id:crypto.randomUUID().replaceAll('-','')});post('oasis.return_requested',{status:result.status,return_url:'https://untrusted.invalid'});};
    post('oasis.ready');
   `);
   if(url.pathname==='/api/player/wallet'&&walletFails){fixture.send(res,503,{error:{code:'WALLET_UNAVAILABLE'}});return true;}
   if(url.pathname==='/api/player/wallet'&&holdWallet||url.pathname==='/api/player/launch'&&holdLaunch){
    const end=res.end.bind(res),held=url.pathname==='/api/player/wallet'?heldWallet:heldLaunch;
    res.end=(...args)=>{held.push(()=>{if(!res.destroyed)end(...args);});return res;};
   }
   return false;
  });
  const entry=fixture.origin+'/player?app_id='+fixture.app.id,username='wallet_browser_'+name,password='Wallet-browser-fixture-2026!';
  const login=async()=>{await page.getByLabel('账号',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();try{await page.locator('.player-games').waitFor();}catch(error){const failure={passed:false,browser:name,checks,errors,text:await page.locator('main').innerText(),requestTrace,cookies:(await context.cookies()).map(({name,domain,secure,httpOnly,sameSite})=>({name,domain,secure,httpOnly,sameSite}))};await writeFile(new URL('failure.json',dir),JSON.stringify(failure,null,2));console.log(JSON.stringify(failure,null,2));throw error;}};
  const balance=page.getByRole('region',{name:'账户余额'});
  await page.goto(entry);await page.getByRole('button',{name:'没有账号，创建账号'}).click();await page.getByLabel('账号',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'注册账号',exact:true}).click();await page.getByRole('status').filter({hasText:'账号已注册'}).waitFor();await login();
  await balance.getByText('0.00 COIN',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.OasisPlayerHost.requestBack()),false);
  assert.equal((await fixture.pool.query("SELECT count(*)::int count FROM wallet_ledger")).rows[0].count,0);checks.push('real register/login opens zero platform wallet, displays 0.00 and lobby returns synchronous false');
  for(const width of [360,390,430]){
   await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert((await page.locator('button').evaluateAll(elements=>elements.filter(e=>e.getClientRects().length).map(e=>e.getBoundingClientRect().height))).every(height=>height>=44));
  }
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:new URL('wallet-zero.png',dir).pathname});checks.push('360/390/430 mobile layouts have no horizontal overflow and touch targets >=44px');
  const user=(await fixture.pool.query('SELECT map.external_user_id FROM gp_player_app_ids map JOIN gp_players p ON p.id=map.player_id WHERE map.app_id=$1 AND p.username=$2',[fixture.app.id,username])).rows[0].external_user_id;
  await fixture.pool.query('UPDATE gp_apps SET currency_scale=6 WHERE id=$1',[fixture.app.id]);await fixture.pool.query('UPDATE wallet_scopes SET currency_scale=6 WHERE app_id=$1',[fixture.app.id]);
  await fixture.pool.query('UPDATE wallet_users SET available=1,reserved=2 WHERE external_user_id=$1',[user]);await page.reload();await balance.getByText('0.000001 COIN',{exact:true}).waitFor();assert.match(await balance.innerText(),/冻结 0\.000002 COIN/);await page.screenshot({path:new URL('wallet-scale-six.png',dir).pathname});checks.push('real wallet 1/2 minor at scale6 is displayed exactly without floats');
  holdWallet=true;await page.reload();await waitHeld(()=>heldWallet.length>0);await page.waitForFunction(()=>document.querySelector('[aria-label="账户余额"]')?.textContent.includes('正在读取余额'));
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('button',{name:'登录',exact:true}).waitFor();
  holdWallet=false;await fixture.pool.query('UPDATE wallet_users SET available=3,reserved=0 WHERE external_user_id=$1',[user]);await login();await balance.getByText('0.000003 COIN',{exact:true}).waitFor();await Promise.all(heldWallet.splice(0).map(fulfill=>fulfill()));await page.waitForTimeout(100);assert.match(await balance.innerText(),/可用 0\.000003 COIN/);assert.doesNotMatch(await balance.innerText(),/0\.000001/);checks.push('late aborted wallet responses from previous login cannot overwrite new-session balance');
  walletFails=true;await page.reload();await balance.getByRole('alert').waitFor();assert.equal(await balance.locator('strong').count(),0);assert.equal(await page.locator('.player-games').count(),1);
  walletFails=false;await balance.getByRole('button',{name:'重新读取余额'}).click();await balance.getByText('0.000003 COIN',{exact:true}).waitFor();checks.push('failed refresh shows unavailable without stale/fabricated zero and retries actual wallet');
  await fixture.pool.query('UPDATE wallet_users SET available=0,reserved=0 WHERE external_user_id=$1',[user]);await fixture.pool.query('UPDATE wallet_scopes SET currency_scale=2 WHERE app_id=$1',[fixture.app.id]);await fixture.pool.query('UPDATE gp_apps SET currency_scale=2 WHERE id=$1',[fixture.app.id]);
  await page.evaluate(()=>{window.__qaThrowLaunch=true;});holdLaunch=true;await page.getByRole('button',{name:'三消对战 进入游戏'}).click();await waitHeld(()=>heldLaunch.length>0);
  assert.equal(await page.evaluate(()=>window.OasisPlayerHost.requestBack()),true);assert.equal(await page.locator('.player-game[data-state=loading]').count(),1);assert.equal(await page.locator('iframe').count(),1);checks.push('native Back consumes pending launch without discarding possibly accepted intent');
  holdLaunch=false;await Promise.all(heldLaunch.splice(0).map(fulfill=>fulfill()));await page.locator('.player-game[data-state=error]').waitFor();
  const acceptedSession=(await fixture.pool.query('SELECT id FROM gp_sessions WHERE external_user_id=$1',[user])).rows[0].id;
  assert.equal(await page.evaluate(()=>window.OasisPlayerHost.requestBack()),true);await page.getByRole('status').filter({hasText:'原游戏尚未确认返回'}).waitFor();assert.equal(await page.locator('.player-game').count(),1);checks.push('actual SDK mount rejects after receiving real BFF session; Back retains accepted session rather than leaving lobby');
  await page.evaluate(()=>{window.__qaThrowLaunch=false;});await page.getByRole('button',{name:'重试连接',exact:true}).click();await page.locator('.player-game[data-state=error]').waitFor();let frame=page.frames().find(frame=>frame.url()===fixture.origin+'/play/match');assert(frame);
  assert.equal((await fixture.pool.query('SELECT count(*)::int count FROM gp_sessions WHERE external_user_id=$1',[user])).rows[0].count,1);assert(fixture.launches.some(value=>value.resume_session_id===acceptedSession));
  await frame.waitForFunction(()=>Boolean(window.fixture?.roomId));await page.locator('.player-game[data-state=error]').waitFor();
  const roomId=await frame.evaluate(()=>window.fixture.roomId);assert(roomId);assert.equal((await fixture.pool.query('SELECT status FROM pvp_rooms WHERE id=$1',[roomId])).rows[0].status,'active');
  assert.equal(await page.evaluate(()=>window.OasisPlayerHost.requestBack()),true);await page.getByRole('status').filter({hasText:'原游戏尚未确认返回'}).waitFor();assert.equal(await page.locator('iframe').count(),1);assert.equal(await frame.evaluate(()=>window.fixture.backRequests),0);checks.push('accepted session before loaded cannot return on error; original room remains recoverable');
  withholdLoaded=false;await page.getByRole('button',{name:'重试连接',exact:true}).click();await page.locator('.player-game[data-state=loaded]').waitFor();frame=page.frames().find(frame=>frame.url()===fixture.origin+'/play/match');
  assert.equal(await frame.evaluate(()=>window.fixture.roomId),roomId);assert.equal((await fixture.pool.query('SELECT count(*)::int count FROM pvp_rooms WHERE id=$1',[roomId])).rows[0].count,1);
  for(const bad of ['/player?app_id=other_app','/player?app_id='+fixture.app.id+'&token=bad','/demo/native/match?app_id='+fixture.app.id,'/player?app_id='+fixture.app.id+'#fragment']){
   await page.evaluate(url=>history.replaceState(null,'',url),bad);assert.equal(await page.evaluate(()=>window.OasisPlayerHost.requestBack()),false);
  }
  await page.evaluate(url=>history.replaceState(null,'',url),entry);assert.equal(await page.evaluate(()=>window.OasisPlayerHost.requestBack()),true);await frame.waitForFunction(()=>window.fixture.backRequests===1);
  assert.equal(await page.locator('.player-game[data-state=loaded]').count(),1);assert.equal((await fixture.pool.query('SELECT 1 FROM pvp_active_users WHERE room_id=$1',[roomId])).rowCount,1);checks.push('wrong URLs reject bridge; valid Back sends original SDK message and waits while authority room remains active');
  await frame.evaluate(()=>window.fixture.finishReturn());await page.locator('.player-games').waitFor();await balance.getByText('0.00 COIN',{exact:true}).waitFor();
  assert.equal(page.url(),entry);assert.equal(await page.locator('iframe').count(),0);assert.equal(await page.evaluate(()=>window.OasisPlayerHost.requestBack()),false);assert.equal((await fixture.pool.query('SELECT 1 FROM pvp_active_users WHERE room_id=$1',[roomId])).rowCount,0);
  assert.equal((await fixture.pool.query('SELECT count(*)::int count FROM wallet_ledger')).rows[0].count,0);assert(!requests.some(path=>path.startsWith('/api/demo/')||path.startsWith('/api/admin/')));assert.deepEqual(errors,[]);checks.push('only authoritative leave then return_requested releases game; owned lobby reloads real zero wallet, no credits or browser authority');
  const report={passed:true,browser:name,scope:'Real local HTTPS with owned temporary self-signed certificate (local fixture ignoreHTTPSErrors only), desktop browser mobile viewport, isolated production PostgreSQL+BFF+wallet+practice room; synthetic presentation, not public TLS/Android/iPhone/full-game acceptance',checks,errors,sourceSha256,requestTrace};
  await writeFile(new URL('report.json',dir),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await context.close();await browser.close();browser=null;
 }
}finally{await browser?.close();await fixture.close();}
