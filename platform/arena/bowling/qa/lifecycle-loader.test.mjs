import test from 'node:test';import assert from 'node:assert/strict';
import {createNeonArtPreloader} from '../art.mjs';
function harness(){
 const before={fetch:globalThis.fetch,Image:globalThis.Image},requests=[],images=[],decodes=[];
 globalThis.fetch=(url,{signal})=>new Promise((resolve,reject)=>{const request={url,signal,aborted:false};requests.push(request);const abort=()=>{request.aborted=true;reject(signal.reason);};if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});if(String(url).endsWith('.webp'))resolve({ok:true,blob:async()=>new Blob(['fixture'])});});
 globalThis.Image=class{constructor(){images.push(this);}set src(url){this.url=url;if(url)queueMicrotask(()=>this.onload?.());}get src(){return this.url;}decode(){return new Promise(resolve=>decodes.push(resolve));}};
 return{requests,images,decodes,restore(){globalThis.fetch=before.fetch;globalThis.Image=before.Image;}};
}
test('Deadline aborts owned fetches and hanging image decode; retry allocates fresh requests',async()=>{
 const h=harness();try{const preload=createNeonArtPreloader({timeoutMs:15});await assert.rejects(preload(),/timed out/);assert.equal(h.requests.length,7);assert.ok(h.requests.every(r=>r.aborted));assert.equal(h.images.length,2);assert.ok(h.images.every(image=>image.src===''&&image.onload===null&&image.onerror===null));await assert.rejects(preload(),/timed out/);assert.equal(h.requests.length,14);assert.notEqual(h.requests[0].signal,h.requests[7].signal);for(const resolve of h.decodes)resolve();await new Promise(resolve=>setTimeout(resolve,0));assert.ok(h.requests.every(r=>r.aborted));}finally{h.restore();}
});
test('One consumer cancellation preserves another; last cancellation retires only its generation',async()=>{
 const h=harness();try{const preload=createNeonArtPreloader({timeoutMs:1000}),a=new AbortController(),b=new AbortController();const one=preload({signal:a.signal}),two=preload({signal:b.signal}),first=assert.rejects(one,e=>e.name==='AbortError'),second=assert.rejects(two,e=>e.name==='AbortError');a.abort();await first;assert.equal(h.requests.length,7);assert.ok(h.requests.every(r=>!r.aborted));b.abort();await second;assert.ok(h.requests.every(r=>r.aborted));const c=new AbortController(),next=preload({signal:c.signal}),third=assert.rejects(next,e=>e.name==='AbortError');assert.equal(h.requests.length,14);c.abort();await third;assert.ok(h.requests.every(r=>r.aborted));}finally{h.restore();}
});
test('Already aborted consumers cannot start any source or decoder request',async()=>{const h=harness();try{const preload=createNeonArtPreloader(),controller=new AbortController();controller.abort();await assert.rejects(preload({signal:controller.signal}),e=>e.name==='AbortError');assert.equal(h.requests.length,0);assert.equal(h.images.length,0);}finally{h.restore();}});
