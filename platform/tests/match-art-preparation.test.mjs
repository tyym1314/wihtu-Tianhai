import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createMatchCheerPreparation,matchCriticalAssetUrls,matchCheerAssetUrl,preloadMatchAssets,preloadMatchCheer} from '../arena/match/assets.mjs';

function fixture(load){const callbacks=new Map();let serial=0,ready=0;const art=createMatchCheerPreparation({load,requestFrame:fn=>{callbacks.set(++serial,fn);return serial;},cancelFrame:id=>callbacks.delete(id),onReady:()=>ready++});return{art,callbacks,get ready(){return ready;},async frame(){const pending=[...callbacks.values()];callbacks.clear();for(const fn of pending)fn();await Promise.resolve();}};}

test('Match first entrance decodes four critical images; cheer is a separate low-priority, shared preparation',async()=>{
 const before=Object.getOwnPropertyDescriptor(globalThis,'Image'),images=[];
 class FakeImage{constructor(){images.push(this);}decode(){this.decoded=true;return Promise.resolve();}}
 Object.defineProperty(globalThis,'Image',{configurable:true,value:FakeImage});
 try{
  const critical=preloadMatchAssets();assert.equal(images.length,4);assert.equal(matchCriticalAssetUrls.includes(matchCheerAssetUrl),false);
  for(const image of images){assert.equal(image.fetchPriority,'auto');image.onload();}await critical;
  const cheer=preloadMatchCheer();assert.equal(images.length,5);assert.equal(images[4].fetchPriority,'low');images[4].onload();await cheer;
  await preloadMatchCheer();assert.equal(images.length,5,'a later preparation reuses the decoded image');
 }finally{if(before)Object.defineProperty(globalThis,'Image',before);else Reflect.deleteProperty(globalThis,'Image');}
});

test('celebration never delays first paint or retries an in-flight preparation',async()=>{
 let loads=0,finish;const f=fixture(()=>{loads++;return new Promise(resolve=>finish=resolve);});
 const first=f.art.prepare();assert.equal(f.art.prepare(),first);assert.equal(loads,0);
 await f.frame();assert.equal(loads,0);await f.frame();assert.equal(loads,1);assert.equal(f.art.ready,false);
 finish();assert.equal(await first,true);assert.equal(f.art.ready,true);assert.equal(f.ready,1);assert.equal(await f.art.prepare(),true);assert.equal(loads,1);
 f.art.dispose();assert.equal(f.callbacks.size,0);
});

test('optional art failure leaves idle usable and the next operation can retry',async()=>{
 let loads=0;const f=fixture(()=>++loads===1?Promise.reject(Error('offline')):Promise.resolve());
 const failed=f.art.prepare();await f.frame();await f.frame();assert.equal(await failed,false);assert.equal(f.art.ready,false);assert.equal(f.ready,0);
 const retry=f.art.prepare();await f.frame();await f.frame();assert.equal(await retry,true);assert.equal(loads,2);assert.equal(f.ready,1);
});

test('exit cancels pending frame work and a late download/decode cannot update its previous component',async()=>{
 const f=fixture(()=>{throw Error('should not load');});const canceled=f.art.prepare();f.art.dispose();assert.equal(f.callbacks.size,0);assert.equal(await canceled,false);
 let finish;const g=fixture(()=>new Promise(resolve=>finish=resolve)),pending=g.art.prepare();await g.frame();await g.frame();g.art.dispose();finish();assert.equal(await pending,false);assert.equal(g.ready,0);assert.equal(g.art.ready,false);
});
