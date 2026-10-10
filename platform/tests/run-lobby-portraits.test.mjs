import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRunLobbyPortraitLease,runLobbyCharacter,runLobbyPortraitPosition} from '../arena/run/lobby-portraits.mjs';
import {acquireRunImageSource} from '../arena/run/asset-sources.mjs';
import {loadRunTexture} from '../arena/run/asset-loading.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const flush=()=>new Promise(r=>setTimeout(r,0));
function urls(t){const created=[],revoked=[];t.mock.method(URL,'createObjectURL',blob=>{created.push(blob);return'blob:lobby-'+created.length});t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url));return{created,revoked}}

test('waiting portraits and real Run texture consume one original front Blob; URL disposal is independent and idempotent',async t=>{
 const bytes=await readFile(new URL('../arena/run/assets/atlases/front-win-mobile-902055527a.webp',import.meta.url)),blob=new Blob([bytes]),url='/portrait-shared/front.webp',tracked=urls(t);let count=0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{count++;assert.equal(options.mode,'no-cors');assert.equal(options.credentials,'include');return{ok:true,blob:async()=>blob}});
 const oldImage=Object.getOwnPropertyDescriptor(globalThis,'Image');globalThis.Image=class{set src(url){if(url)queueMicrotask(()=>this.onload?.())}decode(){return Promise.resolve()}};t.after(()=>oldImage?Object.defineProperty(globalThis,'Image',oldImage):delete globalThis.Image);
 const [first,second,texture]=await Promise.all([createRunLobbyPortraitLease(url),createRunLobbyPortraitLease(url),loadRunTexture(url,{retainBlob:true})]);
 assert.equal(count,1);assert.equal(texture.userData.sourceBlob,blob);assert.equal(tracked.created.length,3);assert(tracked.created.every(source=>source===blob));assert.equal(createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex'),'902055527a213b285a521ca893c5cf7a7b4a98aa0de69b5e61ff7db4c29b706f');
 first.dispose();first.dispose();assert.equal(tracked.revoked.filter(value=>value===first.url).length,1);assert.equal(tracked.revoked.includes(second.url),false);second.dispose();texture.dispose();assert.equal(tracked.revoked.length,3);
});
test('cancelled waiting room cannot create a late URL or abort the renderer consumer of the original transfer',async t=>{
 const transfer=deferred(),controller=new AbortController(),tracked=urls(t),url='/portrait-cancel/shared.webp';let sourceSignal,count=0;t.mock.method(globalThis,'fetch',async(_url,{signal})=>{count++;sourceSignal=signal;return transfer.promise});
 const preparation=acquireRunImageSource(url),cancelled=assert.rejects(createRunLobbyPortraitLease(url,{signal:controller.signal}),e=>e.name==='AbortError');await flush();controller.abort();await cancelled;assert.equal(sourceSignal.aborted,false);const blob=new Blob(['original front']);transfer.resolve({ok:true,blob:async()=>blob});assert.equal(await preparation,blob);await flush();assert.equal(tracked.created.length,0);
 const next=await createRunLobbyPortraitLease(url);assert.equal(count,1);assert.equal(tracked.created[0],blob);next.dispose();
});
test('abandoned sole portrait owner cancels its transfer; a pre-aborted lease never fetches or creates a URL',async t=>{
 const transfer=deferred(),controller=new AbortController(),tracked=urls(t);let sourceSignal,count=0;t.mock.method(globalThis,'fetch',async(_url,{signal})=>{count++;sourceSignal=signal;return transfer.promise});const cancelled=assert.rejects(createRunLobbyPortraitLease('/portrait-cancel/sole.webp',{signal:controller.signal}),e=>e.name==='AbortError');await flush();controller.abort();await cancelled;await flush();assert.equal(sourceSignal.aborted,true);transfer.resolve({ok:true,blob:async()=>new Blob(['late'])});await flush();assert.equal(tracked.created.length,0);
 await assert.rejects(createRunLobbyPortraitLease('/portrait-cancel/never.webp',{signal:controller.signal}),e=>e.name==='AbortError');assert.equal(count,1);
});
test('roster preview follows owned seat or actual assigned character, including all four original row crops',()=>{
 const kinds=['fox','cat','bear','rabbit'];for(const[i,kind]of kinds.entries()){assert.equal(runLobbyCharacter(null,{seat_index:i},3-i),kind);assert.equal(runLobbyPortraitPosition(kind),`100% ${i*100/3}%`)}
 assert.equal(runLobbyCharacter({game:{players:[{key:'p0',character:'rabbit'}]}},{external_user_id:'p0',seat_index:0}), 'rabbit');assert.equal(runLobbyCharacter({game:{players:[{key:'foreign',character:'rabbit'}]}},{external_user_id:'p0',seat_index:1}), 'cat');assert.equal(runLobbyCharacter(null,{seat_index:-1},2),'bear');assert.equal(runLobbyPortraitPosition('unknown'),'100% 0%');
});
