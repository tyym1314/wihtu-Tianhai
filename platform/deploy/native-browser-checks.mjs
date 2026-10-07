/** Strict, independently testable gates for the native-host browser smoke. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRunSnapshotObserver,runSnapshotRequest} from './run-snapshot-observer.mjs';

const terminal=status=>['cancelled','settled','voided'].includes(status);
const apiPath=path=>/^\/(?:api|v1)\//.test(path);
const assets=new Set(['document','script','stylesheet','image','media','font']);
const message=error=>String(error?.message||error);
const pollCancellationReasons=new Set(['OASIS_ROOM_POLL_STOPPED','OASIS_ROOM_POLL_BACKGROUND']);
const fetchClockUncertaintyMs=1;

export function createNativeFetchEvidence({clean=String}={}){
 const frames=new WeakMap(),documents=new Map(),events=[],errors=[],network=new Map(),networkDocuments=new Map();
 let frameSequence=0,revision=0;
 const frameId=frame=>{if(!frame||typeof frame!=='object')return null;if(!frames.has(frame))frames.set(frame,`frame-${++frameSequence}`);return frames.get(frame);};
 const receive=(frame,event)=>{
  revision++;
  if(events.length>=20000){errors.push('FETCH_PROBE_EVENT_LIMIT');return;}
  if(!frameId(frame)||!event||typeof event.document_id!=='string'||!event.document_id||!Number.isSafeInteger(event.event_seq)||event.event_seq<1||!Number.isFinite(event.at_ms)||!['document','checkpoint','start','abort','fulfilled','rejected'].includes(event.kind)){errors.push('INVALID_FETCH_PROBE_EVENT');return;}
  let doc=documents.get(event.document_id);
  if(!doc){doc={frame,events:new Map()};documents.set(event.document_id,doc);}
  if(doc.frame!==frame||doc.events.has(event.event_seq)){errors.push('CONFLICTING_FETCH_PROBE_EVENT');return;}
  const value=structuredClone(event);doc.events.set(value.event_seq,value);events.push({frame_id:frameId(frame),...value});
 };
 const attempts=()=>{
  const values=[];
  for(const [documentId,doc] of documents){
   const ordered=[...doc.events.values()].sort((a,b)=>a.event_seq-b.event_seq);
   for(const start of ordered.filter(event=>event.kind==='start')){
    const related=ordered.filter(event=>event.attempt_id===start.attempt_id&&event.kind!=='checkpoint'&&event.kind!=='document');
    const terminals=related.filter(event=>['fulfilled','rejected'].includes(event.kind)),aborts=related.filter(event=>event.kind==='abort');
    const end=terminals[0],prefix=ordered.filter(event=>event.event_seq<=(end?.event_seq??ordered.at(-1)?.event_seq));
    const valid=related.filter(event=>event.kind==='start').length===1&&terminals.length<=1&&aborts.length<=1&&prefix[0]?.kind==='document'&&prefix.every((event,index)=>event.event_seq===index+1&&(index===0||event.at_ms>=prefix[index-1].at_ms));
    values.push({documentId,frame:doc.frame,frameId:frameId(doc.frame),start,end,abort:aborts[0],valid});
   }
  }
  return values;
 };
 const timeOverlap=(attempt,entry)=>Number.isFinite(entry.network_started_at_ms)&&entry.network_started_at_ms>0&&attempt.start.at_ms-fetchClockUncertaintyMs<=entry.network_started_at_ms&&entry.network_started_at_ms<(attempt.end?.at_ms??Infinity)+fetchClockUncertaintyMs;
 const overlap=(attempt,entry)=>attempt.frame===entry.frame_object&&attempt.start.frame_url===entry.frame_url_raw&&attempt.start.url===entry.full_url&&attempt.start.method===entry.method&&timeOverlap(attempt,entry);
 const receiveNetworkDocument=(frame,event)=>{
  if(!frame||event?.kind!=='document'||typeof event.document_id!=='string'||!Number.isFinite(event.at_ms)){errors.push('INVALID_NETWORK_DOCUMENT');return;}
  const previous=networkDocuments.get(event.document_id);
  if(previous&&(previous.frame!==frame||previous.at_ms!==event.at_ms)){errors.push('CONFLICTING_NETWORK_DOCUMENT');return;}
  networkDocuments.set(event.document_id,{frame,...event});
 };
 const networkDocument=record=>{
  const candidates=[...networkDocuments.entries()].filter(([_id,doc])=>doc.frame===record.frame&&doc.at_ms<=record.started_at_ms).sort((a,b)=>b[1].at_ms-a[1].at_ms);
  if(!candidates.length||candidates.length>1&&candidates[0][1].at_ms===candidates[1][1].at_ms)return null;
  const [id,doc]=candidates[0],observed=documents.get(id),identity=observed?.events.get(1);
  return identity?.kind==='document'&&identity.at_ms===doc.at_ms&&identity.frame_url===doc.frame_url?{id,frame:observed.frame,url:doc.frame_url}:null;
 };
 const bindNetwork=(requests,failed)=>{
  const same=(record,entry)=>{const doc=networkDocument(record);return doc?.frame===entry.frame_object&&doc.url===entry.frame_url_raw&&record.url===entry.full_url&&record.method===entry.method;};
  for(const {entry,observation} of failed){
   const knownTime=entry.network_started_at_ms>0?entry.network_started_at_ms:null;
   entry.network_proof_error=null;
   const related=[...network.values()].filter(record=>record.type==='Fetch'&&same(record,entry));
   if(!related.length&&knownTime)continue;
   const candidates=related.filter(record=>{
    if(knownTime)return !Number.isFinite(record.started_at_ms)||Math.abs(record.started_at_ms-knownTime)<=fetchClockUncertaintyMs;
    const otherResponses=requests.filter(other=>other!==entry&&other.response_seen&&same(record,other)&&other.network_started_at_ms>0&&Math.abs(other.network_started_at_ms-record.started_at_ms)<=fetchClockUncertaintyMs&&related.filter(candidate=>Math.abs(candidate.started_at_ms-other.network_started_at_ms)<=fetchClockUncertaintyMs).length===1);
    return otherResponses.length!==1;
   });
   if(knownTime&&related.length&&!candidates.length){entry.network_proof_error='CONFLICTING_NETWORK_CLOCKS';continue;}
   if(candidates.length!==1){entry.network_proof_error=candidates.length?'AMBIGUOUS_CDP_NETWORK_FAILURE':'MISSING_CDP_NETWORK_PROOF';continue;}
   const record=candidates[0];
   entry.response_seen||=record.response_seen;entry.redirected||=record.redirected;
   if(record.error!==observation.error){entry.network_proof_error='CONFLICTING_NETWORK_FAILURE';continue;}
   if(failed.filter(other=>same(record,other.entry)&&other.observation.error===record.error&&(!(other.entry.network_started_at_ms>0)||Math.abs(other.entry.network_started_at_ms-record.started_at_ms)<=fetchClockUncertaintyMs)).length!==1){entry.network_proof_error='AMBIGUOUS_PLAYWRIGHT_NETWORK_FAILURE';continue;}
   if(record.error!=='net::ERR_ABORTED'||record.cancelled!==true||!Number.isFinite(record.failed_at_ms)||record.failed_at_ms<record.started_at_ms){entry.network_proof_error='NOT_ABORTED_CDP_FAILURE';continue;}
   entry.network_started_at_ms=record.started_at_ms;entry.network_failed_at_ms=record.failed_at_ms;entry.network_protocol_id=record.id;entry.network_timing_source='cdp';entry.response_seen||=record.response_seen;entry.redirected||=record.redirected;entry.network_proof_error=null;
  }
 };
 const classify=(entry,requests)=>{
  const deny=reason=>({eligible:false,reason});
  if(errors.length)return deny('FETCH_PROBE_PROTOCOL_ERROR');
  if(!entry.request_observed||!entry.owned_room_at_start||!entry.session_id||!entry.player_id||!entry.game_frame_request||entry.method!=='GET'||entry.type!=='fetch'||entry.body_present!==false||entry.redirected||entry.query)return deny('NOT_OWNED_READ_ONLY_ROOM_POLL');
  if(entry.response_seen)return deny('RESPONSE_HEADERS_OBSERVED');
  if(entry.failure_error!=='net::ERR_ABORTED')return deny('NOT_ABORTED_NETWORK_REQUEST');
  if(entry.network_proof_error)return deny(entry.network_proof_error);
  if(requests.some(other=>other!==entry&&other.frame_object===entry.frame_object&&other.full_url===entry.full_url&&other.method===entry.method&&!(other.network_started_at_ms>0)))return deny('UNKNOWN_COMPETING_NETWORK_REQUEST');
  const allAttempts=attempts();
  if(allAttempts.some(attempt=>!attempt.start.supported&&attempt.frame===entry.frame_object&&timeOverlap(attempt,entry)))return deny('UNSUPPORTED_COMPETING_FETCH');
  const candidates=allAttempts.filter(attempt=>overlap(attempt,entry));
  if(candidates.length!==1)return deny(candidates.length?'AMBIGUOUS_FETCH_ATTEMPT':'MISSING_FETCH_ATTEMPT');
  const attempt=candidates[0],{start,abort,end}=attempt;
  if(requests.filter(other=>overlap(attempt,other)).length!==1)return deny('AMBIGUOUS_NETWORK_REQUEST');
  if(!attempt.valid||!start.supported||start.body_present!==false||!Number.isSafeInteger(start.attempt_id)||start.attempt_id<1)return deny('INCOMPLETE_FETCH_PROOF');
  if(!abort||abort.already_aborted||!end||end.kind!=='rejected'||end.sync_throw||!end.signal_aborted||!end.reject_is_signal_reason)return deny('FETCH_DID_NOT_REJECT_FROM_OBSERVED_ABORT');
  const reason=abort.reason;
  if(reason?.name!=='AbortError'||!pollCancellationReasons.has(reason.message)||end.reason?.name!==reason.name||end.reason?.message!==reason.message||end.error?.name!==reason.name||end.error?.message!==reason.message)return deny('NOT_LIFECYCLE_ABORT_REASON');
  if(!(start.event_seq<abort.event_seq&&abort.event_seq<end.event_seq&&start.at_ms<=abort.at_ms&&start.at_ms-fetchClockUncertaintyMs<=entry.network_started_at_ms&&entry.network_started_at_ms<=abort.at_ms+fetchClockUncertaintyMs&&abort.at_ms<=end.at_ms))return deny('INVALID_ABORT_ORDER');
  return{eligible:true,proof:{document_id:attempt.documentId,frame_id:attempt.frameId,fetch_attempt_id:start.attempt_id,clock_uncertainty_ms:fetchClockUncertaintyMs,fetch_started_at_ms:start.at_ms,network_started_at_ms:entry.network_started_at_ms,network_failed_at_ms:entry.network_failed_at_ms??null,network_protocol_id:entry.network_protocol_id??null,network_timing_source:entry.network_timing_source||'playwright',aborted_at_ms:abort.at_ms,rejected_at_ms:end.at_ms,reason:{...reason},error:{...end.error},trace_event_seqs:[start.event_seq,abort.event_seq,end.event_seq]}};
 };
 const observations=()=>events.map(event=>{
  const value={...event};for(const key of ['url','frame_url'])if(value[key])value[key]=clean(value[key]);
  for(const key of ['error','reason'])if(value[key])value[key]={name:clean(value[key].name),message:clean(value[key].message)};
  return value;
 });
 const networkObservations=()=>[...network.values()].map(record=>{const doc=networkDocument(record);return{...record,url:clean(record.url),frame_id:doc?frameId(doc.frame):null,document_id:doc?.id??null};});
 const unmatchedRejections=failed=>{
  const all=attempts(),unmatched=[];
  for(const [documentId,doc] of documents)for(const end of doc.events.values())if(end.kind==='rejected'){
   const starts=all.filter(attempt=>attempt.documentId===documentId&&attempt.start.attempt_id===end.attempt_id&&attempt.end===end),attempt=starts.length===1?starts[0]:null;
   const matching=attempt?.valid?failed.filter(({entry})=>overlap(attempt,entry)):[];
   if(matching.length===1&&all.filter(other=>overlap(other,matching[0].entry)).length===1)continue;
   unmatched.push({document_id:documentId,frame_id:frameId(doc.frame),fetch_attempt_id:end.attempt_id??null,rejected_event_seq:end.event_seq,url:attempt?clean(attempt.start.url):null,method:attempt?.start.method??null,started_at_ms:attempt?.start.at_ms??null,rejected_at_ms:end.at_ms,error:{name:clean(end.error?.name),message:clean(end.error?.message)},reason:end.reason?{name:clean(end.reason.name),message:clean(end.reason.message)}:null});
  }
  return unmatched;
 };
 return{receive,classify,observations,errors,frameId,receiveNetworkDocument,bindNetwork,network,networkObservations,unmatchedRejections,get revision(){return revision;}};
}

function nativeFetchProbe({bindingName,flushName,networkBindingName}){
 const originalFetch=globalThis.fetch,documentId=crypto.randomUUID(),at=()=>performance.timeOrigin+performance.now();
 let sequence=0,attemptSequence=0,lost=false;
 const describe=error=>({name:typeof error?.name==='string'?error.name:'',message:typeof error?.message==='string'?error.message:''});
 const emit=event=>{
  try{const value={document_id:documentId,event_seq:++sequence,at_ms:at(),...event};if(event.kind==='document'&&typeof globalThis[networkBindingName]==='function')globalThis[networkBindingName](JSON.stringify(value));return Promise.resolve(globalThis[bindingName](value)).catch(()=>{lost=true;});}
  catch{lost=true;return Promise.resolve();}
 };
 void emit({kind:'document',frame_url:location.href});
 Object.defineProperty(globalThis,flushName,{value:async()=>{await emit({kind:'checkpoint'});return{document_id:documentId,lost};}});
 globalThis.fetch=function(...args){
  const [input,init]=args,attemptId=++attemptSequence;
  let url='',method='',bodyPresent=null,signal,supported=false;
  try{
   const fields=['method','body','signal'],plainInit=init==null||Object.getPrototypeOf(init)===Object.prototype&&fields.every(key=>!Object.getOwnPropertyDescriptor(init,key)?.get);
   if(plainInit&&(typeof input==='string'||input instanceof URL||input instanceof Request)){
    const request=input instanceof Request?input:null;
    url=new URL(request?request.url:String(input),location.href).href;
    method=String(init?.method??request?.method??'GET').toUpperCase();
    bodyPresent=init?.body!=null||request?.body!=null;
    signal=init&&Object.hasOwn(init,'signal')?init.signal:request?.signal;
    supported=!signal||signal instanceof AbortSignal;
   }
  }catch{}
  void emit({kind:'start',attempt_id:attemptId,url,method,body_present:bodyPresent,supported,frame_url:location.href});
  const aborted=()=>{try{void emit({kind:'abort',attempt_id:attemptId,reason:describe(signal.reason),already_aborted:false});}catch{lost=true;}};
  try{if(supported&&signal){
   if(signal.aborted)void emit({kind:'abort',attempt_id:attemptId,reason:describe(signal.reason),already_aborted:true});
   else signal.addEventListener('abort',aborted,{once:true});
  }}catch{lost=true;}
  const finish=(kind,value,syncThrow=false)=>{
   try{
   if(supported&&signal)signal.removeEventListener('abort',aborted);
   void emit({kind,attempt_id:attemptId,...(kind==='rejected'?{error:describe(value),sync_throw:syncThrow,reject_is_signal_reason:Boolean(signal?.aborted&&value===signal.reason)}:{}),signal_aborted:Boolean(signal?.aborted),reason:signal?.aborted?describe(signal.reason):null});
   }catch{lost=true;}
  };
  let promise;
  try{promise=Reflect.apply(originalFetch,this,args);}catch(error){finish('rejected',error,true);throw error;}
  return promise.then(response=>{finish('fulfilled');return response;},error=>{finish('rejected',error);throw error;});
 };
}

export async function installNativeFetchProbe(context,{clean=String}={}){
 const evidence=createNativeFetchEvidence({clean}),suffix=randomUUID().replaceAll('-',''),bindingName=`__oasisNativeFetch_${suffix}`,flushName=`__oasisNativeFlush_${suffix}`,networkBindingName=`__oasisNativeNetwork_${suffix}`;
 await context.exposeBinding(bindingName,({frame},event)=>evidence.receive(frame,event));
 await context.addInitScript(nativeFetchProbe,{bindingName,flushName,networkBindingName});
 evidence.attach=async page=>{
  const session=await context.newCDPSession(page),contexts=new Map();
  session.on('Runtime.executionContextCreated',({context})=>{if(context.auxData?.isDefault)contexts.set(context.id,context.auxData.frameId);});
  session.on('Runtime.executionContextDestroyed',({executionContextId})=>contexts.delete(executionContextId));
  session.on('Runtime.bindingCalled',event=>{if(event.name===networkBindingName){try{evidence.receiveNetworkDocument(contexts.get(event.executionContextId),JSON.parse(event.payload));}catch{evidence.errors.push('INVALID_NETWORK_BINDING');}}});
  session.on('Network.requestWillBeSent',event=>{
   const previous=evidence.network.get(event.requestId);
   evidence.network.set(event.requestId,{id:event.requestId,frame:event.frameId,url:event.request.url,method:event.request.method,started_at_ms:event.wallTime*1000,monotonic_start:event.timestamp,response_seen:false,redirected:Boolean(previous||event.redirectResponse),type:event.type});
  });
  session.on('Network.responseReceived',event=>{const record=evidence.network.get(event.requestId);if(record)record.response_seen=true;});
  session.on('Network.loadingFailed',event=>{const record=evidence.network.get(event.requestId);if(record){record.error=event.errorText;record.cancelled=event.canceled===true;record.failed_at_ms=record.started_at_ms+(event.timestamp-record.monotonic_start)*1000;}});
  await session.send('Runtime.enable');await session.send('Runtime.addBinding',{name:networkBindingName});await session.send('Network.enable');
  evidence.networkFlush=async()=>{if(!page.isClosed())await session.send('Runtime.evaluate',{expression:'void 0'});};
 };
 evidence.flush=async page=>{
  if(page.isClosed())return;
  await Promise.all(page.frames().map(async frame=>{
   try{const value=await frame.evaluate(async name=>typeof globalThis[name]==='function'?await globalThis[name]():null,flushName);if(value?.lost)evidence.errors.push('FETCH_PROBE_TELEMETRY_LOST');}
   catch(error){if(!frame.isDetached()&&!page.isClosed())throw error;}
  }));
  await evidence.networkFlush?.();
 };
 return evidence;
}

export async function reserveNativeReportDirectory(out,report){
 await fs.mkdir(out,{recursive:true});
 assert.equal((await fs.readdir(out)).length,0,'OUTPUT_ALREADY_EXISTS: preserve previous evidence and choose a fresh directory');
 await fs.writeFile(resolve(out,'native-browser.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
}

export function observeNativeBrowser(page,{origin,state,result,clean=String,remember=()=>{},drainTimeoutMs=10000,fetchProbe=null}){
 const tasks=new Set(),requests=new WeakMap(),requestEntries=[],failedEntries=[],recordedFailures=new Set(),recordedProbeErrors=new Set(),recordedUnmatchedRejections=new Set();
 const runSnapshots=createRunSnapshotObserver();
 if(state.game==='run'&&state.token&&state.sessionId&&state.playerId&&state.appId)runSnapshots.authorize({token:state.token,sessionId:state.sessionId,playerId:state.playerId,appId:state.appId});
 result.run_snapshot_duplicates??=[];
 for(const key of ['js_errors','resource_errors','observer_errors','http_errors','network_errors'])result[key]??=[];
 result.network_observations??=[];result.fetch_observations??=[];result.lifecycle_cancellations??=[];result.pending_network_observations=0;
 result.unmatched_fetch_rejections??=[];
 state.creations??=[];state.actionRequests??=[];state.probabilityRequests??=[];
 result.creations=state.creations;result.action_requests=state.actionRequests;result.probability_requests=state.probabilityRequests;
 const phase=()=>state.phase||(state.returning?'returning':'entry');
 const address=request=>{
  const url=new URL(request.url()),frame=typeof request.frame==='function'?request.frame():null,frameUrl=frame?.url();
  const roomId=/^\/api\/pvp\/rooms\/([^/]+)$/.exec(url.pathname)?.[1];
  return{request,request_id:`network-${requestEntries.length+1}`,origin:url.origin,path:url.pathname,query:url.search,full_url:url.href,frame_object:frame,frame_url_raw:frameUrl,method:request.method(),type:request.resourceType(),phase:phase(),frame_url:frameUrl?clean(frameUrl):null,game_frame_request:frameUrl===origin+'/play/'+state.game,session_id:state.sessionId,player_id:state.playerId,owned_room_at_start:Boolean(url.origin===origin&&roomId&&state.ownedRooms?.has(roomId)),body_present:typeof request.postData==='function'?request.postData()!==null:null,redirected:Boolean(request.redirectedFrom?.()||request.redirectedTo?.()),response_seen:false};
 };
 const row=entry=>({path:clean(entry.path),method:entry.method,phase:entry.phase,frame_url:entry.frame_url,game_frame_request:entry.game_frame_request,session_id:entry.session_id?clean(entry.session_id):null,player_id:entry.player_id?clean(entry.player_id):null});
 const failure=(stage,error,entry={})=>result.observer_errors.push({stage,...row(entry),observed_phase:phase(),message:clean(message(error))});
 page.on('pageerror',error=>result.js_errors.push(clean(message(error))));
 page.on('console',item=>{if(item.type()==='error')result.js_errors.push(clean(item.text()));});
 page.on('request',request=>{let entry;try{
  entry=address(request);entry.request_observed=true;requests.set(request,entry);requestEntries.push(entry);
  if(entry.origin===origin&&(entry.path.startsWith('/api/pvp/rooms')||entry.path==='/v1/launch/exchange'))entry.runSnapshotTicket=runSnapshotRequest(runSnapshots,request,entry.path);
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
  entry.failure_error=error;
  for(const intent of [entry.creation,entry.action,entry.probability])if(intent)intent.transport_error=error;
  if(entry.creation)entry.creation.finished=true;
  if(entry.origin===origin&&apiPath(entry.path)||['fetch','xhr'].includes(entry.type)){
   const observation=Object.freeze({observation_id:entry.request_id,...row(entry),frame_id:fetchProbe?.frameId(entry.frame_object)??null,observed_at_ms:Date.now(),error});result.network_observations.push(observation);
   failedEntries.push({entry,observation});result.pending_network_observations++;
   if(!fetchProbe){result.network_errors.push({...observation});recordedFailures.add(observation.observation_id);result.pending_network_observations--;}
  }
  else if(assets.has(entry.type))result.resource_errors.push({...row(entry),error});
 }catch(error){failure('requestfailed',error,entry);}});
 page.on('response',response=>{
  let entry;
  const work=(async()=>{
   const request=response.request();entry=requests.get(request)||address(request);entry.response_seen=true;
   const status=response.status(),path=entry.path;
   for(const intent of [entry.creation,entry.action,entry.probability])if(intent)intent.status=status;
   if(assets.has(entry.type)&&status>=400)result.resource_errors.push({...row(entry),status});
   if(entry.origin===origin&&apiPath(path)?!response.ok():['fetch','xhr'].includes(entry.type)&&status>=400)result.http_errors.push({...row(entry),status});
   if(entry.origin!==origin)return;
   if(!response.ok())return;
   if(['/api/demo/config','/api/demo/launch','/v1/launch/exchange'].includes(path)){
    const decoded=response.json().then(body=>{remember(body);
     if(path==='/v1/launch/exchange'){
      assert.equal(body.game_id,state.game,'Exchange game differs');
      assert.ok(body.session_id&&body.external_user_id&&body.access_token,'Incomplete launch exchange');
      if(state.sessionId)assert.equal(body.session_id,state.sessionId,'Reauthorization replaced the original session');
      if(state.playerId)assert.equal(body.external_user_id,state.playerId,'Reauthorization replaced the original player');
      if(state.game==='run')runSnapshots.authorize({token:body.access_token,sessionId:body.session_id,playerId:body.external_user_id,appId:body.scope?.app_id},entry.runSnapshotTicket);
      state.token=body.access_token;state.sessionId=body.session_id;state.playerId=body.external_user_id;result.launch_exchange=true;
     }
     return body;
    });
    await runSnapshots.enqueue(decoded,()=>{});
   }
   if(path.startsWith('/api/pvp/rooms')){
    await runSnapshots.enqueue(response.json(),body=>{const room=body.room||body;
     if(!room.id&&(Object.hasOwn(room,'run_game_transfer')||entry.method==='GET'&&/^\/api\/pvp\/rooms\/[^/]+$/.test(path)))runSnapshots.inspect(entry.runSnapshotTicket,room);
     if(room.id){
      assert.equal(room.game_id,state.game,'Observed room belongs to another game');
      assert.equal(room.me,state.playerId,'Observed room belongs to another player');
      if(entry.creation){
       assert.equal(room.practice,true);assert.equal(room.entry_minor,'0');
       entry.creation.room_id=room.id;state.ownedRooms.add(room.id);
      }
      const observed=runSnapshots.inspect(entry.runSnapshotTicket,room);
      if(observed.kind==='duplicate')result.run_snapshot_duplicates.push({...row(entry),...observed.evidence});
      else if(!state.room||state.room.id!==room.id||room.version>=state.room.version)state.room=room;
     }
    });
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
  if(fetchProbe){
   let timer;
   try{await Promise.race([fetchProbe.flush?.(page),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Fetch observer drain timed out')),Math.max(1,deadline-Date.now()));})]);}catch(error){failure('fetch-probe-drain',error);throw error;}finally{clearTimeout(timer);}
   while(tasks.size){assert.ok(Date.now()<deadline,'Response observer drain timed out');await new Promise(resolve=>setTimeout(resolve,5));}
   for(const entry of requestEntries){try{entry.network_started_at_ms=entry.request.timing?.().startTime;entry.redirected||=Boolean(entry.request.redirectedFrom?.()||entry.request.redirectedTo?.());}catch{entry.network_started_at_ms=null;}}
   fetchProbe.bindNetwork?.(requestEntries,failedEntries);
   result.network_protocol_observations=fetchProbe.networkObservations?.()||[];
   const previousClassifications=new Map(result.lifecycle_cancellations.map(value=>[value.observation_id,value]));
   result.fetch_observations=fetchProbe.observations();result.lifecycle_cancellations=[];
   for(const {entry,observation} of failedEntries){
    const classification=fetchProbe.classify(entry,requestEntries);
    if(classification.eligible&&!recordedFailures.has(observation.observation_id))result.lifecycle_cancellations.push({...observation,...classification.proof});
    else if(!recordedFailures.has(observation.observation_id)){result.network_errors.push({...observation,classification_failure:classification.reason,...(previousClassifications.has(observation.observation_id)?{previous_lifecycle_classification:previousClassifications.get(observation.observation_id)}:{})});recordedFailures.add(observation.observation_id);}
   }
   for(const error of fetchProbe.errors)if(!recordedProbeErrors.has(error)){failure('fetch-probe',error);recordedProbeErrors.add(error);}
   for(const rejection of fetchProbe.unmatchedRejections?.(failedEntries)||[]){
    const id=`${rejection.document_id}:${rejection.fetch_attempt_id}:${rejection.rejected_event_seq}`;
    if(!recordedUnmatchedRejections.has(id)){result.unmatched_fetch_rejections.push(rejection);failure('unmatched-fetch-rejection',`${rejection.error.name}: ${rejection.error.message}`);recordedUnmatchedRejections.add(id);}
   }
   result.pending_network_observations=0;
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
 return !result.pending_network_observations&&['js_errors','resource_errors','observer_errors','http_errors','network_errors'].every(key=>Array.isArray(result[key])&&result[key].length===0);
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
