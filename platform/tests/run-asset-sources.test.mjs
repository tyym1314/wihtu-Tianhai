import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {prepareRunGameSources,preloadRunSources,acquireRunImageSource,acquireRunModelSource} from '../arena/run/asset-sources.mjs';
import {loadRunTexture} from '../arena/run/asset-loading.mjs';

const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function nativeFetch(t,implementation){t.mock.method(globalThis,'fetch',implementation);}
function decoder(t){
 const consumed=[],revoked=[];
 t.mock.method(URL,'createObjectURL',blob=>{consumed.push(blob);return 'blob:run-source-test-'+consumed.length;});
 t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url));
 const original=Object.getOwnPropertyDescriptor(globalThis,'Image');globalThis.Image=class{set src(url){if(url)queueMicrotask(()=>this.onload?.());}decode(){return Promise.resolve();}};t.after(()=>original?Object.defineProperty(globalThis,'Image',original):delete globalThis.Image);
 return{consumed,revoked};
}

test('cold sources download during delayed renderer import; decode/GLB parse consume the same original bytes once',async t=>{
 const imageUrl='/cold/run-fox-v4-mobile-bd3571fd7e.webp',modelUrl='/cold/oasis-kit-runtime-v1.glb',moduleReady=deferred(),images=decoder(t),calls=[],original={};
 const [imageBytes,modelBytes]=await Promise.all([readFile(new URL('../arena/run/assets/atlases/run-fox-v4-mobile-bd3571fd7e.webp',import.meta.url)),readFile(new URL('../arena/run/assets/environment/oasis-kit-runtime-v1.glb',import.meta.url))]);
 nativeFetch(t,async(url,options)=>{calls.push({url,options});return{ok:true,blob:async()=>original.image=new Blob([imageBytes]),arrayBuffer:async()=>original.model=modelBytes.buffer.slice(modelBytes.byteOffset,modelBytes.byteOffset+modelBytes.byteLength)};});
 let decoded=false,prepared=false;
 const preparation=prepareRunGameSources({images:[imageUrl,imageUrl],models:[modelUrl]},async options=>{await moduleReady.promise;const [texture,data]=await Promise.all([loadRunTexture(imageUrl,{...options,retainBlob:true}),acquireRunModelSource(modelUrl,options)]);assert.equal(data,original.model);assert.equal(texture.userData.sourceBlob,original.image);texture.dispose();decoded=true;}).then(()=>{prepared=true;});
 await flush();assert.deepEqual(calls.map(c=>c.url),[imageUrl,modelUrl]);assert.equal(decoded,false);assert.equal(prepared,false,'download completion does not declare decoded/rendered scene readiness');
 moduleReady.resolve();await preparation;
 assert.equal(calls.length,2);assert.equal(calls[0].options.mode,'no-cors');assert.equal(calls[0].options.credentials,'include');assert.equal(images.consumed[0],original.image);assert.equal(images.revoked.length,1);
 assert.equal(digest(Buffer.from(await original.image.arrayBuffer())),digest(imageBytes));assert.equal(digest(Buffer.from(original.model)),digest(modelBytes));
});

test('two-to-four roster effect handoff retains one real GET for common sources while renderer import is pending',async t=>{
 const pending=new Map(),calls=new Map(),signals=new Map(),moduleReady=deferred();
 nativeFetch(t,(url,{signal})=>{calls.set(url,(calls.get(url)||0)+1);signals.set(url,signal);const transfer=deferred();pending.set(url,transfer);return transfer.promise;});
 const firstController=new AbortController(),common=['/handoff/fox','/handoff/cat','/handoff/action','/handoff/front'],plan=images=>({images,models:['/handoff/kit']}),decode=async options=>{await moduleReady.promise;await preloadRunSources(plan([...common,'/handoff/bear','/handoff/rabbit']),options);};
 const previous=assert.rejects(prepareRunGameSources(plan(common),decode,{signal:firstController.signal}),e=>e.name==='AbortError');await flush();firstController.abort();
 const next=prepareRunGameSources(plan([...common,'/handoff/bear','/handoff/rabbit']),decode);await previous;await flush();
 assert.equal(calls.size,7);for(const [url,count]of calls){assert.equal(count,1,url);assert.equal(signals.get(url).aborted,false,url);pending.get(url).resolve({ok:true,blob:async()=>new Blob([url]),arrayBuffer:async()=>new ArrayBuffer(4)});}
 moduleReady.resolve();await next;assert.equal([...calls.values()].reduce((a,b)=>a+b,0),7);
});

test('cancelled abandoned entry aborts transfers, cannot lend late bytes to the retry, and pre-aborted entry sends nothing',async t=>{
 const url='/cancel/image',old=deferred(),calls=[],controller=new AbortController();
 nativeFetch(t,(url,options)=>{calls.push(options);return calls.length===1?old.promise:Promise.resolve({ok:true,blob:async()=>new Blob(['fresh'])});});
 const first=assert.rejects(preloadRunSources({images:[url],models:[]},{signal:controller.signal}),e=>e.name==='AbortError');await flush();controller.abort();await first;await flush();assert.equal(calls[0].signal.aborted,true);
 const fresh=await acquireRunImageSource(url);old.resolve({ok:true,blob:async()=>new Blob(['old'])});await flush();assert.equal(await acquireRunImageSource(url),fresh);assert.equal(await fresh.text(),'fresh');assert.equal(calls.length,2);
 const stopped=new AbortController();stopped.abort();await assert.rejects(prepareRunGameSources({images:['/cancel/never'],models:[]},()=>assert.fail('cancelled module preparation must not run'),{signal:stopped.signal}),e=>e.name==='AbortError');assert.equal(calls.length,2);
});

test('renderer module failure remains the original error and cancels only its source consumers',async t=>{
 const url='/module-failure/shared',transfer=deferred(),failure=deferred();let signal,calls=0;
 nativeFetch(t,(_url,options)=>{calls++;signal=options.signal;return transfer.promise;});
 const outside=acquireRunImageSource(url),error=new Error('renderer import failed');
 const preparation=assert.rejects(prepareRunGameSources({images:[url],models:[]},()=>failure.promise),e=>e===error);await flush();failure.reject(error);await preparation;assert.equal(signal.aborted,false,'independent scene owner retains its transfer');
 const blob=new Blob(['shared']);transfer.resolve({ok:true,blob:async()=>blob});assert.equal(await outside,blob);assert.equal(calls,1);
});

test('failed HTTP/body transfers are not cached as readiness and actual retry sends a fresh GET',async t=>{
 for(const [kind,stage]of [['image','http'],['model','http'],['image','body'],['model','body']]){
  const url='/retry/'+kind+'-'+stage;
  let calls=0;nativeFetch(t,async()=>{calls++;return calls===1?(stage==='http'?{ok:false}:{ok:true,blob:async()=>{throw Error('original image body failure')},arrayBuffer:async()=>{throw Error('original model body failure')}}):kind==='image'?{ok:true,blob:async()=>new Blob(['real retry'])}:{ok:true,arrayBuffer:async()=>new ArrayBuffer(8)};});
  const acquire=kind==='image'?acquireRunImageSource:acquireRunModelSource;await assert.rejects(acquire(url),stage==='http'?/download failed/:/original .* body failure/);await acquire(url);assert.equal(calls,2);
 }
});
