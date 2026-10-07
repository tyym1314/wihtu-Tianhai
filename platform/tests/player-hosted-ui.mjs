import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {createPlayerFixture} from './player-hosted-fixture.mjs';

const fixture=await createPlayerFixture(),out=new URL('../review/player-hosted/',import.meta.url),errors=[],requests=[],checks=[];
await mkdir(out,{recursive:true});
const bundle=await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import App from './src/App.jsx';import './src/styles.css';createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);",resolveDir:new URL('../',import.meta.url).pathname,loader:'jsx'},bundle:true,write:false,format:'esm',platform:'browser',outdir:'fixture'});
const javascript=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text,css=bundle.outputFiles.find(file=>file.path.endsWith('.css')).text;
let browser,lostLaunch=false,recoveryUnavailable=true;
try{
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());assert.equal(url.origin,fixture.origin);requests.push(url.pathname);
  if(url.pathname==='/player')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>'});
  if(url.pathname==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:javascript});
  if(url.pathname==='/fixture.css')return route.fulfill({contentType:'text/css',body:css});
  if(url.pathname==='/api/player/recovery'&&recoveryUnavailable){recoveryUnavailable=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEMPORARILY_UNAVAILABLE'}})});}
  if(url.pathname==='/play/match')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#123f34;color:white;font:16px system-ui}button{min-height:48px;margin:20px;font:inherit}</style><h1>隔离游戏桥接测试</h1><button id="reauth">恢复原游戏</button><button id="return">返回大厅</button><output id="status">等待授权</output><script src="/fixture-game.js"></script>'});
  if(url.pathname==='/fixture-game.js')return route.fulfill({contentType:'text/javascript',body:`
   const nonce='hosted_player_nonce_12345678',base={protocol_version:1,game_id:'match',bridge_nonce:nonce};
   window.fixture={loaded:0,sessions:[],roomId:null};let token;
   const api=async(path,body)=>{const response=await fetch(path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw Error('Fixture game request failed '+response.status);return response.json();};
   const post=(type,extra={})=>parent.postMessage({...base,type,...extra},location.origin);
   addEventListener('message',async event=>{if(event.origin!==location.origin||event.source!==parent||event.data?.bridge_nonce!==nonce)return;
    if(event.data.type==='oasis.launch'){
     const response=await fetch('/v1/launch/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({launch_code:event.data.launch_code,game_id:'match',host_origin:location.origin,client_instance_id:'hosted_fixture_instance'})});
     const result=await response.json();if(!response.ok){post('oasis.error',{code:'EXCHANGE_FAILED'});return;}
     token=result.access_token;const state=await api('/api/arena/session');
     if(state.active_room_id)window.fixture.roomId=state.active_room_id;
     else{const room=await api('/api/pvp/rooms',{request_id:crypto.randomUUID().replaceAll('-',''),game_id:'match',capacity:2,practice:true});window.fixture.roomId=room.id;await api('/api/pvp/rooms/'+room.id+'/ready',{request_id:crypto.randomUUID().replaceAll('-','')});}
     window.fixture.loaded++;window.fixture.sessions.push(result.session_id);document.querySelector('#status').textContent='已连接';post('oasis.loaded');
    }
    if(event.data.type==='oasis.back')post('oasis.return_requested',{return_url:'https://untrusted.invalid'});
   });
   document.querySelector('#reauth').onclick=()=>post('oasis.reauth_required');
   document.querySelector('#return').onclick=async()=>{await api('/api/pvp/rooms/'+window.fixture.roomId+'/leave',{request_id:crypto.randomUUID().replaceAll('-','')});post('oasis.return_requested',{return_url:'https://untrusted.invalid'});};
   post('oasis.ready');
  `});
  const result=await new Promise((resolve,reject)=>{
   const headers={...req.headers()};delete headers['content-length'];
   const forwarded=request(fixture.base+url.pathname+url.search,{method:req.method(),headers},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));});
   forwarded.on('error',reject);forwarded.end(req.postDataBuffer());
  });
  if(url.pathname==='/api/player/launch'&&result.status===201&&!lostLaunch){lostLaunch=true;return route.abort('connectionreset');}
  const headers=Object.fromEntries(Object.entries(result.headers).filter(([key])=>!['connection','keep-alive','transfer-encoding','content-length'].includes(key)).map(([key,value])=>[key,Array.isArray(value)?value.join('\n'):String(value)]));
  return route.fulfill({status:result.status,headers,body:result.body});
 });
 const entry=fixture.origin+'/player?app_id='+fixture.app.id,username='hosted_browser_player',password='Hosted-browser-fixture-2026!';
 fixture.runtime.production=false;
 await page.goto(entry);await page.getByRole('alert').filter({hasText:'此玩家入口暂不可用'}).waitFor();assert.equal(await page.locator('input').count(),0);assert(!requests.some(value=>value.startsWith('/api/demo/')));checks.push('sandbox entry is visibly unavailable with no demo or admin fallback');
 fixture.runtime.production=true;await page.reload();await page.getByRole('button',{name:'没有账号，创建账号'}).click();
 await page.getByLabel('账号',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'注册账号',exact:true}).click();
 await page.getByRole('status').filter({hasText:'账号已注册'}).waitFor();assert.equal(await page.getByLabel('密码',{exact:true}).inputValue(),'');
 await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('alert').filter({hasText:'连接暂时未完成'}).waitFor();
 assert.equal(await page.locator('.player-games').count(),0);assert.equal(await page.getByLabel('密码',{exact:true}).inputValue(),'');
 await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.player-games').waitFor();checks.push('a recovery-service 503 after login remains visible with a working retry and cleared password input');
 assert.equal(await page.locator('.player-game-card').count(),2);assert.equal((await context.cookies()).filter(cookie=>cookie.name==='__Host-oasis_player').every(cookie=>cookie.httpOnly&&cookie.secure&&cookie.sameSite==='Strict'),true);
 checks.push('real production BFF registers and logs in, sets Secure HttpOnly cookie and displays only App game entitlement');
 for(const width of [360,390,430]){
  await page.setViewportSize({width,height:844});const layout=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,targets:[...document.querySelectorAll('button,input')].filter(element=>element.getClientRects().length).map(element=>element.getBoundingClientRect().height)}));
  assert.equal(layout.overflow,false);assert(layout.targets.every(height=>height>=44));await page.screenshot({path:new URL('lobby-'+width+'.png',out).pathname});
 }
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'三消对战 进入游戏'}).click();
 await page.locator('.player-game[data-state=loaded]').waitFor();let frame=page.frames().find(frame=>frame.url()===fixture.origin+'/play/match');assert(frame);
 const firstSession=fixture.launches[0];assert(fixture.launches.length>=2);assert(fixture.launches.filter(body=>!body.resume_session_id).every(body=>body.request_id===firstSession.request_id));
 assert.equal((await fixture.pool.query('SELECT count(*)::int count FROM gp_sessions')).rows[0].count,1);
 assert.deepEqual(await page.evaluate(()=>{const bounds=document.querySelector('iframe').getBoundingClientRect();return{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height};}),{x:0,y:0,width:390,height:844});
 checks.push('lost launch response retries the same intent; one real session and real single-use exchange load a full-viewport SDK fixture');
 const originalRoom=(await fixture.pool.query('SELECT id,status FROM pvp_rooms')).rows[0];assert.equal(originalRoom.status,'active');
 fixture.runtime.admissionEnabled=false;
 await frame.locator('#reauth').click();await frame.waitForFunction(()=>window.fixture.loaded===2);assert.equal(fixture.launches.at(-1).resume_session_id,(await fixture.pool.query('SELECT id FROM gp_sessions')).rows[0].id);
 await fixture.pool.query('DELETE FROM gp_player_sessions');await page.reload();await page.getByRole('button',{name:'登录',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'没有账号，创建账号'}).count(),0);
 await page.getByLabel('账号',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('button',{name:'恢复 三消对战'}).waitFor();assert.equal(await page.locator('.player-game-card:disabled').count(),2);
 await page.getByRole('button',{name:'恢复 三消对战'}).click();await page.locator('.player-game[data-state=loaded]').waitFor();frame=page.frames().find(frame=>frame.url()===fixture.origin+'/play/match');
 assert.equal(await frame.evaluate(()=>window.fixture.roomId),originalRoom.id);assert.equal((await fixture.pool.query('SELECT count(*)::int count FROM pvp_rooms')).rows[0].count,1);assert.equal((await fixture.pool.query('SELECT count(*)::int count FROM gp_sessions')).rows[0].count,1);
 checks.push('real active practice room survives page refresh and expired login; closed-admission recovery reads owned session from backend and resumes the same room');
 await fixture.pool.query('DELETE FROM gp_player_sessions');await frame.locator('#reauth').click();await page.getByRole('dialog',{name:'重新登录'}).waitFor();
 assert.equal(await page.getByLabel('账号',{exact:true}).inputValue(),username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('dialog',{name:'重新登录'}).waitFor({state:'hidden'});await page.locator('.player-game[data-state=loaded]').waitFor();frame=page.frames().find(frame=>frame.url()===fixture.origin+'/play/match');
 assert.equal((await fixture.pool.query('SELECT count(*)::int count FROM gp_sessions')).rows[0].count,1);checks.push('closed admission preserves accepted-session reauthorization, including real login expiry and same-account recovery');
 await frame.locator('#return').click();await page.locator('.player-games').waitFor();assert.equal(page.url(),entry);assert.equal(await page.locator('iframe').count(),0);assert.equal(await page.locator('.player-game-card:disabled').count(),2);
 assert.equal((await fixture.pool.query('SELECT count(*)::int count FROM pvp_active_users')).rows[0].count,0);assert.equal(await page.getByRole('button',{name:'恢复 三消对战'}).count(),0);
 assert.deepEqual(await page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage),cookie:document.cookie})),{local:[],session:[],cookie:''});
 assert.equal((await fixture.pool.query('SELECT available::text FROM wallet_users')).rows[0].available,'0');assert.equal((await fixture.pool.query('SELECT count(*)::int count FROM wallet_ledger')).rows[0].count,0);
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('button',{name:'登录',exact:true}).waitFor();assert.equal((await context.cookies()).filter(cookie=>cookie.name==='__Host-oasis_player').length,0);
 assert(!requests.some(value=>value.startsWith('/api/admin/')||value.startsWith('/api/demo/')));assert.deepEqual(errors,[]);checks.push('return remains in owned lobby; closed games disabled; logout revokes real session; no browser storage or funded ledger');
 const report={passed:true,scope:'Isolated PostgreSQL production BFF + platform zero-balance wallet + real active practice room + React entry + real OasisHost and one-use exchange; synthetic game presentation, not full-game or device certification',checks,errors};
 await writeFile(new URL('ui-validation.json',out),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await context.close();
}finally{await browser?.close();await fixture.close();}
