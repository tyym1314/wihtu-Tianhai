/** APK-specific gates. Unlike a fresh browser context, an APK retains its guest. */
import assert from 'node:assert/strict';
import {cleanupNativeSession} from '../deploy/native-browser-checks.mjs';

/** Network-event adapter for the one measured reload, not a time-based filter.
 * Only a request actually observed before the selected navigation can be excluded.
 * Unknown response origins fail closed and cannot authorize the measured session.
 * Errors are still subscribed from the real page by the fetch probe.
 */
export function createAndroidMeasurementBoundary(page,{origin,game,result}){
 const generations=new WeakMap();let armed=false,navigation=null,navigationResponse=false,committed=false,sequence=0,initialFrames=new Set();
 result.initial_request_boundary??=[];result.observer_errors??=[];
 const record=(request,event,original)=>{
  const value=generations.get(request),row={request_id:value?.id??null,event,method:request.method(),path:new URL(request.url()).pathname,...(event==='response'?{status:original.status()}:{}),...(event==='requestfailed'?{error:request.failure()?.errorText||'unknown transport failure'}:{})};
  result.initial_request_boundary.push(row);
  if(row.status>=400||row.error)result.observer_errors.push({stage:'initial-request-failure',...row,message:'Observed initial request failed; excluded from identity only, not from errors'});
 };
 page.on('request',request=>{
  if(generations.has(request)){result.observer_errors.push({stage:'request-generation',message:'DUPLICATE_REQUEST_EVENT'});return;}
  const url=new URL(request.url()),frame=request.frame(),main=page.mainFrame(),isNavigation=armed&&!navigation&&request.isNavigationRequest?.()&&frame===main&&request.method()==='GET'&&url.href===origin+'/demo/native/'+game&&!request.redirectedFrom?.();
  let kind='initial',reason;
  if(isNavigation){navigation=request;kind='navigation';}
  else if(navigation){
   if(!committed)reason='REQUEST_BEFORE_MEASURED_DOCUMENT_COMMIT';
   else if(frame!==main&&initialFrames.has(frame))reason='OLD_FRAME_REQUEST_AFTER_MEASURED_NAVIGATION';
   else if(frame!==main&&frame.parentFrame?.()!==main)reason='UNPROVEN_GAME_FRAME_ANCESTRY';
   else if(url.origin===origin&&/^\/(?:api|v1)\//.test(url.pathname)){
    if(frame===main&&!url.pathname.startsWith('/api/demo/'))reason='API_NOT_FROM_MEASURED_GAME_FRAME';
    else if(frame!==main&&frame.url()!==origin+'/play/'+game)reason='API_NOT_FROM_MEASURED_GAME_FRAME';
   }
   kind=reason?'invalid':'measured';
  }
  const value={id:`apk-request-${++sequence}`,kind};generations.set(request,value);
  if(reason)result.observer_errors.push({stage:'request-generation',request_id:value.id,message:reason,path:url.pathname});
 });
 page.on('response',response=>{if(response.request()===navigation)navigationResponse=true;});
 page.on('framenavigated',frame=>{if(frame===page.mainFrame()&&navigation&&navigationResponse&&frame.url()===origin+'/demo/native/'+game){committed=true;result.measured_main_document_committed=true;}});
 const accept=(request,event,original)=>{
  const value=generations.get(request);
  if(value&&['navigation','measured'].includes(value.kind))return true;
  if(value?.kind==='initial'){record(request,event,original);return false;}
  if(value?.kind==='invalid')return false;
  result.observer_errors.push({stage:'request-generation',event,message:'UNOBSERVED_REQUEST_CANNOT_AUTHORIZE_MEASURED_DOCUMENT',path:new URL(request.url()).pathname});return false;
 };
 const observedPage={
  on(event,handler){page.on(event,(...args)=>{const request=event==='response'?args[0].request():args[0];if(['request','requestfinished','requestfailed','response'].includes(event)&&!accept(request,event,args[0]))return;handler(...args);});return observedPage;},
  isClosed:()=>page.isClosed(),frames:()=>page.frames(),url:()=>page.url(),
 };
 return{
  observedPage,
  arm(){assert.equal(armed,false,'MEASUREMENT_BOUNDARY_ALREADY_ARMED');initialFrames=new Set(page.frames());armed=true;},
  verifyNavigation(response){assert.ok(navigation,'MEASURED_NAVIGATION_MISSING');assert.equal(response?.request(),navigation,'RELOAD_RESPONSE_REQUEST_IDENTITY_MISMATCH');assert.equal(committed,true,'MEASURED_DOCUMENT_COMMIT_UNPROVEN');result.measured_navigation_request_id=generations.get(navigation).id;},
  probeAdapter(probe){return new Proxy(probe,{get(target,key){if(key==='observePageErrors')return(_page,receive)=>target.observePageErrors(page,receive);if(key==='flush')return()=>target.flush(page);const value=target[key];return typeof value==='function'?value.bind(target):value;}});},
 };
}

export function parseAndroidForwards(text){
 return text.trim()?text.trim().split(/\r?\n/).map(line=>{
  const parts=line.trim().split(/\s+/);assert.equal(parts.length,3,'INVALID_ADB_FORWARD_INVENTORY');
  return{serial:parts[0],local:parts[1],remote:parts[2]};
 }):[];
}
export function ownedAndroidForward(before,after,{serial,port,remote}){
 assert.match(String(port),/^[1-9]\d{0,4}$/);assert.ok(Number(port)<=65535);
 const expected={serial,local:`tcp:${port}`,remote};
 assert.ok(!before.some(row=>row.local===expected.local),'FORWARD_WAS_NOT_NEW');
 assert.deepEqual(after.filter(row=>row.local===expected.local),[expected],'OWNED_FORWARD_BINDING_MISMATCH');
 for(const row of before)assert.ok(after.some(item=>JSON.stringify(item)===JSON.stringify(row)),'EXISTING_FORWARD_CHANGED');
 return Object.freeze(expected);
}
export function assertAndroidForwardsRestored(before,after){
 const sorted=rows=>rows.map(row=>JSON.stringify(row)).sort();
 assert.deepEqual(sorted(after),sorted(before),'ADB_FORWARD_INVENTORY_NOT_RESTORED');
}
export function androidForeground(text){
 const matches=[...text.matchAll(/(?:topResumedActivity|mResumedActivity)[^\n]*?\bu\d+\s+([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/g)].map(match=>match[1]);
 const unique=[...new Set(matches)];assert.equal(unique.length,1,'ANDROID_FOREGROUND_UNPROVEN');return unique[0];
}
export function assertAndroidSessionBaseline(state,session,arenaGames){
 assert.ok(state.token&&state.sessionId&&state.playerId&&state.appId,'ORIGINAL_SESSION_IDENTITY_REQUIRED');
 assert.equal(state.creations?.length||0,0,'MUTATION_BEFORE_BASELINE');
 assert.equal(state.probabilityRequests?.length||0,0,'MUTATION_BEFORE_BASELINE');
 assert.equal(state.actionRequests?.length||0,0,'MUTATION_BEFORE_BASELINE');
 assert.equal(state.inputsRequests?.length||0,0,'MUTATION_BEFORE_BASELINE');
 if(arenaGames.includes(state.game)){
  assert.equal(session.session_id,state.sessionId);assert.equal(session.external_user_id,state.playerId);assert.equal(session.game_id,state.game);
  assert.equal(session.scope?.app_id,state.appId);assert.equal(session.active_room_id,null,'PREEXISTING_ROOM_PRESERVED');assert.equal(session.other_active_game,null,'PREEXISTING_OTHER_GAME_PRESERVED');
 }else{
  assert.equal(session.sessionId,state.sessionId);assert.equal(session.pendingRound,null,'PREEXISTING_PENDING_ROUND_PRESERVED');assert.equal(session.freeSpins,0,'PREEXISTING_FREE_SPINS_PRESERVED');
 }
 const baseline=Object.freeze({game:state.game,sessionId:state.sessionId,playerId:state.playerId,appId:state.appId});
 state.androidBaseline=baseline;return baseline;
}
const sameIdentity=state=>{
 const baseline=state.androidBaseline;assert.ok(baseline,'NO_CLEAN_ANDROID_BASELINE');
 for(const field of ['game','sessionId','playerId','appId'])assert.equal(state[field],baseline[field],'ORIGINAL_ANDROID_SESSION_CHANGED');
};
export function assertAndroidOneAction(state,action){
 if(['run-practice-inputs-v1','run-practice-inputs-v2'].includes(action.protocol)){
  assert.equal(state.actionRequests.length,0);assert.equal(state.inputsRequests.length,1,'EXPECTED_ONE_INPUT_BATCH_NO_RETRY');
  const observed=state.inputsRequests[0];assert.equal(observed.status,action.httpStatus);assert.equal(observed.validated,true);
  assert.deepEqual(observed.proof,action.inputEvidence,'INDEPENDENT_INPUT_RECEIPT_MISMATCH');
 }else{assert.equal(state.actionRequests.length,1,'EXPECTED_ONE_ACTION_NO_RETRY');assert.equal(state.inputsRequests.length,0);assert.equal(state.actionRequests[0].status,action.httpStatus);}
}
export function assertAndroidPaidCycle(state,{requireAcks=true}={}){
 sameIdentity(state);assert.ok(state.spins.length>0,'NO_ORIGINAL_PAID_SPIN');
 assert.equal(state.spins.filter(round=>!round.isFreeSpin).length,1,'EXPECTED_ONE_PAID_CYCLE');
 const cycles=new Set(state.spins.map(round=>round.cycleId));assert.equal(cycles.size,1,'MULTIPLE_PROBABILITY_CYCLES');assert.ok([...cycles][0]);
 for(const round of state.spins){assert.equal(round.status,'SETTLED');if(requireAcks)assert.ok(state.acks.has(round.id),'ORIGINAL_ROUND_NOT_ACKNOWLEDGED');}
 return [...cycles][0];
}

/** Never let the shared fresh-guest helper adopt an APK's pre-existing room/cycle.
 * UI must already be stopped. All guards run before the shared helper can POST.
 * An unknown mutation stays failed even if a later read happens to look empty.
 */
export async function cleanupOwnedAndroidSession({state,arenaGames,api,until,newId,uiStopped,clean=String}){
 try{
  assert.equal(uiStopped,true,'GAME_UI_NOT_STOPPED');sameIdentity(state);
  const roomIds=new Set(state.creations.filter(row=>row.room_id&&row.game===state.game&&row.practice===true&&row.entry==='0'&&row.status>=200&&row.status<300).map(row=>row.room_id));
  assert.deepEqual([...state.ownedRooms].sort(),[...roomIds].sort(),'ROOM_WITHOUT_THIS_RUN_CREATION_PROOF');
  const cycles=new Set(state.spins.map(round=>round.cycleId));
  if(state.spins.length)assertAndroidPaidCycle(state,{requireAcks:false});
  const guarded=async(path,body)=>{
   sameIdentity(state);
   if(body!==undefined){
    const leave=/^\/api\/pvp\/rooms\/([^/]+)\/leave$/.exec(path);
    if(leave)assert.ok(roomIds.has(leave[1]),'REFUSE_UNOWNED_ROOM_LEAVE');
    else if(path===`/api/play/${state.game}/ack`)assert.ok(knownRounds.has(body.roundId),'REFUSE_UNOWNED_ROUND_ACK');
    else if(path===`/api/play/${state.game}/spin`)assert.ok(cycles.size===1&&lastProbability?.freeSpins>0&&lastProbability?.pendingRound===null,'REFUSE_NEW_PAID_CLEANUP_SPIN');
    else assert.fail('UNEXPECTED_ANDROID_CLEANUP_MUTATION');
   }
   const value=await api(path,body);
   if(path==='/api/arena/session'){
    assert.equal(value.session_id,state.sessionId);assert.equal(value.external_user_id,state.playerId);assert.equal(value.game_id,state.game);assert.equal(value.scope?.app_id,state.appId);
    assert.equal(value.other_active_game,null,'FOREIGN_ACTIVE_GAME_PRESERVED');
    if(value.active_room_id!==null)assert.ok(roomIds.has(value.active_room_id),'FOREIGN_ACTIVE_ROOM_PRESERVED');
   }
   if(path===`/api/play/${state.game}/session`){
    assert.equal(value.sessionId,state.sessionId);
    if(value.pendingRound){assert.ok(cycles.has(value.pendingRound.cycleId),'FOREIGN_PENDING_CYCLE_PRESERVED');knownRounds.add(value.pendingRound.id);}
    if(value.freeSpins>0)assert.equal(cycles.size,1,'UNKNOWN_FREE_SPINS_PRESERVED');
    lastProbability=value;
   }
   return value;
  };
  let lastProbability;const knownRounds=new Set(state.spins.map(round=>round.id));
  return await cleanupNativeSession({state,arenaGames,api:guarded,until,newId,clean});
 }catch(error){return{attempted:false,passed:false,error:clean(error.message),scope:'Only this run, original session; inherited obligations preserved'};}
}

export function androidStrictPassed(report){
 return report.layout_diagnostic!==true&&report.full_catalog===true&&report.games.length===13&&report.games.every(game=>game.passed===true&&game.cleanup?.passed===true)
  &&report.inventory_final?.clean===true&&report.resources?.passed===true&&!report.failure;
}

/** A separate diagnostic may inspect the remaining catalog after a measured
 * layout failure, but only after this session and all owned resources are clean.
 * It can never produce a strict acceptance pass.
 */
export function androidContinueLayoutDiagnostic(report,result,observationsClean){
 return report.layout_diagnostic===true&&result.error==='WEBVIEW_SINGLE_SCREEN_REQUIRED'
  &&result.layout?.single_screen===false&&result.ui_stopped===true
  &&result.cleanup?.passed===true&&result.inventory_after?.clean===true
  &&!result.inventory_error&&!result.screenshot_error&&observationsClean===true&&report.resources.errors.length===0;
}
