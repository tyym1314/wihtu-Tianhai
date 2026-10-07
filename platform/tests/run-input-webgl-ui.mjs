/** Local real HTTP + RunGame + WebGL/assets. Not device, public-host or FPS acceptance. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import * as engine from '../arena/run/engine.mjs';
import {makeRunActionReceipt} from '../shared/run-action-receipt.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const out=resolve(root,'review/deployment',`run-input-webgl-${Date.now()}-${Math.random().toString(16).slice(2,8)}`);
await mkdir(out,{recursive:true});console.log(JSON.stringify({report_directory:out}));
const sourceFiles=['arena/run/RunGame.jsx','arena/run/scene.mjs','arena/run/input-presentation.mjs','arena/run/presentation.mjs','arena/run/atlas-characters.mjs','arena/run/characters.mjs','arena/run/engine.mjs','shared/run-action-receipt.mjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await readFile(resolve(root,file))).digest('hex')])));
const report={scope:'Local Chrome with actual RunGame, scene, GLB/WebP assets and WebGL renderer. Isolated real HTTP wrapper and pinned engine; controlled ACK/publication delays, not Arena backend, device, public-host, FPS or full-round acceptance.',harness_sha256:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),cases:[],errors:[],source_hashes:await hashes(),passed:false};
const source=`
import React,{useEffect,useRef,useState} from 'react';import{createRoot}from'react-dom/client';
import RunGame from './arena/run/RunGame.jsx';import{startRoomPolling}from'./arena/shared/room-poller.mjs';
import{readRunActionReceipt}from'./shared/run-action-receipt.mjs';
window.inputWebgl={requests:[],frames:[],droppedFrames:0,audio:[],returned:false};
const freeze=x=>{if(x&&typeof x==='object'){for(const v of Object.values(x))freeze(v);Object.freeze(x)}return x};
function App(){const[room,setRoom]=useState(null),[requestState,setRequestState]=useState('idle'),[shown,setShown]=useState(true),roomRef=useRef(null),inFlight=useRef(false);
 window.inputWebgl.dispose=()=>setShown(false);
 const accept=raw=>{const old=roomRef.current;if(old?.id===raw.id&&old.version>raw.version)return old;const next=freeze(raw);roomRef.current=next;setRoom(next);return next;};
 useEffect(()=>startRoomPolling({initialDelay:0,interval:()=>150,read:async signal=>{const r=await fetch('/room',{signal});if(!r.ok)throw Error('Room read failed');return r.json()},onRoom:accept,onError:e=>window.inputWebgl.pollError=String(e)}),[]);
 async function onAction(action,{onDispatch}={}){if(inFlight.current)throw Error('Previous request is pending');const r=roomRef.current,request_id=crypto.randomUUID().replaceAll('-',''),seq=r.me_last_seq+1;
  const dispatch={roomId:r.id,playerKey:r.me,request_id,seq,type:action.type,ruleVersion:r.game.ruleVersion};
  const row={...dispatch,dispatch_at:performance.now()};window.inputWebgl.requests.push(row);inFlight.current=true;setRequestState('sending');
  try{onDispatch?.(dispatch);const response=await fetch('/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request_id,seq,action})});const raw=await response.json();row.ack_at=performance.now();row.status=response.status;row.raw_receipt=raw.action_receipt??null;
   if(!response.ok)throw Object.assign(Error(raw.message||'Action rejected'),{code:raw.code,status:response.status});
   const inputReceipt=readRunActionReceipt(raw,dispatch);row.valid_receipt=inputReceipt;return{room:accept(raw),inputReceipt};
  }catch(error){row.error={message:error.message,code:error.code||null};throw error}finally{inFlight.current=false;setRequestState('idle')}
 }
 return shown&&room?<RunGame room={room} me="p0" locale="en" requestState={requestState} audio={{enabled:false,play:kind=>window.inputWebgl.audio.push(kind)}} onExit={()=>{window.inputWebgl.returned=true}} onAction={onAction} onSceneReady={async()=>{const r=await fetch('/scene-ready',{method:'POST'});return accept(await r.json())}}/>:null;
}createRoot(document.getElementById('root')).render(<App/>);
`;
function instrumentScene(content){
 const needle='onFrame(time);if(mine&&!readyAnnounced)';assert.equal(content.split(needle).length,2,'scene post-render observation anchor must be unique');
 return content.replace(needle,`onFrame(time);if(mine&&window.inputWebgl){const observedRoot=runners.get(me)?.root,observedAuthority=projectedPose(mine,game,time-received),probe=window.inputWebgl;
  if(probe.frames.length<6000)probe.frames.push({at:performance.now(),raf_at:time,snapshot_tick:game.snapshotTick,input_no:mine.inputNo,applied_input_no:mine.appliedInputNo,actual:{x:observedRoot.position.x,y:observedRoot.position.y,z:observedRoot.position.z,clip:observedRoot.userData.clip},authority:observedAuthority,camera_distance:cameraDistance,camera_z:camera.position.z,feedback_at:container.dataset.inputFeedbackAt||null,feedback_type:container.dataset.inputFeedbackType||null,feedback_state:container.dataset.inputFeedbackState||null,calls:renderer.info.render.calls,textures:renderer.info.memory.textures});else probe.droppedFrames++;
 }if(mine&&!readyAnnounced)`);
}
let server,browser,timer,publicationTimer,context;
const httpEvents=[];let scenario,state,version=0,sequence=0,heldUntil=0;
const players=[{key:'p0',name:'Local human',seatIndex:0,isBot:false},{key:'p1',name:'Declared BOT',seatIndex:1,isBot:true}];
const snap=()=>({id:'webgl-run-room',game_id:'run',me:'p0',me_last_seq:sequence,version,status:state.status==='active'?'active':'settled',practice:true,capacity:2,entry_minor:'0',prize_minor:'0',server_now:Date.now(),starts_at:state.phase==='arming'?null:state.startedAt,players:players.map(p=>({external_user_id:p.key,name:p.name,bot:p.isBot,seat_index:p.seatIndex})),start_protocol:{kind:engine.RUN_SCENE_READY_POLICY,phase:state.phase,ready_count:state.phase==='arming'?0:1,human_count:1,ready_deadline_at:state.armingDeadlineAt,starts_at:state.phase==='arming'?null:state.startedAt},game:engine.view(state,'p0')});
function advance(){if(!state||state.phase==='arming'||Date.now()<heldUntil)return;engine.tick(state,Date.now());version++;}
function reset(next){clearTimeout(publicationTimer);scenario=next;state=engine.createState('02'.repeat(32),Date.now(),{players,ruleVersion:engine.PRACTICE_RULE_VERSION,startPolicy:engine.RUN_SCENE_READY_POLICY});sequence=0;version++;heldUntil=0;}
try{
 const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:'run-input-webgl-entry.jsx',loader:'jsx'},bundle:true,write:false,outdir:'/virtual-run-input-webgl',jsx:'automatic',format:'esm',logLevel:'silent',loader:{'.glb':'file','.webp':'file'},plugins:[{name:'real-assets-readonly-observation',setup(b){
  b.onResolve({filter:/\.(glb|webp)\?url$/},a=>({path:resolve(a.resolveDir,a.path.slice(0,-4))}));
  b.onLoad({filter:/\/run\/scene\.mjs$/},async a=>({contents:instrumentScene(await readFile(a.path,'utf8')),loader:'js',resolveDir:dirname(a.path)}));
 }}]});
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).contents,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).contents;
 const assets=new Map(bundle.outputFiles.filter(f=>/\.(glb|webp)$/.test(f.path)).map(f=>['/'+basename(f.path),f.contents]));
 report.assets=[...assets].map(([path,body])=>({path,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')}));
 server=createServer(async(req,res)=>{try{
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  if(assets.has(path)){res.setHeader('content-type',path.endsWith('.glb')?'model/gltf-binary':'image/webp');res.end(assets.get(path));return;}
  if(path==='/app.js'){res.setHeader('content-type','text/javascript');res.end(js);return;}
  if(path==='/app.css'){res.setHeader('content-type','text/css');res.end(css);return;}
  if(path==='/favicon.ico'){res.statusCode=204;res.end();return;}
  if(path==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><link rel="stylesheet" href="/app.css"><style>html,body{margin:0;background:#102d37}#root{max-width:460px;margin:auto}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script>');return;}
  res.setHeader('content-type','application/json');
  if(path==='/room'){res.end(JSON.stringify(snap()));return;}
  if(path==='/scene-ready'){if(state.phase==='arming'){engine.armStart(state,Date.now());version++;}res.end(JSON.stringify(snap()));return;}
  if(path==='/action'){
   let body='';for await(const chunk of req)body+=chunk;const payload=JSON.parse(body),received=Date.now(),caseName=scenario.name;
   const entry={case:caseName,received_at:received,payload,ack_delay_ms:scenario.ack,publish_delay_ms:scenario.publish,rejected:!!scenario.reject};httpEvents.push(entry);
   assert.equal(payload.seq,sequence+1);let response;
   if(scenario.reject)response={code:'BUSY',message:'Controlled fixture rejection: engine action not applied'};
   else{
    const result=engine.act(state,'p0',payload.action,received);sequence++;version++;
    const expected={roomId:'webgl-run-room',playerKey:'p0',request_id:payload.request_id,seq:payload.seq,type:payload.action.type,ruleVersion:state.ruleVersion};
    response={...snap(),action_receipt:makeRunActionReceipt({...expected,event:result.event})};entry.receipt=response.action_receipt;
    heldUntil=received+scenario.publish;
    publicationTimer=setTimeout(()=>{advance();entry.published_at=Date.now();entry.published_input_no=state.players[0].appliedInputNo;},scenario.publish);
   }
   const frozenResponse=JSON.stringify(response);await new Promise(resolve=>setTimeout(resolve,scenario.ack));entry.response_at=Date.now();res.statusCode=scenario.reject?409:200;res.end(frozenResponse);return;
  }
  res.statusCode=404;res.end(JSON.stringify({code:'NOT_FOUND'}));
 }catch(error){httpEvents.push({server_error:String(error.stack||error)});res.statusCode=500;res.end(JSON.stringify({code:'FIXTURE_ERROR',message:error.message}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));timer=setInterval(advance,250);
 const origin=`http://127.0.0.1:${server.address().port}`;report.origin=origin;
 browser=await chromium.launch({headless:true,channel:'chrome',args:['--use-angle=metal']});report.browser=browser.version();
 const cases=[{name:'jump-ack300-publish450',type:'jump',ack:300,publish:450},{name:'left-ack450-publish200',type:'left',ack:450,publish:200},{name:'jump-ack450-publish450',type:'jump',ack:450,publish:450},{name:'left-ack300-publish200',type:'left',ack:300,publish:200},{name:'left-rejected-ack450',type:'left',ack:450,publish:0,reject:true}];
 for(const current of cases){
  reset(current);const row={...current,errors:[],resources:[],passed:false};report.cases.push(row);
  context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){row.errors.push({kind:'nonlocal-request',url:route.request().url()});return route.abort();}return route.continue();});
  const page=await context.newPage();let closing=false;
  page.on('pageerror',error=>row.errors.push({kind:'javascript',message:error.message}));
  page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('409 (Conflict)'))row.errors.push({kind:'console',message:message.text()});});
  page.on('requestfailed',request=>{if(!closing)row.errors.push({kind:'network',path:new URL(request.url()).pathname,error:request.failure()?.errorText});});
  page.on('response',response=>{const path=new URL(response.url()).pathname;if(assets.has(path))row.resources.push({path,status:response.status()});if(response.status()>=400&&!(current.reject&&path==='/action'&&response.status()===409))row.errors.push({kind:'http',path,status:response.status()});});
  await page.goto(origin,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('[data-testid=run-jump]')?.disabled===false,{},{timeout:30000});
  row.gpu=await page.evaluate(()=>{const canvas=document.querySelector('[data-testid=run-track] canvas'),gl=canvas.getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return{renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),canvas:{width:canvas.width,height:canvas.height},loadedModels:document.querySelector('[data-testid=run-track]').dataset.modelsReady};});
  await page.evaluate(()=>{window.inputWebgl.frames=[];window.inputWebgl.requests=[];});
  await page.getByTestId(`run-${current.type}`).tap();
  await page.waitForFunction(type=>window.inputWebgl.frames.some(f=>f.feedback_state==='predicted'&&(type==='jump'?f.actual.y>0&&f.actual.clip==='jump':f.actual.x<-.001)&&f.applied_input_no===0),current.type,{timeout:1500});
  await page.screenshot({path:resolve(out,`${current.name}-immediate.png`)});
  await page.waitForFunction(()=>window.inputWebgl.requests[0]?.ack_at!==undefined,{},{timeout:4000});
  if(!current.reject)await page.waitForFunction(()=>window.inputWebgl.frames.some(f=>f.applied_input_no===1),{},{timeout:4000});
  await page.waitForTimeout(180);
  row.observation=await page.evaluate(()=>{const {dispose,...observation}=window.inputWebgl;return structuredClone(observation);});
  const request=row.observation.requests[0],frames=row.observation.frames,first=frames.find(f=>f.at>=request.dispatch_at&&f.feedback_state==='predicted'&&(current.type==='jump'?f.actual.y>0&&f.actual.clip==='jump':f.actual.x<-.001)&&f.applied_input_no===0),applied=frames.find(f=>f.applied_input_no===1);
  assert.equal(row.observation.requests.length,1);assert.ok(first,'real renderer must draw the predicted character before authority');assert.ok(first.at<request.ack_at);assert.ok(Number(first.feedback_at)>=request.dispatch_at&&Number(first.feedback_at)<request.ack_at);
  assert.ok(first.at-request.dispatch_at<=100,'local visible character feedback must meet the existing 100ms target');
  assert.ok(frames.every(f=>Math.abs(f.actual.z+f.authority.distance)<1e-8&&Math.abs(f.camera_distance-f.authority.distance)<1e-8&&Math.abs(f.camera_z-(-f.authority.distance+8.8))<1e-8),'prediction must not change forward distance or camera');
  row.timing={dispatch_at:request.dispatch_at,first_render_at:first.at,diagnostic_feedback_at:Number(first.feedback_at),ack_at:request.ack_at,first_applied_at:applied?.at??null,visible_feedback_ms:first.at-request.dispatch_at,ack_ms:request.ack_at-request.dispatch_at};
  if(current.reject){assert.equal(request.status,409);assert.equal(request.valid_receipt,undefined);assert.equal(sequence,0);assert.equal(state.players[0].inputNo,0);const restored=frames.find(f=>f.at>request.ack_at&&Math.abs(f.actual.x-f.authority.x)<1e-8);assert.ok(restored,'rejection must roll back lateral prediction');row.timing.rollback_ms=restored.at-request.ack_at;assert.ok(row.timing.rollback_ms<=100);}
  else{assert.equal(request.status,200);assert.ok(request.valid_receipt);assert.ok(first.at<applied.at);const settled=frames.find(f=>f.at>=applied.at+100&&Math.abs(f.actual.x-f.authority.x)<1e-8&&Math.abs(f.actual.y-f.authority.y)<1e-8);assert.ok(settled,'applied authority must take over after the bounded 100ms correction');assert.ok(settled.at-applied.at<=150,'authority reconciliation is bounded to 100ms plus at most 50ms frame-observation margin');row.timing.reconciled_at=settled.at;row.timing.reconciliation_ms=settled.at-applied.at;}
  assert.equal(row.observation.droppedFrames,0);assert.equal(row.observation.pollError,undefined);assert.deepEqual(row.errors,[]);
  await page.screenshot({path:resolve(out,`${current.name}-authority.png`)});
  closing=true;await page.evaluate(()=>window.inputWebgl.dispose());await page.waitForSelector('[data-testid=run-scene]',{state:'detached'});await context.close();context=null;
  row.passed=true;console.log(JSON.stringify({case:current.name,timing:row.timing,passed:true}));await writeFile(resolve(out,'webgl-input.json'),JSON.stringify({...report,http_events:httpEvents},null,2));
 }
 report.source_hashes_after=await hashes();assert.deepEqual(report.source_hashes_after,report.source_hashes,'tested production sources must remain frozen throughout observation');assert.ok(httpEvents.every(event=>!event.server_error));report.passed=true;
}catch(error){report.errors.push({message:error.message,stack:error.stack});process.exitCode=1;}
finally{
 if(context)await context.close().catch(()=>{});if(browser)await browser.close().catch(()=>{});clearInterval(timer);clearTimeout(publicationTimer);if(server)await new Promise(resolve=>server.close(resolve));
 report.http_events=httpEvents;report.completed_at=new Date().toISOString();await writeFile(resolve(out,'webgl-input.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,report:resolve(out,'webgl-input.json'),errors:report.errors.map(e=>e.message)}));
}
