import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createRunSourceCache,loadRunTexture,prepareRunAssets} from '../asset-loading.mjs';
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
test('A timeout retires the source; late value is disposed and cannot evict the successful retry',async()=>{
 let calls=0,late,disposed=0;const ready={id:2},cache=createRunSourceCache(()=>++calls===1?new Promise(resolve=>late=resolve):Promise.resolve(ready),{timeoutMs:15,dispose:()=>disposed++});
 await assert.rejects(cache(),/timed out/);assert.equal(await cache(),ready);late({id:1});await flush();assert.equal(disposed,1);assert.equal(await cache(),ready);assert.equal(calls,2);
});
test('Consumers share one request; one cancellation keeps others, last cancellation aborts it',async()=>{
 let calls=0,sourceSignal;const cache=createRunSourceCache(({signal})=>{calls++;sourceSignal=signal;return new Promise(()=>{});});const a=new AbortController(),b=new AbortController(),first=assert.rejects(cache({signal:a.signal}),e=>e.name==='AbortError'),second=assert.rejects(cache({signal:b.signal}),e=>e.name==='AbortError');await flush();a.abort();await first;assert.equal(sourceSignal.aborted,false);b.abort();await second;assert.equal(sourceSignal.aborted,true);assert.equal(calls,1);
});
test('Aggregate failure aborts its sibling consumer but cannot cancel an independent owner',async()=>{
 let finish,sourceSignal;const value={id:1},cache=createRunSourceCache(({signal})=>{sourceSignal=signal;return new Promise(resolve=>finish=resolve);});const outside=cache();await assert.rejects(prepareRunAssets([cache,()=>Promise.reject(Error('one asset failed'))]),/one asset failed/);assert.equal(sourceSignal.aborted,false);finish(value);assert.equal(await outside,value);
});
test('Pre-aborted consumers issue no request, including aggregate construction',async()=>{
 let calls=0;const cache=createRunSourceCache(()=>{calls++;});const controller=new AbortController();controller.abort();await assert.rejects(cache({signal:controller.signal}),e=>e.name==='AbortError');await assert.rejects(prepareRunAssets([cache],{signal:controller.signal}),e=>e.name==='AbortError');assert.equal(calls,0);
});
test('Texture fetching keeps CSS no-cors credentials mode; hung decode cancels and revokes its URL',async()=>{
 const original={fetch:globalThis.fetch,Image:globalThis.Image,create:URL.createObjectURL,revoke:URL.revokeObjectURL},images=[],requests=[],urls=new Set();let finishDecode;
 globalThis.fetch=async(url,options)=>{requests.push({url,options});return{ok:true,blob:async()=>new Blob(['fixture'])};};URL.createObjectURL=()=>{const url='blob:run-test';urls.add(url);return url;};URL.revokeObjectURL=url=>urls.delete(url);
 globalThis.Image=class{constructor(){images.push(this);}set src(url){this.url=url;if(url)queueMicrotask(()=>this.onload?.());}get src(){return this.url;}decode(){return new Promise(resolve=>finishDecode=resolve);}};
 try{const cache=createRunSourceCache(options=>loadRunTexture('/same-origin/front-win.webp',options),{timeoutMs:15});await assert.rejects(cache(),/timed out/);assert.equal(requests.length,1);assert.equal(requests[0].options.mode,'no-cors');assert.equal(requests[0].options.credentials,'include');assert.equal(requests[0].options.signal.aborted,true);assert.equal(urls.size,0);assert.equal(images[0].src,'');assert.equal(images[0].onload,null);assert.equal(images[0].crossOrigin,undefined);finishDecode();await flush();assert.equal(urls.size,0);}finally{globalThis.fetch=original.fetch;globalThis.Image=original.Image;URL.createObjectURL=original.create;URL.revokeObjectURL=original.revoke;}
});

test('The current scenery GLB has no hidden external image, buffer or Draco decode requests',()=>{const bytes=readFileSync(new URL('../assets/environment/oasis-kit-runtime-v1.glb',import.meta.url)),length=bytes.readUInt32LE(12),json=JSON.parse(bytes.subarray(20,20+length).toString());assert.equal((json.images||[]).length,0);assert.ok((json.buffers||[]).every(buffer=>!buffer.uri));assert.ok(!(json.extensionsUsed||[]).includes('KHR_draco_mesh_compression'));});

test('A pending two-to-four roster handoff reuses common sources before last-consumer cancellation',async()=>{
 const calls=new Map(),signals=new Map(),complete=new Map();const caches=new Map(['fox','cat','bear','rabbit','actions','front'].map(name=>[name,createRunSourceCache(({signal})=>{calls.set(name,(calls.get(name)||0)+1);signals.set(name,signal);return new Promise(resolve=>complete.set(name,resolve));})]));
 const prepare=(kinds,options)=>prepareRunAssets([options=>prepareRunAssets([...kinds,'actions','front'].map(name=>caches.get(name)),options)],options),firstController=new AbortController();
 const previous=assert.rejects(prepare(['fox','cat'],{signal:firstController.signal}),e=>e.name==='AbortError');await flush();firstController.abort();const next=prepare(['fox','cat','bear','rabbit']);await previous;await flush();
 assert.equal(calls.size,6);for(const name of caches.keys()){assert.equal(calls.get(name),1,name+' must keep one source');assert.equal(signals.get(name).aborted,false,name+' remains owned');complete.get(name)({name});}
 const [values]=await next;assert.deepEqual(values.map(value=>value.name),['fox','cat','bear','rabbit','actions','front']);
});
