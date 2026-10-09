/** Strict, independently testable gates for the native-host browser smoke. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runPracticeInputBaseline,verifyRunPracticeInputAction} from '../scripts/android-game-actions.mjs';
import {createRunSnapshotObserver,runSnapshotRequest} from './run-snapshot-observer.mjs';

const terminal=status=>['cancelled','settled','voided'].includes(status);
const apiPath=path=>/^\/(?:api|v1)\//.test(path);
const assets=new Set(['document','script','stylesheet','image','media','font']);
const message=error=>String(error?.message||error);
const pollCancellationReasons=new Set(['OASIS_ROOM_POLL_STOPPED','OASIS_ROOM_POLL_BACKGROUND']);
const fetchClockUncertaintyMs=1;

export function createNativeFetchEvidence({clean=String}={}){
 const frames=new WeakMap(),documents=new Map(),events=[],errors=[],network=new Map(),networkDocuments=new Map(),listeners=new Set();
 let frameSequence=0,revision=0;
 const changed=kind=>{revision++;for(const listener of listeners)try{listener(kind);}catch{errors.push('FETCH_PROBE_CHANGE_LISTENER_FAILED');}};
 const onChange=listener=>{assert.equal(typeof listener,'function');listeners.add(listener);return()=>listeners.delete(listener);};
 const notifyNetworkChange=()=>changed('network');
 const frameId=frame=>{if(!frame||typeof frame!=='object')return null;if(!frames.has(frame))frames.set(frame,`frame-${++frameSequence}`);return frames.get(frame);};
 const receive=(frame,event)=>{
  try{
  if(events.length>=20000){errors.push('FETCH_PROBE_EVENT_LIMIT');return;}
  if(!frameId(frame)||!event||typeof event.document_id!=='string'||!event.document_id||!Number.isSafeInteger(event.event_seq)||event.event_seq<1||!Number.isFinite(event.at_ms)||!['document','checkpoint','start','abort','fulfilled','rejected'].includes(event.kind)){errors.push('INVALID_FETCH_PROBE_EVENT');return;}
  let doc=documents.get(event.document_id);
  if(!doc){doc={frame,events:new Map()};documents.set(event.document_id,doc);}
  if(doc.frame!==frame||doc.events.has(event.event_seq)){errors.push('CONFLICTING_FETCH_PROBE_EVENT');return;}
  const value=structuredClone(event);doc.events.set(value.event_seq,value);events.push({frame_id:frameId(frame),...value});
  }finally{changed('fetch');}
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
 const cancellationCandidates=(all,entry,exclusions=[])=>{
  const candidates=all.filter(attempt=>overlap(attempt,entry));
  if(entry.network_timing_source!=='cdp'||!entry.network_document_id||!entry.network_protocol_id||entry.network_proof_error||entry.response_seen!==false||entry.failure_error!=='net::ERR_ABORTED')return candidates;
  const uniqueStart=attempt=>{
   const document=networkDocuments.get(attempt.documentId);
   if(!document)return null;
   const records=[...network.values()].filter(record=>record.frame===document.frame&&record.type==='Fetch'&&record.url===attempt.start.url&&record.method===attempt.start.method&&(!Number.isFinite(record.started_at_ms)||Math.abs(record.started_at_ms-attempt.start.at_ms)<=fetchClockUncertaintyMs));
   if(records.length!==1)return null;
   const record=records[0],owner=networkDocument(record);
   if(owner?.id!==attempt.documentId||owner.frame!==attempt.frame||owner.url!==attempt.start.frame_url)return null;
   const starts=all.filter(other=>other.frame===attempt.frame&&Math.abs(other.start.at_ms-record.started_at_ms)<=fetchClockUncertaintyMs&&(!other.start.supported||other.start.frame_url===owner.url&&other.start.url===record.url&&other.start.method===record.method));
   return starts.length===1&&starts[0]===attempt?record:null;
  };
  // A concurrent success needs its own bidirectionally unique CDP start, plus
  // the cancelled fetch's independent unique start. Fulfilled means headers,
  // not a verified body; response-body observer failures remain fatal. Never
  // choose the nearest timestamp or remove a success merely because it ended.
  return candidates.filter(attempt=>{
   const {start,end}=attempt;
   const completed=attempt.documentId===entry.network_document_id&&attempt.valid&&start.supported===true&&start.body_present===false&&!attempt.abort&&end?.kind==='fulfilled'&&end.signal_aborted===false&&end.reason===null&&!['error','sync_throw','reject_is_signal_reason'].some(key=>Object.hasOwn(end,key));
   if(!completed)return true;
   if(candidates.some(next=>next!==attempt&&next.documentId===attempt.documentId&&next.valid&&next.end?.kind==='rejected'&&next.start.event_seq>end.event_seq&&next.start.at_ms>=end.at_ms))return false;
   const success=uniqueStart(attempt);
   if(!success||success.response_seen!==true||success.response_status!==200||success.error||success.cancelled||success.redirected!==false)return true;
   const cancelled=candidates.filter(next=>{
    if(next===attempt||next.documentId!==attempt.documentId||!next.valid||next.start.supported!==true||next.start.body_present!==false||next.end?.kind!=='rejected')return false;
    const record=uniqueStart(next);
    return record?.id===entry.network_protocol_id&&(record.session_id??null)===entry.network_session_id&&record.started_at_ms===entry.network_started_at_ms;
   });
   if(cancelled.length!==1)return true;
   exclusions.push({fetch_attempt_id:start.attempt_id,fetch_started_at_ms:start.at_ms,fulfilled_at_ms:end.at_ms,network_protocol_id:success.id,network_session_id:success.session_id??null,network_started_at_ms:success.started_at_ms,response_status:success.response_status});
   return false;
  });
 };
 const receiveNetworkDocument=(frame,event)=>{
  try{
  if(!frame||event?.kind!=='document'||typeof event.document_id!=='string'||!Number.isFinite(event.at_ms)){errors.push('INVALID_NETWORK_DOCUMENT');return;}
  const previous=networkDocuments.get(event.document_id);
  if(previous&&(previous.frame!==frame||previous.at_ms!==event.at_ms)){errors.push('CONFLICTING_NETWORK_DOCUMENT');return;}
  networkDocuments.set(event.document_id,{frame,...event});
  }finally{changed('network-document');}
 };
 const networkDocument=record=>{
  const candidates=[...networkDocuments.entries()].filter(([_id,doc])=>doc.frame===record.frame&&doc.at_ms<=record.started_at_ms).sort((a,b)=>b[1].at_ms-a[1].at_ms);
  if(!candidates.length||candidates.length>1&&candidates[0][1].at_ms===candidates[1][1].at_ms)return null;
  const [id,doc]=candidates[0],observed=documents.get(id),identity=observed?.events.get(1);
  return identity?.kind==='document'&&identity.at_ms===doc.at_ms&&identity.frame_url===doc.frame_url?{id,frame:observed.frame,url:doc.frame_url}:null;
 };
 const bindNetwork=(requests,failed)=>{
  const same=(record,entry)=>{const doc=networkDocument(record);return doc?.frame===entry.frame_object&&doc.url===entry.frame_url_raw&&record.url===entry.full_url&&record.method===entry.method;};
  const identity=record=>({id:record.id,session_id:record.session_id??null,started_at_ms:record.started_at_ms});
  const identical=(a,b)=>a.id===b.id&&(a.session_id??null)===(b.session_id??null)&&a.started_at_ms===b.started_at_ms;
  const protocolKey=record=>JSON.stringify([record.session_id??null,record.id]);
  const verifiedBindings=new Set();
  // Revalidate previously unique bindings first. A later zero Playwright clock
  // must not erase a proven protocol identity, nor may that identity mask drift.
  for(const {entry,observation} of [...failed].sort((a,b)=>Number(Boolean(b.entry.network_binding_identity))-Number(Boolean(a.entry.network_binding_identity)))){
   const playwrightTime=entry.network_started_at_ms>0?entry.network_started_at_ms:null,retained=entry.network_binding_identity;
   const knownTime=retained?.started_at_ms??playwrightTime;
   entry.network_proof_error=null;
   entry.network_candidate_identity=null;
   entry.network_binding_incomplete=false;
   entry.network_binding_observation={playwright_started_at_ms:playwrightTime,retained_identity:retained?{...retained}:null,candidates:[]};
   if(retained&&playwrightTime&&Math.abs(playwrightTime-retained.started_at_ms)>fetchClockUncertaintyMs){entry.network_proof_error='CONFLICTING_NETWORK_CLOCKS';continue;}
   const related=[...network.values()].filter(record=>record.type==='Fetch'&&same(record,entry));
   const anchor=entry.network_binding_anchor;
   if(retained&&anchor&&related.some(record=>!anchor.protocol_keys.includes(protocolKey(record))&&(!Number.isFinite(record.started_at_ms)||record.started_at_ms<=anchor.at_ms+fetchClockUncertaintyMs))){entry.network_proof_error='LATE_COMPETING_CDP_EVIDENCE';continue;}
   if(!related.length&&knownTime&&!retained)continue;
   const candidates=related.filter(record=>{
    if(knownTime)return !Number.isFinite(record.started_at_ms)||Math.abs(record.started_at_ms-knownTime)<=fetchClockUncertaintyMs;
    // A zero Playwright start time cannot be compared with CDP wallTime. Match
    // explicit protocol failures, not historical successes by a 1ms clock join.
    // Header/body failures remain candidates; incomplete requests also remain
    // ambiguous until their protocol outcome arrives. Nothing is exempted here:
    // classify() still requires one exact document/frame fetch and its abort chain.
    return (Boolean(record.error)||record.response_seen!==true)&&!failed.some(other=>other.entry!==entry&&verifiedBindings.has(other.entry)&&identical(other.entry.network_binding_identity,record));
   });
   entry.network_binding_observation.candidates=candidates.map(record=>({...identity(record),document_id:networkDocument(record)?.id??null,response_seen:record.response_seen===true,error:record.error??null,cancelled:record.cancelled===true,failed_at_ms:record.failed_at_ms??null}));
   entry.network_binding_incomplete=!knownTime&&(!candidates.length||candidates.some(record=>!record.error&&record.response_seen!==true));
   if(knownTime&&related.length&&!candidates.length){entry.network_proof_error='CONFLICTING_NETWORK_CLOCKS';continue;}
   if(candidates.length!==1){entry.network_proof_error=candidates.length?'AMBIGUOUS_CDP_NETWORK_FAILURE':'MISSING_CDP_NETWORK_PROOF';continue;}
   const record=candidates[0];
   if(retained&&!identical(retained,record)){entry.network_proof_error='CONFLICTING_NETWORK_IDENTITY';continue;}
   entry.response_seen||=record.response_seen;entry.redirected||=record.redirected;
   if(record.error!==observation.error){entry.network_proof_error='CONFLICTING_NETWORK_FAILURE';continue;}
   if(failed.filter(other=>{const at=other.entry.network_binding_identity?.started_at_ms??other.entry.network_started_at_ms;return same(record,other.entry)&&other.observation.error===record.error&&(other.entry===entry||(!(at>0)?!retained:Math.abs(at-record.started_at_ms)<=fetchClockUncertaintyMs));}).length!==1){entry.network_proof_error='AMBIGUOUS_PLAYWRIGHT_NETWORK_FAILURE';continue;}
   if(record.error!=='net::ERR_ABORTED'||record.cancelled!==true||!Number.isFinite(record.failed_at_ms)||record.failed_at_ms<record.started_at_ms){entry.network_proof_error='NOT_ABORTED_CDP_FAILURE';continue;}
   entry.network_started_at_ms=record.started_at_ms;entry.network_failed_at_ms=record.failed_at_ms;entry.network_protocol_id=record.id;entry.network_session_id=record.session_id??null;entry.network_document_id=networkDocument(record).id;entry.network_timing_source='cdp';entry.response_seen||=record.response_seen;entry.redirected||=record.redirected;entry.network_proof_error=null;
   entry.network_candidate_identity=identity(record);entry.network_candidate_keys=related.map(protocolKey);
   if(retained)verifiedBindings.add(entry);
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
  const exclusions=[],candidates=cancellationCandidates(allAttempts,entry,exclusions);
  if(candidates.length!==1)return deny(candidates.length?'AMBIGUOUS_FETCH_ATTEMPT':'MISSING_FETCH_ATTEMPT');
  const attempt=candidates[0],{start,abort,end}=attempt;
  if(entry.network_document_id&&attempt.documentId!==entry.network_document_id)return deny('CONFLICTING_NETWORK_DOCUMENT');
  if(requests.filter(other=>overlap(attempt,other)).length!==1)return deny('AMBIGUOUS_NETWORK_REQUEST');
  if(!attempt.valid||!start.supported||start.body_present!==false||!Number.isSafeInteger(start.attempt_id)||start.attempt_id<1)return deny('INCOMPLETE_FETCH_PROOF');
  if(!abort||abort.already_aborted||!end||end.kind!=='rejected'||end.sync_throw||!end.signal_aborted||!end.reject_is_signal_reason)return deny('FETCH_DID_NOT_REJECT_FROM_OBSERVED_ABORT');
  const reason=abort.reason;
  if(reason?.name!=='AbortError'||!pollCancellationReasons.has(reason.message)||end.reason?.name!==reason.name||end.reason?.message!==reason.message||end.error?.name!==reason.name||end.error?.message!==reason.message)return deny('NOT_LIFECYCLE_ABORT_REASON');
  if(!(start.event_seq<abort.event_seq&&abort.event_seq<end.event_seq&&start.at_ms<=abort.at_ms&&start.at_ms-fetchClockUncertaintyMs<=entry.network_started_at_ms&&entry.network_started_at_ms<=abort.at_ms+fetchClockUncertaintyMs&&abort.at_ms<=end.at_ms))return deny('INVALID_ABORT_ORDER');
  if(entry.network_candidate_identity&&!entry.network_binding_identity){
   const prefix=[...documents.get(attempt.documentId).events.values()].sort((a,b)=>a.event_seq-b.event_seq);
   if(!prefix.every((event,index)=>event.event_seq===index+1&&(index===0||event.at_ms>=prefix[index-1].at_ms)))return deny('INCOMPLETE_FETCH_PROOF');
   const watermark=prefix.at(-1);
   entry.network_binding_identity=Object.freeze({...entry.network_candidate_identity});
   entry.network_binding_anchor=Object.freeze({document_id:attempt.documentId,event_seq:watermark.event_seq,at_ms:watermark.at_ms,protocol_keys:Object.freeze([...entry.network_candidate_keys])});
  }
  return{eligible:true,proof:{document_id:attempt.documentId,frame_id:attempt.frameId,fetch_attempt_id:start.attempt_id,clock_uncertainty_ms:fetchClockUncertaintyMs,fetch_started_at_ms:start.at_ms,network_started_at_ms:entry.network_started_at_ms,network_failed_at_ms:entry.network_failed_at_ms??null,network_protocol_id:entry.network_protocol_id??null,network_session_id:entry.network_session_id??null,network_timing_source:entry.network_timing_source||'playwright',aborted_at_ms:abort.at_ms,rejected_at_ms:end.at_ms,reason:{...reason},error:{...end.error},trace_event_seqs:[start.event_seq,abort.event_seq,end.event_seq],...(exclusions.length?{concurrent_fulfilled_exclusions:exclusions}:{})}};
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
   if(matching.length===1&&cancellationCandidates(all,matching[0].entry).length===1)continue;
   unmatched.push({document_id:documentId,frame_id:frameId(doc.frame),fetch_attempt_id:end.attempt_id??null,rejected_event_seq:end.event_seq,url:attempt?clean(attempt.start.url):null,method:attempt?.start.method??null,started_at_ms:attempt?.start.at_ms??null,rejected_at_ms:end.at_ms,error:{name:clean(end.error?.name),message:clean(end.error?.message)},reason:end.reason?{name:clean(end.reason.name),message:clean(end.reason.message)}:null});
  }
  return unmatched;
 };
 const rejectionPending=(rejection,pending)=>{
  const attempt=attempts().find(value=>value.documentId===rejection.document_id&&value.start.attempt_id===rejection.fetch_attempt_id&&value.end?.event_seq===rejection.rejected_event_seq);
  if(!attempt?.valid||!attempt.abort||attempt.abort.already_aborted||attempt.end.sync_throw||!attempt.end.signal_aborted||!attempt.end.reject_is_signal_reason||attempt.end.reason?.name!=='AbortError'||!pollCancellationReasons.has(attempt.end.reason.message))return false;
  return pending.some(entry=>attempt.frame===entry.frame_object&&attempt.start.frame_url===entry.frame_url_raw&&attempt.start.url===entry.full_url&&attempt.start.method===entry.method);
 };
 const hasDocument=(frame,id,url)=>{const doc=documents.get(id),first=doc?.events.get(1);return doc?.frame===frame&&first?.kind==='document'&&first.frame_url===url;};
 const inspectChallenge=(frame,id,url,before,after)=>{
  const doc=documents.get(id),ordered=[...(doc?.events.values()||[])].filter(event=>event.event_seq<=after).sort((a,b)=>a.event_seq-b.event_seq);
  const matching=attempts().filter(attempt=>attempt.frame===frame&&attempt.documentId===id&&attempt.start.url===url),attempt=matching[0];
  const records=[...network.values()].filter(record=>record.url===url),record=records[0],mapped=record&&networkDocument(record);
  const summary={starts:matching.length,fulfilled:matching.filter(item=>item.end?.kind==='fulfilled').length,rejected:matching.filter(item=>item.end?.kind==='rejected').length,
   checkpoints:doc?.events.get(before)?.kind==='checkpoint'&&doc?.events.get(after)?.kind==='checkpoint',
   complete_prefix:ordered.length===after&&ordered.every((event,index)=>event.event_seq===index+1&&(index===0||event.at_ms>=ordered[index-1].at_ms)),
   network_requests:records.length,network_statuses:records.map(item=>item.response_status??null)};
  summary.passed=Boolean(!errors.length&&summary.checkpoints&&summary.complete_prefix&&matching.length===1&&attempt.valid&&attempt.start.supported&&attempt.start.method==='GET'&&attempt.start.body_present===false&&!attempt.abort&&attempt.end?.kind==='fulfilled'&&!attempt.end.signal_aborted&&attempt.start.event_seq>before&&attempt.end.event_seq<after&&records.length===1&&mapped?.frame===frame&&mapped.id===id&&record.method==='GET'&&record.type==='Fetch'&&record.response_seen&&record.response_status===200&&!record.error&&!record.redirected);
  return summary;
 };
 return{receive,classify,observations,errors,frameId,receiveNetworkDocument,bindNetwork,network,networkObservations,unmatchedRejections,rejectionPending,hasDocument,inspectChallenge,onChange,notifyNetworkChange,get revision(){return revision;}};
}

function nativeFetchProbe({bindingName,flushName,networkBindingName}){
 // getRandomValues is available in the initial about: realm too. Do not depend
 // on secure-context-only randomUUID before the first HTTPS navigation.
 const originalFetch=globalThis.fetch,documentId=Array.from(crypto.getRandomValues(new Uint8Array(16)),value=>value.toString(16).padStart(2,'0')).join(''),at=()=>performance.timeOrigin+performance.now();
 let sequence=0,attemptSequence=0,lost=false,wrappedFetch;
 const describe=error=>({name:typeof error?.name==='string'?error.name:'',message:typeof error?.message==='string'?error.message:''});
 const emit=event=>{
  try{const value={document_id:documentId,event_seq:++sequence,at_ms:at(),...event};if(event.kind==='document'&&typeof globalThis[networkBindingName]==='function')globalThis[networkBindingName](JSON.stringify(value));return Promise.resolve(globalThis[bindingName](value)).catch(()=>{lost=true;});}
  catch{lost=true;return Promise.resolve();}
 };
 void emit({kind:'document',frame_url:location.href});
 Object.defineProperty(globalThis,flushName,{value:async()=>{const event_seq=sequence+1;await emit({kind:'checkpoint'});return{document_id:documentId,event_seq,frame_url:location.href,lost,fetch_wrapper_intact:globalThis.fetch===wrappedFetch};}});
 globalThis.fetch=wrappedFetch=function(...args){
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
 const attachedPages=new WeakSet(),pageErrors=new WeakMap(),errorSubscribers=new WeakMap(),networkFlushes=[];let sessionSequence=0;
 const observeErrors=page=>{
  if(pageErrors.has(page))return;const rows=[];pageErrors.set(page,rows);
  const record=(kind,error)=>{const row={kind,page_url:clean(page.url()),message:clean(message(error))};rows.push(row);for(const receive of errorSubscribers.get(page)||[])receive({...row});};
  page.on('pageerror',error=>record('pageerror',error));
  page.on('console',item=>{if(item.type()==='error')record('console',item.text());});
 };
 context.on('page',observeErrors);for(const page of context.pages())observeErrors(page);
 evidence.pageErrors=page=>pageErrors.get(page)?.map(row=>({...row}))??[];
 evidence.observePageErrors=(page,receive)=>{observeErrors(page);if(!errorSubscribers.has(page))errorSubscribers.set(page,new Set());errorSubscribers.get(page).add(receive);for(const row of pageErrors.get(page))receive({...row});};
 await context.exposeBinding(bindingName,({frame},event)=>evidence.receive(frame,event));
 await context.addInitScript(nativeFetchProbe,{bindingName,flushName,networkBindingName});
 evidence.attach=async page=>{
  if(attachedPages.has(page)){evidence.errors.push('DUPLICATE_NETWORK_PAGE_ATTACHMENT');throw new Error('DUPLICATE_NETWORK_PAGE_ATTACHMENT');}
  attachedPages.add(page);
  const session=await context.newCDPSession(page),contexts=new Map(),sessionId=`cdp-session-${++sessionSequence}`,key=id=>`${sessionId}:${id}`;
  session.on('Runtime.executionContextCreated',({context})=>{if(context.auxData?.isDefault)contexts.set(context.id,context.auxData.frameId);});
  session.on('Runtime.executionContextDestroyed',({executionContextId})=>contexts.delete(executionContextId));
  session.on('Runtime.bindingCalled',event=>{if(event.name===networkBindingName){try{const frame=contexts.get(event.executionContextId);evidence.receiveNetworkDocument(frame?key(frame):null,JSON.parse(event.payload));}catch{evidence.errors.push('INVALID_NETWORK_BINDING');}}});
  session.on('Network.requestWillBeSent',event=>{
   const previous=evidence.network.get(key(event.requestId));
   evidence.network.set(key(event.requestId),{id:event.requestId,session_id:sessionId,frame:key(event.frameId),url:event.request.url,method:event.request.method,started_at_ms:event.wallTime*1000,monotonic_start:event.timestamp,response_seen:false,redirected:Boolean(previous||event.redirectResponse),type:event.type});
   evidence.notifyNetworkChange();
  });
  session.on('Network.responseReceived',event=>{const record=evidence.network.get(key(event.requestId));if(record){record.response_seen=true;record.response_status=event.response?.status??null;evidence.notifyNetworkChange();}});
  session.on('Network.loadingFailed',event=>{const record=evidence.network.get(key(event.requestId));if(record){record.error=event.errorText;record.cancelled=event.canceled===true;record.failed_at_ms=record.started_at_ms+(event.timestamp-record.monotonic_start)*1000;evidence.notifyNetworkChange();}});
  await session.send('Runtime.enable');await session.send('Runtime.addBinding',{name:networkBindingName});await session.send('Network.enable');
  networkFlushes.push(async()=>{if(!page.isClosed())await session.send('Runtime.evaluate',{expression:'void 0'});});
 };
 evidence.networkFlush=async()=>{await Promise.all(networkFlushes.map(flush=>flush()));};
 evidence.installationObservations=[];
 evidence.requireInstalled=async frame=>{
  const url=frame.url(),observation={frame_id:evidence.frameId(frame),frame_url:clean(url),passed:false};evidence.installationObservations.push(observation);
  const shape=value=>({document_available:Boolean(value&&evidence.hasDocument(frame,value.document_id,url)),document_id:value?.document_id??null,event_seq:value?.event_seq??null,lost:value?.lost??null,fetch_wrapper_intact:value?.fetch_wrapper_intact??null,frame_url_matches:value?.frame_url===url});
  const valid=value=>value&&typeof value.document_id==='string'&&/^[a-f0-9]{32}$/.test(value.document_id)&&value.frame_url===url&&value.lost===false&&evidence.hasDocument(frame,value.document_id,url);
  let deadline,open=true;const stillOpen=()=>{if(!open)throw Error('FETCH_PROBE_CHALLENGE_TIMEOUT');};
  try{return await Promise.race([(async()=>{
   const before=await frame.evaluate(async name=>typeof globalThis[name]==='function'?await globalThis[name]():null,flushName);stillOpen();observation.before=shape(before);
   if(!valid(before))throw Error('FETCH_PROBE_NOT_INSTALLED');
   if(url==='about:blank'){
    if(before.fetch_wrapper_intact!==true)throw Error('FETCH_PROBE_NOT_INSTALLED');
    observation.passed=true;observation.verification='direct-initial-realm';return Object.freeze({...before,verification:observation.verification});
   }
   const parsed=new URL(url);if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)))throw Error('FETCH_PROBE_UNSAFE_CHALLENGE_ORIGIN');
   // The deployed API compares req.url literally; /health?nonce is not /health.
   // No nonce/header is added. inspectChallenge requires one request across the
   // entire CDP collection, so any other same-URL candidate fails closed.
   const challenge=new URL('/health',url);
   const received=await frame.evaluate(async challengeUrl=>{
    const controller=new AbortController();let timer;
    try{return await Promise.race([(async()=>{const response=await globalThis.fetch(challengeUrl,{method:'GET',credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
     let bytes=0;const reader=response.body?.getReader();if(reader)for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>16384){await reader.cancel();throw Error('CHALLENGE_BODY_LIMIT');}}
     return{status:response.status,url:response.url,redirected:response.redirected,bytes};})(),new Promise((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('CHALLENGE_TIMEOUT'));},5000);})]);}
    catch{return{failed:true};}finally{clearTimeout(timer);}
   },challenge.href);
   stillOpen();
   observation.http={status:received?.status??null,url_matches:received?.url===challenge.href,redirected:received?.redirected??null,bytes:received?.bytes??null,failed:received?.failed===true};
   const after=await frame.evaluate(async name=>typeof globalThis[name]==='function'?await globalThis[name]():null,flushName);stillOpen();observation.after=shape(after);await evidence.networkFlush();stillOpen();
   observation.challenge=evidence.inspectChallenge(frame,before.document_id,challenge.href,before.event_seq,after?.event_seq);
   if(!valid(after)||after.document_id!==before.document_id||received?.status!==200||received.url!==challenge.href||received.redirected!==false||!observation.challenge.passed)throw Error('FETCH_PROBE_CHALLENGE_FAILED');
   observation.passed=true;observation.verification='same-document-fetch-challenge';
   return Object.freeze({...after,verification:observation.verification,challenge:Object.freeze({...observation.challenge})});
  })(),new Promise((_resolve,reject)=>{deadline=setTimeout(()=>reject(Error('FETCH_PROBE_CHALLENGE_TIMEOUT')),10000);})]);}
  catch(error){const code=['FETCH_PROBE_NOT_INSTALLED','FETCH_PROBE_UNSAFE_CHALLENGE_ORIGIN','FETCH_PROBE_CHALLENGE_FAILED','FETCH_PROBE_CHALLENGE_TIMEOUT'].includes(error?.message)?error.message:'FETCH_PROBE_INSTALLATION_CHECK_FAILED';observation.failure=code;evidence.errors.push(code);throw Error(code);}
  finally{open=false;clearTimeout(deadline);}
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
 const tasks=new Map(),requests=new WeakMap(),requestEntries=[],failedEntries=[],recordedFailures=new Set(),recordedProbeErrors=new Set(),recordedUnmatchedRejections=new Set();
 let drainSequence=0,workSequence=0;
 const maxDrainRecords=64,maxWorkDetails=16;
 result.observer_drain_observations??=[];result.observer_drain_observations_dropped??=0;
 const workDetails=(task,at)=>({work_id:task.work_id,request_id:task.request_id,kind:task.kind,stage:task.stage,
  started_at_ms:task.started_at_ms,body_started_at_ms:task.body_started_at_ms,body_completed_at_ms:task.body_completed_at_ms,
  completed_at_ms:task.completed_at_ms,elapsed_ms:Math.max(0,(task.completed_at_ms??at)-task.started_at_ms),
  outcome:task.outcome,failure_stage:task.failure_stage});
 const runSnapshots=createRunSnapshotObserver();
 if(state.game==='run'&&state.token&&state.sessionId&&state.playerId&&state.appId)runSnapshots.authorize({token:state.token,sessionId:state.sessionId,playerId:state.playerId,appId:state.appId});
 result.run_snapshot_duplicates??=[];
 for(const key of ['js_errors','resource_errors','observer_errors','http_errors','network_errors'])result[key]??=[];
 result.network_observations??=[];result.fetch_observations??=[];result.lifecycle_cancellations??=[];result.pending_network_observations=0;
 result.unmatched_fetch_rejections??=[];
 result.pending_fetch_rejections??=[];result.network_binding_decisions??=[];result.page_error_observations??=[];
 result.early_binding_observations??=[];result.early_binding_attempt_limit_reached=false;
 state.creations??=[];state.actionRequests??=[];state.inputsRequests??=[];state.probabilityRequests??=[];
 result.creations=state.creations;result.action_requests=state.actionRequests;result.inputs_requests=state.inputsRequests;result.probability_requests=state.probabilityRequests;
 const phase=()=>state.phase||(state.returning?'returning':'entry');
 const address=request=>{
  const url=new URL(request.url()),frame=typeof request.frame==='function'?request.frame():null,frameUrl=frame?.url();
  const roomId=/^\/api\/pvp\/rooms\/([^/]+)$/.exec(url.pathname)?.[1];
  return{request,request_id:`network-${requestEntries.length+1}`,origin:url.origin,path:url.pathname,query:url.search,full_url:url.href,frame_object:frame,frame_url_raw:frameUrl,method:request.method(),type:request.resourceType(),phase:phase(),frame_url:frameUrl?clean(frameUrl):null,game_frame_request:frameUrl===origin+'/play/'+state.game,session_id:state.sessionId,player_id:state.playerId,owned_room_at_start:Boolean(url.origin===origin&&roomId&&state.ownedRooms?.has(roomId)),body_present:typeof request.postData==='function'?request.postData()!==null:null,redirected:Boolean(request.redirectedFrom?.()||request.redirectedTo?.()),response_seen:false};
 };
 const row=entry=>({path:clean(entry.path),method:entry.method,phase:entry.phase,frame_url:entry.frame_url,game_frame_request:entry.game_frame_request,session_id:entry.session_id?clean(entry.session_id):null,player_id:entry.player_id?clean(entry.player_id):null});
 const failure=(stage,error,entry={},task=null)=>result.observer_errors.push({stage,...row(entry),observed_phase:phase(),message:clean(message(error)),...(task?{response_work:workDetails(task,Date.now())}:{})});
 const refreshRequestTimings=()=>{
  // A tentative CDP clock from a previous ineligible attempt is not independent
  // Playwright evidence. Only a validated binding_identity survives this read.
  for(const entry of requestEntries){try{entry.network_started_at_ms=entry.request.timing?.().startTime;entry.redirected||=Boolean(entry.request.redirectedFrom?.()||entry.request.redirectedTo?.());}catch{entry.network_started_at_ms=null;}}
 };
 let earlyQueued=false,earlyClosed=false,earlyAttempts=0;
 const earlyTriggers=new Set(),maxEarlyAttempts=128,maxEarlyDetails=16;
 const scheduleEarlyBinding=trigger=>{
  if(earlyClosed||!fetchProbe?.bindNetwork||!fetchProbe?.classify||!failedEntries.some(({entry,observation})=>!entry.network_binding_identity&&!recordedFailures.has(observation.observation_id)))return;
  if(earlyAttempts>=maxEarlyAttempts||failedEntries.length>maxEarlyAttempts){result.early_binding_attempt_limit_reached=true;return;}
  earlyTriggers.add(trigger);if(earlyQueued)return;earlyQueued=true;
  queueMicrotask(()=>{
   earlyQueued=false;const triggers=[...earlyTriggers];earlyTriggers.clear();if(earlyClosed)return;
   if(failedEntries.length>maxEarlyAttempts){result.early_binding_attempt_limit_reached=true;return;}
   const record={attempt:++earlyAttempts,observed_at_ms:Date.now(),evidence_revision:fetchProbe.revision??null,triggers,decisions:[],decisions_omitted:0};
   try{
    refreshRequestTimings();fetchProbe.bindNetwork(requestEntries,failedEntries);
    for(const {entry,observation} of failedEntries){
     if(recordedFailures.has(observation.observation_id))continue;
     const previous=Boolean(entry.network_binding_identity),classification=fetchProbe.classify(entry,requestEntries);
     const anchor=entry.network_binding_anchor;
     const decision={observation_id:observation.observation_id,verdict:classification.eligible&&anchor?'anchored':'unresolved',classification_failure:classification.reason??(anchor?null:'NO_CDP_ANCHOR'),previous_anchor:previous,
      identity:entry.network_binding_identity?{...entry.network_binding_identity}:null,
      anchor:anchor?{document_id:anchor.document_id,event_seq:anchor.event_seq,at_ms:anchor.at_ms,protocol_count:anchor.protocol_keys.length}:null};
     if(record.decisions.length<maxEarlyDetails)record.decisions.push(decision);else record.decisions_omitted++;
    }
   }catch(error){record.failed=true;failure('early-binding',error);}
   result.early_binding_observations.push(record);
  });
 };
 const stopEarlyBinding=fetchProbe?.onChange?.(scheduleEarlyBinding);
 page.once('close',()=>{earlyClosed=true;earlyTriggers.clear();stopEarlyBinding?.();});
 if(fetchProbe?.observePageErrors)fetchProbe.observePageErrors(page,value=>{result.page_error_observations.push(value);result.js_errors.push(value.message);});
 else{
  page.on('pageerror',error=>result.js_errors.push(clean(message(error))));
  page.on('console',item=>{if(item.type()==='error')result.js_errors.push(clean(item.text()));});
 }
 page.on('request',request=>{let entry;try{
  entry=address(request);entry.request_observed=true;requests.set(request,entry);requestEntries.push(entry);
  scheduleEarlyBinding('request');
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
  if(/^\/api\/pvp\/rooms\/[^/]+\/inputs$/.test(entry.path)){
   const body=request.postDataJSON();
   entry.inputs={...row(entry),request_id:body?.request_id,commands:body?.commands,status:null,validated:false};state.inputsRequests.push(entry.inputs);
   assert.equal(state.game,'run','Only Run supports input batches');assert.ok(entry.game_frame_request,'Input batch is outside the game frame');
   entry.inputBaseline=runPracticeInputBaseline(state.room);assert.ok(entry.inputBaseline,'Input batch has no explicit negotiated practice before snapshot');
   assert.equal(entry.path,`/api/pvp/rooms/${entry.inputBaseline.roomId}/inputs`,'Input path differs from owned room');
   assert.equal(entry.inputBaseline.playerKey,state.playerId,'Input player differs from the original session');
   entry.inputBody=structuredClone(body);
  }
  if(new RegExp(`^/api/play/${state.game}/(spin|ack)$`).test(entry.path)){
   const body=request.postDataJSON();
   entry.probability={...row(entry),type:entry.path.endsWith('/spin')?'spin':'ack',request_id:body.requestId,round_id:body.roundId,status:null};state.probabilityRequests.push(entry.probability);
  }
 }catch(error){failure('request',error,entry);}});
 page.on('requestfinished',request=>{const entry=requests.get(request);if(entry?.creation)entry.creation.finished=true;scheduleEarlyBinding('requestfinished');});
 page.on('requestfailed',request=>{let entry;try{
  entry=requests.get(request)||address(request);const error=clean(request.failure()?.errorText||'NETWORK_ERROR');
  entry.failure_error=error;
  for(const intent of [entry.creation,entry.action,entry.inputs,entry.probability])if(intent)intent.transport_error=error;
  if(entry.creation)entry.creation.finished=true;
  if(entry.origin===origin&&apiPath(entry.path)||['fetch','xhr'].includes(entry.type)){
   const observation=Object.freeze({observation_id:entry.request_id,...row(entry),frame_id:fetchProbe?.frameId(entry.frame_object)??null,observed_at_ms:Date.now(),error});result.network_observations.push(observation);
   failedEntries.push({entry,observation});result.pending_network_observations++;
   scheduleEarlyBinding('requestfailed');
   if(!fetchProbe){result.network_errors.push({...observation});recordedFailures.add(observation.observation_id);result.pending_network_observations--;}
  }
  else if(assets.has(entry.type))result.resource_errors.push({...row(entry),error});
 }catch(error){failure('requestfailed',error,entry);}});
 page.on('response',response=>{
  let entry;
  const task={work_id:++workSequence,request_id:null,kind:'other',stage:'response-headers',started_at_ms:Date.now(),
   body_started_at_ms:null,body_completed_at_ms:null,completed_at_ms:null,outcome:null,failure_stage:null};
  tasks.set(task.work_id,task);
  const readBody=()=>{task.stage='body-read';task.body_started_at_ms=Date.now();return response.json().then(body=>{
   task.body_completed_at_ms=Date.now();task.stage='snapshot-queue';return body;
  });};
  const work=(async()=>{
   const request=response.request();entry=requests.get(request)||address(request);entry.response_seen=true;scheduleEarlyBinding('response');
   const status=response.status(),path=entry.path;
   task.request_id=entry.request_id;
   task.kind=path.startsWith('/api/pvp/rooms')?'room':(['/api/demo/config','/api/demo/launch','/v1/launch/exchange'].includes(path)?'launch':path===`/api/play/${state.game}/spin`?'spin':path===`/api/play/${state.game}/ack`?'ack':'other');
   for(const intent of [entry.creation,entry.action,entry.inputs,entry.probability])if(intent)intent.status=status;
   if(assets.has(entry.type)&&status>=400)result.resource_errors.push({...row(entry),status});
   if(entry.origin===origin&&apiPath(path)?!response.ok():['fetch','xhr'].includes(entry.type)&&status>=400)result.http_errors.push({...row(entry),status});
   if(entry.origin!==origin)return;
   if(!response.ok())return;
   if(['/api/demo/config','/api/demo/launch','/v1/launch/exchange'].includes(path)){
    const decoded=readBody().then(body=>{task.stage='consume';remember(body);
     if(path==='/v1/launch/exchange'){
      assert.equal(body.game_id,state.game,'Exchange game differs');
      assert.ok(body.session_id&&body.external_user_id&&body.access_token,'Incomplete launch exchange');
      if(state.sessionId)assert.equal(body.session_id,state.sessionId,'Reauthorization replaced the original session');
      if(state.playerId)assert.equal(body.external_user_id,state.playerId,'Reauthorization replaced the original player');
      if(state.game==='run')runSnapshots.authorize({token:body.access_token,sessionId:body.session_id,playerId:body.external_user_id,appId:body.scope?.app_id},entry.runSnapshotTicket);
      state.token=body.access_token;state.sessionId=body.session_id;state.playerId=body.external_user_id;result.launch_exchange=true;
     }
     task.stage='snapshot-queue';return body;
    });
    await runSnapshots.enqueue(decoded,()=>{task.stage='consume';});
   }
   if(path.startsWith('/api/pvp/rooms')){
    await runSnapshots.enqueue(readBody(),body=>{task.stage='consume';const room=body.room||body;
     if(!room.id&&(Object.hasOwn(room,'run_game_transfer')||entry.method==='GET'&&/^\/api\/pvp\/rooms\/[^/]+$/.test(path)))runSnapshots.inspect(entry.runSnapshotTicket,room);
     if(entry.inputs){const proof=verifyRunPracticeInputAction(entry.inputBaseline,entry.inputBody,room);entry.inputs.proof=proof;entry.inputs.validated=true;}
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
    const body=await readBody();task.stage='consume';
    assert.equal(body.session?.sessionId,state.sessionId,'Spin session differs');assert.ok(body.round?.id&&body.round.cycleId,'Spin response lacks a round/cycle identity');
    state.spins.push({id:body.round.id,cycleId:body.round.cycleId,status:body.round.settlementStatus,isFreeSpin:body.round.isFreeSpin===true,httpStatus:status});
   }
   if(path===`/api/play/${state.game}/ack`){
    const body=await readBody();task.stage='consume';
    assert.equal(body.session?.sessionId,state.sessionId,'ACK session differs');assert.equal(body.session.pendingRound,null);
    state.acks.add(request.postDataJSON().roundId);
   }
  })().catch(error=>{task.outcome='failed';task.failure_stage=task.stage;failure('response',error,entry,task);});
  // No body-loss exception is suppressed, including after return or teardown.
  void work.finally(()=>{task.completed_at_ms=Date.now();task.outcome??='complete';task.stage=task.outcome==='failed'?'failed':'complete';tasks.delete(task.work_id);});
 });
 return async({final=true}={})=>{
  assert.equal(typeof final,'boolean','final must be boolean');const drainId=++drainSequence;
  // An active page can keep polling forever. Only the work observed at this
  // call belongs to an intermediate drain; the final drain still requires the
  // whole live set to empty after the caller has stopped the UI.
  const startedAt=Date.now(),fence=workSequence,deadline=startedAt+drainTimeoutMs;
  const initialCount=tasks.size,initialDetails=[];
  for(const task of tasks.values()){if(initialDetails.length===maxWorkDetails)break;initialDetails.push(task);}
  const observation={drain_id:drainId,final,fence_work_id:fence,started_at_ms:startedAt,initial_work_count:initialCount};
  let stage='response-work-before-flush',completed=false;
  const hasAwaitedWork=()=>{if(final)return tasks.size>0;for(const id of tasks.keys())if(id<=fence)return true;return false;};
  const waitForWork=async()=>{while(hasAwaitedWork()){
   assert.ok(Date.now()<deadline,'Response observer drain timed out');
   await new Promise(resolve=>setTimeout(resolve,5));
  }};
  try{
  await waitForWork();
  if(fetchProbe){
   stage='fetch-probe-flush';
   let timer;
   try{await Promise.race([fetchProbe.flush?.(page),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Fetch observer drain timed out')),Math.max(1,deadline-Date.now()));})]);}catch(error){failure('fetch-probe-drain',error);throw error;}finally{clearTimeout(timer);}
   stage='response-work-after-flush';await waitForWork();stage='network-proof';
   refreshRequestTimings();
   fetchProbe.bindNetwork?.(requestEntries,failedEntries);
   result.fetch_probe_installation_observations=structuredClone(fetchProbe.installationObservations??[]);
   result.network_protocol_observations=fetchProbe.networkObservations?.()||[];
   const previousClassifications=new Map(result.lifecycle_cancellations.map(value=>[value.observation_id,value]));
   result.fetch_observations=fetchProbe.observations();result.lifecycle_cancellations=[];
   const pending=[];
   for(const {entry,observation} of failedEntries){
    const classification=fetchProbe.classify(entry,requestEntries);
    // A later live poll can still have a zero Playwright clock at an active
    // fence. Preserve that uncertainty, rather than permanently failing an
    // earlier proven abort. Final drain still requires the full unique proof.
    const deferred=!final&&!recordedFailures.has(observation.observation_id)&&
     (classification.reason==='UNKNOWN_COMPETING_NETWORK_REQUEST'||entry.network_binding_incomplete&&['AMBIGUOUS_CDP_NETWORK_FAILURE','MISSING_CDP_NETWORK_PROOF'].includes(classification.reason));
    assert.ok(result.network_binding_decisions.length<20000,'Network binding decision limit exceeded');
    result.network_binding_decisions.push({drain_id:drainId,final,observation_id:observation.observation_id,verdict:recordedFailures.has(observation.observation_id)?'failure-retained':deferred?'pending':classification.eligible?'lifecycle':'failure',classification_failure:classification.reason??null,binding:structuredClone(entry.network_binding_observation??null),binding_anchor:structuredClone(entry.network_binding_anchor??null)});
    if(deferred)pending.push(entry);
    else if(classification.eligible&&!recordedFailures.has(observation.observation_id))result.lifecycle_cancellations.push({...observation,...classification.proof});
    else if(!recordedFailures.has(observation.observation_id)){result.network_errors.push({...observation,classification_failure:classification.reason,...(previousClassifications.has(observation.observation_id)?{previous_lifecycle_classification:previousClassifications.get(observation.observation_id)}:{})});recordedFailures.add(observation.observation_id);}
   }
   for(const error of fetchProbe.errors)if(!recordedProbeErrors.has(error)){failure('fetch-probe',error);recordedProbeErrors.add(error);}
   result.pending_fetch_rejections=[];
   for(const rejection of fetchProbe.unmatchedRejections?.(failedEntries)||[]){
    const id=`${rejection.document_id}:${rejection.fetch_attempt_id}:${rejection.rejected_event_seq}`;
    if(!final&&!recordedUnmatchedRejections.has(id)&&fetchProbe.rejectionPending?.(rejection,pending)){result.pending_fetch_rejections.push(rejection);continue;}
    if(!recordedUnmatchedRejections.has(id)){result.unmatched_fetch_rejections.push(rejection);failure('unmatched-fetch-rejection',`${rejection.error.name}: ${rejection.error.message}`);recordedUnmatchedRejections.add(id);}
   }
   result.pending_network_observations=pending.length;
  }
  completed=true;
  }finally{
   const endedAt=Date.now(),pending=[],later=[];let pendingCount=0,laterCount=0;
   for(const task of tasks.values()){
    const awaited=final||task.work_id<=fence,details=awaited?pending:later;
    if(awaited)pendingCount++;else laterCount++;
    if(details.length<maxWorkDetails)details.push(workDetails(task,endedAt));
   }
   Object.assign(observation,{ended_at_ms:endedAt,elapsed_ms:Math.max(0,endedAt-startedAt),completed,
    failure_stage:completed?null:stage,observed_through_work_id:workSequence,
    initial_work:initialDetails.map(task=>workDetails(task,endedAt)),initial_work_details_omitted:Math.max(0,initialCount-initialDetails.length),
    pending_work_count:pendingCount,pending_work:pending,pending_work_details_omitted:pendingCount-pending.length,
    later_pending_work_count:laterCount,later_pending_work:later,later_pending_work_details_omitted:laterCount-later.length});
   if(result.observer_drain_observations.length===maxDrainRecords){result.observer_drain_observations.shift();result.observer_drain_observations_dropped++;}
   result.observer_drain_observations.push(observation);
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
