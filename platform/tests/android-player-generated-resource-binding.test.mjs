import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {playerResourceManifest,createPlayerEvidenceRedactor} from '../scripts/android-player-acceptance-checks.mjs';
import {deriveDracoWorkerPin,validateConsumedImageEvidence,generatedScriptProofForResponse} from '../scripts/android-player-resource-evidence.mjs';
import {collectPlayerEvidence} from '../scripts/android-player-acceptance.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
// These are local protocol/resource fixtures, never an app, server response or
// device evidence. The recipe is derived by the same release-byte validator.
function fixture(){
 const origin='https://owned.example',entryUrl=origin+'/player?app_id=local_fixture',frame=origin+'/play/golf',timeOrigin=100000,nonce='local-resource-fixture-0123456789',documentId='a'.repeat(32),scope={frameId:'owned-golf-frame',contextId:9};
 const loaderPath='/arena/assets/DRACOLoader-fixture.js',aliasPath='/arena/assets/DRACOLoader-alias.js',decoderPath='/arena/assets/draco_wasm_wrapper-fixture.js';
 const workerFunction='self.onmessage=function(event){self.postMessage(event.data);};',decoder=Buffer.from('var DracoDecoderModule=function(){return {};};');
 const loader=Buffer.from('const a=W.toString(),b=["/* draco decoder */",d,"","/* worker */",a.substring(a.indexOf("{")+1,a.lastIndexOf("}"))].join(`\n`);this.workerSourceURL=URL.createObjectURL(new Blob([b]));function W(){'+workerFunction+'}export{W};\n'),alias=Buffer.concat([Buffer.from('/* independent loader alias */\n'),loader]);
 const image=Buffer.from('local immutable image bytes'),files=new Map([[loaderPath,loader],[aliasPath,alias],[decoderPath,decoder],['/arena/assets/fixture.webp',image],['/index.html',Buffer.from('<main>local fixture</main>')],['/arena/index.html',Buffer.from('<canvas></canvas>')]]);
 const outputs=Object.fromEntries([...files].map(([path,bytes])=>[path.startsWith('/arena/')?'platform/arena/dist/'+path.slice('/arena/'.length):'platform/dist/'+path.slice(1),hash(bytes)])),manifest=playerResourceManifest({format:1,inputs:{},outputs});
 const recipes=[deriveDracoWorkerPin({origin,manifest,loaderUrl:origin+loaderPath,loaderBytes:loader,decoderUrl:origin+decoderPath,decoderBytes:decoder}),deriveDracoWorkerPin({origin,manifest,loaderUrl:origin+aliasPath,loaderBytes:alias,decoderUrl:origin+decoderPath,decoderBytes:decoder})];
 const worker=Buffer.from(['/* draco decoder */',decoder.toString('utf8'),'','/* worker */',workerFunction].join('\n'));assert.equal(hash(worker),recipes[0].sha256);
 const get=(id,path,start,end)=>{const startedAtMs=timeOrigin+start,startedMonotonic=1+start/1000,finishedMonotonic=1+end/1000;return{id,url:origin+path,frameId:scope.frameId,contextId:scope.contextId,method:'GET',type:'Fetch',redirected:false,transferFinished:true,failed:false,response:{status:200,fromServiceWorker:false},startedAtMs,startedMonotonic,finishedMonotonic,finishedAtMs:startedAtMs+(finishedMonotonic-startedMonotonic)*1000};};
 const requests=[get('loader',loaderPath,20,40),get('decoder-early',decoderPath,50,70),get('decoder-later-1',decoderPath,180,200),get('decoder-later-2',decoderPath,280,300)];
 const urls=[1,2,3].map(id=>'blob:'+origin+'/'+String(id).padStart(8,'0')+'-0000-0000-0000-000000000000');
 const generatedReceipts=[100,220,320].map((createdAt,i)=>({id:i+1,kind:'generated-script',bytes:worker.length,sha256:hash(worker),createdAt,completedAt:createdAt+5,hashDurationMs:4,hashStartedAt:createdAt+1,hashStarted:true,hashComplete:true,recipe:null,recipeCandidates:recipes,blobUrls:[{url:urls[i],createdAt:createdAt+1,revokedAt:null}]}));
 const snapshot={schema:'owned-player-resource-evidence-v1',game:'golf',identity:{nonce,documentId,timeOrigin,url:frame,parentUrl:entryUrl},phase:'loading',pendingTasks:0,totalHashedBytes:worker.length*3,receipts:[],generatedReceipts,errors:[],closed:false};
 const source=(id,path)=>({id,request_id:id,url:origin+path,path,method:'GET',status:200,frame,resourceType:'fetch',original_sha256:hash(files.get(path)),original_bytes:files.get(path).length,pin:{sha256:hash(files.get(path))}}),delivery=(id,index)=>({id,request_id:id,url:urls[index],path:origin+'/'+urls[index].split('/').at(-1),method:'GET',status:200,frame,resourceType:'script',original_sha256:hash(worker),original_bytes:worker.length,worker_response_finished:true});
 const responses=[source(1,loaderPath),source(2,decoderPath),delivery(3,0),delivery(4,0),source(5,decoderPath),delivery(6,1),delivery(7,1),source(8,decoderPath),delivery(9,2),delivery(10,2)];
 const args={origin,entryUrl,game:'golf',nonce,documentId,timeOrigin,scope,manifest,requests,generatedScripts:recipes};
 const prove=(row,snap=snapshot,more={},bodyPins=responses)=>generatedScriptProofForResponse({...row,...scope,transferFinished:row.worker_response_finished===true},validateConsumedImageEvidence(snap,{...args,...more}),{origin,manifest,bodyPins});
 return{args,files,manifest,recipes,snapshot,requests,responses,prove,worker,loaderPath,aliasPath,decoderPath};
}

test('earlier Blob input facts stay fixed after later successful same-URL decoder GETs',()=>{
 const a=fixture(),expected=[['loader','decoder-early'],['loader','decoder-early','decoder-later-1'],['loader','decoder-early','decoder-later-1','decoder-later-2']];
 for(const row of a.responses.filter(r=>r.worker_response_finished)){
  const proof=a.prove(row),index=a.snapshot.generatedReceipts.findIndex(r=>r.blobUrls[0].url===row.url);assert.deepEqual(proof.sourceRequestIds,expected[index]);assert.equal(proof.deliveryRequestId,row.request_id);assert.equal(proof.deliveryResponseId,row.id);assert.equal(proof.deliveryUrl,row.url);assert.equal(proof.sha256,hash(a.worker));
  assert.deepEqual(proof.sourceRequestFacts.map(fact=>fact.id),proof.sourceRequestIds);assert.ok(proof.sourceRequestFacts.every(fact=>fact.finishedAtMs<=proof.blobObservedAtMs));assert.ok(proof.sourceBodyFacts.every(fact=>fact.requestId<row.request_id&&fact.responseId<row.id));
  assert.deepEqual(a.prove(row,a.snapshot,{requests:a.requests.filter(r=>r.finishedAtMs<=proof.blobObservedAtMs)}),proof);
 }
});

test('each new Blob needs its own receipt and exact worker response body and IDs',()=>{
 const a=fixture(),old=a.responses[2],next=a.responses[5],snap=structuredClone(a.snapshot);snap.generatedReceipts=snap.generatedReceipts.filter(r=>r.id!==2);snap.totalHashedBytes-=a.worker.length;
 assert.equal(a.prove(old,snap).generatedReceiptId,1);assert.throws(()=>a.prove(next,snap),/GENERATED_SCRIPT_NATIVE_BLOB_UNPROVEN/);
 assert.throws(()=>a.prove({...next,original_sha256:'0'.repeat(64)}),/RESOURCE_NONEMPTY_CDP_BODY_CONFLICT/);assert.throws(()=>a.prove({...next,request_id:null}),/GENERATED_SCRIPT_DELIVERY_REQUEST_REQUIRED/);
});

test('later success cannot replace missing earlier CDP input, or settle competing earlier loader recipes',()=>{
 const a=fixture(),row=a.responses[2];assert.throws(()=>a.prove(row,a.snapshot,{requests:a.requests.filter(r=>r.id!=='decoder-early')}),/GENERATED_SCRIPT_SOURCE_GET_UNPROVEN/);
 const competing={...a.requests[0],id:'competing-loader',url:a.args.origin+a.aliasPath};assert.throws(()=>a.prove(row,a.snapshot,{requests:[...a.requests,competing]}),/GENERATED_SCRIPT_ACTIVE_MODULE_AMBIGUOUS/);
});

test('failed/missing/conflicting bodies and every later GET ownership/finish/clock ambiguity refuse',()=>{
 const a=fixture(),row=a.responses[2];
 for(const mutate of[r=>r.failed=true,r=>r.transferFinished=false,r=>r.redirected=true,r=>r.contextId++,r=>r.response.status=500,r=>r.response.fromServiceWorker=true,r=>delete r.startedAtMs,r=>r.finishedAtMs++,r=>r.finishedMonotonic=r.startedMonotonic-1]){
  const requests=structuredClone(a.requests);mutate(requests[3]);assert.throws(()=>a.prove(row,a.snapshot,{requests}));
 }
 const evidence=validateConsumedImageEvidence(a.snapshot,a.args),proveBody=bodyPins=>generatedScriptProofForResponse({...row,...a.args.scope,transferFinished:true},evidence,{origin:a.args.origin,manifest:a.manifest,bodyPins});
 const corrupt=structuredClone(a.responses);corrupt[7].original_sha256='0'.repeat(64);assert.throws(()=>proveBody(corrupt),/GENERATED_SCRIPT_RECEIVED_INPUT_BODY_PIN_REQUIRED/);
 assert.throws(()=>proveBody(a.responses.filter(source=>source.id!==2)),/GENERATED_SCRIPT_RECEIVED_INPUT_BODY_PIN_REQUIRED/);
 const failed=structuredClone(a.responses);delete failed[1].original_sha256;delete failed[1].original_bytes;failed[1].body_error='ORIGINAL_BODY_UNAVAILABLE';assert.throws(()=>proveBody(failed),/GENERATED_SCRIPT_RECEIVED_INPUT_BODY_PIN_REQUIRED/);
 const changed=structuredClone(a.requests);changed[1].startedAtMs++;changed[1].finishedAtMs=changed[1].startedAtMs+(changed[1].finishedMonotonic-changed[1].startedMonotonic)*1000;const proof=a.prove(row),changedProof=a.prove(row,a.snapshot,{requests:changed});assert.deepEqual(changedProof.sourceRequestIds,proof.sourceRequestIds);assert.throws(()=>assert.deepEqual(changedProof,proof));
 assert.throws(()=>a.prove(row,a.snapshot,{requests:[...a.requests,a.requests[1]]}),/GENERATED_SCRIPT_SOURCE_ID_AMBIGUOUS/);
});

async function collector(a){
 const out=await mkdtemp(join(tmpdir(),'local-generated-resource-')),outputRoot=join(out,'release'),page=new EventEmitter(),cdp=new EventEmitter();let nonce,finished=0;
 for(const[path,bytes]of a.files){const file=join(outputRoot,path.startsWith('/arena/')?'arena/dist/'+path.slice('/arena/'.length):'dist/'+path.slice(1));await mkdir(join(file,'..'),{recursive:true});await writeFile(file,bytes,{flag:'wx'});}
 const scope=a.args.scope,frame={url:()=>a.args.origin+'/play/golf'},owner={schema:'android-physical-performance-v1',documentId:a.args.documentId,timeOrigin:a.args.timeOrigin,url:frame.url()};let snapshot;
 page.url=()=>a.args.entryUrl;
 cdp.send=async(method,args)=>{if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'top',url:a.args.entryUrl},childFrames:[{frame:{id:scope.frameId,parentId:'top',url:frame.url()}}]}};if(method==='Runtime.evaluate')return{result:{value:args.expression.includes('.stop()')?snapshot:{owner:{...owner,nonce},snapshot}}};return{};};cdp.detach=async()=>{};
 const context={newCDPSession:async()=>cdp,addInitScript:async(_fn,args)=>{nonce=args.nonce;return{dispose:async()=>{}};}};
 const evidence=await collectPlayerEvidence({context,page,origin:a.args.origin,manifest:a.manifest,out,redactor:createPlayerEvidenceRedactor(),result:{},resourceOutputRoot:outputRoot});
 snapshot=structuredClone(a.snapshot);snapshot.generatedReceipts=snapshot.generatedReceipts.slice(0,1);snapshot.totalHashedBytes=a.worker.length;snapshot.identity.nonce=nonce;
 cdp.emit('Runtime.executionContextCreated',{context:{id:scope.contextId,origin:a.args.origin,auxData:{isDefault:true,frameId:scope.frameId}}});
 const transfer=row=>{cdp.emit('Network.requestWillBeSent',{requestId:row.id,frameId:scope.frameId,type:row.type,timestamp:row.startedMonotonic,wallTime:row.startedAtMs/1000,request:{url:row.url,method:row.method}});cdp.emit('Network.responseReceived',{requestId:row.id,response:row.response});cdp.emit('Network.loadingFinished',{requestId:row.id,timestamp:row.finishedMonotonic});};
 const response=(source,{worker=false,headers=Promise.resolve({}),bodyFailure}={})=>{const request={url:()=>source.url,method:()=>source.method,frame:()=>frame,headers:()=>({}),postData:()=>null,resourceType:()=>source.resourceType};page.emit('request',request);const original={request:()=>request,url:()=>source.url,status:()=>200,ok:()=>true,allHeaders:()=>headers,body:async()=>{if(bodyFailure)throw Error(bodyFailure);return worker?a.worker:a.files.get(source.path);},finished:async()=>{assert.equal(worker,true);finished++;return null;}};page.emit('response',original);return{request,response:original};};
 const workerCandidates=()=>{for(const id of['worker-one','worker-two'])cdp.emit('Network.requestWillBeSent',{requestId:id,frameId:scope.frameId,type:'Script',timestamp:1.11,wallTime:(a.args.timeOrigin+110)/1000,request:{url:a.responses[2].url,method:'GET'}});};
 return{evidence,transfer,response,workerCandidates,get finished(){return finished;},async close(){await evidence.close().catch(()=>{});await rm(out,{recursive:true,force:true});}};
}

test('real collector binds two distinct native Request/Response bodies without selecting a CDP candidate',async()=>{
 const a=fixture(),c=await collector(a);try{
  c.transfer(a.requests[0]);c.transfer(a.requests[1]);c.response(a.responses[0]);c.response(a.responses[1]);await c.evidence.drain();c.workerCandidates();c.response(a.responses[2],{worker:true});c.response(a.responses[3],{worker:true});await c.evidence.drain();
  const rows=c.evidence.responses.filter(r=>r.worker_response_finished);assert.equal(rows.length,2);assert.equal(c.finished,2);assert.notEqual(rows[0].request_id,rows[1].request_id);assert.notEqual(rows[0].id,rows[1].id);
  for(const row of rows){assert.equal(row.deliveryProof.deliveryRequestId,row.request_id);assert.equal(row.deliveryProof.deliveryResponseId,row.id);assert.equal(row.cdp_request_id,undefined);assert.equal(row.rawBodyDiagnostic.requestId,undefined);assert.deepEqual(row.cdp_request_ids,['worker-one','worker-two']);assert.equal(row.rawBodyDiagnostic.playwrightRequestId,row.request_id);assert.equal(row.rawBodyDiagnostic.resolvedByIndependentDelivery,true);}
  const proofs=rows.map(r=>structuredClone(r.deliveryProof));c.transfer(a.requests[2]);c.response(a.responses[4]);await c.evidence.drain();assert.deepEqual(rows.map(r=>r.deliveryProof),proofs);assert.deepEqual(c.evidence.errors,[]);
  c.evidence.cdp.emit('Network.loadingFailed',{requestId:'worker-two',errorText:'net::ERR_ABORTED'});await c.evidence.drain();assert.ok(c.evidence.errors.includes('GENERATED_SCRIPT_CDP_SCOPE_UNPROVEN'));assert.ok(rows.every(row=>row.rawBodyDiagnostic.resolvedByIndependentDelivery===false));
 }finally{await c.close();}
});

test('native response registration precedes delayed headers and worker proof waits only for earlier source bodies',async()=>{
 const a=fixture(),c=await collector(a);let release;const delayedHeaders=new Promise(resolve=>{release=resolve;});try{
  c.transfer(a.requests[0]);c.transfer(a.requests[1]);c.response(a.responses[0]);c.response(a.responses[1],{headers:delayedHeaders});c.workerCandidates();c.response(a.responses[2],{worker:true});c.response(a.responses[3],{worker:true});
  assert.deepEqual(c.evidence.responses.map(r=>r.url),a.responses.slice(0,4).map(r=>r.url));assert.deepEqual(c.evidence.responses.map(r=>r.id),[1,2,3,4]);assert.equal(c.evidence.responses[1].headers,null);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(c.finished,2);assert.ok(c.evidence.responses.slice(2).every(r=>r.rawBodyDiagnostic?.resolvedByIndependentDelivery===false));
  release({'content-type':'text/javascript'});await c.evidence.drain();assert.deepEqual(c.evidence.errors,[]);
  for(const row of c.evidence.responses.slice(2)){assert.deepEqual(row.deliveryProof.sourceBodyFacts.map(f=>f.responseId),[1,2]);assert.deepEqual(row.deliveryProof.sourceBodyFacts.map(f=>f.requestId),[1,2]);assert.equal(row.rawBodyDiagnostic.resolvedByIndependentDelivery,true);}
 }finally{release?.({});await c.close();}
});

test('an earlier native source body failure remains refusal after delayed headers finish',async()=>{
 const a=fixture(),c=await collector(a);let release;const delayedHeaders=new Promise(resolve=>{release=resolve;});try{
  c.transfer(a.requests[0]);c.transfer(a.requests[1]);c.response(a.responses[0]);c.response(a.responses[1],{headers:delayedHeaders,bodyFailure:'ORIGINAL_BODY_UNAVAILABLE'});c.workerCandidates();c.response(a.responses[2],{worker:true});release({});await c.evidence.drain();
  assert.ok(c.evidence.errors.includes('ORIGINAL_BODY_UNAVAILABLE'));assert.ok(c.evidence.errors.includes('GENERATED_SCRIPT_RECEIVED_INPUT_BODY_PIN_REQUIRED'));assert.equal(c.evidence.responses[2].rawBodyDiagnostic.resolvedByIndependentDelivery,false);
 }finally{release?.({});await c.close();}
});
