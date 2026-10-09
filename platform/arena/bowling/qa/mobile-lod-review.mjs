import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../../',import.meta.url));
const output=fileURLToPath(new URL('../../../review/bowling-mobile-20261009/',import.meta.url));
await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root,base:'/arena/',server:{host:'127.0.0.1',port:0}});
await server.listen();
let browser;const report={scope:'Short local Chrome/Metal visual and ownership check. Original meshes are served at new URLs only in the explicit baseline context; same current scene/materials. Not a performance or physical-phone acceptance.',checks:[],errors:[],requests:[]};
try{
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=metal','--no-proxy-server']});
 for(const variant of ['baseline','mobile']){
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,hasTouch:true,isMobile:true});
  if(variant==='baseline'){
   for(const [candidate,source]of [['neon-competition-pin-mobile-v1.glb','neon-competition-pin.glb'],['neon-pearl-ball-mobile-v1.glb','neon-pearl-ball.glb']]){
    const body=await readFile(new URL('../assets/models/'+source,import.meta.url));
    await context.route('**/'+candidate,r=>r.fulfill({status:200,contentType:'model/gltf-binary',body}));
   }
  }
  const page=await context.newPage();
  page.on('pageerror',e=>report.errors.push({variant,message:e.message}));
  page.on('response',r=>{if(r.status()>=400&&!r.url().includes('favicon.ico'))report.errors.push({variant,url:r.url(),status:r.status()});});
  page.on('request',r=>{assert(!/\/api\/|\/v1\//.test(r.url()));if(r.url().endsWith('.glb'))report.requests.push({variant,url:r.url()});});
  await page.goto(server.resolvedUrls.local[0]+'bowling/qa/mobile-lod.html');
  await page.waitForFunction(()=>document.querySelector('[data-scene-ready="true"][data-model-quality="mobile-lod-v1"]'));
  await page.waitForTimeout(1200);
  assert.equal(await page.getByTestId('bowling-roll').isEnabled(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const scene=page.locator('[data-art-quality]');
  await page.screenshot({path:output+variant+'-ready.png'});
  const ready=await scene.evaluate(e=>({...e.dataset}));
  const lane=await page.getByTestId('bowling-canvas').boundingBox();
  // A legal pocket shot keeps collision/rack and camera-closeup visible.
  await page.touchscreen.tap(lane.x+lane.width/2+.24/.85*lane.width/2,lane.y+lane.height*.7);
  await page.getByTestId('bowling-roll').tap();
  await page.waitForFunction(()=>window.bowlingVisual.actions.length===1);
  await page.waitForTimeout(1700);
  await page.screenshot({path:output+variant+'-rolling.png'});
  await page.waitForTimeout(1200);
  await page.screenshot({path:output+variant+'-collision.png'});
  const moving=await scene.evaluate(e=>({...e.dataset}));
  assert.equal(await page.evaluate(()=>window.bowlingVisual.actions.length),1);
  const state=await page.evaluate(()=>window.bowlingVisual.room().game.me);
  if(variant==='mobile'){
   // Keep this scope small; the full lifetime harness covers fault injection.
   for(let i=0;i<3;i++){
    await page.evaluate(()=>window.bowlingVisual.hide());await page.getByTestId('unmounted').waitFor();
    assert.equal(await page.locator('canvas').count(),0);
    await page.evaluate(()=>window.bowlingVisual.show());
    await page.waitForFunction(()=>document.querySelector('[data-scene-ready="true"]'));
    assert.equal(await page.locator('canvas').count(),1);
   }
  }
  report.checks.push({variant,ready,moving,shotId:state.shotId,modelAssetsDecoded:true,legalRollAccepted:true,mountChecks:variant==='mobile'?3:0});
  await context.close();
 }
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(e){report.failure=e.stack;process.exitCode=1;}
finally{await browser?.close();await server.close();report.resourcesClosed=true;await writeFile(output+'visual-report.json',JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report));
