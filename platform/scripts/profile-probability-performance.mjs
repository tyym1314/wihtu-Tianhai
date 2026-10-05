/** Public test-wallet diagnostic. Desktop WebKit is not a physical iPhone. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {webkit,chromium} from 'playwright';
import {QUALITY_SCHEMA,profileSchedule,installQualityProbe,waitForPlayable,qualityRecord,statistics,isStaticRequest,supersededAssetPaths,networkShape,applyNetworkShape,networkAddress,observeNetworkResponse,networkFailure} from './mobile-quality-metrics.mjs';

const origin=new URL(process.env.OASIS_PROFILE_ORIGIN||'https://game.tianyahuyu.com').origin;
const out=resolve(process.env.OASIS_PROFILE_OUT||'review/mobile-all-20260928/probability-before');
const games=(process.env.OASIS_PROFILE_GAMES||'thunder,tiger').split(',');
const qualityMode=process.env.OASIS_PROFILE_QUALITY==='1';
const repetitions=Number(process.env.OASIS_PROFILE_REPETITIONS||(qualityMode?'5':'1'));
const cacheModes=(process.env.OASIS_PROFILE_CACHE||(qualityMode?'cold,warm':'cold')).split(',');
const schedule=profileSchedule(games,[1],{repetitions,cacheModes});
const sampleMs=Number(process.env.OASIS_PROFILE_SAMPLE_MS||(qualityMode?'60000':'5000'));
const entryMode=process.env.OASIS_PROFILE_ENTRY||(qualityMode?'demo':'native');
const local=process.env.OASIS_PROFILE_LOCAL_LEGACY?resolve(process.env.OASIS_PROFILE_LOCAL_LEGACY):null;
const browserEngine=process.env.OASIS_PROFILE_BROWSER||'webkit';assert(['chromium','webkit'].includes(browserEngine));const shape=networkShape(process.env.OASIS_PROFILE_SHAPE||'',browserEngine);
const workerFault=process.env.OASIS_PROFILE_WORKER_FAULT||'';
assert(['','delay','fail'].includes(workerFault));
assert(!workerFault||local,'Fault injection only targets local production assets');
assert(!workerFault||cacheModes.join(',')==='cold'&&repetitions===1,'Worker fault diagnostic uses one cold sample; it cannot validate a cold/warm quality cohort');
assert(games.every(game=>['thunder','tiger'].includes(game)));
assert(['demo','native'].includes(entryMode));assert(Number.isFinite(sampleMs)&&sampleMs>=1000&&sampleMs<=900000);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,limit=45000){const end=Date.now()+limit;while(Date.now()<end){if(await fn())return;await pause(100);}throw Error('Timeout: '+label);}
const path=url=>networkAddress(url).path;
const supersededPaths=supersededAssetPaths(JSON.parse(await fs.readFile(new URL('../mobile-assets.json',import.meta.url),'utf8')));
if(qualityMode){const existing=await fs.readdir(out).catch(error=>{if(error.code==='ENOENT')return[];throw error;});assert.equal(existing.length,0,'OUTPUT_ALREADY_EXISTS: quality sampling requires a fresh empty directory; preserving '+out);}
await fs.mkdir(out,{recursive:true});
const report={started_at:new Date().toISOString(),quality_schema:QUALITY_SCHEMA,quality_standard:'mobile-quality-v1',physical_device:false,local_legacy_override:local,measurement_config:{repetitions,cacheModes,sampleMs,entryMode,serial:true},scope:'Actual desktop browser, 390x844 DPR2 touch viewport. Serial cold/new-context and warm/retained-context sessions. Independent demo test wallets; every initiated test cycle is settled and its complete presentation/bonus chain acknowledged. Quality mode repeats real spins for the requested duration; legacy mode keeps one paid cycle plus idle diagnostic. No physical iPhone certification.'+(local?' Local assets use request routing, which disables HTTP cache; these samples cannot establish public cold or warm delivery.':''),games:[]};
const browser=browserEngine==='webkit'?await webkit.launch({headless:true}):await chromium.launch({channel:'chrome',headless:true,args:process.platform==='darwin'?['--use-angle=metal']:[]}),warmContexts=new Map(),warmPages=new Map(),warmPrimed=new Set();report.browser=browser.version();
try{
 for(const {game,cache_mode,iteration} of schedule){
  let context=cache_mode==='cold'?null:warmContexts.get(game);const createdContext=!context;
  if(!context){context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});if(cache_mode!=='cold')warmContexts.set(game,context);}
  const stem=repetitions===1&&cacheModes.join(',')==='cold'?game:`${game}-${cache_mode}-${iteration}`,workerRequests=[];
  if(local&&createdContext)await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==origin||!url.pathname.startsWith('/legacy/')&&!url.pathname.startsWith('/play/'))return route.continue();const file=resolve(local,url.pathname.startsWith('/play/')?game+'.html':url.pathname.slice(8));assert(file.startsWith(local+'/'));if(workerFault&&/audio-worker-.*\.js$/.test(file)){const request={at:Date.now(),fault:workerFault};workerRequests.push(request);if(workerFault==='fail'){await route.abort('failed');request.finished_at=Date.now();return;}await pause(10000);request.finished_at=Date.now();}const ext=file.split('.').pop();await route.fulfill({path:file,contentType:({html:'text/html',js:'text/javascript',css:'text/css',png:'image/png',webp:'image/webp',svg:'image/svg+xml'})[ext]});});
  if(createdContext){await context.addInitScript(installQualityProbe);await context.addInitScript(()=>{const d=window.__mobilePerf={frames:[],marks:[],touches:[]};let last;requestAnimationFrame(function tick(t){if(last!==undefined&&d.frames.length<100000)d.frames.push({at:t,ms:t-last});last=t;requestAnimationFrame(tick);});document.addEventListener('pointerdown',e=>{if(d.touches.length<10000)d.touches.push({type:e.pointerType,trusted:e.isTrusted,target:e.target.id});},true);});}
  let page=cache_mode==='cold'?null:warmPages.get(game);if(!page){page=await context.newPage();if(cache_mode!=='cold')warmPages.set(game,page);}for(const name of ['request','requestfinished','requestfailed','response','pageerror'])page.removeAllListeners(name);const cdp=browserEngine==='chromium'?await context.newCDPSession(page):null;if(cdp)await cdp.send('Network.enable');const networkControl=await applyNetworkShape(cdp,shape);
  const item={build_id:process.env.OASIS_PROFILE_BUILD_ID||null,network_control:networkControl,cache_reuse:cache_mode==='warm'?'same-page-navigation':null,observation_id:randomUUID(),game,cache_mode,iteration,browser_engine:browserEngine,browser_version:browser.version(),cpu_throttle:1,local_override:!!local,source_kind:process.env.OASIS_PROFILE_SOURCE_KIND||null,errors:[],resource_errors:[],http_errors:[],spins:[],acks:0,returned:false,cleanup:false},network=[],pending=new Set(),pendingStatic=new Set();report.games.push(item);
  let frame,token,lastSession,returning=false,measurement={};
  page.on('request',request=>{const pathname=path(request.url());if(isStaticRequest(pathname,request.resourceType()))pendingStatic.add(request);if(pathname===`/api/play/${game}/spin`&&!item.first_spin_request_at)item.first_spin_request_at=Date.now();});
  page.on('requestfinished',request=>pendingStatic.delete(request));
  page.on('requestfailed',request=>{pendingStatic.delete(request);if(!returning){const event=networkFailure(request);if(workerFault&&/audio-worker-.*\.js$/.test(event.path)){(item.injected_resource_failures??=[]).push(event);}else item.resource_errors.push(event);}});
  page.on('pageerror',e=>item.errors.push(e.message.slice(0,300)));
  page.on('response',response=>{
   const task=(async()=>{
    const row=await observeNetworkResponse(response,{origin,returning,onHttpError:error=>item.http_errors.push(error),onResourceError:error=>item.resource_errors.push(error),onSameOriginResponse:async response=>{
     const pathname=new URL(response.url()).pathname;
     if(pathname==='/v1/launch/exchange'&&response.ok())token=(await response.json()).access_token;
     if(pathname===`/api/play/${game}/session`&&response.ok())lastSession=await response.json();
     if(pathname===`/api/play/${game}/spin`&&response.ok()){const b=await response.json();lastSession=b.session;item.spins.push({settlementStatus:b.round.settlementStatus,is_free_spin:b.round.isFreeSpin===true});}
     if(pathname===`/api/play/${game}/ack`&&response.ok()){lastSession=(await response.json()).session;item.acks++;}
    }});network.push(row);
   })().catch(e=>{if(!/closed|No data found|aborted|No resource|unavailable/i.test(e.message))item.errors.push(e.message.slice(0,300));});pending.add(task);task.finally(()=>pending.delete(task));
  });
  async function readSession(){assert(token,'Launch exchange token missing');const response=await page.request.get(origin+`/api/play/${game}/session`,{headers:{authorization:'Bearer '+token,origin}});assert(response.ok(),'Session readback failed');lastSession=await response.json();return lastSession;}
  async function presentOne(){const acks=item.acks;await until(()=>frame.locator('#spin').isEnabled(),'spin ready',60000);if(!item.spin_tap_at)item.spin_tap_at=Date.now();await frame.locator('#spin').tap();await until(async()=>{const close=frame.locator(game==='tiger'?'#continue':'.celebration-close');if(await close.isVisible())await close.tap();return item.acks>acks;},'settled spin and acknowledged presentation',120000);await until(()=>frame.locator('#spin').isEnabled(),'presentation complete',120000);}
  async function finishPending(){let count=0;let session=await readSession();while(session.pendingRound||(session.freeSpins||0)>0){assert(++count<=300,'Bonus cleanup exceeded its bounded round count');await presentOne();session=await readSession();}item.final_readback={pending_round:session.pendingRound??null,free_spins:session.freeSpins||0};item.cleanup=true;}
  async function returnToHost(){if(item.returned||!frame||frame.isDetached())return;returning=true;if(entryMode==='demo')await page.locator('#back').tap();else{const back=frame.locator('[data-action="back"],#back,.back-btn,.back-button,.game-back').first();if(await back.count()&&await back.isVisible())await back.tap();else await page.evaluate(()=>window.OasisNativeHost.requestBack());}item.return_confirmations=0;await until(async()=>{if(entryMode==='demo'?await page.locator('#home').isVisible().catch(()=>false):new URL(page.url()).pathname==='/demo/native-return')return true;if(!frame.isDetached()){const confirm=frame.locator('[data-return="confirm"]');if(await confirm.isVisible().catch(()=>false)){await confirm.tap();item.return_confirmations++;}}return false;},'host return');item.returned=true;}
  try{
   let started;if(entryMode==='demo'){await page.goto(origin+'/demo/',{waitUntil:'domcontentloaded'});await page.locator(`[data-game="${game}"]`).waitFor();started=Date.now();item.entry_start_kind='user-game-selection';await page.locator(`[data-game="${game}"]`).tap();}else{started=Date.now();item.entry_start_kind='native-navigation';await page.goto(origin+'/demo/native/'+game,{waitUntil:'domcontentloaded'});}measurement.startEpoch=started;item.entry_phases=[];
   await until(()=>page.frames().some(f=>f.url()===origin+'/play/'+game),'game frame');frame=page.frames().find(f=>f.url()===origin+'/play/'+game);
   await frame.locator('#spin').waitFor();await until(()=>frame.locator('#spin').isEnabled(),'spin ready');item.interactive_ms=Date.now()-started;item.entry_phases.push({name:'spin-control-enabled',elapsed_ms:item.interactive_ms});
   // Fault diagnostics retain their original submit-while-worker-delayed test.
   // They deliberately cannot establish normal full-resource entry readiness.
   measurement.entryReady=workerFault?{ready:false,kind:'worker-fault-diagnostic'}:await waitForPlayable(frame,game,{pendingStatic:()=>pendingStatic.size});measurement.entryEpoch=Date.now();item.playable_ms=measurement.entryEpoch-started;item.entry_phases.push({name:'observed-playable',elapsed_ms:item.playable_ms});
   const mark=name=>frame.evaluate(name=>{const at=performance.now();window.__mobilePerf.marks.push({name,at});return at;},name);
   await frame.evaluate(()=>{window.__qualityProbe.active=true;});measurement.activityStart=await mark('spin-start');const activeEpoch=Date.now();let cycles=0;
   do{await presentOne();await finishPending();cycles++;}while(qualityMode&&cache_mode!=='prime'&&Date.now()-activeEpoch<sampleMs);
   assert(item.spins.length>0&&item.spins.every(s=>s.settlementStatus==='SETTLED'));assert(item.acks>=item.spins.length);item.completed_paid_cycles=cycles;
   if(workerFault){assert.equal(workerRequests.length,1);assert(item.first_spin_request_at-item.spin_tap_at<3000,'First spin must not wait for audio synthesis');if(workerFault==='delay')assert(item.first_spin_request_at<(workerRequests[0].finished_at||Infinity),'Spin sent while audio worker is still delayed');item.audio_worker_fault={requests:workerRequests,spin_submission_ms:item.first_spin_request_at-item.spin_tap_at};}
   await mark('spin-ack');await pause(qualityMode?150:sampleMs);measurement.activityEnd=await mark('sample-end');measurement.endEpoch=Date.now();
   const raw=await frame.evaluate(()=>({probe:window.__mobilePerf,qualityProbe:window.__qualityProbe,timeOrigin:performance.timeOrigin,resources:performance.getEntriesByType('resource').map(e=>({path:['http:','https:','blob:'].includes(new URL(e.name).protocol)?new URL(e.name).pathname:'[non-http]',url_protocol:new URL(e.name).protocol,url_origin:new URL(e.name).origin,same_origin:new URL(e.name).origin===location.origin,start_ms:e.startTime,encoded_bytes:e.encodedBodySize,decoded_bytes:e.decodedBodySize,transfer_bytes:e.transferSize,duration_ms:e.duration})),layout:{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight},canvas:[...document.querySelectorAll('canvas')].map(e=>({width:e.width,height:e.height,cssWidth:e.clientWidth,cssHeight:e.clientHeight}))}));
   Object.assign(measurement,{probe:raw.qualityProbe,resources:raw.resources,timeOrigin:raw.timeOrigin});const marks=Object.fromEntries(raw.probe.marks.map(e=>[e.name,e.at]));item.phases=[['entry',0,marks['spin-start']],['spin-and-result',marks['spin-start'],marks['spin-ack']],['idle',marks['spin-ack'],marks['sample-end']]].map(([name,start,end])=>({name,duration_ms:end-start,frames:statistics(raw.probe.frames.filter(x=>x.at>=start&&x.at<end).map(x=>x.ms))}));item.layout=raw.layout;item.touch_events=raw.probe.touches;item.canvases=raw.canvas;
   await fs.writeFile(resolve(out,stem+'-raw.json'),JSON.stringify(raw,null,2));await page.screenshot({path:resolve(out,stem+'.png')});await returnToHost();
  }catch(e){item.error=e.message.slice(0,500);await page.screenshot({path:resolve(out,stem+'-failure.png')}).catch(()=>{});}
  finally{
   if(!item.cleanup&&frame&&!frame.isDetached())try{await finishPending();}catch(e){item.cleanup_error=e.message.slice(0,300);}
   if(!item.returned&&item.cleanup)try{await returnToHost();}catch(e){item.return_error=e.message.slice(0,300);}
   await Promise.race([Promise.allSettled([...pending]),pause(5000)]);item.observer_pending_at_close=pending.size;
   item.quality=qualityRecord({sample:item,network,...measurement,supersededPaths,cacheCondition:local?'disabled-by-routing':cache_mode==='cold'?'fresh-context':cache_mode==='prime'?'priming':warmPrimed.has(game)?'retained-context':'unprimed-context',networkProfile:process.env.OASIS_PROFILE_NETWORK_PROFILE||'uncontrolled',scenario:process.env.OASIS_PROFILE_SCENARIO||'opening-and-repeat-spins'});item.quality.coverage.full_round=item.cleanup&&item.returned&&item.spins.length>0&&item.spins.every(s=>s.settlementStatus==='SETTLED')&&item.acks>=item.spins.length;
   if(cache_mode==='prime'&&item.cleanup&&item.returned&&!item.error)warmPrimed.add(game);
   await cdp?.detach().catch(()=>{});if(cache_mode==='cold'||cache_mode==='warm'&&iteration===repetitions){await context.close();warmContexts.delete(game);warmPages.delete(game);}
   await fs.writeFile(resolve(out,stem+'-network.json'),JSON.stringify(network,null,2));await fs.writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({game,cache_mode,iteration,playable_ms:item.playable_ms,spins:item.spins.length,acks:item.acks,returned:item.returned,cleanup:item.cleanup,cache_condition:item.quality.cache_condition,static_encoded_bytes:item.quality.network.static_encoded_bytes,error:item.error}));
  }
 }
}finally{await browser.close();report.finished_at=new Date().toISOString();await fs.writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));}
if(report.games.some(x=>x.error||x.errors.length||x.resource_errors.length||x.http_errors.length||!x.returned||!x.acks||!x.cleanup))process.exitCode=1;
