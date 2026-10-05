import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const label=process.argv[2]||'b',folder=new URL('../assets/review/venue-v3/',import.meta.url).pathname;
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=metal']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>assert(!/\/(api|v1)\//.test(r.url())));
 await page.goto('http://127.0.0.1:18112/arena/golf/art-review.html?game=bowling&players=2&lang=en');
 await page.waitForFunction(()=>document.querySelector('[data-art-quality="blender"]'));await page.waitForTimeout(1400);
 await page.screenshot({path:folder+`glow-${label}-390.png`});
 const stats=await page.evaluate(async()=>{const samples=[];let last;await new Promise(resolve=>{const f=t=>{if(last!==undefined)samples.push(t-last);last=t;if(samples.length<180)requestAnimationFrame(f);else resolve();};requestAnimationFrame(f);});samples.sort((a,b)=>a-b);const e=document.querySelector('[data-art-quality]'),gl=document.querySelector('[data-testid=bowling-canvas]').getContext('webgl2'),ex=gl.getExtension('WEBGL_debug_renderer_info');return{medianFrameMs:samples[90],p95FrameMs:samples[171],drawCalls:+e.dataset.renderCalls,triangles:+e.dataset.triangles,gpu:ex?gl.getParameter(ex.UNMASKED_RENDERER_WEBGL):'unavailable'};});assert(stats.gpu.includes('Metal'));assert.deepEqual(errors,[]);await writeFile(folder+`glow-${label}-report.json`,JSON.stringify({label,scope:'same 390x844 scene, desktop Chrome Metal; 180 RAF samples, not physical-phone performance',...stats,errors},null,2));console.log(stats);
}finally{await browser.close();}
