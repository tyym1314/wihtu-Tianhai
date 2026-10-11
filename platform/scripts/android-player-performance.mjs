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
import {installOwnedPlayerResourceEvidence,validateConsumedImageEvidence,deliveryProofForRow} from './android-player-resource-evidence.mjs';
import {visibleFeedbackProtocolReceipt,visibleFeedbackImplementationReceipt,VISIBLE_FEEDBACK_IMPLEMENTATION_SOURCES,readOwnedFeedbackProjection,installOwnedVisibleFeedbackObservation,readOwnedVisibleFeedbackObservation,createVisibleFeedbackCollector,analyzeVisibleRunFeedback} from './android-player-visible-feedback.mjs';
import {ARENA_FEEDBACK_CONFIGS,arenaFeedbackPlan,readArenaFeedbackPresentation,installOwnedArenaFeedbackObservation,readOwnedArenaFeedbackObservation,renderArenaFeedbackGlyphTemplate,analyzeVisibleArenaFeedback} from './android-player-arena-feedback.mjs';
import {legalMoves as matchLegalMoves} from '../arena/match/engine.mjs';
import {canExercise,activityRoomState} from './mobile-continuous-driver.mjs';
import {waitForPlayable,roomWaitReason} from './mobile-quality-metrics.mjs';
import {waitForPerformanceLobbyWallet,preparePerformanceLobbyForEntry} from './android-player-performance-lobby-readiness.mjs';
import {ANDROID_PERFORMANCE_SCHEMA,performanceArguments,physicalAdbArgs,parseWebViewProvider,parseThermal,parseRefresh,assertGameContext,authorityCursor,assertPerformanceRoom,activeMotionState,acceptedPerformanceAction,installPhysicalProbe,verifyProbe,pixelDifference,cacheSchedule,assertCachePosture,evaluateAndroidPerformance,runtimeSourcePins,finalizePerformanceStatus,hash} from './android-player-performance-checks.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url)),execute=promisify(execFile),require=createRequire(import.meta.url);
const standards=JSON.parse(await readFile(join(ROOT,'specs/mobile-quality-v1.json'),'utf8'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(predicate,label,timeout=45000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(100);}throw Error(label+'_TIMEOUT');};
const sourceFiles=['scripts/android-player-performance.mjs','scripts/android-player-performance-lobby-readiness.mjs','scripts/android-player-lobby-wallet-readiness.mjs','scripts/android-player-visible-feedback.mjs','scripts/android-player-arena-feedback.mjs','scripts/android-player-resource-evidence.mjs','scripts/android-player-performance-checks.mjs','scripts/android-player-acceptance.mjs','scripts/android-player-acceptance-checks.mjs','scripts/android-webview-checks.mjs','scripts/android-game-actions.mjs','scripts/mobile-quality-metrics.mjs','scripts/mobile-continuous-driver.mjs','deploy/native-browser-checks.mjs','specs/mobile-quality-v1.json'];
const sceneSelectors={run:'.run-scene canvas',towerlink:'.towerlink-game canvas',golf:'.og-game canvas',bowling:'.bowling-game canvas',carrom:'.oc-game canvas',pool:'.op-game canvas',darts:'.da-board',match:'.match-cells',ludo:'.ludo-board',jackaroo:'.jack-board',domino:'.do-chain'};

/** Collector observation times only. Never infer the first product-ready instant
 * or subtract instrumentation from the existing entry values/gates. */
export function createPerformanceLoadTimeline({roundId,game,nonce,entryUrl,startEpochMs}){
 assert.ok(typeof roundId==='string'&&roundId.length>0&&roundId.length<=128&&ARENA_IDS.includes(game),'LOAD_TIMELINE_ROUND_REQUIRED');
 assert.ok(typeof nonce==='string'&&nonce.length>0&&nonce.length<=128&&Number.isFinite(startEpochMs),'LOAD_TIMELINE_CLOCK_REQUIRED');
 const entry=new URL(entryUrl);assert.equal(entry.protocol,'https:','LOAD_TIMELINE_REAL_PLAYER_REQUIRED');
 return {schema:'owned-performance-load-timeline-v1',scope:{roundId,game,nonce,entryUrl,gameUrl:entry.origin+'/play/'+game},startEpochMs,
  clockSource:'Collector host Date.now epoch; trusted events retain their original document performance.timeOrigin and performance.now separately',
  productFirstConditionTimeProven:false,limits:{nativeTaps:64,reasonTransitions:128},nativeTaps:[],nativeTapsOmitted:0,
  readiness:{observationCount:0,reasonTransitions:[],reasonTransitionsOmitted:0,lastReasonObservation:null,
   reasonSource:'Existing waitForPlayable readRoom callback, after that loop DOM read; retained authorized room snapshots, not first condition-satisfaction times'}};
}

/** Record only this entry's existing receipts. No extra realm read or input. */
export function recordPerformanceLoadNativeTap(timeline,receipt){
 assert.equal(timeline?.schema,'owned-performance-load-timeline-v1');assert.equal(receipt.roundId,timeline.scope.roundId,'LOAD_TIMELINE_FOREIGN_TAP');assert.equal(receipt.measurementPhase,'entry','LOAD_TIMELINE_NON_ENTRY_TAP');
 const original=receipt.trustedReceipt,installation=receipt.installation,url=original?.url??installation?.url??null;
 if(url!==null)assert.ok(url===timeline.scope.entryUrl||url===timeline.scope.gameUrl,'LOAD_TIMELINE_FOREIGN_DOCUMENT');
 const scope=receipt.performanceScope;if(scope){assert.equal(scope.nonce,timeline.scope.nonce,'LOAD_TIMELINE_FOREIGN_PROBE');assert.equal(scope.url,timeline.scope.gameUrl);if(timeline.gameDocument){assert.equal(scope.documentId,timeline.gameDocument.documentId);assert.equal(scope.timeOrigin,timeline.gameDocument.timeOrigin);assert.equal(scope.frameId,timeline.gameDocument.frameId);}}
 const timeOrigin=original?.documentTimeOrigin??installation?.documentTimeOrigin??null;
 if(scope&&Number.isFinite(timeOrigin))assert.equal(timeOrigin,scope.timeOrigin,'LOAD_TIMELINE_EVENT_CLOCK_CHANGED');
 const clock=value=>Number.isFinite(value)?value:null,events=(original?.events??[]).slice(0,8).map(event=>({type:event.type,isTrusted:event.isTrusted===true,at:clock(event.at),epochMs:Number.isFinite(timeOrigin)&&Number.isFinite(event.at)?timeOrigin+event.at:null,domObservationAvailable:!!event.dom,domObservationError:!!event.observationError}));
 const row={sequence:receipt.sequence,nativeRole:receipt.nativeRole??null,preparationStartedAtEpochMs:clock(receipt.nativeTiming?.preparationStartedAtEpochMs),preparationCompletedAtEpochMs:clock(receipt.nativeTiming?.preparationCompletedAtEpochMs),
  commandDispatchedAtEpochMs:clock(receipt.nativeTiming?.commandDispatchedAtEpochMs),commandCompletedAtEpochMs:clock(receipt.nativeTiming?.commandCompletedAtEpochMs),commandOutcome:receipt.nativeTiming?.commandOutcome??'not-sent',
  trustedReceiptReadAtEpochMs:clock(receipt.nativeTiming?.trustedReceiptReadAtEpochMs),finishedAtEpochMs:clock(receipt.nativeTiming?.finishedAtEpochMs),completed:receipt.completed===true,nativeNotSentReason:receipt.nativeNotSentReason??null,
  document:{url,timeOrigin:clock(timeOrigin),performanceScope:scope?{nonce:scope.nonce,documentId:scope.documentId,timeOrigin:scope.timeOrigin,url:scope.url,frameId:scope.frameId}:null},events,eventOverflow:original?.overflow===true,eventsOmitted:Math.max(0,(original?.events?.length??0)-8),
  eventSource:'Original receipt events only; epochMs is original document timeOrigin + event at, never a collector-host estimate'};
 if(timeline.nativeTaps.length<timeline.limits.nativeTaps)timeline.nativeTaps.push(row);else timeline.nativeTapsOmitted++;
 return row;
}

/** Same readiness/drain/verification sequence and entry arithmetic as before.
 * Failed phases retain their times and rethrow the original error. */
export async function capturePerformanceEntryTiming({round,collector,frame,game,state,waitPlayable=waitForPlayable,now=Date.now}){
 const timeline=round.loadTimeline;assert.equal(timeline?.schema,'owned-performance-load-timeline-v1');assert.equal(timeline.scope.roundId,round.id);assert.equal(timeline.scope.game,game);
 assert.equal(timeline.gameDocument?.documentId,round.documentId,'LOAD_TIMELINE_DOCUMENT_CHANGED');assert.equal(timeline.gameDocument?.timeOrigin,round.documentTimeOrigin,'LOAD_TIMELINE_CLOCK_CHANGED');
 const phase=async(key,operation)=>{const row=key==='waitForPlayable'?timeline.readiness:timeline[key]={};row.startedAtEpochMs=now();row.outcome='pending';try{const value=await operation();row.returnedAtEpochMs=now();row.outcome='returned';return value;}catch(error){row.failedAtEpochMs=now();row.outcome='failed';row.errorCode=typeof error.code==='string'?error.code.slice(0,128):null;throw error;}};
 const ready=await phase('waitForPlayable',()=>waitPlayable(frame,game,{pendingStatic:()=>collector.pendingStatic(),readRoom:()=>{
  const room=state.room;assert.equal(hash(room?.id),round.roomIdHash,'LOAD_TIMELINE_ROOM_CHANGED');assert.equal(room.game_id,game,'LOAD_TIMELINE_GAME_CHANGED');
  const observation={observedAtEpochMs:now(),reason:roomWaitReason(game,room),roomVersion:Number.isFinite(room.version)?room.version:null,serverNowEpochMs:Number.isFinite(room.server_now)?room.server_now:null},readiness=timeline.readiness;
  readiness.observationCount++;if(!readiness.lastReasonObservation||observation.reason!==readiness.lastReasonObservation.reason){if(readiness.reasonTransitions.length<timeline.limits.reasonTransitions)readiness.reasonTransitions.push(observation);else readiness.reasonTransitionsOmitted++;}readiness.lastReasonObservation=observation;return room;
 }}));
 const actualPlayableAt=timeline.readiness.returnedAtEpochMs;timeline.actualPlayableAtEpochMs=actualPlayableAt;
 timeline.readiness.returnedObservation={source:'Last DOM observation returned by existing waitForPlayable, before its final two RAF; no first-satisfied instant is inferred',
  documentTimeOrigin:ready.time_origin,documentClockMatchesBoundGame:ready.time_origin===round.documentTimeOrigin,observedAtRealmMs:ready.at,observedAtEpochMs:Number.isFinite(ready.time_origin)&&Number.isFinite(ready.at)?ready.time_origin+ready.at:null,
  reportedSceneReadyAtRealmMs:ready.scene_ready_at,ready:ready.ready,sceneReady:ready.scene_ready,enabledControl:ready.enabled_control,pendingStaticAtReturn:collector.pendingStatic(),
  excludedTurnWaitMs:ready.turn_wait_ms,excludedOtherReadyMs:ready.other_player_ready_wait_ms,rulesCountdownMs:ready.rules_countdown_ms};
 await phase('drain',()=>collector.drain());await phase('verifyResourceEvidence',()=>collector.verifyResourceEvidence({freeze:true}));
 const evidenceReadyAt=timeline.verifyResourceEvidence.returnedAtEpochMs,start=timeline.startEpochMs;timeline.evidenceReadyAtEpochMs=evidenceReadyAt;
 round.entry={ready:ready.ready,elapsedMs:evidenceReadyAt-start-ready.turn_wait_ms-ready.other_player_ready_wait_ms,wallMs:evidenceReadyAt-start,actualPlayableMs:actualPlayableAt-start-ready.turn_wait_ms-ready.other_player_ready_wait_ms,actualPlayableWallMs:actualPlayableAt-start,evidenceReadyMs:evidenceReadyAt-start,evidenceCollectionAfterPlayableMs:evidenceReadyAt-actualPlayableAt,measurement:'Actual playable boundary precedes evidence drain; both include loading instrumentation. Existing strict gate retains elapsedMs including evidence verification.',excludedTurnWaitMs:ready.turn_wait_ms,excludedOtherReadyMs:ready.other_player_ready_wait_ms,scene:ready};
 return ready;
}

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
 const{state,result,observer,collector,round,nativeTaps=[]}=active;round.observerErrors??=[];
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
 round.actions=collector?.actions||[];round.observerErrors.push(...(result.observer_errors||[]).map(error=>error.message),...(!round.nativeObserverPassed?['NATIVE_FUNCTIONAL_OBSERVATIONS_FAILED']:[]));
 try{await collector?.close();}catch(error){observationError('CDP_CLOSE',error);}round.network=collector?.summary();round.observerErrors.push(...(collector?.errors||[]));
 try{observer.detach();}catch(error){observationError('NATIVE_DETACH',error);}
 if(round.sampleBoundaries?.start||round.visibleFeedbackPhases?.length)partitionPerformanceRoundActions(round);
 round.nativeTapOutcomes=classifyOwnedNativeTapOutcomes({receipts:nativeTaps,requests:collector?.actionRequestDiagnostics?.()??[],actions:round.allObservedActions??round.actions,observationStage:'After original network drain and own cleanup'});
 return round.cleanup;
}

/** Only the collector's already-bound default game realm may answer this read.
 * No controller access, network request, input or application mutation. */
export function ownedPerformanceFailureDOM({expectedUrl,nonce,documentId}){
 const p=globalThis.__oasisPhysicalPerf;
 if(location.href!==expectedUrl||p?.schema!=='android-physical-performance-v1'||p.url!==expectedUrl||p.nonce!==nonce||p.documentId!==documentId||p.timeOrigin!==performance.timeOrigin)throw Error('FAILED_ROUND_DOM_DOCUMENT_UNPROVEN');
 const attributes=['inputReady','ready','rendered','modelsReady','backgroundReady','environmentReady','renderQuality','presentationModel','practiceProfile','practiceMode','authorityExpired','clockEpoch','revision','provisionalTick','tick','clip','cinematic','inputFeedbackState','inputFeedbackType','inputFeedbackAt'];
 const describe=element=>element?{tag:element.tagName,testId:element.getAttribute('data-testid'),disabled:element.disabled===true,ariaDisabled:element.getAttribute('aria-disabled'),ariaBusy:element.getAttribute('aria-busy'),data:Object.fromEntries(attributes.filter(key=>Object.hasOwn(element.dataset,key)).map(key=>[key,String(element.dataset[key]).slice(0,128)]))}:null;
 const controls=[...document.querySelectorAll('button[data-testid]')].slice(0,32).map(describe),statuses=[...document.querySelectorAll('[role="status"]')].slice(0,16).map(element=>(element.textContent||'').trim().slice(0,256));
 return {schema:'owned-performance-failure-dom-v1',owner:{nonce:p.nonce,documentId:p.documentId,timeOrigin:p.timeOrigin,url:p.url},at:performance.now(),visibility:document.visibilityState,focused:document.hasFocus(),scene:describe(document.querySelector('[data-testid="run-scene"]')),track:describe(document.querySelector('[data-testid="run-track"]')),canvasCount:document.querySelectorAll('canvas').length,controls,statuses,loadingCount:document.querySelectorAll('[data-testid="run-loading"],[data-testid="run-start-overlay"]').length,dialogCount:document.querySelectorAll('[role="dialog"]').length};
}

export function failureAuthority(state,{game,baseline}){
 assertOwnedPlayerArenaState(state,baseline);assertPerformanceRoom(state.room,{game,baseline,ownedRooms:state.ownedRooms});
 const room=state.room,g=room.game,waitingWithoutGame=room.status==='waiting'&&g===null;
 assert.ok(waitingWithoutGame||g&&typeof g==='object'&&!Array.isArray(g),'FAILED_ROUND_ENGINE_AUTHORITY_REQUIRED');
 const own=waitingWithoutGame?null:g.me&&typeof g.me==='object'?g.me:g.players?.find?.(player=>player.key===room.me),inputs=room.run_inputs;
 const scalar=(source,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(source||{},key)).map(key=>{const value=source[key];assert.ok(value===null||['number','boolean','string'].includes(typeof value),'FAILED_ROUND_AUTHORITY_NONSCALAR');return[key,value];}));
 return {schema:'owned-performance-failure-authority-v1',source:'Latest retained original authorized room reply; no additional request or mutation',authoritySha256:hash(JSON.stringify(room)),roomIdHash:hash(room.id),playerKeyHash:hash(room.me),sessionIdHash:hash(state.sessionId),room:scalar(room,['status','version','server_now','me_last_seq','practice','entry_minor']),game:waitingWithoutGame?null:scalar(g,['status','phase','ruleVersion','snapshotTick','startedAt','serverNow','deadlineAt']),own:waitingWithoutGame?null:scalar(own,['inputNo','appliedInputNo','lastInputTick','jumpStartTick','slideUntilTick','stunUntilTick','fallStartTick','fallUntilTick','finishTick','forfeited','distanceU','distance','checkpointU','checkpoint']),runInputs:inputs?scalar(inputs,['protocol','profileId','ruleVersion','clockEpoch','revision','headTick','serverTick','committedThroughTick','processedThroughCommandSeq','acceptedInputNo']):null};
}

export const INITIAL_PROBE_FAILURE_LIMITS=Object.freeze({rawProbeBytes:256*1024,inspectedFrames:250000,invalidRows:16,adjacentRows:48,adjacentRowBytes:4096});

/** Serialize the original CDP return, never a replacement realm read. JSON byte
 * prefixes are explicitly incomplete; field types retain JSON-lossy values. */
function initialProbeFailureEvidence(probe){
 const limits=INITIAL_PROBE_FAILURE_LIMITS,type=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
 const raw=(value,limit)=>{const json=JSON.stringify(value);if(json===undefined)return {type:type(value),serialization:'undefined',complete:false,bytes:0,retainedBytes:0,omittedBytes:0};const bytes=Buffer.from(json),retained=bytes.subarray(0,limit);return {type:type(value),serialization:bytes.length<=limit?'complete-json':'json-byte-prefix-base64',complete:bytes.length<=limit,bytes:bytes.length,sha256:hash(bytes),retainedBytes:retained.length,omittedBytes:bytes.length-retained.length,...(bytes.length<=limit?{json}:{base64:retained.toString('base64')})};};
 const frames=probe?.frames,inspected=Array.isArray(frames)?Math.min(frames.length,limits.inspectedFrames):0,invalidRows=[],adjacent=new Set();let invalidCount=0;
 for(let index=0;index<inspected;index++){
  const row=frames[index],fields={at:row?.at,ms:row?.ms,visible:row?.visible,active:row?.active,moving:row?.moving},invalidFields=[];
  for(const key of ['at','ms'])if(typeof fields[key]!=='number'||!Number.isFinite(fields[key]))invalidFields.push(key+':not-finite-number');
  if(typeof fields.ms==='number'&&Number.isFinite(fields.ms)){if(fields.ms<=0)invalidFields.push('ms:not-positive');if(fields.ms>900000)invalidFields.push('ms:above-900000');}
  for(const key of ['visible','active','moving'])if(typeof fields[key]!=='boolean')invalidFields.push(key+':not-boolean');
  if(!invalidFields.length)continue;invalidCount++;
  if(invalidRows.length<limits.invalidRows){invalidRows.push({index,rowType:type(row),fieldTypes:Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,type(value)])),nonfiniteNumbers:Object.fromEntries(Object.entries(fields).filter(([,value])=>typeof value==='number'&&!Number.isFinite(value)).map(([key,value])=>[key,String(value)])),invalidFields});for(let near=Math.max(0,index-1);near<=Math.min(frames.length-1,index+1);near++)adjacent.add(near);}
 }
 return {schema:'owned-initial-probe-failure-evidence-v1',source:'Same initial CDP Runtime.evaluate return rejected by unchanged verifyProbe; no additional read, filtering or correction',limits,rawProbe:raw(probe,limits.rawProbeBytes),framesType:type(frames),frameCount:Array.isArray(frames)?frames.length:null,inspectedFrames:inspected,uninspectedFrames:Array.isArray(frames)?frames.length-inspected:null,invalidRowsDetectedInInspectedFrames:invalidCount,invalidRowsOmitted:invalidCount-invalidRows.length,invalidRows,adjacentRows:[...adjacent].sort((a,b)=>a-b).map(index=>({index,raw:raw(frames[index],limits.adjacentRowBytes)}))};
}

/** A bound frame/default realm is evidence, but does not authorize an unverified
 * probe document ID. The caller sets its original verified scope only on return. */
export async function readInitialPerformanceProbe({collector,round,origin,game,nonce}){
 const binding=await collector.bind(),observation=round.initialProbeValidation={schema:'owned-initial-probe-validation-v1',binding:{...binding},bindingSource:'Original first collector.bind result before probe validation; frame/default-realm identity only',probeIdentityVerified:false};
 const probe=await collector.evaluate('(()=>globalThis.__oasisPhysicalPerf)()');
 try{verifyProbe(probe,{origin,game,nonce});}catch(error){observation.validationError={message:String(error.message).slice(0,256),code:error.code??null};try{observation.failureEvidence=initialProbeFailureEvidence(probe);}catch(failure){observation.evidenceError=String(failure.message).slice(0,256);}throw error;}
 observation.probeIdentityVerified=true;return probe;
}

/** Preserve the original failure before cleanup can destroy the observed realm.
 * Each exact-realm read is bounded; unavailable evidence stays explicit. */
export async function capturePerformanceRoundFailure({round,error,collector,state,baseline,origin,game,nonce,nativeTaps=[],timeoutMs=1500,clean=String,now=Date.now}){
 assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=1500,'BOUNDED_FAILED_ROUND_OBSERVATION_REQUIRED');round.observerErrors??=[];round.error??=clean(error.message);
 const observation={schema:'owned-performance-round-failure-v1',observedAt:new Date(now()).toISOString(),stage:'Before UI stop and original-session cleanup',error:round.error,code:error.code??null,nativeInputSent:error.nativeInputSent??null};round.failureObservation=observation;
 if(round.sampleStartedAt&&!round.sampleBoundaries?.end)round.sampleWallMs=Math.max(0,now()-Date.parse(round.sampleStartedAt));
 try{observation.authorityBeforeDOM=failureAuthority(state,{game,baseline});}catch(failure){observation.authorityError=clean(failure.message);}
 const bounded=async operation=>{let timer;try{return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('FAILED_ROUND_OBSERVATION_TIMEOUT')),timeoutMs);})]);}finally{clearTimeout(timer);}};
 if(collector&&round.documentId){
  try{const snapshot=await bounded(()=>collector.evaluate('(()=>{('+ownedPerformanceFailureDOM.toString()+')('+JSON.stringify({expectedUrl:origin+'/play/'+game,nonce,documentId:round.documentId})+');const p=globalThis.__oasisPhysicalPerf;if(!Number.isFinite(p.sampleEndAt))p.sampleEndAt=performance.now();p.stop();return p;})()'));verifyProbe(snapshot,{origin,game,nonce,documentId:round.documentId});round.probe=snapshot;round.probePreservedAfterFailure=true;}catch(failure){observation.probeError=clean(failure.message);round.observerErrors.push('FAILED_ROUND_PROBE: '+observation.probeError);}
  try{const dom=await bounded(()=>collector.evaluate('('+ownedPerformanceFailureDOM.toString()+')('+JSON.stringify({expectedUrl:origin+'/play/'+game,nonce,documentId:round.documentId})+')'));assert.equal(dom?.schema,'owned-performance-failure-dom-v1','FAILED_ROUND_DOM_EVIDENCE_REQUIRED');const timeOrigin=round.documentTimeOrigin??round.probe?.timeOrigin;assert.ok(Number.isFinite(timeOrigin),'FAILED_ROUND_DOM_CLOCK_UNPROVEN');assert.deepEqual(dom.owner,{nonce,documentId:round.documentId,timeOrigin,url:origin+'/play/'+game},'FAILED_ROUND_DOM_IDENTITY_CHANGED');assert.ok(Number.isFinite(dom.at),'FAILED_ROUND_DOM_CLOCK_UNPROVEN');observation.dom=dom;}catch(failure){observation.domError=clean(failure.message);round.observerErrors.push('FAILED_ROUND_DOM: '+observation.domError);}
 }else{observation.probeError='No previously bound owned game document';observation.domError='No previously bound owned game document';}
 try{observation.authorityAfterDOM=failureAuthority(state,{game,baseline});}catch(failure){observation.authorityAfterDOMError=clean(failure.message);}
 observation.nativeTapOutcomes=classifyOwnedNativeTapOutcomes({receipts:nativeTaps,requests:collector?.actionRequestDiagnostics?.()??[],actions:collector?.actions??[],observationStage:'At original round failure before UI stop'});
 return observation;
}

/** A failed round ends this run even after successful own cleanup. */
export function assertPerformanceRoundContinuation(round){
 if(round.error)throw Object.assign(Error(round.error),{code:round.failureObservation?.code??'PERFORMANCE_ROUND_FAILED'});
 assert.equal(round.cleanup?.passed,true,'OWNED_ROOM_CLEANUP_FAILED');
}

export async function ownedContinuousSampleBoundary({stage,expectedUrl,nonce,documentId,motion},readDOM){
 if(!['start','end'].includes(stage))throw Error('CONTINUOUS_SAMPLE_BOUNDARY_INVALID');readDOM({expectedUrl,nonce,documentId});
 return await new Promise((resolve,reject)=>requestAnimationFrame(at=>{try{
  const dom=readDOM({expectedUrl,nonce,documentId}),p=globalThis.__oasisPhysicalPerf;
  if(stage==='start'){if(Number.isFinite(p.sampleStartAt))throw Error('CONTINUOUS_SAMPLE_ALREADY_STARTED');p.sampleStartAt=at;p.active=motion.active;p.moving=motion.moving;p.validUntil=performance.now()+500;}
  else{if(!Number.isFinite(p.sampleStartAt)||at<=p.sampleStartAt)throw Error('CONTINUOUS_SAMPLE_NOT_STARTED');if(Number.isFinite(p.sampleEndAt))throw Error('CONTINUOUS_SAMPLE_ALREADY_ENDED');p.sampleEndAt=at;p.stop();}
  resolve({schema:'owned-continuous-sample-boundary-v1',stage,at,epochMs:p.timeOrigin+at,owner:dom.owner,dom,motion,probe:stage==='end'?p:null});
 }catch(error){reject(error);}}));
}

async function continuousSampleBoundary({stage,round,collector,state,baseline,origin,game,nonce,motion}){
 const authorityBefore=failureAuthority(state,{game,baseline}),args={stage,expectedUrl:origin+'/play/'+game,nonce,documentId:round.documentId,motion};let timer,value;
 try{value=await Promise.race([collector.evaluate('('+ownedContinuousSampleBoundary.toString()+')('+JSON.stringify(args)+','+ownedPerformanceFailureDOM.toString()+')'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CONTINUOUS_SAMPLE_BOUNDARY_TIMEOUT')),1500);})]);}finally{clearTimeout(timer);}
 assert.equal(value?.schema,'owned-continuous-sample-boundary-v1');assert.equal(value.stage,stage);assert.deepEqual(value.owner,{nonce,documentId:round.documentId,timeOrigin:round.documentTimeOrigin,url:args.expectedUrl},'CONTINUOUS_SAMPLE_OWNER_CHANGED');assert.ok(Number.isFinite(value.at)&&value.epochMs===value.owner.timeOrigin+value.at,'CONTINUOUS_SAMPLE_CLOCK_UNPROVEN');
 round.sampleBoundaries??={};round.sampleBoundaries[stage]={...value,probe:undefined,authorityBefore,authorityAfter:failureAuthority(state,{game,baseline}),source:'Exact same-document RAF callback; raw intervals retained without deletion or adjustment'};
 round.measurementPhase=stage==='start'?'continuous':'after';if(stage==='start')round.sampleStartedAt=new Date(value.epochMs).toISOString();else{verifyProbe(value.probe,{origin,game,nonce,documentId:round.documentId});round.probe=value.probe;round.sampleWallMs=value.epochMs-round.sampleBoundaries.start.epochMs;}
 return value;
}

/** Separate full RAF observations for the screenshot proof phase. They never
 * replace or delete the continuous probe's original intervals. */
export function beginOwnedMotionProof({phase,expectedUrl,nonce,documentId},readDOM){
 if(!['before','after','feedbackProof'].includes(phase))throw Error('MOTION_PROOF_PHASE_INVALID');const dom=readDOM({expectedUrl,nonce,documentId});
 if(Object.hasOwn(globalThis,'__oasisOwnedMotionProof'))throw Error('MOTION_PROOF_ALREADY_INSTALLED');let raf,last=null;const proof={schema:'owned-motion-proof-intervals-v1',phase,owner:dom.owner,startAt:performance.now(),endAt:null,frames:[],dropped:0,closed:false};
 const frame=at=>{if(last!==null){if(proof.frames.length<8192)proof.frames.push({at,ms:at-last,visible:document.visibilityState==='visible'});else proof.dropped++;}last=at;raf=requestAnimationFrame(frame);};raf=requestAnimationFrame(frame);
 Object.defineProperty(globalThis,'__oasisOwnedMotionProof',{configurable:true,value:{stop(){readDOM({expectedUrl,nonce,documentId});cancelAnimationFrame(raf);proof.endAt=performance.now();proof.closed=true;delete globalThis.__oasisOwnedMotionProof;return proof;}}});return {...proof,frames:undefined};
}

export async function capturePerformanceMotionPhase({phase,round,collector,target,decode,writePair,readMotion,readAuthority,origin,game,nonce,wait=sleep,now=Date.now}){
 assert.ok(['before','after'].includes(phase),'MOTION_PROOF_PHASE_INVALID');assert.ok(round.measurementPhase!=='continuous','SCREENSHOT_DURING_CONTINUOUS_SAMPLE_REFUSED');assert.ok(phase==='before'?!round.sampleBoundaries?.start:!!round.sampleBoundaries?.end,'MOTION_PROOF_SAMPLE_BOUNDARY_REQUIRED');
 const args={phase,expectedUrl:origin+'/play/'+game,nonce,documentId:round.documentId},entry={phase,startedAt:new Date(now()).toISOString(),authorityBefore:readAuthority(),pairs:[]};round.motion.proofPhases??=[];round.motion.proofPhases.push(entry);let installed=false,firstError;
 const evaluate=async expression=>{let timer;try{return await Promise.race([collector.evaluate(expression),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('MOTION_PROOF_OBSERVATION_TIMEOUT')),1500);})]);}finally{clearTimeout(timer);}};
 try{
  await evaluate('('+beginOwnedMotionProof.toString()+')('+JSON.stringify(args)+','+ownedPerformanceFailureDOM.toString()+')');installed=true;
  if(!await target.count()||!await target.isVisible())entry.unavailable='Exact render surface is absent or hidden';
  else for(let i=0;i<(phase==='before'?2:1);i++){
   const before=readMotion(),startEpochMs=now(),a=await target.screenshot({type:'png',timeout:5000}),firstCapturedEpochMs=now();await wait(160);const b=await target.screenshot({type:'png',timeout:5000}),endEpochMs=now(),after=readMotion();
   const pair={...pixelDifference(decode(a),decode(b)),phase,startEpochMs,endEpochMs,firstCapturedEpochMs,authorityMovingBefore:before.moving,authorityMovingAfter:after.moving};if(!before.moving||!after.moving)pair.moved=false;
   entry.pairs.push(pair);round.motion.pairs.push(pair);await writePair(round.motion.pairs.length,a,b);
  }
 }catch(error){entry.captureError=error.message;firstError=error;}
 if(installed)try{entry.probe=await evaluate('globalThis.__oasisOwnedMotionProof.stop()');assert.equal(entry.probe.closed,true);assert.equal(entry.probe.phase,phase);assert.equal(entry.probe.dropped,0,'MOTION_PROOF_INTERVALS_DROPPED');assert.ok(Array.isArray(entry.probe.frames)&&entry.probe.frames.every(frame=>Number.isFinite(frame.at)&&Number.isFinite(frame.ms)&&frame.ms>0&&typeof frame.visible==='boolean'),'MOTION_PROOF_INTERVALS_INVALID');assert.deepEqual(entry.probe.owner,{nonce,documentId:round.documentId,timeOrigin:round.documentTimeOrigin,url:args.expectedUrl},'MOTION_PROOF_OWNER_CHANGED');}catch(error){entry.probeError=error.message;firstError??=error;}
 try{entry.authorityAfter=readAuthority();}catch(error){entry.authorityAfterError=error.message;firstError??=error;}entry.finishedAt=new Date(now()).toISOString();
 if(firstError)throw firstError;return entry;
}

export function partitionPerformanceRoundActions(round){
 const all=round.allObservedActions??round.actions??[],start=round.sampleBoundaries?.start?.epochMs,end=round.sampleBoundaries?.end?.epochMs??(round.probe?.timeOrigin+round.probe?.sampleEndAt),phases={before:[],feedbackProof:[],continuous:[],after:[],boundary:[],unproven:[]};
 for(const action of all){const{gestureCompletedEpochMs:g,requestStartedEpochMs:r,responseFinishedEpochMs:f}=action;let phase='unproven';const feedback=round.visibleFeedbackPhases?.find(p=>p.capture?.before&&p.capture?.after&&p.capture.scope&&[g,r,f].every(Number.isFinite)&&g<=r&&r<=f&&g>=p.capture.scope.timeOrigin+p.capture.before.at&&f<=p.capture.scope.timeOrigin+p.capture.after.at);if(feedback)phase='feedbackProof';else if([g,r,f,start,end].every(Number.isFinite)&&g<=r&&r<=f){if(f<=start)phase='before';else if(g>=end)phase='after';else if(g>=start&&f<=end)phase='continuous';else phase='boundary';}phases[phase].push(action);}
 round.allObservedActions=all;round.actionPhases=phases;round.actions=phases.continuous;return phases;
}

/** Exact original default-realm binding, never an iframe selected by title. */
export function visibleFeedbackScopeForRound({tree,context,round,origin,nonce,topUrl,arenaPlan=null}){
 if(round.game==='run')assert.equal(arenaPlan,null,'VISIBLE_FEEDBACK_RUN_PLAN_CHANGED');else{assert.ok(ARENA_FEEDBACK_CONFIGS[round.game],'VISIBLE_FEEDBACK_GAME_UNSUPPORTED');assert.deepEqual(arenaPlan,arenaFeedbackPlan(arenaPlan),'VISIBLE_FEEDBACK_EXPLICIT_ARENA_PLAN_REQUIRED');assert.equal(arenaPlan.game,round.game,'VISIBLE_FEEDBACK_GAME_CHANGED');}
 assert.ok(round.documentId&&Number.isFinite(round.documentTimeOrigin),'VISIBLE_FEEDBACK_ROUND_OWNER_REQUIRED');assert.ok(context&&context.frameId===round.context?.frameId&&context.contextId===round.context.contextId&&context.url===origin+'/play/'+round.game,'VISIBLE_FEEDBACK_DEFAULT_REALM_CHANGED');
 const rows=(tree.childFrames??[]).filter(row=>row.frame.url===context.url);assert.equal(rows.length,1,'VISIBLE_FEEDBACK_EXACT_GAME_FRAME_REQUIRED');const f=rows[0].frame;assert.equal(f.id,context.frameId);assert.equal(f.parentId,tree.frame.id);assert.equal(tree.frame.url,topUrl);assert.ok(f.loaderId&&tree.frame.loaderId,'VISIBLE_FEEDBACK_LOADER_REQUIRED');
 return {nonce,documentId:round.documentId,timeOrigin:round.documentTimeOrigin,url:context.url,frameId:f.id,loaderId:f.loaderId,contextId:context.contextId,topFrameId:tree.frame.id,topLoaderId:tree.frame.loaderId,topUrl};
}

/** Read the actual final UI target. These selectors identify submission only;
 * the existing game driver remains responsible for legal cards/pawns/routes. */
export function arenaFeedbackPlanForInput({game,kind,descriptor={},room,locale='zh'}){
 assert.ok(ARENA_FEEDBACK_CONFIGS[game],'VISIBLE_FEEDBACK_GAME_UNSUPPORTED');
 assert.ok(room?.game_id===game&&room.id&&room.status==='active'&&room.game&&typeof room.me==='string'&&Number.isSafeInteger(room.me_last_seq),'ARENA_FEEDBACK_OWN_ACTIVE_ROOM_REQUIRED');
 let actionType,end,cell;const id=descriptor.testId,action=descriptor.action;
 if(kind==='drag')actionType=game==='darts'?'throw':game==='towerlink'?'link':null;
 else if(kind==='tap'){
  if(id&&{golf:'golf-shoot',bowling:'bowling-roll',carrom:'carrom-shoot',pool:'pool-shoot'}[game]===id)actionType=game==='bowling'?'roll':'shot';
  else if(game==='ludo'&&['ludo-roll','ludo-move'].includes(action))actionType=action==='ludo-roll'?'roll':'move';
  else if(game==='jackaroo'&&action==='jack-confirm')actionType=room.game.phase==='exchange'?'pass':descriptor.effect==='discard'?'discard':'play';
  else if(game==='domino'&&['domino-left','domino-right','domino-draw','domino-pass'].includes(id)){actionType=['domino-draw','domino-pass'].includes(id)?id.slice(7):'play';if(actionType==='play')end=id.slice(7);}
  else if(game==='match'&&Number.isSafeInteger(descriptor.cell)&&Number.isSafeInteger(descriptor.selectedCell)&&matchLegalMoves(room.game.board??[]).some(a=>a.from===descriptor.selectedCell&&a.to===descriptor.cell)){actionType='swap';cell=descriptor.cell;}
  else if(game==='towerlink'&&['tower-stop','tower-upgrade-confirm'].includes(action))actionType=action==='tower-stop'?'stop':'upgrade';
 }
 return actionType?arenaFeedbackPlan({game,actionType,locale,...(end?{end}:{}),...(cell===undefined?{}:{cell})}):null;
}

/** Wrap the original touch frame without changing input or response bytes.
 * Card/tile/pawn preparation passes through. Capture is armed immediately before
 * the actual submitting tap or drag's first down. The driver still checks ACK. */
export function arenaFeedbackInputFrame({frame,game,readRoom,beforeSubmit,locale='zh'}){
 const originalPage=frame.page(),handlers=new Map();let wrapped,submission=null;
 const submit=async plan=>{if(!plan)return;if(submission)throw Error('ARENA_FEEDBACK_MULTIPLE_SUBMISSIONS');submission=plan;await beforeSubmit(plan);};
 const response=r=>new Proxy(r,{get(target,key){if(key==='request')return()=>new Proxy(target.request(),{get(request,k){if(k==='frame')return()=>request.frame()===frame?wrapped:request.frame();const value=request[k];return typeof value==='function'?value.bind(request):value;}});const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 const mouse=new Proxy(originalPage.mouse,{get(target,key){if(key==='down')return async(...args)=>{await submit(arenaFeedbackPlanForInput({game,kind:'drag',room:readRoom(),locale}));return target.down(...args);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 const page=new Proxy(originalPage,{get(target,key){if(key==='mouse')return mouse;if(key==='on')return(event,handler)=>{const bound=event==='response'?r=>handler(response(r)):handler;handlers.set(handler,bound);target.on(event,bound);return page;};if(key==='off')return(event,handler)=>{target.off(event,handlers.get(handler)||handler);handlers.delete(handler);return page;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 const locator=target=>new Proxy(target,{get(value,key){if(key==='tap')return async(...args)=>{const descriptor=await value.evaluate(el=>{const selected=document.querySelector('.match-cells button[aria-pressed="true"]'),effect=document.querySelector('.jack-effects [data-effect].is-active'),integer=v=>v!==null&&/^\d+$/.test(v)?Number(v):null;return {testId:el.getAttribute('data-testid'),action:el.getAttribute('data-action'),cell:integer(el.getAttribute('data-cell')),selectedCell:integer(selected?.getAttribute('data-cell')??null),effect:effect?.getAttribute('data-effect')??null};});const plan=arenaFeedbackPlanForInput({game,kind:'tap',descriptor,room:readRoom(),locale});if(plan)await value.scrollIntoViewIfNeeded({timeout:1500});await submit(plan);return value.tap(...args);};const member=value[key];return typeof member==='function'?member.bind(value):member;}});
 wrapped=new Proxy(frame,{get(target,key){if(key==='page')return()=>page;if(key==='locator')return(...args)=>locator(target.locator(...args));const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 return {frame:wrapped,get plan(){return submission;},assertClosed(){assert.equal(handlers.size,0,'ARENA_FEEDBACK_DRIVER_LISTENER_NOT_REMOVED');}};
}

async function captureArenaVisibleFeedbackPhase({round,collector,origin,nonce,topUrl,protocol,implementation,webviewVersion,readTop,runAction,arenaFrame,readRoom,locale='zh',drainOriginal,writeFrame,readAuthority,createCapture,wait,now}){
 assert.ok(ARENA_FEEDBACK_CONFIGS[round.game],'VISIBLE_FEEDBACK_GAME_UNSUPPORTED');assert.ok(round.measurementPhase!=='continuous'&&!round.sampleBoundaries?.start,'VISIBLE_FEEDBACK_DURING_CONTINUOUS_REFUSED');
 const phaseId=round.id+'-feedback-1',entry={schema:'owned-performance-visible-feedback-phase-v1',game:round.game,phase:'feedbackProof',phaseId,position:'beforeContinuous',startedAt:new Date(now()).toISOString(),errors:[],finalized:false};round.visibleFeedbackPhases??=[];round.visibleFeedbackPhases.push(entry);
 if(!protocol?.available){entry.analysis=analyzeVisibleArenaFeedback({});entry.analysis.reasons=[protocol?.error??'Exact official screencast protocol bytes were not provided'];entry.finishedAt=new Date(now()).toISOString();return entry;}
 const previousPhase=round.measurementPhase,key='__oasisFeedback_'+randomUUID().replaceAll('-',''),args={phase:'feedbackProof',expectedUrl:origin+'/play/'+round.game,nonce,documentId:round.documentId};let capture,installed=false,probeInstalled=false,actionError,input;
 const evaluate=async expression=>{let timer;try{return await Promise.race([collector.evaluate(expression),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('VISIBLE_FEEDBACK_REALM_TIMEOUT')),1500);})]);}finally{clearTimeout(timer);}};
 try{
  input=arenaFeedbackInputFrame({frame:arenaFrame,game:round.game,readRoom,locale,beforeSubmit:async plan=>{
   entry.plan=plan;round.measurementPhase='feedbackProof';entry.authorityBefore=readAuthority();const {frameTree}=await collector.cdp.send('Page.getFrameTree'),context=await collector.bind();entry.scope=visibleFeedbackScopeForRound({tree:frameTree,context,round,origin,nonce,topUrl,arenaPlan:plan});
   await evaluate('('+beginOwnedMotionProof.toString()+')('+JSON.stringify(args)+','+ownedPerformanceFailureDOM.toString()+')');probeInstalled=true;
   entry.installation=await evaluate('('+installOwnedArenaFeedbackObservation.toString()+')('+JSON.stringify({scope:entry.scope,key,phaseId,plan})+','+readArenaFeedbackPresentation.toString()+')');installed=true;
   capture=await createCapture({session:collector.cdp,scope:entry.scope,arenaPlan:plan,phaseId,protocol:protocol.receipt,implementation:implementation?.receipt??null,webviewVersion,readOwnedState:()=>readTop(readOwnedFeedbackProjection,{scope:entry.scope}),writeFrame});
   const baselineDeadline=now()+1500;while(capture.capture.frames.length<2&&now()<baselineDeadline)await wait(25);assert.ok(capture.capture.frames.length>=2,'VISIBLE_FEEDBACK_BASELINE_FRAMES_UNAVAILABLE');
  }});
  try{
   // Pool may first require its real accepted cue placement or pocket call.
   // Those remain preparation, never the shot's feedback or accepted sequence.
   for(let attempt=0;attempt<3;attempt++){const action=await runAction(input.frame);if(input.plan){entry.uiAction=action;break;}entry.preparatoryUiActions??=[];entry.preparatoryUiActions.push(action);if(round.game!=='pool'||!['place','call'].includes(action.actionType))break;}
   input.assertClosed();
  }catch(error){if(error.capture)entry.capture=error.capture;entry.actionError={message:error.message,code:error.code??null,status:error.status??null,nativeInputSent:error.nativeInputSent??null};actionError=error;}
  if(capture){await wait(200);await drainOriginal();}
 }catch(error){if(error.capture)entry.capture=error.capture;entry.errors.push({stage:'OBSERVATION',message:error.message});}
 finally{
  if(input)try{input.assertClosed();}catch(error){entry.errors.push({stage:'OWN_DRIVER_LISTENERS',message:error.message});}
  if(installed)try{entry.observation=await evaluate('('+readOwnedArenaFeedbackObservation.toString()+')('+JSON.stringify({scope:entry.scope,key,remove:true})+')');}catch(error){entry.errors.push({stage:'OWN_OBSERVER_CLEANUP',message:error.message});}
  if(capture)try{entry.capture=await capture.close();}catch(error){entry.errors.push({stage:'OWN_SCREENCAST_CLEANUP',message:error.message});}
  if(probeInstalled)try{entry.probe=await evaluate('globalThis.__oasisOwnedMotionProof.stop()');assert.equal(entry.probe.phase,'feedbackProof');assert.equal(entry.probe.closed,true);assert.equal(entry.probe.dropped,0);assert.deepEqual(entry.probe.owner,{nonce,documentId:round.documentId,timeOrigin:round.documentTimeOrigin,url:args.expectedUrl});}catch(error){entry.errors.push({stage:'OWN_PROBE_CLEANUP',message:error.message});}
  // Original PNG capture has closed before offscreen comparison preparation.
  if(entry.observation&&entry.capture)try{const first=entry.capture.frames[0],scale=first?.pngBase64?Buffer.from(first.pngBase64,'base64').readUInt32BE(16)/first.metadata.deviceWidth:NaN;for(let i=0;i<entry.observation.presentations.length;i++){const p=entry.observation.presentations[i];if(p.feedback.textRect)entry.observation.presentations[i]=await evaluate('('+renderArenaFeedbackGlyphTemplate.toString()+')('+JSON.stringify({scope:entry.scope,presentation:p,pixelScale:scale})+')');}}catch(error){entry.errors.push({stage:'RETAINED_GLYPH_COMPARISON',message:error.message});}
  try{entry.authorityAfter=readAuthority();}catch(error){entry.errors.push({stage:'ORIGINAL_AUTHORITY',message:error.message});}round.measurementPhase=previousPhase;entry.finishedAt=new Date(now()).toISOString();
 }
 entry.originalRequests=collector.actionRequestDiagnostics?.().filter(r=>r.frameId===entry.scope?.frameId&&entry.capture?.before&&entry.capture?.after&&r.requestStartedEpochMs>=entry.scope.timeOrigin+entry.capture.before.at&&r.requestStartedEpochMs<=entry.scope.timeOrigin+entry.capture.after.at)??[];
 entry.acceptedActions=collector.actions.filter(a=>entry.originalRequests.some(r=>r.requestSha256===a.requestSha256));
 entry.analysis=analyzeVisibleArenaFeedback({plan:entry.plan,capture:entry.capture,observation:entry.observation,actions:entry.acceptedActions,requests:entry.originalRequests});
 entry.finalized=entry.errors.length===0&&entry.capture?.closed===true&&entry.observation?.removed===true&&entry.probe?.closed===true;
 if(!entry.finalized&&entry.analysis.captureStatus==='pass'){entry.analysis.status='insufficient';entry.analysis.captureStatus='insufficient';entry.analysis.passed=false;entry.analysis.reasons.push('Independent phase finalization evidence is incomplete');}
 if(entry.capture)entry.capture={...entry.capture,frames:entry.capture.frames.map(({pngBase64,...row})=>row),rawPngStorage:'All original received PNG bytes saved by indexed sink; byte hashes validated before stripping duplicated inline base64'};
 if(actionError&&!(actionError.code==='ACTION_STATE_CHANGED'&&actionError.nativeInputSent===false))throw actionError;
 return entry;
}

/** Isolated proof: no continuous-clock edits and no authority/controller injection.
 * runAction must use the existing native UI + original accepted response path.
 * All received PNG files remain on disk; report indexes every frame without
 * duplicating their large base64 bodies after the original-byte analysis. */
/** One closure for one Run feedback-proof tap; never an entry/continuous hook.
 * This only chooses when the original PNG capture starts. It grants no input. */
export function createRunFeedbackNativeReadyHook({round,scope,authorityBefore,readAuthority,onReady}){
 assert.equal(round.game,'run','RUN_FEEDBACK_READY_GAME_REQUIRED');assert.equal(round.measurementPhase,'feedbackProof','RUN_FEEDBACK_READY_PHASE_REQUIRED');assert.ok(!round.sampleBoundaries?.start,'RUN_FEEDBACK_READY_CONTINUOUS_REFUSED');
 assert.equal(new URL(scope.url).protocol,'https:','RUN_FEEDBACK_READY_SCOPE_CHANGED');assert.equal(new URL(scope.url).pathname,'/play/run','RUN_FEEDBACK_READY_SCOPE_CHANGED');
 const owner={nonce:scope.nonce,documentId:scope.documentId,timeOrigin:scope.timeOrigin,url:scope.url},performanceScope={...owner,frameId:scope.frameId};let invoked=false,completed=false,closed=false;
 assert.equal(scope.url,round.context.url,'RUN_FEEDBACK_READY_SCOPE_CHANGED');assert.equal(scope.frameId,round.context.frameId,'RUN_FEEDBACK_READY_SCOPE_CHANGED');assert.equal(scope.documentId,round.documentId,'RUN_FEEDBACK_READY_SCOPE_CHANGED');assert.equal(scope.timeOrigin,round.documentTimeOrigin,'RUN_FEEDBACK_READY_SCOPE_CHANGED');
 assert.equal(authorityBefore?.schema,'owned-performance-failure-authority-v1','RUN_FEEDBACK_READY_AUTHORITY_REQUIRED');assert.match(authorityBefore.roomIdHash,/^[a-f0-9]{64}$/,'RUN_FEEDBACK_READY_AUTHORITY_REQUIRED');assert.match(authorityBefore.sessionIdHash,/^[a-f0-9]{64}$/,'RUN_FEEDBACK_READY_AUTHORITY_REQUIRED');assert.ok(typeof readAuthority==='function'&&typeof onReady==='function','RUN_FEEDBACK_READY_CALLBACK_REQUIRED');
 return {async invoke(input){
  assert.equal(closed,false,'RUN_FEEDBACK_READY_CLOSED');assert.equal(invoked,false,'RUN_FEEDBACK_READY_DUPLICATE');invoked=true;
  assert.equal(round.game,'run','RUN_FEEDBACK_READY_GAME_CHANGED');assert.equal(round.measurementPhase,'feedbackProof','RUN_FEEDBACK_READY_PHASE_CHANGED');assert.ok(!round.sampleBoundaries?.start,'RUN_FEEDBACK_READY_CONTINUOUS_REFUSED');
  assert.equal(input?.schema,'owned-run-feedback-native-ready-v1','RUN_FEEDBACK_READY_INPUT_REQUIRED');assert.equal(input.roundId,round.id,'RUN_FEEDBACK_READY_ROUND_CHANGED');assert.equal(input.game,'run','RUN_FEEDBACK_READY_GAME_CHANGED');assert.equal(input.phase,'feedbackProof','RUN_FEEDBACK_READY_PHASE_CHANGED');assert.equal(input.nativeRole,'game-action','RUN_FEEDBACK_READY_ROLE_CHANGED');
  assert.deepEqual(input.performanceScope,performanceScope,'RUN_FEEDBACK_READY_SCOPE_CHANGED');assert.equal(input.dom?.schema,'owned-native-tap-event-dom-v1','RUN_FEEDBACK_READY_DOM_REQUIRED');assert.deepEqual(input.dom.owner,owner,'RUN_FEEDBACK_READY_DOCUMENT_CHANGED');assert.equal(input.dom.control?.testId,'run-jump','RUN_FEEDBACK_READY_CONTROL_CHANGED');
  const authority=readAuthority();assert.equal(authority?.schema,'owned-performance-failure-authority-v1','RUN_FEEDBACK_READY_AUTHORITY_REQUIRED');assert.equal(authority.roomIdHash,authorityBefore.roomIdHash,'RUN_FEEDBACK_READY_ROOM_CHANGED');assert.equal(authority.sessionIdHash,authorityBefore.sessionIdHash,'RUN_FEEDBACK_READY_SESSION_CHANGED');
  await onReady({authority});completed=true;
 },assertComplete(){assert.equal(invoked,true,'RUN_FEEDBACK_READY_MISSING');assert.equal(completed,true,'RUN_FEEDBACK_READY_INCOMPLETE');},close(){closed=true;}};
}

export async function capturePerformanceVisibleFeedbackPhase({round,collector,origin,nonce,topUrl,protocol,implementation=null,webviewVersion=null,readTop,waitEnabled,runAction,arenaFrame,readRoom,locale='zh',drainOriginal,writeFrame,readAuthority,createCapture=createVisibleFeedbackCollector,wait=sleep,now=Date.now}){
 if(round.game!=='run')return captureArenaVisibleFeedbackPhase({round,collector,origin,nonce,topUrl,protocol,implementation,webviewVersion,readTop,runAction,arenaFrame,readRoom,locale,drainOriginal,writeFrame,readAuthority,createCapture,wait,now});
 assert.equal(round.game,'run');assert.ok(round.measurementPhase!=='continuous'&&!round.sampleBoundaries?.start,'VISIBLE_FEEDBACK_DURING_CONTINUOUS_REFUSED');
 const phaseId=round.id+'-feedback-1',entry={schema:'owned-performance-visible-feedback-phase-v1',phase:'feedbackProof',phaseId,position:'beforeContinuous',startedAt:new Date(now()).toISOString(),errors:[],finalized:false};round.visibleFeedbackPhases??=[];round.visibleFeedbackPhases.push(entry);
 if(!protocol?.available){entry.analysis={schema:'owned-visible-run-feedback-v1',status:'insufficient',swapStatus:'insufficient',passed:false,physicalPanelPresent:false,reasons:[protocol?.error??'Exact official screencast protocol bytes were not provided']};entry.finishedAt=new Date(now()).toISOString();return entry;}
 const previousPhase=round.measurementPhase,args={phase:'feedbackProof',expectedUrl:origin+'/play/run',nonce,documentId:round.documentId},key='__oasisFeedback_'+randomUUID().replaceAll('-','');let capture,installed=false,probeInstalled=false,actionError,readyHook;
 const evaluate=async expression=>{let timer;try{return await Promise.race([collector.evaluate(expression),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('VISIBLE_FEEDBACK_REALM_TIMEOUT')),1500);})]);}finally{clearTimeout(timer);}};
 try{
  await waitEnabled();round.measurementPhase='feedbackProof';entry.authorityBefore=readAuthority();const {frameTree}=await collector.cdp.send('Page.getFrameTree'),context=await collector.bind();entry.scope=visibleFeedbackScopeForRound({tree:frameTree,context,round,origin,nonce,topUrl});
  await evaluate('('+beginOwnedMotionProof.toString()+')('+JSON.stringify(args)+','+ownedPerformanceFailureDOM.toString()+')');probeInstalled=true;
  entry.installation=await evaluate('('+installOwnedVisibleFeedbackObservation.toString()+')('+JSON.stringify({scope:entry.scope,key,phaseId,action:'jump'})+')');installed=true;
  readyHook=createRunFeedbackNativeReadyHook({round,scope:entry.scope,authorityBefore:entry.authorityBefore,readAuthority,onReady:async({authority})=>{
   entry.authorityAtNativeReady=authority;const observer=await evaluate('('+readOwnedVisibleFeedbackObservation.toString()+')('+JSON.stringify({scope:entry.scope,key})+')');assert.equal(observer.schema,'owned-visible-feedback-observation-v1','RUN_FEEDBACK_READY_OBSERVER_REQUIRED');assert.deepEqual(observer.scope,entry.scope,'RUN_FEEDBACK_READY_OBSERVER_SCOPE_CHANGED');assert.equal(observer.key,key,'RUN_FEEDBACK_READY_OBSERVER_CHANGED');assert.equal(observer.phaseId,phaseId,'RUN_FEEDBACK_READY_OBSERVER_CHANGED');assert.equal(observer.phase,'feedbackProof','RUN_FEEDBACK_READY_OBSERVER_PHASE_CHANGED');assert.equal(observer.action,'jump','RUN_FEEDBACK_READY_OBSERVER_ACTION_CHANGED');assert.equal(observer.removed,false,'RUN_FEEDBACK_READY_OBSERVER_REMOVED');assert.deepEqual(observer.events,[],'RUN_FEEDBACK_READY_PRIOR_INPUT_REFUSED');assert.deepEqual(observer.errors,[],'RUN_FEEDBACK_READY_OBSERVER_ERRORS');assert.equal(observer.overflow,false,'RUN_FEEDBACK_READY_OBSERVER_BOUND');
   capture=await createCapture({session:collector.cdp,scope:entry.scope,phaseId,protocol:protocol.receipt,implementation:implementation?.receipt??null,webviewVersion,readOwnedState:()=>readTop(readOwnedFeedbackProjection,{scope:entry.scope}),writeFrame});
   const baselineDeadline=now()+1500;while(capture.capture.frames.length<2&&now()<baselineDeadline)await wait(25);assert.ok(capture.capture.frames.length>=2,'VISIBLE_FEEDBACK_BASELINE_FRAMES_UNAVAILABLE');
  }});
  try{entry.uiAction=await runAction(input=>readyHook.invoke(input));readyHook.assertComplete();}catch(error){if(error.capture)entry.capture=error.capture;entry.actionError={message:error.message,code:error.code??null,status:error.status??null,nativeInputSent:error.nativeInputSent??null};actionError=error;}
  await wait(200);await drainOriginal();
 }catch(error){if(error.capture)entry.capture=error.capture;entry.errors.push({stage:'OBSERVATION',message:error.message});}
 finally{
  readyHook?.close();
  if(installed)try{entry.observation=await evaluate('('+readOwnedVisibleFeedbackObservation.toString()+')('+JSON.stringify({scope:entry.scope,key,remove:true})+')');}catch(error){entry.errors.push({stage:'OWN_OBSERVER_CLEANUP',message:error.message});}
  if(capture)try{entry.capture=await capture.close();}catch(error){entry.errors.push({stage:'OWN_SCREENCAST_CLEANUP',message:error.message});}
  if(probeInstalled)try{entry.probe=await evaluate('globalThis.__oasisOwnedMotionProof.stop()');assert.equal(entry.probe.phase,'feedbackProof');assert.equal(entry.probe.closed,true);assert.equal(entry.probe.dropped,0);assert.deepEqual(entry.probe.owner,{nonce,documentId:round.documentId,timeOrigin:round.documentTimeOrigin,url:args.expectedUrl});}catch(error){entry.errors.push({stage:'OWN_PROBE_CLEANUP',message:error.message});}
  try{entry.authorityAfter=readAuthority();}catch(error){entry.errors.push({stage:'ORIGINAL_AUTHORITY',message:error.message});}round.measurementPhase=previousPhase;entry.finishedAt=new Date(now()).toISOString();
 }
 entry.originalRequests=collector.actionRequestDiagnostics?.().filter(r=>r.frameId===entry.scope?.frameId&&entry.capture?.before&&entry.capture?.after&&r.requestStartedEpochMs>=entry.scope.timeOrigin+entry.capture.before.at&&r.requestStartedEpochMs<=entry.scope.timeOrigin+entry.capture.after.at)??[];
 entry.acceptedActions=collector.actions.filter(a=>entry.originalRequests.some(r=>r.requestSha256===a.requestSha256));
 // The standard accepts a proven captured-content upper bound. OS/optical
 // presentation is supplementary evidence and is never claimed by this phase.
 entry.analysis=analyzeVisibleRunFeedback({capture:entry.capture,observation:entry.observation,actions:entry.acceptedActions,requests:entry.originalRequests});
 entry.finalized=entry.errors.length===0&&entry.capture?.closed===true&&entry.observation?.removed===true&&entry.probe?.closed===true;
 if(!entry.finalized&&entry.analysis.captureStatus==='pass'){entry.analysis.status='insufficient';entry.analysis.captureStatus='insufficient';entry.analysis.passed=false;entry.analysis.reasons.push('Independent phase finalization evidence is incomplete');}
 if(entry.capture){entry.capture={...entry.capture,frames:entry.capture.frames.map(({pngBase64,...row})=>row),rawPngStorage:'All original received PNG bytes saved by indexed sink; byte hashes validated before stripping duplicated inline base64'};}
 if(actionError&&!(actionError.code==='ACTION_STATE_CHANGED'&&actionError.nativeInputSent===false))throw actionError;
 return entry;
}

/** No raw CDP headers, cookies, authorization, launch exchange or API bodies leave memory. */
export async function createPhysicalNetworkCollector({context,page,origin,game,state,baseline,manifest,nonce,round,entryUrl,drainTimeoutMs=20000}){
 assert.ok(Number.isSafeInteger(drainTimeoutMs)&&drainTimeoutMs>0&&drainTimeoutMs<=20000,'BOUNDED_DRAIN_TIMEOUT_REQUIRED');
 const cdp=await context.newCDPSession(page),contexts=new Map(),requests=new Map(),tasks=new Set(),errors=[],records=[],actions=[],rawBodyDiagnostics=[];let candidateFrame=null,scope=null,bytes=0,closed=false,resourceSnapshot=null,resourceEvidence=null,resourceFrozen=false,resourceFinalized=false;
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
  const row=requests.get(event.requestId);if(!row)return;row.transferFinished=true;row.finished=true;tracked(async()=>{
   assert.equal(row.frameId,candidateFrame,'NETWORK_GAME_FRAME_CHANGED');assert.ok(row.response,'NETWORK_RESPONSE_MISSING');assert.ok(row.response.status>=200&&row.response.status<300||row.response.status===304,'GAME_HTTP_FAILURE');assert.ok(Number.isFinite(event.encodedDataLength)&&event.encodedDataLength>=0,'ENCODED_TRANSFER_UNAVAILABLE');
   const record={path:row.path.replace(/\/rooms\/[^/]+/,'/rooms/[owned]'),method:row.method,type:row.type,static:row.isStatic,status:row.response.status,encodedTransferBytes:event.encodedDataLength,durationMs:(event.timestamp-row.start)*1000,cache:{memory:row.cached,disk:row.response.fromDiskCache,serviceWorker:row.response.fromServiceWorker,revalidated:row.response.status===304},protocol:row.response.protocol,timing:row.response.timing,frameId:row.frameId};
   assert.ok(!row.response.fromServiceWorker,'UNREVIEWED_SERVICE_WORKER_DELIVERY');records.push(record);
   if(row.isStatic){
    let data;try{const body=await cdp.send('Network.getResponseBody',{requestId:event.requestId});data=Buffer.from(body.body,body.base64Encoded?'base64':'utf8');bytes+=data.length;assert.ok(bytes<=256*1024*1024,'RESOURCE_BODY_BOUND_EXCEEDED');
     if(row.url.startsWith('blob:'))throw Error('UNPINNED_PLAYER_RESOURCE: '+row.path);
     record.resourcePin=assertPlayerResourceBody(row.url,data,{origin,manifest})||{sha256:hash(data),bytes:data.length,source:'Observed external HTTPS font asset; not a release output pin'};
    }catch(error){
     const image=row.type==='Image'||/\.(?:webp|png|jpe?g|svg|avif|gif)$/.test(row.path),ownImage=image&&(row.url.startsWith('blob:'+origin+'/')||new URL(row.url).origin===origin);
     if(!ownImage||error.message==='RESOURCE_BODY_BOUND_EXCEEDED')throw error;
     const diagnostic={requestId:row.id,path:row.path,frameId:row.frameId,code:data===undefined?'CDP_RESPONSE_BODY_UNAVAILABLE':row.url.startsWith('blob:')?'UNPINNED_PLAYER_RESOURCE':'PLAYER_RESOURCE_BODY_SHA_MISMATCH',bodyBytes:data?.length??null,bodySha256:data?hash(data):null,nonemptyPublicBodyConflict:!!(data?.length&&!row.url.startsWith('blob:')),resolvedByIndependentDelivery:false};
     rawBodyDiagnostics.push(diagnostic);record.rawBodyDiagnostic=diagnostic;record.observedBodySha256=data?hash(data):null;record.observedBodyBytes=data?.length??null;if(diagnostic.nonemptyPublicBodyConflict)throw error;
    }
   }
   if(row.isAction){assert.ok(scope,'ACTION_BEFORE_PROVEN_GAME_CONTEXT');const response=await cdp.send('Network.getResponseBody',{requestId:event.requestId}),data=Buffer.from(response.body,response.base64Encoded?'base64':'utf8');assert.ok(data.length<=2*1024*1024,'ACTION_BODY_BOUND_EXCEEDED');const body=JSON.parse(data),after=body.room||body;
    const probe=await evaluate('(()=>{const p=globalThis.__oasisPhysicalPerf;return {schema:p.schema,nonce:p.nonce,documentId:p.documentId,url:p.url,timeOrigin:p.timeOrigin,frames:[],longTasks:[],gestures:p.gestures.slice(-8)};})()');verifyProbe(probe,{origin,game,nonce,documentId:round.documentId});const gesture=[...probe.gestures].reverse().find(g=>g.completedEpochMs<=row.wall&&row.wall-g.completedEpochMs<1000);
    const proof=acceptedPerformanceAction({game,before:row.before,request:row.request,after,status:row.response.status,gesture,startedAt:row.wall,finishedAt:row.wall+(event.timestamp-row.start)*1000});
    actions.push({...proof,gestureCompletedEpochMs:gesture.completedEpochMs,requestStartedEpochMs:row.wall,responseFinishedEpochMs:row.wall+(event.timestamp-row.start)*1000,responseSha256:hash(data),requestSha256:hash(JSON.stringify(row.request)),roomIdHash:hash(after.id),source:'Exact game-frame CDP transfer plus trusted pointer completion and declared authority cursor',confirmationScope:'Complete network authority reply; excludes application JSON-read/visible-feedback time'});
   }
   row.finished=true;
  });
 });
 await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:false});
 async function bind(){const{frameTree}=await cdp.send('Page.getFrameTree');scope=assertGameContext({tree:frameTree,contexts:[...contexts.values()],origin,game,topUrl:page.url()});assert.equal(scope.frameId,candidateFrame,'OBSERVED_FRAME_IDENTITY_MISMATCH');return scope;}
 async function evaluate(expression){assert.ok(scope&&contexts.has(scope.contextId),'GAME_EXECUTION_CONTEXT_LOST');const value=await cdp.send('Runtime.evaluate',{expression,contextId:scope.contextId,returnByValue:true,awaitPromise:true});assert.ok(!value.exceptionDetails,'GAME_PROBE_EVALUATION_FAILED');return value.result.value;}
 async function verifyResourceEvidence({freeze=false,finish=false}={}){
  assert.ok(entryUrl,'RESOURCE_PARENT_ENTRY_REQUIRED');const probe=await evaluate('(()=>{const p=globalThis.__oasisPhysicalPerf;return {schema:p.schema,nonce:p.nonce,documentId:p.documentId,url:p.url,timeOrigin:p.timeOrigin,frames:[],longTasks:[],gestures:[]};})()');verifyProbe(probe,{origin,game,nonce,documentId:round.documentId});
  const began=Date.now();try{resourceSnapshot=await evaluate(finish?'globalThis.__oasisConsumedImageEvidence.stop()':'globalThis.__oasisConsumedImageEvidence.drain(15000)');}catch(error){try{resourceSnapshot=await evaluate('globalThis.__oasisConsumedImageEvidence.snapshot()');}catch{}if(resourceSnapshot)round.resourceEvidence={...resourceSnapshot,loadingDrainMs:Date.now()-began,verificationError:error.message,hashingPerturbsLoading:true,hashingDuringFrameSampling:resourceSnapshot.phase==='sampling'&&resourceSnapshot.pendingTasks>0};throw error;}
  round.resourceEvidence={...resourceSnapshot,loadingDrainMs:Date.now()-began,hashingPerturbsLoading:true,hashingDuringFrameSampling:false,rawCdpBodyDiagnosticsRetained:true};
  assert.ok(!rawBodyDiagnostics.some(d=>d.nonemptyPublicBodyConflict),'RESOURCE_NONEMPTY_CDP_BODY_CONFLICT');
  resourceEvidence=validateConsumedImageEvidence(resourceSnapshot,{origin,entryUrl,game,nonce,documentId:round.documentId,timeOrigin:probe.timeOrigin,scope,manifest,requests:[...requests.values()]});
  for(const record of records.filter(r=>r.rawBodyDiagnostic)){
   const row=requests.get(record.rawBodyDiagnostic.requestId),proof=deliveryProofForRow(row,resourceEvidence,{origin,manifest});
   if(record.observedBodyBytes>0)assert.equal(record.observedBodySha256,proof.sha256,'RESOURCE_NONEMPTY_CDP_BODY_CONFLICT');
   record.deliveryProof=proof;record.rawBodyDiagnostic.resolvedByIndependentDelivery=true;
  }
  if(freeze){resourceSnapshot=await evaluate('globalThis.__oasisConsumedImageEvidence.freeze()');resourceFrozen=true;round.resourceHashLoadingDrainMs=Date.now()-began;round.resourceEvidenceReadyAt=new Date().toISOString();}
  if(finish)resourceFinalized=true;
  round.resourceEvidence={schema:resourceSnapshot.schema,identity:resourceSnapshot.identity,phase:resourceSnapshot.phase,pendingTasks:resourceSnapshot.pendingTasks,errors:resourceSnapshot.errors,receipts:resourceSnapshot.receipts,totalHashedBytes:resourceSnapshot.totalHashedBytes,verifiedReceipts:resourceEvidence.verifiedReceipts,loadingDrainMs:round.resourceHashLoadingDrainMs??null,finalVerificationMs:finish?Date.now()-began:null,hashingPerturbsLoading:true,hashingDuringFrameSampling:false,rawCdpBodyDiagnosticsRetained:true};return round.resourceEvidence;
 }
 return {cdp,errors,records,actions,bind,evaluate,verifyResourceEvidence,
  actionRequestDiagnostics(){return [...requests.values()].filter(row=>row.isAction).map(row=>({cdpRequestId:row.id,frameId:row.frameId,roomIdHash:hash(row.before.id),requestSha256:hash(JSON.stringify(row.request)),requestStartedEpochMs:row.wall,responseStatus:row.response?.status??null,transferFinished:row.transferFinished===true,failed:row.failed===true,canceled:row.canceled===true,source:'Original exact own game-frame authenticated action request; body and headers remain private'}));},
  pendingStatic(){return [...requests.values()].filter(r=>r.isStatic&&!r.finished&&!r.failed).length;},
  async clearOwnHttpCache(){await cdp.send('Network.clearBrowserCache');},
  async drain(){const end=Date.now()+drainTimeoutMs;try{while(tasks.size){const remaining=end-Date.now();assert.ok(remaining>0,'PERFORMANCE_NETWORK_DRAIN_TIMEOUT');let timer;try{await Promise.race([Promise.all([...tasks]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('PERFORMANCE_NETWORK_DRAIN_TIMEOUT')),remaining);})]);}finally{clearTimeout(timer);}}}finally{round.pendingWork=tasks.size;}},
  summary(){const staticRows=records.filter(r=>r.static),images=staticRows.filter(r=>r.type==='Image'||/\.(?:png|webp|svg|jpg|jpeg)$/.test(r.path)),snapshots=records.filter(r=>r.method==='GET'&&/^\/api\/pvp\/rooms\//.test(r.path));return {staticEncodedBytes:staticRows.length?staticRows.reduce((s,r)=>s+r.encodedTransferBytes,0):null,imageMaxEncodedBytes:images.length?Math.max(...images.map(r=>r.encodedTransferBytes)):staticRows.length?0:null,snapshotMaxEncodedBytes:snapshots.length?Math.max(...snapshots.map(r=>r.encodedTransferBytes)):null,records,rawBodyDiagnostics,bodyPinsOnly:rawBodyDiagnostics.length===0,deliveryEvidenceSeparateFromCdpBody:true,transferCompletionSeparateFromBodyVerification:true,headersStored:false,apiBodiesStored:false,encodedScope:'Unmodified actual CDP encodedDataLength includes transport headers, including any 304 header transfer; cache delivery flags are separate'};},
  cacheFacts(){return {diskCacheSeen:records.some(r=>r.cache.disk),memoryCacheSeen:records.some(r=>r.cache.memory),reuseObserved:records.some(r=>r.cache.disk||r.cache.memory||r.status===304)};},
  async close(){if(closed)return;closed=true;try{await this.drain();if(scope&&round.documentId&&!resourceFinalized)try{await verifyResourceEvidence({finish:true});}catch(error){errors.push('RESOURCE_FINAL_EVIDENCE: '+error.message);}for(const diagnostic of rawBodyDiagnostics)if(!diagnostic.resolvedByIndependentDelivery)errors.push('RESOURCE_ALTERNATIVE_DELIVERY_UNPROVEN: '+diagnostic.path);if(resourceFrozen&&!resourceFinalized)errors.push('RESOURCE_SAMPLING_EVIDENCE_NOT_FINALIZED');}finally{for(const {event,fn}of handlers)cdp.off(event,fn);await cdp.detach();}}
 };
}

/** One native input only: evidence installation observes real DOM events, never dispatches them. */
export async function waitForSettledNativeTapFrame({twoRAF,wait=sleep,timeoutMs=1000}){
 assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=1000,'BOUNDED_NATIVE_TAP_SETTLE_REQUIRED');let timer;
 try{await Promise.race([twoRAF(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('OWNED_NATIVE_TAP_RAF_SETTLE_TIMEOUT')),timeoutMs);})]);}finally{clearTimeout(timer);}await wait(300);
}
export function settledNativeTapGeometry({bounds,webview,viewport,position}){
 const finite=(v,label)=>assert.ok(typeof v==='number'&&Number.isFinite(v),label);
 for(const k of['x','y','width','height'])finite(bounds[k],'VISIBLE_NATIVE_TAP_BOUNDS_REQUIRED');
 for(const k of['width','height','screenX','screenY'])finite(webview[k],'PLAYER_NATIVE_WEBVIEW_GEOMETRY_REQUIRED');
 for(const k of['width','height','dpr'])finite(viewport[k],'PLAYER_NATIVE_VIEWPORT_REQUIRED');
 assert.ok(bounds.width>0&&bounds.height>0&&viewport.width>0&&viewport.height>0&&viewport.dpr>0,'VISIBLE_NATIVE_TAP_BOUNDS_REQUIRED');
 assert.equal(webview.visible,true,'PLAYER_NATIVE_WEBVIEW_NOT_VISIBLE');assert.equal(webview.attached,true,'PLAYER_NATIVE_WEBVIEW_NOT_ATTACHED');
 assert.ok(Math.abs(webview.width/viewport.width-viewport.dpr)<.1&&Math.abs(webview.height/viewport.height-viewport.dpr)<.1,'PLAYER_WEBVIEW_SCALE_UNPROVEN');
 const x=Math.round(webview.screenX+(bounds.x+(position?.x??bounds.width/2))*viewport.dpr),y=Math.round(webview.screenY+(bounds.y+(position?.y??bounds.height/2))*viewport.dpr);
 assert.ok(x>=webview.screenX&&x<webview.screenX+webview.width&&y>=webview.screenY&&y<webview.screenY+webview.height,'PLAYER_NATIVE_TAP_OUTSIDE_WEBVIEW');return{x,y};
}
export function ownedNativeTapEventDOM(element,{performanceScope},readDOM){
 const scope=performanceScope;if(!scope)throw Error('OWNED_NATIVE_TAP_PERFORMANCE_SCOPE_REQUIRED');
 const dom=readDOM({expectedUrl:scope.url,nonce:scope.nonce,documentId:scope.documentId});if(dom.owner.timeOrigin!==scope.timeOrigin)throw Error('OWNED_NATIVE_TAP_DOCUMENT_CLOCK_CHANGED');
 return {...dom,schema:'owned-native-tap-event-dom-v1',control:{tag:element.tagName,testId:element.getAttribute('data-testid'),disabled:element.disabled===true,ariaDisabled:element.getAttribute('aria-disabled'),ariaBusy:element.getAttribute('aria-busy')},hostRequest:{available:false,reason:'Pinned product DOM does not expose the RunGame closure ref; combined aria-disabled and status text are retained without inferring idle'}};
}
export function prepareOwnedNativeTapReceipt(element,{key,expectedUrl,position,performanceScope=null,authorityAtInstallation=null},readDOM){
 const w=element.ownerDocument.defaultView,d=element.ownerDocument;
 let failedPredicate,urlMatches,visibility,disabled,ariaDisabled;
 if((failedPredicate='urlMatches',urlMatches=w.location.href===expectedUrl,!urlMatches)||(failedPredicate='visibility',visibility=d.visibilityState,visibility!=='visible')||(failedPredicate='disabled',disabled=!!element.disabled,disabled)||(failedPredicate='ariaDisabled',ariaDisabled=element.getAttribute('aria-disabled'),ariaDisabled==='true')){
  const visibilityLabel=failedPredicate==='urlMatches'?'unread':visibility==='visible'?'visible':visibility==='hidden'?'hidden':visibility==='prerender'?'prerender':'other',disabledLabel=failedPredicate==='urlMatches'||failedPredicate==='visibility'?'"unread"':disabled?'true':'false',ariaDisabledLabel=failedPredicate!=='ariaDisabled'?'unread':ariaDisabled==='true'?'true':ariaDisabled==='false'?'false':ariaDisabled===null?'absent':'other';
  const diagnostic='{"schema":"owned-native-tap-guard-diagnostic-v1","failedPredicate":"'+failedPredicate+'","evaluatedPrefix":{"urlMatches":'+(urlMatches?'true':'false')+',"visibility":"'+visibilityLabel+'","disabled":'+disabledLabel+',"ariaDisabled":"'+ariaDisabledLabel+'"}}';
  throw Error('OWNED_NATIVE_TAP_DOCUMENT_OR_CONTROL_UNPROVEN | guard-diagnostic='+diagnostic);
 }
 if(Object.hasOwn(element,key))throw Error('OWNED_NATIVE_TAP_RECEIPT_ALREADY_PRESENT');
 const r=element.getBoundingClientRect(),hit=d.elementFromPoint(r.x+(position?.x??r.width/2),r.y+(position?.y??r.height/2));
 if(!hit||!(hit===element||element.contains(hit)))throw Error('OWNED_NATIVE_TAP_HIT_TARGET_UNPROVEN');
 if(performanceScope){if(performanceScope.url!==expectedUrl||typeof readDOM!=='function')throw Error('OWNED_NATIVE_TAP_PERFORMANCE_SCOPE_REQUIRED');readDOM(element,{performanceScope});}
 const slot={schema:'owned-native-tap-receipt-v1',key,url:expectedUrl,documentTimeOrigin:w.performance.timeOrigin,events:[],overflow:false,handlers:[],visibility:d.visibilityState,focusedBefore:d.hasFocus(),performanceScope,authorityAtInstallation,observationErrors:[]};
 Object.defineProperty(element,key,{value:slot,configurable:true});
 for(const type of['pointerdown','pointerup','click']){const handler=event=>{if(!(event.target===element||element.contains(event.target)))return;if(slot.events.length>=8){slot.overflow=true;return;}const row={type,isTrusted:event.isTrusted===true,x:event.clientX,y:event.clientY,at:w.performance.now()};if(performanceScope)try{row.dom=readDOM(element,{performanceScope});row.authorityReference={source:'Last retained original authorized room reply at receipt installation; asynchronous reference, not an atomic click-time authority read',snapshot:authorityAtInstallation,domRevision:row.dom.track?.data.revision??null,authorityRevision:authorityAtInstallation?.runInputs?.revision??null};}catch(error){row.observationError=error.message;slot.observationErrors.push({type,at:row.at,error:error.message});}slot.events.push(row);};d.addEventListener(type,handler,true);slot.handlers.push({type,handler});}
 return{schema:slot.schema,key,url:slot.url,documentTimeOrigin:slot.documentTimeOrigin,visibility:slot.visibility,focusedBefore:slot.focusedBefore,tag:element.tagName,testId:element.getAttribute('data-testid'),hitTag:hit.tagName,performanceScope,authorityAtInstallation};
}
export function readOwnedNativeTapReceipt(element,{key,expectedUrl}){
 const s=element[key],w=element.ownerDocument.defaultView;if(!s||s.key!==key||s.url!==expectedUrl||w.location.href!==expectedUrl||s.documentTimeOrigin!==w.performance.timeOrigin)throw Error('OWNED_NATIVE_TAP_RECEIPT_IDENTITY_CHANGED');
 return{schema:s.schema,key:s.key,url:s.url,documentTimeOrigin:s.documentTimeOrigin,events:s.events,overflow:s.overflow,focusedBefore:s.focusedBefore,focusedAfter:element.ownerDocument.hasFocus(),visibility:element.ownerDocument.visibilityState,performanceScope:s.performanceScope,authorityAtInstallation:s.authorityAtInstallation,observationErrors:s.observationErrors};
}
export function removeOwnedNativeTapReceipt(element,{key,expectedUrl}){
 const s=element[key];if(!s)return{removed:false,missing:true};if(s.key!==key||s.url!==expectedUrl)throw Error('OWNED_NATIVE_TAP_RECEIPT_IDENTITY_CHANGED');
 for(const{type,handler}of s.handlers)element.ownerDocument.removeEventListener(type,handler,true);delete element[key];return{removed:true,missing:false};
}
export function assertOwnedNativeTapReceipt(receipt,{key,expectedUrl,performanceScope=null}){
 assert.equal(receipt?.schema,'owned-native-tap-receipt-v1','OWNED_NATIVE_TAP_RECEIPT_REQUIRED');assert.equal(receipt.key,key);assert.equal(receipt.url,expectedUrl);assert.equal(receipt.overflow,false,'OWNED_NATIVE_TAP_RECEIPT_BOUND');
 assert.ok(Array.isArray(receipt.events)&&receipt.events.length<=8&&receipt.events.every(e=>['pointerdown','pointerup','click'].includes(e.type)&&e.isTrusted===true&&Number.isFinite(e.x)&&Number.isFinite(e.y)&&Number.isFinite(e.at)),'OWNED_NATIVE_TAP_UNTRUSTED_EVENT');
 assert.equal(receipt.events.filter(e=>e.type==='click').length,1,'OWNED_NATIVE_TAP_EXACT_TRUSTED_CLICK_REQUIRED');
 if(performanceScope){assert.deepEqual(receipt.performanceScope,performanceScope,'OWNED_NATIVE_TAP_PERFORMANCE_SCOPE_CHANGED');assert.deepEqual(receipt.observationErrors,[],'OWNED_NATIVE_TAP_EVENT_DOM_UNPROVEN');for(const event of receipt.events){assert.equal(event.dom?.schema,'owned-native-tap-event-dom-v1','OWNED_NATIVE_TAP_EVENT_DOM_UNPROVEN');assert.deepEqual(event.dom.owner,{nonce:performanceScope.nonce,documentId:performanceScope.documentId,timeOrigin:performanceScope.timeOrigin,url:performanceScope.url},'OWNED_NATIVE_TAP_EVENT_DOCUMENT_CHANGED');assert.ok(event.dom.at>=event.at,'OWNED_NATIVE_TAP_EVENT_CLOCK_UNPROVEN');}}
 return receipt;
}

/** ElementHandle.evaluate invokes Function values with element/args. A string
 * containing an arrow merely evaluates that arrow without calling it. */
export function createOwnedNativeTapEvaluators(){
 return{
  install:new Function('element','args','return ('+prepareOwnedNativeTapReceipt.toString()+')(element,args,(element,scope)=>('+ownedNativeTapEventDOM.toString()+')(element,scope,'+ownedPerformanceFailureDOM.toString()+'));'),
  readDOM:new Function('element','args','return ('+ownedNativeTapEventDOM.toString()+')(element,args,'+ownedPerformanceFailureDOM.toString()+');'),
 };
}

/** Installation must be proven before sending any native input. */
export function assertOwnedNativeTapInstallation(installation,{key,expectedUrl,performanceScope=null}){
 assert.equal(installation?.schema,'owned-native-tap-receipt-v1','OWNED_NATIVE_TAP_INSTALLATION_REQUIRED');assert.equal(installation.key,key,'OWNED_NATIVE_TAP_INSTALLATION_KEY_CHANGED');assert.equal(installation.url,expectedUrl,'OWNED_NATIVE_TAP_INSTALLATION_URL_CHANGED');
 assert.ok(Number.isFinite(installation.documentTimeOrigin)&&installation.documentTimeOrigin>0,'OWNED_NATIVE_TAP_INSTALLATION_CLOCK_UNPROVEN');assert.equal(installation.visibility,'visible','OWNED_NATIVE_TAP_INSTALLATION_NOT_VISIBLE');
 assert.deepEqual(installation.performanceScope,performanceScope,'OWNED_NATIVE_TAP_INSTALLATION_SCOPE_CHANGED');if(performanceScope)assert.equal(installation.documentTimeOrigin,performanceScope.timeOrigin,'OWNED_NATIVE_TAP_INSTALLATION_CLOCK_CHANGED');return installation;
}
export function assertOwnedNativeTapInstalledSlot(receipt,{installation,key,expectedUrl,performanceScope=null}){
 assertOwnedNativeTapInstallation(installation,{key,expectedUrl,performanceScope});
 assert.equal(receipt?.schema,'owned-native-tap-receipt-v1','OWNED_NATIVE_TAP_INSTALLED_SLOT_REQUIRED');assert.equal(receipt.key,key,'OWNED_NATIVE_TAP_INSTALLED_SLOT_KEY_CHANGED');assert.equal(receipt.url,expectedUrl,'OWNED_NATIVE_TAP_INSTALLED_SLOT_URL_CHANGED');assert.equal(receipt.documentTimeOrigin,installation.documentTimeOrigin,'OWNED_NATIVE_TAP_INSTALLED_SLOT_CLOCK_CHANGED');
 assert.deepEqual(receipt.performanceScope,performanceScope,'OWNED_NATIVE_TAP_INSTALLED_SLOT_SCOPE_CHANGED');assert.equal(receipt.visibility,'visible','OWNED_NATIVE_TAP_INSTALLED_SLOT_NOT_VISIBLE');assert.deepEqual(receipt.events,[],'OWNED_NATIVE_TAP_PRE_INPUT_EVENTS_PRESENT');assert.equal(receipt.overflow,false,'OWNED_NATIVE_TAP_INSTALLED_SLOT_BOUND');assert.deepEqual(receipt.observationErrors,[],'OWNED_NATIVE_TAP_INSTALLED_SLOT_DOM_UNPROVEN');return receipt;
}

/** Diagnostic labels never turn a missing request into a valid interaction. */
export function classifyOwnedNativeTapOutcomes({receipts=[],requests=[],actions=[],observationStage}){
 return receipts.map((receipt,index)=>{
  const scope=receipt.performanceScope,events=receipt.trustedReceipt?.events??[],click=events.find(event=>event.type==='click'&&event.isTrusted),up=events.find(event=>event.type==='pointerup'&&event.isTrusted),epoch=scope&&up?scope.timeOrigin+up.at:null,next=receipts.slice(index+1).map(value=>{const event=value.trustedReceipt?.events?.find(e=>e.type==='pointerup'&&e.isTrusted);return event&&value.performanceScope?.documentId===scope?.documentId?value.performanceScope.timeOrigin+event.at:null;}).find(Number.isFinite)??Infinity;
  const matched=Number.isFinite(epoch)?requests.filter(request=>request.frameId===scope.frameId&&request.roomIdHash===receipt.authorityAtInstallation?.roomIdHash&&request.requestStartedEpochMs>=epoch&&request.requestStartedEpochMs<next):[],accepted=actions.filter(action=>matched.some(request=>request.requestSha256===action.requestSha256));
  const scoped=scope&&click&&up&&receipt.completed===true&&!receipt.trustedReceipt.observationErrors?.length&&[click,up].every(event=>event.dom?.owner?.nonce===scope.nonce&&event.dom.owner.documentId===scope.documentId&&event.dom.owner.timeOrigin===scope.timeOrigin&&event.dom.owner.url===scope.url&&!event.observationError);
  const inputSent=receipt.nativeInput?.exit===0?true:receipt.nativeInput===null?false:null;let outcome=inputSent===false?(receipt.nativeNotSentReason==='disabled-before-native-input'?'disabled-native-input-not-sent':'native-input-not-sent'):inputSent!==true?'native-input-command-failed':!click?'native-input-without-proven-trusted-click':!scope?'trusted-non-game-click':!scoped?'trusted-click-observation-unproven':receipt.nativeRole!=='game-action'?'trusted-non-action-game-click':matched.length>1?'trusted-click-action-request-binding-ambiguous':!matched.length?'trusted-click-no-action-post-observed':accepted.length===1?'trusted-click-action-accepted':'trusted-click-action-post-without-proven-accepted-response';
  return {nativeTapSequence:receipt.sequence,roundId:receipt.roundId??null,phase:receipt.measurementPhase??null,outcome,nativeInputSent:inputSent,trustedClickEpochMs:scope&&click?scope.timeOrigin+click.at:null,gestureCompletedEpochMs:epoch,observationStage,requests:matched,acceptedActions:accepted.map(action=>({requestSha256:action.requestSha256,commandSeq:action.proof?.commandSeq??null,cursorBefore:action.cursorBefore,cursorAfter:action.cursorAfter})),source:'report.resources.nativeTaps entry with the same sequence; labels retain missing/failed evidence and do not alter action counts'};
 });
}
export async function waitForOriginalAndroidForeground({read,expected,timeoutMs=10000,wait=sleep,now=Date.now,evidence}){
 assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=10000,'BOUNDED_FOREGROUND_RESTORE_REQUIRED');const end=now()+timeoutMs;let lastError=null;
 evidence.observations??=[];evidence.observationsOmitted??=0;
 while(now()<end){let current=null,readTimer;try{const raw=await Promise.race([read(),new Promise((_,reject)=>{readTimer=setTimeout(()=>reject(Error('ORIGINAL_ANDROID_FOREGROUND_RESTORE_TIMEOUT')),Math.max(1,end-now()));})]);current=androidForeground(raw);}catch(error){if(!error.message.startsWith('ANDROID_FOREGROUND_UNPROVEN'))throw error;lastError=error.message;}finally{clearTimeout(readTimer);}
  const row={observedAt:new Date(now()).toISOString(),unique:current!==null,componentHash:current?hash(current):null,expected:current===expected};if(evidence.observations.length<20)evidence.observations.push(row);else evidence.observationsOmitted++;
  if(current===expected){evidence.confirmed=true;return current;}await wait(100);
 }
 evidence.confirmed=false;evidence.lastParserError=lastError?'ANDROID_FOREGROUND_UNPROVEN':null;throw Error('ORIGINAL_ANDROID_FOREGROUND_RESTORE_TIMEOUT');
}

/** Read the original control until genuinely enabled; never mutate it or send input. */
export async function waitForOwnedNativeTapEnabled({read,wait=sleep,now=Date.now,timeoutMs=45000,evidence}){
 assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=45000,'BOUNDED_NATIVE_TAP_ENABLE_WAIT_REQUIRED');const began=now(),end=began+timeoutMs;evidence.limitMs=timeoutMs;evidence.observedDisabled=false;evidence.observations=[];evidence.observationsOmitted=0;evidence.enabled=false;
 try{while(now()<end){let timer;let value;try{value=await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('OWNED_NATIVE_TAP_CONTROL_ENABLE_TIMEOUT')),Math.max(1,end-now()));})]);}finally{clearTimeout(timer);}
   assert.ok(value&&typeof value.visible==='boolean'&&typeof value.enabled==='boolean','OWNED_NATIVE_TAP_CONTROL_STATE_UNPROVEN');const row={elapsedMs:now()-began,visible:value.visible,enabled:value.enabled};if(evidence.observations.length<64)evidence.observations.push(row);else evidence.observationsOmitted++;if(!value.enabled)evidence.observedDisabled=true;
   if(value.visible&&value.enabled){evidence.enabled=true;return;}await wait(Math.min(100,Math.max(1,end-now())));
  }throw Error('OWNED_NATIVE_TAP_CONTROL_ENABLE_TIMEOUT');
 }finally{evidence.waitMs=now()-began;}
}
export function ownedNativeTapWaitingDOM(element,{expectedUrl}){
 const d=element.ownerDocument,w=d.defaultView;if(w.location.href!==expectedUrl)throw Error('OWNED_NATIVE_TAP_WAITING_DOCUMENT_CHANGED');
 const text=e=>String(e?.textContent||'').replace(/\s+/g,' ').trim().slice(0,160);
 return{url:w.location.href,visibility:d.visibilityState,focused:d.hasFocus(),viewport:{width:w.innerWidth,height:w.innerHeight,dpr:w.devicePixelRatio},control:{tag:element.tagName,disabled:element.disabled===true,ariaDisabled:element.getAttribute('aria-disabled'),className:String(element.className||'').slice(0,160),text:text(element)},loadingStatuses:[...d.querySelectorAll('.lobby-settings [role="status"],.waiting-room [role="status"],.arena-loading [role="status"]')].slice(0,4).map(e=>({className:String(e.className||'').slice(0,160),text:text(e)}))};
}

export async function runAndroidPerformance(options){
 assert.ok(!process.env.NODE_TLS_REJECT_UNAUTHORIZED||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='1','STRICT_TLS_REQUIRED');
 const redactor=createPlayerEvidenceRedactor(),artifact=await readPlayerArtifact(options.metadata,{shellRoot:join(ROOT,'android-player'),execute,apksigner:options.apksigner});assert.equal(new URL(artifact.origin).protocol,'https:');
 const manifestPath=resolve(options.platformManifest),info=await lstat(manifestPath);assert.ok(info.isFile()&&!info.isSymbolicLink());const rawManifest=await readFile(manifestPath),manifest=playerResourceManifest(JSON.parse(rawManifest));
 const runtimePins=runtimeSourcePins(manifest.inputs,{games:options.games}),runtimeSourcesBefore=await assertRuntimeSources(ROOT,runtimePins);
 const sources=Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,hash(await readFile(join(ROOT,path)))]))),out=resolve(options.output);await mkdir(out,{mode:0o700});await chmod(out,0o700);
 const report={schema:ANDROID_PERFORMANCE_SCHEMA,startedAt:new Date().toISOString(),executed:false,physicalDevice:false,passed:false,status:'preflight',fullCatalog:options.fullCatalog,selectedGames:options.games,measurementSources:sources,standard:{version:standards.version,sha256:sources['specs/mobile-quality-v1.json'],thresholds:standards.thresholds},artifact:{metadataSha256:artifact.metadataSha256,apkSha256:artifact.apkSha256,certificateSha256:artifact.certificateSha256,origin:artifact.origin,appId:artifact.appId,packageName:artifact.packageName},releaseManifestSha256:hash(rawManifest),runtimeSources:{before:runtimeSourcesBefore,after:null},configuration:{sampleMs:options.sampleMs,roomMs:options.roomMs,repetitions:options.repetitions,shortDiagnostic:options.shortDiagnostic},rounds:[],games:[],resources:{errors:[],events:[]},limitations:['Actual Android WebView RAF execution intervals and cropped scene pixel changes; not GPU/presented-frame FPS or iPhone Safari.','Uncontrolled network timings are diagnostics, not calibrated Wi-Fi latency acceptance.','Unsupported and missing observations remain partial; no synthetic authority, funds or new account.','This report does not accept probability games, third-party transfer, content playability or server capacity.']};
 const save=async()=>writeFile(join(out,'report.json'),JSON.stringify(redactor.sanitize(report),null,2)+'\n',{mode:0o600});await save();
 let feedbackProtocol={available:false,error:'--feedback-protocol was not provided; no original screencast source definition is pinned'};
 if(options.feedbackProtocolFile)try{const file=resolve(options.feedbackProtocolFile),info=await lstat(file);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size<=2*1024*1024,'VISIBLE_FEEDBACK_PROTOCOL_FILE_REQUIRED');const bytes=await readFile(file),receipt=visibleFeedbackProtocolReceipt(bytes),artifactFile='visible-feedback-official-protocol.json';await writeFile(join(out,artifactFile),bytes,{mode:0o600,flag:'wx'});feedbackProtocol={available:true,receipt,artifactFile};}catch(error){feedbackProtocol={available:false,error:redactor.clean(error.message)};}
 report.visibleFeedbackProtocol=feedbackProtocol;
 let feedbackImplementation={available:false,error:'--feedback-source-dir was not provided; provider implementation timing semantics are unproven'};
 if(options.feedbackSourceDir)try{const dir=resolve(options.feedbackSourceDir),info=await lstat(dir);assert.ok(info.isDirectory()&&!info.isSymbolicLink(),'VISIBLE_FEEDBACK_SOURCE_DIRECTORY_REQUIRED');const bytes={},artifactFiles={};for(const name of Object.keys(VISIBLE_FEEDBACK_IMPLEMENTATION_SOURCES)){const file=join(dir,name),stat=await lstat(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=256*1024,'VISIBLE_FEEDBACK_SOURCE_FILE_REQUIRED');bytes[name]=await readFile(file);}const receipt=visibleFeedbackImplementationReceipt(bytes);for(const [name,raw]of Object.entries(bytes)){const artifactFile='visible-feedback-chromium150-'+name;await writeFile(join(out,artifactFile),raw,{mode:0o600,flag:'wx'});artifactFiles[name]=artifactFile;}feedbackImplementation={available:true,receipt,artifactFiles};}catch(error){feedbackImplementation={available:false,error:redactor.clean(error.message)};}
 report.visibleFeedbackImplementation=feedbackImplementation;
 if(!options.run){report.preflightPassed=true;report.scope='Local signed artifact/source preflight only. No ADB, network, phone or gameplay.';await save();return report;}
 const credentials=await readPlayerCredentials(options.credentialsFile,redactor),origin=artifact.origin,pkg=artifact.packageName,component=pkg+'/com.tianyahuyu.oasis.player.MainActivity';
 const adb=async(...args)=>(await execute('adb',physicalAdbArgs(options,args),{timeout:45000,maxBuffer:4*1024*1024})).stdout.trim(),forwards=async()=>parseAndroidForwards(await adb('forward','--list'));
 let beforeForwards,foreground,forward,browser,context,page,apiContext,baseline,ownedStarted=false,active=null,resourceInstrumentation=null;
 const beforeState={};
 const tapAuthority=()=>{if(!active?.state.room)return {available:false,recordedAtEpochMs:Date.now(),reason:'No original owned room reply has been retained yet'};return {...failureAuthority(active.state,{game:active.round.game,baseline}),available:true,recordedAtEpochMs:Date.now(),clockSource:'Collector host epoch at snapshot read; separate from event DOM performance clock'};};
 const tapEvaluators=createOwnedNativeTapEvaluators();
 const topRead=async path=>{assert.ok(/^\/api\/player\/(app|session|wallet|recovery)(?:\?app_id=[A-Za-z0-9_-]+)?$/.test(path));const result=await page.evaluate(async path=>{const r=await fetch(path,{credentials:'same-origin',cache:'no-store'});return {status:r.status,body:await r.json()};},path);redactor.remember(result.body);return result;};
 const requiredRead=async path=>{const r=await topRead(path);assert.equal(r.status,200,'PLAYER_READ_FAILED');return r.body;};
 const tap=async(target,{position,beforeNativeTapReady=null}={})=>{
  report.resources.nativeTaps??=[];const preparationStartedAtEpochMs=Date.now(),receipt={sequence:(report.resources.nativeTapCount||0)+1,startedAt:new Date(preparationStartedAtEpochMs).toISOString(),nativeTiming:{preparationStartedAtEpochMs,commandOutcome:'not-sent'},settle:{rafCount:2,minimumWaitMs:300},nativeInput:null,trustedReceipt:null,errors:[],roundId:active?.round.id??null,measurementPhase:active?.round.measurementPhase??null};report.resources.nativeTapCount=receipt.sequence;if(report.resources.nativeTaps.length<1000)report.resources.nativeTaps.push(receipt);else report.resources.nativeTapReceiptsOmitted=(report.resources.nativeTapReceiptsOmitted||0)+1;if(active){active.nativeTaps.push(receipt);active.round.nativeTapSequences??=[];active.round.nativeTapSequences.push(receipt.sequence);}
  let handle,key,expectedUrl,performanceScope=null;
  const recordNative=async(value,exit)=>{const stdout=Buffer.from(value.stdout||''),stderr=Buffer.from(value.stderr||'');receipt.nativeInput={exit,stdoutBytes:stdout.length,stdoutSha256:hash(stdout),stderrBytes:stderr.length,stderrSha256:hash(stderr),stderrFile:null};if(stderr.length)try{const filename='native-tap-'+receipt.sequence+'-stderr.txt';await writeFile(join(out,filename),stderr,{mode:0o600,flag:'wx'});receipt.nativeInput.stderrFile=filename;}catch(error){receipt.stderrCaptureError=redactor.clean(error.message);report.resources.errors.push('OWNED_NATIVE_TAP_STDERR_CAPTURE: '+redactor.clean(error.message));}};
  try{
   await target.scrollIntoViewIfNeeded();receipt.enabledWait={};await waitForOwnedNativeTapEnabled({read:async()=>({visible:await target.isVisible(),enabled:await target.isEnabled()}),evidence:receipt.enabledWait});receipt.settle.startedAt=new Date().toISOString();await waitForSettledNativeTapFrame({twoRAF:()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))});receipt.settle.finishedAt=new Date().toISOString();
   handle=await target.elementHandle();assert.ok(handle,'OWNED_NATIVE_TAP_ELEMENT_REQUIRED');const b=await handle.boundingBox();assert.ok(b&&b.width>0&&b.height>0);const ownFrame=await handle.ownerFrame();assert.ok(ownFrame&&!ownFrame.isDetached(),'OWNED_NATIVE_TAP_FRAME_REQUIRED');expectedUrl=ownFrame.url();assert.ok(ownFrame===page.mainFrame()&&expectedUrl===artifact.entryUrl||active&&ownFrame.parentFrame()===page.mainFrame()&&expectedUrl===origin+'/play/'+active.round.game,'OWNED_NATIVE_TAP_FOREIGN_FRAME');if(ownFrame!==page.mainFrame()){assertOwnedPlayerArenaState(active.state,baseline);performanceScope={nonce:active.nonce,documentId:active.round.documentId,timeOrigin:active.round.documentTimeOrigin,url:expectedUrl,frameId:active.round.context.frameId};receipt.performanceScope=performanceScope;receipt.nativeRole=['continuous','feedbackProof'].includes(receipt.measurementPhase)?'game-action':'setup-or-navigation';receipt.beforeNativeInputDOM=await handle.evaluate(tapEvaluators.readDOM,{performanceScope});}else receipt.nativeRole='player-entry';const enabled=await target.isEnabled();receipt.controlBeforeNativeInput={enabled,checkedAtEpochMs:Date.now()};if(!enabled){receipt.nativeNotSentReason='disabled-before-native-input';throw Object.assign(Error('Control disabled before native input; no gesture was sent'),{code:'ACTION_STATE_CHANGED',nativeInputSent:false});}
   const targets=await fetch('http://127.0.0.1:'+forward.port+'/json/list',{signal:AbortSignal.timeout(5000)}).then(r=>r.json()),match=targets.filter(t=>t.url===artifact.entryUrl);assert.equal(match.length,1);const box=JSON.parse(match[0].description),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollX,scrollY,visibility:document.visibilityState,focused:document.hasFocus(),visual:visualViewport?{width:visualViewport.width,height:visualViewport.height,offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop,scale:visualViewport.scale}:null}));const point=settledNativeTapGeometry({bounds:b,webview:box,viewport,position});receipt.geometry={bounds:b,webview:Object.fromEntries(['attached','visible','width','height','screenX','screenY'].map(k=>[k,box[k]])),viewport,point};
   if(active?.round.game==='run'&&receipt.measurementPhase==='feedbackProof'){assert.equal(typeof beforeNativeTapReady,'function','RUN_FEEDBACK_READY_HOOK_REQUIRED');await beforeNativeTapReady({schema:'owned-run-feedback-native-ready-v1',roundId:active.round.id,game:'run',phase:receipt.measurementPhase,nativeRole:receipt.nativeRole,performanceScope,dom:receipt.beforeNativeInputDOM});}else assert.equal(beforeNativeTapReady,null,'RUN_FEEDBACK_READY_FOREIGN_HOOK');
   key='__oasisOwnNativeTap_'+randomUUID().replaceAll('-','');receipt.authorityAtInstallation=performanceScope?tapAuthority():null;receipt.installation=await handle.evaluate(tapEvaluators.install,{key,expectedUrl,position,performanceScope,authorityAtInstallation:receipt.authorityAtInstallation});assertOwnedNativeTapInstallation(receipt.installation,{key,expectedUrl,performanceScope});receipt.installedSlot=await handle.evaluate(readOwnedNativeTapReceipt,{key,expectedUrl});assertOwnedNativeTapInstalledSlot(receipt.installedSlot,{installation:receipt.installation,key,expectedUrl,performanceScope});
   assert.equal(androidForeground(await adb('shell','dumpsys','activity','activities')),component,'OWNED_NATIVE_TAP_FOREGROUND_CHANGED');receipt.foregroundVerifiedAt=new Date().toISOString();
   receipt.nativeTiming.preparationCompletedAtEpochMs=Date.now();receipt.nativeTiming.commandDispatchedAtEpochMs=Date.now();receipt.nativeTiming.commandOutcome='pending';
   try{const native=await execute('adb',physicalAdbArgs(options,['shell','input','tap',String(point.x),String(point.y)]),{timeout:45000,maxBuffer:4*1024*1024});receipt.nativeTiming.commandCompletedAtEpochMs=Date.now();receipt.nativeTiming.commandOutcome='returned';await recordNative(native,0);}catch(error){if(receipt.nativeTiming.commandOutcome==='pending'){receipt.nativeTiming.commandCompletedAtEpochMs=Date.now();receipt.nativeTiming.commandOutcome='failed';}await recordNative(error,typeof error.code==='number'?error.code:null);throw error;}
   const deadline=Date.now()+1000;let observed;do{observed=await handle.evaluate(readOwnedNativeTapReceipt,{key,expectedUrl});if(observed.events.some(e=>e.type==='click'))break;await sleep(25);}while(Date.now()<deadline);receipt.trustedReceipt=observed;receipt.nativeTiming.trustedReceiptReadAtEpochMs=Date.now();receipt.authorityAfterReceipt=performanceScope?tapAuthority():null;receipt.authorityVersionComparison=performanceScope?{atomic:false,installationRoomVersion:receipt.authorityAtInstallation?.room?.version??null,installationRunRevision:receipt.authorityAtInstallation?.runInputs?.revision??null,clickDomRevision:observed.events.find(e=>e.type==='click')?.dom?.track?.data.revision??null,afterReceiptRoomVersion:receipt.authorityAfterReceipt?.room?.version??null,afterReceiptRunRevision:receipt.authorityAfterReceipt?.runInputs?.revision??null,source:'Original authority reads bracket the trusted DOM event asynchronously; a version difference is retained, never normalized'}:null;assertOwnedNativeTapReceipt(observed,{key,expectedUrl,performanceScope});receipt.completed=true;
  }catch(error){receipt.errors.push(redactor.clean(error.message));if(error.message==='OWNED_NATIVE_TAP_CONTROL_ENABLE_TIMEOUT'){let observationTimer;try{receipt.entryWaitObservation=await Promise.race([(async()=>{let observationHandle;try{observationHandle=await target.elementHandle({timeout:1000});assert.ok(observationHandle,'OWNED_NATIVE_TAP_ELEMENT_REQUIRED');const f=await observationHandle.ownerFrame();assert.ok(f&&!f.isDetached(),'OWNED_NATIVE_TAP_FRAME_REQUIRED');const u=f.url();assert.ok(f===page.mainFrame()&&u===artifact.entryUrl||active&&f.parentFrame()===page.mainFrame()&&u===origin+'/play/'+active.round.game,'OWNED_NATIVE_TAP_FOREIGN_FRAME');if(f!==page.mainFrame())assertOwnedPlayerArenaState(active.state,baseline);return await observationHandle.evaluate(ownedNativeTapWaitingDOM,{expectedUrl:u});}finally{try{await observationHandle?.dispose();}catch(observationError){receipt.entryWaitObservationCleanupError=redactor.clean(observationError.message);}}})(),new Promise((_,reject)=>{observationTimer=setTimeout(()=>reject(Error('OWNED_NATIVE_TAP_WAITING_DOM_TIMEOUT')),1500);})]);}catch(observationError){receipt.entryWaitObservationError=redactor.clean(observationError.message);}finally{clearTimeout(observationTimer);}}throw error;}
  finally{if(handle&&key)try{receipt.receiptCleanup=await handle.evaluate(removeOwnedNativeTapReceipt,{key,expectedUrl});}catch(error){receipt.receiptCleanupError=redactor.clean(error.message);report.resources.errors.push('OWNED_NATIVE_TAP_RECEIPT_CLEANUP: '+redactor.clean(error.message));}try{await handle?.dispose();}catch(error){receipt.elementHandleDisposeError=redactor.clean(error.message);report.resources.errors.push('OWNED_NATIVE_TAP_HANDLE_DISPOSE: '+redactor.clean(error.message));}receipt.nativeTiming.finishedAtEpochMs=Date.now();receipt.finishedAt=new Date(receipt.nativeTiming.finishedAtEpochMs).toISOString();if(receipt.measurementPhase==='entry'&&active?.round.loadTimeline)try{recordPerformanceLoadNativeTap(active.round.loadTimeline,receipt);}catch(error){receipt.loadTimelineError=redactor.clean(error.message);report.resources.errors.push('OWNED_LOAD_TIMELINE_TAP: '+receipt.loadTimelineError);}}
 };
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
  await adb('shell','am','force-stop',pkg);await adb('shell','am','start','-n',component);await until(async()=>/^\d+$/.test(await adb('shell','pidof',pkg).catch(e=>{if(e.code===1)return '';throw e;})),'OWN_QA_PID');const pid=await adb('shell','pidof',pkg),remote='localabstract:webview_devtools_remote_'+pid;
  await until(async()=>(await adb('shell','cat','/proc/net/unix')).includes('@webview_devtools_remote_'+pid),'OWN_QA_DEBUG_SOCKET');const existing=await forwards(),port=await adb('forward','tcp:0',remote);forward={serial:options.serial,port:Number(port),local:'tcp:'+port,remote};ownedAndroidForward(existing,await forwards(),forward);report.resources.events.push({event:'owned-forward-created',...forward});
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{isWebView:true,noDefaults:true,timeout:15000});assert.equal(browser.contexts().length,1);context=browser.contexts()[0];await until(()=>context.pages().length===1,'OWN_QA_SINGLE_PAGE');page=context.pages()[0];await until(()=>page.url()===artifact.entryUrl,'ACTUAL_PLAYER_ENTRY');page.setDefaultTimeout(45000);
  // Identity/authentication run before attaching any network body observer.
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('.player-lobby').waitFor();const existingLogin=await topRead('/api/player/session');
  if(existingLogin.status===200)assert.equal(existingLogin.body.player?.username,credentials.username,'INHERITED_LOGIN_PRESERVED');else{assert.equal(existingLogin.status,401);assert.equal(existingLogin.body.error?.code,'LOGIN_REQUIRED');await page.locator('input[name="username"]').fill(credentials.username);await page.locator('input[name="password"]').fill(credentials.password);const login=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/player/login'&&r.request().method()==='POST');await tap(page.getByRole('button',{name:'登录',exact:true}));assert.equal((await login).status(),200);}
  await page.locator('.player-games').waitFor();baseline=assertPlayerLobbyBaseline({metadata:await requiredRead('/api/player/app?app_id='+artifact.appId),session:await requiredRead('/api/player/session'),wallet:await requiredRead('/api/player/wallet?app_id='+artifact.appId),recovery:await requiredRead('/api/player/recovery?app_id='+artifact.appId),appId:artifact.appId,username:credentials.username});redactor.add(baseline.playerId);redactor.add(baseline.externalUserId);
  apiContext=await httpRequest.newContext({ignoreHTTPSErrors:false,timeout:12000});const nonce=randomUUID(),cacheSession=randomUUID();await context.addInitScript(installPhysicalProbe,{origin,nonce});resourceInstrumentation=await installOwnedPlayerResourceEvidence(context,{origin,entryUrl:artifact.entryUrl,games:options.games,manifest,nonce});report.resourceInstrumentation={schema:'owned-player-resource-evidence-v1',installedBeforeGamePreload:true,readsOnlyConsumedPublicImageBlob:true,refetches:false,responseCloneOrCancel:false,hashingPerturbsLoading:true,hashingAllowedDuringFrameSampling:false};report.executed=true;report.physicalDevice=true;report.webviewSessionId=cacheSession;report.inputScope='ADB native taps and CDP trusted touch drags; no JavaScript-dispatched input';report.measurementArchitecture={continuousBoundary:'Exact same-document RAF callbacks; unchanged thresholds; all raw intervals retained',screenshotsDuringContinuousSample:false,visualProof:'Separate before/after screenshot phases with their complete own RAF observations',visibleFeedbackProof:'Independent before-continuous original PNG screencast phase; exact same-realm trusted gesture and unique accepted command; all phase RAF and raw PNG files retained; exact provider source receipt governs capture-time upper bound; swap and physical panel presentation remain unproven',actions:'Only accepted gestures, request dispatch and complete authority response wholly inside the continuous interval contribute to latency and interaction gates; feedback proof inputs and all other accepted actions retained by their own phases'};
  // Use the PNG decoder already shipped by the pinned Playwright dependency.
  const decoderPath=join(dirname(require.resolve('playwright-core')),'lib/utilsBundle.js'),{PNG}=require(decoderPath);assert.ok(typeof PNG?.sync?.read==='function','PNG_DECODER_UNAVAILABLE');report.motionDecoder={source:'Installed Playwright bundled PNG decoder',sha256:hash(await readFile(decoderPath))};
  const primed=new Set();
  for(const item of cacheSchedule(options.games,options.repetitions)){
   const{game,cacheMode,iteration}=item;assert.deepEqual(parseWebViewProvider(await adb('shell','dumpsys','webviewupdate')),beforeState.webview,'SYSTEM_PROVIDER_CHANGED');assert.equal(await adb('shell','pidof',pkg),pid,'OWNED_WEBVIEW_PID_CHANGED');assert.deepEqual((await requiredRead('/api/player/recovery?app_id='+artifact.appId)).sessions,[],'INHERITED_OBLIGATIONS_PRESERVED');
   const round={id:game+'-'+cacheMode+'-'+iteration,game,cacheMode,iteration,passed:false,entry:null,actions:[],measurementPhase:'entry',motion:{pairs:[],method:'Actual decoded scene pixels in separate before/after proof phases; full proof RAF intervals retained. Continuous RAF uses exact start/end callback timestamps and contains no screenshots.'},observerErrors:[]};report.rounds.push(round);
   const state={game,token:null,sessionId:null,playerId:null,appId:null,room:null,ownedRooms:new Set(),practiceRequested:false,spins:[],acks:new Set(),returning:false,phase:'entry'},result={game,observer_errors:[]};
   const observer=ownedObserver(page,{origin,state,result,clean:redactor.clean,remember:body=>{redactor.remember(body);if(body.access_token){assert.equal(body.scope?.app_id,baseline.appId);assert.equal(body.external_user_id,baseline.externalUserId);state.appId=body.scope.app_id;}}});
   let collector,touch,sampling=false,samplingPump,pumpError;active={state,result,observer,collector:null,round,nonce,nativeTaps:[]};
   try{
    collector=await createPhysicalNetworkCollector({context,page,origin,game,state,baseline,manifest,nonce,round,entryUrl:artifact.entryUrl});active.collector=collector;
    round.cache={sessionId:cacheSession,cacheDisabled:false,routing:false,cookiesCleared:false,httpCacheCleared:cacheMode==='cold',mainDocumentReloaded:false,sameContext:true,primed:primed.has(game),passed:false};
    round.lobbyReadiness={};await preparePerformanceLobbyForEntry({cacheMode,diagnostic:round.lobbyReadiness,waitLobby:(stage,diagnostic)=>waitForPerformanceLobbyWallet({page,cdp:collector.cdp,artifact,baseline,stage,diagnostic}),reloadCold:async()=>{await collector.clearOwnHttpCache();await page.reload({waitUntil:'domcontentloaded'});await page.locator('.player-games').waitFor();round.cache.mainDocumentReloaded=true;}});
    assert.equal(page.url(),artifact.entryUrl,'PLAYER_DOCUMENT_CHANGED');if(cacheMode==='cold')await collector.clearOwnHttpCache();const start=Date.now();round.startedAt=new Date(start).toISOString();round.loadTimeline=createPerformanceLoadTimeline({roundId:round.id,game,nonce,entryUrl:artifact.entryUrl,startEpochMs:start});await tap(page.locator('.player-game-card').filter({has:page.getByText(ARENA_GAMES[game].name,{exact:true})}));
    await until(()=>Boolean(state.token&&state.sessionId),'ACTUAL_LAUNCH_EXCHANGE');await until(()=>page.frames().some(f=>f.url()===origin+'/play/'+game),'ACTUAL_GAME_IFRAME');const frame=page.frames().find(f=>f.url()===origin+'/play/'+game);assert.equal(await page.locator('iframe').count(),1);
    const probe=await readInitialPerformanceProbe({collector,round,origin,game,nonce});round.documentId=probe.documentId;round.documentTimeOrigin=probe.timeOrigin;round.context=await collector.bind();round.sessionIdHash=hash(state.sessionId);round.loadTimeline.gameDocument={nonce,documentId:round.documentId,timeOrigin:round.documentTimeOrigin,url:round.context.url,frameId:round.context.frameId,contextId:round.context.contextId};
    const read=createNativeCleanupApi({page:{request:apiContext},origin,state,result,clean:redactor.clean});assertAndroidSessionBaseline(state,await read('/api/arena/session'),ARENA_IDS);assertOwnedPlayerArenaState(state,baseline);
    state.phase='playing';state.practiceRequested=true;await tap(frame.getByRole('button',{name:'免费练习',exact:false}));await tap(frame.getByRole('button',{name:'确认规则 · 准备开局',exact:true}));await until(()=>state.room?.status==='active','OWN_FREE_BOT_ACTIVE');assertPerformanceRoom(state.room,{game,baseline,ownedRooms:state.ownedRooms});redactor.add(state.room.id);round.roomIdHash=hash(state.room.id);
    await capturePerformanceEntryTiming({round,collector,frame,game,state});
    touch=playerTouchFrame(frame,{tap,touch:async(type,x,y)=>collector.cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y,id:1}],modifiers:0})});
    let previousRoom=state.room,receipt=Date.now(),nextAction=0,lastCursor=authorityCursor(game,state.room);
    const readMotion=()=>{assertPerformanceRoom(state.room,{game,baseline,ownedRooms:state.ownedRooms});if(state.room!==previousRoom){previousRoom=state.room;receipt=Date.now();}return activeMotionState(game,state.room,Date.now()-receipt);};
    const captureMotion=phase=>capturePerformanceMotionPhase({phase,round,collector,target:frame.locator(sceneSelectors[game]).first(),decode:data=>PNG.sync.read(data),readMotion,readAuthority:()=>failureAuthority(state,{game,baseline}),origin,game,nonce,writePair:async(index,a,b)=>{await writeFile(join(out,round.id+'-motion-'+index+'-a.png'),a,{mode:0o600,flag:'wx'});await writeFile(join(out,round.id+'-motion-'+index+'-b.png'),b,{mode:0o600,flag:'wx'});}});
    round.measurementPhase='before';await captureMotion('before');
    if(game==='run'){
     const feedback=await capturePerformanceVisibleFeedbackPhase({round,collector,origin,nonce,topUrl:artifact.entryUrl,protocol:feedbackProtocol,implementation:feedbackImplementation,webviewVersion:report.device.webview.version,readTop:(fn,args)=>page.evaluate(fn,args),waitEnabled:()=>waitForOwnedNativeTapEnabled({read:async()=>({visible:await frame.getByTestId('run-jump').isVisible(),enabled:await frame.getByTestId('run-jump').isEnabled()}),evidence:{}}),runAction:async beforeNativeTapReady=>{const deadlineAt=Date.now()+3000,feedbackTouch=playerTouchFrame(frame,{tap:(target,args)=>tap(target,{...args,beforeNativeTapReady:async input=>{await beforeNativeTapReady(input);if(Date.now()>=deadlineAt)throw Object.assign(Error('run: action deadline exceeded (native feedback ready)'),{code:'ACTION_DEADLINE',nativeInputSent:false});}}),touch:async(type,x,y)=>collector.cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y,id:1}],modifiers:0})});try{return await playOneArenaAction(feedbackTouch.frame,'run',()=>state.room,{touch:true,timeoutMs:3000,deadlineAt,beforeAction:()=>assertPerformanceRoom(state.room,{game,baseline,ownedRooms:state.ownedRooms})});}finally{await feedbackTouch.release();}},drainOriginal:async()=>{await collector.drain();await observer.drain({final:false});},readAuthority:()=>failureAuthority(state,{game,baseline}),writeFrame:async(index,bytes,pin)=>{const name=round.id+'-feedback-frame-'+String(index).padStart(4,'0')+'.png';await writeFile(join(out,name),bytes,{mode:0o600,flag:'wx'});return {path:name,sha256:hash(bytes),bytes:bytes.length};}});if(feedback.uiAction)lastCursor=feedback.uiAction.sequenceAfter;
    }else{
     const feedback=await capturePerformanceVisibleFeedbackPhase({round,collector,origin,nonce,topUrl:artifact.entryUrl,protocol:feedbackProtocol,implementation:feedbackImplementation,webviewVersion:report.device.webview.version,readTop:(fn,args)=>page.evaluate(fn,args),arenaFrame:touch.frame,readRoom:()=>state.room,locale:'zh',runAction:inputFrame=>playOneArenaAction(inputFrame,game,()=>state.room,{touch:true,timeoutMs:8000,deadlineAt:Date.now()+8000,beforeAction:()=>assertPerformanceRoom(state.room,{game,baseline,ownedRooms:state.ownedRooms})}),drainOriginal:async()=>{await collector.drain();await observer.drain({final:false});},readAuthority:()=>failureAuthority(state,{game,baseline}),writeFrame:async(index,bytes)=>{const name=round.id+'-feedback-frame-'+String(index).padStart(4,'0')+'.png';await writeFile(join(out,name),bytes,{mode:0o600,flag:'wx'});return {path:name,sha256:hash(bytes),bytes:bytes.length};}});const last=feedback.uiAction??feedback.preparatoryUiActions?.at(-1);if(last)lastCursor=last.sequenceAfter;
    }
    await continuousSampleBoundary({stage:'start',round,collector,state,baseline,origin,game,nonce,motion:readMotion()});const began=round.sampleBoundaries.start.epochMs,windowMs=Math.max(options.roomMs,Math.ceil(options.sampleMs/(options.repetitions*2))),deadline=began+windowMs;
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
     if(status==='active'&&Date.now()>=nextAction&&canExercise(game,state.room)&&authorityCursor(game,state.room)>=lastCursor&&deadline-Date.now()>=3000){
      const before=state.room;try{const action=await playOneArenaAction(touch.frame,game,()=>state.room,{touch:true,timeoutMs:Math.min(8000,deadline-Date.now()),deadlineAt:deadline,beforeAction:()=>assertPerformanceRoom(state.room,{game,baseline,ownedRooms:state.ownedRooms})});assert.equal(action.sequenceBefore,authorityCursor(game,before),'DECLARED_CURSOR_CHANGED_BEFORE_UI');lastCursor=action.sequenceAfter;round.trustedUiActions??=[];round.trustedUiActions.push({type:action.actionType,protocol:action.protocol||'arena-action-v1',cursorBefore:action.sequenceBefore,cursorAfter:action.sequenceAfter});}
      catch(error){round.rejectedUiActions??=[];round.rejectedUiActions.push({status:error.status||null,code:error.code||null,nativeInputSent:error.nativeInputSent??null,message:redactor.clean(error.message)});if(!(error.code==='ACTION_STATE_CHANGED'&&error.nativeInputSent===false)&&!(error.status===409&&['BUSY','STALE_INPUT','INPUT_PENDING','RATE_LIMIT','NOT_YOUR_TURN','TURN_EXPIRED','NOT_ACTIVE'].includes(error.code)))throw error;}
      nextAction=Date.now()+1000;
     }
     await sleep(100);
    }
    sampling=false;await samplingPump;if(pumpError)throw pumpError;await touch.release();await continuousSampleBoundary({stage:'end',round,collector,state,baseline,origin,game,nonce,motion:readMotion()});await captureMotion('after');await collector.drain();await collector.verifyResourceEvidence({finish:true});await observer.drain({final:false});
    round.renderers=await frame.evaluate(()=>[...document.querySelectorAll('[data-render-calls],[data-render-quality],[data-art-quality]')].map(e=>({tag:e.tagName,data:Object.fromEntries(Object.entries(e.dataset).filter(([key])=>/render|triangle|quality|capture|sceneReady/i.test(key)))})));
    state.returning=true;state.phase='returning';await adb('shell','input','keyevent','4');await sleep(200);const leave=frame.getByRole('button',{name:'确认离开',exact:true});if(!frame.isDetached()&&await leave.isVisible())await tap(leave);const confirm=frame.locator('[data-return="confirm"]');if(!frame.isDetached()&&await confirm.isVisible())await tap(confirm);await page.locator('.player-games').waitFor();assert.equal(await page.locator('iframe').count(),0);round.returned=true;round.uiStopped=true;
    await collector.drain();Object.assign(round.cache,collector.cacheFacts());try{assertCachePosture(round.cache,{mode:cacheMode,sessionId:cacheSession});round.cache.passed=true;}catch(error){round.cache.error=redactor.clean(error.message);}
   }catch(error){await capturePerformanceRoundFailure({round,error,collector,state,baseline,origin,game,nonce,nativeTaps:active.nativeTaps,clean:redactor.clean});}
   finally{sampling=false;await samplingPump;try{await touch?.release();}catch(error){round.observerErrors.push(redactor.clean(error.message));}await cleanup();round.finishedAt=new Date().toISOString();await save();}
   assertPerformanceRoundContinuation(round);assert.ok(page&&!page.isClosed()&&await page.locator('.player-games').isVisible(),'RETAINED_PLAYER_CONTEXT_LOST');assert.deepEqual((await requiredRead('/api/player/recovery?app_id='+artifact.appId)).sessions,[],'OWN_OBLIGATION_REMAINS');assertPlayerZeroWallet(await requiredRead('/api/player/wallet?app_id='+artifact.appId),artifact.appId,baseline);if(round.returned&&round.network?.records?.length&&!round.error)primed.add(game);
  }
  report.games=options.games.map(game=>evaluateAndroidPerformance(game,report.rounds.filter(r=>r.game===game),standards.thresholds,{sampleMs:options.sampleMs,networkCalibrated:false}));report.status=report.games.some(g=>g.status==='fail')?'fail':'partial';
 }catch(error){report.failure=redactor.clean(error.message);report.status='fail';}
 finally{
  await cleanup();
  try{await apiContext?.dispose();}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  try{await resourceInstrumentation?.dispose();}catch(error){report.resources.errors.push('RESOURCE_INIT_DISPOSE: '+redactor.clean(error.message));}
  try{await browser?.close();}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  if(forward)try{assert.deepEqual((await forwards()).filter(r=>r.local===forward.local),[{serial:forward.serial,local:forward.local,remote:forward.remote}]);await adb('forward','--remove',forward.local);report.resources.events.push({event:'owned-forward-removed',local:forward.local});}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  if(ownedStarted)try{await adb('shell','am','force-stop',pkg);if(foreground){await adb('shell','am','start','-n',foreground);report.resources.foregroundRestoreEvidence={};const restored=await waitForOriginalAndroidForeground({read:()=>adb('shell','dumpsys','activity','activities'),expected:foreground,evidence:report.resources.foregroundRestoreEvidence});report.resources.foregroundRestoredHash=hash(restored);}}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  if(beforeForwards)try{assertAndroidForwardsRestored(beforeForwards,await forwards());report.resources.forwardsRestored=true;}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  if(report.device)try{report.device.thermalAfter=parseThermal(await adb('shell','dumpsys','thermalservice'));assert.deepEqual(parseWebViewProvider(await adb('shell','dumpsys','webviewupdate')),beforeState.webview||report.device.webview);}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  try{const finalSources=Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,hash(await readFile(join(ROOT,path)))])));assert.deepEqual(finalSources,sources,'MEASUREMENT_SOURCE_CHANGED');report.runtimeSources.after=await assertRuntimeSources(ROOT,runtimePins);assert.equal(hash(await readFile(manifestPath)),report.releaseManifestSha256,'RELEASE_MANIFEST_CHANGED');}catch(error){report.resources.errors.push(redactor.clean(error.message));}
  if(report.executed)report.games=options.games.map(game=>evaluateAndroidPerformance(game,report.rounds.filter(r=>r.game===game),standards.thresholds,{sampleMs:options.sampleMs,networkCalibrated:false}));
  report.observedCatalog=[...new Set(report.rounds.filter(r=>r.roomIdHash).map(r=>r.game))];report.catalogComplete=report.fullCatalog&&report.observedCatalog.length===ARENA_IDS.length;finalizePerformanceStatus(report,{shortDiagnostic:options.shortDiagnostic});report.finishedAt=new Date().toISOString();await save();
 }
 return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const options=performanceArguments(process.argv.slice(2),standards.thresholds),report=await runAndroidPerformance(options);console.log(JSON.stringify({schema:report.schema,output:options.output,executed:report.executed,status:report.status,passed:report.passed,games:report.games.map(g=>({game:g.game,status:g.status}))},null,2));process.exitCode=report.passed||report.preflightPassed?0:report.status==='fail'?1:2;}
