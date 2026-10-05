import{chromium}from'playwright';
import assert from'node:assert/strict';
import{writeFile,mkdir}from'node:fs/promises';
const origin=process.env.GOLF_SCENE_ORIGIN||'http://127.0.0.1:18096';
const folder=new URL('./',import.meta.url);await mkdir(folder,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});const checks=[],errors=[];
try{
 for(const fixture of [{width:390,height:844,hole:0,lang:'en'},{width:360,height:800,hole:1,lang:'zh'},{width:390,height:844,hole:2,lang:'ar'}]){
  const page=await browser.newPage({viewport:{width:fixture.width,height:fixture.height},deviceScaleFactor:1});page.on('pageerror',e=>errors.push(e.message));const failed=[];page.on('response',r=>{if(r.status()>=400&&r.url().startsWith(origin))failed.push(r.url());});
  await page.goto(`${origin}/arena/golf/preview.html?hole=${fixture.hole}&lang=${fixture.lang}`);await page.locator('canvas').waitFor();await page.waitForTimeout(1600);
  const size=await page.locator('canvas').boundingBox();assert.equal(size.width,fixture.width);assert.equal(size.height,fixture.height);assert.equal(await page.locator('.og-player').count(),4);
  const initialAngle=Number(await page.locator('.og-game').getAttribute('data-angle'));await page.locator('.og-aim-step').first().click();assert(Number(await page.locator('.og-game').getAttribute('data-angle'))<initialAngle);await page.locator('.og-aim-step').last().click();
  await page.screenshot({path:new URL(`golf-${fixture.width}x${fixture.height}-hole${fixture.hole+1}-${fixture.lang}.png`,folder).pathname});
  if(fixture.hole===0){
   await page.locator('input[type="range"]').evaluate(input=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'0.67');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
   assert((await page.locator('.og-power-label b').innerText()).includes('67'));await page.getByTestId('golf-shoot').click();await page.waitForFunction(()=>document.querySelector('[data-testid="golf-shoot"]').disabled);assert((await page.getByTestId('golf-my-strokes').innerText()).startsWith('1'));
   await page.screenshot({path:new URL('golf-rolling-390.png',folder).pathname});await page.locator('.og-you .og-holed-check').waitFor({timeout:15000});assert((await page.getByTestId('golf-my-strokes').innerText()).startsWith('1'));await page.waitForFunction(()=>document.querySelector('[data-shot-mode="cup-closeup"]'));await page.waitForTimeout(750);await page.screenshot({path:new URL('golf-holed-390.png',folder).pathname});
  }
  assert.equal(failed.length,0);checks.push({...fixture,render:'PASS',fourGhostPlayers:'PASS',aimControls:'PASS',assets:'PASS',shotAndHole:fixture.hole===0?'PASS':'not exercised'});await page.close();
 }
 assert.equal(errors.length,0);const report={status:'PASS',scope:'Desktop Chrome mobile viewports with software WebGL and isolated legal-action scene fixture. Not a physical phone or partner wallet acceptance.',checks,pageErrors:errors};await writeFile(new URL('browser-report.json',folder),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
