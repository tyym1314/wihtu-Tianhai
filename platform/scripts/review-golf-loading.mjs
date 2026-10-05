import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {webkit} from 'playwright';

const out=resolve(process.env.OASIS_PROFILE_OUT||'review/deep-mobile-20260928/golf-loading-lifecycle');await mkdir(out,{recursive:true});
const server=await createServer({configFile:resolve('arena/vite.config.mjs'),server:{host:'127.0.0.1',port:0}});await server.listen();
const base=server.resolvedUrls.local[0],browser=await webkit.launch({headless:true});
const report={scope:'Desktop WebKit, actual Golf lifecycle fixture and Three loaders. Fault injection verifies error handling; no phone, wallet or performance acceptance.',checks:[],requests:[],errors:[]};
try{
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),page=await context.newPage();
 await context.addInitScript(()=>{
  const stats=window.__golfResources={workers:0,raf:0,intervals:0,gl:{}},NativeWorker=window.Worker;
  let hidden=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>hidden?'hidden':'visible'});window.__golfSetHidden=value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'));};
  window.Worker=class extends NativeWorker{constructor(...args){super(...args);stats.workers++;}terminate(){if(!this.__ended){this.__ended=true;stats.workers--;}return super.terminate();}};
  const raf=requestAnimationFrame,cancel=cancelAnimationFrame,frames=new Set();window.requestAnimationFrame=fn=>{let id=raf(t=>{frames.delete(id);stats.raf=frames.size;fn(t);});frames.add(id);stats.raf=frames.size;return id;};window.cancelAnimationFrame=id=>{frames.delete(id);stats.raf=frames.size;cancel(id);};
  const set=setInterval,clear=clearInterval,intervals=new Map();window.__golfIntervalEvidence=()=>[...intervals.values()];window.setInterval=(...args)=>{const id=set(...args);intervals.set(id,{delay:args[1],stack:new Error().stack});stats.intervals=intervals.size;return id;};window.clearInterval=id=>{intervals.delete(id);stats.intervals=intervals.size;clear(id);};
  const contexts=new Map(),proto=WebGL2RenderingContext.prototype,names=['Buffer','Texture','Program','Framebuffer','Renderbuffer','VertexArray','Shader'];
  Object.defineProperty(stats,'gl',{get(){const totals=Object.fromEntries(names.map(n=>[n,0]));for(const[gl,counts]of contexts)if(!gl.isContextLost())for(const name of names)totals[name]+=counts[name];return totals;}});
  window.__golfContextEvidence=()=>[...contexts].map(([gl,counts])=>({context_lost:gl.isContextLost(),unreleased_handles_at_context_loss:{...counts}}));
  for(const name of names){const create=proto['create'+name],remove=proto['delete'+name],live=new WeakSet();proto['create'+name]=function(...args){const item=create.apply(this,args);if(!contexts.has(this))contexts.set(this,Object.fromEntries(names.map(n=>[n,0])));if(item){live.add(item);contexts.get(this)[name]++;}return item;};proto['delete'+name]=function(item){if(item&&live.has(item)){live.delete(item);contexts.get(this)[name]--;}return remove.call(this,item);};}
 });
 page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>{const path=new URL(r.url()).pathname;if(/\.(glb|wasm)$|draco_wasm_wrapper\.js$/.test(path))report.requests.push({url:path,time:Date.now()});});
 let failOnce=true;await page.route('**/draco_decoder.wasm',route=>{if(failOnce){failOnce=false;return route.abort('failed');}return route.continue();});
 await page.goto(base+'golf/qa/mobile-lifecycle.html',{waitUntil:'domcontentloaded'});
 await page.locator('.og-preparing').filter({hasText:'场景暂时无法启动'}).waitFor({timeout:45000});assert(await page.getByTestId('golf-shoot').isDisabled());assert.equal(await page.locator('canvas').count(),0);
 assert(await page.evaluate(()=>window.__golfResources.workers===0));report.checks.push('early WASM failure is caught, ready remains blocked, no canvas or decoder worker remains');
 const firstModel=report.requests.findIndex(r=>r.url.endsWith('.glb')),decoder=report.requests.map((r,i)=>/\.(wasm)$|draco_wasm_wrapper\.js$/.test(r.url)?i:-1).filter(i=>i>=0);
 assert.equal(decoder.length,2);assert(decoder.every(i=>i<firstModel),'decoder dependencies start before model requests');report.checks.push('both decoder dependencies are requested before the first GLB');
 await page.evaluate(()=>window.golfLifecycle.hide());await page.getByTestId('unmounted').waitFor();report.baselineIntervals=await page.evaluate(()=>window.__golfIntervalEvidence());await page.evaluate(()=>window.golfLifecycle.show());
 await page.waitForFunction(()=>document.querySelector('[data-testid="golf-shoot"]')?.disabled===false,null,{timeout:45000});
 assert(await page.evaluate(()=>window.__golfResources.workers===0));report.checks.push('retry after failed decoder succeeds and releases all decoder workers');
 report.holeSamples=[];
 for(let cycle=0;cycle<3;cycle++)for(const hole of[0,1,2]){
  await page.evaluate(hole=>window.golfLifecycle.hole(hole),hole);await page.waitForFunction(hole=>document.querySelector('.og-canvas')?.dataset.renderedHole===String(hole)&&document.querySelector('[data-testid="golf-shoot"]')?.disabled===false,hole);
  const gl=await page.evaluate(()=>window.__golfResources.gl);report.holeSamples.push({cycle,hole,gl});assert.equal(await page.locator('canvas').count(),1);
  if(cycle===2)assert.deepEqual(gl,report.holeSamples.find(s=>s.cycle===1&&s.hole===hole).gl,'repeated hole transitions must not accumulate GL handles');
 }
 report.checks.push('three cycles through all three holes keep per-hole GL handles stable after warming');
 await page.evaluate(()=>window.__golfSetHidden(true));await page.waitForTimeout(100);const hidden=await page.evaluate(()=>({raf:window.__golfResources.raf,intervals:window.__golfResources.intervals}));assert.equal(hidden.raf,0);assert.equal(hidden.intervals,report.baselineIntervals.length);report.hidden=hidden;
 await page.evaluate(()=>window.__golfSetHidden(false));await page.waitForFunction(()=>window.__golfResources.raf===1);assert.equal(await page.evaluate(()=>window.__golfResources.intervals),report.baselineIntervals.length+1);report.checks.push('controlled hidden/resume: scene RAF and 80ms display timer stop and restart once; authority data is unchanged (not a physical background test)');
 report.exitSamples=[];
 for(let i=0;i<10;i++){
  await page.evaluate(()=>window.golfLifecycle.hide());await page.getByTestId('unmounted').waitFor();assert.equal(await page.locator('canvas').count(),0);
  const sample=await page.evaluate(async()=>({resources:structuredClone(window.__golfResources),cached_source_listeners:await window.golfLifecycle.sourceListeners()}));report.exitSamples.push(sample);
  assert.equal(sample.resources.workers,0);assert.equal(sample.resources.raf,0);assert.equal(sample.resources.intervals,report.baselineIntervals.length);assert.equal(sample.cached_source_listeners,0);assert(Object.values(sample.resources.gl).every(n=>n===0));
  if(i)assert.deepEqual(sample,report.exitSamples[0]);
  await page.evaluate(()=>window.golfLifecycle.show());await page.waitForFunction(()=>document.querySelector('[data-testid="golf-shoot"]')?.disabled===false);assert.equal(await page.locator('canvas').count(),1);
 }
 await page.evaluate(()=>window.golfLifecycle.hide());await page.getByTestId('unmounted').waitFor();report.contexts=await page.evaluate(()=>window.__golfContextEvidence());
 assert(report.contexts.every(c=>c.context_lost));report.checks.push('ten source-cache exits/remounts leave no active worker, RAF, game interval, cached-source listener or live-context GL handle (Vite HMR interval baseline separately recorded); retired contexts explicitly lost');
 await page.evaluate(()=>window.golfLifecycle.show());await page.waitForFunction(()=>document.querySelector('[data-testid="golf-shoot"]')?.disabled===false);
 await page.screenshot({path:resolve(out,'golf-ready.png')});assert.deepEqual(report.errors,[]);await context.close();report.passed=true;
}catch(error){report.failure=error.message;throw error;}finally{await browser.close();await server.close();await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
