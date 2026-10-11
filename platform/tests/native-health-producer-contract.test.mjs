import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {webcrypto} from 'node:crypto';
import {mkdtemp,writeFile,chmod,symlink,link,rename,rm,lstat,open,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NATIVE_HEALTH_SOURCE08,validateNativeHealthProducerContract,nativeFetchChallengeConsumer,installNativeFetchProbe} from '../deploy/native-browser-checks.mjs';
import {playerAcceptanceArguments,readNativeHealthProducerContract,playerEvidenceHash} from '../scripts/android-player-acceptance-checks.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url)),version=NATIVE_HEALTH_SOURCE08,body='{"status":"ok","environment":"production"}',url=version.origin+'/health';
const selection=()=>({schema:'root-source08-native-health-producer-contract-v1',origin:version.origin,method:'GET',path:'/health',environment:'production',release_manifest:{path:'/private/frozen/source08-manifest.json',sha256:version.manifestSha256},source_sha256:{...version.sourceSha256},expected_body:{bytes:version.bodyBytes,sha256:version.bodySha256},deployment_evidence:{path:'/private/frozen/source08-authority.json',sha256:version.deploymentEvidenceSha256}});
const producer=()=>({challengeUrl:url,producerBound:{mode:'producer-bound-native-arraybuffer',bytes:42,sha256:version.bodySha256}});
const descriptor=()=>({contract:validateNativeHealthProducerContract(selection()),sha256:playerEvidenceHash(JSON.stringify(selection())),provenance:{fresh_deployment_confirmation:false,fixture:true}});

// Real native Response/ReadableStream consumption in an isolated JS realm. Only
// transport and clocks are local fixtures; no HTTP/ADB/device operations occur.
function realmFixture({content=body,status=200,responseUrl=url,redirected=false,pendingBody=false,bodyError=null}={}){
 const calls={fetch:[],arrayBuffer:0,reader:0,cancel:0,cleared:[],order:[]},timers=[];let now=0,streamController,onFetch=()=>{};
 const sandbox={AbortController,AbortSignal,URL,Request,Uint8Array,crypto:webcrypto,location:{href:version.origin+'/play/golf'},performance:{timeOrigin:1000000,now:()=>++now},Date:{now:()=>1000000+now},btoa:value=>Buffer.from(value,'binary').toString('base64'),
  setTimeout:(callback,delay)=>{const timer={callback,delay};timers.push(timer);return timer;},clearTimeout:timer=>calls.cleared.push(timer),
  fetch:async(href,options)=>{
   calls.fetch.push({href,options});calls.order.push('native-fetch');onFetch(href,1000000+now);
   const source=pendingBody?new ReadableStream({start(controller){streamController=controller;options.signal.addEventListener('abort',()=>controller.error(options.signal.reason),{once:true});}}):bodyError?new ReadableStream({start(controller){controller.error(bodyError);}}):Buffer.from(content);
   const response=new Response(source,{status});Object.defineProperties(response,{url:{value:responseUrl},redirected:{value:redirected}});
   let nativeReading=false;response.arrayBuffer=function(){calls.arrayBuffer++;calls.order.push('native-arraybuffer');nativeReading=true;return Response.prototype.arrayBuffer.call(this).finally(()=>{nativeReading=false;});};
   // Node's native Body implementation may internally use getReader. Count only
   // the consumer's explicit stream API, not implementation details of Body.
   const getReader=response.body.getReader.bind(response.body);response.body.getReader=()=>{if(!nativeReading)calls.reader++;const reader=getReader(),cancel=reader.cancel.bind(reader);reader.cancel=(...args)=>{calls.cancel++;return cancel(...args);};return reader;};
   return response;
  },
 };
 const realm=vm.createContext(sandbox);
 const evaluate=(fn,arg)=>vm.runInContext('('+fn.toString()+')('+JSON.stringify(arg)+')',realm);
 return{calls,timers,sandbox,evaluate,now:()=>1000000+now,setTransport:callback=>onFetch=callback,releaseBody:()=>streamController.close()};
}

test('only the exact source08 producer selection and actual artifact/source hashes are accepted',async()=>{
 const contract=selection(),sourcePins={};for(const name of Object.keys(version.sourceSha256))sourcePins[name]=playerEvidenceHash(await readFile(join(ROOT,name.slice('platform/'.length))));
 assert.deepEqual(sourcePins,version.sourceSha256);assert.equal(Buffer.byteLength(body),42);assert.equal(playerEvidenceHash(body),version.bodySha256);
 assert.deepEqual(validateNativeHealthProducerContract(contract,{origin:version.origin,manifestSha256:version.manifestSha256,sourcePins}),contract);
 for(const mutate of [v=>v.extra=true,v=>v.origin='https://foreign.example',v=>v.path='/health?nonce=x',v=>v.method='POST',v=>v.environment='sandbox',v=>v.release_manifest.sha256='a'.repeat(64),v=>v.source_sha256['platform/server/index.mjs']='a'.repeat(64),v=>v.expected_body.bytes=16384,v=>v.expected_body.sha256='a'.repeat(64),v=>v.deployment_evidence.sha256='a'.repeat(64)]){
  const wrong=structuredClone(contract);mutate(wrong);assert.throws(()=>validateNativeHealthProducerContract(wrong),/HEALTH_PRODUCER/);
 }
 assert.throws(()=>validateNativeHealthProducerContract(contract,{origin:'https://foreign.example'}),/ARTIFACT_ORIGIN/);
 assert.throws(()=>validateNativeHealthProducerContract(contract,{manifestSha256:'a'.repeat(64)}),/ACTUAL_MANIFEST/);
 assert.throws(()=>validateNativeHealthProducerContract(contract,{sourcePins:{}}),/ACTUAL_SOURCE/);
 const args=['--metadata','/qa/meta','--platform-manifest','/build/stamp','--apksigner','/local/signer','--output','/private/out'];
 assert.equal(playerAcceptanceArguments(args).healthProducerContract,undefined);assert.equal(playerAcceptanceArguments([...args,'--health-producer-contract','/private/contract']).healthProducerContract,'/private/contract');
 assert.throws(()=>playerAcceptanceArguments([...args,'--health-producer-contract']),/ARGUMENT_VALUE_REQUIRED/);
});

test('private producer file is NOFOLLOW, owned 0600/nlink1 and stable through its complete read',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'health-producer-contract-')),path=join(dir,'contract.json'),manifest=join(dir,'manifest.json');
 try{
  const value=selection();value.release_manifest.path=manifest;await writeFile(manifest,'{}');await writeFile(path,JSON.stringify(value),{mode:0o600});
  let opened=false;await assert.rejects(readNativeHealthProducerContract(path,{root:ROOT,origin:version.origin,openFile:async(name,flags)=>{if(name===path){opened=true;assert.equal(flags,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}return open(name,flags);}}),/ACTUAL_MANIFEST_MISMATCH/);assert.equal(opened,true);
  // A regular lstat result can race with a FIFO replacement. Nonblocking open
  // reaches fstat, rejects that descriptor and never attempts a body read.
  let fifoRead=false,fifoClosed=false;await assert.rejects(readNativeHealthProducerContract(path,{root:ROOT,origin:version.origin,openFile:async(name,flags)=>{assert.ok(flags&constants.O_NONBLOCK);assert.equal(name,path);return{stat:async()=>{const info=await lstat(path,{bigint:true});info.isFile=()=>false;return info;},read:async()=>{fifoRead=true;throw Error('UNEXPECTED_FIFO_READ');},close:async()=>{fifoClosed=true;}};}}),/FILE_REPLACED/);assert.equal(fifoRead,false);assert.equal(fifoClosed,true);
  await chmod(path,0o640);await assert.rejects(readNativeHealthProducerContract(path,{root:ROOT,origin:version.origin}),/FILE_IDENTITY_INVALID/);await chmod(path,0o600);
  const symbolic=join(dir,'symbolic');await symlink(path,symbolic);await assert.rejects(readNativeHealthProducerContract(symbolic,{root:ROOT,origin:version.origin}),/FILE_IDENTITY_INVALID/);
  const hard=join(dir,'hard');await link(path,hard);await assert.rejects(readNativeHealthProducerContract(path,{root:ROOT,origin:version.origin}),/FILE_IDENTITY_INVALID/);await rm(hard);
  await assert.rejects(readNativeHealthProducerContract(path,{root:ROOT,origin:version.origin,statPath:async(name,options)=>{const info=await lstat(name,options);if(name===path)info.uid+=1n;return info;}}),/FILE_IDENTITY_INVALID/);
  const swapped=join(dir,'replacement');await writeFile(swapped,JSON.stringify(value),{mode:0o600});let first=true;
  await assert.rejects(readNativeHealthProducerContract(path,{root:ROOT,origin:version.origin,statPath:async(name,options)=>{const info=await lstat(name,options);if(name===path&&first){first=false;await rename(swapped,path);}return info;}}),/FILE_REPLACED/);
  let written=false;await assert.rejects(readNativeHealthProducerContract(path,{root:ROOT,origin:version.origin,openFile:async(name,flags)=>{const handle=await open(name,flags);if(name!==path)return handle;return{stat:options=>handle.stat(options),close:()=>handle.close(),read:async(...args)=>{const result=await handle.read(...args);if(!written){written=true;await writeFile(path,JSON.stringify({...value,extra:true}));}return result;}};}}),/FILE_CHANGED/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('explicit producer consumer uses the original native arrayBuffer and retains the actual complete 42 bytes',async()=>{
 const f=realmFixture(),result=await f.evaluate(nativeFetchChallengeConsumer,producer()),t=result.consumer_telemetry;
 assert.equal(result.status,200);assert.equal(result.bytes,42);assert.equal(result.failed,undefined);assert.equal(f.calls.fetch.length,1);assert.equal(f.calls.arrayBuffer,1);assert.equal(f.calls.reader,0);assert.equal(f.calls.cancel,0);
 assert.deepEqual(JSON.parse(JSON.stringify(t.events.map(e=>e.kind))),['fetch-start','fetch-fulfilled','native-body-start','native-body-complete','consumer-final']);
 assert.equal(t.diagnostic_only,false);assert.equal(t.body_evidence_required,true);
 assert.equal(t.mode,'producer-bound-native-arraybuffer');assert.equal(t.runtime_byte_cap,false);assert.equal(t.producer_max_body_bytes,42);assert.equal(t.native_body_complete,true);assert.equal(t.eof,false);assert.equal(t.body_complete,true);assert.equal(t.signal_aborted,false);assert.equal(playerEvidenceHash(Buffer.from(t.body_base64,'base64')),version.bodySha256);
 assert.equal(f.timers[0].delay,5000);assert.equal(f.calls.cleared[0],f.timers[0]);const {signal,...options}=f.calls.fetch[0].options;assert.deepEqual(options,{method:'GET',credentials:'omit',cache:'no-store',redirect:'error'});assert.equal(signal.aborted,false);
});

test('unselected generic challenge still reads the bounded stream and cancels only beyond 16 KiB',async()=>{
 const good=realmFixture(),received=await good.evaluate(nativeFetchChallengeConsumer,url);assert.equal(received.bytes,42);assert.equal(good.calls.arrayBuffer,0);assert.equal(good.calls.reader,1);assert.equal(received.consumer_telemetry.mode,'bounded-stream');assert.equal(received.consumer_telemetry.eof,true);assert.equal(received.consumer_telemetry.runtime_byte_cap,true);
 assert.equal(received.consumer_telemetry.diagnostic_only,true);assert.equal(received.consumer_telemetry.body_evidence_required,false);
 const over=realmFixture({content:'x'.repeat(16385)}),failed=await over.evaluate(nativeFetchChallengeConsumer,url);assert.equal(failed.failed,true);assert.equal(over.calls.arrayBuffer,0);assert.equal(over.calls.cancel,1);assert.equal(failed.consumer_telemetry.events.find(e=>e.kind==='consumer-rejected').error.message,'CHALLENGE_BODY_LIMIT');
 const wrong=producer();wrong.producerBound.bytes=16384;const f=realmFixture(),rejected=await f.evaluate(nativeFetchChallengeConsumer,wrong);assert.equal(rejected.failed,true);assert.equal(f.calls.fetch.length,0);assert.equal(f.calls.reader,0);assert.equal(f.calls.arrayBuffer,0);
});

test('producer consumer rejects non-200, foreign response, redirects, altered bytes and post-read limit violations',async()=>{
 for(const [options,error,reads]of [[{status:404},'CHALLENGE_PRODUCER_RESPONSE_INVALID',0],[{responseUrl:'https://foreign.example/health'},'CHALLENGE_PRODUCER_RESPONSE_INVALID',0],[{redirected:true},'CHALLENGE_PRODUCER_RESPONSE_INVALID',0],[{content:body.replace('production','producTion')},'CHALLENGE_PRODUCER_BODY_MISMATCH',1],[{content:body+' '},'CHALLENGE_PRODUCER_BODY_MISMATCH',1],[{content:'x'.repeat(16385)},'CHALLENGE_BODY_LIMIT',1],[{bodyError:new TypeError('net::ERR_ABORTED')},'net::ERR_ABORTED',1]]){
  const f=realmFixture(options),result=await f.evaluate(nativeFetchChallengeConsumer,producer());assert.equal(result.failed,true);assert.equal(f.calls.fetch.length,1);assert.equal(f.calls.arrayBuffer,reads);assert.equal(f.calls.reader,0);assert.equal(f.calls.cancel,0);assert.equal(result.consumer_telemetry.events.find(e=>e.kind==='consumer-rejected').error.message,error);assert.equal(result.consumer_telemetry.signal_aborted,false);
 }
});

test('pending native body retains the original 5 second timeout/abort and never retries or fabricates EOF',async()=>{
 const f=realmFixture({pendingBody:true}),pending=f.evaluate(nativeFetchChallengeConsumer,producer());await new Promise(setImmediate);assert.equal(f.calls.arrayBuffer,1);assert.equal(f.timers[0].delay,5000);f.timers[0].callback();const result=await pending,t=result.consumer_telemetry;
 assert.equal(result.failed,true);assert.equal(f.calls.fetch.length,1);assert.equal(f.calls.arrayBuffer,1);assert.equal(f.calls.reader,0);assert.equal(t.signal_aborted,true);assert.equal(t.native_body_complete,false);assert.equal(t.eof,false);assert.equal(t.body_complete,false);assert.ok(t.events.some(e=>e.kind==='timeout-fired'));assert.ok(t.events.some(e=>e.kind==='signal-abort'));
});

async function installedFixture({contract=descriptor(),cdpError=null,duplicate=false,foreignFrame=false,content=body}={}){
 const f=realmFixture({content}),page=Object.assign(new EventEmitter(),{url:()=>f.sandbox.location.href,isClosed:()=>false}),session=new EventEmitter();let init,initArgs,frame,request=0;
 session.send=async method=>{if(method==='Runtime.enable')session.emit('Runtime.executionContextCreated',{context:{id:1,auxData:{isDefault:true,frameId:'owned-cdp-frame'}}});};
 const context=Object.assign(new EventEmitter(),{pages:()=>[page],exposeBinding:async(name,callback)=>{f.sandbox[name]=event=>callback({frame},event);},addInitScript:async(fn,args)=>{init=fn;initArgs=args;},newCDPSession:async()=>session});
 frame={url:()=>f.sandbox.location.href,evaluate:async(fn,arg)=>{f.calls.order.push(fn===nativeFetchChallengeConsumer?'consumer-evaluate':'checkpoint');return f.evaluate(fn,arg);}};page.frames=()=>[frame];
 const probe=await installNativeFetchProbe(context,{healthProducerContract:contract});await probe.attach(page);
 f.sandbox[initArgs.networkBindingName]=payload=>session.emit('Runtime.bindingCalled',{name:initArgs.networkBindingName,executionContextId:1,payload});await f.evaluate(init,initArgs);
 f.setTransport((href,started)=>{
  const emit=id=>{session.emit('Network.requestWillBeSent',{requestId:id,frameId:foreignFrame?'foreign-frame':'owned-cdp-frame',request:{url:href,method:'GET'},wallTime:started/1000,timestamp:started/1000,type:'Fetch'});session.emit('Network.responseReceived',{requestId:id,response:{status:200}});if(cdpError)session.emit('Network.loadingFailed',{requestId:id,errorText:cdpError,canceled:true,timestamp:(started+1)/1000});};emit('request-'+(++request));if(duplicate)emit('duplicate');
 });
 return{...f,probe,frame};
}

test('actual serialized probe and consumer remain sequential and same-document, with body SHA and contract provenance',async()=>{
 const f=await installedFixture(),proof=await f.probe.requireInstalled(f.frame),observation=f.probe.installationObservations[0];assert.equal(proof.verification,'same-document-fetch-challenge');assert.equal(observation.passed,true);assert.equal(observation.producer_body.passed,true);assert.equal(observation.producer_body.sha256,version.bodySha256);assert.equal(observation.producer_contract.sha256,descriptor().sha256);
 assert.deepEqual(f.calls.order,['checkpoint','consumer-evaluate','native-fetch','native-arraybuffer','checkpoint']);assert.equal(observation.before.document_id,observation.after.document_id);assert.ok(observation.before.event_seq<observation.after.event_seq);assert.equal(observation.challenge.starts,1);assert.equal(observation.challenge.network_requests,1);assert.equal(f.probe.errors.length,0);
 // A second same-URL request cannot be adopted as another successful challenge.
 await assert.rejects(f.probe.requireInstalled(f.frame),/FETCH_PROBE_CHALLENGE_FAILED/);assert.equal(f.calls.fetch.length,2);assert.equal(f.probe.installationObservations[1].challenge.network_requests,2);
 const generic=await installedFixture({contract:null});await generic.probe.requireInstalled(generic.frame);assert.equal(generic.calls.arrayBuffer,0);assert.equal(generic.calls.reader,1);assert.equal(generic.probe.installationObservations[0].producer_contract,undefined);
});

test('complete native producer body cannot override original CDP errors, foreign scope, duplicate requests or wrong bytes',async()=>{
 for(const options of [{cdpError:'net::ERR_ABORTED'},{foreignFrame:true},{duplicate:true},{content:body.replace('production','producTion')}]){
  const f=await installedFixture(options);await assert.rejects(f.probe.requireInstalled(f.frame),/FETCH_PROBE_CHALLENGE_FAILED/);const observation=f.probe.installationObservations[0];assert.equal(observation.passed,false);assert.deepEqual(f.probe.errors,['FETCH_PROBE_CHALLENGE_FAILED']);assert.equal(f.calls.fetch.length,1);
  if(options.cdpError){assert.equal(observation.producer_body.passed,true);assert.equal(observation.challenge.passed,false);assert.equal([...f.probe.network.values()][0].error,options.cdpError);}
 }
 const wrong=descriptor();wrong.contract={...wrong.contract,origin:'https://foreign.example'};await assert.rejects(installedFixture({contract:wrong}),/HEALTH_PRODUCER_ORIGIN_MISMATCH/);
 const foreign=await installedFixture();foreign.sandbox.location.href='https://foreign.example/play/golf';await assert.rejects(foreign.probe.requireInstalled(foreign.frame),/FETCH_PROBE_NOT_INSTALLED/);assert.equal(foreign.calls.fetch.length,0);
});
