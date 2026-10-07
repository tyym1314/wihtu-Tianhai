/** Controlled long-run RunGame/WebGL probe. Browser emulation, not iPhone acceptance. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import * as engine from '../arena/run/engine.mjs';
import {reviewServer} from '../arena/run/review-harness.mjs';

const label=process.argv[2];
if(!/^[a-z0-9-]+$/.test(label||''))throw Error('Pass a simple baseline/after label');
const durationMs=62000,output=resolve('arena/run/qa/sustained-20261007');
const percentile=(values,p)=>{const a=[...values].sort((x,y)=>x-y);return a.length?a[Math.min(a.length-1,Math.floor(a.length*p))]:null;};
const stats=values=>({count:values.length,p50:percentile(values,.5),p95:percentile(values,.95),p99:percentile(values,.99),max:values.length?Math.max(...values):null});

const server=await reviewServer({fairStart:true});server.reset('00'.repeat(32));
let browser,context,page,autopilot,progressTimer;const legalActions=[],progress=[],errors=[];
try{
 browser=await chromium.launch({headless:true,channel:'chrome',args:['--use-angle=metal']});
 context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3});
 const cdp=await context.newCDPSession(await context.newPage());
 // Keep the same CPU/GPU conditions for both labels. This is a stress profile,
 // not a measurement of iPhone 15 Pro speed.
 await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 page=context.pages()[0];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.__runProbe={active:false,frames:[],longTasks:[],startedAt:null,endedAt:null};
  const probe=window.__runProbe;
  const loop=t=>{if(probe.active&&probe.frames.length<8000)probe.frames.push(t);requestAnimationFrame(loop);};requestAnimationFrame(loop);
  if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>{if(probe.active)for(const entry of list.getEntries())probe.longTasks.push({at:entry.startTime,ms:entry.duration});}).observe({type:'longtask'});
 });
 await page.goto(server.origin+'?locale=en',{waitUntil:'domcontentloaded'});
 await page.waitForSelector('[data-testid=run-track][data-rendered=true]',{timeout:30000});
 await page.waitForSelector('[data-testid=run-scene][data-input-ready=true]',{timeout:10000});
 assert.equal(server.state().phase,'racing');
 const startedAt=Date.now();
 await page.evaluate(()=>{window.__runReactCommits.length=0;window.__runProbe.active=true;window.__runProbe.startedAt=performance.now();});
 // Every action goes through the pinned authoritative engine. Ignore held-item
 // boosts so the 480 m course lasts more than 60 s; delay the first decision
 // long enough for one real beam hit, giving a reproducible >60 s race.
 autopilot=setInterval(()=>{const state=server.state(),now=Date.now();if(state.status!=='active'||state.phase!=='racing'||now-state.startedAt<5500)return;const action=engine.botAction(state,'p0',now);if(!action||action.type==='item')return;try{const result=engine.act(state,'p0',action,now);legalActions.push({at:now,type:action.type,event:result.event?.type});}catch(e){errors.push('autopilot '+(e.code||e.message));}},100);
 progressTimer=setInterval(()=>{const state=server.state(),me=state.players.find(p=>p.key==='p0');progress.push({at:Date.now(),phase:state.phase,tick:state.tick,distance:me.distanceU/300,netDistance:engine.netCentimeters(me)/100,hits:me.hits});},200);
 await page.waitForTimeout(durationMs);
 const raw=await page.evaluate(()=>{window.__runProbe.active=false;window.__runProbe.endedAt=performance.now();return{probe:window.__runProbe,commits:window.__runReactCommits,canvasReady:document.querySelector('[data-testid=run-track]')?.dataset.rendered,inputReady:document.querySelector('[data-testid=run-scene]')?.dataset.inputReady};});
 const elapsed=Date.now()-startedAt,state=server.state(),me=state.players.find(p=>p.key==='p0'),frames=raw.probe.frames,intervals=frames.slice(1).map((time,i)=>time-frames[i]),commits=raw.commits.filter(c=>c.commitTime>=raw.probe.startedAt&&c.commitTime<=raw.probe.endedAt),durations=commits.map(c=>c.actualDuration);
 const report={label,scope:'Isolated authoritative engine + real RunGame/WebGL + Chrome mobile emulation 390x844 DPR3, Apple Metal, CPU x4; no wallet, no public host or physical iPhone Safari claim',browser:'Chrome mobile emulation',duration_ms:elapsed,rule_version:state.ruleVersion,course_id:state.courseId,start_at:state.startedAt,phase:state.phase,final_distance_m:me.distanceU/300,final_net_distance_m:engine.netCentimeters(me)/100,hits:me.hits,legal_actions:legalActions.length,frames:stats(intervals),frames_over_50_ms_percent:intervals.length?100*intervals.filter(x=>x>50).length/intervals.length:null,frames_over_100_ms:intervals.filter(x=>x>100).length,long_tasks:stats(raw.probe.longTasks.map(x=>x.ms)),react_commits:stats(durations),react_commits_per_second:commits.length/(elapsed/1000),react_total_render_ms:durations.reduce((a,b)=>a+b,0),canvas_ready:raw.canvasReady,input_ready:raw.inputReady,errors};
 assert.ok(elapsed>=60000,'at least 60 s continuous real-time observation');
 assert.ok(me.distanceU/300>450,'engine must advance through the real course');
 assert.ok(progress.some(x=>x.netDistance<50)&&progress.some(x=>x.netDistance>450),'authority must show genuine forward progress');
 assert.ok(legalActions.length>10,'autopilot must use legal actions, not position fixtures');
 assert.deepEqual(errors,[]);
 await mkdir(output,{recursive:true});
 await writeFile(resolve(output,`${label}.json`),JSON.stringify(report,null,2));
 await writeFile(resolve(output,`${label}-raw.json`),JSON.stringify({frames,commits,longTasks:raw.probe.longTasks,legalActions,progress},null,2));
 console.log(JSON.stringify(report,null,2));
}finally{
 clearInterval(autopilot);clearInterval(progressTimer);
 await context?.close();await browser?.close();await server.close();
}
