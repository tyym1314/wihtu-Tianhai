import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
import {installConsumedImageEvidence,resourceEvidenceConfiguration,installOwnedPlayerResourceEvidence,validateConsumedImageEvidence,deliveryProofForRow} from '../scripts/android-player-resource-evidence.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),origin='https://owned.example',entryUrl=origin+'/player?app_id=app_fixture',url=origin+'/arena/assets/cat-fixture.webp',body=Buffer.from('RIFFactual-immutable-image'),nonce='isolated-test-nonce-0123456789',documentId='a'.repeat(32),timeOrigin=1000,scope={frameId:'actual-cdp-child',contextId:7,url:origin+'/play/run'};
const manifest={expected:new Map([['/arena/assets/cat-fixture.webp',hash(body)]])};
const config=resourceEvidenceConfiguration({origin,entryUrl,games:['run'],manifest,nonce});
const sourceGet={id:'sourceGET',url,frameId:scope.frameId,method:'GET',type:'Fetch',transferFinished:true,response:{status:200,fromDiskCache:true,fromServiceWorker:false}};
const args={origin,entryUrl,game:'run',nonce,documentId,timeOrigin,scope,manifest,requests:[sourceGet]};
function realm({foreign=false,wrongParent=false,digestHook}={}){
 const internals=new WeakMap(),calls={blob:0,arrayBuffer:0,url:0,revoke:0};
 class ResponseFixture{constructor(blob,source=url){internals.set(this,{blob,url:source,promise:Promise.resolve(blob)});}get url(){return internals.get(this).url;}get status(){return 200;}get type(){return 'basic';}blob(){calls.blob++;return internals.get(this).promise;}}
 class URLFixture extends URL{static createObjectURL(){calls.url++;return'blob:'+origin+'/'+String(calls.url).padStart(8,'0')+'-0000-0000-0000-000000000000';}static revokeObjectURL(){calls.revoke++;}}
 const parent={location:{href:wrongParent?origin+'/foreign':entryUrl}};
 let now=1;const sandbox={URL:URLFixture,Response:ResponseFixture,Blob,location:{href:origin+'/play/run'},parent,top:parent,performance:{timeOrigin,now:()=>now++},crypto:{subtle:{digest:digestHook||((...args)=>webcrypto.subtle.digest(...args))}},setTimeout,clearTimeout,__oasisPhysicalPerf:{schema:'android-physical-performance-v1',nonce,documentId,timeOrigin,url:origin+'/play/run'}};
 if(foreign)sandbox.location.href=origin+'/play/golf';const context=vm.createContext(sandbox);vm.runInContext('('+installConsumedImageEvidence.toString()+')('+JSON.stringify(config)+')',context);
 return{context,calls,ResponseFixture,nativePromise:r=>internals.get(r).promise,control:context.__oasisConsumedImageEvidence,blob:new Blob([body])};
}
const snapshot=c=>JSON.parse(JSON.stringify(c.snapshot()));
async function consumed(r){const response=new r.ResponseFixture(r.blob),promise=response.blob();assert.equal(promise,r.nativePromise(response),'game receives original native promise');const blob=await promise;const blobUrl=r.context.URL.createObjectURL(blob);await r.control.drain(1000);return blobUrl;}
test('actual consumed immutable Blob reference and original Promise/URL prove cached own GET, no CDP body success claimed',async()=>{
 const r=realm(),blobUrl=await consumed(r),snap=snapshot(r.control);assert.equal(r.calls.blob,1);assert.equal(r.calls.url,1);assert.equal(snap.receipts[0].sha256,hash(body));assert.equal(snap.receipts[0].bytes,body.length);assert.equal(snap.receipts[0].blobUrls[0].url,blobUrl);
 const evidence=validateConsumedImageEvidence(snap,args),blobRow={...sourceGet,id:'blobGET',url:blobUrl,type:'Image'},proof=deliveryProofForRow(blobRow,evidence,{origin,manifest});assert.equal(proof.sourceRequestId,'sourceGET');assert.equal(proof.sha256,hash(body));assert.match(proof.source,/not CDP/);assert.ok(!('body' in snap.receipts[0]));
 r.control.freeze();r.control.stop();assert.equal(r.context.Response.prototype.blob.name,'blob');
});
test('one Blob can have two native URLs; API Response blobs are not associated or hashed',async()=>{
 const r=realm(),first=await consumed(r),second=r.context.URL.createObjectURL(r.blob);assert.notEqual(first,second);assert.equal(snapshot(r.control).totalHashedBytes,body.length);assert.equal(snapshot(r.control).receipts[0].blobUrls.length,2);
 const privateResponse=new r.ResponseFixture(new Blob(['private ignored']),origin+'/api/private'),original=privateResponse.blob();assert.equal(original,r.nativePromise(privateResponse));await original;assert.equal(snapshot(r.control).receipts.length,1);
});
test('outer/foreign game and foreign parent realms install no hook',()=>{for(const options of[{foreign:true},{wrongParent:true}]){const r=realm(options);assert.equal(r.control,undefined);assert.equal(r.context.Response.prototype.blob.name,'blob');}});
test('unknown or foreign Blob and wrong actual bytes remain failures',async()=>{
 const r=realm();r.context.URL.createObjectURL(new Blob(['not observed']));assert.ok(snapshot(r.control).errors.includes('RESOURCE_UNKNOWN_BLOB'));
 const foreign=realm(),res=new foreign.ResponseFixture({arrayBuffer:()=>{throw Error('must not read');}});await res.blob();await Promise.resolve();assert.ok(snapshot(foreign.control).errors.includes('RESOURCE_FOREIGN_BLOB_REALM'));
 const wrong=realm();wrong.blob=new Blob(['different bytes']);await consumed(wrong);assert.ok(snapshot(wrong.control).errors.includes('RESOURCE_CONSUMED_BLOB_SHA_MISMATCH'));assert.throws(()=>validateConsumedImageEvidence(snapshot(wrong.control),args),/RESOURCE_EVIDENCE_ERRORS/);
});
test('SHA tasks pending at drain/freeze and new hashing during sampling reject honestly',async()=>{
 let resolveHash;const r=realm({digestHook:()=>new Promise(resolve=>{resolveHash=resolve;})}),response=new r.ResponseFixture(r.blob);await response.blob();r.context.URL.createObjectURL(r.blob);await Promise.resolve();assert.throws(()=>r.control.freeze(),/RESOURCE_HASH_PENDING/);await assert.rejects(r.control.drain(5),/RESOURCE_HASH_DRAIN_TIMEOUT/);assert.equal(snapshot(r.control).pendingTasks,1);resolveHash(await webcrypto.subtle.digest('SHA-256',body));await r.control.drain(1000);r.control.freeze();r.context.URL.createObjectURL(r.blob);assert.ok(snapshot(r.control).errors.includes('RESOURCE_OBJECT_URL_DURING_SAMPLING'));assert.equal(snapshot(r.control).pendingTasks,0);
});
test('same bytes with wrong nonce/document/time/context, POST, unclosed transfer, SW or ambiguous original GET reject',async()=>{
 const r=realm();await consumed(r);const snap=snapshot(r.control);for(const mutation of[
 x=>x.identity.nonce='foreign',x=>x.identity.documentId='b'.repeat(32),x=>x.identity.timeOrigin++,x=>x.pendingTasks=1,x=>x.receipts[0].sha256='c'.repeat(64),x=>x.receipts[0].blobUrls=[]]){const changed=structuredClone(snap);mutation(changed);assert.throws(()=>validateConsumedImageEvidence(changed,args));}
 for(const get of[{...sourceGet,method:'POST'},{...sourceGet,frameId:'foreign'},{...sourceGet,transferFinished:false},{...sourceGet,response:{status:200,fromServiceWorker:true}}])assert.throws(()=>validateConsumedImageEvidence(snap,{...args,requests:[get]}));
 assert.throws(()=>validateConsumedImageEvidence(snap,{...args,requests:[sourceGet,{...sourceGet,id:'duplicate'}]}),/AMBIGUOUS/);assert.throws(()=>deliveryProofForRow({...sourceGet,url:origin+'/arena/assets/unknown.webp'},validateConsumedImageEvidence(snap,args),{origin,manifest}),/UNPROVEN/);
});
test('init requires an authored disposable and never uses addBinding/fetch or replaces unknown hooks on dispose',async()=>{
 let captured;const installed=await installOwnedPlayerResourceEvidence({async addInitScript(fn,arg){captured={fn,arg};return{async dispose(){captured.disposed=true;}};}},{origin,entryUrl,games:['run'],manifest,nonce});assert.equal(captured.fn,installConsumedImageEvidence);await installed.dispose();assert.equal(captured.disposed,true);
 await assert.rejects(installOwnedPlayerResourceEvidence({async addInitScript(){return undefined;}},{origin,entryUrl,games:['run'],manifest,nonce}),/DISPOSABLE/);
 const r=realm();await consumed(r);const foreign=()=>{};r.context.Response.prototype.blob=foreign;r.control.stop();assert.equal(r.context.Response.prototype.blob,foreign);assert.ok(snapshot(r.control).errors.includes('RESOURCE_HOOK_REPLACED'));
});

test('even a declared output under API/v1 is never a consumed public image candidate',()=>{const modified={expected:new Map([...manifest.expected,['/api/private.webp',hash(body)],['/v1/private.png',hash(body)]])},c=resourceEvidenceConfiguration({origin,entryUrl,games:['run'],manifest:modified,nonce});assert.deepEqual(Object.keys(c.expected),['/arena/assets/cat-fixture.webp']);});
