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
import {installOwnedPlayerResourceEvidence,validateConsumedImageEvidence,deliveryProofForRow,generatedScriptProofForResponse} from './android-player-resource-evidence.mjs';
import {playerAcceptanceArguments,readPlayerArtifact,createPlayerEvidenceRedactor,readPlayerCredentials,readNativeHealthProducerContract,assertPlayerLobbyBaseline,assertPlayerZeroWallet,assertOwnedPlayerArenaState,assertPlayerReturnReadback,playerResourceManifest,assertPlayerResourceBody,assertInstalledPlayerArtifact,playerEvidenceHash,playerShellSourcePins,playerRunResumeEvidence} from './android-player-acceptance-checks.mjs';

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
export async function collectPlayerEvidence({context,page,origin,manifest,out,redactor,result,resourceDrainTimeoutMs=15000,resourceOutputRoot}){
 assert.ok(Number.isSafeInteger(resourceDrainTimeoutMs)&&resourceDrainTimeoutMs>0&&resourceDrainTimeoutMs<=15000,'RESOURCE_DRAIN_BOUND');
 const cdp=await context.newCDPSession(page),tasks=new Set(),responseWork=new WeakMap(),raw=[],responses=[],errors=[],requests=[],requestRows=new WeakMap(),cdpRequests=new Map(),contexts=new Map(),resourceDocuments=new Map(),rawBodyDiagnostics=[],resourceSnapshots=[],handlers=[],initHandles=[];
 const imagePath=path=>!/^\/(?:api|v1)(?:\/|$)/.test(path)&&/\.(?:webp|png|jpe?g|svg|avif|gif)$/.test(path),hasImages=[...manifest.expected.keys()].some(imagePath);
 const entryUrl=hasImages?page.url():null,nonce=randomUUID();let sequence=0,totalBytes=0,closed=false;
 const rememberPost=value=>{if(value){try{redactor.remember(JSON.parse(value));}catch{redactor.add(value);}}};
 const on=(event,fn)=>{cdp.on(event,fn);handlers.push({event,fn});},key=row=>row.frameId+':'+row.contextId;
 for(const event of ['Network.requestWillBeSent','Network.responseReceived','Network.loadingFinished','Network.loadingFailed','Page.frameNavigated','Runtime.executionContextCreated','Runtime.executionContextDestroyed','Runtime.executionContextsCleared','Runtime.exceptionThrown','Security.visibleSecurityStateChanged'])on(event,value=>{
  redactor.remember(value);if(event==='Network.requestWillBeSent')rememberPost(value.request?.postData);raw.push({event,value});
 });
 on('Runtime.executionContextCreated',({context:realm})=>contexts.set(realm.id,realm));
 on('Runtime.executionContextDestroyed',({executionContextId})=>contexts.delete(executionContextId));on('Runtime.executionContextsCleared',()=>contexts.clear());
 on('Network.requestWillBeSent',event=>{
  try{assert.ok(cdpRequests.size<50000,'RESOURCE_NETWORK_RECORD_BOUND');
   const realms=[...contexts.values()].filter(realm=>realm.auxData?.isDefault&&realm.auxData.frameId===event.frameId);
   cdpRequests.set(event.requestId,{id:event.requestId,url:event.request.url,frameId:event.frameId,contextId:realms.length===1?realms[0].id:null,method:event.request.method,type:event.type,startedAtMs:event.wallTime*1000,startedMonotonic:event.timestamp,redirected:!!event.redirectResponse||cdpRequests.has(event.requestId),transferFinished:false,response:null,failed:false});
  }catch(error){errors.push(error.message);}
 });
 on('Network.responseReceived',({requestId,response})=>{const row=cdpRequests.get(requestId);if(row)row.response={status:response.status,fromServiceWorker:response.fromServiceWorker===true};});
 on('Network.loadingFinished',({requestId,timestamp})=>{const row=cdpRequests.get(requestId);if(row){row.transferFinished=true;row.finishedMonotonic=timestamp;row.finishedAtMs=row.startedAtMs+(timestamp-row.startedMonotonic)*1000;}});
 on('Network.loadingFailed',({requestId,errorText})=>{const row=cdpRequests.get(requestId);if(row){row.failed=true;row.failure=errorText;}});
 try{
  if(hasImages){
   assert.equal(new URL(entryUrl).origin,origin,'RESOURCE_PARENT_ORIGIN_REQUIRED');assert.equal(new URL(entryUrl).pathname,'/player','RESOURCE_PARENT_ENTRY_REQUIRED');
   // Only an immutable document identity is installed here. There is no RAF,
   // generated input, Response clone or replacement network response.
   const identityHandle=await context.addInitScript(({origin,entryUrl,games,nonce})=>{
    let game;try{const u=new URL(location.href);game=u.pathname.slice('/play/'.length);if(globalThis===parent||parent!==top||u.href!==origin+'/play/'+game||!games.includes(game)||parent.location.href!==entryUrl)return;}catch{return;}
    if(Object.prototype.hasOwnProperty.call(globalThis,'__oasisPhysicalPerf'))throw Error('RESOURCE_DOCUMENT_IDENTITY_ALREADY_INSTALLED');
    const id=new Uint8Array(16);crypto.getRandomValues(id);Object.defineProperty(globalThis,'__oasisPhysicalPerf',{value:Object.freeze({schema:'android-physical-performance-v1',nonce,documentId:Array.from(id,v=>v.toString(16).padStart(2,'0')).join(''),timeOrigin:performance.timeOrigin,url:location.href}),configurable:false,writable:false});
   },{origin,entryUrl,games:ARENA_IDS,nonce});
   assert.ok(identityHandle&&typeof identityHandle.dispose==='function','RESOURCE_IDENTITY_INIT_DISPOSABLE_REQUIRED');initHandles.push(identityHandle);
   initHandles.push(await installOwnedPlayerResourceEvidence(context,{origin,entryUrl,games:ARENA_IDS,manifest,nonce,root:resourceOutputRoot}));
  }
  await cdp.send('Network.enable');await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Security.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await mkdir(join(out,'bodies'),{recursive:true,mode:0o700});
 }catch(error){for(const {event,fn}of handlers)cdp.off(event,fn);await Promise.allSettled(initHandles.map(handle=>handle.dispose()));await cdp.detach().catch(()=>{});throw error;}
 const bounded=async(work,ms,label)=>{let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]);}finally{clearTimeout(timer);}};
 const validateDocument=document=>{
  for(const receipt of document.snapshot.receipts)for(const source of cdpRequests.values())if(source.url===receipt.sourceUrl&&source.frameId===document.scope.frameId){assert.equal(source.contextId,document.scope.contextId,'RESOURCE_SOURCE_CONTEXT_CHANGED');assert.ok(!source.redirected,'RESOURCE_SOURCE_REDIRECT_REFUSED');}
  return validateConsumedImageEvidence(document.snapshot,{origin,entryUrl,game:document.game,nonce,documentId:document.owner.documentId,timeOrigin:document.owner.timeOrigin,scope:document.scope,manifest,requests:[...cdpRequests.values()]});
 };
 const retainSnapshot=(row,document)=>{const value={responseId:row.id,scope:document.scope,owner:document.owner,snapshot:document.snapshot};if(row.resource_snapshot_index===undefined){row.resource_snapshot_index=resourceSnapshots.length;resourceSnapshots.push(value);}else resourceSnapshots[row.resource_snapshot_index]=value;};
 async function delivery(row,{generatedScript=false}={}){
  const matches=[...cdpRequests.values()].filter(get=>get.url===row.url&&get.method===row.method);
  const cachedMatches=matches.filter(get=>resourceDocuments.get(key(get))?.owner.url===row.frame),liveRealms=[...contexts.values()].filter(realm=>realm.auxData?.isDefault);
  let get,document,scope;const deliveryDeadline=Date.now()+resourceDrainTimeoutMs;
  if(!generatedScript&&cachedMatches.length===1&&!liveRealms.some(realm=>realm.id===cachedMatches[0].contextId)){get=cachedMatches[0];scope={frameId:get.frameId,contextId:get.contextId};document=resourceDocuments.get(key(scope));}
  else{
   const {frameTree}=await cdp.send('Page.getFrameTree');assert.equal(frameTree?.frame.url,entryUrl,'RESOURCE_PARENT_DOCUMENT_CHANGED');
   const frames=(frameTree.childFrames||[]).filter(child=>child.frame.url===row.frame&&child.frame.parentId===frameTree.frame.id);
   assert.equal(frames.length,1,'RESOURCE_OWN_GAME_FRAME_AMBIGUOUS');const frame=frames[0].frame,game=frame.url.slice((origin+'/play/').length);
   assert.ok(frame.url===origin+'/play/'+game&&ARENA_IDS.includes(game),'RESOURCE_OWN_GAME_FRAME_REQUIRED');
   const realms=liveRealms.filter(realm=>realm.auxData.frameId===frame.id&&realm.origin===origin);assert.equal(realms.length,1,'RESOURCE_CDP_CONTEXT_REQUIRED');
   const owned=matches.filter(candidate=>candidate.frameId===frame.id&&candidate.contextId===realms[0].id);
   if(generatedScript){assert.ok(owned.length>0&&owned.every(candidate=>candidate.type==='Script'&&!candidate.redirected&&!candidate.failed),'GENERATED_SCRIPT_CDP_SCOPE_UNPROVEN');row.cdp_request_ids=owned.map(candidate=>candidate.id);}
   else{assert.equal(owned.length,1,'RESOURCE_DELIVERY_REQUEST_AMBIGUOUS');get=owned[0];}
   scope={frameId:frame.id,contextId:realms[0].id};const end=deliveryDeadline;
   for(;;){
    assert.ok(Date.now()<end,'RESOURCE_DELIVERY_DRAIN_TIMEOUT');assert.ok(contexts.has(scope.contextId),'RESOURCE_GAME_EXECUTION_CONTEXT_LOST');
    const evaluated=await bounded(cdp.send('Runtime.evaluate',{expression:`(async()=>{const p=globalThis.__oasisPhysicalPerf,c=globalThis.__oasisConsumedImageEvidence;return {owner:p?{schema:p.schema,nonce:p.nonce,documentId:p.documentId,timeOrigin:p.timeOrigin,url:p.url}:null,snapshot:c?await c.drain(${resourceDrainTimeoutMs}):null};})()`,contextId:scope.contextId,returnByValue:true,awaitPromise:true}),end-Date.now(),'RESOURCE_DELIVERY_DRAIN_TIMEOUT');
    assert.ok(!evaluated.exceptionDetails,'RESOURCE_DELIVERY_EVALUATION_FAILED');const value=evaluated.result?.value,owner=value?.owner;
    document={game,scope,owner,snapshot:value?.snapshot};retainSnapshot(row,document);
    assert.ok(owner?.schema==='android-physical-performance-v1'&&owner.nonce===nonce&&owner.url===frame.url&&/^[a-f0-9]{32}$/.test(owner.documentId)&&Number.isFinite(owner.timeOrigin),'RESOURCE_NATIVE_DOCUMENT_UNPROVEN');
    const prior=resourceDocuments.get(key(scope));if(prior)assert.deepEqual(owner,prior.owner,'RESOURCE_NATIVE_DOCUMENT_CHANGED');
    assert.ok(document.snapshot,'RESOURCE_EVIDENCE_MISSING');assert.deepEqual(document.snapshot.errors,[],'RESOURCE_EVIDENCE_ERRORS');
    assert.deepEqual(document.snapshot.identity,{nonce,documentId:owner.documentId,timeOrigin:owner.timeOrigin,url:frame.url,parentUrl:entryUrl},'RESOURCE_DOCUMENT_IDENTITY_CHANGED');
    const allReceipts=[...document.snapshot.receipts,...(document.snapshot.generatedReceipts||[])],receipt=allReceipts.find(receipt=>row.url.startsWith('blob:')?receipt.blobUrls.some(blob=>blob.url===row.url):receipt.sourceUrl===row.url);
    if((!receipt||!receipt.hashComplete||!receipt.blobUrls.length||!generatedScript&&!get.transferFinished)&&document.snapshot.phase==='loading'){
     if(row.url.startsWith('blob:')&&allReceipts.some(receipt=>receipt.hashComplete)&&!receipt)throw Error('RESOURCE_ALTERNATIVE_DELIVERY_UNPROVEN');
     if(get?.failed||get?.response?.fromServiceWorker)break;await sleep(Math.min(25,Math.max(1,end-Date.now())));continue;
    }
    try{validateDocument(document);}catch(error){
     // A different image may have just resolved Response.blob while its native
     // object URL or transfer is still finishing. Only incomplete work retries.
     const incomplete=document.snapshot.receipts.some(receipt=>!receipt.hashComplete||!receipt.blobUrls.length||[...cdpRequests.values()].some(source=>source.url===receipt.sourceUrl&&source.frameId===scope.frameId&&!source.transferFinished&&!source.failed));
     if(document.snapshot.phase==='loading'&&(incomplete&&/RESOURCE_CONSUMED_BYTES_UNPROVEN|RESOURCE_OBJECT_URL_UNPROVEN|RESOURCE_SOURCE_GET_UNPROVEN|RESOURCE_HASH_TASKS_NOT_CLOSED/.test(error.message)||error.message==='GENERATED_SCRIPT_SOURCE_TRANSFER_PENDING')){await sleep(Math.min(25,Math.max(1,end-Date.now())));continue;}throw error;
    }
    break;
   }
  }
  if(!generatedScript)assert.ok(!get.redirected,'RESOURCE_DELIVERY_REDIRECT_REFUSED');const evidence=validateDocument(document);
  if(generatedScript){
   const paths=new Set(evidence.byGeneratedBlob.get(row.url)?.sourcePins.map(pin=>origin+pin.path)),prior=responses.filter(source=>paths.has(source.url)&&source.frame===row.frame&&source.id<row.id&&source.request_id<row.request_id);
   // Header/body collection may finish after a later worker response. Await
   // only sources already registered before this worker; never a later GET.
   assert.ok(Date.now()<deliveryDeadline,'GENERATED_SCRIPT_INPUT_BODY_DRAIN_TIMEOUT');await bounded(Promise.all(prior.map(source=>responseWork.get(source))),deliveryDeadline-Date.now(),'GENERATED_SCRIPT_INPUT_BODY_DRAIN_TIMEOUT');
  }
  const proof=generatedScript?generatedScriptProofForResponse({...row,frameId:document.scope.frameId,contextId:document.scope.contextId,transferFinished:row.worker_response_finished===true},evidence,{origin,manifest,bodyPins:responses}):deliveryProofForRow(get,evidence,{origin,manifest});
  if(row.original_bytes>0)assert.equal(row.original_sha256,proof.sha256,'RESOURCE_NONEMPTY_CDP_BODY_CONFLICT');
  resourceDocuments.set(key(scope),document);retainSnapshot(row,document);
  row.delivery_scope=scope;row.deliveryProof=proof;row.rawBodyDiagnostic.frameId=scope.frameId;row.rawBodyDiagnostic.contextId=scope.contextId;row.rawBodyDiagnostic.resolvedByIndependentDelivery=true;
  if(generatedScript){row.rawBodyDiagnostic.playwrightRequestId=row.request_id;row.rawBodyDiagnostic.mainFrameCdpWorkerCandidates=(row.cdp_request_ids||[]).map(id=>{const item=cdpRequests.get(id);return {requestId:id,transferFinished:item.transferFinished,response:item.response,failed:item.failed};});row.pin={path:row.url,sha256:proof.sha256,bytes:proof.bytes,source:'Exact original readable Worker response bound to the release-manifest decoder/module recipe and the actual native Blob',sourcePins:proof.sourcePins};}
  else{row.cdp_request_id=get.id;row.rawBodyDiagnostic.requestId=get.id;}
 }
 const onRequest=request=>{try{const u=new URL(request.url());if(!['http:','https:','blob:'].includes(u.protocol))return;const row={id:++sequence,at:Date.now(),url:request.url(),method:request.method(),frame:request.frame()?.url(),headers:request.headers(),postData:request.postData(),resourceType:request.resourceType()};redactor.remember(row.headers);rememberPost(row.postData);requests.push(row);requestRows.set(request,row);if(u.origin!==origin&&!['https://fonts.googleapis.com','https://fonts.gstatic.com'].includes(u.origin))errors.push('UNEXPECTED_NETWORK_ORIGIN: '+u.origin);}catch(error){errors.push('REQUEST_OBSERVATION_FAILED: '+error.message);}};
 const onResponse=response=>{
  let row;
  const work=(async()=>{
   const request=response.request(),u=new URL(response.url()),status=response.status();
   row={id:responses.length+1,at:Date.now(),request_at:requestRows.get(request)?.at??null,request_id:requestRows.get(request)?.id??null,request_headers:requestRows.get(request)?.headers??null,url:response.url(),path:u.pathname,method:request.method(),status,frame:request.frame()?.url(),resourceType:request.resourceType(),headers:null};responses.push(row);
   const headers=await response.allHeaders();redactor.remember(headers);row.headers=headers;
   if(!response.ok())row.body_error='NON_SUCCESS_STATUS';let bytes,bodyError;
   try{bytes=await response.body();row.original_sha256=playerEvidenceHash(bytes);row.original_bytes=bytes.length;totalBytes+=bytes.length;assert.ok(totalBytes<=256*1024*1024,'EVIDENCE_BODY_BOUND_EXCEEDED');}catch(error){bodyError=error;}
   const api=u.origin===origin&&(/^\/(api|v1)\//.test(u.pathname)||['/health','/health/ready'].includes(u.pathname));
   const ownGame=ARENA_IDS.some(game=>row.frame===origin+'/play/'+game),image=row.resourceType==='image'||imagePath(u.pathname),ownImage=hasImages&&!api&&ownGame&&image&&u.origin===origin&&row.method==='GET'&&status===200;
   const ownGeneratedScript=hasImages&&ownGame&&u.protocol==='blob:'&&u.origin===origin&&row.resourceType==='script'&&row.method==='GET'&&status===200&&bytes?.length>0&&!bodyError;
   if(bodyError&&!ownImage)throw bodyError;if(bodyError?.message==='EVIDENCE_BODY_BOUND_EXCEEDED')throw bodyError;
   if(api){try{const value=JSON.parse(bytes);redactor.remember(value);row.body=value;row.body_format='redacted-json';}catch{row.body=bytes.toString('utf8');row.body_format='redacted-text';errors.push('API_RESPONSE_JSON_INVALID: '+u.pathname);}return;}
   if(!response.ok()){row.body=bytes.toString('utf8');row.body_format='redacted-text';return;}
   if(['document','script','stylesheet','image','font','media','fetch','xhr'].includes(request.resourceType())){
    try{if(bodyError)throw bodyError;if(u.protocol==='blob:')throw Error('UNPINNED_PLAYER_RESOURCE: '+u.pathname);row.pin=u.origin===origin?assertPlayerResourceBody(response.url(),bytes,{origin,manifest}):{sha256:row.original_sha256,bytes:bytes.length,source:'Observed external HTTPS public asset; not a release output pin',origin:u.origin};}
    catch(error){
     if(!ownImage&&!ownGeneratedScript)throw error;
     const diagnostic={responseId:row.id,path:row.path,url:row.url,code:bytes===undefined?'CDP_RESPONSE_BODY_UNAVAILABLE':u.protocol==='blob:'?'UNPINNED_PLAYER_RESOURCE':'PLAYER_RESOURCE_BODY_SHA_MISMATCH',originalError:error.message,bodyBytes:row.original_bytes??null,bodySha256:row.original_sha256??null,nonemptyPublicBodyConflict:!!(bytes?.length&&u.protocol!=='blob:'),resolvedByIndependentDelivery:false};
     rawBodyDiagnostics.push(diagnostic);row.rawBodyDiagnostic=diagnostic;if(diagnostic.nonemptyPublicBodyConflict)throw error;
     try{if(ownGeneratedScript){assert.equal(typeof response.finished,'function','GENERATED_SCRIPT_RESPONSE_FINISH_REQUIRED');const failure=await bounded(response.finished(),resourceDrainTimeoutMs,'GENERATED_SCRIPT_RESPONSE_FINISH_TIMEOUT');assert.equal(failure,null,'GENERATED_SCRIPT_RESPONSE_FINISH_FAILED');row.worker_response_finished=true;await delivery(row,{generatedScript:true});}else await delivery(row);}catch(proofError){diagnostic.deliveryError=proofError.message;throw proofError;}
    }
    if(bytes!==undefined){const file='body-'+row.original_sha256;await writeFile(join(out,'bodies',file),bytes,{mode:0o600,flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});row.stored_body='bodies/'+file;}
   }
  })().catch(error=>errors.push(error.message));if(row)responseWork.set(row,work);tasks.add(work);void work.finally(()=>tasks.delete(work));
 };
 page.on('request',onRequest);page.on('response',onResponse);
 return{cdp,raw,responses,requests,errors,rawBodyDiagnostics,resourceSnapshots,
  async drain(){const deadline=Date.now()+20000;try{while(tasks.size){assert.ok(Date.now()<deadline,'RAW_RESPONSE_DRAIN_TIMEOUT');await bounded(Promise.all([...tasks]),deadline-Date.now(),'RAW_RESPONSE_DRAIN_TIMEOUT');}
   // Recheck the original Blob input IDs/facts and every later observed GET.
   // Later success cannot repair an earlier proof; failed transfers still revoke it.
   for(const row of responses.filter(row=>row.rawBodyDiagnostic?.resolvedByIndependentDelivery)){try{const get=cdpRequests.get(row.cdp_request_id),document=resourceDocuments.get(key(row.delivery_scope)),evidence=validateDocument(document);if(row.worker_response_finished){const candidates=[...cdpRequests.values()].filter(candidate=>candidate.url===row.url&&candidate.frameId===document.scope.frameId&&candidate.contextId===document.scope.contextId);assert.ok(candidates.length>0&&candidates.every(candidate=>candidate.method==='GET'&&candidate.type==='Script'&&!candidate.redirected&&!candidate.failed),'GENERATED_SCRIPT_CDP_SCOPE_UNPROVEN');}const proof=row.worker_response_finished?generatedScriptProofForResponse({...row,frameId:document.scope.frameId,contextId:document.scope.contextId,transferFinished:true},evidence,{origin,manifest,bodyPins:responses}):deliveryProofForRow(get,evidence,{origin,manifest});assert.deepEqual(proof,row.deliveryProof,'RESOURCE_DELIVERY_PROOF_CHANGED');}catch(error){row.rawBodyDiagnostic.resolvedByIndependentDelivery=false;row.rawBodyDiagnostic.deliveryError=error.message;errors.push(error.message);}}
  }finally{result.raw_response_work_pending=tasks.size;}},
  async save(){await this.drain();await writeFile(join(out,'raw-cdp.json'),JSON.stringify(redactor.sanitize(raw),null,2),{mode:0o600});await writeFile(join(out,'network-bodies.json'),JSON.stringify(redactor.sanitize({requests,responses,errors,totalBytes,rawBodyDiagnostics,resourceSnapshots,cdpRequests:[...cdpRequests.values()],deliveryEvidenceSeparateFromCdpBody:true}),null,2),{mode:0o600});},
  async close({transportClosed=false}={}){if(closed)return;closed=true;const failures=[];
   try{await this.drain();}catch(error){failures.push(error);}
   for(const document of resourceDocuments.values())if(contexts.has(document.scope.contextId))try{const stopped=await bounded(cdp.send('Runtime.evaluate',{expression:'globalThis.__oasisConsumedImageEvidence.stop()',contextId:document.scope.contextId,returnByValue:true,awaitPromise:true}),resourceDrainTimeoutMs,'RESOURCE_CLOSE_TIMEOUT');assert.ok(!stopped.exceptionDetails,'RESOURCE_CLOSE_EVALUATION_FAILED');if(stopped.result?.value)validateConsumedImageEvidence(stopped.result.value,{origin,entryUrl,game:document.game,nonce,documentId:document.owner.documentId,timeOrigin:document.owner.timeOrigin,scope:document.scope,manifest,requests:[...cdpRequests.values()]});}catch(error){if(!transportClosed||!/Target.*closed|Session closed|Connection closed|not connected/i.test(error.message))failures.push(error);}
   page.off('request',onRequest);page.off('response',onResponse);for(const {event,fn}of handlers)cdp.off(event,fn);
   for(const handle of initHandles)try{await handle.dispose();}catch(error){if(!transportClosed||!/Target.*closed|Session closed|Connection closed|not connected/i.test(error.message))failures.push(error);}
   try{await cdp.detach();}catch(error){if(!transportClosed||!/Target.*closed|Session closed/i.test(error.message))failures.push(error);}
   if(failures.length){errors.push(...failures.map(error=>error.message));throw new AggregateError(failures,failures.map(error=>error.message).join('; '));}
  },
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
 const healthProducerContract=options.healthProducerContract?await readNativeHealthProducerContract(options.healthProducerContract,{root:ROOT,origin:artifact.origin}):null;
 const out=resolve(options.output);await mkdir(out,{mode:0o700});await mkdir(join(out,'bodies'),{mode:0o700});
 const report={schema:'android-real-player-acceptance-v1',mode:options.mode,started_at:new Date().toISOString(),passed:false,executed:false,physical_device:false,
  scope:'Signed real Player QA shell; production cookie identity and zero wallet; one trusted Android/UI action per admitted arena and original-session return/cleanup. Not complete game, frame-rate, iPhone or third-party transfer acceptance.',
  artifact:{metadataSha256:artifact.metadataSha256,apkSha256:artifact.apkSha256,certificateSha256:artifact.certificateSha256,origin:artifact.origin,appId:artifact.appId,packageName:artifact.packageName,sourceEvidence:artifact.sourceEvidence},release:{manifestSha256:manifestSha,runtimePins},games:[],resources:{events:[],errors:[]},lifecycle:{included:options.mode==='lifecycle',separate_report:options.mode==='lifecycle',basic_smoke_is_not_recovery_acceptance:true}};
 if(healthProducerContract)report.health_producer_contract=healthProducerContract;
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
  await locator.scrollIntoViewIfNeeded();await until(async()=>await locator.isEnabled()&&(await locator.getAttribute('aria-disabled'))!=='true','ENABLED_NATIVE_TAP');const b=await locator.boundingBox();assert.ok(b&&b.width>0&&b.height>0,'VISIBLE_NATIVE_TAP_BOUNDS_REQUIRED');
  const targets=await fetch('http://127.0.0.1:'+forward.port+'/json/list',{signal:AbortSignal.timeout(5000)}).then(r=>r.json()),target=targets.find(t=>t.url===artifact.entryUrl);assert.ok(target,'EXACT_PLAYER_WEBVIEW_TARGET_REQUIRED');
  const box=JSON.parse(target.description),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));assert.ok(Math.abs(box.width/viewport.width-viewport.dpr)<.1,'PLAYER_WEBVIEW_SCALE_UNPROVEN');
  const x=Math.round(box.screenX+(b.x+(position?.x??b.width/2))*viewport.dpr),y=Math.round(box.screenY+(b.y+(position?.y??b.height/2))*viewport.dpr);
  assert.ok(x>=box.screenX&&x<box.screenX+box.width&&y>=box.screenY&&y<box.screenY+box.height,'PLAYER_NATIVE_TAP_OUTSIDE_WEBVIEW');await adb('shell','input','tap',String(x),String(y));
 };
 const screenshot=async name=>{
  const masks=page.frames().flatMap(frame=>[frame.locator('.player-welcome, input[name="username"], input[type="password"], .room-code'),frame.getByText(credentials.username,{exact:false}),...(baseline?[frame.getByText(baseline.playerId,{exact:false}),frame.getByText(baseline.externalUserId,{exact:false})]:[])]);
  await page.screenshot({path:join(out,name+'.png'),mask:masks});
  // Supplement CDP capture with the owned QA app's actual device pixels,
  // outside action/continuous-performance timing. Never capture another app.
  if(/^[a-z]+-accepted-action$/.test(name))try{
   assert.equal(androidForeground(await adb('shell','dumpsys','activity','activities')),component,'DEVICE_SCREENSHOT_OWN_QA_FOREGROUND_REQUIRED');
   const started=Date.now(),capture=await execute('adb',playerAdbArgs(options,['exec-out','screencap','-p']),{timeout:15000,maxBuffer:16*1024*1024,encoding:'buffer'}),bytes=capture.stdout;
   assert.ok(Buffer.isBuffer(bytes)&&bytes.length>8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'DEVICE_SCREENSHOT_PNG_REQUIRED');
   const file=name+'.device.png';await writeFile(join(out,file),bytes,{mode:0o600,flag:'wx'});
   (report.device_screenshots??=[]).push({file,packageName:pkg,component,started_at_ms:started,completed_at_ms:Date.now(),bytes:bytes.length,sha256:playerEvidenceHash(bytes),source:'ADB screencap of the foreground owned QA app; visual inspection evidence, no display latency inference'});
  }catch(error){(report.device_screenshot_errors??=[]).push({name,message:redactor.clean(error.message)});}
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
  // Let the current activity persist its cookie jar before killing our process.
  if(androidForeground(await adb('shell','dumpsys','activity','activities'))===component){await adb('shell','input','keyevent','3');await sleep(300);}
  await adb('shell','am','force-stop',pkg);await adb('shell','am','start','-n',component);
  await until(async()=>/^\d+$/.test(await adb('shell','pidof',pkg).catch(error=>{if(error.code===1)return '';throw error;})),'EXACT_PLAYER_PID');const pid=await adb('shell','pidof',pkg),remote='localabstract:webview_devtools_remote_'+pid;
  await until(async()=>(await adb('shell','cat','/proc/net/unix')).includes('@webview_devtools_remote_'+pid),'PLAYER_DEBUG_SOCKET');const localBefore=await forwards(),port=await adb('forward','tcp:0',remote);
  forward={serial:options.serial,local:'tcp:'+port,port,remote};ownedAndroidForward(localBefore,await forwards(),forward);report.resources.events.push({event:'forward-created',...forward});
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{isWebView:true,noDefaults:true,timeout:15000});assert.equal(browser.contexts().length,1,'EXACT_PLAYER_CONTEXT_REQUIRED');context=browser.contexts()[0];
  await until(()=>context.pages().length===1,'EXACT_PLAYER_PAGE');page=context.pages()[0];await until(()=>page.url()===artifact.entryUrl,'EXACT_PLAYER_ENTRY');page.setDefaultTimeout(45000);await page.waitForLoadState('networkidle',{timeout:30000});
  probe=await installNativeFetchProbe(context,{clean:redactor.clean,healthProducerContract});await probe.attach(page);const dir='connection-'+(++connection);await mkdir(join(out,dir),{mode:0o700});evidence=await collectPlayerEvidence({context,page,origin,manifest,out:join(out,dir),redactor,result:report});
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
  if(initial.status===401){
   // The signed-out lobby intentionally reads LOGIN_REQUIRED before login.
   // Preserve that phase, then measure games in a new authenticated WebView.
   await evidence.drain();report.login_phase_page_errors=probe.pageErrors(page);
   const denied=evidence.responses.filter(row=>row.status===401);
   assert.ok(denied.length>0&&denied.every(row=>row.path==='/api/player/session'&&row.body?.error?.code==='LOGIN_REQUIRED'),'UNEXPECTED_PRELOGIN_HTTP_FAILURE');
   assert.ok(report.login_phase_page_errors.every(row=>row.kind==='console'&&row.page_url===artifact.entryUrl&&/^Failed to load resource: the server responded with a status of 401 \(\)$/.test(row.message)),'UNEXPECTED_PRELOGIN_PAGE_ERROR');
   await closeConnection();await connect();assert.equal((await requiredRead('/api/player/session')).player?.id,baseline.playerId,'AUTHENTICATED_RECONNECT_IDENTITY_CHANGED');
   assertPlayerZeroWallet(await requiredRead('/api/player/wallet?app_id='+artifact.appId),artifact.appId,baseline);assert.deepEqual((await requiredRead('/api/player/recovery?app_id='+artifact.appId)).sessions,[],'AUTHENTICATED_RECONNECT_OBLIGATION_CHANGED');
  }
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
  if(healthProducerContract)assert.equal((await readNativeHealthProducerContract(options.healthProducerContract,{root:ROOT,origin:artifact.origin})).sha256,healthProducerContract.sha256,'HEALTH_PRODUCER_CONTRACT_CHANGED_DURING_ACCEPTANCE');
  for(const[name,digest]of Object.entries(runtimePins))assert.equal(playerEvidenceHash(await readFile(join(ROOT,name))),digest,'RUNTIME_SOURCE_CHANGED_DURING_ACCEPTANCE: '+name);
  report.basic_passed=report.full_catalog&&report.games.every(g=>g.passed&&g.cleanup?.passed);report.passed=options.mode==='basic'&&report.basic_passed;
 }catch(error){report.failure=redactor.clean(error.stack);}
 finally{
  if(active&&!active.result.cleanup)await cleanup(active);
  try{await context?.setOffline(false);}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  try{await closeConnection();}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  try{await apiContext?.dispose();}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  if(forward){try{assert.deepEqual((await forwards()).filter(r=>r.local===forward.local),[{serial:forward.serial,local:forward.local,remote:forward.remote}],'OWNED_FORWARD_REPLACED_NO_REMOVE');await adb('forward','--remove',forward.local);}catch(error){report.resources.errors.push(redactor.clean(error.message));}}
  if(started){try{await adb('shell','am','force-stop',pkg);if(foreground){await adb('shell','am','start','-n',foreground);await until(async()=>{report.resources.restoredForeground=androidForeground(await adb('shell','dumpsys','activity','activities'));return report.resources.restoredForeground===foreground;},'ORIGINAL_FOREGROUND_NOT_RESTORED',10000);}else report.resources.restoredForeground=androidForeground(await adb('shell','dumpsys','activity','activities'));assert.equal(report.resources.restoredForeground,foreground,'ORIGINAL_FOREGROUND_NOT_RESTORED');}catch(error){report.resources.errors.push(redactor.clean(error.message));}}
  if(beforeForwards){try{report.resources.afterForwards=await forwards();assertAndroidForwardsRestored(beforeForwards,report.resources.afterForwards);}catch(error){report.resources.errors.push(redactor.clean(error.message));}}
  report.resources.passed=report.resources.errors.length===0;report.basic_passed=report.full_catalog&&report.games.length===ARENA_IDS.length&&report.games.every(g=>g.passed&&g.post_close_drained&&g.cleanup?.passed);report.passed=options.mode==='basic'&&report.basic_passed&&!report.failure&&report.resources.passed;report.finished_at=new Date().toISOString();await save();
 }
 return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const report=await runPlayerAcceptance(playerAcceptanceArguments(process.argv.slice(2)));console.log(JSON.stringify({passed:report.passed,preflight_passed:report.preflight_passed??false,executed:report.executed,mode:report.mode}));if(report.executed&&!report.passed)process.exitCode=1;}
 catch{console.error('PLAYER_ACCEPTANCE_PRECONDITION_FAILED');process.exitCode=1;}
}
