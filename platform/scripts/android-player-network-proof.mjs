/** Independent browser request-shaping proof. Private raw events may contain
 * cookies. No ADB, HTTP request, synthetic input, physical RTT claim or gate change.
 * The caller owns every supplied CDP session and its Network domain exclusively.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {VISIBLE_FEEDBACK_PROTOCOL_SHA256} from './android-player-visible-feedback.mjs';

const sha=raw=>createHash('sha256').update(raw).digest('hex'),clone=value=>structuredClone(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
export const NETWORK_PROOF_PROFILES=Object.freeze({
 wifi:Object.freeze({downloadThroughput:2500000,uploadThroughput:625000,latency:50}),
 weak:Object.freeze({downloadThroughput:500000,uploadThroughput:125000,latency:150}),
});

export function networkProtocolReceipt(raw){
 assert.ok(Buffer.isBuffer(raw),'NETWORK_ORIGINAL_PROTOCOL_REQUIRED');assert.equal(sha(raw),VISIBLE_FEEDBACK_PROTOCOL_SHA256,'NETWORK_PROTOCOL_SHA_CHANGED');
 const value=JSON.parse(raw),network=value.domains.find(d=>d.domain==='Network');
 const command=network.commands.find(c=>c.name==='emulateNetworkConditionsByRule'),type=network.types.find(t=>t.id==='NetworkConditions'),extra=network.events.find(e=>e.name==='requestWillBeSentExtraInfo');
 assert.equal(command.experimental,true);assert.equal(command.parameters.find(p=>p.name==='matchedNetworkConditions').items.$ref,'NetworkConditions');
 assert.equal(command.returns.find(p=>p.name==='ruleIds').items.type,'string');assert.equal(extra.parameters.find(p=>p.name==='appliedNetworkConditionsId').type,'string');
 assert.match(type.properties.find(p=>p.name==='latency').description,/request sent to response headers/);
 for(const name of ['downloadThroughput','uploadThroughput'])assert.match(type.properties.find(p=>p.name===name).description,/bytes\/sec/);
 return {schema:'android-network-official-protocol-v1',sha256:sha(raw),bytes:raw.length,version:value.version,
  latencySemantics:'minimum-request-to-response-headers-delay-ms',throughputUnit:'bytes-per-second',physicalRtt:false};
}

function assertScope(scope){
 assert.equal(scope?.serial,'46dcfd25','NETWORK_PHYSICAL_DEVICE_REQUIRED');assert.equal(scope.androidUserId,0,'NETWORK_CURRENT_USER_REQUIRED');assert.equal(scope.uid,10416,'NETWORK_QA_UID_REQUIRED');
 assert.equal(scope.packageName,'com.tianyahuyu.oasis.player.qa','NETWORK_QA_PACKAGE_REQUIRED');assert.ok(Number.isSafeInteger(scope.pid)&&scope.pid>0,'NETWORK_PROCESS_REQUIRED');
 assert.match(scope.startTicks??'',/^[0-9]+$/,'NETWORK_PROCESS_IDENTITY_REQUIRED');assert.ok(typeof scope.nonce==='string'&&scope.nonce.length>=16,'NETWORK_NONCE_REQUIRED');
 assert.ok(typeof scope.targetId==='string'&&scope.targetId.length>0,'NETWORK_TARGET_REQUIRED');assert.ok(['page','iframe','worker','service_worker','shared_worker'].includes(scope.targetType),'NETWORK_TARGET_TYPE_UNSUPPORTED');
 const origin=new URL(scope.origin);assert.equal(origin.protocol,'https:','NETWORK_TLS_ORIGIN_REQUIRED');assert.equal(origin.origin,scope.origin,'NETWORK_EXACT_ORIGIN_REQUIRED');
 assert.match(scope.providerVersion??'',/^150\.[0-9]+\.[0-9]+\.[0-9]+$/,'NETWORK_PROVIDER_150_REQUIRED');
}

export function networkConditionParameters(scope,profile='wifi'){
 assertScope(scope);assert.ok(Object.hasOwn(NETWORK_PROOF_PROFILES,profile),'NETWORK_PROFILE_REQUIRED');
 return {matchedNetworkConditions:[{urlPattern:'',offline:false,...NETWORK_PROOF_PROFILES[profile]}]};
}

/** No fabricated transfer is generated. Install before the caller's actual
 * requests; record all protocol events without changing existing fetch/DOM.
 * The callback must return the same original device/process/target identity.
 */
export async function collectNetworkRuleProof({session,scope,profile='wifi',protocolBytes,readTargetIdentity,
 exclusiveNetworkDomain=false,clock=()=>({epochMs:Date.now(),monotonicMs:performance.now()}),maxEvents=100000,maxCommandMs=5000}){
 assertScope(scope);assert.equal(exclusiveNetworkDomain,true,'NETWORK_EXCLUSIVE_SESSION_REQUIRED');assert.equal(typeof readTargetIdentity,'function','NETWORK_REAL_TARGET_READER_REQUIRED');
 assert.ok(typeof session?.send==='function'&&typeof session.on==='function'&&typeof session.off==='function','NETWORK_ACTUAL_SESSION_REQUIRED');
 assert.ok(Number.isSafeInteger(maxEvents)&&maxEvents>0&&maxEvents<=100000,'NETWORK_RECORD_BOUND');
 assert.ok(Number.isSafeInteger(maxCommandMs)&&maxCommandMs>0&&maxCommandMs<=5000,'NETWORK_COMMAND_TIME_BOUND');
 const bounded=async work=>{let timer;try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('NETWORK_COMMAND_TIMEOUT')),maxCommandMs);})]);}finally{clearTimeout(timer);}};
 const capture={schema:'android-network-rule-capture-v1',scope:clone(scope),profile,protocol:networkProtocolReceipt(protocolBytes),parameters:networkConditionParameters(scope,profile),
  before:clone(await bounded(readTargetIdentity)),events:[],commands:[],errors:[],overflow:0,eventBytes:0,started:false,closed:false,physicalRtt:false,networkCalibrated:false};
 assert.deepEqual(capture.before,scope,'NETWORK_INITIAL_TARGET_CHANGED');
 const listeners=[],on=(event,fn)=>{session.on(event,fn);listeners.push({event,fn});};
 const send=async(method,parameters)=>{const row={method,parameters:clone(parameters),started:clock()};capture.commands.push(row);try{row.response=clone(await bounded(()=>session.send(method,parameters)));row.finished=clock();return row.response;}catch(error){row.error=error.message;row.finished=clock();capture.errors.push({code:method,error:error.message});throw error;}};
 for(const event of ['Network.requestWillBeSent','Network.requestWillBeSentExtraInfo','Network.responseReceived','Network.loadingFinished','Network.loadingFailed','Network.requestServedFromCache','Target.attachedToTarget','Inspector.detached'])on(event,value=>{
  const bytes=Buffer.byteLength(JSON.stringify(value));if(capture.events.length>=maxEvents||capture.eventBytes+bytes>128*1024*1024){capture.overflow++;return;}
  capture.eventBytes+=bytes;capture.events.push({event,value:clone(value),received:clock()});
 });
 let closing;
 const close=()=>closing??=(async()=>{
  try{await send('Network.emulateNetworkConditionsByRule',{matchedNetworkConditions:[]});}catch{}
  try{capture.after=clone(await bounded(readTargetIdentity));assert.deepEqual(capture.after,scope,'NETWORK_FINAL_TARGET_CHANGED');}catch(error){capture.errors.push({code:'FINAL_SCOPE',error:error.message});}
  for(const {event,fn}of listeners)session.off(event,fn);capture.closed=true;return capture;
 })();
 try{
  await send('Network.enable',{});const version=await send('Browser.getVersion',{});
  assert.ok(typeof version.product==='string'&&version.product.endsWith('/'+scope.providerVersion),'NETWORK_OBSERVED_PROVIDER_CHANGED');capture.browserVersion=version;
  const response=await send('Network.emulateNetworkConditionsByRule',capture.parameters);
  assert.ok(Array.isArray(response.ruleIds)&&response.ruleIds.length===1&&typeof response.ruleIds[0]==='string'&&response.ruleIds[0].length>0,'NETWORK_ACTUAL_RULE_ID_REQUIRED');
  capture.ruleId=response.ruleIds[0];capture.started=true;
 }catch(error){capture.errors.push({code:'INSTALL',error:error.message});await close();throw Object.assign(error,{capture});}
 return {capture,close};
}

/** A target inventory is not evidence of requests in unobserved workers. The
 * caller supplies all owned actual request IDs and complete inventories before
 * and after; each request must have its original unique rule ExtraInfo event.
 * Even a proven shaping result cannot calibrate a physical 50ms RTT link.
 */
export function analyzeNetworkRuleProof({captures,inventoryBefore,inventoryAfter,ownedRequests}){
 const result={schema:'android-network-rule-proof-v1',status:'insufficient',requestShapingProven:false,networkCalibrated:false,physicalRtt:false,
  requestCount:0,reasons:[],limitations:['CDP latency is a minimum request-to-response-headers delay, not measured physical RTT',
   '20/5 Mbps are browser throttle ceilings; effective throughput needs separate original upload/download measurements',
   'Every page, worker, service worker and OOPIF carrying owned traffic needs its own observed rule',
   'The unchanged mobile-quality gate still requires its controlled real network and hardware conditions']};
 try{
  assert.ok(Array.isArray(captures)&&captures.length>0,'NETWORK_TARGET_CAPTURE_REQUIRED');assert.deepEqual(inventoryBefore,inventoryAfter,'NETWORK_TARGET_INVENTORY_CHANGED');
  assert.ok(Array.isArray(inventoryBefore)&&inventoryBefore.length===captures.length&&new Set(inventoryBefore.map(t=>t.targetId)).size===inventoryBefore.length,'NETWORK_COMPLETE_TARGET_INVENTORY_REQUIRED');
  assert.ok(Array.isArray(ownedRequests)&&ownedRequests.length>0,'NETWORK_ACTUAL_REQUESTS_REQUIRED');
  const targets=new Map(),requestKeys=new Set();let common;
  for(const capture of captures){assertScope(capture.scope);assert.equal(capture.schema,'android-network-rule-capture-v1');assert.equal(capture.closed,true);assert.equal(capture.started,true);assert.equal(capture.overflow,0,'NETWORK_EVENTS_LOST');assert.deepEqual(capture.errors,[],'NETWORK_CAPTURE_ERROR');
   assert.deepEqual(capture.before,capture.scope);assert.deepEqual(capture.after,capture.scope);assert.deepEqual(capture.parameters,networkConditionParameters(capture.scope,capture.profile));
   assert.equal(capture.protocol.sha256,VISIBLE_FEEDBACK_PROTOCOL_SHA256);assert.equal(capture.protocol.physicalRtt,false);
   const identity={...capture.scope};delete identity.targetId;delete identity.targetType;if(common)assert.deepEqual({identity,profile:capture.profile},common,'NETWORK_TARGETS_DIFFERENT_RUN');else common={identity,profile:capture.profile};
   assert.equal(capture.browserVersion?.product?.split('/').at(-1),capture.scope.providerVersion,'NETWORK_ACTUAL_PROVIDER_UNPROVEN');
   assert.ok(!targets.has(capture.scope.targetId),'NETWORK_DUPLICATE_TARGET');assert.deepEqual(inventoryBefore.find(t=>t.targetId===capture.scope.targetId),capture.scope,'NETWORK_INVENTORY_SCOPE_CHANGED');
   assert.deepEqual(capture.commands.map(c=>c.method),['Network.enable','Browser.getVersion','Network.emulateNetworkConditionsByRule','Network.emulateNetworkConditionsByRule'],'NETWORK_COMMAND_SEQUENCE_CHANGED');
   assert.ok(capture.commands.every((c,index)=>!c.error&&finite(c.started?.epochMs)&&finite(c.started?.monotonicMs)&&finite(c.finished?.epochMs)&&finite(c.finished?.monotonicMs)&&c.finished.monotonicMs>=c.started.monotonicMs&&(!index||c.started.monotonicMs>=capture.commands[index-1].finished.monotonicMs)),'NETWORK_COMMAND_CLOCK_REQUIRED');
   assert.deepEqual(capture.commands[1].response,capture.browserVersion,'NETWORK_ACTUAL_PROVIDER_RECEIPT_CHANGED');
   const installs=capture.commands.filter(c=>c.method==='Network.emulateNetworkConditionsByRule'&&c.parameters.matchedNetworkConditions?.length);
   assert.equal(installs.length,1);assert.deepEqual(installs[0].parameters,capture.parameters);assert.deepEqual(installs[0].response.ruleIds,[capture.ruleId]);
   const resets=capture.commands.filter(c=>c.method==='Network.emulateNetworkConditionsByRule'&&c.parameters.matchedNetworkConditions?.length===0);assert.equal(resets.length,1,'NETWORK_RULE_NOT_CLEARED');assert.ok(!resets[0].error);
   assert.ok(capture.events.every(e=>finite(e.received?.epochMs)&&finite(e.received?.monotonicMs)),'NETWORK_EVENT_CLOCK_REQUIRED');
   assert.ok(!capture.events.some(e=>e.event==='Inspector.detached'||e.event==='Target.attachedToTarget'),'NETWORK_UNOBSERVED_TARGET_OR_DETACH');targets.set(capture.scope.targetId,capture);
  }
  for(const request of ownedRequests){const key=request.targetId+':'+request.requestId;assert.ok(!requestKeys.has(key),'NETWORK_DUPLICATE_OWNED_REQUEST');requestKeys.add(key);
   const capture=targets.get(request.targetId);assert.ok(capture,'NETWORK_UNOBSERVED_REQUEST_TARGET');
   const rows=capture.events.filter(e=>e.value?.requestId===request.requestId),sent=rows.filter(e=>e.event==='Network.requestWillBeSent'),extra=rows.filter(e=>e.event==='Network.requestWillBeSentExtraInfo'),responses=rows.filter(e=>e.event==='Network.responseReceived'),finished=rows.filter(e=>e.event==='Network.loadingFinished');
   assert.equal(sent.length,1,'NETWORK_REDIRECT_OR_MISSING_REQUEST');assert.equal(extra.length,1,'NETWORK_UNIQUE_RULE_EVENT_REQUIRED');assert.equal(extra[0].value.appliedNetworkConditionsId,capture.ruleId,'NETWORK_REQUEST_RULE_UNPROVEN');
   assert.equal(sent[0].value.request.url,request.url);assert.equal(new URL(request.url).origin,capture.scope.origin,'NETWORK_FOREIGN_REQUEST');assert.equal(sent[0].value.redirectResponse,undefined,'NETWORK_REDIRECT_REFUSED');
   assert.equal(responses.length,1);assert.equal(finished.length,1);assert.ok(!rows.some(e=>['Network.loadingFailed','Network.requestServedFromCache'].includes(e.event)),'NETWORK_FAILED_OR_CACHED_REQUEST');
   const response=responses[0].value.response;assert.ok(response.status>=200&&response.status<300&&!response.fromDiskCache&&!response.fromServiceWorker&&!response.fromPrefetchCache,'NETWORK_ORIGINAL_NETWORK_RESPONSE_REQUIRED');
   assert.ok(sent[0].received.monotonicMs>=installsFor(capture).finished.monotonicMs&&finished[0].received.monotonicMs<resetsFor(capture).started.monotonicMs,'NETWORK_REQUEST_OUTSIDE_RULE_INTERVAL');result.requestCount++;
  }
  result.status='request-shaping-proven';result.requestShapingProven=true;
 }catch(error){result.reasons.push(error.message);}
 return result;
}
const installsFor=c=>c.commands.find(row=>row.method==='Network.emulateNetworkConditionsByRule'&&row.parameters.matchedNetworkConditions?.length);
const resetsFor=c=>c.commands.find(row=>row.method==='Network.emulateNetworkConditionsByRule'&&row.parameters.matchedNetworkConditions?.length===0);
