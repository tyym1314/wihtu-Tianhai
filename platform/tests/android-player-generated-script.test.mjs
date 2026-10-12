import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {deriveDracoWorkerPin,dracoWorkerResourcePins,resourceEvidenceConfiguration,installConsumedImageEvidence,validateConsumedImageEvidence,generatedScriptProofForResponse,deliveryProofForRow} from '../scripts/android-player-resource-evidence.mjs';

const origin='https://owned.example',entryUrl=origin+'/player?app_id=fixture',nonce='native-worker-test-0123456789',documentId='a'.repeat(32),timeOrigin=1000;
const hash=data=>createHash('sha256').update(data).digest('hex'),loaderPath='/arena/assets/DRACOLoader-fixture.js',decoderPath='/arena/assets/draco_wasm_wrapper-fixture.js',imagePath='/arena/assets/image-fixture.webp';
const workerBody='onmessage=()=>postMessage("actual decoded geometry");',decoder=Buffer.from('function DracoDecoderModule(){/* actual pinned decoder text */}');
const loader=Buffer.from('class D{init(){const n=W.toString(),t=["/* draco decoder */",r,"","/* worker */",n.substring(n.indexOf("{")+1,n.lastIndexOf("}"))].join(`\n`);this.workerSourceURL=URL.createObjectURL(new Blob([t]))}}function W(){'+workerBody+'}export{D};\n');
const worker=Buffer.from(['/* draco decoder */',decoder.toString(),'','/* worker */',workerBody].join('\n'));
const manifest={expected:new Map([[loaderPath,hash(loader)],[decoderPath,hash(decoder)],[imagePath,hash('actual image')]])};
const recipe=deriveDracoWorkerPin({origin,manifest,loaderUrl:origin+loaderPath,loaderBytes:loader,decoderUrl:origin+decoderPath,decoderBytes:decoder});
const config=resourceEvidenceConfiguration({origin,entryUrl,games:['golf'],manifest,nonce,generatedScripts:[recipe]}),scope={frameId:'actual-child',contextId:9};
// Local source transfers finish at document-relative 40/70 ms, before the
// native Blob observation at 100 ms. CDP monotonic seconds have their own
// anchor; wall time uses the collector's original per-request conversion.
const blobObservationStartMs=100;
const gets=recipe.sourcePins.map((pin,i)=>{
 const start=20+i*30,end=40+i*30,startedAtMs=timeOrigin+start,startedMonotonic=1+start/1000,finishedMonotonic=1+end/1000;
 return{id:'original-public-'+i,url:origin+pin.path,frameId:scope.frameId,contextId:scope.contextId,type:pin.role==='decoder-text'?'Fetch':'Script',method:'GET',transferFinished:true,response:{status:200,fromServiceWorker:false},startedAtMs,startedMonotonic,finishedMonotonic,finishedAtMs:startedAtMs+(finishedMonotonic-startedMonotonic)*1000};
});
const bodyPins=recipe.sourcePins.map((pin,i)=>({id:i+1,request_id:i+1,url:origin+pin.path,frame:origin+'/play/golf',method:'GET',status:200,pin:{sha256:pin.sha256},original_sha256:pin.sha256,original_bytes:pin.bytes}));
function actualRealm({configuration=config}={}){
 const original=new WeakMap();class ResponseFixture{constructor(blob){original.set(this,Promise.resolve(blob));}get url(){return origin+imagePath;}get status(){return 200;}get type(){return'basic';}blob(){return original.get(this);}}
 let id=0,clock=blobObservationStartMs;class NativeURL extends URL{static createObjectURL(){return'blob:'+origin+'/'+String(++id).padStart(8,'0')+'-0000-0000-0000-000000000000';}static revokeObjectURL(){}}
 const parent={location:{href:entryUrl}},realm=vm.createContext({URL:NativeURL,Response:ResponseFixture,Blob,parent,top:parent,location:{href:origin+'/play/golf'},crypto:webcrypto,performance:{timeOrigin,now:()=>clock++},setTimeout,clearTimeout,__oasisPhysicalPerf:{schema:'android-physical-performance-v1',nonce,documentId,timeOrigin,url:origin+'/play/golf'}});
 vm.runInContext('('+installConsumedImageEvidence.toString()+')('+JSON.stringify(configuration)+')',realm);return realm;
}
const snapshot=realm=>JSON.parse(JSON.stringify(realm.__oasisConsumedImageEvidence.snapshot()));
const args={origin,entryUrl,game:'golf',nonce,documentId,timeOrigin,scope,manifest,requests:gets,generatedScripts:[recipe]};
async function generated(options){const realm=actualRealm(options),blob=new realm.Blob([worker]),url=realm.URL.createObjectURL(blob);await realm.__oasisConsumedImageEvidence.drain(1000);return {realm,blob,url,snap:snapshot(realm)};}

test('exact Draco derivation rejects wrong local input SHA and altered synthesis; original worker bytes equal the independent expected recipe',()=>{
 assert.equal(recipe.bytes,worker.length);assert.equal(recipe.sha256,hash(worker));assert.equal(recipe.workerFunctionSha256,hash(workerBody));
 assert.throws(()=>deriveDracoWorkerPin({origin,manifest,loaderUrl:origin+loaderPath,loaderBytes:Buffer.from('wrong'),decoderUrl:origin+decoderPath,decoderBytes:decoder}),/SOURCE_SHA_MISMATCH/);
 const changed=Buffer.from(loader.toString().replace('/* worker */','/* foreign worker */')),altered={expected:new Map([...manifest.expected,[loaderPath,hash(changed)]])};
 assert.throws(()=>deriveDracoWorkerPin({origin,manifest:altered,loaderUrl:origin+loaderPath,loaderBytes:changed,decoderUrl:origin+decoderPath,decoderBytes:decoder}),/RECIPE_UNPROVEN/);
});

test('local derivation inputs must be real manifest output files, hash-matched and never symlinks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'actual-worker-pins-')),dir=join(root,'arena/dist/assets');await mkdir(dir,{recursive:true});
 try{await writeFile(join(dir,'DRACOLoader-fixture.js'),loader);await writeFile(join(dir,'draco_wasm_wrapper-fixture.js'),decoder);assert.deepEqual(await dracoWorkerResourcePins({origin,manifest,root}),[recipe]);await writeFile(join(dir,'draco_wasm_wrapper-fixture.js'),'changed actual file');await assert.rejects(dracoWorkerResourcePins({origin,manifest,root}),/SOURCE_SHA_MISMATCH/);await rm(join(dir,'draco_wasm_wrapper-fixture.js'));await symlink(join(dir,'DRACOLoader-fixture.js'),join(dir,'draco_wasm_wrapper-fixture.js'));await assert.rejects(dracoWorkerResourcePins({origin,manifest,root}),/OUTPUT_FILE_REQUIRED/);}finally{await rm(root,{recursive:true,force:true});}
});

test('same native generated Blob/objectURL has exact script bytes, retains source pins, and requires readable original worker response and both received public bodies',async()=>{
 const f=await generated();assert.deepEqual(f.snap.errors,[]);assert.equal(f.snap.receipts.length,0);assert.equal(f.snap.generatedReceipts.length,1);assert.equal(f.snap.totalHashedBytes,worker.length);
 const evidence=validateConsumedImageEvidence(f.snap,args),row={id:3,request_id:3,url:f.url,frameId:scope.frameId,contextId:scope.contextId,resourceType:'script',method:'GET',status:200,transferFinished:true,original_bytes:worker.length,original_sha256:hash(worker)};
 const proof=generatedScriptProofForResponse(row,evidence,{origin,manifest,bodyPins});assert.equal(proof.sha256,hash(worker));assert.equal(proof.blobObservedAtMs,timeOrigin+blobObservationStartMs);
 assert.deepEqual(proof.sourceRequestIds,gets.map(get=>get.id));assert.ok(proof.sourceRequestFacts.every(get=>get.finishedAtMs<proof.blobObservedAtMs));assert.deepEqual(proof.sourceBodyFacts.map(body=>[body.requestId,body.responseId]),[[1,1],[2,2]]);assert.equal(proof.deliveryRequestId,3);assert.equal(proof.deliveryResponseId,3);
 for(const mutation of [{original_bytes:0},{original_sha256:hash('nonempty conflicting script')},{transferFinished:false},{contextId:10},{resourceType:'image'},{method:'POST'},{id:undefined},{request_id:undefined}])assert.throws(()=>generatedScriptProofForResponse({...row,...mutation},evidence,{origin,manifest,bodyPins}));
 for(const pins of [bodyPins.slice(1),bodyPins.map(pin=>({...pin,pin:undefined})),bodyPins.map(pin=>({...pin,original_sha256:hash('conflict')})),bodyPins.map(pin=>({...pin,id:undefined})),bodyPins.map(pin=>({...pin,request_id:undefined})),bodyPins.map(pin=>({...pin,id:3})),bodyPins.map(pin=>({...pin,request_id:3}))])assert.throws(()=>generatedScriptProofForResponse(row,evidence,{origin,manifest,bodyPins:pins}),/RECEIVED_INPUT_BODY_PIN_REQUIRED/);
 f.realm.__oasisConsumedImageEvidence.stop();
});

test('generated Blob provenance refuses missing or changed source clocks and sources that finish after the Blob',async()=>{
 const f=await generated();
 try{
  for(const mutate of [get=>delete get.startedAtMs,get=>delete get.startedMonotonic,get=>delete get.finishedAtMs,get=>delete get.finishedMonotonic,get=>get.finishedAtMs++,get=>get.finishedMonotonic=get.startedMonotonic-1,get=>{get.startedAtMs=timeOrigin-1;get.finishedAtMs=get.startedAtMs+(get.finishedMonotonic-get.startedMonotonic)*1000;}]){
   const requests=structuredClone(gets);mutate(requests[1]);assert.throws(()=>validateConsumedImageEvidence(f.snap,{...args,requests}),/GENERATED_SCRIPT_SOURCE_CLOCK_UNPROVEN/);
  }
  const later=structuredClone(gets);later[1].finishedMonotonic=later[1].startedMonotonic+1;later[1].finishedAtMs=later[1].startedAtMs+(later[1].finishedMonotonic-later[1].startedMonotonic)*1000;
  assert.ok(later[1].finishedAtMs>timeOrigin+f.snap.generatedReceipts[0].createdAt);assert.throws(()=>validateConsumedImageEvidence(f.snap,{...args,requests:later}),/GENERATED_SCRIPT_SOURCE_GET_UNPROVEN/);
 }finally{f.realm.__oasisConsumedImageEvidence.stop();}
});

test('unknown bytes/images, wrong document and wrong/unfinished/foreign original source GET remain failures',async()=>{
 const realm=actualRealm();realm.URL.createObjectURL(new realm.Blob(['unknown image or code']));await realm.__oasisConsumedImageEvidence.drain(1000);assert.ok(snapshot(realm).errors.includes('RESOURCE_UNKNOWN_BLOB'));
 const f=await generated();for(const changed of [{requests:gets.slice(1)},{requests:gets.map(get=>({...get,transferFinished:false}))},{requests:gets.map(get=>({...get,contextId:8}))},{requests:gets.map(get=>({...get,response:{status:200,fromServiceWorker:true}}))},{generatedScripts:[]},{documentId:'b'.repeat(32)}])assert.throws(()=>validateConsumedImageEvidence(f.snap,{...args,...changed}));
 const foreign=structuredClone(f.snap);foreign.generatedReceipts[0].recipe.sourcePins[0].sha256=hash('wrong script');assert.throws(()=>validateConsumedImageEvidence(foreign,args),/RECIPE_CHANGED/);
 f.realm.__oasisConsumedImageEvidence.stop();
});

test('CSS Image GET at a reused public URL is separate from the actual Response.blob Fetch source; two Fetch deliveries stay ambiguous',async()=>{
 const realm=actualRealm(),response=new realm.Response(new Blob(['actual image'])),blob=await response.blob();realm.URL.createObjectURL(blob);await realm.__oasisConsumedImageEvidence.drain(1000);
 const source={id:'originalFetch',url:origin+imagePath,frameId:scope.frameId,type:'Fetch',method:'GET',transferFinished:true,response:{status:200,fromServiceWorker:false}},css={...source,id:'lateCSSImage',type:'Image',transferFinished:false};
 const evidence=validateConsumedImageEvidence(snapshot(realm),{...args,requests:[source,css]});assert.equal(evidence.verifiedReceipts,1);
 assert.throws(()=>deliveryProofForRow({...css,transferFinished:true},evidence,{origin,manifest}),/PUBLIC_RESPONSE_NOT_CONSUMED_BLOB_SOURCE/);
 assert.throws(()=>validateConsumedImageEvidence(snapshot(realm),{...args,requests:[css]}),/SOURCE_GET_AMBIGUOUS/);
 assert.throws(()=>validateConsumedImageEvidence(snapshot(realm),{...args,requests:[source,{...source,id:'duplicateFetch'}]}),/SOURCE_GET_AMBIGUOUS/);
 realm.__oasisConsumedImageEvidence.stop();
});

test('retained loader output aliases with identical derived bytes require exactly one actual delivered module graph',async()=>{
 const retainedPath='/arena/assets/DRACOLoader-retained.js',retainedBytes=Buffer.from(loader.toString().replace('class D{','class E{').replace('export{D}','export{E}')),actual={expected:new Map([...manifest.expected,[retainedPath,hash(retainedBytes)]])};
 const retained=deriveDracoWorkerPin({origin,manifest:actual,loaderUrl:origin+retainedPath,loaderBytes:retainedBytes,decoderUrl:origin+decoderPath,decoderBytes:decoder}),profiles=[recipe,retained];assert.equal(retained.sha256,recipe.sha256);
 const configuration=resourceEvidenceConfiguration({origin,entryUrl,games:['golf'],manifest:actual,nonce,generatedScripts:profiles}),f=await generated({configuration});assert.deepEqual(f.snap.errors,[]);assert.equal(f.snap.generatedReceipts[0].recipe,null);assert.equal(f.snap.generatedReceipts[0].recipeCandidates.length,2);
 const evidence=validateConsumedImageEvidence(f.snap,{...args,manifest:actual,generatedScripts:profiles});assert.equal(evidence.byGeneratedBlob.get(f.url).sourcePins[0].path,loaderPath);
 const both=[...gets,{...gets[0],id:'retained-module',url:origin+retainedPath}];assert.throws(()=>validateConsumedImageEvidence(f.snap,{...args,manifest:actual,generatedScripts:profiles,requests:both}),/ACTIVE_MODULE_AMBIGUOUS/);
 f.realm.__oasisConsumedImageEvidence.stop();
});
