/** Real-device collector. --run is required for every ADB/HTTP/UI action. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,lstat,chmod} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {chromium,request as httpRequest} from 'playwright';
import {ARENA_IDS,ARENA_GAMES} from '../shared/games.mjs';
import {readPlayerArtifact,readPlayerCredentials,createPlayerEvidenceRedactor,playerResourceManifest,assertPlayerResourceBody,assertInstalledPlayerArtifact,assertPlayerLobbyBaseline,assertPlayerZeroWallet,assertOwnedPlayerArenaState} from './android-player-acceptance-checks.mjs';
import {parseAndroidForwards,ownedAndroidForward,assertAndroidForwardsRestored,androidForeground,assertAndroidSessionBaseline,cleanupOwnedAndroidSession} from './android-webview-checks.mjs';
import {observeNativeBrowser,createNativeCleanupApi,nativeErrorsEmpty} from '../deploy/native-browser-checks.mjs';
import {playerTouchFrame} from './android-player-acceptance.mjs';
import {playOneArenaAction} from './android-game-actions.mjs';
import {canExercise,activityRoomState} from './mobile-continuous-driver.mjs';
import {waitForPlayable} from './mobile-quality-metrics.mjs';
import {ANDROID_PERFORMANCE_SCHEMA,performanceArguments,physicalAdbArgs,parseWebViewProvider,parseThermal,parseRefresh,assertGameContext,authorityCursor,assertPerformanceRoom,activeMotionState,acceptedPerformanceAction,installPhysicalProbe,verifyProbe,pixelDifference,cacheSchedule,assertCachePosture,evaluateAndroidPerformance,runtimeSourcePins,finalizePerformanceStatus,hash} from './android-player-performance-checks.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url)),execute=promisify(execFile),require=createRequire(import.meta.url);
const standards=JSON.parse(await readFile(join(ROOT,'specs/mobile-quality-v1.json'),'utf8'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(predicate,label,timeout=45000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(100);}throw Error(label+'_TIMEOUT');};
const sourceFiles=['scripts/android-player-performance.mjs','scripts/android-player-performance-checks.mjs','scripts/android-player-acceptance.mjs','scripts/android-player-acceptance-checks.mjs','scripts/android-webview-checks.mjs','scripts/android-game-actions.mjs','scripts/mobile-quality-metrics.mjs','scripts/mobile-continuous-driver.mjs','deploy/native-browser-checks.mjs','specs/mobile-quality-v1.json'];
const sceneSelectors={run:'.run-scene canvas',towerlink:'.towerlink-game canvas',golf:'.og-game canvas',bowling:'.bowling-game canvas',carrom:'.oc-game canvas',pool:'.op-game canvas',darts:'.da-board',match:'.match-cells',ludo:'.ludo-board',jackaroo:'.jack-board',domino:'.do-chain'};

function ownedObserver(page,args){
 const events=['request','requestfinished','requestfailed','response','pageerror','console','close'],before=new Map(events.map(event=>[event,new Set(page.listeners(event))]));
 const drain=observeNativeBrowser(page,args),listeners=events.flatMap(event=>page.listeners(event).filter(fn=>!before.get(event).has(fn)).map(fn=>({event,fn})));
 return {drain,detach(){for(const{event,fn}of listeners)page.off(event,fn);}};
}

export async function assertRuntimeSources(root,pins){
 for(const [path,digest]of Object.entries(pins)){
  let current=resolve(root);const parts=path.split('/');
  assert.ok(parts.length>1&&parts.every(part=>part!==''&&part!=='.'&&part!=='..'&&!part.includes('\\')&&!part.includes('\0')),'UNSAFE_RUNTIME_INPUT_PATH');
  for(let index=0;index<parts.length;index++){
   current=join(current,parts[index]);const info=await lstat(current);
   assert.ok(!info.isSymbolicLink()&&(index===parts.length-1?info.isFile():info.isDirectory()),'UNSAFE_RUNTIME_SOURCE_FILE: '+path);
  }
  assert.equal(hash(await readFile(current)),digest,'MEASURED_RUNTIME_SOURCE_CHANGED: '+path);
 }
 assert.ok(Object.keys(pins).length>0,'EMPTY_RUNTIME_SOURCE_PINS');
 return {count:Object.keys(pins).length,pinsSha256:hash(JSON.stringify(pins)),verifiedAt:new Date().toISOString()};
}

/** Observation failures must never suppress independently proven own cleanup. */
export async function cleanupPerformanceRound({active,baseline,stopUI,api,until,newId,clean=String}){
 const{state,result,observer,collector,round}=active;round.observerErrors??=[];
 const observationError=(stage,error)=>{round.observerErrors.push(stage+': '+clean(error.message));};
 try{await stopUI(round);result.ui_stopped=round.uiStopped;}catch(error){round.cleanup={attempted:false,passed:false,error:'UI_STOP: '+clean(error.message)};}
 try{await observer.drain({final:false});}catch(error){observationError('NATIVE_DRAIN_BEFORE_CLEANUP',error);}
 if(round.uiStopped===true){
  try{
   if(state.androidBaseline){assertOwnedPlayerArenaState(state,baseline);state.phase='cleanup';round.cleanup=await cleanupOwnedAndroidSession({state,arenaGames:ARENA_IDS,api,until,newId,uiStopped:true,clean});}
   else{assert.equal((state.creations?.length||0)+(state.actionRequests?.length||0)+(state.inputsRequests?.length||0),0,'MUTATION_WITHOUT_CLEAN_BASELINE');assert.equal(state.practiceRequested,false,'PRACTICE_WITHOUT_CLEAN_BASELINE');round.cleanup={passed:true,attempted:false};}
  }catch(error){round.cleanup={attempted:false,passed:false,error:'OWNED_SCOPE_CLEANUP: '+clean(error.message)};}
 }
 try{await observer.drain({final:true});}catch(error){observationError('NATIVE_FINAL_DRAIN',error);}
 round.nativeObserverPassed=nativeErrorsEmpty(result)&&!round.observerErrors.some(error=>error.startsWith('NATIVE_'));round.nativeEvidence=result;
 try{await collector?.drain();}catch(error){observationError('CDP_DRAIN',error);}
 round.network=collector?.summary();round.actions=collector?.actions||[];round.observerErrors.push(...(collector?.errors||[]),...(result.observer_errors||[]).map(error=>error.message),...(!round.nativeObserverPassed?['NATIVE_FUNCTIONAL_OBSERVATIONS_FAILED']:[]));
 try{await collector?.close();}catch(error){observationError('CDP_CLOSE',error);}
 try{observer.detach();}catch(error){observationError('NATIVE_DETACH',error);}
 return round.cleanup;
}

/** No raw CDP headers, cookies, authorization, launch exchange or API bodies leave memory. */
export async function createPhysicalNetworkCollector({context,page,origin,game,state,baseline,manifest,nonce,round,drainTimeoutMs=20000}){
 assert.ok(Number.isSafeInteger(drainTimeoutMs)&&drainTimeoutMs>0&&drainTimeoutMs<=20000,'BOUNDED_DRAIN_TIMEOUT_REQUIRED');
 const cdp=await context.newCDPSession(page),contexts=new Map(),requests=new Map(),tasks=new Set(),errors=[],records=[],actions=[];let candidateFrame=null,scope=null,bytes=0,closed=false;
 const handlers=[],on=(event,fn)=>{cdp.on(event,fn);handlers.push({event,fn});};
 const tracked=fn=>{const task=Promise.resolve().then(fn).catch(error=>errors.push(error.message));tasks.add(task);void task.finally(()=>tasks.delete(task));};
 on('Runtime.executionContextCreated',({context:realm})=>contexts.set(realm.id,realm));on('Runtime.executionContextDestroyed',({executionContextId})=>contexts.delete(executionContextId));on('Runtime.executionContextsCleared',()=>contexts.clear());
 on('Page.frameNavigated',({frame})=>{if(frame.url===origin+'/play/'+game){if(candidateFrame&&candidateFrame!==frame.id)errors.push('GAME_FRAME_REPLACED');candidateFrame=frame.id;}else if(scope?.frameId===frame.id)errors.push('GAME_FRAME_NAVIGATED_AWAY');});
 on('Network.requestWillBeSent',event=>{
  try{
   const u=new URL(event.request.url);if(event.type==='Document'&&u.href===origin+'/play/'+game){assert.ok(!candidateFrame||candidateFrame===event.frameId,'DUPLICATE_GAME_FRAME');candidateFrame=event.frameId;}
   if(event.frameId!==candidateFrame)return;
   if(u.origin!==origin)assert.ok(['https://fonts.googleapis.com','https://fonts.gstatic.com'].includes(u.origin),'UNEXPECTED_GAME_NETWORK_ORIGIN');
   assert.ok(requests.size<50000,'NETWORK_RECORD_BOUND_EXCEEDED');assert.ok(!event.redirectResponse,'GAME_RESOURCE_REDIRECT_REFUSED');assert.ok(Number.isFinite(event.timestamp)&&Number.isFinite(event.wallTime),'NETWORK_REQUEST_CLOCK_UNPROVEN');
   const isAction=event.request.method==='POST'&&/^\/api\/pvp\/rooms\/[^/]+\/(?:action|inputs)$/.test(u.pathname),isRoom=event.request.method==='GET'&&/^\/api\/pvp\/rooms\/[^/]+$/.test(u.pathname),isStatic=!/^\/(?:api|v1)\//.test(u.pathname)&&(['Document','Script','Stylesheet','Image','Font','Media'].includes(event.type)||/\.(?:js|mjs|css|png|webp|svg|jpg|jpeg|glb|wasm|woff2|ogg|mp3)$/.test(u.pathname));
   const row={id:event.requestId,frameId:event.frameId,url:u.href,path:u.pathname,method:event.request.method,type:event.type,start:event.timestamp,wall:event.wallTime*1000,isAction,isRoom,isStatic,response:null,cached:false,before:null,request:null};
   if(isAction){assertPerformanceRoom(state.room,{game,baseline,ownedRooms:state.ownedRooms});assert.equal(u.pathname,`/api/pvp/rooms/${state.room.id}/${game==='run'&&state.room.run_inputs?'inputs':'action'}`,'UNOWNED_ACTION_REQUEST');assert.ok((event.request.headers.Authorization||event.request.headers.authorization)==='Bearer '+state.token,'ORIGINAL_ACTION_TOKEN_REQUIRED');row.before=structuredClone(state.room);row.request=JSON.parse(event.request.postData);}
   requests.set(event.requestId,row);
  }catch(error){errors.push(error.message);}
 });
 on('Network.requestServedFromCache',({requestId})=>{const row=requests.get(requestId);if(row)row.cached=true;});
 on('Network.responseReceived',({requestId,response})=>{const row=requests.get(requestId);if(row)row.response={status:response.status,protocol:response.protocol,mime:response.mimeType,fromDiskCache:response.fromDiskCache===true,fromServiceWorker:response.fromServiceWorker===true,timing:response.timing||null};});
 on('Network.loadingFailed',({requestId,errorText,canceled})=>{const row=requests.get(requestId);if(row){errors.push('GAME_NETWORK_FAILED: '+errorText);row.failed=true;row.canceled=!!canceled;}});
 on('Network.loadingFinished',event=>{
  const row=requests.get(event.requestId);if(!row)return;tracked(async()=>{
   assert.equal(row.frameId,candidateFrame,'NETWORK_GAME_FRAME_CHANGED');assert.ok(row.response,'NETWORK_RESPONSE_MISSING');assert.ok(row.response.status>=200&&row.response.status<300||row.response.status===304,'GAME_HTTP_FAILURE');assert.ok(Number.isFinite(event.encodedDataLength)&&event.encodedDataLength>=0,'ENCODED_TRANSFER_UNAVAILABLE');
   const record={path:row.path.replace(/\/rooms\/[^/]+/,'/rooms/[owned]'),method:row.method,type:row.type,static:row.isStatic,status:row.response.status,encodedTransferBytes:event.encodedDataLength,durationMs:(event.timestamp-row.start)*1000,cache:{memory:row.cached,disk:row.response.fromDiskCache,serviceWorker:row.response.fromServiceWorker,revalidated:row.response.status===304},protocol:row.response.protocol,timing:row.response.timing,frameId:row.frameId};
   assert.ok(!row.response.fromServiceWorker,'UNREVIEWED_SERVICE_WORKER_DELIVERY');
   if(row.isStatic){const body=await cdp.send('Network.getResponseBody',{requestId:event.requestId}),data=Buffer.from(body.body,body.base64Encoded?'base64':'utf8');bytes+=data.length;assert.ok(bytes<=256*1024*1024,'RESOURCE_BODY_BOUND_EXCEEDED');record.resourcePin=assertPlayerResourceBody(row.url,data,{origin,manifest})||{sha256:hash(data),bytes:data.length,source:'Observed external HTTPS font asset; not a release output pin'};}
   if(row.isAction){assert.ok(scope,'ACTION_BEFORE_PROVEN_GAME_CONTEXT');const response=await cdp.send('Network.getResponseBody',{requestId:event.requestId}),data=Buffer.from(response.body,response.base64Encoded?'base64':'utf8');assert.ok(data.length<=2*1024*1024,'ACTION_BODY_BOUND_EXCEEDED');const body=JSON.parse(data),after=body.room||body;
    const probe=await evaluate('(()=>{const p=globalThis.__oasisPhysicalPerf;return {schema:p.schema,nonce:p.nonce,documentId:p.documentId,url:p.url,timeOrigin:p.timeOrigin,frames:[],longTasks:[],gestures:p.gestures.slice(-8)};})()');verifyProbe(probe,{origin,game,nonce,documentId:round.documentId});const gesture=[...probe.gestures].reverse().find(g=>g.completedEpochMs<=row.wall&&row.wall-g.completedEpochMs<1000);
    const proof=acceptedPerformanceAction({game,before:row.before,request:row.request,after,status:row.response.status,gesture,startedAt:row.wall,finishedAt:row.wall+(event.timestamp-row.start)*1000});
    actions.push({...proof,responseSha256:hash(data),requestSha256:hash(JSON.stringify(row.request)),roomIdHash:hash(after.id),source:'Exact game-frame CDP transfer plus trusted pointer completion and declared authority cursor',confirmationScope:'Complete network authority reply; excludes application JSON-read/visible-feedback time'});
   }
   records.push(record);row.finished=true;
  });
 });
 await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:false});
 async function bind(){const{frameTree}=await cdp.send('Page.getFrameTree');scope=assertGameContext({tree:frameTree,contexts:[...contexts.values()],origin,game,topUrl:page.url()});assert.equal(scope.frameId,candidateFrame,'OBSERVED_FRAME_IDENTITY_MISMATCH');return scope;}
 async function evaluate(expression){assert.ok(scope&&contexts.has(scope.contextId),'GAME_EXECUTION_CONTEXT_LOST');const value=await cdp.send('Runtime.evaluate',{expression,contextId:scope.contextId,returnByValue:true,awaitPromise:true});assert.ok(!value.exceptionDetails,'GAME_PROBE_EVALUATION_FAILED');return value.result.value;}
 return {cdp,errors,records,actions,bind,evaluate,
  pendingStatic(){return [...requests.values()].filter(r=>r.isStatic&&!r.finished&&!r.failed).length;},
  async clearOwnHttpCache(){await cdp.send('Network.clearBrowserCache');},
  async drain(){const end=Date.now()+drainTimeoutMs;try{while(tasks.size){const remaining=end-Date.now();assert.ok(remaining>0,'PERFORMANCE_NETWORK_DRAIN_TIMEOUT');let timer;try{await Promise.race([Promise.all([...tasks]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('PERFORMANCE_NETWORK_DRAIN_TIMEOUT')),remaining);})]);}finally{clearTimeout(timer);}}}finally{round.pendingWork=tasks.size;}},
  summary(){const staticRows=records.filter(r=>r.static),images=staticRows.filter(r=>r.type==='Image'||/\.(?:png|webp|svg|jpg|jpeg)$/.test(r.path)),snapshots=records.filter(r=>r.method==='GET'&&/^\/api\/pvp\/rooms\//.test(r.path));return {staticEncodedBytes:staticRows.length?staticRows.reduce((s,r)=>s+r.encodedTransferBytes,0):null,imageMaxEncodedBytes:images.length?Math.max(...images.map(r=>r.encodedTransferBytes)):staticRows.length?0:null,snapshotMaxEncodedBytes:snapshots.length?Math.max(...snapshots.map(r=>r.encodedTransferBytes)):null,records,bodyPinsOnly:true,headersStored:false,apiBodiesStored:false,encodedScope:'Unmodified actual CDP encodedDataLength includes transport headers, including any 304 header transfer; cache delivery flags are separate'};},
  cacheFacts(){return {diskCacheSeen:records.some(r=>r.cache.disk),memoryCacheSeen:records.some(r=>r.cache.memory),reuseObserved:records.some(r=>r.cache.disk||r.cache.memory||r.status===304)};},
  async close(){if(closed)return;closed=true;try{await this.drain();}finally{for(const {event,fn}of handlers)cdp.off(event,fn);await cdp.detach();}}
 };
}

export async function runAndroidPerformance(options){
 assert.ok(!process.env.NODE_TLS_REJECT_UNAUTHORIZED||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='1','STRICT_TLS_REQUIRED');
 const redactor=createPlayerEvidenceRedactor(),artifact=await readPlayerArtifact(options.metadata,{shellRoot:join(ROOT,'android-player'),execute,apksigner:options.apksigner});assert.equal(new URL(artifact.origin).protocol,'https:');
 const manifestPath=resolve(options.platformManifest),info=await lstat(manifestPath);assert.ok(info.isFile()&&!info.isSymbolicLink());const rawManifest=await readFile(manifestPath),manifest=playerResourceManifest(JSON.parse(rawManifest));
 const runtimePins=runtimeSourcePins(manifest.inputs,{games:options.games}),runtimeSourcesBefore=await assertRuntimeSources(ROOT,runtimePins);
 const sources=Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,hash(await readFile(join(ROOT,path)))]))),out=resolve(options.output);await mkdir(out,{mode:0o700});await chmod(out,0o700);
 const report={schema:ANDROID_PERFORMANCE_SCHEMA,startedAt:new Date().toISOString(),executed:false,physicalDevice:false,passed:false,status:'preflight',fullCatalog:options.fullCatalog,selectedGames:options.games,measurementSources:sources,standard:{version:standards.version,sha256:sources['specs/mobile-quality-v1.json'],thresholds:standards.thresholds},artifact:{metadataSha256:artifact.metadataSha256,apkSha256:artifact.apkSha256,certificateSha256:artifact.certificateSha256,origin:artifact.origin,appId:artifact.appId,packageName:artifact.packageName},releaseManifestSha256:hash(rawManifest),runtimeSources:{before:runtimeSourcesBefore,after:null},configuration:{sampleMs:options.sampleMs,roomMs:options.roomMs,repetitions:options.repetitions,shortDiagnostic:options.shortDiagnostic},rounds:[],games:[],resources:{errors:[],events:[]},limitations:['Actual Android WebView RAF execution intervals and cropped scene pixel changes; not GPU/presented-frame FPS or iPhone Safari.','Uncontrolled network timings are diagnostics, not calibrated Wi-Fi latency acceptance.','Unsupported and missing observations remain partial; no synthetic authority, funds or new account.','This report does not accept probability games, third-party transfer, content playability or server capacity.']};
 const save=async()=>writeFile(join(out,'report.json'),JSON.stringify(redactor.sanitize(report),null,2)+'\n',{mode:0o600});await save();
 if(!options.run){report.preflightPassed=true;report.scope='Local signed artifact/source preflight only. No ADB, network, phone or gameplay.';await save();return report;}
 const credentials=await readPlayerCredentials(options.credentialsFile,redactor),origin=artifact.origin,pkg=artifact.packageName,component=pkg+'/com.tianyahuyu.oasis.player.MainActivity';
 const adb=async(...args)=>(await execute('adb',physicalAdbArgs(options,args),{timeout:45000,maxBuffer:4*1024*1024})).stdout.trim(),forwards=async()=>parseAndroidForwards(await adb('forward','--list'));
 let beforeForwards,foreground,forward,browser,context,page,apiContext,baseline,ownedStarted=false,active=null;
 const beforeState={};
 const topRead=async path=>{assert.ok(/^\/api\/player\/(app|session|wallet|recovery)(?:\?app_id=[A-Za-z0-9_-]+)?$/.test(path));const result=await page.evaluate(async path=>{const r=await fetch(path,{credentials:'same-origin',cache:'no-store'});return {status:r.status,body:await r.json()};},path);redactor.remember(result.body);return result;};
 const requiredRead=async path=>{const r=await topRead(path);assert.equal(r.status,200,'PLAYER_READ_FAILED');return r.body;};
 const tap=async(target,{position}={})=>{await target.scrollIntoViewIfNeeded();const b=await target.boundingBox();assert.ok(b&&b.width>0&&b.height>0);const targets=await fetch('http://127.0.0.1:'+forward.port+'/json/list',{signal:AbortSignal.timeout(5000)}).then(r=>r.json()),match=targets.filter(t=>t.url===artifact.entryUrl);assert.equal(match.length,1);const box=JSON.parse(match[0].description),viewport=await page.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio}));assert.ok(Math.abs(box.width/viewport.width-viewport.dpr)<.1);const x=Math.round(box.screenX+(b.x+(position?.x??b.width/2))*viewport.dpr),y=Math.round(box.screenY+(b.y+(position?.y??b.height/2))*viewport.dpr);assert.ok(x>=box.screenX&&x<box.screenX+box.width&&y>=box.screenY&&y<box.screenY+box.height);await adb('shell','input','tap',String(x),String(y));};
 const stopUI=async round=>{if(page&&!page.isClosed()&&await page.locator('.player-lobby').isVisible()&&await page.locator('iframe').count()===0){round.uiStopped=true;return;}await adb('shell','am','force-stop',pkg);await until(async()=>!(await adb('shell','pidof',pkg).catch(e=>{if(e.code===1)return '';throw e;})),'OWN_QA_UI_STOP');round.uiStopped=true;};
 const cleanup=async()=>{
  if(!active)return;const current=active,{state,result,round}=current;
  try{await cleanupPerformanceRound({active:current,baseline,stopUI,api:createNativeCleanupApi({page:{request:apiContext},origin,state,result,clean:redactor.clean}),until,newId:()=> 'physical_cleanup_'+randomUUID().replaceAll('-',''),clean:redactor.clean});}
  catch(error){round.cleanup={attempted:false,passed:false,error:redactor.clean(error.message)};round.observerErrors??=[];round.observerErrors.push('ROUND_CLEANUP_UNEXPECTED: '+redactor.clean(error.message));}
  finally{active=null;}
 };
 try{
  report.executed=true;const deviceState=await adb('get-state');assert.equal(deviceState,'device','PHYSICAL_DEVICE_OFFLINE');const devices=await adb('devices','-l');assert.ok(devices.split('\n').some(line=>line.split(/\s+/)[0]===options.serial&&line.split(/\s+/)[1]==='device'&&line.includes('usb:')),'EXACT_USB_DEVICE_REQUIRED');report.physicalDevice=true;
  const paths=(await adb('shell','pm','path',pkg)).split(/\r?\n/);assert.equal(paths.length,1);assert.match(paths[0],/^package:\/data\/app\/[A-Za-z0-9_./=+~-]+\/base\.apk$/);const packageInfo=await adb('shell','dumpsys','package',pkg);report.installed=assertInstalledPlayerArtifact({apkSha256:(await adb('shell','sha256sum',paths[0].slice(8))).split(/\s+/)[0],version:packageInfo.match(/\bversionName=([^\s]+)/)?.[1],versionCode:Number(packageInfo.match(/\bversionCode=(\d+)/)?.[1]),debuggable:/\bDEBUGGABLE\b/.test(packageInfo)},artifact);
  report.device={serial:options.serial,adbPort:options.adbPort,model:await adb('shell','getprop','ro.product.model'),os:await adb('shell','getprop','ro.build.version.release'),api:Number(await adb('shell','getprop','ro.build.version.sdk')),abi:await adb('shell','getprop','ro.product.cpu.abilist'),webview:parseWebViewProvider(await adb('shell','dumpsys','webviewupdate')),refresh:parseRefresh(await adb('shell','dumpsys','display')),thermalBefore:parseThermal(await adb('shell','dumpsys','thermalservice'))};
  beforeForwards=await forwards();foreground=androidForeground(await adb('shell','dumpsys','activity','activities'));report.resources.foregroundBeforeHash=hash(foreground);beforeState.webview=report.device.webview;ownedStarted=true;
  await adb('shell','am','force-stop',pkg);await adb('shell','am','start','-n',component);await until(async()=>/^\d+$/.test(await adb('shell','pidof',pkg)),'OWN_QA_PID');const pid=await adb('shell','pidof',pkg),remote='localabstract:webview_devtools_remote_'+pid;
  await until(async()=>(await adb('shell','cat','/proc/net/unix')).includes('@webview_devtools_remote_'+pid),'OWN_QA_DEBUG_SOCKET');const existing=await forwards(),port=await adb('forward','tcp:0',remote);forward={serial:options.serial,port:Number(port),local:'tcp:'+port,remote};ownedAndroidForward(existing,await forwards(),forward);report.resources.events.push({event:'owned-forward-created',...forward});
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{isWebView:true,noDefaults:true,timeout:15000});assert.equal(browser.contexts().length,1);context=browser.contexts()[0];await until(()=>context.pages().length===1,'OWN_QA_SINGLE_PAGE');page=context.pages()[0];await until(()=>page.url()===artifact.entryUrl,'ACTUAL_PLAYER_ENTRY');page.setDefaultTimeout(45000);
  // Identity/authentication run before attaching any network body observer.
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('.player-lobby').waitFor();const existingLogin=await topRead('/api/player/session');
  if(existingLogin.status===200)assert.equal(existingLogin.body.player?.username,credentials.username,'INHERITED_LOGIN_PRESERVED');else{assert.equal(existingLogin.status,401);assert.equal(existingLogin.body.error?.code,'LOGIN_REQUIRED');await page.locator('input[name="username"]').fill(credentials.username);await page.locator('input[name="password"]').fill(credentials.password);const login=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/player/login'&&r.request().method()==='POST');await tap(page.getByRole('button',{name:'登录',exact:true}));assert.equal((await login).status(),200);}
  await page.locator('.player-games').waitFor();baseline=assertPlayerLobbyBaseline({metadata:await requiredRead('/api/player/app?app_id='+artifact.appId),session:await requiredRead('/api/player/session'),wallet:await requiredRead('/api/player/wallet?app_id='+artifact.appId),recovery:await requiredRead('/api/player/recovery?app_id='+artifact.appId),appId:artifact.appId,username:credentials.username});redactor.add(baseline.playerId);redactor.add(baseline.externalUserId);
  apiContext=await httpRequest.newContext({ignoreHTTPSErrors:false,timeout:12000});const nonce=randomUUID(),cacheSession=randomUUID();await context.addInitScript(installPhysicalProbe,{origin,nonce});report.executed=true;report.physicalDevice=true;report.webviewSessionId=cacheSession;report.inputScope='ADB native taps and CDP trusted touch drags; no JavaScript-dispatched input';
  // Use the PNG decoder already shipped by the pinned Playwright dependency.
  const decoderPath=join(dirname(require.resolve('playwright-core')),'lib/utilsBundle.js'),{PNG}=require(decoderPath);assert.ok(typeof PNG?.sync?.read==='function','PNG_DECODER_UNAVAILABLE');report.motionDecoder={source:'Installed Playwright bundled PNG decoder',sha256:hash(await readFile(decoderPath))};
  const primed=new Set();
  for(const item of cacheSchedule(options.games,options.repetitions)){
   const{game,cacheMode,iteration}=item;assert.deepEqual(parseWebViewProvider(await adb('shell','dumpsys','webviewupdate')),beforeState.webview,'SYSTEM_PROVIDER_CHANGED');assert.equal(await adb('shell','pidof',pkg),pid,'OWNED_WEBVIEW_PID_CHANGED');assert.deepEqual((await requiredRead('/api/player/recovery?app_id='+artifact.appId)).sessions,[],'INHERITED_OBLIGATIONS_PRESERVED');
   const round={id:game+'-'+cacheMode+'-'+iteration,game,cacheMode,iteration,passed:false,entry:null,actions:[],motion:{pairs:[],method:'Decoded pixels of cropped actual scene surfaces; screenshot overhead remains visible in recorded RAF'},observerErrors:[]};report.rounds.push(round);
   const state={game,token:null,sessionId:null,playerId:null,appId:null,room:null,ownedRooms:new Set(),practiceRequested:false,spins:[],acks:new Set(),returning:false,phase:'entry'},result={game,observer_errors:[]};
   const observer=ownedObserver(page,{origin,state,result,clean:redactor.clean,remember:body=>{redactor.remember(body);if(body.access_token){assert.equal(body.scope?.app_id,baseline.appId);assert.equal(body.external_user_id,baseline.externalUserId);state.appId=body.scope.app_id;}}});
   let collector,touch,sampling=false,samplingPump,pumpError;active={state,result,observer,collector:null,round};
   try{
    collector=await createPhysicalNetworkCollector({context,page,origin,game,state,baseline,manifest,nonce,round});active.collector=collector;
    round.cache={sessionId:cacheSession,cacheDisabled:false,routing:false,cookiesCleared:false,httpCacheCleared:cacheMode==='cold',mainDocumentReloaded:false,sameContext:true,primed:primed.has(game),passed:false};
    if(cacheMode==='cold'){await collector.clearOwnHttpCache();await page.reload({waitUntil:'domcontentloaded'});await page.locator('.player-games').waitFor();round.cache.mainDocumentReloaded=true;}
    assert.equal(page.url(),artifact.entryUrl,'PLAYER_DOCUMENT_CHANGED');if(cacheMode==='cold')await collector.clearOwnHttpCache();const start=Date.now();round.startedAt=new Date(start).toISOString();await tap(page.locator('.player-game-card').filter({has:page.getByText(ARENA_GAMES[game].name,{exact:true})}));
    await until(()=>Boolean(state.token&&state.sessionId),'ACTUAL_LAUNCH_EXCHANGE');await until(()=>page.frames().some(f=>f.url()===origin+'/play/'+game),'ACTUAL_GAME_IFRAME');const frame=page.frames().find(f=>f.url()===origin+'/play/'+game);assert.equal(await page.locator('iframe').count(),1);
    await collector.bind();const probe=await collector.evaluate('(()=>globalThis.__oasisPhysicalPerf)()');verifyProbe(probe,{origin,game,nonce});round.documentId=probe.documentId;round.context=await collector.bind();
    const read=createNativeCleanupApi({page:{request:apiContext},origin,state,result,clean:redactor.clean});assertAndroidSessionBaseline(state,await read('/api/arena/session'),ARENA_IDS);assertOwnedPlayerArenaState(state,baseline);
    state.phase='playing';state.practiceRequested=true;await tap(frame.getByRole('button',{name:'免费练习',exact:false}));await tap(frame.getByRole('button',{name:'确认规则 · 准备开局',exact:true}));await until(()=>state.room?.status==='active','OWN_FREE_BOT_ACTIVE');assertPerformanceRoom(state.room,{game,baseline,ownedRooms:state.ownedRooms});redactor.add(state.room.id);round.roomIdHash=hash(state.room.id);
    const ready=await waitForPlayable(frame,game,{pendingStatic:()=>collector.pendingStatic(),readRoom:()=>state.room});round.entry={ready:ready.ready,elapsedMs:Date.now()-start-ready.turn_wait_ms-ready.other_player_ready_wait_ms,wallMs:Date.now()-start,excludedTurnWaitMs:ready.turn_wait_ms,excludedOtherReadyMs:ready.other_player_ready_wait_ms,scene:ready};
    touch=playerTouchFrame(frame,{tap,touch:async(type,x,y)=>collector.cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y,id:1}],modifiers:0})});
    await collector.evaluate('(()=>{globalThis.__oasisPhysicalPerf.sampleStartAt=performance.now();return true;})()');const began=Date.now(),windowMs=Math.max(options.roomMs,Math.ceil(options.sampleMs/(options.repetitions*2))),deadline=began+windowMs;let previousRoom=state.room,receipt=Date.now(),nextAction=0,nextMotion=0,lastCursor=authorityCursor(game,state.room);
    sampling=true;samplingPump=(async()=>{while(sampling){assertPerformanceRoom(state.room,{game,baseline,ownedRooms:state.ownedRooms});if(state.room!==previousRoom){previousRoom=state.room;receipt=Date.now();}const motion=activeMotionState(game,state.room,Date.now()-receipt);await collector.evaluate(`(()=>{const p=globalThis.__oasisPhysicalPerf;if(p.documentId!==${JSON.stringify(round.documentId)})throw Error('DOCUMENT_CHANGED');p.active=${motion.active};p.moving=${motion.moving};p.validUntil=performance.now()+500;return true;})()`);await sleep(100);}})().catch(error=>{pumpError=error;});
    while(Date.now()<deadline){
     if(pumpError)throw pumpError;
     assertPerformanceRoom(state.room,{game,baseline,ownedRooms:state.ownedRooms});if(state.room!==previousRoom){previousRoom=state.room;receipt=Date.now();}
     const status=activityRoomState(state.room,game,state.room.id),motion=activeMotionState(game,state.room,Date.now()-receipt);
     if(status==='terminal'){
      round.naturallyCompleted=state.room.status==='settled'||state.room.game?.status==='finished';round.terminalEvidence={roomStatus:state.room.status,gameStatus:state.room.game?.status,authoritySha256:hash(JSON.stringify(state.room)),source:'Original authorized room snapshot; a player finish alone is not a complete round'};
      if(state.room.game?.phase==='fault'||state.room.status==='fault')throw Error('AUTHORITATIVE_GAME_FAULT');
      const me=state.room.game?.me&&typeof state.room.game.me==='object'?state.room.game.me:state.room.game?.players?.find?.(p=>p.key===state.room.me);
      if(round.naturallyCompleted||me?.forfeited||me?.eliminated||['cancelled','voided'].includes(state.room.status))break;
      // A personal finish is kept on screen until the original match outcome,
      // without pretending the completed runner/board is active or moving.
     }
     if(motion.moving&&Date.now()>=nextMotion&&round.motion.pairs.length<12){
      const target=frame.locator(sceneSelectors[game]).first();if(await target.count()&&await target.isVisible()){
       const captureStart=Date.now(),a=await target.screenshot({type:'png',timeout:5000}),at=Date.now();await sleep(160);const b=await target.screenshot({type:'png',timeout:5000});
       const pair=pixelDifference(PNG.sync.read(a),PNG.sync.read(b));Object.assign(pair,{startEpochMs:captureStart,endEpochMs:Date.now(),firstCapturedEpochMs:at,authorityMovingBefore:true,authorityMovingAfter:activeMotionState(game,state.room,Date.now()-receipt).moving});if(!pair.authorityMovingAfter)pair.moved=false;
       round.motion.pairs.push(pair);await writeFile(join(out,round.id+'-motion-'+round.motion.pairs.length+'-a.png'),a,{mode:0o600,flag:'wx'});await writeFile(join(out,round.id+'-motion-'+round.motion.pairs.length+'-b.png'),b,{mode:0o600,flag:'wx'});nextMotion=Date.now()+5000;
      }else{round.motion.unavailable='Exact render surface selector is absent; RAF is insufficient.';nextMotion=Date.now()+5000;}
     }
     if(status==='active'&&Date.now()>=nextAction&&canExercise(game,state.room)&&authorityCursor(game,state.room)>=lastCursor&&deadline-Date.now()>=3000){
      const before=state.room;try{const action=await playOneArenaAction(touch.frame,game,()=>state.room,{touch:true,timeoutMs:Math.min(8000,deadline-Date.now()),deadlineAt:deadline,beforeAction:()=>assertPerformanceRoom(state.room,{game,baseline,ownedRooms:state.ownedRooms})});assert.equal(action.sequenceBefore,authorityCursor(game,before),'DECLARED_CURSOR_CHANGED_BEFORE_UI');lastCursor=action.sequenceAfter;round.trustedUiActions??=[];round.trustedUiActions.push({type:action.actionType,protocol:action.protocol||'arena-action-v1',cursorBefore:action.sequenceBefore,cursorAfter:action.sequenceAfter});}
      catch(error){round.rejectedUiActions??=[];round.rejectedUiActions.push({status:error.status||null,code:error.code||null,message:redactor.clean(error.message)});if(!(error.status===409&&['BUSY','STALE_INPUT','INPUT_PENDING','RATE_LIMIT','NOT_YOUR_TURN','TURN_EXPIRED','NOT_ACTIVE'].includes(error.code)))throw error;}
      nextAction=Date.now()+1000;
     }
     await sleep(100);
    }
    sampling=false;await samplingPump;if(pumpError)throw pumpError;await touch.release();round.sampleWallMs=Date.now()-began;await collector.drain();await observer.drain({final:false});
    const snapshot=await collector.evaluate('(()=>{const p=globalThis.__oasisPhysicalPerf;p.sampleEndAt=performance.now();p.stop();return p;})()');verifyProbe(snapshot,{origin,game,nonce,documentId:round.documentId});round.probe=snapshot;
    round.renderers=await frame.evaluate(()=>[...document.querySelectorAll('[data-render-calls],[data-render-quality],[data-art-quality]')].map(e=>({tag:e.tagName,data:Object.fromEntries(Object.entries(e.dataset).filter(([key])=>/render|triangle|quality|capture|sceneReady/i.test(key)))})));
    state.returning=true;state.phase='returning';await adb('shell','input','keyevent','4');await sleep(200);const leave=frame.getByRole('button',{name:'确认离开',exact:true});if(!frame.isDetached()&&await leave.isVisible())await tap(leave);const confirm=frame.locator('[data-return="confirm"]');if(!frame.isDetached()&&await confirm.isVisible())await tap(confirm);await page.locator('.player-games').waitFor();assert.equal(await page.locator('iframe').count(),0);round.returned=true;round.uiStopped=true;
    await collector.drain();Object.assign(round.cache,collector.cacheFacts());try{assertCachePosture(round.cache,{mode:cacheMode,sessionId:cacheSession});round.cache.passed=true;}catch(error){round.cache.error=redactor.clean(error.message);}
   }catch(error){round.error=redactor.clean(error.message);}
   finally{sampling=false;await samplingPump;try{await touch?.release();}catch(error){round.observerErrors.push(redactor.clean(error.message));}await cleanup();round.finishedAt=new Date().toISOString();await save();}
   assert.equal(round.cleanup?.passed,true,'OWNED_ROOM_CLEANUP_FAILED');assert.ok(page&&!page.isClosed()&&await page.locator('.player-games').isVisible(),'RETAINED_PLAYER_CONTEXT_LOST');assert.deepEqual((await requiredRead('/api/player/recovery?app_id='+artifact.appId)).sessions,[],'OWN_OBLIGATION_REMAINS');assertPlayerZeroWallet(await requiredRead('/api/player/wallet?app_id='+artifact.appId),artifact.appId,baseline);if(round.returned&&round.network?.records?.length&&!round.error)primed.add(game);
  }
  report.games=options.games.map(game=>evaluateAndroidPerformance(game,report.rounds.filter(r=>r.game===game),standards.thresholds,{sampleMs:options.sampleMs,networkCalibrated:false}));report.status=report.games.some(g=>g.status==='fail')?'fail':'partial';
 }catch(error){report.failure=redactor.clean(error.message);report.status='fail';}
 finally{
  await cleanup();
  try{await apiContext?.dispose();}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  try{await browser?.close();}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  if(forward)try{assert.deepEqual((await forwards()).filter(r=>r.local===forward.local),[{serial:forward.serial,local:forward.local,remote:forward.remote}]);await adb('forward','--remove',forward.local);report.resources.events.push({event:'owned-forward-removed',local:forward.local});}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  if(ownedStarted)try{await adb('shell','am','force-stop',pkg);if(foreground){await adb('shell','am','start','-n',foreground);const restored=androidForeground(await adb('shell','dumpsys','activity','activities'));assert.equal(restored,foreground);report.resources.foregroundRestoredHash=hash(restored);}}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  if(beforeForwards)try{assertAndroidForwardsRestored(beforeForwards,await forwards());report.resources.forwardsRestored=true;}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  if(report.device)try{report.device.thermalAfter=parseThermal(await adb('shell','dumpsys','thermalservice'));assert.deepEqual(parseWebViewProvider(await adb('shell','dumpsys','webviewupdate')),beforeState.webview||report.device.webview);}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  try{const finalSources=Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,hash(await readFile(join(ROOT,path)))])));assert.deepEqual(finalSources,sources,'MEASUREMENT_SOURCE_CHANGED');report.runtimeSources.after=await assertRuntimeSources(ROOT,runtimePins);assert.equal(hash(await readFile(manifestPath)),report.releaseManifestSha256,'RELEASE_MANIFEST_CHANGED');}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  if(report.executed)report.games=options.games.map(game=>evaluateAndroidPerformance(game,report.rounds.filter(r=>r.game===game),standards.thresholds,{sampleMs:options.sampleMs,networkCalibrated:false}));
  report.observedCatalog=[...new Set(report.rounds.filter(r=>r.roomIdHash).map(r=>r.game))];report.catalogComplete=report.fullCatalog&&report.observedCatalog.length===ARENA_IDS.length;finalizePerformanceStatus(report,{shortDiagnostic:options.shortDiagnostic});report.finishedAt=new Date().toISOString();await save();
 }
 return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const options=performanceArguments(process.argv.slice(2),standards.thresholds),report=await runAndroidPerformance(options);console.log(JSON.stringify({schema:report.schema,output:options.output,executed:report.executed,status:report.status,passed:report.passed,games:report.games.map(g=>({game:g.game,status:g.status}))},null,2));process.exitCode=report.passed||report.preflightPassed?0:report.status==='fail'?1:2;}
