/** Local blind CONNECT preparation. No Android settings, ADB, MITM, CDP rule,
 * server change or performance-gate update. Ciphertext is forwarded, never
 * decoded, hashed or retained. The caller exclusively owns real-phone setup.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const hash=value=>createHash('sha256').update(value).digest('hex');
const clone=value=>structuredClone(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
export const shaperClock=()=>({monotonicMs:Number(process.hrtime.bigint())/1e6,epochMs:Date.now()});
const now=shaperClock;
const errorCode=error=>error.code&&error.code!=='ERR_ASSERTION'?error.code:error.message;
export const QA_NETWORK_ORIGIN='https://oasis-player.43.98.202.236.sslip.io';
export const QA_PREVIEW=Object.freeze({path:'/previews/carrom.webm',bytes:3144937,
 sha256:'f36dda4bcb1baed0d77ec324507617783a5e7fc5aca4b83a9d39b3660fc874ba'});
export const SHAPER_PROFILES=Object.freeze({
 baseline:Object.freeze({downloadBytesPerSecond:null,uploadBytesPerSecond:null,targetRoundTripMs:null}),
 wifi:Object.freeze({downloadBytesPerSecond:2500000,uploadBytesPerSecond:625000,targetRoundTripMs:50}),
 weak:Object.freeze({downloadBytesPerSecond:500000,uploadBytesPerSecond:125000,targetRoundTripMs:150}),
});
export const QA_CALIBRATION_SOURCE=Object.freeze({release:'/opt/oasis/releases/20261011-01',
 manifestSha256:'960c380ac39a2083edbce269467ec497af70146e99f555a909a9a769e3b3f708',
 sourceCommit:'877ede391fab75dfd7293c9e3f6dc3e8aae9bdd8',
 files:Object.freeze({
  'platform/server/index.mjs':'7df0bca77ef21fa88f7ce94b365320d0dac2e593f15f3cf6f437545e72b667f3',
  'platform/server/security.mjs':'20b83d7852a3852c9274152f342d8503f3db709f0fd9cf6a46dab7b43548438f',
  'platform/server/player-routes.mjs':'f0736a30415d864e401bbc497a28005a51f1560ee68668d4a069af7424099039',
  'platform/server/request-timing.mjs':'ebcb6a9e14dc6f9625782daf0873343cdb4d570c288f3b0db20bc0f8775ba4e5',
  'platform/deploy/production-ingress.py':'2edec7bb341b1f440fb5c3f246fa7ba28caeeea95540fe1cbfe0698c0a10a2c3',
 }),notFound:Object.freeze({bytes:52,sha256:'25f169010390e1601e36cbf51501ebd84b050cd8c0c27cb3a6c92c286326a5c7'}),
});

/** The caller supplies original deployed manifest/helper bytes; this does not
 * read a server. Fixed raw bodies pin the independently reviewed readBody→404
 * path, including UTF8 JSON-object/65536-byte/no-content-encoding constraints.
 * This receipt proves source semantics, not an observed remote response. */
export function qaCalibrationSourceReceipt({manifestBytes,sourceFiles}){
 assert.ok(Buffer.isBuffer(manifestBytes));assert.equal(hash(manifestBytes),QA_CALIBRATION_SOURCE.manifestSha256,'CALIBRATION_MANIFEST_CHANGED');
 const manifest=JSON.parse(manifestBytes),files={};
 assert.ok(Object.keys(sourceFiles).sort().join(',')===Object.keys(QA_CALIBRATION_SOURCE.files).sort().join(','),'CALIBRATION_SOURCE_FILES_CHANGED');
 for(const [path,expected]of Object.entries(QA_CALIBRATION_SOURCE.files)){
  assert.ok(Buffer.isBuffer(sourceFiles[path]));assert.equal(hash(sourceFiles[path]),expected,'CALIBRATION_SOURCE_BODY_CHANGED');
  assert.equal(manifest[path],expected,'CALIBRATION_SOURCE_MANIFEST_PIN_CHANGED');files[path]={bytes:sourceFiles[path].length,sha256:expected};
 }
 return {schema:'android-qa-calibration-source-v1',release:QA_CALIBRATION_SOURCE.release,
  manifestSha256:hash(manifestBytes),sourceCommit:QA_CALIBRATION_SOURCE.sourceCommit,files,
  bodyContract:'complete-UTF8-JSON-object-at-most-65536-bytes-no-Content-Encoding-before-NOT_FOUND',
  unknownPathPrefix:'/api/__qa-net-',notFound:clone(QA_CALIBRATION_SOURCE.notFound),serverBodyShaEcho:false,
  sourceAnalysis:'index:99,144/security:32-40/player-routes:22/request-timing:10,19/ingress:212',
 };
}
const DIRECTIONS=['upload','download'];
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export const shaperConfigurationSha256=configuration=>hash(canonical(configuration));

export function shaperConfiguration({profile='wifi',uploadDelayMs=0,downloadDelayMs=0,
 burstBytes=16384,maxQueuedBytes=2097152,maxConnections=16}={}){
 assert.ok(Object.hasOwn(SHAPER_PROFILES,profile),'SHAPER_PROFILE_REQUIRED');
 const selected=SHAPER_PROFILES[profile];
 for(const delay of [uploadDelayMs,downloadDelayMs])assert.ok(finite(delay)&&delay>=0&&delay<=150,'SHAPER_DELAY_BOUND');
 assert.ok(uploadDelayMs+downloadDelayMs<=(selected.targetRoundTripMs??0),'SHAPER_ADDED_DELAY_BOUND');
 assert.ok(Number.isSafeInteger(burstBytes)&&burstBytes>=1024&&burstBytes<=16384,'SHAPER_BURST_BOUND');
 assert.ok(Number.isSafeInteger(maxQueuedBytes)&&maxQueuedBytes>=burstBytes&&maxQueuedBytes<=2097152,'SHAPER_QUEUE_BOUND');
 assert.ok(Number.isSafeInteger(maxConnections)&&maxConnections>=1&&maxConnections<=16,'SHAPER_CONNECTION_BOUND');
 return {profile,targetHost:new URL(QA_NETWORK_ORIGIN).hostname,targetPort:443,...selected,
  uploadDelayMs,downloadDelayMs,burstBytes,maxQueuedBytes,maxConnections,
  byteBoundary:'opaque-ciphertext-accepted-by-proxy-write',rateScope:'target-host-aggregate-all-connections',
  delayScope:'each-chunk-enqueue-to-proxy-write-minimum',otherHttpsHosts:'unshaped-CONNECT-Mac-route',
  plainHttp:'unsupported-405',physicalPropagationRtt:false};
}

/** One FIFO per host/direction. Refilling is monotonic; the burst is bounded.
 * A blocked destination holds the head and backpressures every owning source.
 * Delay is an eligibility deadline, not a sleep repeated after rate limiting.
 */
export class AggregateByteQueue{
 constructor({direction,rateBytesPerSecond,delayMs,burstBytes,maxQueuedBytes,clock=now,
  wait=(ms,signal)=>sleep(ms,undefined,{signal}),record=()=>{}}){
  assert.ok(DIRECTIONS.includes(direction));assert.ok(rateBytesPerSecond===null||(finite(rateBytesPerSecond)&&rateBytesPerSecond>0));
  assert.ok(finite(delayMs)&&delayMs>=0&&Number.isSafeInteger(burstBytes)&&burstBytes>0&&maxQueuedBytes>=burstBytes);
  Object.assign(this,{direction,rateBytesPerSecond,delayMs,burstBytes,maxQueuedBytes,clock,wait,record});
  this.jobs=[];this.queuedBytes=0;this.sequence=0;this.tokens=burstBytes;this.last=this.time();this.abort=new AbortController();this.closed=false;
 }
 time(){const value=this.clock();assert.ok(finite(value?.monotonicMs)&&finite(value?.epochMs),'SHAPER_CLOCK_REQUIRED');
  if(this.observedMonotonicMs!==undefined)assert.ok(value.monotonicMs>=this.observedMonotonicMs,'SHAPER_CLOCK_REGRESSED');
  this.observedMonotonicMs=value.monotonicMs;return clone(value);}
 enqueue(buffer,connectionId,deliver,receivedAt){
  assert.ok(Buffer.isBuffer(buffer)&&buffer.length>0&&buffer.length<=this.burstBytes,'SHAPER_CHUNK_BOUND');
  assert.equal(typeof deliver,'function');assert.equal(this.closed,false,'SHAPER_QUEUE_CLOSED');
  assert.ok(this.queuedBytes+buffer.length<=this.maxQueuedBytes,'SHAPER_QUEUE_OVERFLOW');
  const observed=this.time(),enqueued=receivedAt??observed;
  assert.ok(finite(enqueued?.monotonicMs)&&finite(enqueued?.epochMs)&&enqueued.monotonicMs<=observed.monotonicMs,'SHAPER_INGRESS_CLOCK_REQUIRED');
  this.queuedBytes+=buffer.length;
  const enqueueOrder=++this.sequence;
  const result=new Promise((resolve,reject)=>this.jobs.push({buffer,connectionId,deliver,enqueued,enqueueOrder,resolve,reject}));
  this.start();return result;
 }
 start(){if(!this.running)this.running=this.pump().finally(()=>{
  this.running=null;if(this.jobs.length&&!this.closed)this.start();
 });
 }
 async pump(){
  try{while(this.jobs.length&&!this.closed){
   const job=this.jobs[0];let at;
   for(;;){
    at=this.time();const delta=at.monotonicMs-this.last.monotonicMs;
    if(this.rateBytesPerSecond!==null)this.tokens=Math.min(this.burstBytes,this.tokens+delta*this.rateBytesPerSecond/1000);
    this.last=at;
    const eligible=job.enqueued.monotonicMs+this.delayMs;
    const tokenWait=this.rateBytesPerSecond===null?0:Math.max(0,(job.buffer.length-this.tokens)*1000/this.rateBytesPerSecond);
    const pause=Math.max(0,eligible-at.monotonicMs,tokenWait);
    if(pause<=0.000001)break;
    await this.wait(pause,this.abort.signal);
   }
   if(this.rateBytesPerSecond!==null)this.tokens=Math.max(0,this.tokens-job.buffer.length);
   const row={kind:'write',direction:this.direction,connectionId:job.connectionId,bytes:job.buffer.length,
    enqueued:job.enqueued,enqueueOrder:job.enqueueOrder,writeAccepted:at,tokensAfter:this.rateBytesPerSecond===null?null:this.tokens};
   try{await job.deliver(job.buffer);row.drained=this.time();this.record(row);job.resolve();}
   catch(error){job.reject(error);row.error=errorCode(error);try{this.record(row);}catch{}throw error;}
   finally{this.jobs.shift();this.queuedBytes-=job.buffer.length;}
  }}catch(error){this.failure=error;this.closed=true;this.abort.abort();
   for(const job of this.jobs)job.reject(error);this.jobs=[];this.queuedBytes=0;
   try{this.record({kind:'queue-error',direction:this.direction,code:errorCode(error)});}catch{}
  }
 }
 async close(){this.closed=true;this.abort.abort();const error=Error('SHAPER_QUEUE_CLOSED');
  // The active pump owns its head until a pending drain/sleep settles.
  for(const job of this.jobs)job.reject(error);
  await this.running;this.jobs=[];this.queuedBytes=0;
 }
}

function socketWrite(socket,buffer){
 return new Promise((resolve,reject)=>{
  if(socket.destroyed)return reject(Error('SHAPER_DESTINATION_CLOSED'));
  let timer;const cleanup=()=>{clearTimeout(timer);socket.off('error',error);socket.off('close',closed);socket.off('drain',drain);};
  const error=value=>{cleanup();reject(value);},closed=()=>error(Error('SHAPER_DESTINATION_CLOSED')),drain=()=>{cleanup();resolve();};
  socket.once('error',error);socket.once('close',closed);
  try{if(socket.write(buffer)){cleanup();resolve();}else{socket.once('drain',drain);timer=setTimeout(()=>error(Error('SHAPER_DRAIN_TIMEOUT')),30000);}}
  catch(value){error(value);}
 });
}

export async function startBlindConnectShaper({port=0,configuration=shaperConfiguration(),clock=now,maxLedgerRows=300000,connectSocket=options=>net.connect(options)}={}){
 assert.ok(Number.isSafeInteger(port)&&port>=0&&port<=65535,'SHAPER_PORT_BOUND');
 assert.deepEqual(configuration,shaperConfiguration(configuration),'SHAPER_CONFIGURATION_CHANGED');
 assert.ok(Number.isSafeInteger(maxLedgerRows)&&maxLedgerRows>=100&&maxLedgerRows<=300000,'SHAPER_LEDGER_BOUND');
 const ledger={schema:'android-blind-connect-ledger-v1',clockDomain:'Mac-host-hrtime-ms',process:{pid:process.pid,started:clock()},listenHost:'127.0.0.1',
  configurations:[],connections:[],rows:[],errors:[],maxLedgerEntries:maxLedgerRows,overflow:false,dropped:0,closed:false,networkCalibrated:false,
  limitations:['Global Android HTTP proxy is not UID isolated','Other HTTPS hosts also traverse the Mac route',
   'Proxy write timestamps are not TCP wire, physical propagation or panel timing','Plain HTTP is refused with 405']};
 let era=0,closing,stopping=false,queues,active=new Map(),sequence=0;
 const append=(collection,row)=>{
  if(ledger.overflow||['rows','connections','errors','configurations'].reduce((n,key)=>n+ledger[key].length,0)>=maxLedgerRows){
   ledger.overflow=true;ledger.dropped=1;stopping=true;throw Error('SHAPER_LEDGER_OVERFLOW');
  }
  ledger[collection].push(row);
 };
 const record=row=>append('rows',{...clone(row),era});
 const install=()=>{const started=clock();append('configurations',{era,configuration:clone(configuration),sha256:shaperConfigurationSha256(configuration),started});
  queues=Object.fromEntries(DIRECTIONS.map(direction=>[direction,new AggregateByteQueue({direction,
   rateBytesPerSecond:configuration[direction==='upload'?'uploadBytesPerSecond':'downloadBytesPerSecond'],
   delayMs:configuration[direction+'DelayMs'],burstBytes:configuration.burstBytes,maxQueuedBytes:configuration.maxQueuedBytes,clock,record})]));};
 install();
 const server=http.createServer((req,res)=>{res.writeHead(405,{'content-length':'0','connection':'close'});res.end();});
 server.on('clientError',(_error,socket)=>socket.destroy());
 server.on('connect',(req,client,head)=>{
  let authority;
  try{authority=new URL('http://'+req.url);assert.equal(authority.username,'');assert.equal(authority.password,'');
   assert.equal(authority.pathname,'/');assert.equal(authority.search,'');assert.equal(authority.hash,'');assert.equal(authority.port,'443');
   assert.ok(authority.hostname&&!req.url.includes('/'),'SHAPER_CONNECT_AUTHORITY');
   assert.ok(!stopping&&active.size<configuration.maxConnections,'SHAPER_CONNECTION_OVERFLOW');
  }catch{client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');return;}
  const id='tunnel-'+(++sequence),target=authority.hostname===configuration.targetHost;
  const row={id,era,host:authority.hostname,port:443,target,routeChanged:true,opened:clock(),uploadBytes:0,downloadBytes:0,closed:false};
  try{append('connections',row);}catch{client.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');return;}client.pause();
  const upstream=connectSocket({host:authority.hostname,port:443,allowHalfOpen:true});active.set(id,{client,upstream,target});
  upstream.setTimeout(30000);upstream.on('timeout',()=>upstream.destroy(Error('SHAPER_CONNECT_OR_IDLE_TIMEOUT')));
  const fail=error=>{if(!row.error){row.error=errorCode(error);try{append('errors',{connectionId:id,code:row.error});}catch{}}
   client.destroy();upstream.destroy();};
  client.on('error',fail);upstream.on('error',fail);
  const close=()=>{if(!row.closed){row.closed=true;row.finished=clock();active.delete(id);}client.destroy();upstream.destroy();};
  client.once('close',close);upstream.once('close',close);
  upstream.once('connect',()=>{
   if(stopping||client.destroyed)return close();
   upstream.setTimeout(0);client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
   const forward=(source,destination,direction,initial)=>{
    let chain=Promise.resolve();
    const consume=buffer=>{source.pause();const receivedAt=clock();row[direction+'Bytes']+=buffer.length;
     chain=chain.then(async()=>{
      if(target){const pending=[];
       try{for(let offset=0;offset<buffer.length;offset+=configuration.burstBytes){const chunk=buffer.subarray(offset,offset+configuration.burstBytes);
        pending.push(queues[direction].enqueue(chunk,id,value=>socketWrite(destination,value),receivedAt));}}
       catch(error){await Promise.allSettled(pending);throw error;}
       await Promise.all(pending);}
      else await socketWrite(destination,buffer);
     }).then(()=>{if(!source.destroyed)source.resume();}).catch(fail);
    };
    source.on('data',consume);source.once('end',()=>{chain.then(()=>{if(!destination.destroyed)destination.end();}).catch(fail);});
    if(initial?.length)consume(initial);else source.resume();
   };
   forward(client,upstream,'upload',head);forward(upstream,client,'download');
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port},()=>{server.off('error',reject);resolve();});});
 ledger.listenPort=server.address().port;ledger.ready=clock();
 return {ledger,address:clone(server.address()),
  async setConfiguration(next,{calibrationRequestsComplete=false}={}){
   assert.ok(DIRECTIONS.every(d=>!queues[d].queuedBytes),'SHAPER_PROFILE_HAS_PENDING_BYTES');
   // Other hosts stay on their independent passthrough sockets. A completed
   // HTTP request does not prove its target tunnel/keepalive connection closed.
   assert.equal([...active.values()].filter(connection=>connection.target).length,0,'SHAPER_PROFILE_HAS_ACTIVE_CONNECTIONS');
   assert.deepEqual(next,shaperConfiguration(next));for(const queue of Object.values(queues))await queue.close();
   ledger.configurations.at(-1).finished=clock();configuration=next;era++;install();},
  close(){return closing??=(async()=>{stopping=true;const errors=[];
   // Independent cleanup attempts: one rejection must not skip other resources.
   const attempt=async(name,work)=>{try{await work();}catch(error){errors.push({name,code:errorCode(error)});}};
   await attempt('tunnels',async()=>{await Promise.all([...active.values()].map(({client,upstream})=>new Promise(resolve=>{
    client.once('close',resolve);client.destroy();upstream.destroy();})));});
   for(const direction of DIRECTIONS)await attempt('queue-'+direction,()=>queues[direction].close());
   await attempt('listener',()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
   ledger.configurations.at(-1).finished=clock();ledger.finished=clock();ledger.cleanupErrors=errors;
   ledger.cleanup={listenerClosed:!server.listening,ownTunnelsRemaining:active.size,queuedBytes:Object.values(queues).reduce((n,q)=>n+q.queuedBytes,0)};
   ledger.closed=true;return ledger;
  })();},
 };
}

/** Validate actual aggregate scheduling without claiming decrypted HTTP/body
 * identity or that kernel buffering equals physical wire delivery. */
export function validateProxyLedger(ledger,{requireClosed=true}={}){
 const result={schema:'android-blind-connect-ledger-proof-v1',status:'insufficient',scheduleProven:false,
  networkCalibrated:false,physicalPropagationRtt:false,reasons:[]};
 try{
  assert.equal(ledger.schema,'android-blind-connect-ledger-v1');assert.equal(ledger.listenHost,'127.0.0.1');
  assert.ok(Number.isSafeInteger(ledger.listenPort)&&ledger.listenPort>0);assert.equal(ledger.dropped,0);assert.equal(ledger.overflow,false);assert.deepEqual(ledger.errors,[]);
  assert.ok(Number.isSafeInteger(ledger.maxLedgerEntries)&&ledger.maxLedgerEntries>=100&&ledger.maxLedgerEntries<=300000);
  assert.ok(['rows','connections','errors','configurations'].reduce((n,key)=>n+ledger[key].length,0)<=ledger.maxLedgerEntries,'SHAPER_LEDGER_TOTAL_BOUND');
  if(requireClosed){assert.equal(ledger.closed,true);assert.deepEqual(ledger.cleanupErrors,[]);
   assert.deepEqual(ledger.cleanup,{listenerClosed:true,ownTunnelsRemaining:0,queuedBytes:0});}
  const ids=new Map(ledger.connections.map(row=>[row.id,row]));assert.equal(ids.size,ledger.connections.length);
  assert.ok(ledger.connections.some(row=>row.target&&row.uploadBytes>0&&row.downloadBytes>0),'SHAPER_NO_ACTUAL_TARGET_TRANSFER');
  assert.ok(new Set(ledger.configurations.map(row=>row.era)).size===ledger.configurations.length,'SHAPER_DUPLICATE_ERA');
  assert.ok(ledger.rows.every(row=>row.kind==='write'&&DIRECTIONS.includes(row.direction)),'SHAPER_UNKNOWN_ROW');
  for(const connection of ledger.connections){assert.equal(connection.port,443);assert.equal(connection.routeChanged,true);
   assert.equal(connection.target,connection.host===new URL(QA_NETWORK_ORIGIN).hostname);assert.equal(connection.error,undefined);
   if(requireClosed)assert.equal(connection.closed,true);
   for(const direction of DIRECTIONS){assert.ok(Number.isSafeInteger(connection[direction+'Bytes'])&&connection[direction+'Bytes']>=0);
    if(requireClosed&&connection.target)assert.equal(ledger.rows.filter(row=>row.connectionId===connection.id&&row.direction===direction).reduce((n,row)=>n+row.bytes,0),connection[direction+'Bytes'],'SHAPER_CONNECTION_BYTES_NOT_DRAINED');}}
  for(const entry of ledger.configurations){
   const config=entry.configuration;assert.deepEqual(config,shaperConfiguration(config));assert.equal(entry.sha256,shaperConfigurationSha256(config));
   for(const direction of DIRECTIONS){let tokens=config.burstBytes,last=entry.started.monotonicMs,total=0;
    const rows=ledger.rows.filter(row=>row.era===entry.era&&row.direction===direction);
    for(const [index,row]of rows.entries()){assert.equal(row.kind,'write','SHAPER_QUEUE_ERROR');assert.equal(row.error,undefined);
     assert.equal(row.enqueueOrder,index+1,'SHAPER_FIFO_ORDER_OR_MISSING_ROW');
     const connection=ids.get(row.connectionId);assert.ok(connection?.target&&connection.era===entry.era,'SHAPER_FOREIGN_SCHEDULE');
     assert.ok(Number.isSafeInteger(row.bytes)&&row.bytes>0&&row.bytes<=config.burstBytes);
     for(const time of [row.enqueued,row.writeAccepted,row.drained])assert.ok(finite(time?.monotonicMs)&&finite(time?.epochMs),'SHAPER_CLOCK_REQUIRED');
     assert.ok(row.enqueued.monotonicMs>=entry.started.monotonicMs&&row.writeAccepted.monotonicMs>=last
      &&row.writeAccepted.monotonicMs+0.000001>=row.enqueued.monotonicMs+config[direction+'DelayMs']
      &&row.drained.monotonicMs>=row.writeAccepted.monotonicMs,'SHAPER_CLOCK_OR_DELAY_CHANGED');
     if(requireClosed)assert.ok(finite(entry.finished?.monotonicMs)&&row.drained.monotonicMs<=entry.finished.monotonicMs,'SHAPER_WRITE_OUTSIDE_ERA');
     const rate=config[direction==='upload'?'uploadBytesPerSecond':'downloadBytesPerSecond'];
     if(rate!==null){tokens=Math.min(config.burstBytes,tokens+(row.writeAccepted.monotonicMs-last)*rate/1000);
      assert.ok(tokens+0.0001>=row.bytes,'SHAPER_AGGREGATE_RATE_EXCEEDED');tokens=Math.max(0,tokens-row.bytes);
      assert.ok(Math.abs(tokens-row.tokensAfter)<0.0001,'SHAPER_TOKEN_LEDGER_CHANGED');}
     else assert.equal(row.tokensAfter,null);
     last=row.writeAccepted.monotonicMs;total+=row.bytes;
    }
    if(requireClosed)assert.equal(total,ledger.connections.filter(row=>row.era===entry.era&&row.target).reduce((n,row)=>n+row[direction+'Bytes'],0),'SHAPER_CIPHER_BYTES_NOT_DRAINED');
   }
  }
  assert.ok(ledger.rows.every(row=>ledger.configurations.some(entry=>entry.era===row.era)),'SHAPER_UNKNOWN_ERA');
  result.status='proxy-aggregate-schedule-proven';result.scheduleProven=true;
 }catch(error){result.reasons.push(error.message);}
 return result;
}

export function calibrationPlan(nonce){
 assert.match(nonce,/^[a-f0-9]{32}$/,'CALIBRATION_HEX_NONCE_REQUIRED');
 const body=Buffer.from(JSON.stringify({nonce,padding:'x'.repeat(65536-57)}));
 assert.equal(body.length,65536,'CALIBRATION_BODY_BOUND');
 return {nonce,uploadBytes:body.length,uploadSha256:hash(body),totalUploadCapBytes:196608,
  previewUrl:QA_NETWORK_ORIGIN+QA_PREVIEW.path+'?qa_net='+nonce,
  healthUrl:QA_NETWORK_ORIGIN+'/health/ready',
  uploads:[0,1,2].map(index=>({url:QA_NETWORK_ORIGIN+'/api/__qa-net-'+hash(nonce+index).slice(0,32),body}))};
}

/** These are aggregate candidate tunnels, never a claimed HTTP/2-stream or
 * CDP-connectionId-to-CONNECT identity. Root's original effective-route proof
 * and the original QA request receipts provide that separate route binding.
 * Even with that binding, too few target bytes inside a request's own era and
 * measured interval cannot prove that its complete plaintext used this shaper.
 */
export function validateCalibrationProxyTransfers(rows,ledger){
 const proof={status:'insufficient',transfersBound:false,physicalPropagationRtt:false,reasons:[]};
 try{
  assert.equal(validateProxyLedger(ledger).scheduleProven,true,'CALIBRATION_ACTUAL_PROXY_LEDGER_REQUIRED');
  let previousEnd=-Infinity;const counted=new Set();
  for(const row of rows){const p=row.proxyEvidence;
   assert.equal(p?.schema,'android-qa-request-proxy-interval-v1','CALIBRATION_PROXY_REQUEST_INTERVAL_REQUIRED');
   assert.equal(p.requestId,row.requestId);assert.equal(p.clockDomain,ledger.clockDomain);
   assert.match(p.originalEvidenceSha256??'',/^[a-f0-9]{64}$/,'CALIBRATION_PROXY_ORIGINAL_RECEIPT_REQUIRED');
   const entry=ledger.configurations.find(e=>e.era===p.era);assert.ok(entry,'CALIBRATION_PROXY_UNKNOWN_REQUEST_ERA');
   assert.equal(p.configurationSha256,entry.sha256);assert.equal(entry.configuration.profile,row.phase,'CALIBRATION_PROXY_REQUEST_PROFILE_CHANGED');
   for(const at of [p.before,p.after])assert.ok(finite(at?.monotonicMs)&&finite(at?.epochMs),'CALIBRATION_PROXY_DUAL_CLOCK_REQUIRED');
   assert.ok(p.before.monotonicMs>=entry.started.monotonicMs&&p.after.monotonicMs<=entry.finished.monotonicMs
    &&p.after.monotonicMs>p.before.monotonicMs&&p.before.monotonicMs>=previousEnd,'CALIBRATION_PROXY_REQUEST_INTERVAL_CHANGED');
   previousEnd=p.after.monotonicMs;
   assert.ok(Array.isArray(p.targetConnectionIds)&&p.targetConnectionIds.length>0
    &&new Set(p.targetConnectionIds).size===p.targetConnectionIds.length,'CALIBRATION_PROXY_TARGET_CONNECTIONS_REQUIRED');
   for(const id of p.targetConnectionIds){const c=ledger.connections.find(c=>c.id===id);
    assert.ok(c?.target&&c.era===p.era&&c.host===new URL(QA_NETWORK_ORIGIN).hostname,'CALIBRATION_PROXY_FOREIGN_CONNECTION');}
   assert.ok(finite(p.cdpEncodedDataLength)&&p.cdpEncodedDataLength>0,'CALIBRATION_ORIGINAL_ENCODED_TRANSFER_REQUIRED');
   const scheduled=ledger.rows.filter(r=>r.era===p.era&&p.targetConnectionIds.includes(r.connectionId)
    &&r.enqueued.monotonicMs>=p.before.monotonicMs&&r.enqueued.monotonicMs<p.after.monotonicMs&&r.drained.monotonicMs<=p.after.monotonicMs);
   for(const r of scheduled){assert.ok(!counted.has(r),'CALIBRATION_PROXY_BYTES_REUSED');counted.add(r);}
   assert.ok(scheduled.filter(r=>r.direction==='download').reduce((n,r)=>n+r.bytes,0)>=p.cdpEncodedDataLength,'CALIBRATION_TARGET_ENCODED_DOWNLOAD_BYTES_TOO_SMALL');
   if(row.kind==='upload'){
    assert.equal(p.requestContentEncoding,'identity','CALIBRATION_COMPRESSED_UPLOAD_NOT_BOUND');
    assert.ok(scheduled.filter(r=>r.direction==='upload').reduce((n,r)=>n+r.bytes,0)>=row.requestBodyBytes,'CALIBRATION_TARGET_UPLOAD_BYTES_TOO_SMALL');
   }
   if(row.kind==='preview'){
    assert.equal(p.responseContentEncoding,'identity','CALIBRATION_COMPRESSED_PREVIEW_NOT_BOUND');
    assert.ok(p.cdpEncodedDataLength>=row.responseBodyBytes,'CALIBRATION_ENCODED_PREVIEW_BYTES_TOO_SMALL');
    assert.ok(scheduled.filter(r=>r.direction==='download').reduce((n,r)=>n+r.bytes,0)>=row.responseBodyBytes,'CALIBRATION_TARGET_PREVIEW_BYTES_TOO_SMALL');
   }
  }
  assert.equal(rows.filter(r=>r.kind==='upload').reduce((n,r)=>n+r.requestBodyBytes,0),196608,'CALIBRATION_ALL_UPLOADS_REQUIRED');
  assert.equal(rows.filter(r=>r.kind==='preview').reduce((n,r)=>n+r.responseBodyBytes,0),QA_PREVIEW.bytes,'CALIBRATION_FULL_PREVIEW_REQUIRED');
  proof.status='complete-QA-transfers-bound-to-target-aggregate-intervals';proof.transfersBound=true;
 }catch(error){proof.reasons.push(error.message);}
 return proof;
}

/** Draft driver: request() must run in the actual owned QA document and return
 * its original complete request/response receipt. This function never fetches
 * via Node or changes Android proxy/reverse settings. Baseline cannot be reduced.
 * Proof completeness is separate from calibration acceptance and the old gate.
 */
export async function collectQaNetworkCalibration({shaper,scope,profile='wifi',nonce,request,readRootState,cleanupRoot,sourceReceipt,
 measuredDelayConfiguration,maxRequestMs=30000,maxCalibrationMs=90000,runControlledWindow,maxControlledWindowMs=1800000}){
 assert.equal(typeof request,'function');assert.equal(typeof readRootState,'function');assert.equal(typeof cleanupRoot,'function');
 assert.ok(profile==='wifi'||profile==='weak');const plan=calibrationPlan(nonce),rows=[],errors=[],cleanup=[];
 assert.equal(scope?.serial,'46dcfd25');assert.equal(scope.androidUserId,0);assert.equal(scope.uid,10416);
 assert.equal(scope.packageName,'com.tianyahuyu.oasis.player.qa');assert.equal(scope.origin,QA_NETWORK_ORIGIN);
 assert.ok(Number.isSafeInteger(scope.pid)&&scope.pid>0);assert.match(scope.startTicks??'',/^[0-9]+$/);
 assert.match(scope.documentId??'',/^[a-f0-9]{32}$/);assert.ok(finite(scope.timeOrigin));assert.equal(scope.nonce,nonce);
 assert.match(scope.providerVersion??'',/^150\.[0-9]+\.[0-9]+\.[0-9]+$/);
 assert.ok(typeof scope.targetId==='string'&&scope.targetId.length>0,'CALIBRATION_OWNED_TARGET_REQUIRED');
 assert.ok(Object.keys(scope).sort().join(',')===['serial','androidUserId','uid','packageName','origin','pid','startTicks','documentId','timeOrigin','nonce','providerVersion','targetId'].sort().join(','),'CALIBRATION_SCOPE_FIELDS_CHANGED');
 assert.ok(Number.isSafeInteger(maxRequestMs)&&maxRequestMs>0&&maxRequestMs<=30000);
 assert.ok(Number.isSafeInteger(maxCalibrationMs)&&maxCalibrationMs>0&&maxCalibrationMs<=90000);
 assert.ok(runControlledWindow===undefined||typeof runControlledWindow==='function');
 assert.ok(Number.isSafeInteger(maxControlledWindowMs)&&maxControlledWindowMs>0&&maxControlledWindowMs<=3600000);
 const deadline=performance.now()+maxCalibrationMs;
 const report={schema:'android-qa-network-calibration-draft-v1',status:'pending-real-proof',networkCalibrated:false,
  physicalPropagationRtt:false,routeScope:'QA-WebView-via-USB-reverse-and-Mac-TLS-CONNECT',scope:clone(scope),profile,
  plan:{...plan,uploads:plan.uploads.map(({url,body})=>({url,bytes:body.length,sha256:hash(body)}))},sourceReceipt:clone(sourceReceipt),rows,errors,cleanup};
 const bounded=async(name,work,limit)=>{let timer;const abort=new AbortController();
  try{return await Promise.race([Promise.resolve().then(()=>work(abort.signal)),new Promise((_,reject)=>{
   timer=setTimeout(()=>{abort.abort();reject(Error(name+'_TIMEOUT_ABORT_REQUESTED_NOT_CONFIRMED'));},limit);
  })]);}finally{clearTimeout(timer);}};
 const actual=async(phase,kind,url,method='GET',body,sample)=>{
  const remaining=Math.min(maxRequestMs,deadline-performance.now());assert.ok(remaining>0,'CALIBRATION_DEADLINE_EXHAUSTED');
  const receipt=await bounded('CALIBRATION_REQUEST',signal=>request({phase,kind,url,method,body,signal,cache:'no-store',redirect:'error',contentType:body?'application/json':undefined,...(kind==='health'?{sample}:{})}),remaining);
  const allowed=['schema','scope','url','method','requestId','startedMonotonicMs','finishedMonotonicMs','clockScope','redirected','fromDiskCache','fromServiceWorker','fromPrefetchCache','tlsVerified','requestBodyBytes','requestBodySha256','status','responseBody','proxyEvidence'];
  assert.ok(Object.keys(receipt).sort().join(',')===allowed.sort().join(','),'CALIBRATION_RECEIPT_FIELDS_CHANGED');
  assert.equal(receipt.schema,'android-qa-calibration-request-v1');assert.deepEqual(receipt.scope,scope);
  assert.equal(receipt.url,url);assert.equal(receipt.method,method);assert.ok(typeof receipt.requestId==='string'&&receipt.requestId);
  assert.ok(!rows.some(row=>row.requestId===receipt.requestId),'CALIBRATION_DUPLICATE_REQUEST');
  assert.ok(finite(receipt.startedMonotonicMs)&&finite(receipt.finishedMonotonicMs)&&receipt.finishedMonotonicMs>receipt.startedMonotonicMs);
  if(rows.length)assert.ok(receipt.startedMonotonicMs>=rows.at(-1).finishedMonotonicMs,'CALIBRATION_SERIAL_REQUEST_CLOCK_CHANGED');
  assert.equal(receipt.clockScope,'owned-WebView-performance');
  assert.equal(receipt.redirected,false);assert.equal(receipt.fromDiskCache,false);assert.equal(receipt.fromServiceWorker,false);assert.equal(receipt.fromPrefetchCache,false);
  assert.equal(receipt.tlsVerified,true);assert.equal(receipt.requestBodyBytes,body?.length??0);assert.equal(receipt.requestBodySha256,hash(body??Buffer.alloc(0)));
  assert.ok(Buffer.isBuffer(receipt.responseBody),'CALIBRATION_ORIGINAL_RESPONSE_REQUIRED');
  if(kind==='preview'){assert.equal(receipt.status,200);assert.equal(receipt.responseBody.length,QA_PREVIEW.bytes);assert.equal(hash(receipt.responseBody),QA_PREVIEW.sha256);}
  else if(kind==='upload'){assert.equal(receipt.status,404);assert.equal(receipt.responseBody.length,QA_CALIBRATION_SOURCE.notFound.bytes);
   assert.equal(hash(receipt.responseBody),QA_CALIBRATION_SOURCE.notFound.sha256);}
  else{assert.equal(receipt.status,200);const value=JSON.parse(receipt.responseBody);assert.equal(value.environment,'production');assert.equal(value.status,'ok');}
  const {responseBody,...safe}=receipt;const row={...clone(safe),phase,kind,responseBodyBytes:responseBody.length,responseBodySha256:hash(responseBody),elapsedMs:receipt.finishedMonotonicMs-receipt.startedMonotonicMs};
  rows.push(row);return row;
 };
 try{
  report.before=clone(await bounded('CALIBRATION_INITIAL_ROOT_STATE',readRootState,maxRequestMs));
  await shaper.setConfiguration(shaperConfiguration({profile:'baseline'}));
  for(let index=0;index<3;index++)await actual('baseline','health',plan.healthUrl,'GET',undefined,index);
  report.baselineRoundTripMs=Math.min(...rows.filter(row=>row.phase==='baseline'&&row.kind==='health').map(row=>row.elapsedMs));
  const target=SHAPER_PROFILES[profile].targetRoundTripMs;
  assert.ok(report.baselineRoundTripMs<=target,'CALIBRATION_BASELINE_EXCEEDS_TARGET_CANNOT_REDUCE');
  await actual('baseline','upload',plan.uploads[0].url,'POST',plan.uploads[0].body);
  assert.ok(measuredDelayConfiguration,'CALIBRATION_MEASURED_DELAY_CONFIGURATION_REQUIRED');
  const selected=typeof measuredDelayConfiguration==='function'?await measuredDelayConfiguration({baselineRoundTripMs:report.baselineRoundTripMs,targetRoundTripMs:target,baseline:clone(rows)}):measuredDelayConfiguration;
  const config=shaperConfiguration({...selected,profile});
  await shaper.setConfiguration(config,{calibrationRequestsComplete:true});report.configuration=clone(config);
  await actual(profile,'preview',plan.previewUrl);
  for(let index=1;index<3;index++)await actual(profile,'upload',plan.uploads[index].url,'POST',plan.uploads[index].body);
  for(let index=0;index<3;index++)await actual(profile,'health',plan.healthUrl,'GET',undefined,index);
  report.observedRoundTripMs=rows.filter(row=>row.phase===profile&&row.kind==='health').map(row=>row.elapsedMs);
  report.observedTransfers=rows.filter(row=>row.phase===profile&&row.kind!=='health').map(row=>({requestId:row.requestId,kind:row.kind,
   payloadBytes:row.kind==='preview'?row.responseBodyBytes:row.requestBodyBytes,elapsedMs:row.elapsedMs,
   payloadBitsPerSecond:(row.kind==='preview'?row.responseBodyBytes:row.requestBodyBytes)*8000/row.elapsedMs}));
  // Root may run its separately timed gameplay window here, after calibration
  // and before final settings observation/restoration. The same installed era
  // remains in force. Only Root's callback controls the device and own rooms.
  if(runControlledWindow){const started=shaperClock();
   const result=await bounded('CALIBRATION_CONTROLLED_WINDOW',signal=>runControlledWindow({signal,profile,configuration:clone(config),shaper,calibration:report}),maxControlledWindowMs);
   report.controlledWindow={started,finished:shaperClock(),result:clone(result)};
  }
  report.after=clone(await bounded('CALIBRATION_FINAL_ROOT_STATE',readRootState,maxRequestMs));report.status='measurements-collected-calibration-pending';
 }catch(error){errors.push({code:errorCode(error)});}
 finally{
  const attempt=async(name,work)=>{try{cleanup.push({name,passed:true,receipt:clone(await work())});}catch(error){cleanup.push({name,passed:false,error:errorCode(error)});}};
  // Root restores original global keys/effective proxy and removes only its
  // reverse while this listener still exists; our independent close is last.
  await attempt('root-original-settings-and-own-reverse',()=>bounded('CALIBRATION_ROOT_CLEANUP',cleanupRoot,maxRequestMs));
  await attempt('own-proxy',async()=>{const ledger=await shaper.close();report.proxyLedger=ledger;
   const proof=validateProxyLedger(ledger);report.proxyLedgerProof=proof;
   assert.ok(proof.scheduleProven,'CALIBRATION_PROXY_LEDGER_INSUFFICIENT');
   if(!errors.length){report.proxyTransfersProof=validateCalibrationProxyTransfers(rows,ledger);
    assert.ok(report.proxyTransfersProof.transfersBound,report.proxyTransfersProof.reasons.join(','));}
   return proof;});
  if(cleanup.some(row=>!row.passed)||errors.length)report.status='insufficient';
 }
 report.requirementsRemaining=['Actual user0 UID10416 QA route/effective proxy and original-key cleanup proof',
  'Original deployed source receipts binding unknown POST complete bounded JSON read before the 404 (no server SHA echo)',
  'Actual roundtrip samples and measurement uncertainty at the unchanged profile target; added delay alone is not RTT',
  'Actual complete downlink and serial upload receipts plus valid aggregate ciphertext ledger',
  'Before/middle/after evidence coverage over the separately timed real gameplay interval and caller gate integration'];
 return report;
}

/** Formal software-controlled network hook. Root supplies original scoped
 * before/during/after environment observations and restored original settings.
 * RTT bounds come from an independently recorded measurement-error procedure,
 * or an explicit original-standard procedure; there is no invented ±N default.
 * Application HTTPS roundtrip includes server processing, never physical RTT.
 * This hook is separate from the old runner and cannot by itself pass gameplay.
 */
export function analyzeQaNetworkCalibration({calibration,rootProof,rttCalibration,sourceReceipt}){
 const proof={schema:'android-software-controlled-network-proof-v1',status:'insufficient',networkCalibrated:false,
  physicalPropagationRtt:false,scope:'actual-QA-USB-Mac-CONNECT-software-controlled-network',reasons:[]};
 try{
  const report=calibration,profile=SHAPER_PROFILES[report.profile];assert.ok(profile&&report.profile!=='baseline');
  assert.equal(report.schema,'android-qa-network-calibration-draft-v1');assert.equal(report.status,'measurements-collected-calibration-pending');
  assert.deepEqual(report.errors,[]);assert.equal(report.cleanup.length,2);assert.ok(report.cleanup.every(row=>row.passed===true));
  assert.equal(validateProxyLedger(report.proxyLedger).scheduleProven,true,'CALIBRATION_ACTUAL_PROXY_LEDGER_REQUIRED');
  assert.equal(sourceReceipt.schema,'android-qa-calibration-source-v1');assert.equal(sourceReceipt.release,QA_CALIBRATION_SOURCE.release);
  assert.equal(sourceReceipt.manifestSha256,QA_CALIBRATION_SOURCE.manifestSha256);assert.equal(sourceReceipt.sourceCommit,QA_CALIBRATION_SOURCE.sourceCommit);
  assert.deepEqual(Object.fromEntries(Object.entries(sourceReceipt.files).map(([path,row])=>[path,row.sha256])),QA_CALIBRATION_SOURCE.files);
  assert.equal(sourceReceipt.bodyContract,'complete-UTF8-JSON-object-at-most-65536-bytes-no-Content-Encoding-before-NOT_FOUND');
  assert.deepEqual(sourceReceipt.notFound,QA_CALIBRATION_SOURCE.notFound);assert.equal(sourceReceipt.serverBodyShaEcho,false);
  assert.deepEqual(report.sourceReceipt,sourceReceipt,'CALIBRATION_SOURCE_RECEIPT_NOT_BOUND');
  const plan=calibrationPlan(report.scope.nonce),rows=report.rows;
  assert.equal(rows.length,10,'CALIBRATION_COMPLETE_REAL_REQUEST_SEQUENCE_REQUIRED');
  const expected=[...Array.from({length:3},()=>['baseline','health',plan.healthUrl,'GET']),
   ['baseline','upload',plan.uploads[0].url,'POST'],[report.profile,'preview',plan.previewUrl,'GET'],
   ...[1,2].map(i=>[report.profile,'upload',plan.uploads[i].url,'POST']),
   ...Array.from({length:3},()=>[report.profile,'health',plan.healthUrl,'GET'])];
  assert.equal(new Set(rows.map(row=>row.requestId)).size,rows.length);
  for(const [index,row]of rows.entries()){
   assert.deepEqual([row.phase,row.kind,row.url,row.method],expected[index]);assert.deepEqual(row.scope,report.scope);
   assert.equal(row.tlsVerified,true);assert.equal(row.redirected,false);
   for(const key of ['fromDiskCache','fromServiceWorker','fromPrefetchCache'])assert.equal(row[key],false);
   assert.equal(row.clockScope,'owned-WebView-performance');assert.ok(finite(row.startedMonotonicMs)&&finite(row.finishedMonotonicMs));
   assert.equal(row.elapsedMs,row.finishedMonotonicMs-row.startedMonotonicMs);assert.ok(row.elapsedMs>0);
   if(index)assert.ok(row.startedMonotonicMs>=rows[index-1].finishedMonotonicMs,'CALIBRATION_REQUEST_SERIALITY_CHANGED');
   if(row.kind==='upload'){assert.equal(row.requestBodyBytes,65536);assert.equal(row.requestBodySha256,plan.uploadSha256);
    assert.equal(row.status,404);assert.equal(row.responseBodyBytes,52);assert.equal(row.responseBodySha256,QA_CALIBRATION_SOURCE.notFound.sha256);}
   else{assert.equal(row.status,200);assert.equal(row.requestBodyBytes,0);assert.equal(row.requestBodySha256,hash(Buffer.alloc(0)));}
   if(row.kind==='preview'){assert.equal(row.responseBodyBytes,QA_PREVIEW.bytes);assert.equal(row.responseBodySha256,QA_PREVIEW.sha256);}
  }
  const transfers=validateCalibrationProxyTransfers(rows,report.proxyLedger);
  assert.equal(transfers.transfersBound,true,transfers.reasons.join(','));
  const baseline=Math.min(...rows.filter(row=>row.phase==='baseline'&&row.kind==='health').map(row=>row.elapsedMs));
  assert.equal(report.baselineRoundTripMs,baseline);assert.ok(baseline<=profile.targetRoundTripMs,'CALIBRATION_BASELINE_EXCEEDS_TARGET_CANNOT_REDUCE');
  const config=shaperConfiguration(report.configuration);assert.deepEqual(config,report.configuration);assert.equal(config.profile,report.profile);
  assert.equal(rttCalibration.schema,'android-controlled-rtt-measurement-bounds-v1');assert.equal(rttCalibration.profile,report.profile);
  assert.equal(rttCalibration.targetMs,profile.targetRoundTripMs);assert.ok(['independent-measurement-error','original-standard-procedure'].includes(rttCalibration.basis));
  assert.match(rttCalibration.originalEvidenceSha256??'',/^[a-f0-9]{64}$/);assert.ok(typeof rttCalibration.procedure==='string'&&rttCalibration.procedure.length>0);
  const {lowerMs,upperMs}=rttCalibration;
  assert.ok(finite(lowerMs)&&finite(upperMs)&&lowerMs>=0&&lowerMs<=profile.targetRoundTripMs&&upperMs>=profile.targetRoundTripMs,'CALIBRATION_RTT_BOUNDS_REQUIRED');
  assert.ok(finite(rttCalibration.clockPrecisionMs)&&rttCalibration.clockPrecisionMs>0,'CALIBRATION_ACTUAL_CLOCK_PRECISION_REQUIRED');
  const measured=rows.filter(row=>row.phase===report.profile&&row.kind==='health').map(row=>row.elapsedMs);
  assert.ok(measured.every(value=>value>=lowerMs&&value<=upperMs),'CALIBRATION_ACTUAL_RTT_OUTSIDE_MEASURED_BOUNDS');
  assert.equal(rootProof.schema,'android-root-owned-proxy-environment-v1');assert.deepEqual(rootProof.scope,report.scope);
  assert.equal(rootProof.clockDomain,'Mac-host-hrtime-ms');assert.equal(report.proxyLedger.clockDomain,rootProof.clockDomain);
  assert.deepEqual(rootProof.source,{release:sourceReceipt.release,manifestSha256:sourceReceipt.manifestSha256,sourceCommit:sourceReceipt.sourceCommit});
  assert.equal(rootProof.macProxyPort,report.proxyLedger.listenPort);assert.equal(rootProof.proxyPid,report.proxyLedger.process.pid);
  assert.ok(Number.isSafeInteger(rootProof.deviceProxyPort)&&rootProof.deviceProxyPort>0&&rootProof.deviceProxyPort<=65535);
  const interval=rootProof.sampleInterval;assert.ok(finite(interval.startMs)&&finite(interval.endMs)&&interval.endMs>interval.startMs);
  assert.deepEqual(rootProof.observations.map(row=>row.phase),['before','during','after']);
  for(const row of rootProof.observations){assert.deepEqual(row.scope,report.scope);assert.ok(finite(row.monotonicMs));
   assert.deepEqual(row.effectiveProxy,{host:'127.0.0.1',port:rootProof.deviceProxyPort});
   assert.deepEqual(row.ownedReverse,{serial:report.scope.serial,devicePort:rootProof.deviceProxyPort,macPort:rootProof.macProxyPort});
   assert.equal(row.httpProxyValue,'127.0.0.1:'+rootProof.deviceProxyPort);
   assert.match(row.originalEvidenceSha256??'',/^[a-f0-9]{64}$/);
  }
  const [before,during,after]=rootProof.observations;
  assert.ok(before.monotonicMs<=interval.startMs&&during.monotonicMs>=interval.startMs&&during.monotonicMs<=interval.endMs&&after.monotonicMs>=interval.endMs,'CALIBRATION_ENVIRONMENT_DOES_NOT_COVER_SAMPLE');
  const era=report.proxyLedger.configurations.find(row=>canonical(row.configuration)===canonical(config)
   &&row.started.monotonicMs<=before.monotonicMs&&row.finished?.monotonicMs>=after.monotonicMs);
  assert.ok(era,'CALIBRATION_PROXY_PROFILE_NOT_CONTINUOUS');
  assert.deepEqual(rootProof.restoredGlobalProxyKeys,rootProof.originalGlobalProxyKeys,'CALIBRATION_ORIGINAL_PROXY_NOT_RESTORED');
  assert.ok(Array.isArray(rootProof.originalGlobalProxyKeys)&&rootProof.originalGlobalProxyKeys.length>0);
  for(const key of rootProof.originalGlobalProxyKeys){assert.ok(typeof key.name==='string'&&typeof key.present==='boolean');assert.ok(key.value===null||typeof key.value==='string');}
  assert.deepEqual(rootProof.restoredReverseInventory,rootProof.originalReverseInventory,'CALIBRATION_ORIGINAL_REVERSE_NOT_RESTORED');
  assert.deepEqual(rootProof.restoredEffectiveProxy,rootProof.originalEffectiveProxy);
  assert.ok(Array.isArray(rootProof.originalReverseInventory)&&Array.isArray(rootProof.restoredReverseInventory));
  assert.match(rootProof.cleanupOriginalEvidenceSha256??'',/^[a-f0-9]{64}$/);
  proof.status='software-controlled-network-proven';proof.networkCalibrated=true;
  proof.profile=report.profile;proof.targetRoundTripMs=profile.targetRoundTripMs;proof.actualHealthRoundTripMs=measured;
  proof.baselineHealthRoundTripMs=baseline;proof.addedDelayMs={upload:config.uploadDelayMs,download:config.downloadDelayMs};
  proof.rttMeasurementBounds=clone(rttCalibration);proof.proxyByteBoundary=config.byteBoundary;
  proof.limitations=['HTTPS request/response elapsed time includes server work; not physical propagation RTT',
   'Host aggregate shaping covers all target-host tunnels; it is not UID isolation','Raw Root evidence must be sealed and verified by the actual operator',
   'This network proof does not pass Android gameplay, frame or action gates by itself'];
 }catch(error){proof.reasons.push(errorCode(error));}
 return proof;
}

async function cli(){
 const args=process.argv.slice(2),options={};for(let index=0;index<args.length;index+=2){assert.ok(['--out','--port','--profile','--upload-delay-ms','--download-delay-ms'].includes(args[index])&&args[index+1]!==undefined&&!Object.hasOwn(options,args[index]),'SHAPER_CLI_ARGUMENT');options[args[index]]=args[index+1];}
 assert.ok(options['--out'],'SHAPER_EXCLUSIVE_OUTPUT_REQUIRED');
 const configuration=shaperConfiguration({profile:options['--profile']??'wifi',uploadDelayMs:Number(options['--upload-delay-ms']??0),downloadDelayMs:Number(options['--download-delay-ms']??0)});
 const out=resolve(options['--out']);await mkdir(out,{mode:0o700});let handle;
 try{
  handle=await startBlindConnectShaper({port:Number(options['--port']??0),configuration});
  process.stdout.write(JSON.stringify({status:'pending-real-calibration',host:handle.address.address,port:handle.address.port,pid:process.pid,configurationSha256:handle.ledger.configurations[0].sha256,networkCalibrated:false})+'\n');
  await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
 }finally{if(handle){const ledger=await handle.close();await writeFile(resolve(out,'ledger.json'),JSON.stringify(ledger)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify(validateProxyLedger(ledger))+'\n');}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)cli().catch(error=>{process.stderr.write(String(errorCode(error))+'\n');process.exitCode=1;});
