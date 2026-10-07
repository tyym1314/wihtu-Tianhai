/** Desktop diagnostic, NOT phone certification. Only isolated zero-entry public practice. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,webkit} from 'playwright';
import {runContinuousActions} from './mobile-continuous-driver.mjs';
import {playOneArenaAction} from './android-game-actions.mjs';
import {createSnapshotTransfer} from '../arena/shared/snapshot-transfer.mjs';
import {createProfileEntryGate} from './profile-entry-gate.mjs';
import {ARENA_IDS} from '../shared/games.mjs';
import {QUALITY_SCHEMA,profileSchedule,installQualityProbe,waitForPlayable,qualityRecord,isStaticRequest,supersededAssetPaths,networkShape,applyNetworkShape,networkAddress,networkFailure} from './mobile-quality-metrics.mjs';

const origin=new URL(process.env.OASIS_PROFILE_ORIGIN||'https://game.tianyahuyu.com').origin;
const out=resolve(process.env.OASIS_PROFILE_OUT||'review/performance-20260927');
const qualityMode=process.env.OASIS_PROFILE_QUALITY==='1';
const games=(process.env.OASIS_PROFILE_GAMES||(qualityMode?ARENA_IDS.join(','):'run,bowling,carrom')).split(',');
const rates=(process.env.OASIS_PROFILE_CPU||(qualityMode?'1':'1,4')).split(',').map(Number);
const repetitions=Number(process.env.OASIS_PROFILE_REPETITIONS||(qualityMode?'5':'1')),cacheModes=(process.env.OASIS_PROFILE_CACHE||(qualityMode?'cold,warm':'cold')).split(',');
const schedule=profileSchedule(games,rates,{repetitions,cacheModes});
const entryMode=process.env.OASIS_PROFILE_ENTRY||(qualityMode?'demo':'native');assert(['demo','native'].includes(entryMode));
const browserEngine=process.env.OASIS_PROFILE_BROWSER||'chromium';
const shape=networkShape(process.env.OASIS_PROFILE_SHAPE||'',browserEngine);
const touch=process.env.OASIS_PROFILE_TOUCH==='1'||qualityMode;
const continuous=process.env.OASIS_PROFILE_CONTINUOUS==='1';
assert(['chromium','webkit'].includes(browserEngine));
assert(browserEngine!=='webkit'||rates.every(rate=>rate===1),'WebKit does not support CDP CPU throttling');
assert(games.every(g=>ARENA_IDS.includes(g))&&rates.every(r=>r>=1&&r<=6));
const sampleMs=Number(process.env.OASIS_PROFILE_SAMPLE_MS||(qualityMode?60000:10000));
const localArena=process.env.OASIS_PROFILE_LOCAL_ARENA?resolve(process.env.OASIS_PROFILE_LOCAL_ARENA):null;
const capacity=process.env.OASIS_PROFILE_CAPACITY?Number(process.env.OASIS_PROFILE_CAPACITY):null;
assert(capacity===null||[2,3,4].includes(capacity));
assert(Number.isFinite(sampleMs)&&sampleMs>=1000&&sampleMs<=900000);
assert(!continuous||sampleMs>=60000,'Continuous driver is for >=60-second activity samples, not loading-only runs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error('Timeout: '+label);}
const path=url=>networkAddress(url).path;
const percentile=(list,q)=>list.length?Number([...list].sort((a,b)=>a-b)[Math.min(list.length-1,Math.max(0,Math.ceil(list.length*q)-1))].toFixed(2)):null;
function metrics(samples){return {count:samples.length,p50_ms:percentile(samples,.5),p95_ms:percentile(samples,.95),p99_ms:percentile(samples,.99),max_ms:samples.length?Math.max(...samples):null,over_25ms:samples.filter(x=>x>25).length,over_50ms:samples.filter(x=>x>50).length,over_100ms:samples.filter(x=>x>100).length};}
const report={started_at:new Date().toISOString(),origin,physical_device:false,scope:'Cold independent desktop Chrome native-host sessions, mobile 390x844 viewport, hardware Metal GPU; CPU throttling is diagnostic only and is not a device benchmark. Actual UI action accepted by the public sandbox. Zero-entry practice only.',samples:[]};
if(qualityMode){const existing=await fs.readdir(out).catch(error=>{if(error.code==='ENOENT')return[];throw error;});assert.equal(existing.length,0,'OUTPUT_ALREADY_EXISTS: quality sampling requires a fresh empty directory; preserving '+out);}
await fs.mkdir(out,{recursive:true});
if(process.env.OASIS_PROFILE_MODE==='fixture'){await profileFixture();process.exit(0);}
const browser=browserEngine==='webkit'?await webkit.launch({headless:true}):await chromium.launch({channel:'chrome',headless:true,args:process.platform==='darwin'?['--use-angle=metal']:[]});
report.quality_schema=QUALITY_SCHEMA;report.quality_standard='mobile-quality-v1';report.measurement_config={repetitions,cacheModes,sampleMs,entryMode,serial:true,continuous};report.engine=browserEngine;
report.local_arena_override=localArena;
report.scope=`Serial cold/new-context and warm/retained-context desktop ${browserEngine} sessions, mobile 390x844/DPR2 viewport. Not a physical iPhone or phone performance certificate. Actual UI actions on the public sandbox, zero-entry practice only.${localArena?' Frontend assets overridden with a local production build; loading times do not measure public delivery.':''}`;
report.browser=browser.version();
const warmContexts=new Map(),warmPages=new Map(),warmPrimed=new Set();
const supersededPaths=supersededAssetPaths(JSON.parse(await fs.readFile(new URL('../mobile-assets.json',import.meta.url),'utf8')));
try{
 for(const run of schedule){
  const {game,cpu,cache_mode,iteration}=run,key=game+':'+cpu;let context=cache_mode==='cold'?null:warmContexts.get(key);const createdContext=!context;
  if(!context){context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});if(cache_mode!=='cold')warmContexts.set(key,context);}
  const stem=repetitions===1&&cacheModes.join(',')==='cold'?`${game}-cpu${cpu}`:`${game}-cpu${cpu}-${cache_mode}-${iteration}`;
  if(localArena&&createdContext)await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin||!url.pathname.startsWith('/arena/')&&!url.pathname.startsWith('/play/'))return route.continue();
   const file=resolve(localArena,url.pathname.startsWith('/play/')?'index.html':url.pathname.slice('/arena/'.length));
   assert(file.startsWith(localArena+'/'));
   const extension=file.split('.').pop(),contentType={html:'text/html',js:'text/javascript',css:'text/css',glb:'model/gltf-binary',wasm:'application/wasm',webp:'image/webp',png:'image/png',svg:'image/svg+xml',json:'application/json'}[extension];
   await route.fulfill({path:file,contentType});
  });
  if(createdContext){await context.addInitScript(installQualityProbe);await context.addInitScript(()=>{
   const d=window.__gamePerf={frames:[],longTasks:[],marks:[]};let last;
   requestAnimationFrame(function tick(t){if(last!==undefined&&d.frames.length<20000)d.frames.push({at:t,ms:t-last});last=t;requestAnimationFrame(tick);});
   d.longTaskObserverSupported=PerformanceObserver.supportedEntryTypes.includes('longtask');
   if(d.longTaskObserverSupported)new PerformanceObserver(list=>{for(const e of list.getEntries())d.longTasks.push({at:e.startTime,ms:e.duration,name:e.name});}).observe({type:'longtask',buffered:true});
  });
  }
  let page=cache_mode==='cold'?null:warmPages.get(key);if(!page){page=await context.newPage();if(cache_mode!=='cold')warmPages.set(key,page);}for(const name of ['request','requestfinished','requestfailed','response','pageerror'])page.removeAllListeners(name);const cdp=browserEngine==='chromium'?await context.newCDPSession(page):null;
  if(cdp){await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});await cdp.send('Network.enable');}
  const networkControl=await applyNetworkShape(cdp,shape);
  if(cdp&&process.env.OASIS_PROFILE_CPU_PROFILE==='1'){await cdp.send('Profiler.enable');await cdp.send('Profiler.start');}
  const transports=[];
  cdp?.on('Network.responseReceived',({response:r})=>{if(r.url.startsWith(origin))transports.push({path:path(r.url),protocol:r.protocol,connection_id:r.connectionId,reused:r.connectionReused,timing:r.timing});});
  const observedTransfer=createSnapshotTransfer(),snapshotTickets=new WeakMap();
  const state={token:null,room:null,playerId:null,rooms:new Set()},tasks=new Set(),network=[],clockSamples=[];
  const result={build_id:process.env.OASIS_PROFILE_BUILD_ID||null,network_control:networkControl,cache_reuse:cache_mode==='warm'?'same-page-navigation':null,observation_id:randomUUID(),game,iteration,cache_mode,browser_engine:browserEngine,browser_version:browser.version(),local_override:!!localArena,source_kind:process.env.OASIS_PROFILE_SOURCE_KIND||null,resource_errors:[],cpu_throttle:cpu,requested_capacity:capacity,input:touch?'trusted touch taps; darts/towerlink helper drags use mouse':'mouse',errors:[],accepted_action:false,cleanup:false};report.samples.push(result);
  page.on('pageerror',e=>result.errors.push(e.message.slice(0,300)));
  const entryGate=createProfileEntryGate({origin,game});let returning=false,measurement={};
  page.on('request',r=>{const address=new URL(r.url());let frame=null;try{frame=r.frame();}catch{}snapshotTickets.set(r,observedTransfer.begin(address.pathname,r.method()==='GET'));entryGate.request(r,{frame,url:r.url(),type:r.resourceType(),method:r.method(),isStatic:isStaticRequest(address.pathname,r.resourceType()),isNavigation:r.isNavigationRequest()});});
  page.on('requestfinished',r=>entryGate.finish(r,'finished'));
  page.on('requestfailed',r=>{entryGate.finish(r,'failed');if(!returning)result.resource_errors.push(networkFailure(r));});
  page.on('response',response=>{
   const task=(async()=>{
    const request=response.request(),responseUrl=new URL(response.url()),pathname=responseUrl.pathname;entryGate.observer(request,'response',{url:responseUrl.origin+pathname,type:request.resourceType(),method:request.method()});let snapshotShape=null;if(response.status()>=400&&isStaticRequest(pathname,request.resourceType())&&!returning)result.resource_errors.push({...networkAddress(response.url()),status:response.status()});
    if(responseUrl.origin===origin&&pathname==='/v1/launch/exchange'&&response.ok()){entryGate.observer(request,'authorization-json');const b=await response.json();if(entryGate.decision(request).accepted){if(state.token!==b.access_token){observedTransfer.clear();entryGate.resetRoom();state.room=null;}state.token=b.access_token;state.playerId=b.external_user_id;}}
    if(responseUrl.origin===origin&&pathname.startsWith('/api/pvp/rooms')&&response.ok()){
     entryGate.observer(request,'room-json');const b=await response.json();let room=b.room||b;snapshotShape={room_version:room.version,legal_actions_key:room.legal_actions_key||null,legal_actions_omitted:room.game?.legalActionsOmitted===true,legal_actions_count:Array.isArray(room.game?.legalActions)?room.game.legalActions.length:null,request_known_actions:request.headers()['x-oasis-known-actions']||null};try{room=entryGate.decision(request).accepted?observedTransfer.restore(snapshotTickets.get(request),room):null;}catch(error){if(error.code!=='SNAPSHOT_REFRESH_REQUIRED'&&error.code!=='SESSION_CHANGED')throw error;(result.observer_notes??=[]).push({path:path(response.url()),code:error.code});room=null;}
     if(room?.id&&room.game_id===game){const created=pathname==='/api/pvp/rooms'&&request.method()==='POST';if(created){assert.equal(room.entry_minor,'0');assert.equal(room.practice,true);state.rooms.add(room.id);}const selected=entryGate.receiveRoom(request,room,{created});clockSamples.push({receipt_epoch_ms:Date.now(),room_id:room.id,version:room.version,status:room.status,server_now:room.server_now,game_server_now:room.game?.serverNow,simulation_at:room.game?.simulationAt,snapshot_tick:room.game?.snapshotTick,entry_selected:selected.accepted,entry_reason:selected.reason});if(selected.accepted)state.room=selected.room;}
    }
    entryGate.observer(request,'response-finished');await response.finished();entryGate.observer(request,'request-sizes');const timing=request.timing(),size=await request.sizes().catch(()=>({}));
    network.push({...snapshotShape,...networkAddress(response.url()),type:request.resourceType(),method:request.method(),status:response.status(),content_encoding:response.headers()['content-encoding']||null,cache_control:response.headers()['cache-control']||null,start_epoch_ms:timing.startTime,duration_ms:Number(timing.responseEnd.toFixed(2)),request_start_ms:timing.requestStart,ttfb_ms:timing.responseStart<0?null:Number((timing.responseStart-Math.max(0,timing.requestStart)).toFixed(2)),encoded_body_bytes:size.responseBodySize??null});entryGate.observer(request,'recorded');
   })().catch(e=>{entryGate.observer(response.request(),'error');if(!/Target.*closed|No data found|No resource|aborted|unavailable/i.test(e.message))result.errors.push(e.message.slice(0,300));});
   tasks.add(task);task.finally(()=>tasks.delete(task));
  });
  try{
   let started;if(entryMode==='demo'){await page.goto(origin+'/demo/',{waitUntil:'domcontentloaded'});await page.locator(`[data-game="${game}"]`).waitFor();started=Date.now();entryGate.begin({at:started,mainFrame:page.mainFrame(),existingFrames:page.frames()});result.entry_start_kind='user-game-selection';await page.locator(`[data-game="${game}"]`)[touch?'tap':'click']();}else{started=Date.now();entryGate.begin({at:started,mainFrame:page.mainFrame(),existingFrames:page.frames()});result.entry_start_kind='native-navigation';await page.goto(origin+'/demo/native/'+game,{waitUntil:'domcontentloaded'});}measurement.startEpoch=started;result.entry_phases=[];
   await until(()=>state.token&&page.frames().some(f=>f.url()===origin+'/play/'+game),'game frame');
   const frame=page.frames().find(f=>f.url()===origin+'/play/'+game);
   await frame.locator('.lobby-settings').waitFor();result.lobby_ready_ms=Date.now()-started;result.entry_phases.push({name:'lobby-ready',elapsed_ms:result.lobby_ready_ms});
   if(capacity)await frame.locator('.arena-segments button').filter({hasText:new RegExp(`^\\s*${capacity} 人\\s*$`)}).click();
   await frame.getByRole('button',{name:'免费练习',exact:false}).click();
   await frame.getByRole('button',{name:'确认规则 · 准备开局',exact:true}).click();
   await until(()=>state.room?.status==='active','active zero-entry room');
   assert.equal(state.room.entry_minor,'0');assert.equal(state.room.practice,true);
   await frame.locator('.arena-loading').waitFor({state:'hidden'});
   result.active_room_ms=Date.now()-started;result.entry_phases.push({name:'active-room',elapsed_ms:result.active_room_ms});
   const ready=await waitForPlayable(frame,game,{pendingStatic:()=>entryGate.pendingCount(),readRoom:()=>state.room,readinessDiagnostics:()=>entryGate.snapshot()});measurement.entryReady=ready;measurement.entryEpoch=Date.now();result.playable_ms=measurement.entryEpoch-started;result.entry_phases.push({name:'observed-playable',elapsed_ms:result.playable_ms,excluded_turn_wait_ms:ready.turn_wait_ms,excluded_other_player_ready_wait_ms:ready.other_player_ready_wait_ms});
   const mark=name=>frame.evaluate(name=>{const at=performance.now();window.__gamePerf.marks.push({name,at});return at;},name);
   await mark('action-start');
   let action;
   for(let attempt=0;attempt<4;attempt++)try{action=await playOneArenaAction(frame,game,()=>state.room,{touch});break;}catch(e){if(game!=='run'||e.status!==409||!['BUSY','STALE_INPUT','INPUT_PENDING','RATE_LIMIT'].includes(e.code)||attempt===3)throw e;await delay(400);}
   result.accepted_action=true;result.action={type:action.actionType,status:action.httpStatus};
   await mark('action-accepted');
   if(continuous&&cache_mode!=='prime'){
    const roomId=state.room.id,deadlineAt=Date.now()+sampleMs+100;
    result.continuous=await runContinuousActions({game,roomId,readRoom:()=>state.room,deadlineAt,initialSequence:action.sequenceAfter,playAction:options=>playOneArenaAction(frame,game,()=>state.room,{touch,...options})});
    if(['room-changed','action-failed'].includes(result.continuous.reason))result.error='Continuous sampling stopped: '+result.continuous.reason;
   }else await delay(cache_mode==='prime'?1000:sampleMs+100);
   await mark('sample-end');measurement.endEpoch=Date.now();
   const raw=await frame.evaluate(()=>({probe:window.__gamePerf,qualityProbe:window.__qualityProbe,timeOrigin:performance.timeOrigin,resources:performance.getEntriesByType('resource').map(e=>({path:['http:','https:','blob:'].includes(new URL(e.name).protocol)?new URL(e.name).pathname:'[non-http]',url_protocol:new URL(e.name).protocol,url_origin:new URL(e.name).origin,same_origin:new URL(e.name).origin===location.origin,start_ms:e.startTime,type:e.initiatorType,duration_ms:e.duration,encoded_bytes:e.encodedBodySize,decoded_bytes:e.decodedBodySize,transfer_bytes:e.transferSize})),renderers:[...document.querySelectorAll('[data-render-calls],[data-render-quality],[data-art-quality]')].map(e=>({tag:e.tagName,attrs:{...e.dataset}})),canvas:[...document.querySelectorAll('canvas')].map(e=>({width:e.width,height:e.height,cssWidth:e.clientWidth,cssHeight:e.clientHeight}))}));
   const phase=(name,start,end)=>{const frames=raw.probe.frames.filter(e=>e.at>=start&&e.at<end).map(e=>e.ms),long=raw.probe.longTasks.filter(e=>e.at>=start&&e.at<end);return {phase:name,duration_ms:end-start,frames:metrics(frames),long_tasks:raw.probe.longTaskObserverSupported?metrics(long.map(e=>e.ms)):null,blocking_ms:raw.probe.longTaskObserverSupported?Number(long.reduce((s,e)=>s+Math.max(0,e.ms-50),0).toFixed(2)):null};};
   const marks=Object.fromEntries(raw.probe.marks.map(e=>[e.name,e.at]));Object.assign(measurement,{probe:raw.qualityProbe,resources:raw.resources,timeOrigin:raw.timeOrigin,activityStart:marks['action-accepted'],activityEnd:Math.min(marks['sample-end'],result.continuous?result.continuous.deadline_at-raw.timeOrigin:Infinity)});
   result.phases=[phase('entry',0,marks['action-start']),phase('action-response',marks['action-start'],marks['action-accepted']),phase('animation-after-action',marks['action-accepted'],marks['sample-end'])];
   result.action_response_ms=marks['action-accepted']-marks['action-start'];result.renderers=raw.renderers;result.canvases=raw.canvas;
   result.mobile_layout=await frame.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth},canvases:[...document.querySelectorAll('canvas,svg[role=application]')].map(e=>({touchAction:getComputedStyle(e).touchAction,...Object.fromEntries(['x','y','width','height'].map(key=>[key,e.getBoundingClientRect()[key]]))})),button_targets:[...document.querySelectorAll('button')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.top<innerHeight&&r.bottom>0;}).map(e=>({label:e.getAttribute('aria-label')||e.dataset.testid||e.textContent.trim().slice(0,32),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,disabled:e.disabled}))}));
   result.mobile_layout.small_buttons=result.mobile_layout.button_targets.filter(b=>b.width<40||b.height<40);
   result.long_task_observer_supported=raw.probe.longTaskObserverSupported;
   if(cdp&&process.env.OASIS_PROFILE_CPU_PROFILE==='1'){const {profile}=await cdp.send('Profiler.stop');await fs.writeFile(resolve(out,`${stem}.cpuprofile`),JSON.stringify(profile));}
   for(const resource of raw.resources)resource.path=resource.path.replace(/\/rooms\/[^/]+/,'/rooms/[room]');
   result.resources={count:raw.resources.length,decoded_total_bytes:raw.resources.reduce((s,e)=>s+e.decoded_bytes,0),transfer_total_bytes:raw.resources.reduce((s,e)=>s+e.transfer_bytes,0),largest:[...raw.resources].sort((a,b)=>b.decoded_bytes-a.decoded_bytes).slice(0,12)};
   await page.screenshot({path:resolve(out,`${stem}.png`)});
   await fs.writeFile(resolve(out,`${stem}-raw.json`),JSON.stringify({probe:raw.probe,qualityProbe:raw.qualityProbe,timeOrigin:raw.timeOrigin,resources:raw.resources},null,2));
  }catch(e){result.error=String(e.message).replace(/(?:ses|guest|pvp)_[A-Za-z0-9_-]+/g,'[private-id]').slice(0,600);if(e.readiness){result.readiness_timeout=e.readiness;await fs.writeFile(resolve(out,`${stem}-readiness.json`),JSON.stringify(e.readiness,null,2));}}
  finally{
   returning=true;
   try{
    for(const id of state.rooms){const headers={authorization:'Bearer '+state.token,origin,'content-type':'application/json'},readRoom=async()=>{const read=await page.request.get(origin+`/api/pvp/rooms/${id}`,{headers});const body=await read.json();return body.room||body;},released=room=>['cancelled','settled','voided'].includes(room.status)||room.players?.some(p=>p.external_user_id===state.playerId&&p.forfeited);let room=await readRoom();assert(room.entry_minor==='0'&&room.practice===true);if(!released(room)){const response=await page.request.post(origin+`/api/pvp/rooms/${id}/leave`,{headers,data:{request_id:'perf_cleanup_'+randomUUID().replaceAll('-','')}});const b=await response.json();if(!response.ok()&&!['ROOM_FINISHED','INVALID_STATE'].includes(b.error?.code))throw Error('Leave HTTP '+response.status()+' '+b.error?.code);await until(async()=>{room=await readRoom();return released(room);},'owned zero-entry room released',15000);}assert(released(room));}
    result.cleanup=true;
   }catch(e){result.cleanup_error=e.message;}
   await delay(200);await Promise.race([Promise.allSettled([...tasks]),delay(5000)]);result.observer_pending_at_close=tasks.size;result.entry_isolation=entryGate.snapshot();
   result.network={request_count:network.length,total_encoded_bytes:network.reduce((s,e)=>s+(e.encoded_body_bytes||0),0),api:network.filter(e=>e.path.startsWith('/api/')||e.path.startsWith('/v1/')),slowest:[...network].sort((a,b)=>b.duration_ms-a.duration_ms).slice(0,12),errors:network.filter(e=>e.status>=400),transport:transports};
   await fs.writeFile(resolve(out,`${stem}-network.json`),JSON.stringify(network,null,2));
   await fs.writeFile(resolve(out,`${stem}-clocks.json`),JSON.stringify(clockSamples,null,2));
   result.quality=qualityRecord({sample:result,network,...measurement,supersededPaths,cacheCondition:localArena?'disabled-by-routing':cache_mode==='cold'?'fresh-context':cache_mode==='prime'?'priming':warmPrimed.has(key)?'retained-context':'unprimed-context',networkProfile:process.env.OASIS_PROFILE_NETWORK_PROFILE||'uncontrolled',scenario:process.env.OASIS_PROFILE_SCENARIO||'opening'});
   result.quality.activity.driver=result.continuous||{mode:'single-action-observation'};
   if(cache_mode==='prime'&&result.accepted_action&&result.cleanup&&!result.error)warmPrimed.add(key);
   await cdp?.detach().catch(()=>{});if(cache_mode==='cold'||cache_mode==='warm'&&iteration===repetitions){await context.close();warmContexts.delete(key);warmPages.delete(key);}await fs.writeFile(resolve(out,'baseline.json'),JSON.stringify(report,null,2));
   console.log(JSON.stringify({game,cpu,accepted:result.accepted_action,action_response_ms:result.action_response_ms,phases:result.phases,cleanup:result.cleanup,error:result.error}));
  }
 }
}finally{await browser.close();report.finished_at=new Date().toISOString();await fs.writeFile(resolve(out,'baseline.json'),JSON.stringify(report,null,2));}
if(report.samples.some(sample=>sample.resource_errors?.length||sample.error||sample.errors.length||!sample.accepted_action||!sample.cleanup||sample.network.errors.some(error=>![409,429].includes(error.status))))process.exitCode=1;

async function profileFixture(){
 const {build}=await import('vite'),{createServer}=await import('node:http'),{extname,join}=await import('node:path'),{createHash}=await import('node:crypto');
 const buildDir=resolve(out,'fixture-build');
 // The shared art fixture normally executes authoritative physics in-page.
 // Move only fixture action calculation to this isolated Node server, so a
 // Cannon simulation is not falsely reported as a production renderer stall.
 const fixtureBridge={name:'profile-server-actions',enforce:'pre',transform(code,id){if(!id.endsWith('/arena/review-preview.jsx'))return;const needle="engine.act(state,me,action,Date.now())";assert(code.includes(needle),'Fixture action shape changed');return code.replace(needle,"await(async()=>{const r=await fetch('/__perf-fixture-action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({game,state,action,now:Date.now()})});const b=await r.json();if(!r.ok)throw Error(b.error);state=b.state;return b.result;})()");}};
 await build({configFile:resolve('arena/vite.config.mjs'),plugins:[fixtureBridge],build:{outDir:buildDir,emptyOutDir:true,rollupOptions:{input:resolve('arena/review-preview.html')}}});
 const server=createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/__perf-fixture-action'&&req.method==='POST'){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2000000)throw Error('Fixture body too large');}const b=JSON.parse(raw);assert(['run','bowling','carrom'].includes(b.game));const engine=await import(`../arena/${b.game}/engine.mjs`),result=engine.act(b.state,'p0',b.action,b.now);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({state:b.state,result}));return;}if(!pathname.startsWith('/arena/'))throw Error('No route');const file=join(buildDir,pathname.slice(7));assert(file.startsWith(buildDir+'/'));res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.wasm':'application/wasm','.webp':'image/webp','.png':'image/png','.glb':'model/gltf-binary'})[extname(file)]||'application/octet-stream');res.end(await fs.readFile(file));}catch(e){res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const local='http://127.0.0.1:'+server.address().port,fixture={started_at:new Date().toISOString(),physical_device:false,scope:'Production-built isolated fixture with actual UI controls; authoritative action physics executes in an isolated Node endpoint, not browser. No wallet/production API/phone. Localhost removes public network. Eager fixture imports mean startup times must not be compared with public shell startup. Desktop mobile viewport, Metal GPU, CPU throttle diagnostic.',source_hashes:{},samples:[]};
 for(const file of ['arena/run/scene.mjs','arena/run/RunGame.jsx','arena/bowling/scene.mjs','arena/bowling/BowlingGame.jsx','arena/carrom/board.mjs','arena/carrom/CarromGame.jsx','arena/shared/server-clock.mjs'])try{fixture.source_hashes[file]=createHash('sha256').update(await fs.readFile(file)).digest('hex');}catch{}
 const browser=await chromium.launch({channel:'chrome',headless:true,args:process.platform==='darwin'?['--use-angle=metal']:[]});
 try{for(const cpu of rates)for(const game of games){
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await context.addInitScript(()=>{const d=window.__gamePerf={frames:[],longTasks:[]};let last;requestAnimationFrame(function tick(t){if(last!==undefined)d.frames.push({at:t,ms:t-last});last=t;requestAnimationFrame(tick);});new PerformanceObserver(list=>{for(const e of list.getEntries())d.longTasks.push({at:e.startTime,ms:e.duration});}).observe({type:'longtask',buffered:true});});
  let page=cache_mode==='cold'?null:warmPages.get(key);if(!page){page=await context.newPage();if(cache_mode!=='cold')warmPages.set(key,page);}for(const name of ['request','requestfinished','requestfailed','response','pageerror'])page.removeAllListeners(name);const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});
  if(process.env.OASIS_PROFILE_CPU_PROFILE==='1'){await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:1000});await cdp.send('Profiler.start');}
  const item={game,cpu_throttle:cpu,errors:[]};fixture.samples.push(item);page.on('pageerror',e=>item.errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/')||new URL(r.url()).pathname.startsWith('/v1/'))item.errors.push('Unexpected backend request');});
  try{
   await page.goto(local+'/arena/review-preview.html?game='+game+'&locale=en');await page.waitForFunction(()=>!!window.artReview);
   const control=page.getByTestId({run:'run-jump',bowling:'bowling-roll',carrom:'carrom-shoot'}[game]);await until(()=>control.isEnabled(),'fixture legal control');
   const start=await page.evaluate(()=>performance.now());await control.click();
   await page.waitForFunction(game=>{const r=window.artReview.room(),p=r.game.me||r.game.players?.find(p=>p.key===r.me);return window.artReview.actions()>0&&(game==='run'?p.jumpStartTick!==null:game==='bowling'?p.shotId>0:r.game.phase==='rolling');},game,{timeout:5000});
   item.accepted_action=true;await delay(10000);
   const raw=await page.evaluate(start=>{const probe=window.__gamePerf;return {duration_ms:performance.now()-start,frames:probe.frames.filter(e=>e.at>=start),longTasks:probe.longTasks.filter(e=>e.at>=start),renderers:[...document.querySelectorAll('[data-render-calls],[data-render-quality],[data-art-quality]')].map(e=>({...e.dataset})),gpu:[...document.querySelectorAll('canvas')].map(e=>{try{const gl=e.getContext('webgl2'),ext=gl?.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null;}catch{return null;}}).filter(Boolean)};},start);
   item.frames=metrics(raw.frames.map(e=>e.ms));item.long_tasks=metrics(raw.longTasks.map(e=>e.ms));item.renderers=raw.renderers;item.gpu=raw.gpu;item.duration_ms=raw.duration_ms;
   await fs.writeFile(resolve(out,`${game}-cpu${cpu}-fixture-raw.json`),JSON.stringify(raw,null,2));await page.screenshot({path:resolve(out,`${game}-cpu${cpu}-fixture.png`)});
   if(process.env.OASIS_PROFILE_CPU_PROFILE==='1'){const {profile}=await cdp.send('Profiler.stop');await fs.writeFile(resolve(out,`${game}-cpu${cpu}.cpuprofile`),JSON.stringify(profile));}
  }catch(e){item.error=e.message;}finally{await context.close();await fs.writeFile(resolve(out,'fixture.json'),JSON.stringify(fixture,null,2));console.log(JSON.stringify(item));}
 }}finally{await browser.close();await new Promise(r=>server.close(r));fixture.finished_at=new Date().toISOString();await fs.writeFile(resolve(out,'fixture.json'),JSON.stringify(fixture,null,2));}
}
