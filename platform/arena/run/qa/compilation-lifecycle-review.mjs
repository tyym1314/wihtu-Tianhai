/** Real WebGL lifecycle with test-only fault injection. No platform rooms or wallet. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {webkit} from 'playwright';
import * as E from '../engine.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const out=fileURLToPath(new URL('./performance-20260928/',import.meta.url));
const game=E.view(E.createState('02'.repeat(32),10000,{players:[{key:'p0',seatIndex:0},{key:'p1',seatIndex:1}]}),'p0');
const source=`import {resolveRunCourse} from './arena/run/courses.mjs';
import {createRunScene} from './arena/run/scene.mjs';
const mode=new URLSearchParams(location.search).get('mode');
window.state={errors:[],ready:0,compileCalls:0,renderCalls:0,disposed:false};
window.__beforeCompile=()=>{state.compileCalls++;if(mode==='compile-error')throw Error('Injected compile failure');};
window.__afterCompile=()=>{if(mode==='exit-after-compile')queueMicrotask(()=>window.stop());};
window.__afterRender=()=>{state.renderCalls++;};
window.__runFault=point=>{if(mode===point+'-error')throw Error('Injected '+point+' failure');};
let scene;try{scene=createRunScene(document.querySelector('#track'),{course:resolveRunCourse(${JSON.stringify(game)}),onError(e){state.errors.push(String(e));},onReady(){state.ready++;state.rendersAtReady=state.renderCalls;}});}catch(error){state.errors.push(String(error));}
window.stop=()=>{scene?.dispose();state.disposed=true;};
scene?.update(${JSON.stringify(game)},'p0');`;
const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:'run-lifecycle.js',loader:'js'},bundle:true,write:false,outdir:'/virtual-run-lifecycle',format:'esm',minify:true,logLevel:'silent',loader:{'.glb':'file','.webp':'file'},plugins:[{name:'lifecycle-observation',setup(b){
 b.onResolve({filter:/\.(glb|webp)\?url$/},a=>({path:resolve(a.resolveDir,a.path.slice(0,-4))}));
 b.onLoad({filter:/\/run\/scene\.mjs$/},async a=>{
  let source=await readFile(a.path,'utf8');
  assert.ok(source.includes('renderer.compile(scene,camera);warmed=true;'));
  source=source.replace('renderer.compile(scene,camera);','window.__beforeCompile();renderer.compile(scene,camera);window.__afterCompile();');
  source=source.replace('renderer.render(scene,camera);','window.__runFault(\'render\');renderer.render(scene,camera);window.__afterRender();');
  source=source.replace('pmrem.fromScene(roomEnvironment,.06)','(window.__runFault(\'pmrem\'),pmrem.fromScene(roomEnvironment,.06))');
  source=source.replace('observer.observe(container);','window.__runFault(\'resize\');observer.observe(container);');
  return{contents:source,loader:'js',resolveDir:dirname(a.path)};
 });
}}]});
const files=new Map(bundle.outputFiles.map(f=>['/'+basename(f.path),f.contents]));
const js=basename(bundle.outputFiles.find(f=>f.path.endsWith('.js')).path);
const server=createServer((req,res)=>{const pathname=new URL(req.url,'http://local').pathname;if(files.has(pathname)){res.setHeader('content-type',pathname.endsWith('.webp')?'image/webp':pathname.endsWith('.glb')?'model/gltf-binary':'text/javascript');res.end(files.get(pathname));return;}res.setHeader('content-type','text/html');res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#track{width:390px;height:844px}</style><div id="track"></div><script type="module" src="/${js}"></script>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));await mkdir(out,{recursive:true});
const browser=await webkit.launch({headless:true}),checks=[];
try{
 for(const mode of ['pmrem-error','resize-error','compile-error','render-error','exit-loading','exit-after-compile','normal']){
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.addInitScript(()=>{const frames=new Set(),observers=new Set(),contexts=new Set(),urls=new Set(),raf=requestAnimationFrame,cancel=cancelAnimationFrame,Observer=ResizeObserver,get=HTMLCanvasElement.prototype.getContext,makeURL=URL.createObjectURL,dropURL=URL.revokeObjectURL;window.requestAnimationFrame=fn=>{let id=raf(at=>{frames.delete(id);fn(at);});frames.add(id);return id;};window.cancelAnimationFrame=id=>{frames.delete(id);cancel(id);};window.ResizeObserver=class extends Observer{constructor(...args){super(...args);observers.add(this);}disconnect(){observers.delete(this);super.disconnect();}};HTMLCanvasElement.prototype.getContext=function(...args){const value=get.apply(this,args);if(args[0]==='webgl2'&&value)contexts.add(value);return value;};URL.createObjectURL=(...args)=>{const url=makeURL(...args);urls.add(url);return url;};URL.revokeObjectURL=url=>{urls.delete(url);dropURL(url);};window.__faultResources=()=>({raf:frames.size,resizeObservers:observers.size,contexts:contexts.size,liveContexts:[...contexts].filter(gl=>!gl.isContextLost()).length,blobURLs:urls.size});});
  let releaseAssets;const heldAssets=new Promise(resolve=>{releaseAssets=resolve;});
  if(mode==='exit-loading')await page.route('**/*.glb',async route=>{await heldAssets;await route.continue().catch(()=>{});});
  try{
   await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}`,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>typeof window.stop==='function');
   if(mode==='exit-loading'){
    await page.waitForTimeout(80);await page.evaluate(()=>window.stop());releaseAssets();
    await page.waitForLoadState('networkidle');await page.waitForTimeout(300);
   }else if(mode.endsWith('-error')){
    await page.waitForFunction(()=>state.errors.length===1);await page.waitForTimeout(300);
   }else if(mode==='exit-after-compile'){
    await page.waitForFunction(()=>state.disposed);await page.waitForTimeout(300);
   }else{
    await page.waitForFunction(()=>state.ready===1);await page.waitForTimeout(50);
   }
   const state=await page.evaluate(()=>({...window.state,canvasCount:document.querySelectorAll('canvas').length,resources:window.__faultResources()}));
   assert.deepEqual(errors,[],mode+' must not leak an uncaught exception or disposed-program timer');
   if(mode.endsWith('-error')){
    assert.equal(state.compileCalls,['compile-error','render-error'].includes(mode)?1:0);assert.equal(state.renderCalls,0);assert.equal(state.ready,0);assert.equal(state.canvasCount,0);
    assert.deepEqual(state.errors,['Error: Injected '+mode.replace('-error','')+' failure']);
   }else{
    assert.deepEqual(state.errors,[]);
    if(mode==='normal'){assert.equal(state.compileCalls,1);assert.equal(state.ready,1);assert.equal(state.rendersAtReady,1);}
    else{assert.equal(state.canvasCount,0);assert.equal(state.renderCalls,0);assert.equal(state.ready,0);assert.equal(state.compileCalls,mode==='exit-loading'?0:1);}
   }
   if(mode!=='normal')assert.deepEqual(state.resources,{raf:0,resizeObservers:0,contexts:1,liveContexts:0,blobURLs:0},mode+' must release partial scene resources');
   checks.push({mode,state,uncaught:errors});
  }finally{releaseAssets();await context.close();}
 }
 const result={checkedAt:new Date().toISOString(),scope:'Desktop WebKit real WebGL. Test-only PMREM/observer/compile/render exceptions, held GLB and exit microtask. Counters verify resource cleanup, not GC heap, iPhone or production acceptance.',passed:true,checks};
 await writeFile(resolve(out,'compilation-lifecycle.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
