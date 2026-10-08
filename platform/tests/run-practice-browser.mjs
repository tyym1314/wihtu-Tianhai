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
const out=resolve(root,'review/run-practice-browser',stamp);await mkdir(out,{recursive:true});
const name='oasis_pvp_test_'+process.pid+'_'+randomBytes(8).toString('hex');
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres'),dbUrl=new URL(adminUrl);dbUrl.pathname='/'+name;
const admin=new pg.Pool({connectionString:adminUrl.toString(),max:2});
let created=false,localDir,pool,closePools,routePvp,closeEnginePool,server,browser,origin,world;
const timers=new Set(),serverErrors=[],report={schema:'run-practice-browser-v1',startedAt:new Date().toISOString(),scope:'Built Arena/RunGame, actual WebGL scene and resources, actual transactional room route/worker/PostgreSQL, isolated loopback fixture launch authentication. Headless Chromium with software GPU; no physical phone, public network, FPS, production admission or payment acceptance claim.',checks:[],errors:[],output:out};
const sources=['arena/main.jsx','arena/run/RunGame.jsx','arena/run/useRunPractice.jsx','arena/run/scene.mjs','arena/run/practice-controller.mjs','arena/run/practice-input-transport.mjs','tests/run-practice-browser.mjs'];
async function hashes(){return Object.fromEntries(await Promise.all(sources.map(async p=>[p,createHash('sha256').update(await readFile(resolve(root,p))).digest('hex')])));}
const uid=prefix=>prefix+'_'+randomBytes(8).toString('hex');
function json(res,status,value){if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}
function later(fn,ms){const id=setTimeout(()=>{timers.delete(id);fn();},ms);timers.add(id);}
function session(){return{game_id:'run',external_user_id:'human',scope:{app_id:world.session.app_id},active_room_id:null,balance:{balance:{available_minor:'0'}},run_practice_input_protocol:'run-practice-inputs-v1'};}
async function reset(){world={session:{app_id:uid('practice_browser'),external_user_id:'human',game_id:'run'},posts:[],rooms:[],delayNext:0,dropNext:false,decisions:[]};await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[world.session.app_id,'practice browser fixture','fixture','sandbox','fixture','https://no-wallet.invalid','["run"]']);}
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
  entry.deliveredAt=performance.now();return json(res,result.status,result.body);
 }
 if(path==='/play/run'||path.startsWith('/arena/')){
  const relative=path==='/play/run'?'index.html':path.slice('/arena/'.length),file=resolve(root,'arena/dist',relative);
  assert(file.startsWith(resolve(root,'arena/dist')+'/'));
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.glb':'model/gltf-binary','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.ogg':'audio/ogg','.mp3':'audio/mpeg'};
  res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream'});return res.end(await readFile(file));
 }
 throw Error('Unexpected fixture request '+req.method+' '+path);
 }catch(error){serverErrors.push({code:error.code,message:error.message,path:req.url});json(res,error.status||500,{error:{code:error.code,message:error.message}});}}
const waitUntil=async predicate=>{const until=performance.now()+8000;while(!predicate()){assert(performance.now()<until,'Fixture event timed out');await new Promise(r=>setTimeout(r,20));}};
let page,frame;
async function open(){
 await reset();page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(15000);
 await page.addInitScript(()=>sessionStorage.setItem('oasis:run:frame-trace:v1','1'));
 page.on('pageerror',error=>report.errors.push(error.message));
 await page.goto(origin+'/host');await page.waitForFunction(()=>qaSDK?.loaded);frame=page.frames().find(f=>f.url()===origin+'/play/run');
 await frame.getByRole('button',{name:'免费练习',exact:false}).tap();
 await frame.getByRole('button',{name:'确认规则 · 准备开局',exact:false}).tap();
 await frame.waitForFunction(()=>document.querySelector('[data-testid="run-scene"]')?.dataset.inputReady==='true');
 assert.equal(world.posts.find(p=>p.path==='/api/pvp/rooms').body.run_input_protocol,'run-practice-inputs-v1');
 assert(world.posts.some(p=>p.path.endsWith('/scene-ready')),'Rendered arming scene must acknowledge readiness');
 const trace=await readTrace();assert.equal(trace.presentationModel,'run-practice-v1');assert(trace.practiceState?.headTick>=0);
}
const readTrace=async()=>frame.evaluate(()=>document.querySelector('[data-testid="run-track"]').__oasisRunFrameTrace.read());
async function closeCase(label){
 const trace=await readTrace();await writeFile(resolve(out,`trace-${report.checks.length+1}.json`),JSON.stringify(trace));
 await page.screenshot({path:resolve(out,`scene-${report.checks.length+1}.png`)});
 report.checks.push({label,posts:structuredClone(world.posts),controller:trace.practiceState});
 await page.close();page=null;
 for(const id of world.rooms){const row=(await pool.query('SELECT status FROM pvp_rooms WHERE id=$1',[id])).rows[0];if(row?.status==='active')await routePvp(world.session,'POST',`/api/pvp/rooms/${id}/leave`,{request_id:uid('cleanup')},{now:Date.now()});}
}
try{
 report.sourceBefore=await hashes();await admin.query(`CREATE DATABASE "${name}"`);created=true;
 localDir=await mkdtemp(join(tmpdir(),'oasis-practice-browser-'));process.env.OASIS_DATABASE_URL=dbUrl.toString();process.env.OASIS_LOCAL_DIR=localDir;
 ({pool,closePools}=await import('../server/db.mjs'));await(await import('../server/platform.mjs')).migratePlatform();const pvp=await import('../server/pvp/index.mjs');await pvp.migratePvp();({routePvp}=pvp);({closeEnginePool}=await import('../server/pvp/engine-pool.mjs'));
 server=createServer(serve);await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 await open();world.delayNext=1300;
 await frame.getByTestId('run-right').tap();await waitUntil(()=>world.posts.some(p=>p.path.endsWith('/inputs')));
 await page.waitForTimeout(130);await frame.getByTestId('run-jump').tap();
 await waitUntil(()=>world.posts.filter(p=>p.path.endsWith('/inputs')).length>=2);
 let inputs=world.posts.filter(p=>p.path.endsWith('/inputs'));assert.equal(inputs[0].deliveredAt,undefined,'Second gesture must precede the first ACK');
 assert.equal(inputs[1].body.commands.length,2);assert.equal(inputs[1].body.commands[0].commandSeq,inputs[0].body.commands[0].commandSeq);
 await waitUntil(()=>inputs[0].deliveredAt!==undefined);
 await frame.waitForFunction(()=>document.querySelector('[data-testid="run-track"]').__oasisRunFrameTrace.read().practiceState.outbox.pendingCommands.length===0);
 inputs=world.posts.filter(p=>p.path.endsWith('/inputs'));assert.equal(inputs.length,2,'No duplicate request flood while the prefix was covered');
 assert.equal((await pool.query('SELECT count(*) FROM pvp_run_input_decisions WHERE room_id=$1',[world.rooms[0]])).rows[0].count,'2');
 await closeCase('Real WebGL arming, explicit capability, immediate second touch before first ACK, overlapping exact receipts');

 await open();world.dropNext=true;await frame.getByTestId('run-right').tap();
 await waitUntil(()=>world.posts.filter(p=>p.path.endsWith('/inputs')).length>=2);
 inputs=world.posts.filter(p=>p.path.endsWith('/inputs'));assert.deepEqual(inputs[0].body,inputs[1].body,'Lost ACK retries original request and executeTick');
 await frame.waitForFunction(()=>document.querySelector('[data-testid="run-track"]').__oasisRunFrameTrace.read().practiceState.outbox.pendingCommands.length===0);
 assert.equal((await pool.query('SELECT count(*) FROM pvp_run_input_decisions WHERE room_id=$1',[world.rooms[0]])).rows[0].count,'1');
 await frame.getByRole('button',{name:'退出比赛',exact:true}).tap();const inputCount=world.posts.filter(p=>p.path.endsWith('/inputs')).length;
 await frame.locator('body').press('ArrowUp');await page.waitForTimeout(180);assert.equal(world.posts.filter(p=>p.path.endsWith('/inputs')).length,inputCount,'Exit modal must block keyboard input');
 await closeCase('Lost ACK retries identical request with one durable decision; exit dialog blocks keyboard');
 await open();world.authRejectNext=true;await frame.getByTestId('run-right').tap();
 await waitUntil(()=>world.posts.filter(p=>p.path.endsWith('/inputs')).length>=2);
 inputs=world.posts.filter(p=>p.path.endsWith('/inputs'));assert(inputs[0].authRejected);assert.deepEqual(inputs[0].body,inputs[1].body);
 await frame.waitForFunction(()=>document.querySelector('[data-testid="run-track"]').__oasisRunFrameTrace.read().practiceState.outbox.pendingCommands.length===0);
 assert.equal((await pool.query('SELECT count(*) FROM pvp_run_input_decisions WHERE room_id=$1',[world.rooms[0]])).rows[0].count,'1');
 await closeCase('Real host reauthorization after 401 retains controller sequence and retries exact original request');
 assert.deepEqual(serverErrors,[]);assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;process.exitCode=1;if(page){await page.screenshot({path:resolve(out,'failure.png')}).catch(()=>{});report.failureTrace=await readTrace().catch(()=>null);report.failurePosts=world.posts;}}
finally{
 await page?.close();await browser?.close();for(const timer of timers)clearTimeout(timer);server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));
 await closeEnginePool?.();await closePools?.();if(created)await dropOwnedTestDatabase(admin,name,{created});await admin.end();if(localDir)await rm(localDir,{recursive:true,force:true});
 report.serverErrors=serverErrors;report.sourceAfter=await hashes();report.sourceUnchanged=JSON.stringify(report.sourceBefore)===JSON.stringify(report.sourceAfter);if(!report.sourceUnchanged){report.passed=false;process.exitCode=1;}
 report.finishedAt=new Date().toISOString();await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output:out,passed:report.passed,checks:report.checks.length,failure:report.failure,errors:report.errors,serverErrors,sourceUnchanged:report.sourceUnchanged},null,2));
}
