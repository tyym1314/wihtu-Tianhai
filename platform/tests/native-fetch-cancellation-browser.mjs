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
const room={id:'owned',game_id:'run',me:'fixture_player',entry_minor:'0',practice:true,status:'active',version:1,game:{gameId:'run',me:'fixture_player',ruleVersion:'run-fixture',physicsVersion:'physics-fixture',snapshotTick:1}};
let active,browser;
const server=http.createServer((req,res)=>{
 if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
 if(req.url==='/health'||req.url.startsWith('/health?')){
  const status=req.url==='/health'?200:404;
  active.probes.push({method:req.method,path:req.url,status,headers:Object.fromEntries(Object.entries(req.headers).sort(([a],[b])=>a.localeCompare(b)))});
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(status===200?'{"status":"ok"}':'{"error":"NOT_FOUND"}');return;
 }
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
async function run(name,{mode='hold',probe=true,fetchMode=null}={},work){
 active={mode,wire:[],held:[],probes:[]};
 const context=await browser.newContext();
 if(fetchMode){const install=context.addInitScript.bind(context);context.addInitScript=(fn,args)=>install(({source,args})=>{globalThis.__fixtureOriginalFetch=globalThis.fetch.bind(globalThis);globalThis.__fixtureProbeBinding=args.bindingName;(0,eval)(`(${source})`)(args);},{source:fn.toString(),args});}
 const evidence=probe?await installNativeFetchProbe(context):null,page=await context.newPage();
 await evidence?.attach(page);
 const state={game:'run',sessionId:'fixture_session',playerId:'fixture_player',ownedRooms:new Set(['owned']),phase:'playing'},result={name};
 result.request_timings=[];page.on('requestfailed',request=>result.request_timings.push({path:new URL(request.url()).pathname,timing:request.timing()}));
 const drain=observeNativeBrowser(page,{origin,state,result,fetchProbe:evidence,drainTimeoutMs:5000});
 try{
  if(evidence){result.initial_probe_installation=await evidence.requireInstalled(page.mainFrame());assert.equal(result.initial_probe_installation.frame_url,'about:blank');assert.deepEqual(result.js_errors,[]);}
  await page.goto(origin+'/host');const frame=page.frames().find(frame=>frame.url()===origin+'/play/run');assert.ok(frame);
  if(fetchMode)await frame.evaluate(mode=>{
   if(mode==='delegate'){const nativeFetch=globalThis.fetch.bind(globalThis);globalThis.fetch=async(input,init)=>{const original=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);if(original.pathname.startsWith('/api/legacy/'))return nativeFetch('/api/play/tiger/'+original.pathname.slice('/api/legacy/'.length),init);return nativeFetch(input,init);};}
   if(mode==='bypass')globalThis.fetch=globalThis.__fixtureOriginalFetch;
   if(mode==='drop-binding')globalThis[globalThis.__fixtureProbeBinding]=async()=>{};
  },fetchMode);
  if(fetchMode==='extra-health')await frame.evaluate(async()=>{const response=await fetch('/health',{cache:'no-store'});await response.text();});
  if(evidence){
   if(['bypass','drop-binding','extra-health'].includes(fetchMode)){await assert.rejects(evidence.requireInstalled(frame),/FETCH_PROBE_CHALLENGE_FAILED/);result.expected_installation_failure=true;}
   else result.game_probe_installation=await evidence.requireInstalled(frame);
  }
  await frame.evaluate(()=>{window.fixture={controllers:[],done:[],headers:0};});
  const start=async(options={})=>frame.evaluate(({count=1,method='GET',retry=false,preAborted=false,preAbortedReason='OASIS_ROOM_POLL_STOPPED',preAbortedName='AbortError'})=>{
   const controller=new AbortController();window.fixture.controllers.push(controller);
   if(preAborted)controller.abort(new DOMException(preAbortedReason,preAbortedName));
   const send=async()=>{const response=await fetch('/api/pvp/rooms/owned'+(method==='POST'?'/action':''),{method,cache:'no-store',signal:controller.signal,...(method==='POST'?{headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:'fixture_action',seq:1,action:{type:'jump'}})}:{})});window.fixture.headers++;return response.json();};
   for(let index=0;index<count;index++)void(async()=>{try{await send();if(retry){await new Promise(resolve=>setTimeout(resolve,10));await send();}window.fixture.done.push('ok');}catch(error){window.fixture.done.push({name:error.name,message:error.message});}})();
  },options);
  const abort=async(reason='OASIS_ROOM_POLL_STOPPED',name='AbortError',index=0)=>frame.evaluate(({reason,name,index})=>window.fixture.controllers[index].abort(new DOMException(reason,name)),{reason,name,index});
  await work({page,frame,start,abort,result,drain,context});
  await drain();result.wire=active.wire;result.probe_wire=active.probes;result.checked=true;report.cases.push(result);
 }catch(error){result.fixture_error=error.stack;result.wire=active.wire;report.cases.push(result);throw error;}
 finally{for(const res of active.held)res.destroy();await context.close();await fs.writeFile(resolve(out,'native-browser.json'),JSON.stringify(report,null,2)+'\n');}
 return result;
}
try{
 browser=await chromium.launch({channel:'chrome',headless:true});report.browser=browser.version();
 await run('legacy-style delegation proves the installed probe with one read-only health request',{mode:'normal',fetchMode:'delegate'},async({start,frame,result,drain})=>{
  assert.equal(result.game_probe_installation.fetch_wrapper_intact,false);assert.equal(result.game_probe_installation.challenge.passed,true);assert.equal(active.probes.length,1);
  assert.equal(active.probes[0].method,'GET');assert.equal(active.probes[0].path,'/health');assert.equal(active.probes[0].headers.cookie,undefined);assert.equal(active.probes[0].headers.authorization,undefined);
  await start();await waitFor(()=>frame.evaluate(()=>window.fixture.done.length===1),'delegated business read');await drain();assert.equal(nativeErrorsEmpty(result),true);
 });
 for(const fetchMode of ['bypass','drop-binding'])await run(`${fetchMode} cannot fake a valid HTTP health installation proof`,{fetchMode},async({result,drain})=>{
  await drain();assert.equal(result.expected_installation_failure,true);assert.equal(nativeErrorsEmpty(result),false);assert.equal(active.wire.length,0);assert.equal(active.probes.length,1);
  const check=result.fetch_probe_installation_observations.at(-1);assert.equal(check.http.status,200);assert.equal(check.challenge.starts,0);assert.equal(check.passed,false);
 });
 await run('another plain health request makes the installation challenge ambiguous',{fetchMode:'extra-health'},async({result,drain})=>{
  await drain();assert.equal(active.probes.length,2);assert.ok(active.probes.every(row=>row.path==='/health'&&row.status===200));
  const check=result.fetch_probe_installation_observations.at(-1);assert.equal(check.challenge.starts,2);assert.equal(check.challenge.network_requests,2);assert.equal(check.passed,false);assert.equal(nativeErrorsEmpty(result),false);
 });
 await run('query health route is 404 exactly as deployed',{},async({frame,result,drain})=>{
  const status=await frame.evaluate(async()=>{const response=await fetch('/health?__oasis_native_probe=old-fixture',{cache:'no-store'});await response.text();return response.status;});
  assert.equal(status,404);await drain();assert.equal(result.http_errors.length,1);assert.equal(result.http_errors[0].status,404);assert.equal(nativeErrorsEmpty(result),false);assert.equal(active.probes.at(-1).status,404);
 });
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
  const polls=result.fetch_observations.filter(event=>event.kind==='start'&&event.url===origin+'/api/pvp/rooms/owned');
  assert.equal(result.lifecycle_cancellations.length,1,JSON.stringify(result));assert.equal(nativeErrorsEmpty(result),true);assert.equal(polls.length,2);assert.equal(result.lifecycle_cancellations[0].fetch_attempt_id,polls[1].attempt_id);
 });
 await run('302 successful room polls before one zero-timing cancellation',{mode:'normal'},async({frame,start,abort,result,drain})=>{
  await frame.evaluate(async()=>{for(let index=0;index<302;index++){const response=await fetch('/api/pvp/rooms/owned',{cache:'no-store'});await response.json();}});
  // This case tests settled history, not adjacent sub-millisecond fetches. The
  // separate unit gate continues to reject overlap inside the fixed 1ms bound.
  await frame.evaluate(()=>new Promise(resolve=>setTimeout(resolve,5)));
  active.mode='hold';await start();await waitFor(()=>active.held.length===303,'final GET after polling history');await abort();await waitFor(()=>result.network_observations.length===1,'final cancellation');await drain();
  assert.equal(result.lifecycle_cancellations.length,1,JSON.stringify(result));assert.equal(result.fetch_observations.filter(event=>event.kind==='start'&&event.url===origin+'/api/pvp/rooms/owned').length,303);
  assert.equal(result.lifecycle_cancellations[0].network_timing_source,'cdp');assert.ok(result.lifecycle_cancellations[0].network_session_id);assert.equal(nativeErrorsEmpty(result),true);
 });
 await run('previously unique identity survives the second sequential zero-clock cancellation',{},async({start,abort,result,drain})=>{
  await start();await waitFor(()=>active.held.length===1,'first sequential GET');await abort();await waitFor(()=>result.network_observations.length===1,'first sequential failure');await drain();assert.equal(result.lifecycle_cancellations.length,1);
  const original=result.network_observations[0],identity=result.lifecycle_cancellations[0].network_protocol_id;
  await start();await waitFor(()=>active.held.length===2,'second sequential GET');await abort('OASIS_ROOM_POLL_STOPPED','AbortError',1);await waitFor(()=>result.network_observations.length===2,'second sequential failure');await drain();
  assert.equal(result.lifecycle_cancellations.length,2);assert.equal(result.network_errors.length,0);assert.equal(result.network_observations[0],original);
  assert.equal(result.lifecycle_cancellations[0].network_protocol_id,identity);assert.equal(new Set(result.lifecycle_cancellations.map(row=>row.network_protocol_id)).size,2);
  assert.ok(result.network_binding_decisions.some(row=>row.binding?.retained_identity?.id===identity));assert.equal(nativeErrorsEmpty(result),true);
 });
 await run('two sequential zero-clock cancellations without an earlier binding remain ambiguous',{},async({start,abort,result,drain})=>{
  await start();await waitFor(()=>active.held.length===1,'first GET');await abort();await waitFor(()=>result.network_observations.length===1,'first failure');
  await start();await waitFor(()=>active.held.length===2,'second GET');await abort('OASIS_ROOM_POLL_STOPPED','AbortError',1);await waitFor(()=>result.network_observations.length===2,'second failure');await drain({final:true});
  assert.equal(result.lifecycle_cancellations.length,0);assert.equal(result.network_errors.length,2);assert.ok(result.network_errors.every(row=>row.classification_failure==='AMBIGUOUS_CDP_NETWORK_FAILURE'));assert.equal(nativeErrorsEmpty(result),false);
 });
 await run('later pending GET cannot permanently condemn an earlier observed abort',{},async({start,abort,frame,result,drain})=>{
  await start();await waitFor(()=>active.held.length===1,'first GET');await abort();await waitFor(()=>result.network_observations.length===1,'first failure');
  await start();await waitFor(()=>active.held.length===2,'later GET held');await drain({final:false});
  assert.equal(result.pending_network_observations,1);assert.equal(result.network_errors.length,0);assert.equal(result.pending_fetch_rejections.length,1);assert.equal(nativeErrorsEmpty(result),false);
  active.held[1].writeHead(200,{'content-type':'application/json'});active.held[1].end(JSON.stringify(room));
  await waitFor(()=>frame.evaluate(()=>window.fixture.done.length===2),'later GET completed');await drain({final:true});
  assert.equal(result.lifecycle_cancellations.length,1);assert.equal(result.unmatched_fetch_rejections.length,0);assert.equal(nativeErrorsEmpty(result),true);
  assert.deepEqual(result.network_binding_decisions.slice(0,2).map(row=>row.verdict),['pending','lifecycle']);
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
