import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {installNativeFetchProbe,observeNativeBrowser,nativeErrorsEmpty,reserveNativeReportDirectory} from '../deploy/native-browser-checks.mjs';

const out=resolve(process.env.OASIS_NATIVE_FETCH_FIXTURE_OUT||fileURLToPath(new URL(`../review/deployment/native-fetch-fixture-${Date.now()}-${randomUUID().slice(0,8)}/`,import.meta.url)));
const report={schema:'native-fetch-local-fixture-v1',started_at:new Date().toISOString(),scope:'Loopback HTTP and desktop Chrome only; no public service, device or build',cases:[],passed:false};
const room={id:'owned',game_id:'run',me:'fixture_player',entry_minor:'0',practice:true,status:'active',version:1};
let active,browser;
const server=http.createServer((req,res)=>{
 if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
 if(req.url.startsWith('/api/')||req.url.startsWith('/arena/assets/')){
  const row={method:req.method,path:req.url,headers:Object.fromEntries(Object.entries(req.headers).sort(([a],[b])=>a.localeCompare(b))),body:''};active.wire.push(row);
  req.on('data',chunk=>{row.body+=chunk;});
  req.on('end',()=>{
   active.held.push(res);
   if(active.mode==='normal'||active.mode==='retry'&&active.held.length===1){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(room));}
   else if(active.mode==='headers'){res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();res.write('{"id":');}
  });return;
 }
 res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});
 res.end(req.url==='/host'?'<iframe src="/play/run"></iframe>':'<!doctype html><title>Fetch cancellation fixture</title>');
});
const waitFor=async(predicate,label)=>{const end=Date.now()+5000;while(!await predicate()){assert.ok(Date.now()<end,`Fixture timeout: ${label}`);await new Promise(resolve=>setTimeout(resolve,5));}};
await reserveNativeReportDirectory(out,report);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
async function run(name,{mode='hold',probe=true}={},work){
 active={mode,wire:[],held:[]};
 const context=await browser.newContext(),evidence=probe?await installNativeFetchProbe(context):null,page=await context.newPage();
 await evidence?.attach(page);
 const state={game:'run',sessionId:'fixture_session',playerId:'fixture_player',ownedRooms:new Set(['owned']),phase:'playing'},result={name};
 result.request_timings=[];page.on('requestfailed',request=>result.request_timings.push({path:new URL(request.url()).pathname,timing:request.timing()}));
 const drain=observeNativeBrowser(page,{origin,state,result,fetchProbe:evidence,drainTimeoutMs:5000});
 try{
  await page.goto(origin+'/host');const frame=page.frames().find(frame=>frame.url()===origin+'/play/run');assert.ok(frame);
  await frame.evaluate(()=>{window.fixture={controllers:[],done:[],headers:0};});
  const start=async(options={})=>frame.evaluate(({count=1,method='GET',retry=false,preAborted=false,preAbortedReason='OASIS_ROOM_POLL_STOPPED',preAbortedName='AbortError'})=>{
   const controller=new AbortController();window.fixture.controllers.push(controller);
   if(preAborted)controller.abort(new DOMException(preAbortedReason,preAbortedName));
   const send=async()=>{const response=await fetch('/api/pvp/rooms/owned'+(method==='POST'?'/action':''),{method,cache:'no-store',signal:controller.signal,...(method==='POST'?{headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:'fixture_action',seq:1,action:{type:'jump'}})}:{})});window.fixture.headers++;return response.json();};
   for(let index=0;index<count;index++)void(async()=>{try{await send();if(retry){await new Promise(resolve=>setTimeout(resolve,10));await send();}window.fixture.done.push('ok');}catch(error){window.fixture.done.push({name:error.name,message:error.message});}})();
  },options);
  const abort=async(reason='OASIS_ROOM_POLL_STOPPED',name='AbortError',index=0)=>frame.evaluate(({reason,name,index})=>window.fixture.controllers[index].abort(new DOMException(reason,name)),{reason,name,index});
  await work({page,frame,start,abort,result,drain,context});
  await drain();result.wire=active.wire;result.checked=true;report.cases.push(result);
 }catch(error){result.fixture_error=error.stack;result.wire=active.wire;report.cases.push(result);throw error;}
 finally{for(const res of active.held)res.destroy();await context.close();await fs.writeFile(resolve(out,'native-browser.json'),JSON.stringify(report,null,2)+'\n');}
 return result;
}
try{
 browser=await chromium.launch({channel:'chrome',headless:true});report.browser=browser.version();
 for(const reason of ['OASIS_ROOM_POLL_STOPPED','OASIS_ROOM_POLL_BACKGROUND'])await run(reason,{},async({start,abort,result,drain})=>{
  await start();await waitFor(()=>active.held.length===1,'server received GET');await abort(reason);await waitFor(()=>result.network_observations.length===1,'network cancellation');await drain();
  assert.equal(result.lifecycle_cancellations.length,1,JSON.stringify(result));assert.equal(result.network_observations.length,1);assert.equal(nativeErrorsEmpty(result),true);assert.equal(result.lifecycle_cancellations[0].reason.message,reason);
 });
 await run('timeout remains timeout after stopped',{},async({start,abort,result,drain})=>{
  await start();await waitFor(()=>active.held.length===1,'server received GET');await abort('OASIS_ROOM_POLL_TIMEOUT','TimeoutError');await abort();await waitFor(()=>result.network_observations.length===1,'timeout failure');await drain();
  assert.equal(result.lifecycle_cancellations.length,0);assert.equal(result.network_errors.length,1);assert.equal(result.fetch_observations.find(event=>event.kind==='abort').reason.name,'TimeoutError');
 });
 await run('mutation cancellation remains failure',{},async({start,abort,result,drain})=>{
  await start({method:'POST'});await waitFor(()=>active.held.length===1,'server received POST');await abort();await waitFor(()=>result.network_observations.length===1,'POST failure');await drain();
  assert.equal(result.lifecycle_cancellations.length,0);assert.equal(result.network_errors.length,1);assert.equal(active.wire[0].method,'POST');
 });
 await run('response body loss remains failure',{mode:'headers'},async({start,abort,frame,result,drain})=>{
  await start();await waitFor(()=>frame.evaluate(()=>window.fixture.headers===1),'fetch fulfilled with response headers');await abort();await waitFor(()=>result.observer_errors.length>0,'response JSON loss');await drain();
  assert.equal(result.lifecycle_cancellations.length,0);assert.equal(nativeErrorsEmpty(result),false);assert.ok(result.fetch_observations.some(event=>event.kind==='fulfilled'));
 });
 await run('model fetch body loss remains failure',{mode:'headers'},async({frame,result,drain})=>{
  await frame.evaluate(()=>{window.controller=new AbortController();void(async()=>{try{const response=await fetch('/arena/assets/model-1234abcd.glb',{signal:window.controller.signal});window.fixture.headers++;await response.arrayBuffer();}catch{window.fixture.done.push('caught');}})();});
  await waitFor(()=>frame.evaluate(()=>window.fixture.headers===1),'model response headers');await frame.evaluate(()=>window.controller.abort(new DOMException('OASIS_ROOM_POLL_STOPPED','AbortError')));await waitFor(()=>result.network_observations.length===1,'model body transfer failed');await drain();
  assert.equal(result.lifecycle_cancellations.length,0);assert.equal(result.network_errors.length,1);assert.equal(nativeErrorsEmpty(result),false);assert.ok(result.fetch_observations.some(event=>event.kind==='fulfilled'));
 });
 await run('same signal sequential GET retry is distinct',{mode:'retry'},async({start,abort,result,drain})=>{
  await start({retry:true});await waitFor(()=>active.held.length===2,'retry reached server');await abort();await waitFor(()=>result.network_observations.length===1,'retry cancelled');await drain();
  assert.equal(result.lifecycle_cancellations.length,1,JSON.stringify(result));assert.equal(nativeErrorsEmpty(result),true);assert.equal(result.fetch_observations.filter(event=>event.kind==='start').length,2);assert.equal(result.lifecycle_cancellations[0].fetch_attempt_id,2);
 });
 await run('two sequential identical cancellations remain ambiguous',{},async({start,abort,result,drain})=>{
  await start();await waitFor(()=>active.held.length===1,'first sequential GET');await abort();await waitFor(()=>result.network_observations.length===1,'first sequential failure');await drain();assert.equal(result.lifecycle_cancellations.length,1);
  const original=result.network_observations[0];await start();await waitFor(()=>active.held.length===2,'second sequential GET');await abort('OASIS_ROOM_POLL_STOPPED','AbortError',1);await waitFor(()=>result.network_observations.length===2,'second sequential failure');await drain();
  assert.equal(result.lifecycle_cancellations.length,0);assert.equal(result.network_errors.length,2);assert.equal(result.network_observations[0],original);assert.equal(result.network_errors[0].classification_failure,'AMBIGUOUS_CDP_NETWORK_FAILURE');assert.ok(result.network_errors[0].previous_lifecycle_classification);assert.equal(nativeErrorsEmpty(result),false);
 });
 await run('concurrent identical GETs cannot borrow proof',{},async({start,abort,result,drain})=>{
  await start();await start();await waitFor(()=>active.held.length===2,'both GETs received');await abort();active.held[1].destroy();await waitFor(()=>result.network_observations.length===2,'both GETs failed');await drain();
  assert.ok(result.lifecycle_cancellations.length<=1);assert.ok(result.network_errors.length>=1);assert.equal(result.network_errors.length+result.lifecycle_cancellations.length,2);assert.ok(result.network_errors.some(error=>error.error!=='net::ERR_ABORTED'));
 });
 await run('pre-aborted fetch cannot excuse another request',{},async({start,abort,result,drain})=>{
  await start({preAborted:true});await start();await waitFor(()=>active.held.length===1,'only live GET reached server');await abort('UNKNOWN_ABORT','AbortError',1);await waitFor(()=>result.network_observations.length>=1,'unknown failure');await drain();
  assert.equal(result.lifecycle_cancellations.length,0);assert.ok(result.network_errors.length>=1);assert.equal(nativeErrorsEmpty(result),false);
 });
 for(const [name,reason] of [['TimeoutError','OASIS_ROOM_POLL_TIMEOUT'],['AbortError','OASIS_ROOM_POLL_STOPPED']])await run(`networkless pre-aborted ${name} remains failure`,{},async({start,frame,result,drain})=>{
  await start({preAborted:true,preAbortedName:name,preAbortedReason:reason});await waitFor(()=>frame.evaluate(()=>window.fixture.done.length===1),'pre-aborted rejection caught by caller');await drain();
  assert.equal(active.wire.length,0);assert.equal(result.lifecycle_cancellations.length,0);assert.equal(result.unmatched_fetch_rejections.length,1);assert.equal(result.unmatched_fetch_rejections[0].reason.name,name);assert.equal(nativeErrorsEmpty(result),false);
 });
 await run('invalid GET body rejection remains failure without a network request',{},async({frame,result,drain})=>{
  await frame.evaluate(async()=>{try{await fetch('/api/pvp/rooms/owned',{method:'GET',body:'invalid body'});}catch{}});await drain();assert.equal(active.wire.length,0);assert.equal(result.unmatched_fetch_rejections.length,1);assert.equal(result.unmatched_fetch_rejections[0].error.name,'TypeError');assert.equal(nativeErrorsEmpty(result),false);
 });
 await run('detached frame without terminal evidence fails',{},async({start,page,result,drain})=>{
  await start();await waitFor(()=>active.held.length===1,'GET received before detach');await page.locator('iframe').evaluate(element=>element.remove());await waitFor(()=>result.network_observations.length===1,'detached GET failed');await drain();
  assert.equal(result.lifecycle_cancellations.length,0);assert.equal(result.network_errors.length,1);
 });
 await run('identical URLs in separate frames retain distinct reasons',{},async({start,abort,page,frame,result,drain})=>{
  await page.evaluate(()=>{const child=document.createElement('iframe');child.src='/play/run';document.body.append(child);});await waitFor(()=>page.frames().filter(item=>item.url()===origin+'/play/run').length===2,'second game frame');
  const second=page.frames().find(item=>item!==frame&&item.url()===origin+'/play/run');await start();
  await second.evaluate(()=>{window.controller=new AbortController();void fetch('/api/pvp/rooms/owned',{cache:'no-store',signal:window.controller.signal}).catch(()=>{});});
  await waitFor(()=>active.held.length===2,'both frames reached server');await abort();await second.evaluate(()=>window.controller.abort(new DOMException('UNKNOWN_ABORT','AbortError')));await waitFor(()=>result.network_observations.length===2,'both frames cancelled');await drain();
  assert.equal(result.lifecycle_cancellations.length,1,JSON.stringify(result));assert.equal(result.network_errors.length,1);assert.equal(new Set(result.network_observations.map(value=>value.frame_id)).size,2);
 });
 await run('probe preserves unhandled fetch rejections',{},async({frame,result,drain})=>{
  await frame.evaluate(()=>{window.controller=new AbortController();void fetch('/api/pvp/rooms/owned',{cache:'no-store',signal:window.controller.signal});});await waitFor(()=>active.held.length===1,'unhandled GET received');await frame.evaluate(()=>window.controller.abort(new DOMException('OASIS_ROOM_POLL_STOPPED','AbortError')));
  await waitFor(()=>result.network_observations.length===1&&result.js_errors.length>0,'unhandled rejection remains visible');await drain();assert.equal(result.lifecycle_cancellations.length,1);assert.equal(nativeErrorsEmpty(result),false);
 });
 const baseline=await run('wire baseline',{mode:'normal',probe:false},async({start,frame})=>{await start();await waitFor(()=>frame.evaluate(()=>window.fixture.done.length===1),'baseline body');});
 const instrumented=await run('instrumented wire unchanged',{mode:'normal'},async({start,frame})=>{await start();await waitFor(()=>frame.evaluate(()=>window.fixture.done.length===1),'instrumented body');});
 assert.deepEqual(instrumented.wire,baseline.wire);report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));report.finished_at=new Date().toISOString();await fs.writeFile(resolve(out,'native-browser.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,report:resolve(out,'native-browser.json')}));}
