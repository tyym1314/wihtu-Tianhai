/** Real Three scene/assets and controller, with explicit packet and RAF times.
 * This tests rendered transforms, not network latency, FPS or phone performance. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import * as engine from '../arena/run/engine.mjs';
import {createRunPracticeInputs,advanceRunPracticeInputs} from '../server/pvp/run-practice-inputs.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const out=resolve(root,'review/run-practice-motion',new Date().toISOString().replaceAll(':','-')+'-'+randomBytes(4).toString('hex'));
await mkdir(out,{recursive:true});console.log(JSON.stringify({output:out}));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const controllerPath=resolve(root,'arena/run/practice-controller.mjs');
// A deliberately selected archived source permits a before/after regression;
// imports still resolve against the real controller's directory.
const selectedController=process.env.OASIS_RUN_MOTION_CONTROLLER?resolve(process.env.OASIS_RUN_MOTION_CONTROLLER):controllerPath;
const controllerSource=await readFile(selectedController,'utf8');
const sources=['arena/run/scene.mjs','arena/run/practice-controller.mjs','arena/run/causal-sampling.mjs','arena/run/runner-physics.mjs','arena/run/practice-presentation-events.mjs','server/pvp/run-practice-inputs.mjs','tests/run-practice-snapshot-motion-browser.mjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(sources.map(async p=>[p,hash(await readFile(resolve(root,p)))])));
const fields=['key','distanceU','checkpointU','lane','fromLane','changeStartTick','changeEndTick','jumpStartTick','slideUntilTick','stunUntilTick','immuneUntilTick','fallStartTick','fallUntilTick','shieldUntilTick','boostUntilTick','inventory','claimedItems','resolvedObstacles','hits','inputNo','appliedInputNo','lastInputTick','pendingInput','finishTick','finishedAt','forfeited'];
function packets(){
 const state=engine.createState('00'.repeat(32),1000,{ruleVersion:engine.PRACTICE_INPUT_RULE_VERSION,startPolicy:engine.RUN_SCENE_READY_POLICY,players:[{key:'self',seatIndex:0,isBot:false},{key:'bot',seatIndex:1,isBot:true}]});
 engine.armStart(state,1000);
 let e=createRunPracticeInputs({roomId:'motion_room',playerKey:'self',practice:true,entryMinor:'0',clockEpoch:1,state}).envelope;
 return [60,90,105,120].map(tick=>{
  e=advanceRunPracticeInputs(e,tick).envelope;
  const game=engine.view(e.current,'self');game.resultCommitted=false;game.winnerKeys=[];
  assert.equal(game.players[0].hits,0);assert.equal(game.players[0].fallUntilTick,null);
  return {id:e.roomId,game_id:'run',practice:true,entry_minor:'0',status:'active',me:'self',version:e.revision+1,game,
   run_inputs:{protocol:e.protocol,ruleVersion:game.ruleVersion,roomId:e.roomId,playerKey:e.playerKey,clockEpoch:e.clockEpoch,revision:e.revision,
    headTick:e.current.tick,serverTick:e.serverTick,committedThroughTick:e.committedThroughTick,processedThroughCommandSeq:e.lastCommandSeq,
    acceptedInputNo:e.current.players[0].inputNo,decisions:[],correction:null,resultAuthorization:null,
    selfReplay:{schema:'run-practice-self-replay-v1',anchorTick:e.anchor.tick,player:Object.fromEntries(fields.map(k=>[k,structuredClone(e.anchor.players[0][k])])),acceptedCommands:[]}}};
 });
}
const source=`
import {createRunScene} from './arena/run/scene.mjs';
import {createRunPracticeController} from './arena/run/practice-controller.mjs';
import {resolveRunCourse} from './arena/run/courses.mjs';
const nativeRAF=window.requestAnimationFrame.bind(window),nativeCancel=window.cancelAnimationFrame.bind(window);
let callbacks=new Map(),serial=0,scene,controller,origin=0,disposed=false;
window.requestAnimationFrame=fn=>{callbacks.set(++serial,fn);return serial};
window.cancelAnimationFrame=id=>callbacks.delete(id);
window.motionQA={frames:[],errors:[],events:[],ready:false,
 warm(room){scene=createRunScene(document.querySelector('#scene'),{course:resolveRunCourse(room.game),onReady:()=>this.ready=true,onError:e=>this.errors.push(String(e.stack||e)),onEvent:(type,event)=>this.events.push({type,event})});scene.update(room.game,'self',{roomId:room.id,roomVersion:room.version,practiceRoom:room});},
 step(at){const batch=[...callbacks.values()];callbacks.clear();for(const fn of batch)fn(origin+at);return this.frames.at(-1);},
 start(room){origin=performance.now();controller=createRunPracticeController({roomId:room.id,playerKey:'self',clockEpoch:1,makeRequestId:()=> 'motion_request'});this.frames=[];return this.receive(room,0);},
 receive(room,at){const result=controller.receive({room,receivedAt:origin+at});if(!result.ok)throw Error(JSON.stringify(result));scene.update(room.game,'self',{roomId:room.id,roomVersion:room.version,practiceRoom:room,practiceController:controller});return result;},
 capture(){window.requestAnimationFrame=nativeRAF;},
 dispose(){scene?.dispose();controller?.clear();disposed=true;window.requestAnimationFrame=nativeRAF;window.cancelAnimationFrame=nativeCancel;return{callbacks:callbacks.size,canvases:document.querySelectorAll('canvas').length,disposed};},
 time:at=>at-origin
};`;
const report={scope:'Actual Three/WebGL transforms and production assets, explicit synthetic packet/RAF schedule and actual engine-generated replay proofs. No HTTP gameplay, GPU timing, real-device or full-round acceptance.',started_at:new Date().toISOString(),controller_source:selectedController,controller_sha256:hash(controllerSource),source_before:await hashes(),packets:packets(),frames:[],errors:[],checks:[],passed:false};
let server,browser,page;
try{
 const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:'motion-browser.mjs'},bundle:true,write:false,outdir:'/virtual-motion',format:'esm',logLevel:'silent',loader:{'.glb':'file','.webp':'file'},plugins:[{name:'observe-real-transforms',setup(b){
  b.onResolve({filter:/\.(glb|webp)\?url$/},a=>({path:resolve(a.resolveDir,a.path.slice(0,-4))}));
  b.onLoad({filter:/\/run\/practice-controller\.mjs$/},()=>({contents:controllerSource,loader:'js',resolveDir:dirname(controllerPath)}));
  b.onLoad({filter:/\/run\/scene\.mjs$/},async a=>{
   const content=await readFile(a.path,'utf8'),anchor='onFrame(time);if(mine&&!readyAnnounced)';assert.equal(content.split(anchor).length,2);
   return {contents:content.replace(anchor,`onFrame(time);if(window.motionQA&&lastPracticeFrame){window.motionQA.frames.push({at:window.motionQA.time(time),head:game.snapshotTick,runner_z:runners.get(me).root.position.z,camera_z:camera.position.z,distance:currentVisualPose.distance,tick:currentVisualPose.tick,event_tick:currentVisualPose.eventTick,visual_speed:currentVisualPose.visualSpeed,mode:lastPracticeFrame.mode,reason:lastPracticeFrame.reason,draw_calls:renderer.info.render.calls});}if(mine&&!readyAnnounced)`),loader:'js',resolveDir:dirname(a.path)};
  });
 }}]});
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).contents,assets=new Map(bundle.outputFiles.filter(f=>/\.(glb|webp)$/.test(f.path)).map(f=>['/'+basename(f.path),f.contents]));
 report.assets=[...assets].map(([path,bytes])=>({path,bytes:bytes.length,sha256:hash(bytes)}));
 server=createServer((req,res)=>{
  if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');return res.end(js);}
  if(assets.has(req.url)){res.setHeader('content-type',req.url.endsWith('.glb')?'model/gltf-binary':'image/webp');return res.end(assets.get(req.url));}
  if(req.url==='/favicon.ico'){res.statusCode=204;return res.end();}
  if(req.url!=='/'){res.statusCode=404;return res.end();}
  res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}#scene{width:390px;height:700px}</style><div id="scene"></div><script type="module" src="/app.js"></script>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=metal']});
 page=await browser.newPage({viewport:{width:390,height:700},isMobile:true,hasTouch:true});
 page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});
 await page.route('**/*',route=>route.request().url().startsWith(origin+'/')||route.request().url().startsWith('data:')?route.continue():route.abort());
 await page.goto(origin+'/');await page.waitForFunction(()=>window.motionQA);
 await page.evaluate(room=>motionQA.warm(room),report.packets[0]);
 await page.waitForFunction(()=>{motionQA.step(performance.now());return motionQA.ready||motionQA.errors.length},{},{polling:25,timeout:15000});
 assert.deepEqual(await page.evaluate(()=>motionQA.errors),[]);
 await page.evaluate(room=>motionQA.start(room),report.packets[0]);
 // Read actual rendered transforms after every controlled frame. Same-time
 // pre/post receipt draws expose a packet jump independently of RAF cadence.
 const result=await page.evaluate(packets=>{
  const receipts=new Map([[400,packets[1]],[650,packets[2]],[900,packets[3]]]);
  const transitions=[];
  for(let i=0;i<=66;i++){
   const at=i*1000/60,before=motionQA.step(at),packet=receipts.get(Math.round(at));
   if(packet){motionQA.receive(packet,at);const after=motionQA.step(at);transitions.push({at,before,after});}
  }
  return{frames:motionQA.frames,transitions,errors:motionQA.errors,events:motionQA.events};
 },report.packets);
 Object.assign(report,result);
 await page.evaluate(()=>motionQA.capture());
 await page.screenshot({path:resolve(out,'scene.png')});
 const near=(a,b,message)=>assert.ok(Math.abs(a-b)<1e-7,`${message}: ${a} vs ${b}`);
 for(const {before,after} of report.transitions){near(after.runner_z,before.runner_z,'packet must not teleport runner');near(after.camera_z,before.camera_z,'packet must not teleport camera');}
 report.checks.push('Same-time packet receipts preserve actual runner and camera transforms');
 for(let i=0;i<report.frames.length;i++){
  const frame=report.frames[i];near(frame.runner_z,-frame.distance,'runner uses measured trajectory');near(frame.camera_z,8.8-frame.distance,'camera uses same trajectory');assert.ok(frame.draw_calls>0);
  if(i>1){const previous=report.frames[i-1],dt=frame.at-previous.at,advance=frame.distance-previous.distance;assert.ok(advance>=-1e-7,'ordinary movement rewound');assert.ok(advance<=8*dt/1000+1e-7,`ordinary motion exceeded 8m/s: ${advance}m in ${dt}ms`);}
 }
 report.checks.push('Ordinary rendered motion remains monotonic and at most 8m/s across three packet receipts');
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.events,[]);report.passed=true;
}catch(error){report.failure=error.stack;process.exitCode=1;}
finally{
 if(page){report.scene_cleanup=await page.evaluate(()=>motionQA.dispose()).catch(error=>({error:error.message}));if(report.scene_cleanup.callbacks!==0||report.scene_cleanup.canvases!==0){report.passed=false;process.exitCode=1;}}
 if(browser){await browser.close();report.browser_closed=true;}
 if(server){await new Promise(resolve=>server.close(resolve));report.server_closed=true;}
 report.source_after=await hashes();report.source_unchanged=JSON.stringify(report.source_before)===JSON.stringify(report.source_after);if(!report.source_unchanged){report.passed=false;process.exitCode=1;}
 report.finished_at=new Date().toISOString();await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output:out,passed:report.passed,checks:report.checks,errors:report.errors,failure:report.failure,cleanup:report.scene_cleanup}));
}
