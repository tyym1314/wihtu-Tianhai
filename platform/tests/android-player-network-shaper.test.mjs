import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {AggregateByteQueue,shaperConfiguration,startBlindConnectShaper,validateProxyLedger,
 calibrationPlan,collectQaNetworkCalibration,qaCalibrationSourceReceipt,analyzeQaNetworkCalibration,shaperConfigurationSha256,
 QA_CALIBRATION_SOURCE,QA_NETWORK_ORIGIN} from '../scripts/android-player-network-shaper.mjs';

const sha=raw=>createHash('sha256').update(raw).digest('hex');
const nonce='0123456789abcdef0123456789abcdef';
const scope={serial:'46dcfd25',androidUserId:0,uid:10416,packageName:'com.tianyahuyu.oasis.player.qa',origin:QA_NETWORK_ORIGIN,
 pid:37,startTicks:'1400',documentId:'a'.repeat(32),timeOrigin:1700000000000,nonce,providerVersion:'150.0.7871.124',targetId:'unit-owned-target'};
const stamp=time=>({monotonicMs:time,epochMs:1700000000000+time});

test('one bucket limits distinct target connections and delay is an enqueue deadline',async()=>{
 let time=0;const rows=[],delivered=[];
 const queue=new AggregateByteQueue({direction:'upload',rateBytesPerSecond:1024,delayMs:100,burstBytes:1024,maxQueuedBytes:4096,
  clock:()=>stamp(time),wait:async ms=>{time+=ms;},record:row=>rows.push(row)});
 const deliver=async buffer=>delivered.push(buffer.length);
 const first=queue.enqueue(Buffer.alloc(1024),'owned-a',deliver,stamp(0));
 const second=queue.enqueue(Buffer.alloc(1024),'owned-b',deliver,stamp(0));
 const third=queue.enqueue(Buffer.alloc(1024),'owned-a',deliver,stamp(0));
 await Promise.all([first,second,third]);await queue.close();
 assert.deepEqual(delivered,[1024,1024,1024]);
 assert.deepEqual(rows.map(row=>row.writeAccepted.monotonicMs),[100,1100,2100]);
 assert.deepEqual(rows.map(row=>row.enqueued.monotonicMs),[0,0,0]);
 assert.deepEqual(rows.map(row=>row.connectionId),['owned-a','owned-b','owned-a']);
 // Repeating 100ms after each rate wait would incorrectly produce 1200/2300.
 assert.equal(rows[2].writeAccepted.monotonicMs-rows[0].writeAccepted.monotonicMs,2000);
});

test('destination backpressure blocks the FIFO head and bounded overflow rejects rather than drops',async()=>{
 let release;const rows=[];const queue=new AggregateByteQueue({direction:'download',rateBytesPerSecond:null,delayMs:0,burstBytes:1024,maxQueuedBytes:2048,
  clock:()=>stamp(0),record:row=>rows.push(row)});
 const first=queue.enqueue(Buffer.alloc(1024),'a',()=>new Promise(resolve=>{release=resolve;}));
 let delivered=false;const second=queue.enqueue(Buffer.alloc(1024),'b',async()=>{delivered=true;});
 assert.equal(delivered,false);assert.equal(queue.queuedBytes,2048);
 assert.throws(()=>queue.enqueue(Buffer.alloc(1),'c',async()=>{}),/SHAPER_QUEUE_OVERFLOW/);
 release();await Promise.all([first,second]);await queue.close();
 assert.equal(delivered,true);assert.deepEqual(rows.map(row=>row.connectionId),['a','b']);assert.equal(queue.queuedBytes,0);
});

test('a new job immediately after awaiting the previous job cannot be stranded at the idle boundary',async()=>{
 let time=0;const rows=[],queue=new AggregateByteQueue({direction:'upload',rateBytesPerSecond:1024,delayMs:0,burstBytes:1024,maxQueuedBytes:2048,
  clock:()=>stamp(time),wait:async ms=>{time+=ms;},record:row=>rows.push(row)});
 for(let index=0;index<4;index++)await queue.enqueue(Buffer.alloc(1024),'a',async()=>{});
 await queue.close();assert.deepEqual(rows.map(row=>row.enqueueOrder),[1,2,3,4]);assert.equal(rows.at(-1).writeAccepted.monotonicMs,3000);
});

test('monotonic rollback is rejected and closing an outstanding wait rejects its own queued work',async()=>{
 let time=10;const queue=new AggregateByteQueue({direction:'upload',rateBytesPerSecond:1024,delayMs:0,burstBytes:1024,maxQueuedBytes:2048,clock:()=>stamp(time)});
 await queue.enqueue(Buffer.alloc(1024),'a',async()=>{});time=9;
 assert.throws(()=>queue.enqueue(Buffer.alloc(1),'a',async()=>{}),/SHAPER_CLOCK_REGRESSED/);await queue.close();
 const events=[];const pending=new AggregateByteQueue({direction:'upload',rateBytesPerSecond:1024,delayMs:100,burstBytes:1024,maxQueuedBytes:2048,
  clock:()=>stamp(0),record:row=>events.push(row),wait:(_ms,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))});
 const result=pending.enqueue(Buffer.alloc(1024),'a',async()=>{});const rejection=assert.rejects(result,/SHAPER_QUEUE_CLOSED|aborted/);
 await pending.close();await rejection;assert.equal(pending.queuedBytes,0);assert.ok(events.some(row=>row.kind==='queue-error'));
});

function ledgerFixture(){
 const configuration=shaperConfiguration({profile:'wifi',uploadDelayMs:10,downloadDelayMs:10,burstBytes:1024,maxQueuedBytes:2048});
 const ledger={schema:'android-blind-connect-ledger-v1',clockDomain:'Mac-host-hrtime-ms',process:{pid:123},listenHost:'127.0.0.1',listenPort:40000,dropped:0,errors:[],closed:true,cleanupErrors:[],
  cleanup:{listenerClosed:true,ownTunnelsRemaining:0,queuedBytes:0},
  maxLedgerEntries:10000,overflow:false,configurations:[{era:0,configuration,sha256:shaperConfigurationSha256(configuration),started:stamp(0),finished:stamp(30)}],
  connections:[{id:'a',era:0,host:new URL(QA_NETWORK_ORIGIN).hostname,port:443,target:true,routeChanged:true,uploadBytes:2048,downloadBytes:1024,closed:true},
   {id:'b',era:0,host:'example.org',port:443,target:false,routeChanged:true,uploadBytes:90,downloadBytes:90,closed:true}],
  rows:[{kind:'write',direction:'upload',connectionId:'a',era:0,bytes:1024,enqueued:stamp(0),enqueueOrder:1,writeAccepted:stamp(10),drained:stamp(10),tokensAfter:0},
   {kind:'write',direction:'upload',connectionId:'a',era:0,bytes:1024,enqueued:stamp(0),enqueueOrder:2,writeAccepted:stamp(12),drained:stamp(12),tokensAfter:0},
   {kind:'write',direction:'download',connectionId:'a',era:0,bytes:1024,enqueued:stamp(0),enqueueOrder:1,writeAccepted:stamp(10),drained:stamp(10),tokensAfter:0}]};
 return ledger;
}
test('schedule validation requires actual drained target bytes; config, timing, aggregate and cleanup mismatches remain insufficient',()=>{
 const ledger=ledgerFixture(),proof=validateProxyLedger(ledger);assert.equal(proof.scheduleProven,true);assert.equal(proof.networkCalibrated,false);assert.equal(proof.physicalPropagationRtt,false);
 for(const kind of ['early','rate','wrong-counter','token','foreign','lost','cleanup','unknown','duplicate-era']){
  const value=structuredClone(ledger);
  if(kind==='early')value.rows[0].writeAccepted.monotonicMs=9;
  if(kind==='rate')value.rows[1].writeAccepted.monotonicMs=10;
  if(kind==='wrong-counter')value.connections[0].uploadBytes++;
  if(kind==='token')value.rows[1].tokensAfter=1;
  if(kind==='foreign')value.rows[0].connectionId='b';
  if(kind==='lost')value.dropped++;
  if(kind==='cleanup')value.cleanup.ownTunnelsRemaining=1;
  if(kind==='unknown')value.rows.push({...value.rows[0],direction:'unknown'});
  if(kind==='duplicate-era')value.configurations.push(structuredClone(value.configurations[0]));
  assert.equal(validateProxyLedger(value).scheduleProven,false,kind);
 }
 const empty=structuredClone(ledger);empty.connections=[];empty.rows=[];
 assert.equal(validateProxyLedger(empty).scheduleProven,false);
});

test('listener binds only loopback, refuses plaintext HTTP, and closes idempotently without calling any remote host',async()=>{
 const handle=await startBlindConnectShaper();assert.equal(handle.address.address,'127.0.0.1');
 const status=await new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:handle.address.port,path:'/'},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));}).once('error',reject);});
 assert.equal(status,405);const first=handle.close(),second=handle.close();assert.equal(first,second);const ledger=await first;
 assert.equal(ledger.closed,true);assert.deepEqual(ledger.cleanup,{listenerClosed:true,ownTunnelsRemaining:0,queuedBytes:0});
 assert.equal(validateProxyLedger(ledger).scheduleProven,false,'an empty local listener is not actual calibration');
});

test('zero-payload passthrough connections cannot grow metadata beyond the unified bound',async()=>{
 const upstream=net.createServer(socket=>socket.resume());await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const handle=await startBlindConnectShaper({maxLedgerRows:100,connectSocket:()=>net.connect({host:'127.0.0.1',port:upstream.address().port})});
 try{for(let i=0;i<101;i++)await new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:handle.address.port,method:'CONNECT',path:'127.0.0.1:443'});
  req.once('connect',(_res,socket)=>{socket.once('close',resolve);socket.destroy();});req.once('response',res=>{res.resume();res.once('end',resolve);});req.once('error',reject);req.end();
 });}finally{await handle.close();await new Promise(resolve=>upstream.close(resolve));}
 assert.equal(handle.ledger.overflow,true);assert.equal(handle.ledger.dropped,1);assert.equal(handle.ledger.rows.length,0);
 assert.ok(['connections','errors','rows','configurations'].reduce((n,k)=>n+handle.ledger[k].length,0)<=100);
 assert.equal(validateProxyLedger(handle.ledger).scheduleProven,false);
});

test('bounded JSON upload plan uses exact unknown routes and no extra business endpoint',()=>{
 const plan=calibrationPlan(nonce);assert.equal(plan.totalUploadCapBytes,196608);assert.equal(plan.uploads.length,3);
 for(const row of plan.uploads){assert.equal(row.body.length,65536);assert.equal(sha(row.body),plan.uploadSha256);
  assert.deepEqual(Object.keys(JSON.parse(row.body)),['nonce','padding']);assert.match(new URL(row.url).pathname,/^\/api\/__qa-net-[a-f0-9]{32}$/);}
 assert.equal(new Set(plan.uploads.map(row=>row.url)).size,3);assert.throws(()=>calibrationPlan('non-hex'),/CALIBRATION_HEX_NONCE_REQUIRED/);
 assert.throws(()=>shaperConfiguration({uploadDelayMs:51}),/SHAPER_ADDED_DELAY_BOUND/);
});

test('baseline above target cannot be reduced; root cleanup failure still closes proxy and no fixture claims calibration',async()=>{
 const calls=[];let count=0;
 const shaper={setConfiguration:async configuration=>calls.push(configuration.profile),close:async()=>{calls.push('proxy-close');return ledgerFixture();}};
 const report=await collectQaNetworkCalibration({shaper,scope,profile:'wifi',nonce,readRootState:async()=>({actualKeysPending:true}),
  cleanupRoot:async()=>{calls.push('root-cleanup');throw Error('original-settings-not-restored');},sourceReceipt:{actualSourcePending:true},
  measuredDelayConfiguration:{uploadDelayMs:0,downloadDelayMs:0},request:async options=>{
   count++;const responseBody=options.kind==='upload'?Buffer.from('{"error":{"code":"NOT_FOUND","message":"NOT_FOUND"}}'):Buffer.from('{"environment":"production","status":"ok"}');
   return {schema:'android-qa-calibration-request-v1',scope,url:options.url,method:options.method,requestId:'synthetic-unit-'+count,
    clockScope:'owned-WebView-performance',startedMonotonicMs:count*100,finishedMonotonicMs:count*100+51,
    redirected:false,fromDiskCache:false,fromServiceWorker:false,fromPrefetchCache:false,tlsVerified:true,
    requestBodyBytes:options.body?.length??0,requestBodySha256:sha(options.body??Buffer.alloc(0)),status:options.kind==='upload'?404:200,responseBody,proxyEvidence:{syntheticUnitPending:true}};
  }});
 assert.equal(count,3);assert.deepEqual(calls,['baseline','root-cleanup','proxy-close']);
 assert.equal(report.baselineRoundTripMs,51);assert.equal(report.networkCalibrated,false);assert.equal(report.status,'insufficient');
 assert.ok(report.errors.some(row=>row.code==='CALIBRATION_BASELINE_EXCEEDS_TARGET_CANNOT_REDUCE'));
 assert.deepEqual(report.cleanup.map(row=>row.passed),[false,true]);
 assert.equal(report.rows.filter(row=>row.kind==='upload').reduce((n,row)=>n+row.requestBodyBytes,0),0,'an impossible target does not send unnecessary upload probes');
 assert.ok(report.rows.every(row=>!Object.hasOwn(row,'responseBody')),'raw TLS/application response bytes do not enter ledger/report');
});

async function completeDraftFixture(){
 const manifestBytes=await readFile(new URL('../review/firstparty-release-20261010/root-package08-preparation-016xki9t/release-20261011-01.tar.gz.manifest.json',import.meta.url));
 const sourceFiles={};for(const path of Object.keys(QA_CALIBRATION_SOURCE.files))sourceFiles[path]=await readFile(new URL('../../'+path,import.meta.url));
 const sourceReceipt=qaCalibrationSourceReceipt({manifestBytes,sourceFiles});
 const preview=await readFile(new URL('../public/previews/carrom.webm',import.meta.url));
 let time=0,count=0,active=0,maxActive=0,totalUploadBytes=0,windowCalled=0;
 const configuration=ledgerFixture().configurations[0].configuration;
 const ledger=ledgerFixture();ledger.rows=[];ledger.connections=[];ledger.configurations=[];
 const configurationForPhase={baseline:shaperConfiguration({profile:'baseline',burstBytes:1024,maxQueuedBytes:2048}),wifi:configuration};
 for(const [era,phase,start,end]of [[0,'baseline',-1,150],[1,'wifi',150,3000]]){
  const config=configurationForPhase[phase];ledger.configurations.push({era,configuration:config,sha256:shaperConfigurationSha256(config),started:stamp(start),finished:stamp(end)});
  ledger.connections.push({id:'fixture-'+phase,era,host:new URL(QA_NETWORK_ORIGIN).hostname,port:443,target:true,routeChanged:true,uploadBytes:0,downloadBytes:0,closed:true});
 }
 const counters=new Map();
 const writeBytes=(phase,direction,bytes,start)=>{
  const era=phase==='baseline'?0:1,config=configurationForPhase[phase],c=ledger.connections[era],rate=config[direction==='upload'?'uploadBytesPerSecond':'downloadBytesPerSecond'];
  const key=phase+direction,state=counters.get(key)??{tokens:1024,last:ledger.configurations[era].started.monotonicMs,order:0};let at=start+config[direction+'DelayMs'];
  while(bytes){const part=Math.min(bytes,1024);state.tokens=rate===null?1024:Math.min(1024,state.tokens+(at-state.last)*rate/1000);
   state.last=at;if(rate!==null&&state.tokens<part){at+=(part-state.tokens)*1000/rate;state.tokens=part;state.last=at;}
   state.tokens-=part;ledger.rows.push({kind:'write',direction,connectionId:c.id,era,bytes:part,enqueued:stamp(start),enqueueOrder:++state.order,writeAccepted:stamp(at),drained:stamp(at),tokensAfter:rate===null?null:state.tokens});
   c[direction+'Bytes']+=part;bytes-=part;
  }counters.set(key,state);
 };
 const shaper={setConfiguration:async()=>{},close:async()=>ledger};
 const report=await collectQaNetworkCalibration({shaper,scope,nonce,sourceReceipt,measuredDelayConfiguration:configuration,
  readRootState:async()=>({syntheticUnitObservation:true}),cleanupRoot:async()=>({syntheticUnitCleanup:true}),
  runControlledWindow:async()=>{windowCalled++;return {syntheticUnitWindow:true};},request:async options=>{
   active++;maxActive=Math.max(active,maxActive);await Promise.resolve();count++;
   totalUploadBytes+=options.body?.length??0;
   const responseBody=options.kind==='preview'?preview:options.kind==='upload'?Buffer.from('{"error":{"code":"NOT_FOUND","message":"NOT_FOUND"}}'):Buffer.from('{"environment":"production","status":"ok"}');
   const started=time;time+=options.kind==='health'?(options.phase==='baseline'?10:50):options.kind==='preview'?1300:120;active--;
   writeBytes(options.phase,'upload',options.body?.length??64,started);writeBytes(options.phase,'download',responseBody.length+128,started);
   const era=options.phase==='baseline'?0:1,proxyEvidence={schema:'android-qa-request-proxy-interval-v1',requestId:'synthetic-only-'+count,clockDomain:'Mac-host-hrtime-ms',
    era,configurationSha256:ledger.configurations[era].sha256,before:stamp(started),after:stamp(time),targetConnectionIds:[ledger.connections[era].id],
    originalEvidenceSha256:'e'.repeat(64),cdpEncodedDataLength:responseBody.length+128,requestContentEncoding:'identity',responseContentEncoding:'identity'};
   return {schema:'android-qa-calibration-request-v1',scope,url:options.url,method:options.method,requestId:'synthetic-only-'+count,
    clockScope:'owned-WebView-performance',startedMonotonicMs:started,finishedMonotonicMs:time,
    redirected:false,fromDiskCache:false,fromServiceWorker:false,fromPrefetchCache:false,tlsVerified:true,
    requestBodyBytes:options.body?.length??0,requestBodySha256:sha(options.body??Buffer.alloc(0)),status:options.kind==='upload'?404:200,responseBody,proxyEvidence};
  }});
 return {report,sourceReceipt,manifestBytes,sourceFiles,maxActive,totalUploadBytes,windowCalled};
}
test('complete typed calibration consumes the pinned local preview, only three serial uploads and a Root window hook; it is still pending until independently analyzed',async()=>{
 const f=await completeDraftFixture();assert.equal(f.maxActive,1);assert.equal(f.totalUploadBytes,196608);assert.equal(f.windowCalled,1);
 assert.equal(f.report.rows.length,10);assert.equal(f.report.status,'measurements-collected-calibration-pending',JSON.stringify({errors:f.report.errors,cleanup:f.report.cleanup,transfers:f.report.proxyTransfersProof}));assert.equal(f.report.networkCalibrated,false);
 assert.equal(f.report.rows.find(row=>row.kind==='preview').responseBodyBytes,3144937);
 const changed=Buffer.from(f.sourceFiles['platform/server/index.mjs']);changed[0]^=1;
 assert.throws(()=>qaCalibrationSourceReceipt({manifestBytes:f.manifestBytes,sourceFiles:{...f.sourceFiles,'platform/server/index.mjs':changed}}),/CALIBRATION_SOURCE_BODY_CHANGED/);
});

function environmentProof(){
 const keys=['http_proxy','global_http_proxy_host','global_http_proxy_port','global_http_proxy_exclusion_list','global_proxy_pac_url'].map(name=>({name,present:false,value:null}));
 return {schema:'android-root-owned-proxy-environment-v1',scope,clockDomain:'Mac-host-hrtime-ms',
  source:{release:QA_CALIBRATION_SOURCE.release,manifestSha256:QA_CALIBRATION_SOURCE.manifestSha256,sourceCommit:QA_CALIBRATION_SOURCE.sourceCommit},
  macProxyPort:40000,deviceProxyPort:40100,proxyPid:123,sampleInterval:{startMs:2000,endMs:2800},
  observations:['before','during','after'].map((phase,i)=>({phase,scope,monotonicMs:[1990,2400,2900][i],effectiveProxy:{host:'127.0.0.1',port:40100},
   ownedReverse:{serial:'46dcfd25',devicePort:40100,macPort:40000},httpProxyValue:'127.0.0.1:40100',originalEvidenceSha256:'a'.repeat(64)})),
  originalGlobalProxyKeys:keys,restoredGlobalProxyKeys:structuredClone(keys),originalReverseInventory:[],restoredReverseInventory:[],
  originalEffectiveProxy:null,restoredEffectiveProxy:null,cleanupOriginalEvidenceSha256:'b'.repeat(64)};
}
test('formal hook accepts independently supplied measured RTT bounds and complete Root proof; out-of-range/missing/tampered evidence cannot flip the network gate',async()=>{
 const f=await completeDraftFixture(),input={calibration:f.report,sourceReceipt:f.sourceReceipt,rootProof:environmentProof(),
  rttCalibration:{schema:'android-controlled-rtt-measurement-bounds-v1',profile:'wifi',targetMs:50,lowerMs:49,upperMs:51,
   basis:'independent-measurement-error',clockPrecisionMs:0.1,procedure:'SYNTHETIC UNIT FIXTURE of an independently supplied measurement-error procedure, never a live-device receipt',originalEvidenceSha256:'c'.repeat(64)}};
 const proof=analyzeQaNetworkCalibration(input);assert.equal(proof.networkCalibrated,true,proof.reasons.join(','));assert.equal(proof.physicalPropagationRtt,false);
 assert.deepEqual(proof.actualHealthRoundTripMs,[50,50,50]);
 for(const kind of ['lower','upper','no-bounds-source','wrong-original-source','wrong-upload','cache','restore','era','no-during','scope']){
  const value=structuredClone(input);
  if(kind==='lower'){value.calibration.rows[7].elapsedMs=48;value.calibration.rows[7].finishedMonotonicMs=value.calibration.rows[7].startedMonotonicMs+48;}
  if(kind==='upper'){value.calibration.rows[9].elapsedMs=52;value.calibration.rows[9].finishedMonotonicMs=value.calibration.rows[9].startedMonotonicMs+52;}
  if(kind==='no-bounds-source')delete value.rttCalibration.originalEvidenceSha256;
  if(kind==='wrong-original-source')value.sourceReceipt.files['platform/server/index.mjs'].sha256='d'.repeat(64);
  if(kind==='wrong-upload')value.calibration.rows[3].requestBodySha256='d'.repeat(64);
  if(kind==='cache')value.calibration.rows[4].fromDiskCache=true;
  if(kind==='restore')value.rootProof.restoredGlobalProxyKeys[0].present=true;
  if(kind==='era')value.calibration.proxyLedger.configurations[1].finished.monotonicMs=2899;
  if(kind==='no-during')value.rootProof.observations.splice(1,1);
  if(kind==='scope')value.rootProof.scope.uid=1010416;
  assert.equal(analyzeQaNetworkCalibration(value).networkCalibrated,false,kind);
 }
});

test('complete application bodies require enough target ciphertext inside their own configuration and request intervals',async()=>{
 const f=await completeDraftFixture(),input={calibration:f.report,sourceReceipt:f.sourceReceipt,rootProof:environmentProof(),
  rttCalibration:{schema:'android-controlled-rtt-measurement-bounds-v1',profile:'wifi',targetMs:50,lowerMs:49,upperMs:51,
   basis:'independent-measurement-error',clockPrecisionMs:0.1,procedure:'SYNTHETIC measured-error fixture',originalEvidenceSha256:'c'.repeat(64)}};
 assert.equal(analyzeQaNetworkCalibration(input).networkCalibrated,true);
 for(const kind of ['tiny-target','other-host-bytes','wrong-era','outside-interval','compressed','encoded-too-small','encoded-too-large']){
  const value=structuredClone(input);
  if(kind==='tiny-target'||kind==='other-host-bytes'){
   // A valid tiny scheduler ledger is not evidence for the 3MB application body.
   const tiny=value.calibration.proxyLedger;
   for(const e of tiny.configurations)for(const direction of ['upload','download']){
    const rate=e.configuration[direction==='upload'?'uploadBytesPerSecond':'downloadBytesPerSecond'];let tokens=1024,last=e.started.monotonicMs;
    for(const r of tiny.rows.filter(r=>r.era===e.era&&r.direction===direction)){
     r.bytes=1;if(rate!==null){tokens=Math.min(1024,tokens+(r.writeAccepted.monotonicMs-last)*rate/1000)-1;r.tokensAfter=tokens;}else r.tokensAfter=null;
     last=r.writeAccepted.monotonicMs;
    }
   }
   for(const c of tiny.connections)for(const d of ['upload','download'])c[d+'Bytes']=tiny.rows.filter(r=>r.connectionId===c.id&&r.direction===d).reduce((n,r)=>n+r.bytes,0);
   if(kind==='other-host-bytes')tiny.connections.push({id:'unrelated',era:1,host:'example.org',port:443,target:false,routeChanged:true,uploadBytes:196608,downloadBytes:3144937,closed:true});
   assert.equal(validateProxyLedger(tiny).scheduleProven,true);
  }
  if(kind==='wrong-era')value.calibration.rows[4].proxyEvidence.era=0;
  if(kind==='outside-interval')value.calibration.rows[4].proxyEvidence.before.monotonicMs+=1299;
  if(kind==='compressed')value.calibration.rows[4].proxyEvidence.responseContentEncoding='gzip';
  if(kind==='encoded-too-small')value.calibration.rows[4].proxyEvidence.cdpEncodedDataLength=1024;
  if(kind==='encoded-too-large')value.calibration.rows[4].proxyEvidence.cdpEncodedDataLength=10000000;
  const result=analyzeQaNetworkCalibration(value);assert.equal(result.networkCalibrated,false,kind);
  if(kind==='tiny-target'||kind==='other-host-bytes'||kind==='encoded-too-large')assert.match(result.reasons.join(','),/CALIBRATION_TARGET_ENCODED_DOWNLOAD_BYTES_TOO_SMALL/);
 }
});
