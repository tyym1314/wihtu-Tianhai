import{chromium}from'playwright';import{readFile,writeFile}from'node:fs/promises';import assert from'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=metal']});const page=await browser.newPage({viewport:{width:390,height:844}});const report={errors:[],modes:[],videos:[],widths:[],references:[]};
page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400)report.errors.push(r.status()+' '+r.url())});
try{
 await page.goto('http://127.0.0.1:8795/design-review/index.html#run');const data=JSON.parse(await readFile('public/design-review/audit.json','utf8'));
 for(const g of data.games){
  await page.locator(`[data-id="${g.id}"]`).click();
  for(const mode of['play','moment','result','video','round','before','reference']){
   await page.locator(`[data-mode="${mode}"]`).click();await page.locator('#reference').evaluate(e=>e.decode());
   if(mode==='video'){
    await page.waitForFunction(id=>{const v=document.querySelector('#video');return v.readyState>=1&&v.currentSrc.endsWith('/'+id+'.mp4')},g.id);
    const v=await page.locator('#video').evaluate(e=>({src:e.currentSrc,w:e.videoWidth,h:e.videoHeight,duration:e.duration}));
    assert(v.w===390&&v.h===844&&v.duration>1,g.id+' portrait video metadata '+JSON.stringify(v));assert(await page.locator('#current').isHidden());report.videos.push({game:g.id,...v});
   }else{await page.locator('#current').evaluate(e=>e.decode());assert(await page.locator('#video').isHidden());}
   if(mode==='round')assert((await page.locator('#reference').getAttribute('src')).endsWith(g.id+'-previous.png'));
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));report.modes.push(g.id+':'+mode);
  }
  const ref=g.reference.split('/').at(-1);assert((await readFile('../output/design/pvp-arena-concepts-v1/'+ref)).equals(await readFile('public/design-review/'+g.reference)));report.references.push(g.id);
 }
 for(const width of[360,390,1280]){
  await page.setViewportSize({width,height:width===1280?1000:844});await page.locator('[data-id="run"]').click();await page.locator('[data-mode="round"]').click();
  await page.locator('#current').evaluate(e=>e.decode());await page.locator('#reference').evaluate(e=>e.decode());assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`review/visual-restoration/gallery-v4-${width}.png`,fullPage:true});report.widths.push(width);
 }
 const doc=await page.request.get('http://127.0.0.1:8795/specs/visual-restoration-v4.md');assert.equal(doc.status(),200);assert((await doc.text()).includes('本轮实现'));
 assert.deepEqual(report.errors,[]);report.status='PASS';await writeFile('review/visual-restoration/gallery-v4.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({status:report.status,modes:report.modes.length,videos:report.videos.length,widths:report.widths,errors:report.errors}));
}finally{await browser.close()}
