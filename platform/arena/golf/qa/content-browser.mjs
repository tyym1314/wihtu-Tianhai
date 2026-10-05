import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {webkit} from 'playwright';
import {GOLF_HOLES} from '../content.mjs';
const out=resolve('review/deep-mobile-20260928/golf-content');await mkdir(out,{recursive:true});
const server=await createServer({configFile:resolve('arena/vite.config.mjs'),server:{host:'127.0.0.1',port:0}});await server.listen();
const base=server.resolvedUrls.local[0],browser=await webkit.launch({headless:true}),report={scope:'Desktop WebKit mobile viewport, real Three scene and trusted aim/shoot button taps; local presentation fixture, no wallet or physical-phone claim.',cases:[],errors:[]};
try{
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2}),page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 for(const hole of GOLF_HOLES){
  await page.goto(base+'golf/qa/content.html?hole='+hole.id,{waitUntil:'domcontentloaded'});await page.waitForFunction(id=>document.querySelector('.og-canvas')?.dataset.renderedLevel===id&&document.querySelector('[data-testid="golf-shoot"]')?.disabled===false,hole.id,{timeout:45000});
  assert.equal(await page.getByTestId('golf-course-card').count(),3);assert.equal(await page.locator('[aria-current="step"]').getAttribute('data-level-id'),hole.id);assert((await page.locator('[aria-current="step"]').innerText()).includes(hole.name));
  await page.screenshot({path:resolve(out,hole.id+'.png')});const before=Number(await page.locator('.og-game').getAttribute('data-angle'));
  await page.getByRole('button',{name:'向右微调',exact:true}).tap();const aimed=Number(await page.locator('.og-game').getAttribute('data-angle'));assert(Math.abs(aimed-before-.07)<.0002);
  await page.getByTestId('golf-shoot').tap();await page.waitForFunction(()=>window.golfContentReview.accepted().length===1);const accepted=await page.evaluate(()=>window.golfContentReview.accepted()[0]);assert(Math.abs(accepted.action.angle-aimed)<.0002);assert.equal(accepted.action.power,.58);report.cases.push({id:hole.id,name:hole.name,difficulty:hole.difficulty,acceptedAction:accepted.action,trajectoryPoints:accepted.trajectory.length});
 }
 // Equal geometry/camera comparison. Only these six texture responses differ.
 const textureManifest=JSON.parse(await readFile(resolve('arena/golf/assets/mobile-textures.json'),'utf8'));
 const routes=[];for(const item of textureManifest){const pattern='**/'+item.optimized_url.split('/').at(-1);routes.push(pattern);await page.route(pattern,async route=>route.fulfill({status:200,contentType:'image/webp',body:await readFile(resolve('..',item.source))}));}
 await page.goto(base+'golf/qa/content.html?hole=palm-golden-putt');await page.waitForFunction(()=>document.querySelector('[data-testid="golf-shoot"]')?.disabled===false);await page.waitForTimeout(800);await page.screenshot({path:resolve(out,'textures-before.png')});
 for(const pattern of routes)await page.unroute(pattern);
 await page.reload();await page.waitForFunction(()=>document.querySelector('[data-testid="golf-shoot"]')?.disabled===false);await page.waitForTimeout(800);await page.screenshot({path:resolve(out,'textures-q76.png')});report.textureComparison='Same fixture and six runtime URLs: original source responses versus current optimized assets; visual only, no transfer/performance timing claim.';
 assert.deepEqual(report.errors,[]);report.passed=true;await context.close();
}catch(error){report.failure=error.message;throw error;}finally{await browser.close();await server.close();await writeFile(resolve(out,'browser.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
