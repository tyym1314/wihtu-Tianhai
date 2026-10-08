import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium,webkit} from 'playwright';

// Real StrictMode/App/Login/API components, synthetic local HTTP responses only.
// Session/apps fetch deliberately ignores AbortSignal to exercise the generation
// guard independently of cooperative transport cancellation. No credentials,
// request bodies, cookies, real accounts or public services are recorded.
const root=fileURLToPath(new URL('../',import.meta.url));
const output=join(root,'review','console-session-race-ui',new Date().toISOString().replaceAll(':','-')+'-'+randomBytes(3).toString('hex'));
await mkdir(output,{recursive:true});
const cache=await mkdtemp(join(tmpdir(),'oasis-console-session-race-'));
const sourcePaths=['src/App.jsx','src/pages/Login.jsx','src/api.js','src/main.jsx'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const harnessSha=sha(await readFile(fileURLToPath(import.meta.url)));
const sources=async()=>Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,sha(await readFile(join(root,path)))])));
const before=await sources(),results=[],errors=[];
let server,browser;
const role=mode=>mode==='partner'?'partner_developer':'platform_admin';
const account=(mode,name)=>({id:name.toLowerCase().replaceAll(' ','_'),name,role:role(mode)});
const session=(mode,name,environment='sandbox')=>({user:account(mode,name),environment});
const chooseLabel=mode=>mode==='partner'?'合作方账号':'平台管理员';
const settleUI=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function until(check,message){const end=Date.now()+5000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error(message);}

async function fixture(mode,{holdInitialApps=false}={}){
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),requests=[],sessions=[],logins=[],logouts=[],apps=[];
 page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(mode=>{
  sessionStorage.setItem('oasis-console-mode',mode);
  const original=window.fetch,reads=[],operations=[];window.__consoleSessionRace={reads,operations};
  window.fetch=function(input,options){
   const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
   if(!/^\/api\/(admin|partner)\//.test(path))return Reflect.apply(original,this,[input,options]);
   const isSession=path.endsWith('/session');
   const row={number:isSession?reads.length+1:operations.length+1,path,hadSignal:Boolean(options?.signal),abortObserved:options?.signal?.aborted===true,bodyDone:false};operations.push(row);if(isSession)reads.push(row);
   options?.signal?.addEventListener('abort',()=>{row.abortObserved=true;},{once:true});
   return Reflect.apply(original,this,[input,isSession||path.endsWith('/apps')?{...options,signal:undefined}:options]).then(response=>{
    const json=response.json.bind(response);response.json=async()=>{const body=await json();row.bodyDone=true;return body;};return response;
   });
  };
 },mode);
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  const row={path,method:req.method()};requests.push(row);
  const handle={path,done:false,async reply(body,status=200){assert.equal(this.done,false,'Fixture response cannot be replayed');this.done=true;await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});}};
  if(path.endsWith('/session')){sessions.push(handle);return;}
  if(path.endsWith('/login')){logins.push(handle);return;}
  if(path.endsWith('/logout')){logouts.push(handle);return;}
  if(path.endsWith('/apps')){apps.push(handle);if(holdInitialApps&&logins.length===0)return;return handle.reply({apps:[]});}
  if(path.endsWith('/partner-accounts'))return handle.reply({accounts:[]});
  errors.push('Unexpected fixture API: '+path);await route.abort();
 });
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/#/partners');
 await until(()=>sessions.length===2,'Actual src/main.jsx StrictMode must start two initial reads');
 const readDone=async number=>{await page.waitForFunction(number=>window.__consoleSessionRace.reads[number-1]?.bodyDone,number);await settleUI(page);};
 const login=async(target,name)=>{
  await page.getByRole('button',{name:chooseLabel(target),exact:true}).click();
  await page.getByLabel('用户名',{exact:true}).fill(name);
  await page.getByLabel('密码',{exact:true}).fill('local-fixture-password');
  const form=await page.locator('.login-card').elementHandle(),count=sessions.length;
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  await until(()=>logins.length>0,'Login POST not dispatched');await settleUI(page);
  assert.equal(sessions.length,count,'No session GET may precede completion of login POST');
  assert.equal(await form.evaluate(element=>element.isConnected),true,'In-flight login form must not remount');
  assert.equal(await page.getByLabel('用户名',{exact:true}).inputValue(),name);
  assert.equal(await page.getByRole('button',{name:'正在验证…',exact:true}).isDisabled(),true);
  const request=logins.at(-1);assert.equal(request.path,`/api/${target}/login`);
  await request.reply({user:account(target,name)});
  await until(()=>sessions.length===count+1,'Successful login must read authoritative session once');
  assert.equal(sessions.at(-1).path,`/api/${target}/session`);
  return sessions.at(-1);
 };
 const userIs=async(name,environment,mode)=>{
  try{await page.waitForFunction(name=>document.querySelector('.sidebar-user')?.textContent.includes(name),name);}
  catch(error){error.observed=await page.evaluate(()=>({user:document.querySelector('.sidebar-user')?.textContent??null,environment:document.querySelector('[aria-label="当前后台环境"]')?.textContent??null,login:!!document.querySelector('.login-card'),mode:sessionStorage.getItem('oasis-console-mode')}));throw error;}
  assert.equal(await page.getByLabel('当前后台环境').innerText(),environment==='production'?'生产环境':'联调沙箱');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('oasis-console-mode')),mode);
  assert.equal(await page.getByRole('link',{name:'规则与收益',exact:true}).count(),mode==='partner'?0:1);
 };
 return{page,requests,sessions,logins,logouts,apps,readDone,login,userIs};
}

async function runCase(engine,name,fn){
 let context;
 try{context=await fn();results.push({engine,name,passed:true,...context});}
 catch(error){results.push({engine,name,passed:false,error:error.message,observed:error.observed});throw error;}
}

try{
 server=await createServer({root,cacheDir:cache,configFile:false,plugins:[react()],logLevel:'error',server:{host:'127.0.0.1',port:0}});await server.listen();
 for(const [engine,type]of [['chromium',chromium],['webkit',webkit]]){
  browser=await type.launch({headless:true});
  for(const [from,to]of [['admin','partner'],['partner','admin'],['admin','admin'],['partner','partner']]){
   await runCase(engine,`late initial ${from} session after ${to} login`,async()=>{
    const f=await fixture(from);
    try{
     await f.sessions[1].reply({user:null,environment:'sandbox'});await f.readDone(2);
     const fresh=await f.login(to,'NEW USER');await fresh.reply(session(to,'NEW USER'));
     await f.userIs('NEW USER','sandbox',to);
     await f.sessions[0].reply(session(from,'STALE USER','production'));await f.readDone(1);
     await f.userIs('NEW USER','sandbox',to);
     assert.equal(await f.page.getByText('STALE USER',{exact:true}).count(),0);
     const reads=await f.page.evaluate(()=>window.__consoleSessionRace.reads);
     assert.equal(reads[0].abortObserved,true,'Transport ignored a real cancellation');
     return{requests:f.requests,session_reads:reads,login_pending_form_preserved:true};
    }finally{await f.page.close();}
   });
  }
  for(const foreign of [false,true])await runCase(engine,`${foreign?'foreign':'current'} unauthorized during pending session`,async()=>{
   const f=await fixture('admin');
   try{
    await f.page.evaluate(mode=>window.dispatchEvent(new CustomEvent('oasis:unauthorized',{detail:{mode}})),foreign?'partner':'admin');await settleUI(f.page);
    await f.sessions[1].reply(session('admin','CURRENT USER'));await f.readDone(2);
    await f.sessions[0].reply(session('admin','STALE USER','production'));await f.readDone(1);
    if(foreign)await f.userIs('CURRENT USER','sandbox','admin');
    else{assert.equal(await f.page.locator('.sidebar-user').count(),0);assert.equal(await f.page.getByLabel('当前后台环境').count(),0);await f.page.getByRole('button',{name:'登录工作台',exact:true}).waitFor();}
    return{requests:f.requests};
   }finally{await f.page.close();}
  });
  for(const [nextMode,status]of [['partner',200],['admin',200],['admin',401]])await runCase(engine,`late logout ${status} after ${nextMode} reauthentication`,async()=>{
   const f=await fixture('admin');
   try{
    await f.sessions[1].reply(session('admin','OLD USER'));await f.readDone(2);await f.userIs('OLD USER','sandbox','admin');
    await f.sessions[0].reply(session('admin','STALE USER','production'));await f.readDone(1);
    await f.page.getByRole('button',{name:'退出登录',exact:true}).click();await until(()=>f.logouts.length===1,'Logout POST not dispatched');
    await f.page.evaluate(()=>window.dispatchEvent(new CustomEvent('oasis:unauthorized',{detail:{mode:'admin'}})));await settleUI(f.page);
    const fresh=await f.login(nextMode,'NEW USER');await fresh.reply(session(nextMode,'NEW USER'));await f.userIs('NEW USER','sandbox',nextMode);
    await f.logouts[0].reply(status===200?{ok:true}:{error:{code:'LOGIN_REQUIRED',message:'Old session expired'}},status);
    await f.page.waitForFunction(()=>window.__consoleSessionRace.operations.some(row=>row.path.endsWith('/logout')&&row.bodyDone));
    // The consumed JSON and any synchronous unauthorized event precede these RAFs.
    await settleUI(f.page);await f.userIs('NEW USER','sandbox',nextMode);
    return{requests:f.requests};
   }finally{await f.page.close();}
  });
  for(const stale of [true,false])await runCase(engine,`${stale?'stale':'current'} ordinary apps GET 401`,async()=>{
   const f=await fixture('admin',{holdInitialApps:true});
   try{
    await f.sessions[1].reply(session('admin','OLD USER'));await f.readDone(2);await f.userIs('OLD USER','sandbox','admin');
    await f.sessions[0].reply(session('admin','STALE USER','production'));await f.readDone(1);
    await until(()=>f.apps.length>0,'Ordinary apps GET must be in flight');
    const old=[...f.apps];
    if(stale){
     await f.page.evaluate(()=>window.dispatchEvent(new CustomEvent('oasis:unauthorized',{detail:{mode:'admin'}})));await settleUI(f.page);
     const fresh=await f.login('admin','NEW USER');await fresh.reply(session('admin','NEW USER'));await f.userIs('NEW USER','sandbox','admin');
    }
    for(const request of old)await request.reply({error:{code:'LOGIN_REQUIRED',message:'Session expired'}},401);
    await f.page.waitForFunction(()=>window.__consoleSessionRace.operations.filter(row=>row.path.endsWith('/apps')).every(row=>row.bodyDone));await settleUI(f.page);
    if(stale)await f.userIs('NEW USER','sandbox','admin');
    else{assert.equal(await f.page.locator('.sidebar-user').count(),0);assert.equal(await f.page.getByLabel('当前后台环境').count(),0);await f.page.getByRole('button',{name:'登录工作台',exact:true}).waitFor();}
    const operations=await f.page.evaluate(()=>window.__consoleSessionRace.operations);
    if(stale)assert.equal(operations.find(row=>row.path.endsWith('/apps')).abortObserved,true,'Old business transport ignored a real cancellation');
    return{requests:f.requests,operations};
   }finally{await f.page.close();}
  });
  await browser.close();browser=null;
 }
 assert.deepEqual(errors,[]);assert.deepEqual(await sources(),before,'Source changed during the test');
 await writeFile(join(output,'report.json'),JSON.stringify({passed:true,harness_sha256:harnessSha,cases:results,errors,sources:before,scope:'Local synthetic HTTP/API identity-race regression using actual StrictMode and Login components. Session/apps transport ignores cancellation deliberately. No public service or device.'},null,2)+'\n');
 console.log(JSON.stringify({passed:true,cases:results.length,report:join(output,'report.json')}));
}catch(error){
 await writeFile(join(output,'failure.json'),JSON.stringify({passed:false,harness_sha256:harnessSha,message:error.message,stack:error.stack,cases:results,errors,sources_before:before,sources_after:await sources()},null,2)+'\n');
 console.error(JSON.stringify({passed:false,cases:results.length,output,message:error.message}));process.exitCode=1;
}finally{await browser?.close();await server?.close();await rm(cache,{recursive:true,force:true});}
