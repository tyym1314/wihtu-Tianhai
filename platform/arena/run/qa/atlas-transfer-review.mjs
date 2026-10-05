/** Cold same-origin HTTP image transfer in desktop WebKit, not a phone benchmark. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {webkit} from 'playwright';

const root=fileURLToPath(new URL('../../../',import.meta.url)),out=fileURLToPath(new URL('./performance-20260928/',import.meta.url));
const source=`import {preloadIllustratedRunners,RUN_ATLAS_URLS,createRunPortraitLease} from './arena/run/atlas-characters.mjs';
window.done=false;window.frontUrl=RUN_ATLAS_URLS.front;
await preloadIllustratedRunners(['fox','cat']);
const portrait=document.createElement('div');portrait.style.cssText='width:128px;height:128px;background-size:400% 400%';const portraitLease=new URLSearchParams(location.search).get('variant')==='before'?null:await createRunPortraitLease();portrait.style.backgroundImage='url('+(portraitLease?.url||RUN_ATLAS_URLS.front)+')';document.body.append(portrait);
await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
if(new URLSearchParams(location.search).has('expand'))await preloadIllustratedRunners(['fox','cat','bear','rabbit']);
window.done=true;`;
const bundles=new Map(),assets=new Map();
for(const variant of ['before','after']){
 const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:'run-transfer.js',loader:'js'},bundle:true,write:false,outdir:'/virtual-atlas-transfer',format:'esm',minify:true,logLevel:'silent',loader:{'.webp':'file'},plugins:[{name:'controlled-before-after',setup(b){
  b.onResolve({filter:/\.webp\?url$/},a=>({path:resolve(a.resolveDir,a.path.slice(0,-4))}));
  if(variant==='before')b.onLoad({filter:/\/run\/atlas-characters\.mjs$/},async a=>{
   let contents=await readFile(a.path,'utf8');
   assert.ok(contents.includes('function texture(url,options)'));
   const start=contents.indexOf('function texture(url,options)'),end=contents.indexOf('export function preloadIllustratedRunners',start);
   contents=contents.slice(0,start)+`const oldLoader=new T.TextureLoader();function texture(url){if(!cache.has(url))cache.set(url,oldLoader.loadAsync(url).then(t=>{t.colorSpace=T.SRGBColorSpace;t.magFilter=T.LinearFilter;t.minFilter=T.LinearFilter;t.generateMipmaps=false;return t;}).catch(error=>{cache.delete(url);throw error;}));return cache.get(url);}`+contents.slice(end);
   const selected='...selectRunPreloadKinds(kinds).map(kind=>RUN_CYCLE_URLS[kind])';assert.ok(contents.includes(selected));
   contents=contents.replace(selected,'...Object.values(RUN_CYCLE_URLS)');
   return{contents,loader:'js',resolveDir:dirname(a.path)};
  });
 }}]});
 bundles.set('/'+variant+'.js',bundle.outputFiles.find(f=>f.path.endsWith('.js')).contents);
 for(const file of bundle.outputFiles.filter(f=>f.path.endsWith('.webp')))assets.set('/'+basename(file.path),file.contents);
}
let requests=[];
const server=createServer((req,res)=>{
 const url=new URL(req.url,'http://local'),path=url.pathname;
 if(assets.has(path)){
  const data=assets.get(path);requests.push({path,bytes:data.length,fetchMode:req.headers['sec-fetch-mode']||null,origin:req.headers.origin||null});
  res.writeHead(200,{'content-type':'image/webp','content-length':data.length,'cache-control':'public, max-age=31536000, immutable'});res.end(data);return;
 }
 if(bundles.has(path)){res.setHeader('content-type','text/javascript');res.end(bundles.get(path));return;}
 const variant=url.searchParams.get('variant')==='before'?'before':'after';
 res.setHeader('content-type','text/html');res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><script type="module" src="/${variant}.js"></script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));await mkdir(out,{recursive:true});
const browser=await webkit.launch({headless:true}),results=[];
try{
 for(const name of ['before','after','after-expand']){
  requests=[];const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?variant=${name==='before'?'before':'after'}${name==='after-expand'?'&expand=1':''}`,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.done);await page.waitForTimeout(100);
  const resources=await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>e.name.endsWith('.webp')).map(e=>({path:new URL(e.name).pathname,initiator:e.initiatorType,encoded:e.encodedBodySize,decoded:e.decodedBodySize,transfer:e.transferSize})));
  const front=requests.filter(r=>r.path.includes('front-win')),run=requests.filter(r=>r.path.includes('run-'));
  const result={name,serverRequests:[...requests],serverImageBodyBytes:requests.reduce((sum,r)=>sum+r.bytes,0),frontRequests:front.length,frontBytes:front.reduce((sum,r)=>sum+r.bytes,0),runFiles:run.map(r=>r.path),resources,errors};
  assert.deepEqual(errors,[]);assert.equal(front.length,name==='before'?2:1,'Actual HTTP front atlas request count');
  assert.equal(run.length,name==='after'?2:4,'Roster only downloads required run atlases');
  assert.equal(new Set(run.map(r=>r.path)).size,run.length,'Expanding a preload never downloads existing run atlases twice');
  results.push(result);await context.close();
 }
 const report={checkedAt:new Date().toISOString(),scope:'Desktop Playwright WebKit, fresh context per case, actual same-origin HTTP with original image bytes and immutable cache. Before build restores anonymous CORS and all-character preloading in memory only. No public API, production deployment or iPhone acceptance.',results,savedImageBodyBytes:results[0].serverImageBodyBytes-results[1].serverImageBodyBytes};
 await writeFile(resolve(out,'atlas-transfer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
