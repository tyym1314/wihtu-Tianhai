import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createImagePreloader} from '../arena/shared/image-preloader.mjs';
const source=await readFile(new URL('../arena/towerlink/tower-assets.mjs',import.meta.url),'utf8');
const files={sky:'sky.webp',terrain:'terrain.webp',barracks:'barracks.webp',citadel:'citadel.webp',soldiers:'soldiers.webp'};
let serial=0;
async function fixture(selectedFiles=files){
 const images=[],timers=new Map();class FakeImage{constructor(){images.push(this);}decode(){return this.decoded||Promise.resolve();}}
 const preload=createImagePreloader({ImageClass:FakeImage,setTimer:(fn,ms)=>{timers.set(fn,ms);return fn;},clearTimer:fn=>timers.delete(fn)}),key='__tower_assets_fixture_'+serial++;
 globalThis[key]=preload;
 const transformed=source.replace("import {preloadImages} from '../shared/image-preloader.mjs';",`const preloadImages=globalThis[${JSON.stringify(key)}];`).replace("import.meta.glob('./assets/v2/*.webp',{eager:true,query:'?url',import:'default'})",JSON.stringify(Object.fromEntries(Object.values(selectedFiles).map(name=>['./assets/v2/'+name,'/assets/'+name])))).replace("import.meta.glob('./assets/v2/manifest.json',{eager:true,import:'default'})",JSON.stringify({'./assets/v2/manifest.json':{files:selectedFiles}}));
 try{return{module:await import('data:text/javascript;base64,'+Buffer.from(transformed).toString('base64')),images,timers};}finally{delete globalThis[key];}
}
const flush=()=>new Promise(setImmediate);

test('Tower uses shared same-origin images and retains the deadline through decode',async()=>{
 const f=await fixture(),loading=f.module.preloadTowerAssets();assert.equal(f.images.length,5);assert([...f.timers.values()].every(ms=>ms===20000));
 let release;f.images[0].decoded=new Promise(resolve=>release=resolve);
 for(const image of f.images){assert.equal(image.crossOrigin,undefined);image.onload();}
 await flush();assert.equal(f.timers.size,1);assert.equal(f.module.getTowerImage('sky.webp'),undefined,'no partially prepared set is published');
 release();const result=await loading;assert.equal(result.images.size,5);assert.equal(f.module.getTowerImage('sky.webp'),f.images[0]);assert.equal(f.timers.size,0);
});

test('Tower decode timeout permits a new image while late old decode cannot replace it',async()=>{
 const f=await fixture(),loading=f.module.preloadTowerAssets();let releaseOld;f.images[0].decoded=new Promise(resolve=>releaseOld=resolve);
 const rejected=assert.rejects(loading,error=>error.code==='TOWER_ASSETS_FAILED'&&error.failures.includes('sky:sky.webp'));
 for(const image of f.images)image.onload();await flush();assert.equal(f.timers.size,1);[...f.timers.keys()][0]();await rejected;assert.equal(f.images[0].src,'');
 const retry=f.module.preloadTowerAssets({retry:true});assert.equal(f.images.length,6,'four successful images remain cached');f.images[5].onload();await retry;
 const prepared=f.module.getTowerImage('sky.webp');assert.equal(prepared,f.images[5]);releaseOld();await flush();assert.equal(f.module.getTowerImage('sky.webp'),prepared);assert.equal(f.timers.size,0);
});

test('Tower failed cache retries without a flag and shares a pending or completed barrier',async()=>{
 const f=await fixture(),loading=f.module.preloadTowerAssets();assert.equal(f.module.preloadTowerAssets({retry:true}),loading,'retry must not introduce a competing pending generation');
 const rejected=assert.rejects(loading,{code:'TOWER_ASSETS_FAILED'});f.images[0].onerror();for(const image of f.images.slice(1))image.onload();await rejected;
 const retry=f.module.preloadTowerAssets();assert.notEqual(retry,loading);assert.equal(f.images.length,6);f.images[5].onload();await retry;assert.equal(f.module.preloadTowerAssets({retry:true}),retry);assert.equal(f.timers.size,0);
});

test('Tower incomplete core manifest stays unavailable after valid listed images finish',async()=>{
 const f=await fixture(Object.fromEntries(Object.entries(files).slice(0,4))),loading=f.module.preloadTowerAssets(),rejected=assert.rejects(loading,error=>error.code==='TOWER_ASSETS_FAILED'&&error.failures.includes('manifest:missing-core-assets'));
 for(const image of f.images)image.onload();await rejected;assert.equal(f.module.getTowerImage('sky.webp'),undefined);assert.equal(f.timers.size,0);
});
