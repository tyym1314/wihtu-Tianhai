/** Actual consumed public image bytes; no Response clone/read, refetch or decoded-pixel proof. */
import assert from 'node:assert/strict';

export const RESOURCE_EVIDENCE_SCHEMA='owned-player-resource-evidence-v1';
const imagePath=path=>!/^\/(?:api|v1)(?:\/|$)/.test(path)&&/\.(?:webp|png|jpe?g|svg|avif|gif)$/.test(path);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export function resourceEvidenceConfiguration({origin,entryUrl,games,manifest,nonce}){
 const base=new URL(origin),entry=new URL(entryUrl);assert.equal(base.protocol,'https:');assert.equal(base.origin,origin);assert.equal(entry.origin,origin);
 assert.ok(Array.isArray(games)&&games.length>0&&games.length<=11&&new Set(games).size===games.length&&games.every(game=>/^[a-z]+$/.test(game)),'RESOURCE_GAMES_INVALID');
 assert.ok(typeof nonce==='string'&&nonce.length>=16&&nonce.length<=128,'RESOURCE_NONCE_INVALID');
 const expected=Object.fromEntries([...manifest.expected].filter(([path])=>imagePath(path)));
 assert.ok(Object.keys(expected).length>0&&Object.keys(expected).length<=2048,'RESOURCE_IMAGE_MANIFEST_BOUND');
 for(const[path,sha]of Object.entries(expected))assert.ok(path.startsWith('/')&&!path.includes('?')&&!path.includes('#')&&!path.includes('..')&&digest(sha),'RESOURCE_IMAGE_MANIFEST_INVALID');
 return {origin,entryUrl,games:[...games],nonce,expected,maxReceipts:128,maxBlobUrls:512,maxBlobBytes:32*1024*1024,maxTotalBytes:128*1024*1024};
}

/** Self-contained serialized init callback. Native calls and the application's original Promise/URL are preserved. */
export function installConsumedImageEvidence(config){
 const{origin,entryUrl,games,nonce,expected,maxReceipts,maxBlobUrls,maxBlobBytes,maxTotalBytes}=config;
 let game;try{const url=new URL(location.href);game=url.pathname.slice('/play/'.length);if(globalThis===parent||parent!==top||url.origin!==origin||url.href!==origin+'/play/'+game||!games.includes(game)||parent.location.href!==entryUrl)return;}catch{return;}
 if(Object.prototype.hasOwnProperty.call(globalThis,'__oasisConsumedImageEvidence'))throw Error('RESOURCE_EVIDENCE_ALREADY_INSTALLED');
 const blobDescriptor=Object.getOwnPropertyDescriptor(Response.prototype,'blob'),objectDescriptor=Object.getOwnPropertyDescriptor(URL,'createObjectURL'),revokeDescriptor=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL');
 const nativeBlob=blobDescriptor.value,nativeObjectUrl=objectDescriptor.value,nativeRevoke=revokeDescriptor.value,nativeArrayBuffer=Blob.prototype.arrayBuffer;
 const urlGetter=Object.getOwnPropertyDescriptor(Response.prototype,'url').get,statusGetter=Object.getOwnPropertyDescriptor(Response.prototype,'status').get,typeGetter=Object.getOwnPropertyDescriptor(Response.prototype,'type').get,sizeGetter=Object.getOwnPropertyDescriptor(Blob.prototype,'size').get;
 const blobs=new WeakMap(),receipts=[],errors=[],tasks=new Set();let phase='loading',identity=null,totalBytes=0,urlCount=0,closed=false;
 const error=code=>{if(errors.length<128)errors.push(code);else if(!errors.includes('RESOURCE_ERROR_BOUND'))errors.push('RESOURCE_ERROR_BOUND');};
 function owner(){const p=globalThis.__oasisPhysicalPerf;if(!p||p.schema!=='android-physical-performance-v1'||p.nonce!==nonce||p.url!==location.href||!/[a-f0-9]{32}/.test(p.documentId)||p.documentId.length!==32||!Number.isFinite(p.timeOrigin)||p.timeOrigin!==performance.timeOrigin)throw Error('RESOURCE_NATIVE_DOCUMENT_UNPROVEN');const now={nonce,documentId:p.documentId,timeOrigin:p.timeOrigin,url:location.href,parentUrl:parent.location.href};if(identity&&JSON.stringify(identity)!==JSON.stringify(now))throw Error('RESOURCE_NATIVE_DOCUMENT_CHANGED');identity=now;return now;}
 function observedBlob(blob,sourceUrl,status,type){
  try{owner();if(!(blob instanceof Blob))throw Error('RESOURCE_FOREIGN_BLOB_REALM');if(receipts.length>=maxReceipts)throw Error('RESOURCE_RECEIPT_BOUND');if(phase!=='loading')throw Error('RESOURCE_BLOB_AFTER_SAMPLE_FREEZE');
   const receipt={id:receipts.length+1,sourceUrl,status,type,bytes:sizeGetter.call(blob),sha256:null,createdAt:performance.now(),completedAt:null,hashDurationMs:null,hashStartedAt:null,blobUrls:[],hashStarted:false,hashComplete:false};
   if(receipt.bytes<=0||receipt.bytes>maxBlobBytes)throw Error('RESOURCE_BLOB_SIZE_BOUND');receipts.push(receipt);blobs.set(blob,receipt);
  }catch(e){error(e.message);}
 }
 function hashBlob(blob,receipt){
  if(receipt.hashStarted)return;if(phase!=='loading'){error('RESOURCE_HASH_DURING_SAMPLING');return;}receipt.hashStarted=true;
  totalBytes+=receipt.bytes;if(totalBytes>maxTotalBytes){error('RESOURCE_HASH_BYTES_BOUND');return;}
  const started=performance.now();receipt.hashStartedAt=started;let task;
  task=Promise.resolve().then(()=>nativeArrayBuffer.call(blob)).then(async bytes=>{if(bytes.byteLength!==receipt.bytes)throw Error('RESOURCE_BLOB_BYTES_CHANGED');const hash=await crypto.subtle.digest('SHA-256',bytes);owner();receipt.sha256=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');receipt.completedAt=performance.now();receipt.hashDurationMs=receipt.completedAt-started;receipt.hashComplete=true;if(receipt.sha256!==expected[new URL(receipt.sourceUrl).pathname])throw Error('RESOURCE_CONSUMED_BLOB_SHA_MISMATCH');}).catch(e=>error(e.message)).finally(()=>tasks.delete(task));tasks.add(task);
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
  try{owner();const receipt=blobs.get(blob);if(!receipt)throw Error('RESOURCE_UNKNOWN_BLOB');if(!(blob instanceof Blob))throw Error('RESOURCE_FOREIGN_BLOB_REALM');if(!result.startsWith('blob:'+origin+'/'))throw Error('RESOURCE_BLOB_ORIGIN_CHANGED');if(++urlCount>maxBlobUrls)throw Error('RESOURCE_BLOB_URL_BOUND');
   if(phase!=='loading')throw Error('RESOURCE_OBJECT_URL_DURING_SAMPLING');receipt.blobUrls.push({url:result,createdAt:performance.now(),revokedAt:null});hashBlob(blob,receipt);
  }catch(e){error(e.message);}return result;
 }
 function wrappedRevoke(url){const result=Reflect.apply(nativeRevoke,this,[url]);for(const receipt of receipts)for(const row of receipt.blobUrls)if(row.url===url&&row.revokedAt===null)row.revokedAt=performance.now();return result;}
 Object.defineProperty(Response.prototype,'blob',{...blobDescriptor,value:wrappedBlob});Object.defineProperty(URL,'createObjectURL',{...objectDescriptor,value:wrappedObjectUrl});Object.defineProperty(URL,'revokeObjectURL',{...revokeDescriptor,value:wrappedRevoke});
 const snapshot=()=>({schema:'owned-player-resource-evidence-v1',game,identity:identity||owner(),phase,pendingTasks:tasks.size,totalHashedBytes:totalBytes,receipts,errors,closed,source:'Original Response.blob resolved Blob, native createObjectURL identity and actual immutable Blob.arrayBuffer SHA-256; excludes decoded pixels/CDP body availability'});
 const control={snapshot,async drain(timeoutMs){if(!Number.isInteger(timeoutMs)||timeoutMs<=0||timeoutMs>15000)throw Error('RESOURCE_DRAIN_BOUND');const end=performance.now()+timeoutMs;while(tasks.size){const remaining=end-performance.now();if(remaining<=0)throw Error('RESOURCE_HASH_DRAIN_TIMEOUT');let timer;try{await Promise.race([Promise.all([...tasks]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('RESOURCE_HASH_DRAIN_TIMEOUT')),remaining);})]);}finally{clearTimeout(timer);}}return snapshot();},freeze(){owner();if(tasks.size)throw Error('RESOURCE_HASH_PENDING_AT_SAMPLE');if(errors.length)throw Error('RESOURCE_HASH_ERRORS_AT_SAMPLE');phase='sampling';return snapshot();},stop(){if(closed)return snapshot();closed=true;phase='closed';if(Response.prototype.blob!==wrappedBlob||URL.createObjectURL!==wrappedObjectUrl||URL.revokeObjectURL!==wrappedRevoke){error('RESOURCE_HOOK_REPLACED');return snapshot();}Object.defineProperty(Response.prototype,'blob',blobDescriptor);Object.defineProperty(URL,'createObjectURL',objectDescriptor);Object.defineProperty(URL,'revokeObjectURL',revokeDescriptor);return snapshot();}};
 Object.defineProperty(globalThis,'__oasisConsumedImageEvidence',{value:control,configurable:false,writable:false});
}

export async function installOwnedPlayerResourceEvidence(context,args){
 const config=resourceEvidenceConfiguration(args),handle=await context.addInitScript(installConsumedImageEvidence,config);
 assert.ok(handle&&typeof handle.dispose==='function','RESOURCE_INIT_DISPOSABLE_REQUIRED');return {config,async dispose(){await handle.dispose();}};
}

/** A candidate source URL is never sufficient: join to one actual own-frame GET and one native Blob identity. */
export function validateConsumedImageEvidence(snapshot,{origin,entryUrl,game,nonce,documentId,timeOrigin,scope,manifest,requests}){
 assert.equal(snapshot?.schema,RESOURCE_EVIDENCE_SCHEMA,'RESOURCE_EVIDENCE_MISSING');assert.equal(snapshot.game,game);assert.ok(scope&&typeof scope.frameId==='string'&&Number.isInteger(scope.contextId),'RESOURCE_CDP_CONTEXT_REQUIRED');
 assert.deepEqual(snapshot.identity,{nonce,documentId,timeOrigin,url:origin+'/play/'+game,parentUrl:entryUrl},'RESOURCE_DOCUMENT_IDENTITY_CHANGED');assert.ok(Number.isFinite(snapshot.identity.timeOrigin)&&/^[a-f0-9]{32}$/.test(documentId),'RESOURCE_NATIVE_IDENTITY_REQUIRED');
 assert.ok(['loading','sampling','closed'].includes(snapshot.phase)&&snapshot.pendingTasks===0,'RESOURCE_HASH_TASKS_NOT_CLOSED');assert.deepEqual(snapshot.errors,[],'RESOURCE_EVIDENCE_ERRORS');assert.ok(Array.isArray(snapshot.receipts)&&snapshot.receipts.length<=128,'RESOURCE_RECEIPTS_INVALID');
 const bySource=new Map(),byBlob=new Map();let total=0;
 for(const receipt of snapshot.receipts){
  const u=new URL(receipt.sourceUrl);assert.ok(u.origin===origin&&u.href===origin+u.pathname&&imagePath(u.pathname),'RESOURCE_SOURCE_URL_INVALID');const expected=manifest.expected.get(u.pathname);assert.ok(digest(expected),'RESOURCE_SOURCE_NOT_MANIFEST_IMAGE');
  assert.ok(receipt.status===200&&['basic','default'].includes(receipt.type)&&receipt.hashStarted===true&&receipt.hashComplete===true&&receipt.sha256===expected,'RESOURCE_CONSUMED_BYTES_UNPROVEN');assert.ok(Number.isSafeInteger(receipt.bytes)&&receipt.bytes>0&&receipt.bytes<=32*1024*1024,'RESOURCE_CONSUMED_BYTES_BOUND');
  assert.ok(Number.isFinite(receipt.createdAt)&&Number.isFinite(receipt.completedAt)&&receipt.completedAt>=receipt.createdAt&&Number.isFinite(receipt.hashDurationMs)&&receipt.hashDurationMs>=0,'RESOURCE_HASH_CLOCK_UNPROVEN');
  assert.ok(!bySource.has(receipt.sourceUrl),'RESOURCE_DUPLICATE_SOURCE_CONSUMPTION');const matches=requests.filter(row=>row.url===receipt.sourceUrl&&row.frameId===scope.frameId);
  assert.equal(matches.length,1,'RESOURCE_SOURCE_GET_AMBIGUOUS');const get=matches[0];assert.ok(get.method==='GET'&&get.transferFinished===true&&!get.failed&&get.response?.status===200&&get.response.fromServiceWorker===false,'RESOURCE_SOURCE_GET_UNPROVEN');
  assert.ok(Array.isArray(receipt.blobUrls)&&receipt.blobUrls.length>0&&receipt.blobUrls.length<=512,'RESOURCE_OBJECT_URL_UNPROVEN');
  const proof={sourcePath:u.pathname,sha256:expected,bytes:receipt.bytes,sourceRequestId:get.id,frameId:scope.frameId,contextId:scope.contextId,documentId,nonce,timeOrigin:snapshot.identity.timeOrigin,source:'Actual game-consumed immutable Blob bytes; original public GET and native Blob/objectURL reference identity; not CDP response-body success'};
  bySource.set(receipt.sourceUrl,proof);
  for(const row of receipt.blobUrls){assert.ok(typeof row.url==='string'&&new RegExp('^blob:'+origin.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/[a-f0-9-]{36}$').test(row.url)&&!byBlob.has(row.url),'RESOURCE_OBJECT_URL_INVALID');assert.ok(Number.isFinite(row.createdAt)&&row.createdAt>=receipt.createdAt,'RESOURCE_OBJECT_URL_CLOCK_UNPROVEN');byBlob.set(row.url,proof);}
  total+=receipt.bytes;
 }
 assert.equal(total,snapshot.totalHashedBytes,'RESOURCE_HASH_TOTAL_CHANGED');assert.ok(total<=128*1024*1024,'RESOURCE_TOTAL_BYTES_BOUND');
 return {bySource,byBlob,snapshot,scope:{...scope},verifiedReceipts:bySource.size};
}

export function deliveryProofForRow(row,evidence,{origin,manifest}){
 const proof=row.url.startsWith('blob:')?evidence.byBlob.get(row.url):evidence.bySource.get(row.url);assert.ok(proof,'RESOURCE_ALTERNATIVE_DELIVERY_UNPROVEN');
 assert.ok(row.frameId===proof.frameId&&row.method==='GET'&&row.transferFinished===true&&!row.failed&&row.response?.status===200&&row.response.fromServiceWorker===false,'RESOURCE_DELIVERY_GET_UNPROVEN');
 if(row.url.startsWith('blob:'))assert.equal(row.type,'Image','RESOURCE_BLOB_NOT_IMAGE');else assert.equal(new URL(row.url).origin,origin);
 assert.equal(manifest.expected.get(proof.sourcePath),proof.sha256,'RESOURCE_DELIVERY_MANIFEST_CHANGED');return {...proof,deliveryRequestId:row.id};
}
