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
import {createRunTimeline} from '../arena/run/timeline.mjs';
import {createRunTimelineJournal} from '../arena/run/timeline-journal.mjs';
import {makeRunActionReceipt} from '../shared/run-action-receipt.mjs';
import {createRunHeldBoostFixture} from './fixtures/run-timeline-race-fixture.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const out=resolve(root,'review/deployment',`run-input-webgl-${Date.now()}-${Math.random().toString(16).slice(2,8)}`);
await mkdir(out,{recursive:true});console.log(JSON.stringify({report_directory:out}));
const sourceFiles=['arena/run/RunGame.jsx','arena/run/scene.mjs','arena/run/timeline.mjs','arena/run/self-projection.mjs','arena/run/causal-sampling.mjs','arena/run/timeline-journal.mjs','arena/run/runner-physics.mjs','arena/run/input-presentation.mjs','arena/run/presentation-events.mjs','arena/run/input-readiness.mjs','arena/run/frame-trace.mjs','arena/run/presentation.mjs','arena/run/atlas-characters.mjs','arena/run/characters.mjs','arena/run/engine.mjs','arena/shared/room-poller.mjs','arena/shared/run-room-poller.mjs','shared/run-action-receipt.mjs','tests/fixtures/run-timeline-race-fixture.mjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await readFile(resolve(root,file))).digest('hex')])));
const report={scope:'Local Chrome with actual RunGame, scene, GLB/WebP assets and WebGL renderer. Isolated real HTTP wrapper and pinned engine; controlled ACK/publication delays, not Arena backend, device, public-host, FPS or full-round acceptance.',harness_sha256:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),cases:[],errors:[],source_hashes:await hashes(),passed:false};
const source=`
import React,{useEffect,useRef,useState} from 'react';import{createRoot}from'react-dom/client';
import RunGame from './arena/run/RunGame.jsx';import{startRoomPolling}from'./arena/shared/room-poller.mjs';import{startRunRoomPolling}from'./arena/shared/run-room-poller.mjs';
import{readRunActionReceipt}from'./shared/run-action-receipt.mjs';
window.inputWebgl={requests:[],frames:[],timelineCommands:[],timelineSampleNo:0,droppedFrames:0,audio:[],effects:[],returned:false};
const freeze=x=>{if(x&&typeof x==='object'){for(const v of Object.values(x))freeze(v);Object.freeze(x)}return x};
function App(){const[room,setRoom]=useState(null),[requestState,setRequestState]=useState('idle'),[shown,setShown]=useState(true),roomRef=useRef(null),inFlight=useRef(false);
 window.inputWebgl.dispose=()=>setShown(false);
 const accept=raw=>{const old=roomRef.current;if(old?.id===raw.id&&old.version>raw.version)return old;const next=freeze(raw);roomRef.current=next;setRoom(next);return next;};
 useEffect(()=>(window.useRunFreshnessPoller?startRunRoomPolling:startRoomPolling)({initialDelay:0,interval:()=>150,roomId:'webgl-run-room',playerKey:'p0',rateScope:JSON.stringify(['webgl-fixture','p0']),readVersion:()=>roomRef.current?.version??-1,readRoom:()=>roomRef.current,read:async signal=>{const r=await fetch('/room',{signal});if(!r.ok)throw Error('Room read failed');return r.json()},onRoom:accept,onError:e=>window.inputWebgl.pollError=String(e)}),[]);
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
 const animationAnchor='scene.add(runner.root);runners.set(p.key,runner);';assert.equal(content.split(animationAnchor).length,2,'animation observer anchor must be unique');
 content=content.replace(animationAnchor,`const originalAnimate=runner.animate;runner.animate=(...args)=>{if(p.key===me&&window.inputWebgl)window.inputWebgl.lastAnimationTick=args[1];return originalAnimate.apply(runner,args);};scene.add(runner.root);runners.set(p.key,runner);`);
 const eventAnchor='onEvent(event.type,event);';assert.equal(content.split(eventAnchor).length,2,'event observation anchor must be unique');
 content=content.replace(eventAnchor,`if(window.inputWebgl)window.inputWebgl.effects.push({event:structuredClone(event),display_tick:currentVisualPose.eventTick??currentVisualPose.tick,warmed,at:performance.now()});onEvent(event.type,event);`);
 return content.replace(needle,`onFrame(time);if(mine&&window.inputWebgl){const observedRoot=runners.get(me)?.root,observedAuthority=(lastTimelineFrame?.mode==='fallback'?null:lastTimelineFrame?.pose)??projectedPose(mine,game,snapshotClock.elapsed(time)),probe=window.inputWebgl;
  if(probe.frames.length<6000)probe.frames.push({at:performance.now(),raf_at:time,timeline_sample_no:probe.timelineSampleNo,timeline:lastTimelineFrame?{mode:lastTimelineFrame.mode,reason:lastTimelineFrame.reason,displayTick:lastTimelineFrame.displayTick,baseTick:lastTimelineFrame.baseTick,baseVersion:lastTimelineFrame.baseVersion}:null,snapshot_tick:game.snapshotTick,snapshot_elapsed:snapshotClock.elapsed(time),input_no:mine.inputNo,applied_input_no:mine.appliedInputNo,actual:{x:observedRoot.position.x,y:observedRoot.position.y,z:observedRoot.position.z,clip:observedRoot.userData.clip},authority:observedAuthority,animation_tick:probe.lastAnimationTick,visible_items:items.filter(item=>item.root.visible).map(item=>item.id),camera_distance:cameraDistance,camera_z:camera.position.z,feedback_at:container.dataset.inputFeedbackAt||null,feedback_type:container.dataset.inputFeedbackType||null,feedback_state:container.dataset.inputFeedbackState||null,calls:renderer.info.render.calls,textures:renderer.info.memory.textures});else probe.droppedFrames++;
 }if(mine&&!readyAnnounced)`);
}
let server,browser,timer,publicationTimer,context;
const httpEvents=[];let scenario,state,version=0,sequence=0,heldUntil=0,heldReadBody=null,readHeldUntil=0,slowReadsRemaining=0;
const players=[{key:'p0',name:'Local human',seatIndex:0,isBot:false},{key:'p1',name:'Declared BOT',seatIndex:1,isBot:true}];
const snap=()=>({id:'webgl-run-room',game_id:'run',me:'p0',me_last_seq:sequence,version,status:state.status==='active'?'active':'settled',practice:true,capacity:2,entry_minor:'0',prize_minor:'0',server_now:Date.now(),starts_at:state.phase==='arming'?null:state.startedAt,players:players.map(p=>({external_user_id:p.key,name:p.name,bot:p.isBot,seat_index:p.seatIndex})),start_protocol:{kind:engine.RUN_SCENE_READY_POLICY,phase:state.phase,ready_count:state.phase==='arming'?0:1,human_count:1,ready_deadline_at:state.armingDeadlineAt,starts_at:state.phase==='arming'?null:state.startedAt},game:engine.view(state,'p0')});
function advance(){if(!state||state.phase==='arming'||Date.now()<heldUntil)return;engine.tick(state,Date.now());version++;}
function reset(next){clearTimeout(publicationTimer);scenario=next;state=next.midRace?createRunHeldBoostFixture({startedAt:Date.now()-22500,playerKey:'p0',botKey:'p1'}).state:engine.createState('02'.repeat(32),Date.now(),{players,ruleVersion:engine.PRACTICE_RULE_VERSION,startPolicy:engine.RUN_SCENE_READY_POLICY});sequence=0;version++;heldUntil=0;heldReadBody=null;readHeldUntil=0;slowReadsRemaining=0;}
try{
 const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:'run-input-webgl-entry.jsx',loader:'jsx'},bundle:true,write:false,outdir:'/virtual-run-input-webgl',jsx:'automatic',format:'esm',logLevel:'silent',loader:{'.glb':'file','.webp':'file'},plugins:[{name:'real-assets-readonly-observation',setup(b){
  b.onResolve({filter:/\.(glb|webp)\?url$/},a=>({path:resolve(a.resolveDir,a.path.slice(0,-4))}));
  b.onLoad({filter:/\/run\/scene\.mjs$/},async a=>({contents:instrumentScene(await readFile(a.path,'utf8')),loader:'js',resolveDir:dirname(a.path)}));
  b.onLoad({filter:/\/run\/timeline\.mjs$/},async a=>{
   const original=await readFile(a.path,'utf8'),anchor='export function createRunTimeline(';
   assert.equal(original.split(anchor).length,2,'timeline factory observation anchor must be unique');
   const observed=original.replace(anchor,'function createRunTimelineImpl(')+`
export function createRunTimeline(...factoryArgs){const inner=createRunTimelineImpl(...factoryArgs);return new Proxy(inner,{get(target,key){const method=target[key];if(typeof method!=='function')return method;return(...args)=>{const result=method(...args),probe=window.inputWebgl;if(probe){if(probe.timelineCommands.length>=20000)throw Error('Timeline observation limit');const sampleNo=key==='sample'?++probe.timelineSampleNo:null;probe.timelineCommands.push({method:key,args:structuredClone(args),sampleNo});}return result;};}});}
`;
   return{contents:observed,loader:'js',resolveDir:dirname(a.path)};
  });
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
  if(path==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><link rel="stylesheet" href="/app.css"><style>html,body{margin:0;background:#102d37}#root{max-width:460px;margin:auto}</style></head><body><div id="root"></div><script>window.useRunFreshnessPoller='+JSON.stringify(!!scenario.useHedge)+'</script><script type="module" src="/app.js"></script>');return;}
  res.setHeader('content-type','application/json');
  if(path==='/room'){const body=heldReadBody&&Date.now()<readHeldUntil?heldReadBody:JSON.stringify(snap()),delay=slowReadsRemaining>0?(slowReadsRemaining--,scenario.singleSlowReadMs):scenario.readDelay??0;
   const event={case:scenario.name,kind:'read',received_at:Date.now(),version:JSON.parse(body).version,tick:JSON.parse(body).game.snapshotTick,delay_ms:delay};httpEvents.push(event);
   if(delay)await new Promise(resolve=>setTimeout(resolve,delay));event.response_at=Date.now();res.end(body);return;}
  if(path==='/scene-ready'){if(state.phase==='arming'){engine.armStart(state,Date.now());version++;}res.end(JSON.stringify(snap()));return;}
  if(path==='/action'){
   let body='';for await(const chunk of req)body+=chunk;const payload=JSON.parse(body),received=Date.now(),caseName=scenario.name,ackDelay=payload.action.type===scenario.preAction?(scenario.preActionAck??scenario.ack):scenario.ack;
   if(scenario.holdReadsDuringItemAck&&payload.action.type==='item'){heldReadBody=JSON.stringify(snap());readHeldUntil=received+ackDelay;}
   const entry={case:caseName,received_at:received,payload,ack_delay_ms:ackDelay,publish_delay_ms:scenario.publish,rejected:!!scenario.reject};httpEvents.push(entry);
   assert.equal(payload.seq,sequence+1);let response;
   if(scenario.reject)response={code:'BUSY',message:'Controlled fixture rejection: engine action not applied'};
   else{
    const result=engine.act(state,'p0',payload.action,received);sequence++;version++;
    const expected={roomId:'webgl-run-room',playerKey:'p0',request_id:payload.request_id,seq:payload.seq,type:payload.action.type,ruleVersion:state.ruleVersion};
    response={...snap(),action_receipt:makeRunActionReceipt({...expected,event:result.event})};entry.receipt=response.action_receipt;
    heldUntil=received+scenario.publish;
    publicationTimer=setTimeout(()=>{advance();entry.published_at=Date.now();entry.published_input_no=state.players[0].appliedInputNo;},scenario.publish);
   }
   const frozenResponse=JSON.stringify(response);await new Promise(resolve=>setTimeout(resolve,ackDelay));entry.response_at=Date.now();res.statusCode=scenario.reject?409:200;res.end(frozenResponse);return;
  }
  res.statusCode=404;res.end(JSON.stringify({code:'NOT_FOUND'}));
 }catch(error){httpEvents.push({server_error:String(error.stack||error)});res.statusCode=500;res.end(JSON.stringify({code:'FIXTURE_ERROR',message:error.message}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));timer=setInterval(advance,250);
 const origin=`http://127.0.0.1:${server.address().port}`;report.origin=origin;
 browser=await chromium.launch({headless:true,channel:'chrome',args:['--use-angle=metal']});report.browser=browser.version();
 const cases=[{name:'jump-ack300-publish450',type:'jump',ack:300,publish:450},{name:'left-ack450-publish200',type:'left',ack:450,publish:200},{name:'jump-ack450-publish450',type:'jump',ack:450,publish:450},{name:'left-ack300-publish200',type:'left',ack:300,publish:200},{name:'left-rejected-ack450',type:'left',ack:450,publish:0,reject:true},{name:'jump-after-forward-hold',type:'jump',ack:300,publish:450,preHold:true},{name:'left-after-forward-hold',type:'left',ack:300,publish:450,preHold:true},
  {name:'mid-race-boost-ack150-read250',type:'item',ack:150,publish:0,readDelay:250,midRace:true},
  {name:'mid-race-jump-then-boost-ack450-read0',type:'item',preAction:'jump',preActionAck:150,ack:450,publish:0,readDelay:0,midRace:true,holdReadsDuringItemAck:true},
  {name:'mid-race-boost-rejected-ack150-read250',type:'item',ack:150,publish:0,readDelay:250,midRace:true,reject:true},
  {name:'single-slow-get-serial-baseline',type:'jump',ack:150,publish:0,singleSlowReadMs:800,useHedge:false},
  {name:'single-slow-get-bounded-hedge',type:'jump',ack:150,publish:0,singleSlowReadMs:800,useHedge:true}];
 for(const current of cases){
  reset(current);const row={...current,errors:[],resources:[],passed:false};report.cases.push(row);
  row.trace_enabled=report.cases.length>1;
  context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
  if(row.trace_enabled)await context.addInitScript(()=>{try{sessionStorage.setItem('oasis:run:frame-trace:v1','1');}catch{}});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){row.errors.push({kind:'nonlocal-request',url:route.request().url()});return route.abort();}return route.continue();});
  const page=await context.newPage();let closing=false;
  page.on('pageerror',error=>row.errors.push({kind:'javascript',message:error.message}));
  page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('409 (Conflict)'))row.errors.push({kind:'console',message:message.text()});});
  page.on('requestfailed',request=>{if(!closing)row.errors.push({kind:'network',path:new URL(request.url()).pathname,error:request.failure()?.errorText});});
  page.on('response',response=>{const path=new URL(response.url()).pathname;if(assets.has(path))row.resources.push({path,status:response.status()});if(response.status()>=400&&!(current.reject&&path==='/action'&&response.status()===409))row.errors.push({kind:'http',path,status:response.status()});});
  await page.goto(origin,{waitUntil:'domcontentloaded'});await page.waitForFunction(type=>document.querySelector(`[data-testid=run-${type}]`)?.disabled===false,current.type,{timeout:30000});
  if(current.preAction){
   await page.getByTestId(`run-${current.preAction}`).tap();
   await page.waitForFunction(()=>window.inputWebgl.requests[0]?.ack_at!==undefined,{},{timeout:4000});
   row.pre_action=await page.evaluate(()=>structuredClone(window.inputWebgl.requests[0]));
   assert.equal(row.pre_action.status,200);assert.ok(row.pre_action.valid_receipt);
   await page.waitForFunction(()=>document.querySelector('[data-testid=run-item]')?.disabled===false,{},{timeout:4000});
  }
  const initialInputNo=state.players[0].inputNo,initialSequence=sequence;
  row.gpu=await page.evaluate(()=>{const canvas=document.querySelector('[data-testid=run-track] canvas'),gl=canvas.getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return{renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),canvas:{width:canvas.width,height:canvas.height},loadedModels:document.querySelector('[data-testid=run-track]').dataset.modelsReady};});
  assert.equal(await page.evaluate(()=>!!document.querySelector('[data-testid=run-track]').__oasisRunFrameTrace),row.trace_enabled,'trace is exposed only after explicit session opt-in');
  await page.evaluate(()=>{window.inputWebgl.frames=[];window.inputWebgl.requests=[];document.querySelector('[data-testid=run-track]').__oasisRunFrameTrace?.reset();});
  if(current.preHold){
   heldUntil=Date.now()+1800;
   await page.waitForFunction(()=>window.inputWebgl.frames.at(-1)?.snapshot_elapsed>=700,{},{timeout:2000});
   row.before_held_dispatch=await page.evaluate(()=>({frame:window.inputWebgl.frames.at(-1),enabled:!document.querySelector('[data-testid=run-jump]').disabled}));
   assert.ok(row.before_held_dispatch.enabled);assert.ok(row.before_held_dispatch.frame.snapshot_elapsed>=700);
  }
  await page.getByTestId(`run-${current.type}`).tap();
  if(current.type!=='item')await page.waitForFunction(type=>window.inputWebgl.frames.some(f=>f.feedback_state==='predicted'&&(type==='jump'?f.actual.y>0&&f.actual.clip==='jump':f.actual.x<-.001)&&f.applied_input_no===0),current.type,{timeout:1500});
  await page.screenshot({path:resolve(out,`${current.name}-immediate.png`)});
  await page.waitForFunction(()=>window.inputWebgl.requests[0]?.ack_at!==undefined,{},{timeout:4000});
  if(!current.reject)await page.waitForFunction(no=>window.inputWebgl.frames.some(f=>f.applied_input_no===no),initialInputNo+1,{timeout:4000});
  // Start the read-only disturbance after the accepted action is visible;
  // an overlapping delayed POST must not supply a fresh authority mid-control.
  if(current.singleSlowReadMs){row.slow_read_armed_at=Date.now();slowReadsRemaining=1;}
  await page.waitForTimeout(current.singleSlowReadMs?2500:180);
  row.observation=await page.evaluate(()=>{const {dispose,...observation}=window.inputWebgl;return structuredClone({...observation,frame_trace:document.querySelector('[data-testid=run-track]').__oasisRunFrameTrace?.read()??null});});
  const request=row.observation.requests[0],frames=row.observation.frames,first=frames.find(f=>f.at>=request.dispatch_at&&(current.type==='item'||f.feedback_state==='predicted'&&(current.type==='jump'?f.actual.y>0&&f.actual.clip==='jump':f.actual.x<-.001)&&f.applied_input_no===0)),applied=frames.find(f=>f.applied_input_no===initialInputNo+1);
  assert.equal(row.observation.requests.length,1);assert.ok(first,'real renderer must draw after dispatch');assert.ok(first.at<request.ack_at);
  if(current.type!=='item'){assert.ok(Number(first.feedback_at)>=request.dispatch_at&&Number(first.feedback_at)<request.ack_at);assert.ok(first.at-request.dispatch_at<=100,'local visible character feedback must meet the existing 100ms target');}
  assert.ok(frames.every(f=>Math.abs(f.actual.z+f.authority.distance)<1e-8&&Math.abs(f.camera_distance-f.authority.distance)<1e-8&&Math.abs(f.camera_z-(-f.authority.distance+8.8))<1e-8),'input feedback must not change the chosen trajectory distance or camera');
  const effectIds=new Set();for(const effect of row.observation.effects){assert.ok(effect.warmed,'effect must wait for scene readiness');assert.ok(effect.event.tick<=effect.display_tick,'authority FX cannot lead the displayed game tick');assert.ok(!effectIds.has(effect.event.id),'effect cannot replay');effectIds.add(effect.event.id);}
  for(const frame of frames)for(const id of frame.authority.visualPlayer?.claimedItems??[])assert.ok(!frame.visible_items.includes(id),'visually claimed pickup must be hidden');
  row.presentation_events={played:effectIds.size,no_early_or_duplicate_events:true};
  const replay=createRunTimeline(),replayed=new Map();
  for(const command of row.observation.timelineCommands){assert.equal(typeof replay[command.method],'function');const value=replay[command.method](...command.args);if(command.method==='sample')replayed.set(command.sampleNo,value);}
  for(const frame of frames){const expected=replayed.get(frame.timeline_sample_no);assert.ok(expected,'render frame must have a complete replayed timeline');assert.equal(frame.timeline.mode,expected.mode);assert.equal(frame.timeline.reason,expected.reason);assert.equal(frame.timeline.displayTick,expected.displayTick);if(expected.mode!=='fallback'&&expected.pose){assert.equal(frame.authority.distance,expected.pose.distance);assert.equal(frame.authority.x,expected.pose.x);assert.equal(frame.authority.y,expected.pose.y);assert.equal(frame.authority.tick,expected.pose.tick);assert.equal(frame.animation_tick,expected.pose.animationTick??expected.pose.tick);}assert.ok(frame.camera_distance<=480);}
  row.timeline_replay={commands:row.observation.timelineCommands.length,rendered_frames:frames.length,matched_frames:frames.length,modes:[...new Set(frames.map(f=>f.timeline.mode))]};
  if(row.trace_enabled){
   const trace=row.observation.frame_trace,field=Object.fromEntries(trace.fields.map((name,i)=>[name,i]));
   assert.equal(trace.stored,frames.length);assert.equal(trace.rejected,0);assert.equal(trace.overwritten,0);
   const journal=trace.timelineJournal;assert.equal(journal.enabled,true);assert.equal(journal.complete,true,journal.reason);
   const journalReplay=createRunTimelineJournal(createRunTimeline(),{enabled:true,capacity:journal.capacity,payloadBytes:journal.payloadBytes});
   const decoded=journal.commands.map(([methodCode,payload])=>({method:journal.methods[methodCode],args:journal.methods[methodCode]==='sample'?[payload]:journal.payloads[payload]}));
   assert.deepEqual(decoded,row.observation.timelineCommands.map(({method,args})=>({method,args})),'production journal must preserve the independently observed controller command stream');
   for(const {method,args} of decoded)journalReplay.timeline[method](...args);
   const replayJournal=journalReplay.read();assert.equal(replayJournal.complete,true,replayJournal.reason);
   assert.deepEqual(replayJournal.commands,journal.commands);assert.deepEqual(replayJournal.strings,journal.strings);assert.deepEqual(replayJournal.samples,journal.samples,'every recorded pose and causal endpoint must replay exactly');
   const jf=Object.fromEntries(journal.frameFields.map((name,i)=>[name,i])),js=Object.fromEntries(journal.sampleFields.map((name,i)=>[name,i]));
   const bound=new Map(journal.frames.map(frame=>[frame[jf.frameAtMs],frame]));assert.equal(bound.size,journal.frames.length);
   for(const frame of frames){
    const binding=bound.get(frame.raf_at);assert.ok(binding,'every post-reset render retains its full-prefix journal binding');assert.equal(binding[jf.sampleNo],frame.timeline_sample_no);
    assert.equal(binding[jf.runnerX],frame.actual.x);assert.equal(binding[jf.runnerY],frame.actual.y);assert.equal(binding[jf.runnerZ],frame.actual.z);assert.equal(binding[jf.cameraZ],frame.camera_z);
    const sample=journal.samples[binding[jf.sampleNo]-1];assert.equal(sample[js.sampleNo],frame.timeline_sample_no);
    if(frame.timeline.mode!=='fallback'){assert.equal(sample[js.distance],frame.authority.distance);assert.equal(sample[js.poseTick],frame.authority.tick);assert.equal(sample[js.causalFromTick],frame.authority.causalFromTick??null);assert.equal(sample[js.causalToTick],frame.authority.causalToTick??null);assert.equal(sample[js.causalMix],frame.authority.causalMix??null);}
   }
   row.journal_replay={complete:true,commands:journal.commands.length,samples:journal.samples.length,bound_frames:journal.frames.length,matched_observed_frames:frames.length};journalReplay.dispose();
   for(let i=0;i<frames.length;i++){
    const sample=trace.samples[i],frame=frames[i];assert.equal(sample[field.frameAtMs],frame.raf_at);assert.equal(sample[field.snapshotTick],frame.snapshot_tick);
    assert.equal(sample[field.runnerZ],frame.actual.z);assert.equal(sample[field.cameraZ],frame.camera_z);assert.equal(sample[field.projectedDistance],frame.camera_distance);
    assert.ok(Number.isSafeInteger(sample[field.roomVersion])&&sample[field.roomVersion]>=0);assert.ok(sample[field.renderReturnedAtMs]>=sample[field.frameAtMs]);
   }
  }else assert.equal(row.observation.frame_trace,null);
  row.timing={dispatch_at:request.dispatch_at,first_render_at:first.at,diagnostic_feedback_at:Number(first.feedback_at),ack_at:request.ack_at,first_applied_at:applied?.at??null,visible_feedback_ms:current.type==='item'?null:first.at-request.dispatch_at,ack_ms:request.ack_at-request.dispatch_at};
  if(current.singleSlowReadMs){
   const motion=frames.filter(f=>f.at>=request.dispatch_at&&f.timeline.mode!=='fallback'&&f.timeline.reason!=='startup-buffer');
   let previous=null,holdSince=null,maxHold=0,maxSpeed=0,forwardBursts=0;
   for(const f of motion){assert.equal(f.authority.hits,0,'the slow-read fixture must not excuse stalls as collisions');if(previous){const dt=(f.raf_at-previous.raf_at)/1000,delta=previous.actual.z-f.actual.z;assert.ok(delta>=-1e-7,'recovery must not rewind');if(delta>9.6*dt+1e-6)forwardBursts++;if(dt>0)maxSpeed=Math.max(maxSpeed,delta/dt);if(Math.abs(delta)<1e-7){holdSince??=previous.raf_at;maxHold=Math.max(maxHold,f.raf_at-holdSince);}else holdSince=null;}previous=f;}
   const reads=httpEvents.filter(e=>e.case===current.name&&e.kind==='read'),slow=reads.filter(e=>e.delay_ms===current.singleSlowReadMs);assert.equal(slow.length,1,'one controlled delayed HTTP body');
   const overlaps=reads.filter(e=>e!==slow[0]&&e.received_at>slow[0].received_at&&e.received_at<slow[0].response_at);
   assert.ok(motion.length>90,'observe a sustained window including expiry and recovery');
   if(current.useHedge){assert.ok(overlaps.length>0,'the candidate must actually bypass a delayed read');assert.ok(maxHold<100,'a single delayed GET must not stop ordinary motion for 100 ms');assert.equal(forwardBursts,0,'freshness recovery cannot exceed real boost speed');}
   else{assert.equal(overlaps.length,0,'baseline retains serial reads');assert.ok(maxHold>=100,'negative control must reproduce an ordinary hold');}
   row.freshness={single_delay_ms:current.singleSlowReadMs,read_count:reads.length,reads_while_slow_pending:overlaps.length,frames:motion.length,max_hold_ms:maxHold,max_speed_mps:maxSpeed,forward_bursts:forwardBursts,performance_pass:!!current.useHedge&&maxHold<100&&forwardBursts===0,scope:current.useHedge?'One slow HTTP GET with normal later requests; not continuous weak network or device acceptance':'Expected failing serial control; protocol assertions passing are not smoothness acceptance'};
  }
  if(current.type==='item'){
   const motion=frames.filter(f=>f.at>=request.dispatch_at);let previous=null,holdSince=null,maxHold=0,maxSpeed=0;
   for(const f of motion){assert.notEqual(f.timeline.mode,'resync','ordinary mid-race item must not force resynchronization');if(previous){const dt=(f.raf_at-previous.raf_at)/1000,delta=previous.actual.z-f.actual.z;assert.ok(delta>=-1e-7,'item motion cannot rewind');assert.ok(delta<=9.6*dt+1e-6,'item correction cannot exceed real boost speed');maxSpeed=Math.max(maxSpeed,delta/dt);if(Math.abs(delta)<1e-7){holdSince??=previous.raf_at;maxHold=Math.max(maxHold,f.raf_at-holdSince);}else holdSince=null;}previous=f;}
   assert.ok(maxHold<100,'unknown item must not stop ordinary forward motion for 100 ms');assert.ok(motion.some(f=>f.at<request.ack_at),'must observe the unknown-outcome window');
   row.item_motion={frames:motion.length,max_hold_ms:maxHold,max_speed_mps:maxSpeed,preserved_animation_frames:motion.filter(f=>f.authority.animationTick!==undefined).length};
   if(current.preAction){assert.ok(row.item_motion.preserved_animation_frames>0,'combined action must exercise retained animation phase');assert.ok(motion.every(f=>f.actual.y>=0),'retained jump cannot sink below the track');}
   if(current.reject){assert.equal(request.status,409);assert.equal(sequence,initialSequence);assert.equal(state.players[0].inputNo,initialInputNo);assert.equal(state.players[0].inventory,'boost');}
   else{assert.equal(request.status,200);assert.ok(request.valid_receipt);assert.equal(state.players[0].inputNo,initialInputNo+1);assert.equal(state.players[0].inventory,null);}
  }else if(current.reject){assert.equal(request.status,409);assert.equal(request.valid_receipt,undefined);assert.equal(sequence,0);assert.equal(state.players[0].inputNo,0);const restored=frames.find(f=>f.at>request.ack_at&&Math.abs(f.actual.x-f.authority.x)<1e-8);assert.ok(restored,'rejection must roll back lateral prediction');row.timing.rollback_ms=restored.at-request.ack_at;assert.ok(row.timing.rollback_ms<=100);}
  else{assert.equal(request.status,200);assert.ok(request.valid_receipt);assert.ok(first.at<applied.at);const settled=frames.find(f=>f.at>=applied.at+100&&Math.abs(f.actual.x-f.authority.x)<1e-8&&Math.abs(f.actual.y-f.authority.y)<1e-8);assert.ok(settled,'applied authority must take over after the bounded 100ms correction');assert.ok(settled.at-applied.at<=150,'authority reconciliation is bounded to 100ms plus at most 50ms frame-observation margin');row.timing.reconciled_at=settled.at;row.timing.reconciliation_ms=settled.at-applied.at;}
  assert.equal(row.observation.droppedFrames,0);assert.equal(row.observation.pollError,undefined);assert.deepEqual(row.errors,[]);
  await page.screenshot({path:resolve(out,`${current.name}-authority.png`)});
  closing=true;await page.evaluate(()=>{window.retiredTraceContainer=document.querySelector('[data-testid=run-track]');window.retiredTraceAccess=window.retiredTraceContainer.__oasisRunFrameTrace;window.inputWebgl.dispose();});await page.waitForSelector('[data-testid=run-scene]',{state:'detached'});
  row.trace_disposal=await page.evaluate(()=>({propertyRemoved:!Object.hasOwn(window.retiredTraceContainer,'__oasisRunFrameTrace'),stored:window.retiredTraceAccess?.read().stored??0}));assert.deepEqual(row.trace_disposal,{propertyRemoved:true,stored:0});
  await context.close();context=null;
  row.passed=true;console.log(JSON.stringify({case:current.name,timing:row.timing,passed:true}));await writeFile(resolve(out,'webgl-input.json'),JSON.stringify({...report,http_events:httpEvents},null,2));
 }
 report.source_hashes_after=await hashes();assert.deepEqual(report.source_hashes_after,report.source_hashes,'tested production sources must remain frozen throughout observation');assert.ok(httpEvents.every(event=>!event.server_error));report.passed=true;
}catch(error){report.errors.push({message:error.message,stack:error.stack});process.exitCode=1;}
finally{
 if(context)await context.close().catch(()=>{});if(browser)await browser.close().catch(()=>{});clearInterval(timer);clearTimeout(publicationTimer);if(server)await new Promise(resolve=>server.close(resolve));
 report.http_events=httpEvents;report.completed_at=new Date().toISOString();await writeFile(resolve(out,'webgl-input.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,report:resolve(out,'webgl-input.json'),errors:report.errors.map(e=>e.message)}));
}
