/** Actual consumed public image bytes; no Response clone/read, refetch or decoded-pixel proof. */
import assert from 'node:assert/strict';
import {RELEASED_IDS} from '../shared/games.mjs';
import {createHash} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const RESOURCE_EVIDENCE_SCHEMA='owned-player-resource-evidence-v1';
const imagePath=path=>!/^\/(?:api|v1)(?:\/|$)/.test(path)&&/\.(?:webp|png|jpe?g|svg|avif|gif)$/.test(path);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),resourceRoot=fileURLToPath(new URL('../',import.meta.url)),generatedPinsByManifest=new WeakMap();

/** The supported Three recipe is deliberately exact. No executing downloaded
 * JS, guessed function text, arbitrary generated script or prefix-only pin. */
export function deriveDracoWorkerPin({origin,manifest,loaderUrl,loaderBytes,decoderUrl,decoderBytes}){
 const inputs=[[loaderUrl,loaderBytes,'worker-function-module'],[decoderUrl,decoderBytes,'decoder-text']];
 const sourcePins=inputs.map(([url,bytes,role])=>{const u=new URL(url);assert.ok(u.origin===origin&&u.href===origin+u.pathname&&/\.js$/.test(u.pathname)&&!/^\/(?:api|v1)(?:\/|$)/.test(u.pathname),'GENERATED_SCRIPT_SOURCE_URL_INVALID');assert.equal(hash(bytes),manifest.expected.get(u.pathname),'GENERATED_SCRIPT_SOURCE_SHA_MISMATCH');return {path:u.pathname,sha256:hash(bytes),bytes:bytes.length,role};});
 const source=Buffer.from(loaderBytes).toString('utf8'),decoder=Buffer.from(decoderBytes).toString('utf8');assert.ok(Buffer.from(source).equals(Buffer.from(loaderBytes))&&Buffer.from(decoder).equals(Buffer.from(decoderBytes)),'GENERATED_SCRIPT_SOURCE_TEXT_INVALID');
 const recipe=/const ([\w$]+)=([\w$]+)\.toString\(\),([\w$]+)=\["\/\* draco decoder \*\/",([\w$]+),"","\/\* worker \*\/",\1\.substring\(\1\.indexOf\("\{"\)\+1,\1\.lastIndexOf\("\}"\)\)\]\.join\(`\n`\);this\.workerSourceURL=URL\.createObjectURL\(new Blob\(\[\3\]\)\)/g;
 const matches=[...source.matchAll(recipe)];assert.equal(matches.length,1,'GENERATED_DRACO_RECIPE_UNPROVEN');const name=matches[0][2].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const worker=new RegExp('function '+name+'\\(\\)\\{([\\s\\S]*)\\}export\\{[^\\n]*\\};\\s*$').exec(source);assert.ok(worker,'GENERATED_DRACO_WORKER_FUNCTION_UNPROVEN');
 const bytes=Buffer.from(['/* draco decoder */',decoder,'','/* worker */',worker[1]].join('\n'));
 return {kind:'manifest-derived-draco-worker-v1',sha256:hash(bytes),bytes:bytes.length,workerFunctionSha256:hash(worker[1]),sourcePins};
}

/** Read only actual local release outputs and rehash every derivation input.
 * A local recipe is an expected byte pin, never evidence of network delivery. */
export async function dracoWorkerResourcePins({origin,manifest,root=resourceRoot}){
 const loaders=[...manifest.expected.keys()].filter(path=>/^\/arena\/assets\/DRACOLoader-[A-Za-z0-9_-]+\.js$/.test(path)),decoders=[...manifest.expected.keys()].filter(path=>/^\/arena\/assets\/draco_wasm_wrapper-[A-Za-z0-9_-]+\.js$/.test(path));
 assert.ok(loaders.length<=8&&decoders.length<=1,'GENERATED_SCRIPT_RECIPE_BOUND');const pins=[];
 const output=async path=>{const file=join(root,'arena','dist',path.slice('/arena/'.length)),info=await lstat(file);assert.ok(info.isFile()&&!info.isSymbolicLink(),'GENERATED_SCRIPT_OUTPUT_FILE_REQUIRED');const bytes=await readFile(file);assert.equal(hash(bytes),manifest.expected.get(path),'GENERATED_SCRIPT_SOURCE_SHA_MISMATCH');return bytes;};
 for(const loader of loaders)for(const decoder of decoders)pins.push(deriveDracoWorkerPin({origin,manifest,loaderUrl:origin+loader,loaderBytes:await output(loader),decoderUrl:origin+decoder,decoderBytes:await output(decoder)}));
 return pins;
}

export function resourceEvidenceConfiguration({origin,entryUrl,games,manifest,nonce,generatedScripts=generatedPinsByManifest.get(manifest)||[]}){
 const base=new URL(origin),entry=new URL(entryUrl);assert.equal(base.protocol,'https:');assert.equal(base.origin,origin);assert.equal(entry.origin,origin);
 assert.ok(Array.isArray(games)&&games.length>0&&games.length<=RELEASED_IDS.length&&new Set(games).size===games.length&&games.every(game=>RELEASED_IDS.includes(game)),'RESOURCE_GAMES_INVALID');
 assert.ok(typeof nonce==='string'&&nonce.length>=16&&nonce.length<=128,'RESOURCE_NONCE_INVALID');
 const expected=Object.fromEntries([...manifest.expected].filter(([path])=>imagePath(path)));
 assert.ok(Object.keys(expected).length>0&&Object.keys(expected).length<=2048,'RESOURCE_IMAGE_MANIFEST_BOUND');
 for(const[path,sha]of Object.entries(expected))assert.ok(path.startsWith('/')&&!path.includes('?')&&!path.includes('#')&&!path.includes('..')&&digest(sha),'RESOURCE_IMAGE_MANIFEST_INVALID');
 assert.ok(Array.isArray(generatedScripts)&&generatedScripts.length<=8,'GENERATED_SCRIPT_RECIPE_BOUND');
 for(const recipe of generatedScripts){assert.ok(recipe.kind==='manifest-derived-draco-worker-v1'&&digest(recipe.sha256)&&digest(recipe.workerFunctionSha256)&&Number.isSafeInteger(recipe.bytes)&&recipe.bytes>0&&recipe.bytes<=32*1024*1024,'GENERATED_SCRIPT_RECIPE_INVALID');assert.ok(recipe.sourcePins.length===2&&new Set(recipe.sourcePins.map(pin=>pin.role)).size===2,'GENERATED_SCRIPT_SOURCE_PINS_REQUIRED');for(const pin of recipe.sourcePins)assert.ok(['decoder-text','worker-function-module'].includes(pin.role)&&manifest.expected.get(pin.path)===pin.sha256&&digest(pin.sha256)&&Number.isSafeInteger(pin.bytes)&&pin.bytes>0,'GENERATED_SCRIPT_SOURCE_PINS_INVALID');}
 return {origin,entryUrl,games:[...games],nonce,expected,generatedScripts:structuredClone(generatedScripts),maxReceipts:128,maxBlobUrls:512,maxBlobBytes:32*1024*1024,maxTotalBytes:128*1024*1024};
}

/** Self-contained serialized init callback. Native calls and the application's original Promise/URL are preserved. */
export function installConsumedImageEvidence(config){
 const{origin,entryUrl,games,nonce,expected,generatedScripts=[],maxReceipts,maxBlobUrls,maxBlobBytes,maxTotalBytes}=config;
 let game;try{const url=new URL(location.href);game=url.pathname.slice('/play/'.length);if(globalThis===parent||parent!==top||url.origin!==origin||url.href!==origin+'/play/'+game||!games.includes(game)||parent.location.href!==entryUrl)return;}catch{return;}
 if(Object.prototype.hasOwnProperty.call(globalThis,'__oasisConsumedImageEvidence'))throw Error('RESOURCE_EVIDENCE_ALREADY_INSTALLED');
 const blobDescriptor=Object.getOwnPropertyDescriptor(Response.prototype,'blob'),objectDescriptor=Object.getOwnPropertyDescriptor(URL,'createObjectURL'),revokeDescriptor=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL');
 const nativeBlob=blobDescriptor.value,nativeObjectUrl=objectDescriptor.value,nativeRevoke=revokeDescriptor.value,nativeArrayBuffer=Blob.prototype.arrayBuffer;
 const urlGetter=Object.getOwnPropertyDescriptor(Response.prototype,'url').get,statusGetter=Object.getOwnPropertyDescriptor(Response.prototype,'status').get,typeGetter=Object.getOwnPropertyDescriptor(Response.prototype,'type').get,sizeGetter=Object.getOwnPropertyDescriptor(Blob.prototype,'size').get;
 const blobs=new WeakMap(),receipts=[],generatedReceipts=[],errors=[],tasks=new Set();let phase='loading',identity=null,totalBytes=0,urlCount=0,closed=false;
 const error=code=>{if(errors.length<128)errors.push(code);else if(!errors.includes('RESOURCE_ERROR_BOUND'))errors.push('RESOURCE_ERROR_BOUND');};
 function owner(){const p=globalThis.__oasisPhysicalPerf;if(!p||p.schema!=='android-physical-performance-v1'||p.nonce!==nonce||p.url!==location.href||!/[a-f0-9]{32}/.test(p.documentId)||p.documentId.length!==32||!Number.isFinite(p.timeOrigin)||p.timeOrigin!==performance.timeOrigin)throw Error('RESOURCE_NATIVE_DOCUMENT_UNPROVEN');const now={nonce,documentId:p.documentId,timeOrigin:p.timeOrigin,url:location.href,parentUrl:parent.location.href};if(identity&&JSON.stringify(identity)!==JSON.stringify(now))throw Error('RESOURCE_NATIVE_DOCUMENT_CHANGED');identity=now;return now;}
 function observedBlob(blob,sourceUrl,status,type){
  try{owner();if(!(blob instanceof Blob))throw Error('RESOURCE_FOREIGN_BLOB_REALM');if(receipts.length+generatedReceipts.length>=maxReceipts)throw Error('RESOURCE_RECEIPT_BOUND');if(phase!=='loading')throw Error('RESOURCE_BLOB_AFTER_SAMPLE_FREEZE');
   const receipt={id:receipts.length+1,sourceUrl,status,type,bytes:sizeGetter.call(blob),sha256:null,createdAt:performance.now(),completedAt:null,hashDurationMs:null,hashStartedAt:null,blobUrls:[],hashStarted:false,hashComplete:false};
   if(receipt.bytes<=0||receipt.bytes>maxBlobBytes)throw Error('RESOURCE_BLOB_SIZE_BOUND');receipts.push(receipt);blobs.set(blob,receipt);
  }catch(e){error(e.message);}
 }
 function hashBlob(blob,receipt){
  if(receipt.hashStarted)return;if(phase!=='loading'){error('RESOURCE_HASH_DURING_SAMPLING');return;}receipt.hashStarted=true;
  totalBytes+=receipt.bytes;if(totalBytes>maxTotalBytes){error('RESOURCE_HASH_BYTES_BOUND');return;}
  const started=performance.now();receipt.hashStartedAt=started;let task;
  task=Promise.resolve().then(()=>nativeArrayBuffer.call(blob)).then(async bytes=>{if(bytes.byteLength!==receipt.bytes)throw Error('RESOURCE_BLOB_BYTES_CHANGED');const hash=await crypto.subtle.digest('SHA-256',bytes);owner();receipt.sha256=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');receipt.completedAt=performance.now();receipt.hashDurationMs=receipt.completedAt-started;receipt.hashComplete=true;
   if(receipt.kind==='generated-script'){const recipes=generatedScripts.filter(recipe=>recipe.sha256===receipt.sha256&&recipe.bytes===receipt.bytes);if(!recipes.length)throw Error('RESOURCE_UNKNOWN_BLOB');receipt.recipeCandidates=recipes;receipt.recipe=recipes.length===1?recipes[0]:null;}
   else if(receipt.sha256!==expected[new URL(receipt.sourceUrl).pathname])throw Error('RESOURCE_CONSUMED_BLOB_SHA_MISMATCH');
  }).catch(e=>error(e.message)).finally(()=>tasks.delete(task));tasks.add(task);
 }
 function wrappedBlob(...args){
  const promise=Reflect.apply(nativeBlob,this,args);
  // Public metadata only. API/private responses never enter the WeakMap or hashing path.
  try{const sourceUrl=urlGetter.call(this),u=new URL(sourceUrl);if(u.origin===origin&&u.href===origin+u.pathname&&Object.prototype.hasOwnProperty.call(expected,u.pathname)){
   const status=statusGetter.call(this),type=typeGetter.call(this);if(status!==200||!['basic','default'].includes(type))error('RESOURCE_PUBLIC_RESPONSE_UNPROVEN');else void promise.then(blob=>observedBlob(blob,sourceUrl,status,type),()=>{});
  }}catch{error('RESOURCE_RESPONSE_IDENTITY_ERROR');}
  return promise;
 }
 function wrappedObjectUrl(blob){
  const result=Reflect.apply(nativeObjectUrl,this,[blob]);
  try{owner();if(!(blob instanceof Blob))throw Error('RESOURCE_FOREIGN_BLOB_REALM');let receipt=blobs.get(blob);
   if(!receipt){if(!generatedScripts.length)throw Error('RESOURCE_UNKNOWN_BLOB');if(receipts.length+generatedReceipts.length>=maxReceipts)throw Error('RESOURCE_RECEIPT_BOUND');const bytes=sizeGetter.call(blob);if(bytes<=0||bytes>maxBlobBytes)throw Error('RESOURCE_BLOB_SIZE_BOUND');receipt={id:generatedReceipts.length+1,kind:'generated-script',bytes,sha256:null,createdAt:performance.now(),completedAt:null,hashDurationMs:null,hashStartedAt:null,blobUrls:[],hashStarted:false,hashComplete:false,recipe:null};generatedReceipts.push(receipt);blobs.set(blob,receipt);}
   if(!result.startsWith('blob:'+origin+'/'))throw Error('RESOURCE_BLOB_ORIGIN_CHANGED');if(++urlCount>maxBlobUrls)throw Error('RESOURCE_BLOB_URL_BOUND');
   if(phase!=='loading')throw Error('RESOURCE_OBJECT_URL_DURING_SAMPLING');receipt.blobUrls.push({url:result,createdAt:performance.now(),revokedAt:null});hashBlob(blob,receipt);
  }catch(e){error(e.message);}return result;
 }
 function wrappedRevoke(url){const result=Reflect.apply(nativeRevoke,this,[url]);for(const receipt of [...receipts,...generatedReceipts])for(const row of receipt.blobUrls)if(row.url===url&&row.revokedAt===null)row.revokedAt=performance.now();return result;}
 Object.defineProperty(Response.prototype,'blob',{...blobDescriptor,value:wrappedBlob});Object.defineProperty(URL,'createObjectURL',{...objectDescriptor,value:wrappedObjectUrl});Object.defineProperty(URL,'revokeObjectURL',{...revokeDescriptor,value:wrappedRevoke});
 const snapshot=()=>({schema:'owned-player-resource-evidence-v1',game,identity:identity||owner(),phase,pendingTasks:tasks.size,totalHashedBytes:totalBytes,receipts,generatedReceipts,errors,closed,source:'Original Response.blob resolved Blob or exact manifest-derived Draco Worker Blob; native createObjectURL identity and actual immutable Blob.arrayBuffer SHA-256; excludes decoded pixels/CDP body availability'});
 const control={snapshot,async drain(timeoutMs){if(!Number.isInteger(timeoutMs)||timeoutMs<=0||timeoutMs>15000)throw Error('RESOURCE_DRAIN_BOUND');const end=performance.now()+timeoutMs;while(tasks.size){const remaining=end-performance.now();if(remaining<=0)throw Error('RESOURCE_HASH_DRAIN_TIMEOUT');let timer;try{await Promise.race([Promise.all([...tasks]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('RESOURCE_HASH_DRAIN_TIMEOUT')),remaining);})]);}finally{clearTimeout(timer);}}return snapshot();},freeze(){owner();if(tasks.size)throw Error('RESOURCE_HASH_PENDING_AT_SAMPLE');if(errors.length)throw Error('RESOURCE_HASH_ERRORS_AT_SAMPLE');phase='sampling';return snapshot();},stop(){if(closed)return snapshot();closed=true;phase='closed';if(Response.prototype.blob!==wrappedBlob||URL.createObjectURL!==wrappedObjectUrl||URL.revokeObjectURL!==wrappedRevoke){error('RESOURCE_HOOK_REPLACED');return snapshot();}Object.defineProperty(Response.prototype,'blob',blobDescriptor);Object.defineProperty(URL,'createObjectURL',objectDescriptor);Object.defineProperty(URL,'revokeObjectURL',revokeDescriptor);return snapshot();}};
 Object.defineProperty(globalThis,'__oasisConsumedImageEvidence',{value:control,configurable:false,writable:false});
}

export async function installOwnedPlayerResourceEvidence(context,args){
 const generated=args.generatedScripts??await dracoWorkerResourcePins(args);generatedPinsByManifest.set(args.manifest,generated);
 const config=resourceEvidenceConfiguration(args),handle=await context.addInitScript(installConsumedImageEvidence,config);
 assert.ok(handle&&typeof handle.dispose==='function','RESOURCE_INIT_DISPOSABLE_REQUIRED');return {config,async dispose(){await handle.dispose();}};
}

/** A candidate source URL is never sufficient: join to one actual own-frame GET and one native Blob identity. */
export function validateConsumedImageEvidence(snapshot,{origin,entryUrl,game,nonce,documentId,timeOrigin,scope,manifest,requests,generatedScripts=generatedPinsByManifest.get(manifest)||[]}){
 assert.equal(snapshot?.schema,RESOURCE_EVIDENCE_SCHEMA,'RESOURCE_EVIDENCE_MISSING');assert.equal(snapshot.game,game);assert.ok(scope&&typeof scope.frameId==='string'&&Number.isInteger(scope.contextId),'RESOURCE_CDP_CONTEXT_REQUIRED');
 assert.deepEqual(snapshot.identity,{nonce,documentId,timeOrigin,url:origin+'/play/'+game,parentUrl:entryUrl},'RESOURCE_DOCUMENT_IDENTITY_CHANGED');assert.ok(Number.isFinite(snapshot.identity.timeOrigin)&&/^[a-f0-9]{32}$/.test(documentId),'RESOURCE_NATIVE_IDENTITY_REQUIRED');
 assert.ok(['loading','sampling','closed'].includes(snapshot.phase)&&snapshot.pendingTasks===0,'RESOURCE_HASH_TASKS_NOT_CLOSED');assert.deepEqual(snapshot.errors,[],'RESOURCE_EVIDENCE_ERRORS');assert.ok(Array.isArray(snapshot.receipts)&&snapshot.receipts.length<=128,'RESOURCE_RECEIPTS_INVALID');
 const bySource=new Map(),byBlob=new Map(),byGeneratedBlob=new Map();let total=0;
 for(const receipt of snapshot.receipts){
  const u=new URL(receipt.sourceUrl);assert.ok(u.origin===origin&&u.href===origin+u.pathname&&imagePath(u.pathname),'RESOURCE_SOURCE_URL_INVALID');const expected=manifest.expected.get(u.pathname);assert.ok(digest(expected),'RESOURCE_SOURCE_NOT_MANIFEST_IMAGE');
  assert.ok(receipt.status===200&&['basic','default'].includes(receipt.type)&&receipt.hashStarted===true&&receipt.hashComplete===true&&receipt.sha256===expected,'RESOURCE_CONSUMED_BYTES_UNPROVEN');assert.ok(Number.isSafeInteger(receipt.bytes)&&receipt.bytes>0&&receipt.bytes<=32*1024*1024,'RESOURCE_CONSUMED_BYTES_BOUND');
  assert.ok(Number.isFinite(receipt.createdAt)&&Number.isFinite(receipt.completedAt)&&receipt.completedAt>=receipt.createdAt&&Number.isFinite(receipt.hashDurationMs)&&receipt.hashDurationMs>=0,'RESOURCE_HASH_CLOCK_UNPROVEN');
  assert.ok(!bySource.has(receipt.sourceUrl),'RESOURCE_DUPLICATE_SOURCE_CONSUMPTION');const matches=requests.filter(row=>row.url===receipt.sourceUrl&&row.frameId===scope.frameId&&row.type==='Fetch');
  assert.equal(matches.length,1,'RESOURCE_SOURCE_GET_AMBIGUOUS');const get=matches[0];assert.ok(get.method==='GET'&&get.transferFinished===true&&!get.failed&&get.response?.status===200&&get.response.fromServiceWorker===false,'RESOURCE_SOURCE_GET_UNPROVEN');
  assert.ok(Array.isArray(receipt.blobUrls)&&receipt.blobUrls.length>0&&receipt.blobUrls.length<=512,'RESOURCE_OBJECT_URL_UNPROVEN');
  const proof={sourcePath:u.pathname,sha256:expected,bytes:receipt.bytes,sourceRequestId:get.id,frameId:scope.frameId,contextId:scope.contextId,documentId,nonce,timeOrigin:snapshot.identity.timeOrigin,source:'Actual game-consumed immutable Blob bytes; original public GET and native Blob/objectURL reference identity; not CDP response-body success'};
  bySource.set(receipt.sourceUrl,proof);
  for(const row of receipt.blobUrls){assert.ok(typeof row.url==='string'&&new RegExp('^blob:'+origin.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/[a-f0-9-]{36}$').test(row.url)&&!byBlob.has(row.url),'RESOURCE_OBJECT_URL_INVALID');assert.ok(Number.isFinite(row.createdAt)&&row.createdAt>=receipt.createdAt,'RESOURCE_OBJECT_URL_CLOCK_UNPROVEN');byBlob.set(row.url,proof);}
  total+=receipt.bytes;
 }
 const generated=snapshot.generatedReceipts||[];assert.ok(Array.isArray(generated)&&generated.length+snapshot.receipts.length<=128,'RESOURCE_RECEIPTS_INVALID');
 for(const receipt of generated){
  assert.ok(receipt.kind==='generated-script'&&receipt.hashStarted===true&&receipt.hashComplete===true&&(receipt.recipe||Array.isArray(receipt.recipeCandidates))&&Number.isSafeInteger(receipt.bytes)&&receipt.bytes>0&&receipt.bytes<=32*1024*1024,'GENERATED_SCRIPT_CONSUMED_BYTES_UNPROVEN');
  const recipes=generatedScripts.filter(recipe=>recipe.sha256===receipt.sha256&&recipe.bytes===receipt.bytes);assert.ok(recipes.length>0&&recipes.length<=8&&new Set(recipes.map(recipe=>recipe.workerFunctionSha256)).size===1,'GENERATED_SCRIPT_RELEASE_PIN_REQUIRED');
  if(receipt.recipeCandidates){assert.deepEqual(receipt.recipeCandidates,recipes,'GENERATED_SCRIPT_RECIPE_CHANGED');assert.deepEqual(receipt.recipe,recipes.length===1?recipes[0]:null,'GENERATED_SCRIPT_RECIPE_CHANGED');}else{assert.equal(recipes.length,1,'GENERATED_SCRIPT_RECIPE_CHANGED');assert.deepEqual(receipt.recipe,recipes[0],'GENERATED_SCRIPT_RECIPE_CHANGED');}
  assert.ok(Number.isFinite(receipt.createdAt)&&Number.isFinite(receipt.completedAt)&&receipt.completedAt>=receipt.createdAt&&Number.isFinite(receipt.hashDurationMs)&&receipt.hashDurationMs>=0,'RESOURCE_HASH_CLOCK_UNPROVEN');
  // Inputs must finish before this original native Blob/objectURL observation. Later inputs
  // are still checked, but cannot become provenance for an earlier Blob.
  const createdAtMs=timeOrigin+receipt.createdAt;assert.ok(Number.isFinite(createdAtMs),'GENERATED_SCRIPT_BLOB_CLOCK_UNPROVEN');
  const sourceUrls=new Set(recipes.flatMap(recipe=>recipe.sourcePins.map(pin=>origin+pin.path))),candidates=requests.filter(row=>sourceUrls.has(row.url)&&row.frameId===scope.frameId);
  assert.ok(candidates.every(row=>typeof row.id==='string'&&row.id.length>0)&&new Set(candidates.map(row=>row.id)).size===candidates.length,'GENERATED_SCRIPT_SOURCE_ID_AMBIGUOUS');
  for(const row of candidates){
   assert.ok(row.contextId===scope.contextId&&['Fetch','Script'].includes(row.type)&&row.method==='GET'&&!row.failed&&!row.redirected,'GENERATED_SCRIPT_SOURCE_GET_UNPROVEN');
   assert.ok(Number.isFinite(row.startedAtMs)&&Number.isFinite(row.startedMonotonic)&&row.startedAtMs>=timeOrigin,'GENERATED_SCRIPT_SOURCE_CLOCK_UNPROVEN');
   if(!row.transferFinished)throw Error('GENERATED_SCRIPT_SOURCE_TRANSFER_PENDING');
   assert.ok(row.response?.status===200&&row.response.fromServiceWorker===false,'GENERATED_SCRIPT_SOURCE_GET_UNPROVEN');
   assert.ok(Number.isFinite(row.finishedMonotonic)&&row.finishedMonotonic>=row.startedMonotonic&&Number.isFinite(row.finishedAtMs)&&row.finishedAtMs===row.startedAtMs+(row.finishedMonotonic-row.startedMonotonic)*1000,'GENERATED_SCRIPT_SOURCE_CLOCK_UNPROVEN');
  }
  const delivered=pin=>candidates.filter(row=>row.url===origin+pin.path&&row.finishedAtMs<=createdAtMs);
  const active=recipes.filter(recipe=>recipe.sourcePins.every(pin=>delivered(pin).length>0));assert.ok(active.length>0,'GENERATED_SCRIPT_SOURCE_GET_UNPROVEN');assert.equal(active.length,1,'GENERATED_SCRIPT_ACTIVE_MODULE_AMBIGUOUS');const recipe=active[0];
  const sourceRequestIds=[],sourceRequestFacts=[];for(const pin of recipe.sourcePins){assert.equal(manifest.expected.get(pin.path),pin.sha256,'GENERATED_SCRIPT_SOURCE_SHA_MISMATCH');for(const row of delivered(pin)){sourceRequestIds.push(row.id);sourceRequestFacts.push({id:row.id,url:row.url,frameId:row.frameId,contextId:row.contextId,method:row.method,type:row.type,redirected:row.redirected,transferFinished:row.transferFinished,failed:row.failed,response:{status:row.response.status,fromServiceWorker:row.response.fromServiceWorker},startedAtMs:row.startedAtMs,startedMonotonic:row.startedMonotonic,finishedAtMs:row.finishedAtMs,finishedMonotonic:row.finishedMonotonic});}}
  assert.ok(Array.isArray(receipt.blobUrls)&&receipt.blobUrls.length>0&&receipt.blobUrls.length<=512,'RESOURCE_OBJECT_URL_UNPROVEN');
  const proof={kind:recipe.kind,sha256:receipt.sha256,bytes:receipt.bytes,sourcePins:recipe.sourcePins,workerFunctionSha256:recipe.workerFunctionSha256,sourceRequestIds,sourceRequestFacts,generatedReceiptId:receipt.id,blobObservedAtMs:createdAtMs,frameId:scope.frameId,contextId:scope.contextId,documentId,nonce,timeOrigin,source:'Exact manifest-derived Draco Worker bytes in the same native Blob/objectURL; original decoder and uniquely delivered loader module required separately; retained recipe aliases never prove delivery; script CDP response must remain readable and byte-pinned'};
  for(const blob of receipt.blobUrls){assert.ok(typeof blob.url==='string'&&new RegExp('^blob:'+origin.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/[a-f0-9-]{36}$').test(blob.url)&&!byBlob.has(blob.url)&&!byGeneratedBlob.has(blob.url),'RESOURCE_OBJECT_URL_INVALID');assert.ok(Number.isFinite(blob.createdAt)&&blob.createdAt>=receipt.createdAt,'RESOURCE_OBJECT_URL_CLOCK_UNPROVEN');byGeneratedBlob.set(blob.url,proof);}
  total+=receipt.bytes;
 }
 assert.equal(total,snapshot.totalHashedBytes,'RESOURCE_HASH_TOTAL_CHANGED');assert.ok(total<=128*1024*1024,'RESOURCE_TOTAL_BYTES_BOUND');
 return {bySource,byBlob,byGeneratedBlob,snapshot,scope:{...scope},verifiedReceipts:bySource.size,verifiedGeneratedReceipts:generated.length};
}

/** Generated scripts never use the image empty-body fallback. The original
 * worker response body and finish, plus both received public inputs, are pins. */
export function generatedScriptProofForResponse(row,evidence,{origin,manifest,bodyPins}){
 const proof=evidence.byGeneratedBlob.get(row.url);assert.ok(proof,'GENERATED_SCRIPT_NATIVE_BLOB_UNPROVEN');
 assert.ok(row.frameId===proof.frameId&&row.contextId===proof.contextId&&row.method==='GET'&&row.status===200&&row.resourceType==='script'&&row.transferFinished===true,'GENERATED_SCRIPT_DELIVERY_UNPROVEN');
 assert.ok(row.original_bytes>0&&row.original_bytes===proof.bytes&&row.original_sha256===proof.sha256,'RESOURCE_NONEMPTY_CDP_BODY_CONFLICT');
  assert.ok(Number.isSafeInteger(row.id)&&row.id>0&&Number.isSafeInteger(row.request_id)&&row.request_id>0,'GENERATED_SCRIPT_DELIVERY_REQUEST_REQUIRED');
 const sourceBodyFacts=[];
 for(const pin of proof.sourcePins){
  assert.equal(manifest.expected.get(pin.path),pin.sha256,'GENERATED_SCRIPT_SOURCE_SHA_MISMATCH');
  const sources=bodyPins.filter(source=>source.url===origin+pin.path&&source.frame===evidence.snapshot.identity.url);
  // These are independent native Request/Response body candidates, not a
  // guessed one-to-one join to a main-frame CDP ID or a host clock match.
  for(const source of sources)assert.ok(Number.isSafeInteger(source.id)&&source.id>0&&Number.isSafeInteger(source.request_id)&&source.request_id>0&&source.method==='GET'&&source.status===200&&source.pin?.sha256===pin.sha256&&source.original_sha256===pin.sha256&&source.original_bytes===pin.bytes,'GENERATED_SCRIPT_RECEIVED_INPUT_BODY_PIN_REQUIRED');
  const prior=sources.filter(source=>source.request_id<row.request_id&&source.id<row.id);assert.ok(prior.length>0,'GENERATED_SCRIPT_RECEIVED_INPUT_BODY_PIN_REQUIRED');
  for(const source of prior)sourceBodyFacts.push({responseId:source.id,requestId:source.request_id,url:source.url,frame:source.frame,method:source.method,status:source.status,sha256:source.original_sha256,bytes:source.original_bytes});
 }
 return {...proof,sourceBodyFacts,sourceBodyBinding:'Independent native Request/Response body candidate set registered before this worker Request/Response; not a CDP-ID or clock join',deliveryRequestId:row.request_id,deliveryResponseId:row.id,deliveryUrl:row.url,transferSource:'This exact owned Playwright worker-target response.body() and response.finished(); main-frame CDP transfer availability retained separately'};
}

export function deliveryProofForRow(row,evidence,{origin,manifest}){
 const proof=row.url.startsWith('blob:')?evidence.byBlob.get(row.url):evidence.bySource.get(row.url);assert.ok(proof,'RESOURCE_ALTERNATIVE_DELIVERY_UNPROVEN');
 assert.ok(row.frameId===proof.frameId&&row.method==='GET'&&row.transferFinished===true&&!row.failed&&row.response?.status===200&&row.response.fromServiceWorker===false,'RESOURCE_DELIVERY_GET_UNPROVEN');
 if(row.url.startsWith('blob:'))assert.equal(row.type,'Image','RESOURCE_BLOB_NOT_IMAGE');else{assert.equal(new URL(row.url).origin,origin);assert.equal(row.id,proof.sourceRequestId,'RESOURCE_PUBLIC_RESPONSE_NOT_CONSUMED_BLOB_SOURCE');}
 assert.equal(manifest.expected.get(proof.sourcePath),proof.sha256,'RESOURCE_DELIVERY_MANIFEST_CHANGED');return {...proof,deliveryRequestId:row.id};
}
