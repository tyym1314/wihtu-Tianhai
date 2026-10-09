/** Isolated real-core snapshots + actual RunGame/WebGL. No public/device claim. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
import {createRunPracticeController} from '../arena/run/practice-controller.mjs';
import {RUN_PRACTICE_PROFILES as P} from '../shared/run-practice-profiles.mjs';
import {ROOM,SELF,start,advance,apply,publicRoom,knownFall} from './run-practice-client-v2-fixture.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),out=resolve(root,'review/run-practice-client-v2',process.env.RUN_V2_QA_LABEL||('local-'+Date.now()));
await mkdir(out,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
const sources=['arena/main.jsx','arena/run/start-policy.mjs','arena/run/practice-profile-contract.mjs','arena/run/practice-controller.mjs','arena/run/practice-input-outbox.mjs','arena/run/practice-own-events.mjs','arena/run/practice-presentation-events.mjs','arena/run/practice-fall-help.mjs','arena/run/useRunPractice.jsx','arena/run/RunGame.jsx','arena/run/scene.mjs','arena/run/engine.mjs','arena/run/runner-physics.mjs','shared/run-practice-profiles.mjs','server/pvp/run-practice-inputs.mjs'];
const fingerprints=async()=>Object.fromEntries(await Promise.all(sources.map(async name=>[name,hash(await readFile(resolve(root,name)))])));
const report={scope:'Loopback real core + actual RunGame/Three/WebGL/assets. Chrome desktop mobile emulation390x844 DPR3 CPU4 and desktop WebKit. Not physical Android/iPhone or public acceptance.',sourceBefore:await fingerprints(),checks:[],browsers:[],errors:[],baseline:'Same current tuple validation/physics/outbox; counterfactual full v2 trajectory rebuild and original per-frame array cloning/deep freeze. Ignored source and exact transformations retained.'};
const controllerPath=resolve(root,'arena/run/practice-controller.mjs'),source=await readFile(controllerPath,'utf8');
const transformations=[
 ["if(profile.profileId!==null&&trajectory&&offset>=0", "if(false&&profile.profileId!==null&&trajectory&&offset>=0"],
 ["function freeze(o){if(o&&typeof o==='object'&&!Object.isFrozen(o))", "function freeze(o){if(o&&typeof o==='object')"],
 ["const visualPlayer=freeze({...snapshot,", "const visualPlayer=freeze({...own(p),"],
 ["if(profile.profileId!==null&&result.newlyAcknowledged.length===0)", "if(false&&profile.profileId!==null&&result.newlyAcknowledged.length===0)"],
];
let baseline=source;for(const [from,to] of transformations){assert.ok(baseline.includes(from));baseline=baseline.replace(from,to);}
const begin=baseline.indexOf('function snapshotter(){'),end=baseline.indexOf('\nfunction replay(',begin);assert.ok(begin>=0&&end>begin);
baseline=baseline.slice(0,begin)+"function snapshotter(){return(p,tick)=>freeze({tick,...own(p)});}"+baseline.slice(end);
await writeFile(resolve(out,'baseline-controller.mjs'),baseline);await writeFile(resolve(out,'baseline-transformations.json'),JSON.stringify({production_source_sha256:hash(source),baseline_sha256:hash(baseline),transformations,snapshotter:'original deep-owned clone per state record; original independent own clone per visual frame'},null,2));
function makeController(profile){return createRunPracticeController({roomId:ROOM,playerKey:SELF,clockEpoch:1,profile,makeRequestId:()=> 'qa_request'});}
function benchmarkDense(){
 let e=start();const m=makeController(P.v2),ops=[{kind:'receive',room:publicRoom(e),at:0}];assert.equal(m.receive({room:ops[0].room,receivedAt:0}).ok,true);
 for(let tick=0;tick<=360;tick+=6){const at=tick*1000/60;
  if(tick){e=advance(e,tick);const r=publicRoom(e);ops.push({kind:'receive',room:r,at});assert.equal(m.receive({room:r,receivedAt:at}).ok,true);}
  m.sample(at);ops.push({kind:'sample',at});
  for(const type of ['right','left','jump','slide','item']){
   const input=m.enqueue(type,at);ops.push({kind:'enqueue',type,at,ok:input.ok,reason:input.reason});if(!input.ok)continue;
   const h=m.transport.beginBatch(at),r=apply(e,h);e=r.envelope;
   const receipt={request_id:h.requestId,run_inputs:publicRoom(e,r).run_inputs};ops.push({kind:'ack',receipt,at,payload:h.payload});assert.equal(m.transport.resolve({token:h.token,receipt,now:at}).ok,true);break;
  }
 }
 return ops;
}
function benchmarkWorst(){
 let e=start(),m=makeController(P.v2);const first=publicRoom(e),ops=[{kind:'receive',room:first,at:0},{kind:'enqueue',type:'right',at:0,ok:true}];m.receive({room:first,receivedAt:0});m.enqueue('right',0);const h=m.transport.beginBatch(0),r=apply(e,h);e=advance(r.envelope,360);
 ops.push({kind:'receive',room:publicRoom(e),at:1000},{kind:'ack',receipt:{request_id:h.requestId,run_inputs:publicRoom(r.envelope,r).run_inputs},at:1000,payload:h.payload});return ops;
}
const dense=benchmarkDense(),worst=benchmarkWorst(),first=start(),fall=advance(knownFall(),3271),snapshotCases={gap:[publicRoom(first),publicRoom(advance(first,186))],hold:[publicRoom(first)],fall:[publicRoom(fall)]};
let server,browser,context;
try{
 const contents=`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import RunGame from './arena/run/RunGame.jsx';
 import{createRunPracticeController as optimized}from'./arena/run/practice-controller.mjs';import{createRunPracticeController as baseline}from'run-practice-controller-baseline';import{RUN_PRACTICE_PROFILES as P}from'./shared/run-practice-profiles.mjs';
 const root=createRoot(document.getElementById('root'));let epoch=0;window.qaSamples=[];window.qaEvents=[];window.qaReceives=[];
 const assert=(value,message)=>{if(!value)throw Error(message);};
 window.qaBenchmark=(ops,implementation)=>{const create=implementation==='baseline'?baseline:optimized,m=create({roomId:'${ROOM}',playerKey:'${SELF}',clockEpoch:1,profile:P.v2,makeRequestId:()=> 'qa_request'}),durations={receive:[],enqueue:[],ack:[],sample:[]},samples=[];let handle;
  for(const op of ops){const start=performance.now();let r;if(op.kind==='receive'){r=m.receive({room:op.room,receivedAt:op.at});assert(r.ok,implementation+' receive '+JSON.stringify(r));}else if(op.kind==='enqueue'){r=m.enqueue(op.type,op.at);assert(r.ok===op.ok,implementation+' enqueue '+JSON.stringify(r));if(r.ok)handle=m.transport.beginBatch(op.at);}else if(op.kind==='ack'){assert(JSON.stringify(handle.payload)===JSON.stringify(op.payload),'immutable payload mismatch');r=m.transport.resolve({token:handle.token,receipt:op.receipt,now:op.at});assert(r.ok,'ACK '+JSON.stringify(r));}else{r=m.sample(op.at);samples.push([r.provisionalTick,r.pose.distance,r.pose.x,r.pose.y,r.pose.visualPlayer.fallUntilTick]);}durations[op.kind].push(performance.now()-start);}
  return{durations,samples,state:m.state()};};
 function App({initial}){const[room,setRoom]=useState(initial);window.qaSetRoom=setRoom;return <RunGame room={room} me="${SELF}" locale="en" onBack={()=>{}} audio={{play(){}}} inputOwner="qa-owner" inputAuthorization="qa-cookie-owner" onAction={()=>{throw Error('legacy action forbidden')}} onRunInputBatch={async handle=>{throw Error('test scenario has no gameplay input')}} onRunInputRoom={setRoom}/>;}
 window.qaMount=async name=>{window.qaSamples=[];window.qaEvents=[];window.qaReceives=[];const response=await fetch('/snapshot?scenario='+name+'&index=0'),room=await response.json();root.render(<App key={++epoch} initial={room}/>);};
 window.qaPublish=async(name,index)=>window.qaSetRoom(await(await fetch('/snapshot?scenario='+name+'&index='+index)).json());
 window.qaReady=true;`;
 const bundle=await build({stdin:{contents,resolveDir:root,loader:'jsx'},bundle:true,format:'esm',write:false,outdir:resolve(root,'.local/run-client-v2-ui'),assetNames:'assets/[name]-[hash]',loader:{'.glb':'file','.webp':'file','.png':'file'},minify:true,plugins:[{name:'baseline-and-numeric-controller-observer',setup(b){
  b.onResolve({filter:/^run-practice-controller-baseline$/},()=>({path:'baseline',namespace:'qa-baseline'}));
  b.onLoad({filter:/.*/,namespace:'qa-baseline'},()=>({contents:baseline,loader:'js',resolveDir:dirname(controllerPath)}));
  b.onLoad({filter:/\/practice-controller\.mjs$/},async a=>{const original=await readFile(a.path,'utf8');return{contents:original.replace('export function createRunPracticeController(', 'function createRunPracticeControllerImpl(')+`\nexport function createRunPracticeController(...args){const inner=createRunPracticeControllerImpl(...args);return{...inner,receive(...values){const start=performance.now(),r=inner.receive(...values);if(window.qaReceives?.length<2000)window.qaReceives.push({at:performance.now(),ms:performance.now()-start,ok:r.ok,steps:r.steps});return r;},sample(at){const s=inner.sample(at);if(window.qaSamples?.length<4000&&s?.pose)window.qaSamples.push({at,mode:s.mode,reason:s.reason,head:s.headTick,raw:s.provisionalTick,tick:s.pose.tick,distance:s.pose.distance,x:s.pose.x,y:s.pose.y,fall:s.pose.visualPlayer.fallUntilTick,checkpoint:s.pose.checkpoint,boundary:s.pose.causalBoundary});return s;}};}`,loader:'js',resolveDir:dirname(a.path)};});
 }}]});
 const assets=new Map(bundle.outputFiles.map(f=>['/'+(f.path.endsWith('.js')?'app.js':f.path.endsWith('.css')?'app.css':'assets/'+basename(f.path)),f.contents]));
 server=createServer((req,res)=>{try{const u=new URL(req.url,'http://127.0.0.1'),body=assets.get(u.pathname);if(body){res.setHeader('content-type',u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.css')?'text/css':u.pathname.endsWith('.glb')?'model/gltf-binary':'image/webp');res.end(body);return;}if(u.pathname==='/snapshot'){const room=snapshotCases[u.searchParams.get('scenario')]?.[Number(u.searchParams.get('index'))];assert.ok(room);res.setHeader('content-type','application/json');res.end(JSON.stringify(room));return;}if(u.pathname==='/favicon.ico'){res.statusCode=204;res.end();return;}res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>html,body{margin:0;background:#102d37}#root{max-width:430px;margin:auto}</style><div id="root"></div><script type="module" src="/app.js"></script>');}catch(error){res.statusCode=500;res.end(error.message);}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 for(const kind of (process.env.RUN_V2_QA_BROWSER?[process.env.RUN_V2_QA_BROWSER]:['chromium','webkit'])){
  assert.ok(['chromium','webkit'].includes(kind));const errors=[],checks=[];browser=await(kind==='chromium'?chromium:webkit).launch({headless:true,...(kind==='chromium'?{channel:'chrome',args:['--use-angle=metal']}:{})});context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>sessionStorage.setItem('oasis:run:frame-trace:v1','1'));
  if(kind==='chromium'){const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});}
  await page.goto(origin,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.qaReady);
  const performanceResults=[];
  for(const [name,ops]of [['dense-four-six-seconds',dense],['full-revision-rebuild',worst]]){
   const runs=[];for(const implementation of ['baseline','optimized','optimized','baseline'])runs.push({implementation,...await page.evaluate(({ops,implementation})=>window.qaBenchmark(ops,implementation),{ops,implementation})});
   assert.deepEqual(runs[0].samples,runs[1].samples,'baseline/optimized canonical samples');assert.deepEqual(runs[2].samples,runs[3].samples,'paired order-independent canonical samples');
   performanceResults.push({name,runs});checks.push(name+'-identical-physics');
  }
  await writeFile(resolve(out,kind+'-performance.json'),JSON.stringify(performanceResults,null,2));
  await page.evaluate(()=>window.qaMount('gap'));await page.waitForSelector('[data-testid=run-track][data-ready=true]',{timeout:45000});
  // Warm asset/renderer compilation first, then reset with identical real room.
  await page.evaluate(()=>window.qaMount('gap'));await page.waitForSelector('[data-testid=run-track][data-ready=true]',{timeout:20000});await page.waitForTimeout(3100);
  const gap=await page.evaluate(()=>({samples:window.qaSamples,trace:document.querySelector('[data-testid=run-track]').__oasisRunFrameTrace.read(),receives:window.qaReceives}));
  assert.ok(gap.samples.length>=60);assert.ok(gap.samples.some(s=>s.raw>=170));assert.ok(gap.samples.every(s=>s.mode==='provisional'),'no budget hold during three-second gap');assert.ok(gap.samples.at(-1).distance>gap.samples[0].distance+20);
  await page.evaluate(()=>window.qaPublish('gap',1));await page.waitForTimeout(250);const restored=await page.evaluate(()=>window.qaSamples.at(-1));assert.equal(restored.head,186);assert.equal(restored.mode,'provisional');checks.push('three-second-gap-real-motion');
  await page.screenshot({path:resolve(out,kind+'-gap.png')});await writeFile(resolve(out,kind+'-gap.json'),JSON.stringify(gap,null,2));
  await page.evaluate(()=>window.qaMount('hold'));await page.waitForSelector('[data-testid=run-track][data-ready=true]',{timeout:20000});await page.waitForTimeout(6250);
  const hold=await page.evaluate(()=>({samples:window.qaSamples,trace:document.querySelector('[data-testid=run-track]').__oasisRunFrameTrace.read()}));const stopped=hold.samples.filter(s=>s.mode==='hold');assert.ok(stopped.length>=3);assert.ok(stopped.every(s=>s.reason==='provisional-budget-expired'&&s.raw===360));assert.ok(stopped.every(s=>s.distance===stopped[0].distance));checks.push('six-second-honest-stop');await writeFile(resolve(out,kind+'-hold.json'),JSON.stringify(hold,null,2));
  await page.evaluate(()=>window.qaMount('fall'));await page.waitForSelector('[data-testid=run-track][data-ready=true]',{timeout:20000});await page.waitForTimeout(2250);await page.screenshot({path:resolve(out,kind+'-fall.png')});await page.waitForTimeout(1800);await page.screenshot({path:resolve(out,kind+'-respawn.png')});
  const fallVisual=await page.evaluate(()=>({samples:window.qaSamples,trace:document.querySelector('[data-testid=run-track]').__oasisRunFrameTrace.read()}));const fallen=fallVisual.samples.filter(s=>s.fall===3486),respawned=fallVisual.samples.filter(s=>s.tick>=3486&&s.fall===null);
  assert.ok(fallen.length>=10&&fallen.every(s=>s.distance===288));assert.ok(fallen.some(s=>s.y<-.3));assert.ok(respawned.length>=3&&respawned[0].distance<fallen[0].distance-15);assert.ok(respawned.every(s=>s.checkpoint===270));checks.push('natural-3396-fall-3486-checkpoint-respawn');await writeFile(resolve(out,kind+'-fall-visual.json'),JSON.stringify(fallVisual,null,2));
  assert.deepEqual(errors,[]);report.browsers.push({kind,cpuThrottle:kind==='chromium'?4:null,checks,errors,scene:true});await context.close();context=null;await browser.close();browser=null;
 }
 report.sourceAfter=await fingerprints();report.sourceUnchanged=JSON.stringify(report.sourceBefore)===JSON.stringify(report.sourceAfter);assert.equal(report.sourceUnchanged,true,'production source changed during measured runs');report.passed=true;
}catch(error){report.passed=false;report.failure={message:error.message,stack:error.stack};throw error;}
finally{await context?.close();await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,output:out,browsers:report.browsers,failure:report.failure?.message}));}
