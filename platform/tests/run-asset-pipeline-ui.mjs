/** Real original assets and Run preparation over loopback; no API/device acceptance. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root=resolve(new URL('..',import.meta.url).pathname),label=process.env.RUN_PIPELINE_LABEL||new Date().toISOString().replace(/[:.]/g,'-'),out=resolve(root,'review/run-asset-pipeline',label);
const tracked=['arena/main.jsx','arena/run/asset-loading.mjs','arena/run/asset-sources.mjs','arena/run/source-cache.mjs','arena/run/asset-urls.mjs','arena/run/atlas-characters.mjs','arena/run/environment.mjs','tests/run-asset-pipeline-ui.mjs'];
const hash=data=>createHash('sha256').update(data).digest('hex'),pins=()=>Promise.all(tracked.map(async path=>[path,hash(await readFile(resolve(root,path)))])).then(Object.fromEntries);
const before=await pins();
const entry=`import {prepareRunGameSources,acquireRunImageSource,acquireRunModelSource} from './arena/run/asset-sources.mjs';
 import {runAssetSourcePlan} from './arena/run/asset-urls.mjs';
 const plan=runAssetSourcePlan(['fox','cat']);window.qaPrepared=false;window.qaObjects=[];
 const objectURL=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{window.qaObjects.push(blob);return objectURL(blob)};
 const sha=async buffer=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(n=>n.toString(16).padStart(2,'0')).join('');
 window.qaBegin=async()=>{window.qaPrepared=false;await prepareRunGameSources(plan,options=>import('./arena/run/RunGame.jsx').then(module=>module.preloadRunAssets(['fox','cat'],options)));window.qaPrepared=true;
  return{images:await Promise.all(plan.images.map(async url=>{const blob=await acquireRunImageSource(url);return{url,bytes:blob.size,sha256:await sha(await blob.arrayBuffer()),originalBlobDecodes:window.qaObjects.filter(value=>value===blob).length}})),models:await Promise.all(plan.models.map(async url=>{const data=await acquireRunModelSource(url);return{url,bytes:data.byteLength,sha256:await sha(data)}}))};};window.qaBooted=true;`;
const bundle=await build({stdin:{contents:entry,resolveDir:root,sourcefile:'run-asset-pipeline-entry.mjs'},bundle:true,splitting:true,write:false,outdir:'/virtual-run-pipeline',format:'esm',minify:true,assetNames:'assets/[name]-[hash]',loader:{'.glb':'file','.webp':'file','.png':'file'},logLevel:'silent'});
const files=new Map(bundle.outputFiles.map(file=>['/'+file.path.split('/virtual-run-pipeline/')[1],file.contents])),renderer=[...files.keys()].find(path=>/^\/RunGame-.*\.js$/.test(path));assert(renderer,'Split renderer module is required for the real cold dependency race');
const requests=[],errors=[];let rendererFinished=false;
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://fixture').pathname;
 if(path==='/'){res.setHeader('content-type','text/html');res.end('<meta charset="utf-8"><script type="module" src="/stdin.js"></script>');return;}
 if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}
 const data=files.get(path);if(!data){errors.push('UNKNOWN_FIXTURE_RESOURCE: '+path);res.writeHead(404);res.end();return;}
 const row={path,startedAt:Date.now(),bytes:data.length};requests.push(row);res.setHeader('content-type',path.endsWith('.glb')?'model/gltf-binary':path.endsWith('.webp')?'image/webp':path.endsWith('.css')?'text/css':'text/javascript');
 const send=()=>{row.finishedAt=Date.now();res.end(data);if(path===renderer)rendererFinished=true;};if(path===renderer)setTimeout(send,600);else send();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'chrome',headless:true}),report={scope:'Actual Run raw fetch, original Blob decode, GLTF preparation and retained cache over loopback Chrome; delayed renderer module is a test condition. No scene-ready, gameplay, physical device or launch-performance pass claim.',renderer,sourceBefore:before,requests,errors};
try{
 const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('http://127.0.0.1:'+server.address().port+'/');await page.waitForFunction(()=>window.qaBooted);
 const preparation=page.evaluate(()=>qaBegin());await page.waitForTimeout(150);assert.equal(rendererFinished,false);assert.equal(await page.evaluate(()=>qaPrepared),false,'earlier downloaded bytes do not unlock decoded assets');
 const early=requests.filter(row=>/\.(webp|glb)$/.test(row.path));assert.equal(early.length,8,'only the two observed runners, common artwork and original kit download while Three waits');
 report.cold=await preparation;const rendererEnd=requests.find(row=>row.path===renderer).finishedAt;assert(early.every(row=>row.startedAt<rendererEnd));
 for(const receipt of [...report.cold.images,...report.cold.models]){const data=files.get(new URL(receipt.url,'http://fixture/').pathname);assert(data);assert.equal(receipt.bytes,data.length);assert.equal(receipt.sha256,hash(data));if(Object.hasOwn(receipt,'originalBlobDecodes'))assert.equal(receipt.originalBlobDecodes,1);}
 const beforeWarm=requests.length;report.warm=await page.evaluate(()=>qaBegin());assert.deepEqual(report.warm,report.cold);assert.equal(requests.length,beforeWarm,'same original raw source, decoded texture and GLB preparation need no repeat GET');
 report.sourceAfter=await pins();assert.deepEqual(report.sourceAfter,before);assert.deepEqual(errors,[]);report.passed=true;
}catch(error){report.failure=error.stack;process.exitCode=1;}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));await mkdir(out,{recursive:true});await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed||false,failure:report.failure||null,requests:requests.length,report:resolve(out,'report.json')}));}
