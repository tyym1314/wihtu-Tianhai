import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const out=resolve(process.env.GOLF_LOD_OUT||'review/golf-performance-20261009/lod/visual'),candidates=resolve(process.env.GOLF_LOD_CANDIDATES||'review/golf-performance-20261009/lod/candidates');await mkdir(out,{recursive:true});
const server=await createServer({configFile:resolve('arena/vite.config.mjs'),server:{host:'127.0.0.1',port:0}});await server.listen();const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-proxy-server']}),report={scope:'Three authored mobile course cameras and cup closeups; fixed clock/animation timestamps for geometry A/B. No frame-time, phone or scoring claim.',completed:false,scenes:[]};
try{
 for(const course of[0,1,2])for(const view of['wide','closeup'])for(const variant of['original','candidate']){
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,hasTouch:true,isMobile:true}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/oasis-*.glb',async route=>{const url=route.request().url(),match=url.match(/oasis-course-([123])/),file=match?`oasis-course-${match[1]}${variant==='candidate'?'-mobile-lod-v1':''}.glb`:`oasis-botanical-library${variant==='candidate'?'-mobile-lod-v1':''}.glb`,dir=variant==='candidate'?candidates:resolve('arena/golf/assets/models');await route.fulfill({status:200,contentType:'model/gltf-binary',body:await readFile(resolve(dir,file))});});
  await page.goto(server.resolvedUrls.local[0]+`golf/qa/lod-visual.html?course=${course}&view=${view}`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.golfLODReview?.finished||window.golfLODReview?.error,null,{timeout:45000,polling:100});
  const data=await page.evaluate(()=>({review:{...window.golfLODReview,dispose:undefined},dataset:{...document.getElementById('scene').dataset},canvas:{width:document.querySelector('canvas')?.width,height:document.querySelector('canvas')?.height}}));assert(!data.review.error);assert.deepEqual(errors,[]);await page.locator('#scene').screenshot({path:resolve(out,`course-${course+1}-${view}-${variant}.png`)});report.scenes.push({course:course+1,view,variant,...data,errors});await page.evaluate(()=>window.golfLODReview.dispose());await context.close();
 }
 report.completed=true;
}finally{await browser.close();await server.close();await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({completed:report.completed,scenes:report.scenes.map(({course,view,variant,dataset})=>({course,view,variant,triangles:dataset.triangles,calls:dataset.renderCalls})),out},null,2));
