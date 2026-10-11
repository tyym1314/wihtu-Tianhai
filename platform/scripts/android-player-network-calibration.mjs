/** Root-invoked QA adapter. Importing this module does not connect a device or
 * send a request. Root supplies its already connected Playwright WebView
 * Context/Page, original installation readbacks and a private EXCL/0600 sink.
 * No ADB, proxy settings, reverse, login, room, wallet or CDP emulation command
 * is owned here. All requests are separate calibration, outside frame sampling.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {calibrationPlan,QA_NETWORK_ORIGIN,QA_PREVIEW,QA_CALIBRATION_SOURCE,
 shaperClock,shaperConfigurationSha256,collectQaNetworkCalibration} from './android-player-network-shaper.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const copy=value=>structuredClone(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
export const QA_CALIBRATION_APK=Object.freeze({metadataSha256:'732c61f129fc5a9256398dcb8a2008c6824dc75c0ef728db5507b8d84b9ddaad',
 apkSha256:'18575df7fda675f721850313df73ce405c3492e236bd2dd01cdcc4d755b99f01',
 certificateSha256:'21aab9acdf64b9f9235f45fae45adbe746945f6f11ed6044e5626f7e87280c5e',apkBytes:20883});
export const QA_CALIBRATION_PROTOCOL_SHA256='b6d7d248f75d7b4103723a57cb966d7d3b70d3e56dc78e9a6952d7058aed31b1';
const scopeKeys=['serial','androidUserId','uid','packageName','origin','pid','startTicks','documentId','timeOrigin','nonce','providerVersion','targetId'];

export function validateQaCalibrationScope(scope){
 assert.ok(exact(scope,scopeKeys),'CALIBRATION_SCOPE_FIELDS_CHANGED');
 assert.equal(scope.serial,'46dcfd25');assert.equal(scope.androidUserId,0);assert.equal(scope.uid,10416);
 assert.equal(scope.packageName,'com.tianyahuyu.oasis.player.qa');assert.equal(scope.origin,QA_NETWORK_ORIGIN);
 assert.ok(Number.isSafeInteger(scope.pid)&&scope.pid>0);assert.match(scope.startTicks,/^[0-9]+$/);
 for(const field of ['documentId','nonce'])assert.match(scope[field],/^[a-f0-9]{32}$/);
 assert.ok(finite(scope.timeOrigin)&&scope.timeOrigin>0);assert.match(scope.providerVersion,/^150\.[0-9]+\.[0-9]+\.[0-9]+$/);
 assert.ok(typeof scope.targetId==='string'&&scope.targetId.length>0);return copy(scope);
}

export function validateQaCalibrationInstallation(readback,scope){
 assert.ok(exact(readback,['schema','scope','apk','tlsErrorsIgnored','originalEvidenceSha256']),'CALIBRATION_INSTALLATION_FIELDS_CHANGED');
 assert.equal(readback.schema,'android-qa-calibration-installation-v1');assert.deepEqual(readback.scope,scope);
 assert.deepEqual(readback.apk,QA_CALIBRATION_APK,'CALIBRATION_INSTALLED_APK_OR_CERT_CHANGED');
 assert.equal(readback.tlsErrorsIgnored,false,'CALIBRATION_TLS_OVERRIDE_REFUSED');
 assert.ok(digest(readback.originalEvidenceSha256),'CALIBRATION_ORIGINAL_INSTALLATION_READBACK_REQUIRED');return copy(readback);
}

/** Call in the SAME Mac process as the shaper. This atomic metadata snapshot
 * retains all current-era target candidates and original counters, not opaque
 * ciphertext or application secrets. The final original ledger still supplies
 * drained write rows to the independent analyzer. No HTTP/2-stream join occurs.
 */
export function qaCalibrationProxySnapshot(shaper){
 const l=shaper.ledger,e=l.configurations.at(-1),clock=shaperClock();
 const targetConnections=l.connections.filter(c=>c.target&&c.era===e.era);
 assert.ok(targetConnections.length<=256,'CALIBRATION_PROXY_CANDIDATE_BOUND');
 return copy({schema:'android-qa-proxy-snapshot-v1',clockDomain:l.clockDomain,clock,process:l.process,
  listenHost:l.listenHost,listenPort:l.listenPort,configuration:e,targetConnections,rowCount:l.rows.length,
  totalEntries:['rows','connections','errors','configurations'].reduce((n,k)=>n+l[k].length,0),
  maxLedgerEntries:l.maxLedgerEntries,overflow:l.overflow,dropped:l.dropped,errors:l.errors});
}

function validateSnapshot(s,phase){
 assert.equal(s?.schema,'android-qa-proxy-snapshot-v1');assert.equal(s.clockDomain,'Mac-host-hrtime-ms');
 assert.ok(finite(s.clock?.monotonicMs)&&finite(s.clock?.epochMs));assert.equal(s.listenHost,'127.0.0.1');
 assert.ok(Number.isSafeInteger(s.listenPort)&&s.listenPort>0&&s.listenPort<=65535);
 assert.ok(Number.isSafeInteger(s.process?.pid)&&s.process.pid>0);assert.equal(s.overflow,false);assert.equal(s.dropped,0);assert.deepEqual(s.errors,[]);
 assert.ok(Number.isSafeInteger(s.totalEntries)&&s.totalEntries<=s.maxLedgerEntries);
 assert.equal(s.configuration.configuration.profile,phase);assert.equal(s.configuration.finished,undefined,'CALIBRATION_PROXY_ERA_CLOSED');
 assert.equal(s.configuration.sha256,shaperConfigurationSha256(s.configuration.configuration));
 assert.ok(Array.isArray(s.targetConnections)&&s.targetConnections.length<=256);
 for(const c of s.targetConnections){assert.equal(c.target,true);assert.equal(c.era,s.configuration.era);
  assert.equal(c.host,new URL(QA_NETWORK_ORIGIN).hostname);assert.equal(c.port,443);
  for(const d of ['uploadBytes','downloadBytes'])assert.ok(Number.isSafeInteger(c[d])&&c[d]>=0);}
}

function lowerHeaders(headers){return Object.fromEntries(Object.entries(headers??{}).map(([name,value])=>[name.toLowerCase(),String(value)]));}
function decodeBody(value){
 assert.ok(value&&typeof value.body==='string'&&typeof value.base64Encoded==='boolean','CALIBRATION_CDP_BODY_INVALID');
 if(!value.base64Encoded)return Buffer.from(value.body);
 const bytes=Buffer.from(value.body,'base64');assert.equal(bytes.toString('base64'),value.body,'CALIBRATION_BASE64_BODY_INVALID');return bytes;
}

// Serialized into the original default WebView realm. These small properties
// only own our AbortControllers; application state and input are untouched.
export function installQaCalibrationDocument({key,scope}){
 if(location.origin!==scope.origin||performance.timeOrigin!==scope.timeOrigin||globalThis[key])throw Error('CALIBRATION_DOCUMENT_CHANGED');
 Object.defineProperty(globalThis,key,{configurable:true,value:{owner:Object.freeze({...scope}),controllers:new Map()}});
 return {owner:globalThis[key].owner,url:location.href,at:performance.now(),epochMs:Date.now()};
}
export async function fetchQaCalibrationDocument({key,scope,url,method,body,operationId,timeoutMs}){
 const p=globalThis[key];
 const check=()=>{if(!p||p.owner.documentId!==scope.documentId||p.owner.nonce!==scope.nonce||p.owner.timeOrigin!==performance.timeOrigin||location.origin!==scope.origin)throw Error('CALIBRATION_DOCUMENT_CHANGED');};
 check();if(p.controllers.size)throw Error('CALIBRATION_CONCURRENT_REQUEST_REFUSED');
 const controller=new AbortController();p.controllers.set(operationId,controller);const timer=setTimeout(()=>controller.abort(),timeoutMs);
 const started=performance.now(),startedEpoch=Date.now();let headerAt;
 try{
  const response=await fetch(url,{method,body:method==='POST'?body:undefined,credentials:'omit',mode:'same-origin',cache:'no-store',redirect:'error',
   headers:method==='POST'?{'Content-Type':'application/json'}:undefined,signal:controller.signal});
  headerAt=performance.now();const buffer=await response.arrayBuffer(),finished=performance.now(),finishedEpoch=Date.now();check();
  const bytes=new Uint8Array(buffer);if(bytes.length>3144937+65536)throw Error('CALIBRATION_BODY_BOUND');
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',buffer));let binary='';
  for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return {owner:p.owner,url:response.url,status:response.status,redirected:response.redirected,responseType:response.type,
   started,headerAt,finished,startedEpoch,finishedEpoch,responseBodyBase64:btoa(binary),responseBodyBytes:bytes.length,
   responseBodySha256:Array.from(digest,x=>x.toString(16).padStart(2,'0')).join('')};
 }finally{clearTimeout(timer);p.controllers.delete(operationId);}
}
export function abortQaCalibrationDocument({key,scope,operationId,remove=false}){
 const p=globalThis[key];if(!p)return {ownerMissing:true,cancelRequested:false,removed:false};
 if(p.owner.documentId!==scope.documentId||p.owner.nonce!==scope.nonce||performance.timeOrigin!==scope.timeOrigin)throw Error('CALIBRATION_DOCUMENT_CHANGED');
 const controller=p.controllers.get(operationId);controller?.abort();
 if(remove){for(const c of p.controllers.values())c.abort();delete globalThis[key];}
 return {ownerMissing:false,cancelRequested:!!controller,removed:remove};
}

/** Browser body hash is actual consumption in the same realm and same unique
 * request. An unreadable/empty CDP body is retained diagnostically. Any nonempty
 * CDP hash disagreement remains fatal; a second HTTP GET is never substituted.
 */
export function validateQaCalibrationRequestEvidence(raw,{scope,options}){
 const {pageResult,requests,requestExtra,responseExtra,responses,finished,failed,servedFromCache}=raw;
 assert.deepEqual(pageResult?.owner,scope,'CALIBRATION_FETCH_OWNER_CHANGED');assert.equal(pageResult.url,options.url);assert.equal(pageResult.redirected,false);
 assert.equal(pageResult.responseType,'basic');assert.ok(finite(pageResult.started)&&finite(pageResult.headerAt)&&finite(pageResult.finished)
  &&pageResult.started<=pageResult.headerAt&&pageResult.headerAt<=pageResult.finished&&pageResult.finished>pageResult.started);
 assert.equal(requests.length,1,'CALIBRATION_REQUEST_NOT_UNIQUE');const request=requests[0].event;
 assert.ok(finite(raw.commandSent?.monotonicMs)&&finite(raw.commandReturned?.monotonicMs)&&finite(requests[0].received?.monotonicMs)
  &&raw.commandSent.monotonicMs<=requests[0].received.monotonicMs&&requests[0].received.monotonicMs<=raw.commandReturned.monotonicMs,'CALIBRATION_REQUEST_CAPTURE_NOT_FRESH');
 assert.equal(request.frameId,raw.frameId,'CALIBRATION_REQUEST_FOREIGN_FRAME');assert.equal(request.request.url,options.url);assert.equal(request.request.method,options.method);
 assert.equal(request.redirectResponse,undefined,'CALIBRATION_REDIRECT_REFUSED');assert.equal(request.initiator.type,'script');
 assert.equal(requestExtra.length,1,'CALIBRATION_REQUEST_EXTRA_INFO_REQUIRED');assert.equal(responseExtra.length,1,'CALIBRATION_RESPONSE_EXTRA_INFO_REQUIRED');
 assert.equal(responses.length,1);assert.equal(finished.length,1);assert.deepEqual(failed,[]);assert.deepEqual(servedFromCache,[]);
 const id=request.requestId;for(const value of [...requestExtra,...responseExtra,...responses,...finished])assert.equal(value.event.requestId,id);
 assert.equal(requestExtra[0].event.appliedNetworkConditionsId,undefined,'CALIBRATION_OTHER_CDP_NETWORK_RULE_ACTIVE');
 const requestHeaders=lowerHeaders(requestExtra[0].event.headers);
 for(const key of ['authorization','cookie','content-encoding'])assert.equal(requestHeaders[key],undefined,'CALIBRATION_UNAUTHORIZED_REQUEST_HEADER');
 if(options.method==='POST')assert.equal(requestHeaders['content-type'],'application/json');
 const expected=options.body??Buffer.alloc(0),post=options.method==='POST'?Buffer.from(raw.originalPostData.postData):Buffer.alloc(0);
 assert.equal(post.length,expected.length,'CALIBRATION_ORIGINAL_POST_BYTES_CHANGED');assert.equal(hash(post),hash(expected),'CALIBRATION_ORIGINAL_POST_SHA_CHANGED');
 const response=responses[0].event.response,headers=lowerHeaders(responseExtra[0].event.headers);
 assert.equal(response.url,options.url);assert.equal(response.status,pageResult.status);assert.equal(responseExtra[0].event.statusCode,response.status);
 assert.equal(response.securityState,'secure','CALIBRATION_TLS_NOT_SECURE');assert.ok(response.securityDetails&&/^TLS 1\.[23]$/.test(response.securityDetails.protocol),'CALIBRATION_TLS_DETAILS_REQUIRED');
 assert.ok(finite(response.securityDetails.validFrom)&&finite(response.securityDetails.validTo)&&finite(request.wallTime)
  &&response.securityDetails.validFrom<=request.wallTime&&request.wallTime<=response.securityDetails.validTo,'CALIBRATION_TLS_CERTIFICATE_TIME_CHANGED');
 for(const key of ['fromDiskCache','fromServiceWorker','fromPrefetchCache'])assert.notEqual(response[key],true,'CALIBRATION_CACHED_RESPONSE_REFUSED');
 assert.ok(finite(finished[0].event.encodedDataLength)&&finished[0].event.encodedDataLength>0);
 const body=Buffer.from(pageResult.responseBodyBase64,'base64');assert.equal(body.toString('base64'),pageResult.responseBodyBase64);
 assert.equal(body.length,pageResult.responseBodyBytes);assert.equal(hash(body),pageResult.responseBodySha256,'CALIBRATION_CONSUMED_BODY_SHA_CHANGED');
 if(raw.cdpBody?.bytes>0)assert.equal(raw.cdpBody.sha256,hash(body),'CALIBRATION_NONEMPTY_CDP_BODY_SHA_CONFLICT');
 if(options.kind==='preview'){assert.equal(response.status,200);assert.equal(body.length,QA_PREVIEW.bytes);assert.equal(hash(body),QA_PREVIEW.sha256);
  assert.ok(!headers['content-encoding']||headers['content-encoding']==='identity','CALIBRATION_COMPRESSED_PREVIEW_NOT_BOUND');}
 else if(options.kind==='upload'){assert.equal(response.status,404);assert.equal(body.length,QA_CALIBRATION_SOURCE.notFound.bytes);assert.equal(hash(body),QA_CALIBRATION_SOURCE.notFound.sha256);}
 else{assert.equal(response.status,200);const health=JSON.parse(body);assert.equal(health.environment,'production');assert.equal(health.status,'ok');}
 return {id,body,requestHeaders,responseHeaders:headers,encodedDataLength:finished[0].event.encodedDataLength};
}

export async function createQaCalibrationRequestAdapter({context,page,scope,protocolBytes,readIdentity,readProxyState,privateSink,maxRequestMs=30000}){
 validateQaCalibrationScope(scope);assert.ok(Buffer.isBuffer(protocolBytes)&&hash(protocolBytes)===QA_CALIBRATION_PROTOCOL_SHA256,'CALIBRATION_OFFICIAL_PROTOCOL_PIN_CHANGED');
 assert.equal(typeof context?.newCDPSession,'function');assert.equal(typeof page?.mainFrame,'function');
 assert.equal(page.context(),context,'CALIBRATION_PAGE_CONTEXT_CHANGED');
 for(const fn of [readIdentity,readProxyState,privateSink])assert.equal(typeof fn,'function');
 assert.ok(Number.isSafeInteger(maxRequestMs)&&maxRequestMs>0&&maxRequestMs<=30000);
 const cdp=await context.newCDPSession(page),listeners=[],contexts=new Map(),key='__oasisQaNetwork_'+scope.nonce;
 let bound,active,closed=false,documentLost=false,sequence=0,uploadCount=0,installed=false,lastFinished=-Infinity;const used=new Set(),requestIds=new Set(),errors=[];
 const receive=shaperClock;
 const evaluate=async(fn,args)=>{const result=await cdp.send('Runtime.evaluate',{expression:'('+fn.toString()+')('+JSON.stringify(args)+')',contextId:bound.contextId,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails){if(active)active.raw.realmException=copy(result.exceptionDetails);throw Error('CALIBRATION_REALM_EVALUATION_FAILED');}
  assert.ok(Object.hasOwn(result.result??{},'value'),'CALIBRATION_REALM_RESULT_MISSING');return result.result.value;};
 const on=(event,fn)=>{cdp.on(event,fn);listeners.push([event,fn]);};
 const persist=async(name,raw)=>{const bytes=Buffer.from(JSON.stringify(raw));assert.ok(bytes.length<=12*1024*1024,'CALIBRATION_PRIVATE_EVIDENCE_BOUND');
  const pin=await privateSink({name,bytes});assert.ok(isAbsolute(pin?.path)&&pin.bytes===bytes.length&&pin.sha256===hash(bytes),'CALIBRATION_PRIVATE_SINK_PIN_CHANGED');return pin;};
 const checkIdentity=async()=>validateQaCalibrationInstallation(await readIdentity(),scope);
 const push=(collection,event,received=receive())=>{if(!active)return;if(active.eventCount++>=128){active.error??=Error('CALIBRATION_CDP_EVENT_BOUND');return;}
  active.raw[collection].push({received,event:copy(event)});};
 on('Runtime.executionContextCreated',({context:realm})=>contexts.set(realm.id,realm));
 on('Runtime.executionContextDestroyed',event=>{contexts.delete(event.executionContextId);if(event.executionContextId===bound?.contextId)documentLost=true;});
 on('Runtime.executionContextsCleared',()=>{contexts.clear();if(bound)documentLost=true;});
 on('Network.requestWillBeSent',event=>{if(!active)return;
  if(event.request.url!==active.options.url){active.orphans.delete(event.requestId);return;}
  if(active.eventCount>=128){active.error??=Error('CALIBRATION_CDP_EVENT_BOUND');return;}
  if(requestIds.has(event.requestId)&&!active.ids.has(event.requestId))active.error??=Error('CALIBRATION_REQUEST_ID_REUSED');requestIds.add(event.requestId);
  active.ids.add(event.requestId);push('requests',event);
  for(const [collection,e,received]of active.orphans.get(event.requestId)??[])push(collection,e,received);active.orphans.delete(event.requestId);
 });
 for(const [name,collection]of [['requestWillBeSentExtraInfo','requestExtra'],['responseReceivedExtraInfo','responseExtra']])on('Network.'+name,event=>{
  if(!active)return;if(active.ids.has(event.requestId))push(collection,event);
  else{if(active.orphans.size>=128){active.error??=Error('CALIBRATION_CDP_ORPHAN_BOUND');return;}
   const rows=active.orphans.get(event.requestId)??[];if(rows.length>=4){active.error??=Error('CALIBRATION_CDP_ORPHAN_DUPLICATE');return;}
   rows.push([collection,copy(event),receive()]);active.orphans.set(event.requestId,rows);}
 });
 for(const [name,collection]of [['responseReceived','responses'],['loadingFinished','finished'],['loadingFailed','failed'],['requestServedFromCache','servedFromCache']])on('Network.'+name,event=>{if(active?.ids.has(event.requestId))push(collection,event);});
 const close=async()=>{if(closed)return {closed:true,alreadyClosed:true};closed=true;const cleanup=[];
  const attempt=async(name,work)=>{try{cleanup.push({name,passed:true,result:await work()});}catch{cleanup.push({name,passed:false});}};
  const inFlight=active;
  if(installed)await attempt('own-document-controllers',()=>evaluate(abortQaCalibrationDocument,{key,scope,operationId:inFlight?.operationId,remove:true}));
  if(inFlight)await attempt('own-request-settled',async()=>{let timer;
   try{await Promise.race([inFlight.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CALIBRATION_REQUEST_NOT_SETTLED')),5000);})]);}
   finally{clearTimeout(timer);}});
  for(const [event,fn]of listeners)cdp.off(event,fn);await attempt('own-CDP-session',()=>cdp.detach());
  return {closed:true,cleanup,passed:cleanup.every(c=>c.passed),rootSettingsRestored:false};};
 try{
  const installation=await checkIdentity();
  const version=await cdp.send('Browser.getVersion');assert.equal(version.product.split('/').at(-1),scope.providerVersion,'CALIBRATION_CDP_PROVIDER_CHANGED');
  assert.ok(/; wv\)/.test(version.userAgent),'CALIBRATION_REAL_WEBVIEW_REQUIRED');
  const target=await cdp.send('Target.getTargetInfo');assert.equal(target.targetInfo.targetId,scope.targetId,'CALIBRATION_TARGET_CHANGED');
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');
  const {frameTree}=await cdp.send('Page.getFrameTree'),frame=frameTree.frame;
  assert.equal(new URL(frame.url).origin,scope.origin);assert.equal(target.targetInfo.url,frame.url);assert.equal(page.mainFrame().url(),frame.url);
  const realms=[...contexts.values()].filter(c=>c.auxData?.isDefault&&c.auxData?.frameId===frame.id);
  assert.equal(realms.length,1,'CALIBRATION_DEFAULT_REALM_NOT_UNIQUE');bound={contextId:realms[0].id,frameId:frame.id,loaderId:frame.loaderId,url:frame.url};
  const document=await evaluate(installQaCalibrationDocument,{key,scope});assert.deepEqual(document.owner,scope);installed=true;
  await cdp.send('Network.enable',{maxTotalBufferSize:8*1024*1024,maxResourceBufferSize:4*1024*1024,maxPostDataSize:65536});
  await persist('qa-network-adapter-scope.json',{schema:'android-qa-network-adapter-scope-v1',scope,installation,version,target,frameTree,realm:realms[0],document,
   protocolSha256:hash(protocolBytes),physicalPropagationRtt:false,networkCalibrated:false});
 }catch(error){await close();throw error;}
 const plan=calibrationPlan(scope.nonce);
 return {scope:copy(scope),bound:copy(bound),errors,close,
  async request(options){
   assert.equal(closed,false,'CALIBRATION_ADAPTER_CLOSED');assert.equal(active,undefined,'CALIBRATION_CONCURRENT_REQUEST_REFUSED');
   assert.equal(documentLost,false,'CALIBRATION_DOCUMENT_LOST');assert.ok(['baseline','wifi','weak'].includes(options.phase));
   assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');const url=new URL(options.url);assert.equal(url.origin,scope.origin);
   if(options.kind==='health'){assert.equal(options.method,'GET');assert.equal(options.url,plan.healthUrl);assert.ok([0,1,2].includes(options.sample));assert.equal(options.body,undefined);}
   else if(options.kind==='preview'){assert.equal(options.method,'GET');assert.equal(options.url,plan.previewUrl);assert.equal(options.body,undefined);}
   else{assert.equal(options.kind,'upload');assert.equal(options.method,'POST');assert.ok(plan.uploads.some(u=>u.url===options.url));assert.equal(options.contentType,'application/json');
    assert.ok(Buffer.isBuffer(options.body)&&options.body.length===65536&&hash(options.body)===plan.uploadSha256);assert.ok(uploadCount<3,'CALIBRATION_UPLOAD_CAP');}
   const use=options.phase+' '+options.method+' '+options.url+(options.kind==='health'?' '+options.sample:'');assert.equal(used.has(use),false,'CALIBRATION_PROBE_REPEAT_REFUSED');used.add(use);
   if(options.kind==='upload')uploadCount++;
   const operationId='request-'+(++sequence),raw={schema:'android-qa-original-request-evidence-v1',scope:copy(scope),bound:copy(bound),frameId:bound.frameId,
    options:{phase:options.phase,kind:options.kind,url:options.url,method:options.method,requestBodyBytes:options.body?.length??0,requestBodySha256:hash(options.body??Buffer.alloc(0)),...(options.kind==='health'?{sample:options.sample}:{})},
    requests:[],requestExtra:[],responseExtra:[],responses:[],finished:[],failed:[],servedFromCache:[],physicalPropagationRtt:false};
   const current={options,operationId,raw,ids:new Set(),orphans:new Map(),eventCount:0};current.done=new Promise(resolve=>{current.finish=resolve;});active=current;let error,cancellation;
   const abort=()=>{cancellation=evaluate(abortQaCalibrationDocument,{key,scope,operationId}).then(value=>{raw.abortAcknowledgement=value;},()=>{raw.abortAcknowledgement={failed:true};});};
   options.signal?.addEventListener('abort',abort,{once:true});
   try{
    assert.equal(options.signal?.aborted??false,false,'CALIBRATION_ABORTED_BEFORE_REQUEST');raw.installationBefore=await checkIdentity();
    raw.proxyBefore=copy(await readProxyState());validateSnapshot(raw.proxyBefore,options.phase);
    assert.equal(closed,false,'CALIBRATION_ADAPTER_CLOSED');assert.equal(documentLost,false,'CALIBRATION_DOCUMENT_LOST');
    assert.equal(options.signal?.aborted??false,false,'CALIBRATION_ABORTED_BEFORE_REQUEST');raw.commandSent=receive();
    raw.pageResult=await evaluate(fetchQaCalibrationDocument,{key,scope,url:options.url,method:options.method,body:options.body?.toString(),operationId,timeoutMs:maxRequestMs});raw.commandReturned=receive();
    const deadline=performance.now()+Math.min(5000,maxRequestMs);
    while(!raw.requestExtra.length||!raw.responseExtra.length||!raw.finished.length){
     if(active.error)throw active.error;if(raw.failed.length)throw Error('CALIBRATION_ORIGINAL_REQUEST_FAILED');
     assert.ok(performance.now()<deadline,'CALIBRATION_ORIGINAL_NETWORK_EVIDENCE_TIMEOUT');await sleep(10);
    }
    if(active.error)throw active.error;assert.equal(raw.requests.length,1,'CALIBRATION_REQUEST_NOT_UNIQUE');const id=raw.requests[0].event.requestId;
    if(options.method==='POST'){
     raw.originalPostData=await cdp.send('Network.getRequestPostData',{requestId:id});assert.equal(raw.originalPostData.base64Encoded??false,false,'CALIBRATION_POST_ENCODING_CHANGED');
    }
    let original;try{original=await cdp.send('Network.getResponseBody',{requestId:id});}
    catch(value){raw.cdpBody={unreadable:true,error:{message:String(value.message),code:value.code??null}};}
    if(original){raw.cdpBody={original};const body=decodeBody(original);Object.assign(raw.cdpBody,{bytes:body.length,sha256:hash(body)});}
    raw.proxyAfter=copy(await readProxyState());validateSnapshot(raw.proxyAfter,options.phase);raw.installationAfter=await checkIdentity();
    assert.equal(documentLost,false,'CALIBRATION_DOCUMENT_LOST');assert.equal(options.signal?.aborted??false,false,'CALIBRATION_REQUEST_ABORTED');
    const before=raw.proxyBefore,after=raw.proxyAfter;assert.equal(after.configuration.era,before.configuration.era,'CALIBRATION_PROXY_ERA_CHANGED');
    assert.equal(after.configuration.sha256,before.configuration.sha256);assert.deepEqual(after.process,before.process);assert.equal(after.listenPort,before.listenPort);
    const valid=validateQaCalibrationRequestEvidence(raw,{scope,options});
    assert.ok(raw.pageResult.started>=lastFinished,'CALIBRATION_OWNED_PERFORMANCE_CLOCK_REGRESSED');lastFinished=raw.pageResult.finished;
    const targetConnectionIds=after.targetConnections.filter(c=>{const old=before.targetConnections.find(p=>p.id===c.id);
     return c.uploadBytes>(old?.uploadBytes??0)||c.downloadBytes>(old?.downloadBytes??0);}).map(c=>c.id);
    assert.ok(targetConnectionIds.length>0,'CALIBRATION_ACTUAL_PROXY_TARGET_BYTES_REQUIRED');
    raw.matchedConnections={scope:'target-host-aggregate-candidates-in-original-era',uniqueHttp2StreamJoin:false,ids:targetConnectionIds};
    active=undefined;const pin=await persist('qa-network-request-'+String(sequence).padStart(2,'0')+'.json',raw);
    return {schema:'android-qa-calibration-request-v1',scope:copy(scope),url:options.url,method:options.method,requestId:valid.id,
     startedMonotonicMs:raw.pageResult.started,finishedMonotonicMs:raw.pageResult.finished,clockScope:'owned-WebView-performance',
     redirected:false,fromDiskCache:false,fromServiceWorker:false,fromPrefetchCache:false,tlsVerified:true,
     requestBodyBytes:options.body?.length??0,requestBodySha256:hash(options.body??Buffer.alloc(0)),status:raw.pageResult.status,responseBody:valid.body,
     proxyEvidence:{schema:'android-qa-request-proxy-interval-v1',requestId:valid.id,clockDomain:before.clockDomain,era:before.configuration.era,
      configurationSha256:before.configuration.sha256,before:before.clock,after:after.clock,targetConnectionIds,originalEvidenceSha256:pin.sha256,
      cdpEncodedDataLength:valid.encodedDataLength,requestContentEncoding:'identity',responseContentEncoding:valid.responseHeaders['content-encoding']??'identity'}};
   }catch(value){error=value;raw.failure={message:String(value.message),code:value.code??null};errors.push({sequence,code:String(value.message).startsWith('CALIBRATION_')?String(value.message):'CALIBRATION_ADAPTER_EXTERNAL_ERROR'});
    try{await persist('qa-network-request-'+String(sequence).padStart(2,'0')+'-failed.json',raw);}catch{errors.push({sequence,code:'CALIBRATION_FAILURE_EVIDENCE_SAVE_FAILED'});}
    throw error;
   }finally{options.signal?.removeEventListener('abort',abort);await cancellation;if(active===current)active=undefined;current.finish();}
  },
 };
}

/** Root supplies all setup/restoration callbacks. Failure before the old driver
 * starts must still attempt Root restoration and own proxy close independently.
 * A timeout's AbortController acknowledgement is a cancellation request, never
 * a claim that the server did not receive the body or that settings were restored.
 */
export async function collectQaCalibrationWithAdapter({adapterOptions,...options}){
 let adapter,entered=false,report,first;
 try{adapter=await createQaCalibrationRequestAdapter(adapterOptions);entered=true;
  report=await collectQaNetworkCalibration({...options,scope:adapter.scope,nonce:adapter.scope.nonce,request:adapter.request});
 }catch(error){first=error;}
 finally{
  if(!entered){for(const fn of [options.cleanupRoot,()=>options.shaper.close()])try{await fn();}catch{}}
  if(adapter){const cleanup=await adapter.close();if(report){report.adapterCleanup=cleanup;if(!cleanup.passed){report.status='insufficient';report.errors.push({code:'CALIBRATION_ADAPTER_CLEANUP_FAILED'});}}}
 }
 if(first)throw first;return report;
}
