import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectPlayerEvidence,closePlayerObservation} from '../scripts/android-player-acceptance.mjs';
import {createPlayerEvidenceRedactor,playerEvidenceHash} from '../scripts/android-player-acceptance-checks.mjs';
import {deriveDracoWorkerPin} from '../scripts/android-player-resource-evidence.mjs';

const origin='https://owned.example',entryUrl=origin+'/player?app_id=app_fixture',game='golf';
const sourceUrl=origin+'/arena/assets/actual-image.webp',blobUrl='blob:'+origin+'/00000001-0000-0000-0000-000000000000';
const bytes=Buffer.from('actual game-consumed immutable image'),frameId='own-child',contextId=7,documentId='a'.repeat(32),timeOrigin=1000;
const loaderPath='/arena/assets/DRACOLoader-test.js',decoderPath='/arena/assets/draco_wasm_wrapper-test.js',workerBlobUrl='blob:'+origin+'/00000002-0000-0000-0000-000000000000',workerFunction='onmessage=()=>postMessage("decoded");',decoder=Buffer.from('function DracoDecoderModule(){}');
const loader=Buffer.from('class D{init(){const n=W.toString(),t=["/* draco decoder */",r,"","/* worker */",n.substring(n.indexOf("{")+1,n.lastIndexOf("}"))].join(`\n`);this.workerSourceURL=URL.createObjectURL(new Blob([t]))}}function W(){'+workerFunction+'}export{D};\n'),workerBytes=Buffer.from(['/* draco decoder */',decoder.toString(),'','/* worker */',workerFunction].join('\n'));

async function fixture({body='empty',worker=false,snapshotChange=()=>{},rawChange=()=>{},stopChange=()=>{},frameUrl=origin+'/play/'+game}={}){
 const out=await mkdtemp(join(tmpdir(),'player-evidence-collector-')),page=new EventEmitter(),cdp=new EventEmitter(),calls=[],init=[];
 const top={url:()=>entryUrl},child={url:()=>frameUrl,parentFrame:()=>top},manifest={expected:new Map([['/index.html',playerEvidenceHash(Buffer.from('real html'))],['/arena/index.html',playerEvidenceHash(Buffer.from('arena html'))],['/arena/assets/actual-image.webp',playerEvidenceHash(bytes)]])};
 page.url=()=>entryUrl;page.mainFrame=()=>top;page.frames=()=>[top,child];
 let workerRecipe,resourceOutputRoot;
 if(worker){manifest.expected.set(loaderPath,playerEvidenceHash(loader));manifest.expected.set(decoderPath,playerEvidenceHash(decoder));workerRecipe=deriveDracoWorkerPin({origin,manifest,loaderUrl:origin+loaderPath,loaderBytes:loader,decoderUrl:origin+decoderPath,decoderBytes:decoder});resourceOutputRoot=join(out,'actual-output');const dir=join(resourceOutputRoot,'arena/dist/assets');await mkdir(dir,{recursive:true});await writeFile(join(dir,'DRACOLoader-test.js'),loader);await writeFile(join(dir,'draco_wasm_wrapper-test.js'),decoder);}
 const context={async newCDPSession(){return cdp;},async addInitScript(fn,args){init.push({fn,args,disposed:false});return{async dispose(){init.find(row=>row.fn===fn).disposed=true;}};}};
 const snapshot=()=>{
  const nonce=init.find(row=>row.args?.nonce)?.args.nonce;
  const value={schema:'owned-player-resource-evidence-v1',game,identity:{nonce,documentId,timeOrigin,url:origin+'/play/'+game,parentUrl:entryUrl},phase:'loading',pendingTasks:0,totalHashedBytes:bytes.length,errors:[],receipts:[{id:1,sourceUrl,status:200,type:'basic',bytes:bytes.length,sha256:playerEvidenceHash(bytes),createdAt:1,completedAt:4,hashDurationMs:3,hashStarted:true,hashComplete:true,blobUrls:[{url:blobUrl,createdAt:2,revokedAt:null}]}]};
  if(worker){value.totalHashedBytes+=workerBytes.length;value.generatedReceipts=[{id:1,kind:'generated-script',bytes:workerBytes.length,sha256:playerEvidenceHash(workerBytes),createdAt:5,completedAt:8,hashDurationMs:3,hashStarted:true,hashComplete:true,recipe:workerRecipe,blobUrls:[{url:workerBlobUrl,createdAt:6,revokedAt:null}]}];}
  snapshotChange(value);
  return value;
 };
 cdp.send=async(method,args)=>{
  calls.push({method,args});
  if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'top',url:entryUrl},childFrames:[{frame:{id:frameId,parentId:'top',url:frameUrl}}]}};
  if(method==='Runtime.evaluate'){const value=snapshot();if(args.expression.includes('.stop()')){value.phase='closed';stopChange(value);}return{result:{value:args.expression.includes('snapshot:')?{owner:{schema:'android-physical-performance-v1',nonce:value.identity.nonce,documentId,timeOrigin,url:frameUrl},snapshot:value}:value}};}
  return{};
 };
 cdp.detach=async()=>calls.push({method:'detach'});
 const result={raw_response_work_pending:0},evidence=await collectPlayerEvidence({context,page,origin,manifest,out,redactor:createPlayerEvidenceRedactor(),result,resourceDrainTimeoutMs:100,resourceOutputRoot});
 cdp.emit('Page.frameNavigated',{frame:{id:frameId,parentId:'top',url:frameUrl}});
 cdp.emit('Runtime.executionContextCreated',{context:{id:contextId,origin,auxData:{isDefault:true,frameId}}});
 const transfer=(id,url,type='Fetch',{finished=true,responded=true,status=200,serviceWorker=false}={})=>{
  const start={requestId:id,frameId,type,timestamp:1,wallTime:100,request:{url,method:'GET',headers:{}}};
  rawChange(start);
  cdp.emit('Network.requestWillBeSent',start);
  if(responded)cdp.emit('Network.responseReceived',{requestId:id,response:{status,protocol:'h2',mimeType:'image/webp',fromDiskCache:true,fromServiceWorker:serviceWorker}});
  if(finished)cdp.emit('Network.loadingFinished',{requestId:id,timestamp:2,encodedDataLength:0});
 };
 const response=(url,{resourceType='fetch',body:bodyOverride,ok=true}={})=>{
  const request={url:()=>url,method:()=> 'GET',frame:()=>child,headers:()=>({}),postData:()=>null,resourceType:()=>resourceType};
  const selected=bodyOverride??body;
  const item={url:request.url,request:()=>request,status:()=>ok?200:503,ok:()=>ok,allHeaders:async()=>({}),finished:async()=>null,body:async()=>{
   if(selected==='unavailable')throw Error('WEBVIEW_RESPONSE_BODY_UNAVAILABLE');
   if(selected==='empty')return Buffer.alloc(0);
   if(selected==='actual')return bytes;
   return Buffer.from(selected);
  }};
  page.emit('request',request);page.emit('response',item);return item;
 };
 const cleanup=async()=>{await evidence.close().catch(()=>{});await rm(out,{recursive:true,force:true});};
 return{out,page,cdp,context,calls,init,evidence,result,transfer,response,cleanup};
}

test('empty own-image CDP body and generated blob require exact original consumed-byte proof, retaining diagnostics',async()=>{
 const f=await fixture();
 try{
  f.transfer('originalGET',sourceUrl);f.response(sourceUrl);
  f.transfer('blobGET',blobUrl,'Image');f.response(blobUrl,{resourceType:'image'});
  await f.evidence.drain();
  assert.deepEqual(f.evidence.errors,[]);
  const rows=f.evidence.responses.filter(row=>row.rawBodyDiagnostic);
  assert.equal(rows.length,2);assert.equal(rows.every(row=>row.rawBodyDiagnostic.resolvedByIndependentDelivery===true),true);
  assert.equal(rows.every(row=>row.original_bytes===0),true);
  assert.equal(rows.every(row=>row.deliveryProof.sha256===playerEvidenceHash(bytes)),true);
  assert.equal(rows.every(row=>row.deliveryProof.sourceRequestId==='originalGET'),true);
  await f.evidence.save();
  const saved=JSON.parse(await readFile(join(f.out,'network-bodies.json'),'utf8'));
  assert.equal(saved.rawBodyDiagnostics.length,2);
  assert.equal(saved.rawBodyDiagnostics.every(row=>row.resolvedByIndependentDelivery),true);
  assert.equal(f.calls.some(row=>row.method==='Network.getResponseBody'),false,'proof does not refetch image');
 }finally{await f.cleanup();}
});

test('derived native worker accepts two readable exact Script deliveries without pretending main-frame CDP worker transfers finished',async()=>{
 const f=await fixture({worker:true});
 try{
  f.transfer('originalGET',sourceUrl);f.response(sourceUrl,{body:'actual'});
  f.transfer('originalLoader',origin+loaderPath,'Script');f.response(origin+loaderPath,{resourceType:'script',body:loader});
  f.transfer('originalDecoder',origin+decoderPath);f.response(origin+decoderPath,{body:decoder});await f.evidence.drain();
  f.transfer('worker1',workerBlobUrl,'Script',{finished:false,responded:false});f.transfer('worker2',workerBlobUrl,'Script',{finished:false,responded:false});
  f.response(workerBlobUrl,{resourceType:'script',body:workerBytes});f.response(workerBlobUrl,{resourceType:'script',body:workerBytes});await f.evidence.drain();
  assert.deepEqual(f.evidence.errors,[]);const workers=f.evidence.responses.filter(row=>row.worker_response_finished);
  assert.equal(workers.length,2);assert.equal(workers.every(row=>row.pin.sha256===playerEvidenceHash(workerBytes)&&row.rawBodyDiagnostic.resolvedByIndependentDelivery),true);
  assert.equal(workers.every(row=>row.rawBodyDiagnostic.mainFrameCdpWorkerTransfers.every(transfer=>!transfer.transferFinished&&transfer.response===null)),true);
  await f.evidence.save();assert.match(await readFile(join(f.out,'network-bodies.json'),'utf8'),/UNPINNED_PLAYER_RESOURCE/);
 }finally{await f.cleanup();}
});

test('worker original bodies cannot be empty/unreadable/conflicting and both received public input pins are mandatory',async()=>{
 for(const options of [{workerBody:'empty'},{workerBody:'unavailable'},{workerBody:'conflicting nonempty script'},{omitDecoder:true}]){
  const f=await fixture({worker:true});
  try{f.transfer('originalGET',sourceUrl);f.response(sourceUrl,{body:'actual'});f.transfer('originalLoader',origin+loaderPath,'Script');f.response(origin+loaderPath,{resourceType:'script',body:loader});f.transfer('originalDecoder',origin+decoderPath);if(!options.omitDecoder)f.response(origin+decoderPath,{body:decoder});await f.evidence.drain();f.transfer('worker',workerBlobUrl,'Script',{finished:false,responded:false});f.response(workerBlobUrl,{resourceType:'script',body:options.workerBody||workerBytes});await f.evidence.drain();assert.ok(f.evidence.errors.length>0,JSON.stringify(options));assert.equal(f.evidence.responses.at(-1).rawBodyDiagnostic?.resolvedByIndependentDelivery===true,false);if(options.workerBody==='conflicting nonempty script')assert.ok(f.evidence.errors.some(error=>error.includes('RESOURCE_NONEMPTY_CDP_BODY_CONFLICT')));if(options.omitDecoder)assert.ok(f.evidence.errors.some(error=>error.includes('GENERATED_SCRIPT_RECEIVED_INPUT_BODY_PIN_REQUIRED')));}
  finally{await f.cleanup();}
 }
});

test('unreadable image body can be resolved without claiming raw response success; nonempty conflicting public bytes remain fatal',async()=>{
 const unavailable=await fixture({body:'unavailable'});
 try{unavailable.transfer('originalGET',sourceUrl);unavailable.response(sourceUrl);await unavailable.evidence.drain();assert.deepEqual(unavailable.evidence.errors,[]);const row=unavailable.evidence.responses[0];assert.equal(row.rawBodyDiagnostic.originalError,'WEBVIEW_RESPONSE_BODY_UNAVAILABLE');assert.equal(row.rawBodyDiagnostic.resolvedByIndependentDelivery,true);assert.equal(row.original_bytes,undefined);}
 finally{await unavailable.cleanup();}
 const wrong=await fixture({body:'wrong nonempty image'});
 try{wrong.transfer('originalGET',sourceUrl);wrong.response(sourceUrl);await wrong.evidence.drain();assert.ok(wrong.evidence.errors.some(error=>error.includes('PLAYER_RESOURCE_BODY_SHA_MISMATCH')));assert.equal(wrong.evidence.responses[0].rawBodyDiagnostic.nonemptyPublicBodyConflict,true);assert.equal(wrong.evidence.responses[0].rawBodyDiagnostic.resolvedByIndependentDelivery,false);}
 finally{await wrong.cleanup();}
});

test('readable original bytes stay pinned; a generated blob with nonempty conflicting bytes cannot borrow good source proof',async()=>{
 const good=await fixture({body:'actual'});
 try{good.transfer('originalGET',sourceUrl);good.response(sourceUrl);await good.evidence.drain();assert.deepEqual(good.evidence.errors,[]);assert.equal(good.evidence.responses[0].pin.sha256,playerEvidenceHash(bytes));assert.equal(good.evidence.responses[0].rawBodyDiagnostic,undefined);}
 finally{await good.cleanup();}
 const bad=await fixture();
 try{bad.transfer('originalGET',sourceUrl);bad.response(sourceUrl);bad.transfer('blobGET',blobUrl,'Image');bad.response(blobUrl,{resourceType:'image',body:'wrong blob bytes'});await bad.evidence.drain();assert.ok(bad.evidence.errors.some(error=>error.includes('RESOURCE_NONEMPTY_CDP_BODY_CONFLICT')));}
 finally{await bad.cleanup();}
});

test('missing native Blob, foreign document, unfinished source GET, SW delivery and ambiguous GET remain failures',async()=>{
 for(const options of [
  {snapshotChange:value=>{value.receipts=[];value.totalHashedBytes=0;}},
  {snapshotChange:value=>value.identity.documentId='b'.repeat(32)},
  {snapshotChange:value=>value.errors.push('RESOURCE_CONSUMED_BLOB_SHA_MISMATCH')},
  {source:{finished:false}},
  {source:{serviceWorker:true}},
  {duplicate:true}
 ]){
  const f=await fixture(options);
  try{
   f.transfer('originalGET',sourceUrl,'Fetch',options.source);if(options.duplicate)f.transfer('duplicateGET',sourceUrl);
   f.response(sourceUrl);await f.evidence.drain();
   assert.ok(f.evidence.errors.length>0,JSON.stringify(options));assert.equal(f.evidence.responses[0].rawBodyDiagnostic.resolvedByIndependentDelivery,false);
  }finally{await f.cleanup();}
 }
});

test('unknown blob and non-image/non-owned resources do not get alternate delivery acceptance',async()=>{
 const unknown=await fixture();
 try{unknown.transfer('originalGET',sourceUrl);unknown.response(sourceUrl);const url='blob:'+origin+'/11111111-0000-0000-0000-000000000000';unknown.transfer('unknown',url,'Image');unknown.response(url,{resourceType:'image'});await unknown.evidence.drain();assert.ok(unknown.evidence.errors.some(error=>error.includes('RESOURCE_ALTERNATIVE_DELIVERY_UNPROVEN')));}
 finally{await unknown.cleanup();}
 const api=await fixture({body:'unavailable'});
 try{api.response(origin+'/api/player/wallet?app_id=app_fixture');await api.evidence.drain();assert.ok(api.evidence.errors.includes('WEBVIEW_RESPONSE_BODY_UNAVAILABLE'));}
 finally{await api.cleanup();}
 const imageApi=await fixture({body:'unavailable'});
 try{imageApi.response(origin+'/api/player/private.webp',{resourceType:'image'});await imageApi.evidence.drain();assert.ok(imageApi.evidence.errors.includes('WEBVIEW_RESPONSE_BODY_UNAVAILABLE'));assert.equal(imageApi.evidence.rawBodyDiagnostics.length,0);}
 finally{await imageApi.cleanup();}
 const html=await fixture({body:'wrong document'});
 try{html.response(entryUrl,{resourceType:'document'});await html.evidence.drain();assert.ok(html.evidence.errors.some(error=>error.includes('PLAYER_RESOURCE_BODY_SHA_MISMATCH')));}
 finally{await html.cleanup();}
});

test('a destroyed exact game realm can use its already retained proof for a late blob; a new realm cannot borrow it',async()=>{
 const retired=await fixture();
 try{
  retired.transfer('originalGET',sourceUrl);retired.response(sourceUrl);await retired.evidence.drain();
  retired.transfer('lateBlob',blobUrl,'Image');retired.cdp.emit('Runtime.executionContextDestroyed',{executionContextId:contextId});retired.response(blobUrl,{resourceType:'image'});await retired.evidence.drain();
  assert.deepEqual(retired.evidence.errors,[]);assert.equal(retired.evidence.responses[1].deliveryProof.contextId,contextId);
 }finally{await retired.cleanup();}
 const changed=await fixture();
 try{
  changed.transfer('originalGET',sourceUrl);changed.response(sourceUrl);await changed.evidence.drain();
  changed.cdp.emit('Runtime.executionContextDestroyed',{executionContextId:contextId});changed.cdp.emit('Runtime.executionContextCreated',{context:{id:8,origin,auxData:{isDefault:true,frameId}}});
  changed.transfer('newRealmBlob',blobUrl,'Image');changed.response(blobUrl,{resourceType:'image'});await changed.evidence.drain();
  assert.ok(changed.evidence.errors.some(error=>error.includes('RESOURCE_SOURCE_CONTEXT_CHANGED')));assert.equal(changed.evidence.responses[1].rawBodyDiagnostic.resolvedByIndependentDelivery,false);
 }finally{await changed.cleanup();}
});

test('a later duplicate source GET revokes retained proof; source redirects and foreign frame cannot resolve an empty body',async()=>{
 const duplicate=await fixture();
 try{duplicate.transfer('originalGET',sourceUrl);duplicate.response(sourceUrl);await duplicate.evidence.drain();assert.deepEqual(duplicate.evidence.errors,[]);duplicate.transfer('laterDuplicate',sourceUrl);await duplicate.evidence.drain();assert.ok(duplicate.evidence.errors.some(error=>error.includes('RESOURCE_SOURCE_GET_AMBIGUOUS')));assert.equal(duplicate.evidence.responses[0].rawBodyDiagnostic.resolvedByIndependentDelivery,false);}
 finally{await duplicate.cleanup();}
 const redirect=await fixture({rawChange:event=>{event.redirectResponse={status:302};}});
 try{redirect.transfer('redirectedGET',sourceUrl);redirect.response(sourceUrl);await redirect.evidence.drain();assert.ok(redirect.evidence.errors.some(error=>error.includes('RESOURCE_SOURCE_REDIRECT_REFUSED')));}
 finally{await redirect.cleanup();}
 const foreign=await fixture({frameUrl:origin+'/play/foreign'});
 try{foreign.transfer('foreignGET',sourceUrl);foreign.response(sourceUrl);await foreign.evidence.drain();assert.ok(foreign.evidence.errors.some(error=>error.includes('PLAYER_RESOURCE_BODY_SHA_MISMATCH')));assert.equal(foreign.evidence.rawBodyDiagnostics.length,0);}
 finally{await foreign.cleanup();}
});

test('failed delivery retains the observed snapshot and closing hook errors remain fatal while all listeners dispose',async()=>{
 const failure=await fixture({snapshotChange:value=>value.errors.push('RESOURCE_CONSUMED_BLOB_SHA_MISMATCH')});
 try{failure.transfer('originalGET',sourceUrl);failure.response(sourceUrl);await failure.evidence.save();const saved=JSON.parse(await readFile(join(failure.out,'network-bodies.json'),'utf8'));assert.equal(saved.rawBodyDiagnostics[0].resolvedByIndependentDelivery,false);assert.deepEqual(saved.resourceSnapshots[0].snapshot.errors,['RESOURCE_CONSUMED_BLOB_SHA_MISMATCH']);}
 finally{await failure.cleanup();}
 const stopped=await fixture({stopChange:value=>value.errors.push('RESOURCE_HOOK_REPLACED')});
 try{stopped.transfer('originalGET',sourceUrl);stopped.response(sourceUrl);await stopped.evidence.drain();await assert.rejects(stopped.evidence.close(),/RESOURCE_EVIDENCE_ERRORS/);assert.ok(stopped.evidence.errors.some(error=>error.includes('RESOURCE_EVIDENCE_ERRORS')));assert.equal(stopped.init.every(row=>row.disposed),true);assert.equal(stopped.cdp.listenerCount('Network.loadingFinished'),0);}
 finally{await stopped.cleanup();}
});

test('late response failure at close revokes pass and owned init/CDP/page listeners are disposed',async()=>{
 const f=await fixture({body:'unavailable'}),result={passed:true,cleanup:{passed:true},observer_errors:[],js_errors:[],resource_errors:[],http_errors:[],network_errors:[],pending_network_observations:0},errors=[];
 try{
  const browser={async close(){f.page.emit('response',{url:()=>origin+'/api/player/wallet',request:()=>({url:()=>origin+'/api/player/wallet',method:()=> 'GET',frame:()=>({url:()=>entryUrl}),headers:()=>({}),postData:()=>null,resourceType:()=> 'fetch'}),status:()=>200,ok:()=>true,allHeaders:async()=>({}),body:async()=>{throw Error('LATE_REAL_RESPONSE_LOST');}});}};
  const holder={result,async drain(){}};
  await closePlayerObservation({browser,evidence:f.evidence,holder,errors});
  assert.equal(result.passed,false);assert.ok(errors.includes('LATE_REAL_RESPONSE_LOST'));
  assert.equal(f.page.listenerCount('request'),0);assert.equal(f.page.listenerCount('response'),0);
  assert.equal(f.init.every(row=>row.disposed),true);assert.equal(f.cdp.listenerCount('Network.loadingFinished'),0);
 }finally{await f.cleanup();}
});
