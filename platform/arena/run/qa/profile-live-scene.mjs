/** Cold RunGame/WebGL profile under the real isolated authoritative engine. */
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import * as engine from '../engine.mjs';
import {reviewServer} from '../review-harness.mjs';

const label=process.argv[2],durationMs=Number(process.argv[3]||10000),routeIndex=Number(process.argv[4]||0),autopilotDelayMs=Number(process.env.RUN_PROFILE_AUTOPILOT_DELAY||5500),networkProfile=process.env.RUN_PROFILE_NETWORK||'local',bundleMinify=process.env.RUN_PROFILE_MINIFY==='1';
if(!/^[a-z0-9-]+$/.test(label||'')||!Number.isFinite(durationMs)||durationMs<6000||!Number.isInteger(routeIndex)||routeIndex<0||routeIndex>5)throw Error('Usage: profile-live-scene.mjs label duration-ms [route-index 0..5]');
const output=resolve('arena/run/qa/sustained-20261007');
const server=await reviewServer({fairStart:true,sceneProbe:true,bundleMinify});server.reset(routeIndex.toString(16).padStart(8,'0')+'00'.repeat(28));
let browser,context,autopilot;
const errors=[],legalActions=[];
try{
 browser=await chromium.launch({headless:true,channel:'chrome',args:['--use-angle=metal']});
 context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3});
 const page=await context.newPage(),cdp=await context.newCDPSession(page);
 await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 if(networkProfile==='wifi'){
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:50,downloadThroughput:20_000_000/8,uploadThroughput:5_000_000/8,connectionType:'wifi'});
 }else if(networkProfile!=='local')throw Error('Unsupported network profile');
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  window.__runProbe={active:false,frames:[],longTasks:[],loaf:[]};
  const probe=window.__runProbe;
  probe.glCalls=[];
  for(const name of ['bufferData','bufferSubData','texImage2D','texSubImage2D','compressedTexImage2D','drawElements','drawElementsInstanced','drawArrays','drawArraysInstanced','linkProgram','compileShader','getProgramParameter','getShaderParameter']){
   const original=WebGL2RenderingContext.prototype[name];if(typeof original!=='function')continue;
   WebGL2RenderingContext.prototype[name]=function(...args){const at=performance.now();try{return original.apply(this,args);}finally{const ms=performance.now()-at;if(ms>2&&probe.glCalls.length<1000)probe.glCalls.push({at,name,ms,argumentBytes:args.find(arg=>ArrayBuffer.isView(arg))?.byteLength??null,imageWidth:args.at(-1)?.width??null,imageHeight:args.at(-1)?.height??null});}};
  }
  const frame=t=>{if(probe.active&&probe.frames.length<8000)probe.frames.push(t);requestAnimationFrame(frame);};requestAnimationFrame(frame);
  if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>{if(probe.active)probe.longTasks.push(...list.getEntries().map(e=>({at:e.startTime,ms:e.duration})));}).observe({type:'longtask'});
  if(PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'))new PerformanceObserver(list=>{if(probe.active)probe.loaf.push(...list.getEntries().filter(e=>e.duration>45).map(e=>({at:e.startTime,ms:e.duration,scripts:e.scripts.map(s=>({name:s.sourceFunctionName,ms:s.duration,invoker:s.invokerType}))})));}).observe({type:'long-animation-frame'});
 });
 await page.goto(server.origin+'?locale=en',{waitUntil:'domcontentloaded'});
 await page.waitForSelector('[data-testid=run-track][data-rendered=true]',{timeout:30000});
 const sceneRenderedAt=await page.evaluate(()=>performance.now());
 await page.waitForSelector('[data-testid=run-scene][data-input-ready=true]',{timeout:10000});
 const firstInputReadyAt=await page.evaluate(()=>performance.now());
 const start=Date.now();
 await page.evaluate(()=>{window.__runProbe.active=true;window.__runProbe.startedAt=performance.now();});
 autopilot=setInterval(()=>{const state=server.state(),now=Date.now();if(state.status!=='active'||state.phase!=='racing'||now-state.startedAt<autopilotDelayMs)return;const action=engine.botAction(state,'p0',now);if(!action||action.type==='item')return;try{const result=engine.act(state,'p0',action,now);legalActions.push({at:now,type:action.type,event:result.event?.type});}catch(error){errors.push('autopilot '+(error.code||error.message));}},100);
 await page.waitForTimeout(durationMs);
 const raw=await page.evaluate(()=>{window.__runProbe.active=false;return{probe:window.__runProbe,sceneSamples:window.__runSceneSamples||[],sceneCompiles:window.__runSceneCompiles||[],sceneEvents:window.__runSceneEvents||[],readyTimeline:window.__readyTimeline||[],resources:performance.getEntriesByType('resource').map(e=>({name:new URL(e.name).pathname,startTime:e.startTime,responseEnd:e.responseEnd,duration:e.duration,transferSize:e.transferSize,decodedBodySize:e.decodedBodySize})),commits:window.__runReactCommits||[],inputReady:document.querySelector('[data-testid=run-scene]')?.dataset.inputReady};});
 const state=server.state(),me=state.players.find(p=>p.key==='p0');
 const frames=raw.probe.frames,frameGaps=frames.slice(1).map((t,i)=>({at:t,ms:t-frames[i]}));
 const ranked=[...raw.sceneSamples].sort((a,b)=>b.frameMs-a.frameMs).slice(0,15);
 const memory=raw.sceneSamples.map(s=>({textures:s.gpuTextures,geometries:s.gpuGeometries}));
 const report={label,scope:'Isolated RunGame + authoritative engine; Chrome mobile emulation 390x844 DPR3, Metal, CPU4. Not iPhone Safari or public-host acceptance.',network_profile:networkProfile==='wifi'?'CDP 20Mbps down / 5Mbps up / 50ms RTT':'loopback unthrottled',bundle_minified:bundleMinify,duration_ms:Date.now()-start,course_id:state.courseId,phase:state.phase,distance_m:me.distanceU/300,hits:me.hits,actions:legalActions.length,scene_rendered_at_ms:sceneRenderedAt,first_input_ready_at_ms:firstInputReadyAt,input_ready:raw.inputReady,gpu_memory:{first:memory[0],last:memory.at(-1),peakTextures:Math.max(...memory.map(m=>m.textures)),peakGeometries:Math.max(...memory.map(m=>m.geometries))},slowest_resources:[...raw.resources].sort((a,b)=>b.responseEnd-a.responseEnd).slice(0,12),frame_gaps_over_50:frameGaps.filter(x=>x.ms>50),long_tasks:raw.probe.longTasks,loaf:raw.probe.loaf,scene_compiles:raw.sceneCompiles,scene_events:raw.sceneEvents,slowest_scene_frames:ranked,errors};
 await mkdir(output,{recursive:true});
 await writeFile(resolve(output,`${label}-profile.json`),JSON.stringify(report,null,2));
 await writeFile(resolve(output,`${label}-profile-raw.json`),JSON.stringify({...raw,legalActions},null,2));
 console.log(JSON.stringify(report,null,2));
}finally{clearInterval(autopilot);await context?.close();await browser?.close();await server.close();}
