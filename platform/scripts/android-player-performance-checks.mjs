/** Actual Android WebView performance checks. No ADB, browser, HTTP or fetch wrapper. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ARENA_IDS} from '../shared/games.mjs';
import {statistics,percentile} from './mobile-quality-metrics.mjs';
import {runPracticeInputBaseline,verifyRunPracticeInputAction} from './android-game-actions.mjs';
import {VISIBLE_FEEDBACK_PROTOCOL_SHA256,assertVisibleFeedbackImplementation} from './android-player-visible-feedback.mjs';

export const ANDROID_PERFORMANCE_SCHEMA='android-physical-performance-v1';
export const PRIORITY_GAMES=Object.freeze(['run','towerlink','golf','bowling']);
export const hash=value=>createHash('sha256').update(value).digest('hex');
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const exact=(value,keys)=>value&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

/** Release manifests use repository paths; ROOT in the collector is platform/. */
export function runtimeSourcePins(inputs,{games=ARENA_IDS}={}){
 assert.ok(inputs&&typeof inputs==='object'&&!Array.isArray(inputs),'RUNTIME_INPUT_PINS_REQUIRED');
 assert.ok(games.length&&games.every(game=>ARENA_IDS.includes(game)),'RUNTIME_GAMES_REQUIRED');
 const selected={};
 for(const [name,digest]of Object.entries(inputs)){
  if(!/^platform\/(?:arena|shared)\//.test(name))continue;
  const relative=name.slice('platform/'.length),parts=relative.split('/');
  assert.ok(parts.every(part=>part!==''&&part!=='.'&&part!=='..'&&!part.includes('\\')&&!part.includes('\0')),'UNSAFE_RUNTIME_INPUT_PATH');
  assert.match(digest,/^[a-f0-9]{64}$/,'RUNTIME_INPUT_SHA_REQUIRED');
  assert.ok(!parts.includes('dist')&&!parts.includes('node_modules'),'RUNTIME_INPUT_IS_GENERATED');
  selected[relative]=digest;
 }
 const required=['arena/main.jsx','arena/index.html','arena/shared/client.mjs','shared/games.mjs','shared/run-practice-profiles.mjs',...games.map(game=>'arena/'+game+'/engine.mjs')];
 for(const path of required)assert.ok(Object.hasOwn(selected,path),'RUNTIME_INPUT_PIN_MISSING: '+path);
 return selected;
}

export function finalizePerformanceStatus(report,{shortDiagnostic=false}={}){
 report.resources.passed=report.resources.errors.length===0;
 const failed=!!report.failure||!report.resources.passed||report.games.some(game=>game.status==='fail')||report.rounds.some(round=>!!round.error||round.cleanup?.passed===false);
 report.passed=!failed&&report.executed===true&&report.physicalDevice===true&&report.catalogComplete===true&&report.games.length===ARENA_IDS.length&&report.games.every(game=>game.passed===true)&&!shortDiagnostic;
 report.status=failed?'fail':report.passed?'pass':'partial';
 return report.status;
}

export function performanceArguments(argv,thresholds){
 const options={run:false,adbPort:5037,serial:'46dcfd25',games:[...ARENA_IDS],sampleMs:thresholds.minimum_active_sample_ms,repetitions:thresholds.entry_repetitions,roomMs:60000};
 const keys={'--metadata':'metadata','--platform-manifest':'platformManifest','--credentials-file':'credentialsFile','--apksigner':'apksigner','--output':'output','--adb-port':'adbPort','--serial':'serial','--games':'games','--sample-ms':'sampleMs','--room-ms':'roomMs','--repetitions':'repetitions','--feedback-protocol':'feedbackProtocolFile','--feedback-source-dir':'feedbackSourceDir'};
 const seen=new Set();for(let i=0;i<argv.length;i++){const flag=argv[i];assert.ok(!seen.has(flag),'DUPLICATE_ARGUMENT');seen.add(flag);if(flag==='--run'){options.run=true;continue;}assert.ok(keys[flag],'UNKNOWN_ARGUMENT');const value=argv[++i];assert.ok(value&&!value.startsWith('--'),'ARGUMENT_VALUE_REQUIRED');options[keys[flag]]=value;}
 for(const key of ['metadata','platformManifest','apksigner','output'])assert.ok(options[key],key.toUpperCase()+'_REQUIRED');
 for(const key of ['adbPort','sampleMs','roomMs','repetitions']){options[key]=Number(options[key]);assert.ok(Number.isSafeInteger(options[key]),'INTEGER_ARGUMENT_REQUIRED');}
 assert.equal(options.adbPort,5037,'AUTHORIZED_ADB_PORT_REQUIRED');assert.equal(options.serial,'46dcfd25','AUTHORIZED_PHYSICAL_SERIAL_REQUIRED');
 assert.ok(options.sampleMs>=1000&&options.sampleMs<=900000,'SAMPLE_MS_OUT_OF_RANGE');assert.ok(options.roomMs>=1000&&options.roomMs<=900000,'ROOM_MS_OUT_OF_RANGE');assert.ok(options.repetitions>=1&&options.repetitions<=20,'REPETITIONS_OUT_OF_RANGE');
 if(typeof options.games==='string')options.games=options.games==='priority'?[...PRIORITY_GAMES]:options.games.split(',');
 assert.ok(options.games.length&&new Set(options.games).size===options.games.length&&options.games.every(game=>ARENA_IDS.includes(game)),'ONLY_ADMITTED_ARENA_GAMES');
 if(options.run)assert.ok(options.credentialsFile,'PRIVATE_CREDENTIAL_FILE_REQUIRED');
 options.fullCatalog=options.games.length===ARENA_IDS.length;options.shortDiagnostic=options.sampleMs<thresholds.minimum_active_sample_ms||options.repetitions<thresholds.entry_repetitions;return options;
}

export function physicalAdbArgs(options,args){assert.equal(options.adbPort,5037);assert.equal(options.serial,'46dcfd25');return ['-H','127.0.0.1','-P','5037','-s','46dcfd25',...args];}
export function parseWebViewProvider(text){const match=text.match(/Current WebView package \(name, version\): \(([A-Za-z0-9_.]+), ([0-9.]+)\)/);assert.ok(match,'SYSTEM_WEBVIEW_PROVIDER_UNPROVEN');assert.match(text,/WebView package dirty:\s*false/,'SYSTEM_WEBVIEW_PROVIDER_DIRTY');assert.match(text,/Any WebView package installed:\s*true/,'SYSTEM_WEBVIEW_PROVIDER_MISSING');return {packageName:match[1],version:match[2]};}
export function parseThermal(text){const value=text.match(/Thermal Status:\s*(\d+)/);return value?{available:true,status:Number(value[1])}:{available:false,status:null};}
export function parseRefresh(text){const value=text.match(/mActiveSfDisplayMode=.*?peakRefreshRate=([0-9.]+).*?vsyncRate=([0-9.]+)/);return value?{available:true,peakHz:Number(value[1]),vsyncHz:Number(value[2])}:{available:false,peakHz:null,vsyncHz:null};}

export function assertGameContext({tree,contexts,origin,game,topUrl}){
 assert.equal(new URL(origin).protocol,'https:','ACTUAL_HTTPS_REQUIRED');assert.equal(tree.frame.url,topUrl,'PLAYER_MAIN_DOCUMENT_CHANGED');
 const rows=[];const visit=node=>{for(const child of node.childFrames||[]){if(child.frame.url===origin+'/play/'+game)rows.push(child);visit(child);}};visit(tree);
 assert.equal(rows.length,1,'EXACTLY_ONE_GAME_FRAME_REQUIRED');const frame=rows[0].frame;assert.equal(frame.parentId,tree.frame.id,'DIRECT_PLAYER_GAME_FRAME_REQUIRED');
 const realms=contexts.filter(row=>row.auxData?.isDefault===true&&row.auxData.frameId===frame.id&&row.origin===origin);assert.equal(realms.length,1,'EXACT_GAME_DEFAULT_EXECUTION_CONTEXT_REQUIRED');return {frameId:frame.id,contextId:realms[0].id,url:frame.url};
}

export function authorityCursor(game,room){return game==='run'&&runPracticeInputBaseline(room)?runPracticeInputBaseline(room).commandSeq:room?.me_last_seq;}
export function assertPerformanceRoom(room,{game,baseline,ownedRooms}){
 assert.equal(room?.game_id,game,'GAME_CHANGED');assert.equal(room.me,baseline.externalUserId,'PLAYER_CHANGED');assert.ok(ownedRooms.has(room.id),'UNOWNED_ROOM_PRESERVED');assert.equal(room.practice,true);assert.equal(room.entry_minor,'0');assert.equal(room.fee_bps,0,'ZERO_FEE_REQUIRED');
 const roster=Array.isArray(room.players)?room.players.map(p=>({key:p.external_user_id,isBot:p.bot})):Array.isArray(room.game?.players)?room.game.players:Object.values(room.game?.players||{});assert.ok(roster.length>=2&&new Set(roster.map(p=>p.key)).size===roster.length&&roster.every(p=>typeof p.key==='string'&&typeof p.isBot==='boolean')&&roster.filter(p=>p.isBot===false).length===1&&roster.find(p=>p.key===room.me)?.isBot===false&&roster.every(p=>p.key===room.me||p.isBot===true),'EXPLICIT_FREE_BOT_ROSTER_REQUIRED');return room;
}

export function activeMotionState(game,room,receiptAgeMs=0){
 const g=room?.game||{},players=Array.isArray(g.players)?g.players:Object.values(g.players||{}),me=g.me&&typeof g.me==='object'?g.me:players.find(p=>p.key===room.me),now=room?.server_now;
 const active=receiptAgeMs<=1000&&finite(now)&&room?.status==='active'&&g.status!=='finished'&&!['fault','intermission','arming','countdown'].includes(g.phase)&&!(now<(g.startedAt||0))&&!g.forfeited&&!me?.forfeited&&!me?.completed&&!me?.eliminated&&me?.finishTick==null;
 if(!active)return {active:false,moving:false,reason:receiptAgeMs>1000?'authority-stale':'not-active'};
 const busy=[g.busyUntil,me?.busyUntil,...players.map(p=>p.busyUntil)].some(t=>finite(t)&&t>now);
 const moving=game==='run'?['racing','finish-window'].includes(g.phase)&&me?.fallUntilTick==null:game==='towerlink'?(g.armies||[]).some(a=>a.count>0&&a.departedAt<=now&&a.arrivesAt>now):busy;
 return {active:true,moving,reason:moving?'declared-authority-motion':'active-idle'};
}

export function acceptedPerformanceAction({game,before,request,after,status,gesture,startedAt,finishedAt}){
 assert.ok(status>=200&&status<300,'AUTHORITY_ACTION_REJECTED');assert.ok(gesture?.trusted===true&&finite(gesture.completedEpochMs)&&startedAt>=gesture.completedEpochMs&&startedAt-gesture.completedEpochMs<1000,'TRUSTED_GESTURE_BINDING_REQUIRED');
 assert.ok(finite(startedAt)&&finite(finishedAt)&&finishedAt>=startedAt,'ACTION_TIMING_UNPROVEN');
 let proof;const cursor=authorityCursor(game,before);
 if(game==='run'&&runPracticeInputBaseline(before))proof=verifyRunPracticeInputAction(runPracticeInputBaseline(before),request,after,{type:request.commands?.[0]?.type});
 else{assert.equal(request.seq,cursor+1);assert.equal(after.id,before.id);assert.equal(after.game_id,game);assert.equal(after.me,before.me);assert.equal(after.me_last_seq,request.seq);assert.ok(after.status!=='fault'&&after.game?.phase!=='fault');proof={sequence:request.seq,type:request.action?.type};}
 return {accepted:true,protocol:proof.protocol||'arena-action-v1',cursorBefore:cursor,cursorAfter:authorityCursor(game,after),dispatchMs:startedAt-gesture.completedEpochMs,confirmMs:finishedAt-startedAt,gestureType:gesture.pointerType,proof};
}

/** Lives only in the measured game's default realm; deliberately never touches fetch. */
export function installPhysicalProbe({origin,nonce}){
 if(location.origin!==origin||!/^\/play\/[a-z]+$/.test(location.pathname))return;
 if(globalThis.__oasisPhysicalPerf)throw Error('PERFORMANCE_PROBE_ALREADY_PRESENT');
 performance.setResourceTimingBufferSize(10000);
 const probe=globalThis.__oasisPhysicalPerf={schema:'android-physical-performance-v1',nonce,documentId:Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join(''),url:location.href,timeOrigin:performance.timeOrigin,frames:[],longTasks:[],gestures:[],visibility:[],dropped:0,active:false,moving:false,validUntil:0,stopped:false,longTaskSupported:typeof PerformanceObserver==='function'&&PerformanceObserver.supportedEntryTypes.includes('longtask')};
 let last,raf,changed=false,observer;const pointers=new Map(),listeners=[];
 const on=(target,event,fn)=>{target.addEventListener(event,fn,true);listeners.push(()=>target.removeEventListener(event,fn,true));};
 on(document,'visibilitychange',()=>{changed=true;probe.visibility.push({at:performance.now(),state:document.visibilityState});if(document.hidden)pointers.clear();});
 on(document,'pointerdown',e=>{if(e.isPrimary===false){pointers.clear();return;}if(e.isTrusted)pointers.set(e.pointerId,e.pointerType);});
 for(const event of ['pointercancel','lostpointercapture'])on(document,event,e=>pointers.delete(e.pointerId));on(window,'blur',()=>pointers.clear());
 on(document,'pointerup',e=>{const type=pointers.get(e.pointerId);pointers.delete(e.pointerId);if(type&&e.isTrusted){if(probe.gestures.length<10000)probe.gestures.push({trusted:true,pointerType:type,completedEpochMs:performance.timeOrigin+performance.now()});else probe.dropped++;}});
 const tick=t=>{if(last!==undefined){const eligible=Math.max(0,Math.min(t,probe.validUntil)-last);if(probe.frames.length<250000)probe.frames.push({at:t,ms:t-last,visible:!changed&&document.visibilityState==='visible',active:probe.active&&last<=probe.validUntil,moving:probe.moving&&last<=probe.validUntil,eligibleDurationMs:eligible});else probe.dropped++;}last=t;changed=false;if(!probe.stopped)raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);
 if(probe.longTaskSupported){observer=new PerformanceObserver(list=>{for(const e of list.getEntries()){if(probe.longTasks.length<20000)probe.longTasks.push({at:e.startTime,ms:e.duration});else probe.dropped++;}});observer.observe({type:'longtask',buffered:true});}
 Object.defineProperty(probe,'stop',{value:()=>{probe.stopped=true;cancelAnimationFrame(raf);observer?.disconnect();for(const remove of listeners)remove();pointers.clear();}});
}

export function verifyProbe(value,{origin,game,nonce,documentId=null}){assert.equal(value?.schema,ANDROID_PERFORMANCE_SCHEMA);assert.equal(value.nonce,nonce,'PROBE_OWNER_CHANGED');assert.equal(value.url,origin+'/play/'+game,'PROBE_GAME_DOCUMENT_CHANGED');assert.ok(/^[a-f0-9]{32}$/.test(value.documentId||''),'PROBE_DOCUMENT_ID_REQUIRED');if(documentId)assert.equal(value.documentId,documentId,'PROBE_DOCUMENT_REPLACED');assert.ok(finite(value.timeOrigin)&&Array.isArray(value.frames)&&Array.isArray(value.longTasks)&&Array.isArray(value.gestures),'PROBE_DATA_REQUIRED');assert.ok(value.frames.length<=250000&&value.longTasks.length<=20000&&value.gestures.length<=10000,'PROBE_BOUND_EXCEEDED');assert.ok(value.frames.every(r=>finite(r.at)&&finite(r.ms)&&r.ms>0&&r.ms<=900000&&typeof r.visible==='boolean'&&typeof r.active==='boolean'&&typeof r.moving==='boolean'),'INVALID_FRAME_OBSERVATION');return value;}

/** PNG decode belongs to the runner. This check compares decoded pixels, never compressed hashes. */
export function pixelDifference(a,b){
 assert.ok(a&&b&&Number.isSafeInteger(a.width)&&a.width>0&&a.width<=4096&&Number.isSafeInteger(a.height)&&a.height>0&&a.height<=4096,'BOUNDED_IMAGE_REQUIRED');assert.equal(a.width,b.width,'MOTION_IMAGE_WIDTH_CHANGED');assert.equal(a.height,b.height,'MOTION_IMAGE_HEIGHT_CHANGED');assert.equal(a.data.length,a.width*a.height*4);assert.equal(b.data.length,a.data.length);
 let changed=0,totalDelta=0;for(let i=0;i<a.data.length;i+=4){const delta=Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2]);totalDelta+=delta;if(delta>=12)changed++;}
 return {pixels:a.width*a.height,changedPixels:changed,changedPercent:changed/(a.width*a.height)*100,meanRgbDelta:totalDelta/(a.width*a.height*3),pixelShaBefore:hash(a.data),pixelShaAfter:hash(b.data),moved:changed>=Math.max(4,Math.ceil(a.width*a.height*.0001))};
}

export function cacheSchedule(games,repetitions){const rows=[];for(const game of games)for(const mode of ['cold','warm'])for(let iteration=1;iteration<=repetitions;iteration++)rows.push({game,cacheMode:mode,iteration});return rows;}
export function assertCachePosture(posture,{mode,sessionId}){
 assert.equal(posture?.sessionId,sessionId,'WEBVIEW_CACHE_SESSION_CHANGED');assert.equal(posture.cacheDisabled,false,'HTTP_CACHE_DISABLED_REFUSED');assert.equal(posture.routing,false,'ROUTED_LOADING_REFUSED');assert.equal(posture.cookiesCleared,false,'REAL_LOGIN_COOKIE_CLEAR_REFUSED');
 if(mode==='cold'){assert.equal(posture.httpCacheCleared,true,'COLD_CACHE_NOT_CLEARED');assert.equal(posture.mainDocumentReloaded,true,'COLD_DOCUMENT_NOT_RELOADED');assert.equal(posture.diskCacheSeen,false,'COLD_ENTRY_USED_DISK_CACHE');assert.equal(posture.memoryCacheSeen,false,'COLD_ENTRY_USED_MEMORY_CACHE');}
 else{assert.equal(posture.httpCacheCleared,false,'WARM_CACHE_CLEARED');assert.equal(posture.sameContext,true,'RETAINED_WARM_CONTEXT_REQUIRED');assert.equal(posture.primed,true,'WARM_CACHE_NOT_PRIMED');assert.equal(posture.reuseObserved,true,'WARM_CACHE_REUSE_UNPROVEN');}
 return posture;
}

export function summarizeFrames(rounds){
 const sampled=round=>row=>(!round.visibleFeedbackPhases?.length||finite(round.probe?.sampleStartAt))&&(!finite(round.probe?.sampleStartAt)||row.at>round.probe.sampleStartAt)&&(!finite(round.probe?.sampleEndAt)||row.at<=round.probe.sampleEndAt);
 const rows=rounds.flatMap(round=>(round.probe?.frames||[]).filter(sampled(round)).map(row=>{const start=Math.max(row.at-row.ms,round.probe?.sampleStartAt??-Infinity),end=Math.min(row.at,round.probe?.sampleEndAt??Infinity),eligibleEnd=Math.min(row.at-row.ms+(row.eligibleDurationMs??row.ms),end);return {...row,sampledDurationMs:Math.max(0,end-start),activeDurationMs:Math.max(0,eligibleEnd-start)};})).filter(row=>row.visible===true),active=rows.filter(row=>row.active===true),moving=active.filter(row=>row.moving===true);
 const duration=row=>row.activeDurationMs;
 return {foreground:statistics(rows.map(r=>r.ms)),active:statistics(active.map(r=>r.ms)),moving:statistics(moving.map(r=>r.ms)),foregroundMs:rows.reduce((s,r)=>s+r.sampledDurationMs,0),activeMs:active.reduce((s,r)=>s+duration(r),0),movingMs:moving.reduce((s,r)=>s+duration(r),0),idleMs:active.filter(r=>!r.moving).reduce((s,r)=>s+duration(r),0),dropped:rounds.reduce((s,r)=>s+(r.probe?.dropped||0),0),longTaskSupported:rounds.length>0&&rounds.every(r=>r.probe?.longTaskSupported===true),longTasks:statistics(rounds.flatMap(r=>(r.probe?.longTasks||[]).filter(sampled(r))).map(r=>r.ms))};
}

/** Only complete causal original-pixel proof can satisfy the standard's local
 * response limit. This capture-time upper bound does not claim OS/optical present. */
export function summarizeVisibleFeedback(rounds,thresholdMs){
 const phases=rounds.flatMap(r=>(r.visibleFeedbackPhases??[]).map(phase=>({round:r,phase})));if(!phases.length)return {status:'unmeasured',captureStatus:'unmeasured',swapStatus:'unmeasured',count:0,p95UpperBoundMs:null,physicalPanelPresent:false,reason:'No independent original-pixel feedback proof phase was observed'};
 const verified=phases.filter(({round,phase:p})=>{
  const a=p.analysis,s=p.capture?.scope,first=p.capture?.frames?.find(f=>f.index===a?.firstFeedbackFrame?.index);try{assertVisibleFeedbackImplementation(p.capture?.implementation,p.capture?.webviewVersion);}catch{return false;}return round.game==='run'&&p.schema==='owned-performance-visible-feedback-phase-v1'&&p.phase==='feedbackProof'&&p.position==='beforeContinuous'&&p.finalized===true&&!p.errors?.length&&p.capture?.closed===true&&p.capture.dropped===0&&!p.capture.errors?.length&&s?.nonce&&s.url===round.context?.url&&s.documentId===round.documentId&&s.timeOrigin===round.documentTimeOrigin&&s.frameId===round.context?.frameId&&s.contextId===round.context?.contextId&&p.observation?.scope?.nonce===s.nonce&&p.observation.scope.documentId===s.documentId&&p.observation.scope.timeOrigin===s.timeOrigin&&p.observation.removed===true&&p.probe?.closed===true&&p.probe.dropped===0&&a?.schema==='owned-visible-run-feedback-v1'&&['pass','insufficient'].includes(a.captureStatus)&&a.swapStatus==='insufficient'&&a.capturedContentVerified===true&&a.timestampSemantics==='captured-video-frame-received-wall-time-v1'&&a.providerVersion===p.capture.webviewVersion&&finite(a.latencyMs)&&a.latencyMs===a.latencyIntervalMs?.upperInclusive&&a.latencyIntervalMs.lowerExclusive===0&&a.latencyMs>0&&a.commandBinding?.commandSeq>0&&p.acceptedActions?.length===1&&p.acceptedActions[0].proof?.commandSeq===a.commandBinding.commandSeq&&p.acceptedActions[0].requestSha256===a.commandBinding.requestSha256&&first?.pngSha256===a.firstFeedbackFrame.pngSha256&&p.capture.protocol?.sha256===VISIBLE_FEEDBACK_PROTOCOL_SHA256&&(!round.sampleBoundaries?.start||finite(p.capture.after?.at)&&s.timeOrigin+p.capture.after.at<=round.sampleBoundaries.start.epochMs);
 });
 const upper=percentile(verified.map(({phase:p})=>p.analysis.latencyMs),.95),complete=verified.length===phases.length&&rounds.every(r=>r.visibleFeedbackPhases?.length===1),captureStatus=complete&&verified.every(({phase:p})=>p.analysis.captureStatus==='pass')&&upper<=thresholdMs?'pass':'insufficient';
 return {status:captureStatus,captureStatus,swapStatus:'insufficient',measurementScope:'real-webview-captured-content-upper-bound',count:verified.length,observedPhases:phases.length,p95UpperBoundMs:finite(upper)?upper:null,threshold:thresholdMs,physicalPanelPresent:false,physicalPresentStatus:'insufficient',reason:'Complete original local-control PNG + trusted gesture + unique accepted command with exact provider source receipts can establish the captured-content response upper bound; OS/optical presentation is not claimed, and a delayed capture cannot establish a slow response'};
}

export function evaluateAndroidPerformance(game,rounds,thresholds,{sampleMs,networkCalibrated=false}={}){
 const gates=[],frame=summarizeFrames(rounds),actions=rounds.flatMap(r=>r.actions||[]).filter(a=>a.accepted),gate=(id,status,details)=>gates.push({id,status,...details});
 const limit=(id,value,max)=>gate(id,finite(value)?value<=max?'pass':'fail':'unmeasured',{value:finite(value)?value:null,threshold:max});
 gate('ACTIVE-SAMPLE',frame.activeMs>=Math.max(thresholds.minimum_active_sample_ms,sampleMs||0)&&!frame.dropped?'pass':'insufficient',{activeMs:frame.activeMs,dropped:frame.dropped});
 gate('MOVING-SAMPLE',frame.movingMs>=thresholds.minimum_active_sample_ms?'pass':'insufficient',{movingMs:frame.movingMs,idleMs:frame.idleMs});
 for(const scope of ['foreground','active','moving'])for(const [key,max]of [['p95_ms',thresholds.frame_p95_ms],['p99_ms',thresholds.frame_p99_ms],['max_ms',thresholds.frame_max_ms],['over_50ms_percent',thresholds.frames_over_50ms_percent]])limit('FRAME-'+scope+'-'+key,frame[scope][key],max);
 gate('LONGTASK-OBSERVATION',frame.longTaskSupported?'pass':'unmeasured',{supported:frame.longTaskSupported,summary:frame.longTasks});
 gate('VISIBLE-MOTION',rounds.length>0&&rounds.every(r=>r.motion?.pairs?.length>=2&&r.motion.pairs.filter(p=>p.moved).length>=2)?'pass':'insufficient',{pairs:rounds.map(r=>r.motion?.pairs?.length||0),method:'Decoded pixels of game render surface screenshots during authority-declared motion; not GPU/presented FPS'});
 limit('TRUSTED-INPUT-DISPATCH',percentile(actions.map(a=>a.dispatchMs),.95),thresholds.action_dispatch_p95_ms);
 gate('AUTHORITY-ACK',actions.length?(networkCalibrated?(percentile(actions.map(a=>a.confirmMs),.95)<=thresholds.wifi_action_confirm_p95_ms?'pass':'fail'):'insufficient'):'unmeasured',{p95Ms:percentile(actions.map(a=>a.confirmMs),.95),threshold:thresholds.wifi_action_confirm_p95_ms,networkCalibrated});
 const feedback=summarizeVisibleFeedback(rounds,thresholds.local_input_p95_ms);gate('VISIBLE-LOCAL-FEEDBACK',feedback.status,feedback);
 for(const mode of ['cold','warm']){const rows=rounds.filter(r=>r.cacheMode===mode&&r.cache?.passed===true&&r.entry?.ready===true);gate('LOAD-'+mode,rows.length>=thresholds.entry_repetitions?(percentile(rows.map(r=>r.entry.elapsedMs),.95)<=(mode==='cold'?thresholds.cold_entry_p95_ms:thresholds.warm_entry_p95_ms)?networkCalibrated?'pass':'insufficient':'fail'):'insufficient',{count:rows.length,p95Ms:percentile(rows.map(r=>r.entry.elapsedMs),.95),networkCalibrated});}
 for(const round of rounds){const n=round.network;gate('ROUND-INTEGRITY',round.cleanup?.passed===true&&round.returned===true&&!round.error&&!round.observerErrors?.length&&round.pendingWork===0?'pass':'fail',{round:round.id});limit('STATIC-BYTES',n?.staticEncodedBytes,thresholds.critical_static_encoded_bytes);limit('IMAGE-BYTES',n?.imageMaxEncodedBytes,thresholds.critical_image_encoded_bytes);limit('SNAPSHOT-BYTES',n?.snapshotMaxEncodedBytes,thresholds.snapshot_encoded_bytes);}
 gate('THREE-FRESH-ROOMS',new Set(rounds.map(r=>r.roomIdHash).filter(Boolean)).size>=3?'pass':'insufficient',{});
 gate('SUSTAINED-PHYSICAL',frame.foregroundMs>=thresholds.physical_session_min_ms&&actions.length>=thresholds.physical_min_interactions&&rounds.filter(r=>r.naturallyCompleted===true).length>=3?'pass':'insufficient',{foregroundMs:frame.foregroundMs,validInteractions:actions.length,completeRounds:rounds.filter(r=>r.naturallyCompleted===true).length});
 const status=gates.some(g=>g.status==='fail')?'fail':gates.every(g=>g.status==='pass')?'pass':'partial';return {game,status,passed:status==='pass',frames:frame,actions:actions.length,gates};
}
