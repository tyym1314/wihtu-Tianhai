/** Isolated built-app motion diagnosis. Explicit invocation starts browsers. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {chromium,webkit} from 'playwright';
import {installRunTowerMotionProbe} from './run-tower-motion-probe.mjs';
import {analyseRunMotion,analyseTowerMotion} from './run-tower-motion-analysis.mjs';
import {playOneArenaAction} from '../scripts/android-game-actions.mjs';
const options={};for(let i=2;i<process.argv.length;i+=2){assert(['--output','--harness-report','--engine','--seconds'].includes(process.argv[i])&&process.argv[i+1]);options[process.argv[i].slice(2)]=process.argv[i+1];}
assert(options.output&&options['harness-report'],'Pass fresh --output and the supervising --harness-report');
const out=resolve(options.output),harness=JSON.parse(await readFile(resolve(options['harness-report']),'utf8')),origin=process.env.OASIS_PROFILE_ORIGIN,buildId=process.env.OASIS_PROFILE_BUILD_ID;
assert(buildId&&buildId===harness.measurement_build_id&&origin===harness.origin,'Frozen harness/build identity required');
assert(['localhost','127.0.0.1'].includes(new URL(origin).hostname),'Loopback isolated harness only');
assert.equal((await readdir(out).catch(e=>{if(e.code==='ENOENT')return[];throw e;})).length,0,'OUTPUT_ALREADY_EXISTS');await mkdir(out,{recursive:true});
const engine=options.engine||'chromium',seconds=Number(options.seconds||12);assert(['chromium','webkit'].includes(engine));assert(seconds>=5&&seconds<=60);
const hash=data=>createHash('sha256').update(data).digest('hex'),sourcePaths=['tests/run-tower-motion-probe.mjs','tests/run-tower-motion-analysis.mjs','tests/run-tower-motion-review.mjs','scripts/android-game-actions.mjs','arena/run/scene.mjs','arena/run/presentation.mjs','arena/towerlink/tower-scene.js','arena/towerlink/presentation-clock.mjs','arena/towerlink/troop-presentation.mjs','arena/towerlink/assets/v2/manifest.json'];
const report={schema:'run-tower-actual-draw-review-v1',build_id:buildId,harness_report:resolve(options['harness-report']),arena_tree_sha256:harness.builds.arena.tree_sha256,scope:'Separate instrumented desktop mobile-viewport diagnostic on copied production build. GL uploads and Canvas draw submissions are real; compositor presentation, phone performance and unhooked FRAME timing are not measured.',physical_device:false,automatic_performance_acceptance:false,engine,seconds,source_sha256:Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,hash(await readFile(path))]))),samples:[],cleanup:{}};
const artifactFiles=new Map(harness.builds.arena.files.map(f=>[f.path,f])),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label,limit=45000){const end=Date.now()+limit;while(Date.now()<end){if(await check())return;await sleep(80);}throw Error('Timeout: '+label);}
let browser;
try{
 browser=await(engine==='webkit'?webkit.launch({headless:true}):chromium.launch({channel:'chrome',headless:true,args:process.platform==='darwin'?['--use-angle=metal']:[]}));report.browser_version=browser.version();
 for(const game of ['run','towerlink']){
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});await context.addInitScript(installRunTowerMotionProbe);
  const page=await context.newPage(),state={token:null,room:null,playerId:null,rooms:new Set()},tasks=new Set(),sample={game,errors:[],runtime_bundles:[],input:game==='run'?'trusted touch tap':'trusted browser mouse route drag',cleanup:false};report.samples.push(sample);
  page.on('pageerror',e=>sample.errors.push(e.message));
  page.on('response',response=>{const task=(async()=>{
   const u=new URL(response.url());if(u.origin!==origin||!response.ok())return;
   if(u.pathname==='/v1/launch/exchange'){const b=await response.json();state.token=b.access_token;state.playerId=b.external_user_id;}
   else if(u.pathname.startsWith('/api/pvp/rooms')){const b=await response.json(),r=b.room||b;if(r.id&&r.game_id===game){if(!state.room||state.room.id!==r.id||Number(r.version)>=Number(state.room.version))state.room=r;if(response.request().method()==='POST'&&u.pathname==='/api/pvp/rooms'){assert(r.practice===true&&r.entry_minor==='0');state.rooms.add(r.id);}}}
   else if(u.pathname.startsWith('/arena/')&&u.pathname.endsWith('.js')){const bytes=await response.body(),file=artifactFiles.get(u.pathname.slice(7)),sha256=hash(bytes);assert(file&&file.sha256===sha256,'SERVED_BUNDLE_MISMATCH: '+u.pathname);sample.runtime_bundles.push({path:u.pathname,sha256,bytes:bytes.length});}
  })().catch(e=>sample.errors.push(e.message)).finally(()=>tasks.delete(task));tasks.add(task);});
  try{
   await page.goto(origin+'/demo/native/'+game,{waitUntil:'domcontentloaded'});await until(()=>state.token&&page.frames().some(f=>f.url()===origin+'/play/'+game),'launch');
   const frame=page.frames().find(f=>f.url()===origin+'/play/'+game);await frame.locator('.lobby-settings').waitFor();await frame.getByRole('button',{name:'免费练习',exact:false}).tap();await frame.getByRole('button',{name:'确认规则 · 准备开局',exact:true}).tap();await until(()=>state.room?.status==='active','active practice');
   if(game==='run')await frame.waitForFunction(()=>document.querySelector('[data-testid="run-track"]')?.dataset.ready==='true');else await frame.locator('.tl-world-canvas').waitFor();
   await frame.evaluate(()=>window.__actualMotion.begin());sample.action=await playOneArenaAction(frame,game,()=>state.room,{touch:true,timeoutMs:15000});await sleep(seconds*1000);
   const raw=await frame.evaluate(()=>{window.__actualMotion.end();return window.__actualMotion.read();});await writeFile(resolve(out,game+'-raw.json'),JSON.stringify(raw,null,2)+'\n');
   const analysis=game==='run'?analyseRunMotion(raw):analyseTowerMotion(raw);await writeFile(resolve(out,game+'-analysis.json'),JSON.stringify(analysis,null,2)+'\n');
   sample.motion_status=analysis.status;sample.raw=game+'-raw.json';sample.analysis=game+'-analysis.json';sample.dropped=raw.dropped;sample.probe_errors=raw.errors;await page.screenshot({path:resolve(out,game+'.png')});
  }catch(e){sample.error=e.stack;}
  finally{
   try{for(const id of state.rooms){const headers={authorization:'Bearer '+state.token,origin,'content-type':'application/json'},read=async()=>{const response=await page.request.get(origin+'/api/pvp/rooms/'+id,{headers});assert(response.ok());const b=await response.json();return b.room||b;},released=r=>['settled','cancelled','voided'].includes(r.status)||r.players?.some(p=>p.external_user_id===state.playerId&&p.forfeited);let room=await read();assert(room.practice===true&&room.entry_minor==='0');if(!released(room)){const response=await page.request.post(origin+'/api/pvp/rooms/'+id+'/leave',{headers,data:{request_id:'motion_cleanup_'+randomUUID().replaceAll('-','')}});assert(response.ok());await until(async()=>released(await read()),'owned practice released',15000);} }sample.cleanup=true;}catch(e){sample.cleanup_error=e.message;}
   await context.close();await Promise.allSettled([...tasks]);sample.browser_context_closed=true;
  }
 }
}catch(e){report.error=e.stack;}
finally{await browser?.close();report.cleanup.browser_closed=true;report.finished_at=new Date().toISOString();report.capture_complete=report.samples.length===2&&report.samples.every(s=>!s.error&&!s.errors.length&&s.cleanup&&!s.probe_errors?.length&&!s.dropped&&s.motion_status==='motion-observed');await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output:out,capture_complete:report.capture_complete,samples:report.samples.map(s=>({game:s.game,motion_status:s.motion_status,error:s.error,cleanup:s.cleanup}))}));}
if(!report.capture_complete)process.exitCode=1;
