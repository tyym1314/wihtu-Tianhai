import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createQaCalibrationRequestAdapter,QA_CALIBRATION_APK,qaCalibrationProxySnapshot,
 collectQaCalibrationWithAdapter,validateQaCalibrationInstallation,validateQaCalibrationRequestEvidence,installQaCalibrationDocument,fetchQaCalibrationDocument} from '../scripts/android-player-network-calibration.mjs';
import {calibrationPlan,QA_NETWORK_ORIGIN,shaperConfiguration,shaperConfigurationSha256} from '../scripts/android-player-network-shaper.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const nonce='0123456789abcdef0123456789abcdef';
const scope={serial:'46dcfd25',androidUserId:0,uid:10416,packageName:'com.tianyahuyu.oasis.player.qa',origin:QA_NETWORK_ORIGIN,
 pid:37,startTicks:'1400',documentId:'a'.repeat(32),timeOrigin:1700000000000,nonce,providerVersion:'150.0.7871.124',targetId:'SYNTHETIC-unit-target'};
const protocolBytes=await readFile(new URL('../review/android-player-20261010/root-feedback-official-protocol-wn05wslg/browser_protocol.json',import.meta.url));
const plan=calibrationPlan(nonce),health=Buffer.from('{"environment":"production","status":"ok"}');
const configuration=shaperConfiguration({profile:'baseline'});
const c={id:'SYNTHETIC-tunnel',era:1,target:true,host:new URL(QA_NETWORK_ORIGIN).hostname,port:443,uploadBytes:0,downloadBytes:0};
const installation=()=>({schema:'android-qa-calibration-installation-v1',scope:structuredClone(scope),apk:structuredClone(QA_CALIBRATION_APK),tlsErrorsIgnored:false,originalEvidenceSha256:'b'.repeat(64)});
const optionsFor=kind=>({phase:'baseline',kind,url:kind==='upload'?plan.uploads[0].url:plan.healthUrl,method:kind==='upload'?'POST':'GET',...(kind==='health'?{sample:0}:{}),
 body:kind==='upload'?plan.uploads[0].body:undefined,contentType:kind==='upload'?'application/json':undefined,cache:'no-store',redirect:'error'});

/** Entirely synthetic CDP events. This fixture never loads Playwright, ADB,
 * connects a target, or performs a fetch. Original local protocol bytes only
 * exercise the pin; successful fixtures are not real-phone acceptance. */
function fixture(mode){
 const saved=[],calls=[],dispatched=[],connection=structuredClone(c);let time=100,identityReads=0,lastBody,requestCount=0;
 const cdp=new EventEmitter();cdp.detach=async()=>{calls.push('detach');};
 cdp.send=async(method,args={})=>{
  calls.push(method);
  if(method==='Browser.getVersion')return {product:'Chrome/150.0.7871.124',userAgent:'Mozilla/5.0 (Linux; Android 16; UNIT; wv) Chrome/150.0.7871.124 Mobile'};
  if(method==='Target.getTargetInfo')return {targetInfo:{targetId:scope.targetId,url:QA_NETWORK_ORIGIN+'/'}};
  if(method==='Runtime.enable'){cdp.emit('Runtime.executionContextCreated',{context:{id:7,auxData:{isDefault:true,frameId:'frame'}}});return {};}
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame',loaderId:'loader',url:QA_NETWORK_ORIGIN+'/'}}};
  if(method==='Runtime.evaluate'){
   assert.equal(args.contextId,7);const value=JSON.parse(args.expression.slice(args.expression.lastIndexOf(')(')+2,-1));
   if(args.expression.includes('function installQaCalibrationDocument'))return {result:{value:{owner:scope,url:QA_NETWORK_ORIGIN+'/',at:1,epochMs:scope.timeOrigin+1}}};
   if(args.expression.includes('function abortQaCalibrationDocument'))return {result:{value:{ownerMissing:false,cancelRequested:true,removed:!!value.remove}}};
   assert.ok(args.expression.includes('function fetchQaCalibrationDocument'));requestCount++;lastBody=value.body;dispatched.push(value);
   const notFound=value.method==='POST'||mode==='health-404',status=notFound?404:200;
   const requestId='SYNTHETIC-request-'+(mode==='reused-id'?1:requestCount),responseBody=notFound?Buffer.from('{"error":{"code":"NOT_FOUND","message":"NOT_FOUND"}}'):health;
   const postHeaders=value.method==='POST'?{'Content-Type':'application/json'}:{};
   // Real CDP may deliver ExtraInfo before its base event; preserve and bind it.
   cdp.emit('Network.requestWillBeSentExtraInfo',{requestId,headers:postHeaders,connectTiming:{requestTime:1}});
   cdp.emit('Network.requestWillBeSent',{requestId,frameId:mode==='foreign-frame'?'foreign':'frame',timestamp:1,wallTime:scope.timeOrigin/1000,
    request:{url:value.url,method:value.method},initiator:{type:'script'}});
   if(mode==='duplicate')cdp.emit('Network.requestWillBeSent',{requestId,frameId:'frame',timestamp:1,wallTime:scope.timeOrigin/1000,request:{url:value.url,method:value.method},initiator:{type:'script'}});
   cdp.emit('Network.responseReceived',{requestId,timestamp:1.05,response:{url:value.url,status,
    securityState:mode==='tls'?'insecure':'secure',securityDetails:{protocol:'TLS 1.3',validFrom:0,validTo:2100000000},
    fromDiskCache:mode==='cache',fromServiceWorker:false,fromPrefetchCache:false,protocol:'h2',connectionId:48,timing:{requestTime:1,receiveHeadersEnd:50}}});
   if(mode!=='missing-extra')cdp.emit('Network.responseReceivedExtraInfo',{requestId,statusCode:status,headers:{'Content-Type':'application/json'}});
   cdp.emit('Network.loadingFinished',{requestId,timestamp:1.05,encodedDataLength:responseBody.length+128});
   connection.uploadBytes+=(value.body?.length??64);connection.downloadBytes+=responseBody.length+128;time+=50;
   if(mode==='context-lost')cdp.emit('Runtime.executionContextDestroyed',{executionContextId:7});
   const start=100+(mode==='reused-page-result'?0:requestCount-1)*60;
   const result={owner:scope,url:value.url,status,redirected:false,responseType:'basic',started:start,headerAt:start+25,finished:start+50,
    startedEpoch:scope.timeOrigin+start,finishedEpoch:scope.timeOrigin+start+50,responseBodyBase64:responseBody.toString('base64'),responseBodyBytes:responseBody.length,responseBodySha256:hash(responseBody)};
   if(mode==='consumed-conflict')result.responseBodySha256='f'.repeat(64);
   return {result:{value:result}};
  }
  if(method==='Network.getRequestPostData')return {postData:mode==='post-conflict'?'{}':lastBody};
  if(method==='Network.getResponseBody'){
   if(mode==='unreadable')throw Error('SYNTHETIC getResponseBody unavailable');
   return {body:mode==='nonempty-conflict'?'conflicting-original-bytes':mode==='malformed'?'!notbase64!':mode==='empty'?'':
    (lastBody||mode==='health-404'?Buffer.from('{"error":{"code":"NOT_FOUND","message":"NOT_FOUND"}}'):health).toString('base64'),base64Encoded:mode!=='nonempty-conflict'};
  }
  return {};
 };
 const context={newCDPSession:async()=>cdp};
 const adapterOptions={context,page:{context:()=>context,mainFrame:()=>({url:()=>QA_NETWORK_ORIGIN+'/'})},scope,protocolBytes,maxRequestMs:25,
  readIdentity:async()=>{identityReads++;const value=installation();if(mode==='clone'||mode==='identity-changed'&&identityReads>=3)value.scope.uid=1010416;return value;},
  readProxyState:async()=>({schema:'android-qa-proxy-snapshot-v1',clockDomain:'Mac-host-hrtime-ms',clock:{monotonicMs:time,epochMs:scope.timeOrigin+time},
   listenHost:'127.0.0.1',listenPort:40000,process:{pid:123,started:{monotonicMs:0,epochMs:scope.timeOrigin}},configuration:{era:1,configuration,sha256:shaperConfigurationSha256(configuration)},
   targetConnections:[structuredClone(connection)],rowCount:requestCount*2,totalEntries:requestCount*2+2,maxLedgerEntries:300000,overflow:false,dropped:0,errors:[]}),
  privateSink:async({name,bytes})=>{saved.push({name,bytes:Buffer.from(bytes)});return {path:'/PRIVATE-SYNTHETIC-UNIT/'+name,bytes:bytes.length,sha256:mode==='bad-sink'?'0'.repeat(64):hash(bytes)};}};
 return {adapterOptions,saved,calls,dispatched,cdp,requestCount:()=>requestCount};
}

test('three same-URL health samples retain fresh native IDs, command boundaries and bodies without sending sample metadata',async()=>{
 const f=fixture(),adapter=await createQaCalibrationRequestAdapter(f.adapterOptions),receipts=[];
 assert.equal(plan.healthUrl,QA_NETWORK_ORIGIN+'/health/ready');
 for(const sample of [0,1,2])receipts.push(await adapter.request({...optionsFor('health'),sample}));
 assert.equal(new Set(receipts.map(row=>row.requestId)).size,3);assert.equal(new Set(receipts.map(row=>row.url)).size,1);
 const raws=f.saved.filter(row=>/^qa-network-request-0[123]\.json$/.test(row.name)).map(row=>JSON.parse(row.bytes));
 assert.deepEqual(raws.map(raw=>raw.options.sample),[0,1,2]);assert.equal(new Set(f.dispatched.map(row=>row.operationId)).size,3);
 for(const [index,raw]of raws.entries()){
  assert.equal(raw.requests[0].event.requestId,receipts[index].requestId);assert.equal(raw.pageResult.responseBodySha256,hash(health));
  assert.equal(raw.pageResult.responseBodySha256,raw.cdpBody.sha256);assert.ok(raw.installationBefore&&raw.installationAfter);
  assert.ok(raw.commandSent.monotonicMs<=raw.requests[0].received.monotonicMs&&raw.requests[0].received.monotonicMs<=raw.commandReturned.monotonicMs);
  if(index)assert.ok(raw.pageResult.started>=raws[index-1].pageResult.finished);
  assert.equal(f.dispatched[index].url,plan.healthUrl);assert.equal(Object.hasOwn(f.dispatched[index],'sample'),false);
 }
 await assert.rejects(adapter.request(optionsFor('health')),/CALIBRATION_PROBE_REPEAT_REFUSED/);
 for(const sample of [3,'1',undefined])await assert.rejects(adapter.request({...optionsFor('health'),sample}));
 await assert.rejects(adapter.request({...optionsFor('health'),url:plan.healthUrl+'?qa_net='+nonce+'&sample=0'}));
 assert.equal(f.requestCount(),3);await adapter.close();
});

test('same-URL health captures reject reused native request IDs, old consumption clocks and out-of-command collection',async()=>{
 for(const mode of ['reused-id','reused-page-result']){
  const f=fixture(mode),adapter=await createQaCalibrationRequestAdapter(f.adapterOptions);await adapter.request(optionsFor('health'));
  await assert.rejects(adapter.request({...optionsFor('health'),sample:1}),/CALIBRATION_REQUEST_ID_REUSED|CALIBRATION_OWNED_PERFORMANCE_CLOCK_REGRESSED/);
  assert.match(f.saved.at(-1).name,/-failed/);await adapter.close();
 }
 const f=fixture(),adapter=await createQaCalibrationRequestAdapter(f.adapterOptions);await adapter.request(optionsFor('health'));
 const original=JSON.parse(f.saved.at(-1).bytes);
 for(const outside of ['before','after']){const raw=structuredClone(original);raw.requests[0].received.monotonicMs=outside==='before'?raw.commandSent.monotonicMs-1:raw.commandReturned.monotonicMs+1;
  assert.throws(()=>validateQaCalibrationRequestEvidence(raw,{scope,options:optionsFor('health')}),/CALIBRATION_REQUEST_CAPTURE_NOT_FRESH/);}
 await adapter.close();
});

test('literal health endpoint still rejects the genuine NOT_FOUND status and body contract instead of admitting 404',async()=>{
 const f=fixture('health-404'),adapter=await createQaCalibrationRequestAdapter(f.adapterOptions);
 await assert.rejects(adapter.request(optionsFor('health')),error=>error.actual===404&&error.expected===200);
 const raw=JSON.parse(f.saved.at(-1).bytes);assert.equal(raw.pageResult.status,404);assert.equal(raw.pageResult.responseBodyBytes,52);
 assert.equal(raw.pageResult.responseBodySha256,'25f169010390e1601e36cbf51501ebd84b050cd8c0c27cb3a6c92c286326a5c7');
 assert.equal(raw.failed.length,0);assert.equal(raw.finished.length,1);assert.equal(f.requestCount(),1);await adapter.close();
});

test('fixed archived QA APK, certificate and original readback are required, clone UID and ignored TLS cannot be accepted',async()=>{
 const metadata=JSON.parse(await readFile(new URL('../review/android-player-20261010/root-native-recovery-build-20261010/artifacts/qa/build-metadata.json',import.meta.url)));
 for(const key of ['apkSha256','certificateSha256','apkBytes'])assert.equal(QA_CALIBRATION_APK[key],metadata[key]);
 const bytes=await readFile(new URL('../review/android-player-20261010/root-native-recovery-build-20261010/artifacts/qa/build-metadata.json',import.meta.url));assert.equal(hash(bytes),QA_CALIBRATION_APK.metadataSha256);
 for(const kind of ['clone','tls','certificate','missing-pin']){const value=installation();
  if(kind==='clone')value.scope.uid=1010416;if(kind==='tls')value.tlsErrorsIgnored=true;if(kind==='certificate')value.apk.certificateSha256='0'.repeat(64);if(kind==='missing-pin')delete value.originalEvidenceSha256;
  assert.throws(()=>validateQaCalibrationInstallation(value,scope),undefined,kind);
 }
 const f=fixture('clone');await assert.rejects(createQaCalibrationRequestAdapter(f.adapterOptions));assert.equal(f.requestCount(),0);assert.ok(f.calls.includes('detach'));
});

test('original requestId, out-of-order ExtraInfo, TLS, consumed bytes, dual clocks and target-era candidate counters form the private receipt',async()=>{
 const f=fixture(),adapter=await createQaCalibrationRequestAdapter(f.adapterOptions),receipt=await adapter.request(optionsFor('upload'));
 assert.equal(receipt.requestBodyBytes,65536);assert.equal(receipt.responseBody.length,52);assert.equal(receipt.proxyEvidence.cdpEncodedDataLength,180);
 assert.deepEqual(receipt.proxyEvidence.targetConnectionIds,['SYNTHETIC-tunnel']);assert.equal(receipt.proxyEvidence.era,1);assert.equal(receipt.proxyEvidence.before.monotonicMs,100);assert.equal(receipt.proxyEvidence.after.monotonicMs,150);
 const original=f.saved.find(s=>s.name==='qa-network-request-01.json'),raw=JSON.parse(original.bytes);
 assert.equal(receipt.proxyEvidence.originalEvidenceSha256,hash(original.bytes));assert.equal(raw.requestExtra[0].event.requestId,receipt.requestId);
 assert.equal(raw.responses[0].event.response.connectionId,48);assert.equal(raw.matchedConnections.uniqueHttp2StreamJoin,false);
 assert.equal(raw.pageResult.responseBodySha256,hash(receipt.responseBody));assert.equal(raw.cdpBody.sha256,hash(receipt.responseBody));assert.equal(raw.proxyAfter.targetConnections[0].uploadBytes,65536);
 assert.ok(!Object.hasOwn(receipt,'headers'));assert.equal(raw.physicalPropagationRtt,false);
 const cleanup=await adapter.close();assert.equal(cleanup.passed,true);assert.equal(cleanup.rootSettingsRestored,false);
 assert.equal(f.cdp.listenerCount('Network.requestWillBeSent'),0);assert.ok(f.calls.includes('detach'));
 assert.ok(!f.calls.some(m=>/emulate|setCache|setBypass|setOverride|Input\.|Target\.attach/.test(m)));
});

test('only empty or unreadable CDP bodies use the exact independently consumed original body; nonempty disagreements and malformed originals remain failures',async()=>{
 for(const mode of ['empty','unreadable','nonempty-conflict','malformed']){
  const f=fixture(mode),adapter=await createQaCalibrationRequestAdapter(f.adapterOptions);
  if(['empty','unreadable'].includes(mode)){const receipt=await adapter.request(optionsFor('health'));assert.equal(hash(receipt.responseBody),hash(health));
   const raw=JSON.parse(f.saved.at(-1).bytes);assert.ok(raw.cdpBody.unreadable||raw.cdpBody.bytes===0);}
  else{await assert.rejects(adapter.request(optionsFor('health')),/CALIBRATION_NONEMPTY_CDP_BODY_SHA_CONFLICT|CALIBRATION_BASE64_BODY_INVALID/);assert.match(f.saved.at(-1).name,/-failed/);}
  await adapter.close();assert.equal(f.requestCount(),1,'never substitute a second HTTP request');
 }
});

test('foreign frame, duplicate, cache, TLS, original POST conflict, lost context and missing ExtraInfo cannot create valid receipts',async()=>{
 for(const mode of ['foreign-frame','duplicate','cache','tls','post-conflict','context-lost','consumed-conflict','missing-extra','identity-changed']){
  const f=fixture(mode),adapter=await createQaCalibrationRequestAdapter(f.adapterOptions);
  await assert.rejects(adapter.request(optionsFor('upload')),undefined,mode);
  assert.match(f.saved.at(-1).name,/-failed/,mode);await adapter.close();assert.ok(f.calls.includes('detach'));
 }
});

test('business paths and repeated or excess uploads are refused before any request; only the three distinct bounded unknown paths are allowed',async()=>{
 const f=fixture(),adapter=await createQaCalibrationRequestAdapter(f.adapterOptions);
 await assert.rejects(adapter.request({...optionsFor('upload'),url:QA_NETWORK_ORIGIN+'/api/player/login'}));assert.equal(f.requestCount(),0);
 await adapter.request(optionsFor('upload'));await assert.rejects(adapter.request(optionsFor('upload')));
 assert.equal(f.requestCount(),1);
 for(const index of [1,2])await adapter.request({...optionsFor('upload'),url:plan.uploads[index].url,body:plan.uploads[index].body});
 await assert.rejects(adapter.request({...optionsFor('upload'),phase:'wifi'}),/CALIBRATION_UPLOAD_CAP/);
 assert.equal(f.requestCount(),3);await adapter.close();
 const bad=fixture('bad-sink');await assert.rejects(createQaCalibrationRequestAdapter(bad.adapterOptions),/CALIBRATION_PRIVATE_SINK_PIN_CHANGED/);
 assert.equal(bad.requestCount(),0);assert.ok(bad.calls.includes('detach'));
});

test('original proxy snapshot retains complete current-era target candidates without ciphertext; overflow or excessive candidates cannot be projected away',()=>{
 const ledger={schema:'android-blind-connect-ledger-v1',clockDomain:'Mac-host-hrtime-ms',process:{pid:123},listenHost:'127.0.0.1',listenPort:40000,
  configurations:[{era:1,configuration,sha256:shaperConfigurationSha256(configuration)}],connections:[c,{...c,id:'other',era:0}],rows:[],errors:[],maxLedgerEntries:300000,overflow:false,dropped:0};
 const snapshot=qaCalibrationProxySnapshot({ledger});assert.equal(snapshot.targetConnections.length,1);assert.equal(snapshot.totalEntries,3);
 assert.ok(!Object.hasOwn(snapshot,'ciphertext'));ledger.connections=Array.from({length:257},(_,i)=>({...c,id:String(i)}));
 assert.throws(()=>qaCalibrationProxySnapshot({ledger}),/CALIBRATION_PROXY_CANDIDATE_BOUND/);
});

test('adapter initialization failure independently attempts Root original-settings cleanup and own proxy close without creating network proof',async()=>{
 const f=fixture('clone'),order=[];
 await assert.rejects(collectQaCalibrationWithAdapter({adapterOptions:f.adapterOptions,cleanupRoot:async()=>{order.push('root');throw Error('SYNTHETIC cleanup failure');},shaper:{close:async()=>order.push('proxy')}}));
 assert.deepEqual(order,['root','proxy']);assert.equal(f.requestCount(),0);
});

test('the actual serialized realm function consumes complete bytes before its finish clock, omits credentials and leaves no controller behind',async()=>{
 let at=100,observed;const response=Buffer.from('{"error":{"code":"NOT_FOUND","message":"NOT_FOUND"}}'),key='SYNTHETIC-own-key';
 const realm=vm.createContext({location:{origin:scope.origin,href:scope.origin+'/'},performance:{timeOrigin:scope.timeOrigin,now:()=>at},
  crypto:webcrypto,AbortController,setTimeout,clearTimeout,btoa:binary=>Buffer.from(binary,'binary').toString('base64'),
  fetch:async(url,options)=>{observed={url,options};at=150;return {url,status:404,redirected:false,type:'basic',arrayBuffer:async()=>{at=200;return response.buffer.slice(response.byteOffset,response.byteOffset+response.byteLength);}};}});
 vm.runInContext('('+installQaCalibrationDocument.toString()+')('+JSON.stringify({key,scope})+')',realm);
 const args={key,scope,url:plan.uploads[0].url,method:'POST',body:plan.uploads[0].body.toString(),operationId:'SYNTHETIC-operation',timeoutMs:1000};
 const result=await vm.runInContext('('+fetchQaCalibrationDocument.toString()+')('+JSON.stringify(args)+')',realm);
 assert.equal(observed.options.credentials,'omit');assert.equal(observed.options.redirect,'error');assert.equal(observed.options.cache,'no-store');
 assert.equal(observed.options.headers['Content-Type'],'application/json');assert.equal(Buffer.byteLength(observed.options.body),65536);
 assert.equal(result.started,100);assert.equal(result.headerAt,150);assert.equal(result.finished,200);assert.equal(result.responseBodySha256,hash(response));
 assert.equal(realm[key].controllers.size,0);
 realm.performance.timeOrigin++;observed=undefined;
 await assert.rejects(vm.runInContext('('+fetchQaCalibrationDocument.toString()+')('+JSON.stringify(args)+')',realm),/CALIBRATION_DOCUMENT_CHANGED/);
 assert.equal(observed,undefined);
});

test('cancellation while Root reads identity prevents even the bounded unknown POST from being dispatched',async()=>{
 const f=fixture(),controller=new AbortController(),originalRead=f.adapterOptions.readIdentity;let reads=0;
 f.adapterOptions.readIdentity=async()=>{const value=await originalRead();if(++reads===2)controller.abort();return value;};
 const adapter=await createQaCalibrationRequestAdapter(f.adapterOptions);
 await assert.rejects(adapter.request({...optionsFor('upload'),signal:controller.signal}),/CALIBRATION_ABORTED_BEFORE_REQUEST/);
 assert.equal(f.requestCount(),0);assert.match(f.saved.at(-1).name,/-failed/);await adapter.close();
});
