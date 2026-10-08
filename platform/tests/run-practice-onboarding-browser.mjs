/** Actual built Arena + WebGL, actual room routes/worker/PostgreSQL on loopback.
 * Launch authentication is a fixture. This is not a phone or public FPS test. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {chromium} from 'playwright';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';

const root=resolve(new URL('..',import.meta.url).pathname),stamp=new Date().toISOString().replaceAll(':','-')+'-'+randomBytes(3).toString('hex');
const out=resolve(root,'review/run-practice-onboarding/browser',stamp);await mkdir(out,{recursive:true});
const name='oasis_pvp_test_'+process.pid+'_'+randomBytes(8).toString('hex');
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres'),dbUrl=new URL(adminUrl);dbUrl.pathname='/'+name;
if(!['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname))throw Error('LOCAL_POSTGRES_REQUIRED');
const admin=new pg.Pool({connectionString:adminUrl.toString(),max:2});
let created=false,localDir,pool,closePools,routePvp,runPracticeCourseCapability,closeEnginePool,server,browser,origin,world,page,frame;
const timers=new Set(),serverErrors=[],report={schema:'run-practice-onboarding-browser-v1',startedAt:new Date().toISOString(),scope:'Built Arena/RunGame, actual WebGL scene and resources, actual transactional room route/worker/PostgreSQL, isolated loopback fixture launch authentication. Headless Chromium with software GPU; no physical phone, public network, FPS, production admission or payment acceptance claim.',checks:[],errors:[],output:out};
const sources=['arena/main.jsx','arena/run/RunGame.jsx','arena/run/useRunPractice.jsx','arena/run/scene.mjs','arena/run/practice-controller.mjs','arena/run/practice-input-transport.mjs','arena/run/practice-fall-help.mjs','arena/run/practice-course-contract.mjs','arena/run/PracticeCourses.jsx','server/pvp/run-course-policy.mjs','tests/run-practice-onboarding-browser.mjs'];
async function hashes(){return Object.fromEntries(await Promise.all(sources.map(async p=>[p,createHash('sha256').update(await readFile(resolve(root,p))).digest('hex')])));}
const uid=prefix=>prefix+'_'+randomBytes(8).toString('hex');
function json(res,status,value){if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}
function later(fn,ms){const id=setTimeout(()=>{timers.delete(id);fn();},ms);timers.add(id);}
function session(){return{game_id:'run',external_user_id:'human',scope:{app_id:world.session.app_id},active_room_id:world.restoreRoomId||null,balance:{balance:{available_minor:'0'}},run_practice_input_protocol:'run-practice-inputs-v1',...(world.capability?{run_practice_courses:runPracticeCourseCapability()}:{})};}
async function reset(){world={session:{app_id:uid('practice_browser'),external_user_id:'human',game_id:'run'},posts:[],rooms:[],delayNext:0,dropNext:false,decisions:[],capability:true,locale:'zh',stripConfirmation:false};await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[world.session.app_id,'practice browser fixture','fixture','sandbox','fixture','https://no-wallet.invalid','["run"]']);}
async function serve(req,res){try{
 const path=new URL(req.url,'http://fixture').pathname;
 if(path==='/favicon.ico'){res.writeHead(204);return res.end();}
 if(path==='/sdk.mjs'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(await readFile(resolve(root,'public/sdk/oasis-h5.mjs')));}
 if(path==='/host'){res.writeHead(200,{'content-type':'text/html'});return res.end('<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#mount{height:100dvh}</style><div id="mount"></div><script type="module">import{OasisHost}from"/sdk.mjs";window.qa={returns:[]};window.qaSDK=new OasisHost({platformOrigin:location.origin,gameId:"run",requestLaunch:async()=>({entry_url:location.origin+"/play/run",launch_code:"fixture-launch-code",session_id:"fixture-session"}),onEvent:e=>{if(e.type==="return_requested")qa.returns.push(e)}});qaSDK.mount("#mount");</script>');}
 if(path==='/v1/launch/exchange')return json(res,200,{access_token:'isolated-fixture-token',session_id:'fixture-session',game_id:'run',host_origin:origin});
 if(path==='/api/arena/session')return json(res,200,session());
 if(path.startsWith('/api/pvp/')){
  assert.equal(req.headers.authorization,'Bearer isolated-fixture-token');let raw='';for await(const c of req)raw+=c;
  const body=raw?JSON.parse(raw):{},entry={path,body,at:performance.now()};if(req.method==='POST')world.posts.push(entry);
  if(path.endsWith('/inputs')&&world.authRejectNext){world.authRejectNext=false;entry.authRejected=true;return json(res,401,{error:{code:'SESSION_EXPIRED',message:'Fixture requires renewed authorization'}});}
  const result=await routePvp(world.session,req.method,path,body,{now:Date.now()});
  if(result.body?.id&&!world.rooms.includes(result.body.id))world.rooms.push(result.body.id);
  if(path.endsWith('/inputs')){
   entry.decisions=result.body.run_inputs.decisions;entry.processedAt=performance.now();world.decisions.push(...entry.decisions);
   if(world.dropNext){world.dropNext=false;entry.dropped=true;return res.destroy();}
   if(world.delayNext){const wait=world.delayNext;world.delayNext=0;return later(()=>{entry.deliveredAt=performance.now();json(res,result.status,result.body);},wait);}
  }
  entry.deliveredAt=performance.now();if(world.stripConfirmation&&result.body?.run_course)delete result.body.run_course;return json(res,result.status,result.body);
 }
 if(path==='/play/run'||path.startsWith('/arena/')){
  const relative=path==='/play/run'?'index.html':path.slice('/arena/'.length),file=resolve(root,'arena/dist',relative);
  assert(file.startsWith(resolve(root,'arena/dist')+'/'));
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.glb':'model/gltf-binary','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.ogg':'audio/ogg','.mp3':'audio/mpeg'};
  res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream'});return res.end(await readFile(file));
 }
 throw Error('Unexpected fixture request '+req.method+' '+path);
 }catch(error){serverErrors.push({code:error.code,message:error.message,path:req.url});json(res,error.status||500,{error:{code:error.code,message:error.message}});}}

async function open({width=390,height=844,locale='zh',capability=true,stripConfirmation=false}={}){
 await reset();Object.assign(world,{locale,capability,stripConfirmation});
 page=await browser.newPage({viewport:{width,height},isMobile:true,hasTouch:true});page.setDefaultTimeout(15000);
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.addInitScript(locale=>{sessionStorage.setItem('oasis:run:frame-trace:v1','1');if(location.pathname==='/play/run')history.replaceState(null,'','/play/run?locale='+locale);},locale);
 page.on('pageerror',error=>report.errors.push(error.message));
 await page.goto(origin+'/host');await page.waitForFunction(()=>qaSDK?.loaded);
 frame=page.frames().find(f=>new URL(f.url()).pathname==='/play/run');
 await frame.getByRole('button',{name:'免费练习',exact:false}).waitFor();
}
async function layout(label,selector){
 if(selector==='select'||selector==='.ready-card')await frame.locator(selector).scrollIntoViewIfNeeded();
 const handle=await frame.waitForFunction(sel=>{const target=document.querySelector(sel);if(!target)return false;const box=target.getBoundingClientRect();return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,box:{x:box.x,y:box.y,width:box.width,height:box.height},viewportHeight:innerHeight};},selector);const metrics=await handle.jsonValue();await handle.dispose();
 assert(metrics.scrollWidth<=metrics.width+1,'No horizontal page overflow');assert(metrics.box.x>=0&&metrics.box.x+metrics.box.width<=metrics.width+1);
 if(selector==='select')assert(metrics.box.height>=44,'Touch selection target at least 44px');
 await page.screenshot({path:resolve(out,label+'.png')});report.checks.push({label,metrics});
}
async function create(course){
 if(course)await frame.locator('#run-practice-course').selectOption(course);
 await frame.getByRole('button',{name:'免费练习',exact:false}).tap();
 await frame.getByRole('button',{name:'确认规则 · 准备开局',exact:false}).waitFor();
 return world.posts.find(p=>p.path==='/api/pvp/rooms').body;
}
async function closeCase(){
 await page?.close();page=null;
 for(const id of world.rooms){const r=(await pool.query('SELECT status FROM pvp_rooms WHERE id=$1',[id])).rows[0];if(['active','waiting'].includes(r?.status))await routePvp(world.session,'POST',`/api/pvp/rooms/${id}/leave`,{request_id:uid('cleanup')},{now:Date.now()});}
}
try{
 report.sourceBefore=await hashes();await admin.query(`CREATE DATABASE "${name}"`);created=true;
 localDir=await mkdtemp(join(tmpdir(),'oasis-onboarding-browser-'));process.env.OASIS_DATABASE_URL=dbUrl.toString();process.env.OASIS_LOCAL_DIR=localDir;
 ({pool,closePools}=await import('../server/db.mjs'));await(await import('../server/platform.mjs')).migratePlatform();const pvp=await import('../server/pvp/index.mjs');await pvp.migratePvp();({routePvp}=pvp);({closeEnginePool}=await import('../server/pvp/engine-pool.mjs'));
 ({runPracticeCourseCapability}=await import('../server/pvp/run-course-policy.mjs'));
 server=createServer(serve);await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 report.launch={channel:'chrome',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']};
 browser=await chromium.launch(report.launch);
 await open({width:320,height:568});await frame.locator('#run-practice-course').waitFor();
 assert.equal(await frame.locator('#run-practice-course').inputValue(),'sunrise-arches');assert.equal(await frame.locator('#run-practice-course option').count(),6);
 await layout('narrow-picker','select');assert.equal((await create()).run_course_id,'sunrise-arches');
 assert.match(await frame.getByTestId('run-course-confirmed').innerText(),/晨光拱廊.*1\/3/);await layout('narrow-confirmed','.ready-card');
 assert.equal(await frame.getByRole('button',{name:'确认规则 · 准备开局',exact:false}).isEnabled(),true);
 world.restoreRoomId=world.rooms[0];await page.reload();await page.waitForFunction(()=>qaSDK?.loaded);frame=page.frames().find(f=>new URL(f.url()).pathname==='/play/run');
 await frame.getByTestId('run-course-confirmed').waitFor();await frame.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.includes('确认规则')&&!b.disabled));assert.match(await frame.getByTestId('run-course-confirmed').innerText(),/晨光拱廊/);assert.equal(await frame.getByRole('button',{name:'确认规则 · 准备开局',exact:false}).isEnabled(),true);report.checks.push({label:'refresh restores waiting room course confirmation from server metadata'});await closeCase();

 await open();await create('rapid-bridges');assert.match(await frame.getByTestId('run-course-confirmed').innerText(),/急流连桥.*3\/3/);
 await frame.getByRole('button',{name:'确认规则 · 准备开局',exact:false}).tap();
 await frame.waitForFunction(()=>document.querySelector('[data-testid="run-scene"]')?.dataset.inputReady==='true');
 await frame.evaluate(()=>{window.onboardingTouches=[];for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,e=>{if(e.target.closest?.('[data-testid="run-jump"]')){window.onboardingTouches.push({type,trusted:e.isTrusted,at:performance.now(),disabled:document.querySelector('[data-testid="run-jump"]').disabled,distance:document.querySelector('.run-progress b').textContent});if(window.onboardingTouches.length>24)window.onboardingTouches.shift();}},true);});
 await frame.getByTestId('run-practice-hint').waitFor({state:'visible',timeout:25000});
 assert.equal(world.posts.some(p=>p.path.endsWith('/inputs')),false,'Help must not generate any input');
 assert.equal(await frame.getByTestId('run-jump').isEnabled(),true);await layout('committed-fall-help','[data-testid="run-practice-hint"]');
 // Observe the displayed recovery window; do not alter disabled state or call
 // the controller. The only input is an ordinary touch on the visible button.
 const button=await frame.getByTestId('run-jump').boundingBox();assert(button);
 await frame.waitForFunction(()=>{const label=document.querySelector('.run-progress b'),jump=document.querySelector('[data-testid="run-jump"]');const distance=parseInt(label?.textContent,10);return jump&&!jump.disabled&&distance>=35&&distance<36;},{},{timeout:8000});
 await page.touchscreen.tap(button.x+button.width/2,button.y+button.height/2);
 report.jumpTouches=await frame.evaluate(()=>window.onboardingTouches);
 await frame.waitForFunction(()=>parseInt(document.querySelector('.run-progress b')?.textContent,10)>=44,{},{timeout:5000});
 const input=world.posts.find(p=>p.path.endsWith('/inputs'));assert(input);assert.equal(input.decisions[0].outcome,'accepted');assert.equal(input.body.commands[0].type,'jump');
 const live=(await routePvp(world.session,'GET','/api/pvp/rooms/'+world.rooms[0],{},{now:Date.now()})).body;
 assert(live.game.players.find(p=>p.key==='human').distance>41);assert.equal(live.game.players.find(p=>p.key==='human').fallUntilTick,null);
 assert.equal(await frame.getByTestId('run-practice-hint').count(),0);report.checks.push({label:'actual committed falls show help; one legal touch crosses first gap',course:live.game.courseId,accepted:input.decisions[0].outcome,authorityDistance:live.game.players.find(p=>p.key==='human').distance});
 await closeCase();

 await open({width:412,height:915,locale:'ar'});await frame.locator('#run-practice-course').waitFor();await layout('arabic-picker','select');await create('canal-crossing');await layout('arabic-confirmed','.ready-card');await closeCase();
 await open({capability:false});assert.equal(await frame.getByTestId('run-practice-courses').count(),0);assert.equal((await create()).run_course_id,undefined);report.checks.push({label:'no capability means no course picker or explicit course request'});await closeCase();
 await open({stripConfirmation:true});await create('rapid-bridges');assert.equal(await frame.getByRole('button',{name:'确认规则 · 准备开局',exact:false}).isDisabled(),true);
 assert.match(await frame.getByRole('alert').innerText(),/服务端尚未确认/);assert.equal(world.posts.some(p=>p.path.endsWith('/ready')),false);report.checks.push({label:'missing server confirmation blocks ready and never claims chosen course'});await closeCase();
 assert.deepEqual(serverErrors,[]);assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;process.exitCode=1;if(page){await page.screenshot({path:resolve(out,'failure.png')}).catch(()=>{});report.failurePosts=world.posts;report.failureTouches=await frame?.evaluate(()=>window.onboardingTouches).catch(()=>null);report.failureTrace=await frame?.evaluate(()=>document.querySelector('[data-testid="run-track"]')?.__oasisRunFrameTrace?.read()).catch(()=>null);}}
finally{
 await page?.close();await browser?.close();for(const timer of timers)clearTimeout(timer);server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));
 await closeEnginePool?.();await closePools?.();if(created)await dropOwnedTestDatabase(admin,name,{created});await admin.end();if(localDir)await rm(localDir,{recursive:true,force:true});
 report.cleanup={browserClosed:true,serverClosed:true,ownedDatabaseRemoved:created,localDirectoryRemoved:!!localDir};
 report.serverErrors=serverErrors;report.sourceAfter=await hashes();report.sourceUnchanged=JSON.stringify(report.sourceBefore)===JSON.stringify(report.sourceAfter);if(!report.sourceUnchanged){report.passed=false;process.exitCode=1;}
 report.finishedAt=new Date().toISOString();await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output:out,passed:report.passed,checks:report.checks.length,failure:report.failure,errors:report.errors,serverErrors,sourceUnchanged:report.sourceUnchanged},null,2));
}
