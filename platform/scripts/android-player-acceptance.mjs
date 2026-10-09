/** Real Player QA preparation/acceptance. --run is explicit; never installs an APK,
 * creates an account, funds a wallet, reaches SSH, or adopts an inherited room.
 * basic measures one UI action per arena; lifecycle has a separate report/gate.
 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {chromium,request as httpRequest} from 'playwright';
import {ARENA_IDS,ARENA_GAMES} from '../shared/games.mjs';
import {playOneArenaAction} from './android-game-actions.mjs';
import {parseAndroidForwards,ownedAndroidForward,assertAndroidForwardsRestored,androidForeground,assertAndroidSessionBaseline,assertAndroidOneAction,cleanupOwnedAndroidSession} from './android-webview-checks.mjs';
import {installNativeFetchProbe,observeNativeBrowser,runNativeActionOnce,nativeErrorsEmpty,createNativeCleanupApi} from '../deploy/native-browser-checks.mjs';
import {formatPlayerMinor} from '../src/pages/PlayerClient.mjs';
import {playerAcceptanceArguments,readPlayerArtifact,createPlayerEvidenceRedactor,readPlayerCredentials,assertPlayerLobbyBaseline,assertPlayerZeroWallet,assertOwnedPlayerArenaState,assertPlayerReturnReadback,playerResourceManifest,assertPlayerResourceBody,assertInstalledPlayerArtifact,playerEvidenceHash,playerShellSourcePins,playerRunResumeEvidence} from './android-player-acceptance-checks.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url)),execute=promisify(execFile);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(predicate,label,timeout=45000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(100);}throw Error(label+'_TIMEOUT');};
export const playerAdbArgs=(options,args,{device=true}={})=>['-H','127.0.0.1','-P',String(options.adbPort),...(device?['-s',options.serial]:[]),...args];

/** The build stamp uses repository keys; this collector's ROOT is platform/. */
export async function verifyPlayerAcceptanceRuntime(root,inputs){
 const pins={};
 for(const name of ['arena/main.jsx','arena/run/practice-controller.mjs','arena/run/engine.mjs','shared/run-practice-profiles.mjs','server/player-routes.mjs','src/pages/Player.jsx','src/pages/PlayerClient.mjs','server/pvp/index.mjs','server/pvp/run-practice-inputs.mjs','server/pvp/run-practice-protocol.mjs','server/pvp/engine-worker.mjs']){
  const expected=inputs?.['platform/'+name];
  assert.match(expected??'',/^[a-f0-9]{64}$/,'RELEASE_RUNTIME_SOURCE_PIN_MISSING: '+name);
  assert.equal(playerEvidenceHash(await readFile(join(root,name))),expected,'RELEASE_RUNTIME_SOURCE_CHANGED: '+name);
  pins[name]=expected;
 }
 return pins;
}

/** Trusted native taps and CDP touch drags, retaining the exact underlying frame
 * identity expected by the existing one-action response verifier. No JS events.
 */
export function playerTouchFrame(frame,{tap,touch}){
 const realPage=frame.page(),handlers=new Map();let wrapped,x=0,y=0,down=false;
 const mouse={
  async move(nextX,nextY,{steps=1}={}){const fromX=x,fromY=y;for(let i=1;i<=steps;i++){x=fromX+(nextX-fromX)*i/steps;y=fromY+(nextY-fromY)*i/steps;if(down)await touch('touchMove',x,y);}},
  async down(){assert.equal(down,false,'TOUCH_ALREADY_DOWN');down=true;await touch('touchStart',x,y);},
  async up(){if(down){down=false;await touch('touchEnd',x,y);}},
 };
 const response=r=>new Proxy(r,{get(target,key){if(key==='request')return()=>new Proxy(target.request(),{get(request,k){if(k==='frame')return()=>request.frame()===frame?wrapped:request.frame();const value=request[k];return typeof value==='function'?value.bind(request):value;}});const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 const page=new Proxy(realPage,{get(target,key){if(key==='mouse')return mouse;if(key==='on')return(event,handler)=>{const bound=event==='response'?r=>handler(response(r)):handler;handlers.set(handler,bound);target.on(event,bound);return page;};if(key==='off')return(event,handler)=>{target.off(event,handlers.get(handler)||handler);handlers.delete(handler);return page;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 const locator=target=>new Proxy(target,{get(value,key){if(key==='tap')return options=>tap(value,options);const member=value[key];return typeof member==='function'?member.bind(value):member;}});
 wrapped=new Proxy(frame,{get(target,key){if(key==='page')return()=>page;if(key==='locator')return(...args)=>locator(target.locator(...args));const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 return{frame:wrapped,release:()=>mouse.up()};
}

/** Retains raw protocol and complete observed bodies, with original byte hashes
 * separate from redacted stored JSON. Never treats missing/failed bodies as pass.
 */
export async function collectPlayerEvidence({context,page,origin,manifest,out,redactor,result}){
 const cdp=await context.newCDPSession(page),tasks=new Set(),raw=[],responses=[],errors=[],requests=[],requestRows=new WeakMap();let sequence=0,totalBytes=0,closed=false;
 const rememberPost=value=>{if(value){try{redactor.remember(JSON.parse(value));}catch{redactor.add(value);}}};
 for(const event of ['Network.requestWillBeSent','Network.responseReceived','Network.loadingFinished','Network.loadingFailed','Page.frameNavigated','Runtime.exceptionThrown','Security.visibleSecurityStateChanged'])cdp.on(event,value=>{
  redactor.remember(value);if(event==='Network.requestWillBeSent')rememberPost(value.request?.postData);raw.push({event,value});
 });
 await cdp.send('Network.enable');await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Security.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
 const onRequest=request=>{try{const u=new URL(request.url());if(!['http:','https:'].includes(u.protocol))return;const row={id:++sequence,at:Date.now(),url:request.url(),method:request.method(),frame:request.frame()?.url(),headers:request.headers(),postData:request.postData(),resourceType:request.resourceType()};redactor.remember(row.headers);rememberPost(row.postData);requests.push(row);requestRows.set(request,row);if(u.origin!==origin&&!['https://fonts.googleapis.com','https://fonts.gstatic.com'].includes(u.origin))errors.push('UNEXPECTED_NETWORK_ORIGIN: '+u.origin);}catch(error){errors.push('REQUEST_OBSERVATION_FAILED: '+error.message);}};
 const onResponse=response=>{
  const work=(async()=>{
   const request=response.request(),u=new URL(response.url()),status=response.status(),headers=await response.allHeaders();redactor.remember(headers);
   const row={id:responses.length+1,at:Date.now(),request_at:requestRows.get(request)?.at??null,request_id:requestRows.get(request)?.id??null,request_headers:requestRows.get(request)?.headers??null,url:response.url(),path:u.pathname,method:request.method(),status,frame:request.frame()?.url(),resourceType:request.resourceType(),headers};responses.push(row);
   if(!response.ok())row.body_error='NON_SUCCESS_STATUS';
   const bytes=await response.body();row.original_sha256=playerEvidenceHash(bytes);row.original_bytes=bytes.length;totalBytes+=bytes.length;assert.ok(totalBytes<=256*1024*1024,'EVIDENCE_BODY_BOUND_EXCEEDED');
   const api=u.origin===origin&&(/^\/(api|v1)\//.test(u.pathname)||['/health','/health/ready'].includes(u.pathname));
   if(api){try{const value=JSON.parse(bytes);redactor.remember(value);row.body=value;row.body_format='redacted-json';}catch{row.body=bytes.toString('utf8');row.body_format='redacted-text';errors.push('API_RESPONSE_JSON_INVALID: '+u.pathname);}return;}
   if(!response.ok()){row.body=bytes.toString('utf8');row.body_format='redacted-text';return;}
   if(['document','script','stylesheet','image','font','media','fetch','xhr'].includes(request.resourceType())){
    row.pin=u.origin===origin?assertPlayerResourceBody(response.url(),bytes,{origin,manifest}):{sha256:row.original_sha256,bytes:bytes.length,source:'Observed external HTTPS public asset; not a release output pin',origin:u.origin};const file='body-'+row.original_sha256;
    await writeFile(join(out,'bodies',file),bytes,{mode:0o600,flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});row.stored_body='bodies/'+file;
   }
  })().catch(error=>errors.push(error.message));tasks.add(work);void work.finally(()=>tasks.delete(work));
 };
 page.on('request',onRequest);page.on('response',onResponse);await mkdir(join(out,'bodies'),{recursive:true,mode:0o700});
 return{cdp,raw,responses,requests,errors,
  async drain(){const deadline=Date.now()+20000;while(tasks.size){assert.ok(Date.now()<deadline,'RAW_RESPONSE_DRAIN_TIMEOUT');await Promise.all([...tasks]);}result.raw_response_work_pending=tasks.size;},
  async save(){await this.drain();await writeFile(join(out,'raw-cdp.json'),JSON.stringify(redactor.sanitize(raw),null,2),{mode:0o600});await writeFile(join(out,'network-bodies.json'),JSON.stringify(redactor.sanitize({requests,responses,errors,totalBytes}),null,2),{mode:0o600});},
  async close({transportClosed=false}={}){if(!closed){closed=true;page.off('request',onRequest);page.off('response',onResponse);try{await cdp.detach();}catch(error){if(!transportClosed||!/Target.*closed|Session closed/i.test(error.message))throw error;}}},
 };
}

/** Response listeners stay installed through close. The second native drain
 * includes delayed body failures; it can revoke an earlier provisional pass. */
export async function closePlayerObservation({browser,evidence,holder,errors,clean=String}){
 const step=async(stage,run)=>{try{await run();return true;}catch(error){errors.push(stage+': '+clean(error.message));holder?.result.observer_errors.push({stage,message:clean(error.message)});return false;}};
 await step('pre-close-raw-drain',async()=>evidence?.drain());
 await step('pre-close-native-drain',async()=>holder?.drain({final:false}));
 const transportClosed=await step('owned-browser-close',async()=>browser?.close());
 await step('post-close-native-final-drain',async()=>holder?.drain({final:true}));
 await step('post-close-evidence-save',async()=>evidence?.save());
 await step('owned-observer-close',async()=>evidence?.close({transportClosed}));
 errors.push(...(evidence?.errors||[]));
 if(holder){holder.result.post_close_drained=true;holder.result.passed=holder.result.passed===true&&nativeErrorsEmpty(holder.result)&&holder.result.cleanup?.passed===true&&(evidence?.errors.length||0)===0;}
}

export async function runPlayerAcceptance(options){
 assert.ok(!process.env.NODE_TLS_REJECT_UNAUTHORIZED||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='1','STRICT_TLS_REQUIRED');
 const redactor=createPlayerEvidenceRedactor(),artifact=await readPlayerArtifact(options.metadata,{shellRoot:join(ROOT,'android-player'),execute,apksigner:options.apksigner});
 const manifestPath=resolve(options.platformManifest),manifestInfo=await lstat(manifestPath);assert.ok(manifestInfo.isFile()&&!manifestInfo.isSymbolicLink(),'RELEASE_MANIFEST_FILE_REQUIRED');
 const manifestBytes=await readFile(manifestPath),manifest=playerResourceManifest(JSON.parse(manifestBytes)),manifestSha=playerEvidenceHash(manifestBytes);
 const runtimePins=await verifyPlayerAcceptanceRuntime(ROOT,manifest.inputs);
 const out=resolve(options.output);await mkdir(out,{mode:0o700});await mkdir(join(out,'bodies'),{mode:0o700});
 const report={schema:'android-real-player-acceptance-v1',mode:options.mode,started_at:new Date().toISOString(),passed:false,executed:false,physical_device:false,
  scope:'Signed real Player QA shell; production cookie identity and zero wallet; one trusted Android/UI action per admitted arena and original-session return/cleanup. Not complete game, frame-rate, iPhone or third-party transfer acceptance.',
  artifact:{metadataSha256:artifact.metadataSha256,apkSha256:artifact.apkSha256,certificateSha256:artifact.certificateSha256,origin:artifact.origin,appId:artifact.appId,packageName:artifact.packageName,sourceEvidence:artifact.sourceEvidence},release:{manifestSha256:manifestSha,runtimePins},games:[],resources:{events:[],errors:[]},lifecycle:{included:options.mode==='lifecycle',separate_report:options.mode==='lifecycle',basic_smoke_is_not_recovery_acceptance:true}};
 const save=async()=>writeFile(join(out,'report.json'),JSON.stringify(redactor.sanitize(report),null,2)+'\n',{mode:0o600});await save();
 if(!options.run){report.preflight_passed=true;report.scope='Local artifact/source/signature preflight only. No ADB, login, network, device or acceptance run.';await save();return report;}
 const credentials=await readPlayerCredentials(options.credentialsFile,redactor),origin=artifact.origin,pkg=artifact.packageName,component=pkg+'/com.tianyahuyu.oasis.player.MainActivity';
 const adb=async(...args)=>(await execute('adb',playerAdbArgs(options,args),{timeout:45000,maxBuffer:4*1024*1024})).stdout.trim();
 const forwards=async()=>parseAndroidForwards(await adb('forward','--list'));
 let browser,context,page,probe,evidence,forward,beforeForwards,foreground,apiContext,baseline,active,connectionHolder,started=false,connection=0;
 const topRead=async path=>{assert.ok(/^\/api\/player\/(app|session|wallet|recovery)(?:\?app_id=[A-Za-z0-9_-]+)?$/.test(path),'PLAYER_READ_ONLY_PATH_REQUIRED');return page.evaluate(async path=>{const response=await fetch(path,{credentials:'same-origin',cache:'no-store'});return{status:response.status,body:await response.json()};},path);};
 const requiredRead=async path=>{const r=await topRead(path);assert.equal(r.status,200,'PLAYER_READ_FAILED: '+path);redactor.remember(r.body);return r.body;};
 const installed=async()=>{
  const paths=(await adb('shell','pm','path',pkg)).split(/\r?\n/);assert.equal(paths.length,1,'PLAYER_SPLIT_APK_REFUSED');assert.match(paths[0],/^package:\/data\/app\/[A-Za-z0-9_./=+~-]+\/base\.apk$/);
  const apkSha256=(await adb('shell','sha256sum',paths[0].slice(8))).split(/\s+/)[0],info=await adb('shell','dumpsys','package',pkg);
  return assertInstalledPlayerArtifact({apkSha256,version:info.match(/\bversionName=([^\s]+)/)?.[1],versionCode:Number(info.match(/\bversionCode=(\d+)/)?.[1]),debuggable:/\bDEBUGGABLE\b/.test(info)},artifact);
 };
 const tap=async(locator,{position}={})=>{
  await locator.scrollIntoViewIfNeeded();const b=await locator.boundingBox();assert.ok(b&&b.width>0&&b.height>0,'VISIBLE_NATIVE_TAP_BOUNDS_REQUIRED');
  const targets=await fetch('http://127.0.0.1:'+forward.port+'/json/list',{signal:AbortSignal.timeout(5000)}).then(r=>r.json()),target=targets.find(t=>t.url===artifact.entryUrl);assert.ok(target,'EXACT_PLAYER_WEBVIEW_TARGET_REQUIRED');
  const box=JSON.parse(target.description),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));assert.ok(Math.abs(box.width/viewport.width-viewport.dpr)<.1,'PLAYER_WEBVIEW_SCALE_UNPROVEN');
  const x=Math.round(box.screenX+(b.x+(position?.x??b.width/2))*viewport.dpr),y=Math.round(box.screenY+(b.y+(position?.y??b.height/2))*viewport.dpr);
  assert.ok(x>=box.screenX&&x<box.screenX+box.width&&y>=box.screenY&&y<box.screenY+box.height,'PLAYER_NATIVE_TAP_OUTSIDE_WEBVIEW');await adb('shell','input','tap',String(x),String(y));
 };
 const screenshot=async name=>{
  const masks=page.frames().flatMap(frame=>[frame.locator('.player-welcome, input[name="username"], input[type="password"], .room-code'),frame.getByText(credentials.username,{exact:false}),...(baseline?[frame.getByText(baseline.playerId,{exact:false}),frame.getByText(baseline.externalUserId,{exact:false})]:[])]);
  await page.screenshot({path:join(out,name+'.png'),mask:masks});
 };
 const stopUI=async result=>{if(page&&!page.isClosed()&&await page.locator('.player-lobby').isVisible()&&await page.locator('iframe').count()===0){result.ui_stopped=true;result.ui_stop_method='authoritative-sdk-return-unmounted-iframe';return true;}
  await adb('shell','am','force-stop',pkg);await until(async()=>!(await adb('shell','pidof',pkg).catch(error=>{if(error.code===1)return '';throw error;})),'OWNED_PLAYER_APK_STOP',10000);result.ui_stopped=true;result.ui_stop_method='force-stop-owned-qa-apk';return true;};
 const cleanup=async holder=>{
  if(!holder?.state)return;const{state,result}=holder;
  try{if(!result.ui_stopped)await stopUI(result);await holder.drain({final:false});
   if(state.androidBaseline){assertOwnedPlayerArenaState(state,baseline);state.phase='cleanup';result.cleanup=await cleanupOwnedAndroidSession({state,arenaGames:ARENA_IDS,api:createNativeCleanupApi({page:{request:apiContext},origin,state,result,clean:redactor.clean}),until,newId:()=> 'player_cleanup_'+randomUUID().replaceAll('-',''),uiStopped:true,clean:redactor.clean});}
   else{assert.equal(state.creations.length+state.actionRequests.length+state.inputsRequests.length,0,'MUTATION_WITHOUT_CLEAN_BASELINE');result.cleanup={passed:true,attempted:false,scope:'No gameplay mutation; inherited obligations untouched'};}
  }catch(error){result.cleanup={passed:false,error:redactor.clean(error.message)};}
  try{await holder.drain({final:true});}catch(error){result.observer_errors.push({stage:'final-drain',message:redactor.clean(error.message)});}
 };
 const closeConnection=async()=>{
  await closePlayerObservation({browser,evidence,holder:connectionHolder,errors:report.resources.errors,clean:redactor.clean});evidence=null;browser=null;context=null;page=null;probe=null;connectionHolder=null;
  if(forward){assert.deepEqual((await forwards()).filter(r=>r.local===forward.local),[{serial:forward.serial,local:forward.local,remote:forward.remote}],'OWNED_FORWARD_REPLACED_NO_REMOVE');await adb('forward','--remove',forward.local);report.resources.events.push({event:'forward-removed',local:forward.local});forward=null;}
 };
 const connect=async()=>{
  await adb('shell','am','force-stop',pkg);await adb('shell','am','start','-n',component);
  await until(async()=>/^\d+$/.test(await adb('shell','pidof',pkg)),'EXACT_PLAYER_PID');const pid=await adb('shell','pidof',pkg),remote='localabstract:webview_devtools_remote_'+pid;
  await until(async()=>(await adb('shell','cat','/proc/net/unix')).includes('@webview_devtools_remote_'+pid),'PLAYER_DEBUG_SOCKET');const localBefore=await forwards(),port=await adb('forward','tcp:0',remote);
  forward={serial:options.serial,local:'tcp:'+port,port,remote};ownedAndroidForward(localBefore,await forwards(),forward);report.resources.events.push({event:'forward-created',...forward});
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{isWebView:true,noDefaults:true,timeout:15000});assert.equal(browser.contexts().length,1,'EXACT_PLAYER_CONTEXT_REQUIRED');context=browser.contexts()[0];
  await until(()=>context.pages().length===1,'EXACT_PLAYER_PAGE');page=context.pages()[0];await until(()=>page.url()===artifact.entryUrl,'EXACT_PLAYER_ENTRY');page.setDefaultTimeout(45000);
  probe=await installNativeFetchProbe(context,{clean:redactor.clean});await probe.attach(page);const dir='connection-'+(++connection);await mkdir(join(out,dir),{mode:0o700});evidence=await collectPlayerEvidence({context,page,origin,manifest,out:join(out,dir),redactor,result:report});
  report.resources.events.push({event:'fresh-measured-webview',connection,evidence:dir,initial_unobserved_document_excluded:true});
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('.player-lobby').waitFor();
 };
 try{
  const devices=(await execute('adb',playerAdbArgs(options,['devices','-l'],{device:false}),{timeout:10000})).stdout;
  assert.ok(devices.split('\n').some(line=>line.split(/\s+/)[0]===options.serial&&line.split(/\s+/)[1]==='device'&&line.includes('usb:')),'EXACT_PHYSICAL_ANDROID_REQUIRED');report.physical_device=true;
  report.installed_before=await installed();beforeForwards=await forwards();foreground=androidForeground(await adb('shell','dumpsys','activity','activities'));report.resources.beforeForwards=beforeForwards;report.resources.originalForeground=foreground;
  started=true;report.executed=true;await connect();
  apiContext=await httpRequest.newContext({ignoreHTTPSErrors:false,timeout:12000});
  const metadata=await requiredRead('/api/player/app?app_id='+artifact.appId),initial=await topRead('/api/player/session');
  report.login_baseline={status:initial.status};
  if(initial.status===200){assert.equal(initial.body.player?.username,credentials.username,'INHERITED_LOGIN_PRESERVED');}
  else{
   assert.equal(initial.status,401,'PLAYER_LOGIN_BASELINE_UNPROVEN');assert.equal(initial.body.error?.code,'LOGIN_REQUIRED','UNEXPECTED_AUTH_FAILURE');
   await page.locator('input[name="username"]').fill(credentials.username);await page.locator('input[name="password"]').fill(credentials.password);
   const login=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/player/login'&&r.request().method()==='POST');await tap(page.getByRole('button',{name:'登录',exact:true}));const response=await login;assert.equal(response.status(),200,'PLAYER_REAL_LOGIN_FAILED');redactor.remember(await response.json());
  }
  await page.locator('.player-games').waitFor();const session=await requiredRead('/api/player/session'),wallet=await requiredRead('/api/player/wallet?app_id='+artifact.appId),recovery=await requiredRead('/api/player/recovery?app_id='+artifact.appId);
  baseline=assertPlayerLobbyBaseline({metadata,session,wallet,recovery,appId:artifact.appId,username:credentials.username});redactor.add(baseline.playerId);redactor.add(baseline.externalUserId);report.baseline=baseline;report.catalog=metadata.game_ids;
  await page.getByRole('region',{name:'账户余额'}).getByText('可用',{exact:false}).waitFor();assert.ok((await page.getByRole('region',{name:'账户余额'}).textContent()).includes(formatPlayerMinor('0',baseline.currencyScale)+' '+baseline.currencyId),'REAL_ZERO_BALANCE_UI_REQUIRED');await screenshot('player-lobby-zero-wallet');
  const games=options.games||ARENA_IDS;report.full_catalog=games.length===ARENA_IDS.length;
  if(options.mode==='lifecycle'){
   report.lifecycle={included:true,separate_report:true,negative_network_errors_remain_strict_failures:true,scenarios:[]};
   const before=evidence.responses.length,failed=[];const walletPath=origin+'/api/player/wallet?app_id='+artifact.appId;
   await page.route(walletPath,async route=>{failed.push({url:route.request().url(),method:route.request().method()});assert.equal(route.request().method(),'GET');await route.abort('internetdisconnected');});
   await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('region',{name:'账户余额'}).getByRole('alert').waitFor();assert.ok(failed.length>0,'OFFLINE_WALLET_UI_DID_NOT_FAIL');
   await page.unroute(walletPath);const response=page.waitForResponse(r=>r.url()===walletPath&&r.request().method()==='GET'&&r.status()===200);await tap(page.getByRole('button',{name:'重新读取余额',exact:true}));const recoveredWallet=await(await response).json();redactor.remember(recoveredWallet);assertPlayerZeroWallet(recoveredWallet,artifact.appId,baseline);
   assert.ok((await page.getByRole('region',{name:'账户余额'}).textContent()).includes(formatPlayerMinor('0',baseline.currencyScale)+' '+baseline.currencyId));
   report.lifecycle.scenarios.push({name:'wallet-offline-fault-and-real-ui-retry',fault_injection:'Playwright abort of exact authenticated wallet GET in actual WebView, not physical Wi-Fi disable',failed_reads:failed,wallet_after:recoveredWallet,network_response_boundary:before,passed:true,ui_retry_verified:true});
   await closeConnection();await connect();
  }
  for(const game of games){
   if(report.games.length){await closeConnection();await connect();}
   const result={game,passed:false,observer_errors:[]},state={game,token:null,sessionId:null,playerId:null,appId:null,room:null,ownedRooms:new Set(),practiceRequested:false,spins:[],acks:new Set(),returning:false,phase:'entry'};report.games.push(result);
   const drain=observeNativeBrowser(page,{origin,state,result,clean:redactor.clean,fetchProbe:probe,remember:body=>{redactor.remember(body);if(body.access_token){assert.equal(body.scope?.app_id,baseline.appId,'PLAYER_EXCHANGE_APP_MISMATCH');assert.equal(body.external_user_id,baseline.externalUserId,'PLAYER_EXCHANGE_IDENTITY_MISMATCH');state.appId=body.scope.app_id;}}});
   active={state,result,drain};connectionHolder=active;let touch;
   try{
    // Each earlier UI/authority return completed before this new launch.
    assert.deepEqual((await requiredRead('/api/player/recovery?app_id='+artifact.appId)).sessions,[],'INHERITED_OBLIGATIONS_PRESERVED');
    await tap(page.locator('.player-game-card').filter({has:page.getByText(ARENA_GAMES[game].name,{exact:true})}));
    await until(()=>Boolean(state.token&&state.sessionId),'OBSERVED_PLAYER_LAUNCH_EXCHANGE');await until(()=>page.frames().some(f=>f.url()===origin+'/play/'+game),'EXACT_PLAYER_GAME_IFRAME');
    const frame=page.frames().find(f=>f.url()===origin+'/play/'+game);assert.equal(await page.locator('iframe').count(),1);result.probe_installation=await probe.requireInstalled(frame);
    const read=createNativeCleanupApi({page:{request:apiContext},origin,state,result,clean:redactor.clean}),arenaSession=await read('/api/arena/session');result.baseline=assertAndroidSessionBaseline(state,arenaSession,ARENA_IDS);assertOwnedPlayerArenaState(state,baseline);
    state.phase='playing';state.practiceRequested=true;await tap(frame.getByRole('button',{name:'免费练习',exact:false}));await tap(frame.getByRole('button',{name:'确认规则 · 准备开局',exact:true}));
    await until(()=>state.room?.status==='active','THIS_RUN_BOT_PRACTICE_ACTIVE');assertOwnedPlayerArenaState(state,baseline);await frame.locator('.arena-loading').waitFor({state:'hidden'});
    if(options.mode==='lifecycle'&&game==='run'){
     const originalRoom=state.room.id,serverNow=state.room.server_now,at=Date.now();await adb('shell','input','keyevent','3');await sleep(2000);const resumedAt=Date.now();await adb('shell','am','start','-n',component);await until(()=>page.url()===artifact.entryUrl,'PLAYER_FOREGROUND_RESUME');
     const resumeScope={origin,after:resumedAt,token:state.token,sessionId:state.sessionId,roomId:originalRoom,serverNow,playerId:state.playerId,appId:state.appId};
     await until(()=>Boolean(playerRunResumeEvidence(evidence.responses,resumeScope)),'FRESH_ORIGINAL_RUN_ROOM_RESUME');assertOwnedPlayerArenaState(state,baseline);
     const resumedSession=await read('/api/arena/session');assert.equal(resumedSession.session_id,state.androidBaseline.sessionId);assert.equal(resumedSession.external_user_id,state.androidBaseline.playerId);assert.equal(resumedSession.scope?.app_id,state.androidBaseline.appId);assert.equal(resumedSession.active_room_id,originalRoom);assert.equal(resumedSession.other_active_game,null);
     await frame.locator('[data-testid="run-scene"][data-input-ready="true"]').waitFor();report.lifecycle.scenarios.push({name:'physical-home-and-original-run-room-resume',roomId:originalRoom,awayMs:resumedAt-at,fresh_read:playerRunResumeEvidence(evidence.responses,resumeScope),original_session_readback:resumedSession,passed:true});
    }
    touch=playerTouchFrame(frame,{tap,touch:async(type,x,y)=>evidence.cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y,id:1}],modifiers:0})});
    result.action=await runNativeActionOnce(()=>playOneArenaAction(touch.frame,game,()=>state.room,{touch:true,beforeAction:()=>assertOwnedPlayerArenaState(state,baseline)}),result,redactor.clean);
    await drain({final:false});assertAndroidOneAction(state,result.action);result.input_scope='ADB system taps; CDP trusted touch drags in the actual physical WebView. Not a physical finger or full swipe-quality/FPS claim.';await screenshot(game+'-accepted-action');
    state.returning=true;state.phase='returning';const returnedAt=Date.now();await adb('shell','input','keyevent','4');await sleep(200);
    const leave=frame.getByRole('button',{name:'确认离开',exact:true});if(!frame.isDetached()&&await leave.isVisible())await tap(leave);
    const confirm=frame.locator('[data-return="confirm"]');if(!frame.isDetached()&&await confirm.isVisible())await tap(confirm);
    await page.locator('.player-games').waitFor();assert.equal(await page.locator('iframe').count(),0,'SDK_RETURN_DID_NOT_UNMOUNT_GAME');result.native_back_returned=true;result.ui_stopped=true;
    await until(()=>evidence.responses.some(r=>r.path==='/api/player/wallet'&&r.status===200&&r.body?.app_id===artifact.appId&&r.request_at>=returnedAt),'REAL_UI_RETURN_WALLET_REFRESH');await evidence.drain();const refresh=evidence.responses.filter(r=>r.path==='/api/player/wallet'&&r.status===200&&r.body?.app_id===artifact.appId&&r.request_at>=returnedAt).at(-1);
    assert.ok(refresh&&refresh.body,'UI_WALLET_REFRESH_BODY_MISSING');result.wallet_refresh={status:refresh.status,after_return:true,original_sha256:refresh.original_sha256,body:refresh.body,return_requested_at:returnedAt};
    await cleanup(active);const returnedSession=await requiredRead('/api/player/session'),returnedRecovery=await requiredRead('/api/player/recovery?app_id='+artifact.appId),returnedWallet=await requiredRead('/api/player/wallet?app_id='+artifact.appId);
    assertPlayerReturnReadback({state,result,session:returnedSession,recovery:returnedRecovery,wallet:returnedWallet,baseline});assertAndroidOneAction(state,result.action);result.passed=nativeErrorsEmpty(result)&&evidence.errors.length===0;assert.equal(result.passed,true,'PLAYER_STRICT_OBSERVATION_FAILED');await screenshot(game+'-returned-zero-wallet');
   }catch(error){result.error=redactor.clean(error.message);result.failure_action={status:error.status??null,code:error.code??null,request_body:error.requestBody??null,response_body:error.responseBody??null};await screenshot(game+'-failure').catch(e=>{result.screenshot_error=redactor.clean(e.message);});throw error;}
   finally{await touch?.release().catch(e=>{result.observer_errors.push({stage:'touch-release',message:redactor.clean(e.message)});});if(!result.cleanup)await cleanup(active);result.passed=result.passed&&nativeErrorsEmpty(result)&&result.cleanup?.passed===true;await save();}
   active=null;
  }
  report.installed_after=await installed();assert.deepEqual(report.installed_after,report.installed_before,'PLAYER_APK_CHANGED_DURING_ACCEPTANCE');assert.deepEqual(await playerShellSourcePins(join(ROOT,'android-player')),artifact.sourceEvidence.files,'PLAYER_SOURCE_CHANGED_DURING_ACCEPTANCE');assert.equal(playerEvidenceHash(await readFile(manifestPath)),manifestSha,'RELEASE_MANIFEST_CHANGED_DURING_ACCEPTANCE');
  for(const[name,digest]of Object.entries(runtimePins))assert.equal(playerEvidenceHash(await readFile(join(ROOT,name))),digest,'RUNTIME_SOURCE_CHANGED_DURING_ACCEPTANCE: '+name);
  report.basic_passed=report.full_catalog&&report.games.every(g=>g.passed&&g.cleanup?.passed);report.passed=options.mode==='basic'&&report.basic_passed;
 }catch(error){report.failure=redactor.clean(error.stack);}
 finally{
  if(active&&!active.result.cleanup)await cleanup(active);
  try{await context?.setOffline(false);}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  try{await closeConnection();}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  try{await apiContext?.dispose();}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  if(forward){try{assert.deepEqual((await forwards()).filter(r=>r.local===forward.local),[{serial:forward.serial,local:forward.local,remote:forward.remote}],'OWNED_FORWARD_REPLACED_NO_REMOVE');await adb('forward','--remove',forward.local);}catch(error){report.resources.errors.push(redactor.clean(error.message));}}
  if(started){try{await adb('shell','am','force-stop',pkg);if(foreground)await adb('shell','am','start','-n',foreground);report.resources.restoredForeground=androidForeground(await adb('shell','dumpsys','activity','activities'));assert.equal(report.resources.restoredForeground,foreground,'ORIGINAL_FOREGROUND_NOT_RESTORED');}catch(error){report.resources.errors.push(redactor.clean(error.message));}}
  if(beforeForwards){try{report.resources.afterForwards=await forwards();assertAndroidForwardsRestored(beforeForwards,report.resources.afterForwards);}catch(error){report.resources.errors.push(redactor.clean(error.message));}}
  report.resources.passed=report.resources.errors.length===0;report.basic_passed=report.full_catalog&&report.games.length===ARENA_IDS.length&&report.games.every(g=>g.passed&&g.post_close_drained&&g.cleanup?.passed);report.passed=options.mode==='basic'&&report.basic_passed&&!report.failure&&report.resources.passed;report.finished_at=new Date().toISOString();await save();
 }
 return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const report=await runPlayerAcceptance(playerAcceptanceArguments(process.argv.slice(2)));console.log(JSON.stringify({passed:report.passed,preflight_passed:report.preflight_passed??false,executed:report.executed,mode:report.mode}));if(report.executed&&!report.passed)process.exitCode=1;}
 catch{console.error('PLAYER_ACCEPTANCE_PRECONDITION_FAILED');process.exitCode=1;}
}
