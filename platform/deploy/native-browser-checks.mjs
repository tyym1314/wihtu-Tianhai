/** Strict, independently testable gates for the native-host browser smoke. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {resolve} from 'node:path';

const terminal=status=>['cancelled','settled','voided'].includes(status);
const apiPath=path=>/^\/(?:api|v1)\//.test(path);
const assets=new Set(['document','script','stylesheet','image','media','font']);
const message=error=>String(error?.message||error);

export async function reserveNativeReportDirectory(out,report){
 await fs.mkdir(out,{recursive:true});
 assert.equal((await fs.readdir(out)).length,0,'OUTPUT_ALREADY_EXISTS: preserve previous evidence and choose a fresh directory');
 await fs.writeFile(resolve(out,'native-browser.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
}

export function observeNativeBrowser(page,{origin,state,result,clean=String,remember=()=>{},drainTimeoutMs=10000}){
 const tasks=new Set(),requests=new WeakMap();
 for(const key of ['js_errors','resource_errors','observer_errors','http_errors','network_errors'])result[key]??=[];
 state.creations??=[];state.actionRequests??=[];state.probabilityRequests??=[];
 result.creations=state.creations;result.action_requests=state.actionRequests;result.probability_requests=state.probabilityRequests;
 const phase=()=>state.phase||(state.returning?'returning':'entry');
 const address=request=>{
  const url=new URL(request.url()),frame=typeof request.frame==='function'?request.frame():null,frameUrl=frame?.url();
  return{origin:url.origin,path:url.pathname,method:request.method(),type:request.resourceType(),phase:phase(),frame_url:frameUrl?clean(frameUrl):null,game_frame_request:frameUrl===origin+'/play/'+state.game,session_id:state.sessionId,player_id:state.playerId};
 };
 const row=entry=>({path:clean(entry.path),method:entry.method,phase:entry.phase,frame_url:entry.frame_url,game_frame_request:entry.game_frame_request,session_id:entry.session_id?clean(entry.session_id):null,player_id:entry.player_id?clean(entry.player_id):null});
 const failure=(stage,error,entry={})=>result.observer_errors.push({stage,...row(entry),observed_phase:phase(),message:clean(message(error))});
 page.on('pageerror',error=>result.js_errors.push(clean(message(error))));
 page.on('console',item=>{if(item.type()==='error')result.js_errors.push(clean(item.text()));});
 page.on('request',request=>{let entry;try{
  entry=address(request);requests.set(request,entry);
  if(entry.origin!==origin||entry.method!=='POST')return;
  if(entry.path==='/api/pvp/rooms'){
   const body=request.postDataJSON();
   entry.creation={request_id:body.request_id,game:body.game_id,practice:body.practice===true,entry:body.entry_minor,status:null,room_id:null,finished:false};
   state.creations.push(entry.creation);
   assert.equal(body.game_id,state.game);assert.equal(body.practice,true);assert.equal(body.entry_minor,'0');
   state.practiceRequested=true;
  }
  if(/^\/api\/pvp\/rooms\/[^/]+\/action$/.test(entry.path)){
   const body=request.postDataJSON();
   entry.action={...row(entry),request_id:body.request_id,sequence:body.seq,type:body.action?.type,status:null};state.actionRequests.push(entry.action);
  }
  if(new RegExp(`^/api/play/${state.game}/(spin|ack)$`).test(entry.path)){
   const body=request.postDataJSON();
   entry.probability={...row(entry),type:entry.path.endsWith('/spin')?'spin':'ack',request_id:body.requestId,round_id:body.roundId,status:null};state.probabilityRequests.push(entry.probability);
  }
 }catch(error){failure('request',error,entry);}});
 page.on('requestfinished',request=>{const entry=requests.get(request);if(entry?.creation)entry.creation.finished=true;});
 page.on('requestfailed',request=>{let entry;try{
  entry=requests.get(request)||address(request);const error=clean(request.failure()?.errorText||'NETWORK_ERROR');
  for(const intent of [entry.creation,entry.action,entry.probability])if(intent)intent.transport_error=error;
  if(entry.creation)entry.creation.finished=true;
  if(entry.origin===origin&&apiPath(entry.path))result.network_errors.push({...row(entry),error});
  else if(assets.has(entry.type))result.resource_errors.push({...row(entry),error});
 }catch(error){failure('requestfailed',error,entry);}});
 page.on('response',response=>{
  let entry;
  const work=(async()=>{
   const request=response.request();entry=requests.get(request)||address(request);
   const status=response.status(),path=entry.path;
   for(const intent of [entry.creation,entry.action,entry.probability])if(intent)intent.status=status;
   if(assets.has(entry.type)&&status>=400)result.resource_errors.push({...row(entry),status});
   if(entry.origin!==origin)return;
   if(apiPath(path)&&!response.ok())result.http_errors.push({...row(entry),status});
   if(!response.ok())return;
   if(['/api/demo/config','/api/demo/launch','/v1/launch/exchange'].includes(path)){
    const body=await response.json();remember(body);
    if(path==='/v1/launch/exchange'){
     assert.equal(body.game_id,state.game,'Exchange game differs');
     assert.ok(body.session_id&&body.external_user_id&&body.access_token,'Incomplete launch exchange');
     if(state.sessionId)assert.equal(body.session_id,state.sessionId,'Reauthorization replaced the original session');
     if(state.playerId)assert.equal(body.external_user_id,state.playerId,'Reauthorization replaced the original player');
     state.token=body.access_token;state.sessionId=body.session_id;state.playerId=body.external_user_id;result.launch_exchange=true;
    }
   }
   if(path.startsWith('/api/pvp/rooms')){
    const body=await response.json(),room=body.room||body;
    if(room.id){
     assert.equal(room.game_id,state.game,'Observed room belongs to another game');
     assert.equal(room.me,state.playerId,'Observed room belongs to another player');
     if(!state.room||state.room.id!==room.id||room.version>=state.room.version)state.room=room;
     if(entry.creation){
      assert.equal(room.practice,true);assert.equal(room.entry_minor,'0');
      entry.creation.room_id=room.id;state.ownedRooms.add(room.id);
     }
    }
   }
   if(path===`/api/play/${state.game}/spin`){
    const body=await response.json();
    assert.equal(body.session?.sessionId,state.sessionId,'Spin session differs');assert.ok(body.round?.id&&body.round.cycleId,'Spin response lacks a round/cycle identity');
    state.spins.push({id:body.round.id,cycleId:body.round.cycleId,status:body.round.settlementStatus,isFreeSpin:body.round.isFreeSpin===true,httpStatus:status});
   }
   if(path===`/api/play/${state.game}/ack`){
    const body=await response.json();
    assert.equal(body.session?.sessionId,state.sessionId,'ACK session differs');assert.equal(body.session.pendingRound,null);
    state.acks.add(request.postDataJSON().roundId);
   }
  })().catch(error=>failure('response',error,entry));
  // No body-loss exception is suppressed, including after return or teardown.
  tasks.add(work);void work.finally(()=>tasks.delete(work));
 });
 return async()=>{
  const deadline=Date.now()+drainTimeoutMs;
  while(tasks.size){
   assert.ok(Date.now()<deadline,'Response observer drain timed out');
   await new Promise(resolve=>setTimeout(resolve,5));
  }
 };
}

export async function runNativeActionOnce(action,result,clean=String){
 const attempt={attempt:1,started_at:new Date().toISOString(),passed:false};(result.action_attempts??=[]).push(attempt);
 try{const accepted=await action();attempt.http_status=accepted.httpStatus;attempt.passed=true;return accepted;}
 catch(error){attempt.http_status=error.status??null;attempt.code=error.code??null;attempt.error=clean(message(error));throw error;}
 finally{attempt.finished_at=new Date().toISOString();}
}

export function nativeErrorsEmpty(result){
 return ['js_errors','resource_errors','observer_errors','http_errors','network_errors'].every(key=>Array.isArray(result[key])&&result[key].length===0);
}

export function createNativeCleanupApi({page,origin,state,result,clean=String}){
 result.cleanup_requests??=[];result.http_errors??=[];result.network_errors??=[];result.observer_errors??=[];
 return async(path,body)=>{
  const entry={path:clean(path),method:body===undefined?'GET':'POST',phase:'cleanup',status:null,...(body===undefined?{}:{request_id:body.requestId||body.request_id||null,round_id:body.roundId||null})};result.cleanup_requests.push(entry);
  let response;
  try{response=await page.request.fetch(origin+path,{method:entry.method,headers:{authorization:'Bearer '+state.token,...(body===undefined?{}:{origin,'content-type':'application/json'})},...(body===undefined?{}:{data:body}),timeout:12000,failOnStatusCode:false,maxRedirects:0});}
  catch(error){entry.transport_error=clean(message(error));result.network_errors.push({...entry});throw error;}
  entry.status=response.status();
  if(!response.ok()){result.http_errors.push({...entry});throw Object.assign(new Error(`Cleanup HTTP ${entry.status} at ${entry.path}`),{status:entry.status});}
  try{return await response.json();}
  catch(error){result.observer_errors.push({...entry,stage:'cleanup-response',message:clean(message(error))});throw error;}
 };
}

export async function cleanupNativeSession({state,arenaGames,api,until,newId,clean=String}){
 const result={attempted:Boolean(state.token),passed:false,scope:'Original isolated guest/session only; owned free practice rooms and already-owned settled probability presentations',rooms:[]};
 const creations=state.creations||[],probabilityRequests=state.probabilityRequests||[];
 try{
  if(!state.token){
   assert.equal(creations.length+probabilityRequests.length+state.spins.length,0,'Mutations exist without a captured session token');
   assert.equal(state.practiceRequested,false,'Practice requested without a captured session token');result.passed=true;return result;
  }
  assert.ok(state.sessionId&&state.playerId,'Original session identity is missing');
  if(arenaGames.includes(state.game)){
   const session=async()=>{const value=await api('/api/arena/session');assert.equal(value.session_id,state.sessionId,'Cleanup session identity differs');assert.equal(value.external_user_id,state.playerId,'Cleanup player identity differs');assert.equal(value.game_id,state.game,'Cleanup session game differs');return value;};
   const room=async id=>{const body=await api(`/api/pvp/rooms/${id}`),value=body.room||body;assert.equal(value.id,id,'Cleanup returned another room');assert.equal(value.game_id,state.game,'Cleanup room game differs');assert.equal(value.me,state.playerId,'Cleanup room owner differs');assert.equal(value.entry_minor,'0','Cleanup refuses paid rooms');assert.equal(value.practice,true,'Cleanup refuses competitive rooms');return value;};
   const before=await session();
   if(before.active_room_id){await room(before.active_room_id);state.ownedRooms.add(before.active_room_id);}
   for(const id of state.ownedRooms){
    let current=await room(id);const entry={room_id:id,before:current.status,terminal:false};result.rooms.push(entry);
    if(!terminal(current.status)){
     entry.leave_request_id=newId();
     await api(`/api/pvp/rooms/${id}/leave`,{request_id:entry.leave_request_id});
     await until(async()=>{current=await room(id);return terminal(current.status);},'owned free practice terminal readback',15000);
    }
    entry.after=current.status;entry.terminal=terminal(current.status);assert.equal(entry.terminal,true);
   }
   const after=await session();result.final_readback={session_id:after.session_id,external_user_id:after.external_user_id,game_id:after.game_id,active_room_id:after.active_room_id,other_active_game:after.other_active_game};
   assert.equal(after.active_room_id,null,'Own active room remains');assert.equal(after.other_active_game,null,'Another active game remains');
   result.unresolved_creations=creations.filter(entry=>!entry.room_id&&!(entry.status>=400&&entry.status<500));
   assert.deepEqual(result.unresolved_creations,[],'Uncertain room creation requires further original-session readback');
  }else{
   const cycleIds=new Set(state.spins.map(spin=>spin.cycleId).filter(Boolean));
   result.probability={acknowledged:[],free_continuations:[],new_paid_spins:0};
   const session=async()=>{const value=await api(`/api/play/${state.game}/session`);assert.equal(value.sessionId,state.sessionId,'Cleanup session identity differs');assert.ok(Number.isSafeInteger(value.freeSpins)&&value.freeSpins>=0,'Invalid free-spin count');return value;};
   let done=false;
   for(let n=0;n<300;n++){
    const current=await session();
    if(current.pendingRound){
     assert.ok(current.pendingRound.id&&current.pendingRound.cycleId,'Pending round lacks its identity');assert.equal(current.pendingRound.settlementStatus,'SETTLED','Pending round is not settled');cycleIds.add(current.pendingRound.cycleId);
     const acknowledged=await api(`/api/play/${state.game}/ack`,{roundId:current.pendingRound.id});
     assert.equal(acknowledged.session?.sessionId,state.sessionId,'Cleanup ACK identity differs');assert.equal(acknowledged.session.pendingRound,null);result.probability.acknowledged.push(current.pendingRound.id);
    }else if(current.freeSpins>0){
     assert.ok(cycleIds.size,'Cannot continue an unidentified existing cycle');assert.ok(current.betChoices?.includes(current.lockedBet),'Invalid locked bonus bet');assert.ok(Number.isSafeInteger(current.stateVersion),'Missing original-session version');
     const response=await api(`/api/play/${state.game}/spin`,{requestId:newId(),bet:current.lockedBet,expectedVersion:current.stateVersion});
     if(response.round?.isFreeSpin!==true)result.probability.new_paid_spins++;
     assert.equal(response.session?.sessionId,state.sessionId,'Cleanup continuation identity differs');assert.equal(response.round?.isFreeSpin,true,'Cleanup opened a new paid cycle');assert.equal(response.round.settlementStatus,'SETTLED');assert.ok(cycleIds.has(response.round.cycleId),'Cleanup continuation left the original cycle');
     result.probability.free_continuations.push({round_id:response.round.id,cycle_id:response.round.cycleId});
    }else{assert.equal(current.pendingRound,null,'Missing pending-round state');result.probability.final_readback={session_id:current.sessionId,pendingRound:current.pendingRound,freeSpins:current.freeSpins};done=true;break;}
   }
   assert.ok(done,'Existing bonus presentation cleanup exceeded 300 steps');
   result.probability.uncertain_spins=probabilityRequests.filter(entry=>entry.type==='spin'&&(entry.status!==200||entry.transport_error));
   assert.deepEqual(result.probability.uncertain_spins,[],'An uncertain spin cannot be cleared by an empty presentation readback');
  }
  result.passed=true;
 }catch(error){result.error=clean(message(error));}
 return result;
}
