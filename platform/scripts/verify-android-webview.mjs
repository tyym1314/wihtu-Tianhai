/** Strict APK smoke: existing sandbox/test wallets, but never inherited business.
 * Defaults to all 13 games. Legacy recovery/offline tests are deliberately not run.
 * Safe Match bootstrap is instrumentation-only; every measured game is reloaded
 * after the observer is installed. No input is sent before the exact guest inventory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {chromium,request as httpRequest} from 'playwright';
import {RELEASED_IDS,ARENA_IDS} from '../shared/games.mjs';
import {playOneArenaAction} from './android-game-actions.mjs';
import {readAndroidArtifact,androidVerificationTarget,androidAdbArgs,androidReleaseCommand,verifyAndroidReleaseState,verifyInstalledAndroidArtifact} from './android-artifact.mjs';
import {installNativeFetchProbe,observeNativeBrowser,runNativeActionOnce,nativeErrorsEmpty,createNativeCleanupApi} from '../deploy/native-browser-checks.mjs';
import {createAndroidMeasurementBoundary,parseAndroidForwards,ownedAndroidForward,assertAndroidForwardsRestored,androidForeground,assertAndroidSessionBaseline,assertAndroidOneAction,assertAndroidPaidCycle,cleanupOwnedAndroidSession,androidStrictPassed} from './android-webview-checks.mjs';
import {androidInventoryProgram,verifyAndroidInventory} from './android-guest-inventory.mjs';
assert.ok(process.env.OASIS_ANDROID_ARTIFACT,'OASIS_ANDROID_ARTIFACT_REQUIRED');
const artifact=await readAndroidArtifact(process.env.OASIS_ANDROID_ARTIFACT),target=androidVerificationTarget(process.env,artifact);
assert.equal(target.variant,'isolated-mock','STRICT_APK_MODE_REQUIRES_ISOLATED_MOCK');
assert.ok(!process.env.OASIS_ANDROID_LIFECYCLE||process.env.OASIS_ANDROID_LIFECYCLE==='0','LEGACY_LIFECYCLE_IS_NOT_STRICT_APK_ACCEPTANCE');
assert.ok(!process.env.NODE_TLS_REJECT_UNAUTHORIZED||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='1','STRICT_TLS_REQUIRED');
const expectedManifest=process.env.OASIS_ANDROID_RELEASE_MANIFEST_SHA256,expectedApp=process.env.OASIS_ANDROID_APP_ID;
assert.match(expectedManifest||'',/^[a-f0-9]{64}$/,'ANDROID_RELEASE_MANIFEST_REQUIRED');assert.match(expectedApp||'',/^[A-Za-z0-9_-]{1,128}$/,'ANDROID_MOCK_APP_ID_REQUIRED');
const run=promisify(execFile),serial=target.serial,origin=target.origin,pkg=target.packageName,remoteDevice=process.env.OASIS_ANDROID_ALLOW_REMOTE==='1';
const catalog=RELEASED_IDS;
const selected=process.env.OASIS_ANDROID_GAMES?process.env.OASIS_ANDROID_GAMES.split(','):catalog;
assert.ok(selected.length&&selected.every(g=>catalog.includes(g))&&new Set(selected).size===selected.length);
const nonce=randomUUID().replaceAll('-',''),xmlPath=`/data/local/tmp/oasis-strict-${nonce}.xml`;
const outputRoot=new URL('../review/android/',import.meta.url);await fs.mkdir(outputRoot,{recursive:true});
const outputPath=await fs.mkdtemp(resolve(outputRoot.pathname,`${artifact.variant}-${target.release}-strict-`));await fs.chmod(outputPath,0o700);const out=pathToFileURL(outputPath+'/');
const hash=value=>createHash('sha256').update(value).digest('hex'),secrets=new Set();
const clean=value=>{let text=String(value);for(const secret of [...secrets].sort((a,b)=>b.length-a.length))text=text.split(secret).join('[redacted:'+hash(secret).slice(0,12)+']');return text;};
const remember=body=>{if(!body||typeof body!=='object')return;for(const [key,value] of Object.entries(body)){if(typeof value==='string'&&/(token|secret|cookie|csrf|launch_code|session_id|external_user_id)/i.test(key))secrets.add(value);}};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const bounded=async(operation,label,ms=10000)=>{let timer;try{return await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+'_TIMEOUT')),ms);})]);}finally{clearTimeout(timer);}};
const adb=async(...args)=>(await run('adb',androidAdbArgs(target,args),{timeout:45000,maxBuffer:4*1024*1024})).stdout.trim();
const forwards=async()=>parseAndroidForwards(await adb('forward','--list'));
const until=async(fn,label,timeout=45000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(120);}throw Error('Timeout: '+label);};
const {apkPath,...artifactEvidence}=artifact;
const report={schema:'android-webview-strict-v1',started_at:new Date().toISOString(),origin,artifact:artifactEvidence,requested_games:selected,full_catalog:selected.length===catalog.length,physical_device:!remoteDevice,scope:remoteDevice?'Remote Android APK, not physical USB evidence. Strict observed UI/ACK and original-session cleanup.':'Physical USB APK UI/ACK and original-session cleanup; not full-game quality or GPU acceptance.',instrumentation:'Initial unobserved native launch is excluded. Read-only exact guest inventory precedes each action; measured document is reloaded after observer/probe installation.',lifecycle:{included:false,reason:'Recovery, outage and negative-request tests require a separate report; never exempted here.'},games:[],resources:{events:[],errors:[],passed:false},passed:false};
let browser,context,page,ownedForward,originalForeground,beforeForwards,guest,previousInventory,apiContext,apkStarted=false;
const save=()=>fs.writeFile(new URL('device-smoke.json',out),JSON.stringify(report,(_key,value)=>typeof value==='string'?clean(value):value,2)+'\n',{mode:0o600});
await fs.writeFile(new URL('device-smoke.json',out),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
const sshArgs=()=>['-i',target.sshKey,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',target.sshHost];
async function deployedRelease(){const {stdout}=await run('ssh',[...sshArgs(),androidReleaseCommand(target)],{timeout:60000,maxBuffer:16384});return verifyAndroidReleaseState(JSON.parse(stdout),target);}
async function inventory(state,{previous}={}){
 assert.equal(state.appId,expectedApp,'EXCHANGE_APP_DIFFERS_FROM_CONFIGURED_MOCK');
 if(guest)assert.equal(state.playerId,guest,'PERSISTENT_GUEST_CHANGED');
 const input={variant:target.variant,origin,release:target.release,manifest_sha256:expectedManifest,app_id:state.appId,guest_id:state.playerId,session_id:state.sessionId,game_id:state.game};
 const program=androidInventoryProgram(input);
 const stdout=await new Promise((resolve,reject)=>{
  const child=spawn('ssh',[...sshArgs(),program.command],{stdio:['pipe','pipe','pipe']});let output='',error='',size=0,expired=false;
  const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},20000);
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>65536)child.kill('SIGKILL');else output+=chunk;});
  child.stderr.on('data',chunk=>{if(error.length<4096)error+=chunk;});child.on('error',reject);
  child.on('close',code=>{clearTimeout(timer);if(code===0&&!expired&&size<=65536)resolve(output);else reject(Error('READ_ONLY_GUEST_INVENTORY_FAILED: '+clean(error).slice(0,500)));});
  child.stdin.on('error',reject);child.stdin.end(program.input);
 });
 const raw=JSON.parse(stdout);report.last_inventory_observation=raw; // Retain obligations even when the clean gate rejects them.
 return {...verifyAndroidInventory(raw,input,{reader_sha256:program.reader_sha256,previous}),program_sha256:program.program_sha256};
}
async function connect(state,result){
 await until(async()=>/^\d+$/.test(await adb('shell','pidof',pkg)),'APK process');const pid=await adb('shell','pidof',pkg),remote=`localabstract:webview_devtools_remote_${pid}`;
 await until(async()=>(await adb('shell','cat','/proc/net/unix')).includes('@webview_devtools_remote_'+pid),'WebView debug socket');
 assert.ok(!ownedForward,'PREVIOUS_OWNED_FORWARD_NOT_RELEASED');const before=await forwards(),port=await adb('forward','tcp:0',remote);
 ownedForward={port,serial,local:`tcp:${port}`,remote}; // retained even if binding readback fails
 ownedAndroidForward(before,await forwards(),ownedForward);report.resources.events.push({event:'forward-created',...ownedForward});
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{isWebView:true,noDefaults:true,timeout:15000});context=browser.contexts()[0];
 await until(()=>context.pages().length===1,'exact owned APK WebView');page=context.pages()[0];page.setDefaultTimeout(45000);
 const fetchProbe=await installNativeFetchProbe(context,{clean});await fetchProbe.attach(page);
 const boundary=createAndroidMeasurementBoundary(page,{origin,game:state.game,result});
 await page.waitForFunction(()=>document.querySelector('#native-status')?.hidden===true&&document.querySelector('#native-game')?.getAttribute('aria-busy')==='false',null,{timeout:15000});
 await page.waitForLoadState('networkidle',{timeout:15000});result.initial_navigation_idle=true;
 result.network_origins=[];page.on('request',request=>{try{const url=new URL(request.url());if(!['http:','https:'].includes(url.protocol))return;if(!result.network_origins.includes(url.origin))result.network_origins.push(url.origin);if(![origin,'https://fonts.googleapis.com','https://fonts.gstatic.com'].includes(url.origin)||url.origin!==origin&&url.pathname.startsWith('/api/'))result.observer_errors.push({stage:'origin',message:clean('Unexpected origin '+url.origin)});}catch(error){result.observer_errors.push({stage:'origin',message:clean(error.message)});}});
 const drain=observeNativeBrowser(boundary.observedPage,{origin,state,result,clean,fetchProbe:boundary.probeAdapter(fetchProbe),remember:body=>{remember(body);if(body.game_id===state.game&&body.access_token){assert.equal(body.scope?.app_id,expectedApp);state.appId=body.scope.app_id;if(guest)assert.equal(body.external_user_id,guest);}}});
 return{fetchProbe,drain,boundary};
}
async function releaseForward(){
 if(!ownedForward)return;const owned=ownedForward;
 const list=await forwards();assert.deepEqual(list.filter(row=>row.local===owned.local),[{serial:owned.serial,local:owned.local,remote:owned.remote}],'OWNED_FORWARD_REPLACED_NO_REMOVE');
 await adb('forward','--remove',owned.local);assert.ok(!(await forwards()).some(row=>row.local===owned.local),'OWNED_FORWARD_REMAINS');report.resources.events.push({event:'forward-removed',local:owned.local});ownedForward=null;
}
async function nativeTap(locator){
 await locator.scrollIntoViewIfNeeded();const b=await locator.boundingBox();assert.ok(b);
 const targets=await fetch(`http://127.0.0.1:${ownedForward.port}/json/list`,{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
 const target=targets.find(t=>t.url===page.url());assert.ok(target);const box=JSON.parse(target.description);
 const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));
 assert.ok(Math.abs(box.width/viewport.width-viewport.dpr)<.1,'Unexpected WebView scale');
 const x=Math.round(box.screenX+(b.x+b.width/2)*viewport.dpr),y=Math.round(box.screenY+(b.y+b.height/2)*viewport.dpr);
 assert.ok(x>=box.screenX&&x<box.screenX+box.width&&y>=box.screenY&&y<box.screenY+box.height,'Tap outside WebView');
 await adb('shell','input','tap',String(x),String(y));
}
async function nativeXml(){
 // Android 16 occasionally kills the uiautomator shell after it has already
 // written a usable dump (exit 137). Treat that as a transient read and
 // retry instead of aborting the WebView test before the native lobby can be
 // observed.
 for(let attempt=0;attempt<5;attempt++){
  try{
   await adb('shell','uiautomator','dump',xmlPath);
   return await adb('shell','cat',xmlPath);
  }catch(error){
   if(attempt===4)throw error;
   await sleep(450);
  }
 }
 throw new Error('Native UI dump unavailable');
}
async function lobby(){
 await until(async()=>{const xml=await nativeXml();return xml.includes('content-desc="game:')&&!xml.includes('class="android.webkit.WebView"');},'native lobby without WebView');
}
async function nativeGameTap(game){
 let xml=await nativeXml();
 for(let attempt=0;attempt<8;attempt++){
  const node=xml.match(new RegExp('<node\\b[^>]*content-desc="game:'+game+'"[^>]*>'))?.[0];
  const b=node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if(b&&+b[4]- +b[2]>=120){await adb('shell','input','tap',String(Math.round((+b[1]+ +b[3])/2)),String(Math.round((+b[2]+ +b[4])/2)));return;}
  const size=await adb('shell','wm','size'),m=size.match(/(?:Override|Physical) size: (\d+)x(\d+)/);assert.ok(m);
  await adb('shell','input','swipe',String(Math.round(+m[1]*.5)),String(Math.round(+m[2]*.75)),String(Math.round(+m[1]*.5)),String(Math.round(+m[2]*.3)),'350');
  xml=await nativeXml();
 }
 throw Error('Native game button not found: '+game);
}

async function openObservedGame(game,result,holder){
 const state={game,token:null,sessionId:null,playerId:null,appId:null,room:null,ownedRooms:new Set(),practiceRequested:false,spins:[],acks:new Set(),returning:false,phase:'entry'};
 holder.state=state;
 await nativeGameTap(game);await until(async()=>(await nativeXml()).includes('class="android.webkit.WebView"'),'native WebView creation');
 const observer=await connect(state,result);Object.assign(holder,observer);await until(()=>page.url()===origin+'/demo/native/'+game,'exact native game host');
 observer.boundary.arm();const reloadResponse=await page.reload({waitUntil:'domcontentloaded',timeout:30000});observer.boundary.verifyNavigation(reloadResponse);
 await until(()=>Boolean(state.token&&state.sessionId),'observed launch exchange');
 await until(()=>page.frames().some(frame=>frame.url()===origin+'/play/'+game),'exact game frame');
 const frame=page.frames().find(frame=>frame.url()===origin+'/play/'+game);assert.equal(await page.locator('iframe').count(),1);assert.equal(await page.locator('button[data-game]').count(),0);
 result.probe_installation=await observer.fetchProbe.requireInstalled(frame);
 return{state,frame,...observer};
}
async function stopUi(result){
 // Failure cleanup tears down only this explicitly selected test APK. It never
 // presses a business leave/ACK button on an inherited room or presentation.
 if(!page||page.isClosed()){await lobby();result.ui_stopped=true;return true;}
 await adb('shell','am','force-stop',pkg);result.ui_stop_method='force-stop-owned-test-apk';
 await until(async()=>!(await adb('shell','pidof',pkg).catch(error=>{if(error.code===1)return '';throw error;})),'owned APK stopped',10000);result.ui_stopped=true;return true;
}
async function closeConnection(result){
 try{await bounded(()=>browser?.close(),'CDP_CLOSE');}catch(error){result.observer_errors??=[];result.observer_errors.push({stage:'cdp-close',message:clean(error.message)});}
 browser=null;context=null;page=null;
 try{await releaseForward();}catch(error){report.resources.errors.push(clean(error.message));}
}
async function api(state,result){
 const invoke=createNativeCleanupApi({page:{request:apiContext},origin,state,result,clean});return async(path,body)=>{const from=result.cleanup_requests.length;try{return await invoke(path,body);}finally{for(const row of result.cleanup_requests.slice(from))row.phase=state.phase==='entry'?'baseline':'cleanup';}};
}
async function startPractice(frame,state){
 await frame.locator('.lobby-settings').waitFor();await nativeTap(frame.getByRole('button',{name:'免费练习',exact:false}));await nativeTap(frame.getByRole('button',{name:'确认规则 · 准备开局',exact:true}));
 await until(()=>state.room?.status==='active','owned practice active');assert.equal(state.room.practice,true);assert.equal(state.room.entry_minor,'0');assert.ok(state.ownedRooms.has(state.room.id),'ROOM_NOT_CREATED_BY_THIS_RUN');
 await frame.locator('.arena-loading').waitFor({state:'hidden'});
}
async function nativeBack(frame,state,result){
 state.returning=true;state.phase='returning';await adb('shell','input','keyevent','4');await sleep(350);
 const visible=async locator=>{if(frame.isDetached()||page.isClosed())return false;try{return await locator.isVisible();}catch(error){if(frame.isDetached()||page.isClosed())return false;throw error;}};
 const leave=frame.getByRole('button',{name:'确认离开',exact:true});if(await visible(leave))await nativeTap(leave);
 const confirm=frame.locator('[data-return="confirm"]');if(await visible(confirm))await nativeTap(confirm);
 await lobby();result.native_back_returned=true;result.ui_stopped=true;
}
async function spinOnce(frame,state){
 const spin=frame.locator('#spin');await spin.waitFor();await until(()=>spin.isEnabled(),'spin enabled');await nativeTap(spin);
 await until(async()=>{const close=frame.locator(state.game==='tiger'?'#continue':'.celebration-close');if(await close.isVisible())await nativeTap(close);return state.spins.length>0&&state.spins.every(round=>state.acks.has(round.id));},'original paid cycle settlement and exact ACK',120000);
 assertAndroidPaidCycle(state);
}
async function measureLayout(frame,result){
 const v=await frame.evaluate(()=>({width:innerWidth,height:innerHeight,scroll_width:document.documentElement.scrollWidth,scroll_height:document.documentElement.scrollHeight,body_height:document.body.scrollHeight}));
 const host=await page.evaluate(()=>({width:innerWidth,height:innerHeight,secure:isSecureContext,user_agent:navigator.userAgent}));
 const checks={width_matches:Math.abs(v.width-host.width)<=1,height_matches:Math.abs(v.height-host.height)<=1,no_horizontal_overflow:v.scroll_width<=v.width+1,no_document_overflow:v.scroll_height<=v.height+1,no_body_overflow:v.body_height<=v.height+1};
 // Preserve the measured dimensions and failed predicates before an assertion
 // exits the game attempt; screenshots cannot recover the CSS viewport size.
 result.layout={host,game:v,checks,single_screen:Object.values(checks).every(Boolean)};
 assert.ok(host.secure&&host.user_agent.includes('OASISSmoke/'+artifact.version));
 assert.ok(result.layout.single_screen,'WEBVIEW_SINGLE_SCREEN_REQUIRED');return result.layout;
}
let releaseBefore;
try{
 releaseBefore=await deployedRelease();report.release_before=releaseBefore;
 const devices=(await run('adb',androidAdbArgs(target,['devices','-l'],{device:false}),{timeout:10000})).stdout;
 assert.ok(devices.split('\n').some(line=>line.split(/\s+/)[0]===serial&&line.split(/\s+/)[1]==='device'&&(remoteDevice||line.includes('usb:'))),'EXACT_ANDROID_DEVICE_REQUIRED');
 report.installed_artifact=await verifyInstalledAndroidArtifact(target,artifact,run);beforeForwards=await forwards();report.resources.before_forwards=beforeForwards;
 originalForeground=androidForeground(await adb('shell','dumpsys','activity','activities'));report.resources.original_foreground=originalForeground;
 // No overwrite of another run's XML. Nonzero test means it is absent only
 // when the shell exits exactly 1; transport/permission errors remain errors.
 try{await adb('shell','test','-e',xmlPath);assert.fail('OWNED_XML_ALREADY_EXISTS');}catch(error){assert.equal(error.code,1,'OWNED_XML_ABSENCE_UNPROVEN');}
 apiContext=await httpRequest.newContext({ignoreHTTPSErrors:false,timeout:12000});
 apkStarted=true;await adb('shell','am','force-stop',pkg);await adb('shell','am','start','-n',target.component);await lobby();
 const bootstrapResult={game:'match',instrumentation_only:true,passed:false};report.bootstrap=bootstrapResult;let bootstrap={};
 try{
  bootstrap=await openObservedGame('match',bootstrapResult,bootstrap);guest=bootstrap.state.playerId;
  await bootstrap.drain({final:false});await stopUi(bootstrapResult);
  previousInventory=await inventory(bootstrap.state);report.inventory_initial=previousInventory;
  assert.equal(previousInventory.current_session_cycles,0);
  }catch(error){bootstrapResult.error=clean(error.stack);}
 finally{
  try{if(!bootstrapResult.ui_stopped)await stopUi(bootstrapResult);}catch(error){bootstrapResult.stop_error=clean(error.message);}
  await closeConnection(bootstrapResult);
  try{await bootstrap.drain?.({final:true});}catch(error){(bootstrapResult.observer_errors??=[]).push({stage:'post-close-drain',message:clean(error.message)});}
 }
 assert.ok(!bootstrapResult.error&&!bootstrapResult.stop_error&&nativeErrorsEmpty(bootstrapResult)&&report.resources.errors.length===0,bootstrapResult.error||'BOOTSTRAP_OBSERVATION_OR_CLEANUP_FAILED');bootstrapResult.passed=true;
 for(const game of selected){
  const result={game,passed:false};report.games.push(result);let session={},action;
  await adb('shell','am','start','-n',target.component);await lobby();
  try{
   session=await openObservedGame(game,result,session);const {state,frame,drain}=session,read=await api(state,result);
   await drain({final:false});const proof=await inventory(state,{previous:previousInventory});result.inventory_before=proof;assert.equal(proof.current_session_cycles,0,'CURRENT_SESSION_ALREADY_HAS_A_CYCLE');
   const baseline=await read(ARENA_IDS.includes(game)?'/api/arena/session':`/api/play/${game}/session`);
   result.baseline=assertAndroidSessionBaseline(state,baseline,ARENA_IDS);state.phase='playing';
   if(ARENA_IDS.includes(game)){
    await startPractice(frame,state);action=await runNativeActionOnce(()=>playOneArenaAction(frame,game,()=>state.room),result,clean);await drain({final:false});assertAndroidOneAction(state,action);
    result.action=action;result.input_scope='Trusted UI controls in the real WebView; drag paths use browser mouse input. Not a complete physical swipe-quality assessment.';
   }else{await spinOnce(frame,state);result.probability={cycle:assertAndroidPaidCycle(state),spins:state.spins.length,matching_acks:state.acks.size};}
   await measureLayout(frame,result);await page.screenshot({path:new URL(game+'-webview.png',out).pathname});
   await nativeBack(frame,state,result);await drain({final:false});if(action)assertAndroidOneAction(state,action);
   result.ui_check_passed=true; // Errors/pending observations are gated only after final drain.
  }catch(error){result.error=clean(error.message);result.failure_action={status:error.status??null,code:error.code??null,request_body:error.requestBody??null,response_body:error.responseBody??null};await page?.screenshot({path:new URL(game+'-failure.png',out).pathname}).catch(shot=>{result.screenshot_error=clean(shot.message);});}
  finally{
   try{if(!result.ui_stopped)await stopUi(result);}catch(error){result.cleanup={passed:false,error:clean(error.message)};}
   if(session.state){
    try{await session.drain?.({final:false});}catch(error){(result.observer_errors??=[]).push({stage:'pre-cleanup-drain',message:clean(error.message)});}
    if(result.ui_stopped){session.state.phase='cleanup';result.cleanup=await cleanupOwnedAndroidSession({state:session.state,arenaGames:ARENA_IDS,api:await api(session.state,result),until,newId:()=> 'android_cleanup_'+randomUUID().replaceAll('-',''),uiStopped:true,clean});}
    try{previousInventory=await inventory(session.state);result.inventory_after=previousInventory;assert.ok(result.inventory_before,'NO_ACCEPTED_INVENTORY_BASELINE');const probability=!ARENA_IDS.includes(game);assert.equal(previousInventory.counts.cycles,result.inventory_before.counts.cycles+(probability?1:0),'UNEXPECTED_CYCLE_COUNT');assert.equal(previousInventory.counts.rooms,result.inventory_before.counts.rooms+(probability?0:1),'UNEXPECTED_ROOM_COUNT');assert.equal(previousInventory.current_session_cycles,probability?1:0);if(action){assertAndroidOneAction(session.state,action);assert.equal(session.state.creations.length,1);}}catch(error){result.inventory_error=clean(error.message);}
   }
   await closeConnection(result);try{await session.drain?.({final:true});}catch(error){(result.observer_errors??=[]).push({stage:'post-close-drain',message:clean(error.message)});}
   result.passed=Boolean(result.ui_check_passed&&result.cleanup?.passed&&result.inventory_after?.clean&&nativeErrorsEmpty(result)&&!result.error&&!result.inventory_error&&report.resources.errors.length===0);await save();
  }
  if(!result.passed)throw Error('STRICT_GAME_FAILED: '+game+'; first failure retained, no retry');
 }
 report.inventory_final=previousInventory;report.release_after=await deployedRelease();assert.deepEqual(report.release_after,releaseBefore,'DEPLOYMENT_CHANGED');
 assert.deepEqual(await verifyInstalledAndroidArtifact(target,artifact,run),report.installed_artifact,'INSTALLED_APK_CHANGED');
}catch(error){report.failure=clean(error.stack);process.exitCode=1;}
finally{
 try{await bounded(()=>browser?.close(),'CDP_CLOSE');}catch(error){report.resources.errors.push(clean(error.message));}
 try{await releaseForward();}catch(error){report.resources.errors.push(clean(error.message));}
 if(apkStarted){
  try{await adb('shell','am','force-stop',pkg);await adb('shell','rm','-f',xmlPath);try{await adb('shell','test','-e',xmlPath);assert.fail('OWNED_XML_REMAINS');}catch(error){assert.equal(error.code,1,'OWNED_XML_CLEANUP_UNPROVEN');}report.resources.xml_removed=true;}catch(error){report.resources.errors.push(clean(error.message));}
  try{await adb('shell','am','start','-n',originalForeground);assert.equal(androidForeground(await adb('shell','dumpsys','activity','activities')),originalForeground);report.resources.foreground_restored=true;}catch(error){report.resources.errors.push(clean(error.message));}
 }
 try{if(beforeForwards){report.resources.after_forwards=await forwards();assertAndroidForwardsRestored(beforeForwards,report.resources.after_forwards);report.resources.forwards_restored=true;}}catch(error){report.resources.errors.push(clean(error.message));}
 try{await bounded(()=>apiContext?.dispose(),'API_CONTEXT_DISPOSE',15000);}catch(error){report.resources.errors.push(clean(error.message));}
 report.resources.passed=Boolean(report.resources.forwards_restored&&report.resources.foreground_restored&&report.resources.xml_removed&&report.resources.errors.length===0);
 report.passed=androidStrictPassed(report);if(!report.passed)process.exitCode=1;report.finished_at=new Date().toISOString();await save();
}
console.log(JSON.stringify({passed:report.passed,full_catalog:report.full_catalog,physical_device:report.physical_device,games:report.games.length,report:outputPath,failure:report.failure?.split('\n')[0]}));
