/** Local HTTP/PostgreSQL benchmark. Never uses the platform database or live API. */
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,mkdir,rm,chmod} from 'node:fs/promises';
import {tmpdir,cpus,totalmem,platform,arch,release} from 'node:os';
import {resolve} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import pg from 'pg';

const root=resolve(import.meta.dirname,'..');
const output=resolve(root,'review/phase-f/concurrency.json');
const dbname=`oasis_phase_f_bench_${process.pid}_${randomBytes(5).toString('hex')}`;
const adminURL=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
if(!['127.0.0.1','localhost','[::1]'].includes(adminURL.hostname))throw Error('LOCAL_POSTGRES_REQUIRED');
adminURL.pathname='/postgres';
const databaseURL=new URL(adminURL);databaseURL.pathname='/'+dbname;
const admin=new pg.Pool({connectionString:adminURL.href,max:1});
const report={schema_version:1,started_at:new Date().toISOString(),kind:'local-development-concurrency',
  scope:'Real loopback HTTP and isolated PostgreSQL, free practice only; no browser renderer, device, remote network or production capacity claim.',
  command:'node scripts/benchmark-phase-f.mjs',
  machine:{platform:platform(),release:release(),arch:arch(),node:process.version,cpu_model:cpus()[0]?.model,logical_cpus:cpus().length,memory_gib:Math.round(totalmem()/2**30)},
  isolation:{temporary_database:dbname,listen_host:'127.0.0.1',main_database_or_services_used:false,private_directory:true},
  workload:{apps:12,rooms:12,run_rooms:6,bowling_rooms:6,run_capacity:4,bowling_capacity:2,real_users_per_room:1,remaining_seats:'explicit server BOT practice clients',entry_minor:'0',target_stages:[12,24],stage_duration_ms:7000,poll_min_interval_ms:400,action_min_interval_ms:2000,request_timeout_ms:15000,model:'Closed-loop polling: 12 or 24 GET workers across the same 12 rooms, at most one action producer per room. The 24-worker stage has two poll streams per user, not 24 independent users. Latency can reduce offered load.'},
  setup:{},stages:[],cleanup:{child_stopped:false,database_dropped:false,private_directory_removed:false},completed:false,
  limitations:['Short local sample; percentiles are descriptive and are not a capacity/SLA guarantee.','Sequential stages reuse ongoing rooms, so physics phases and action timings differ; stage percentiles are not a scaling curve.','One Node API process, local PostgreSQL and load generator share this computer. Other workstation processes are not controlled.','Free practice exercises room snapshots, locks, persistence and authoritative actions; no reserve/capture/settlement or external wallet network load.','Bowling rigid-body simulation runs synchronously in the API process and can delay unrelated Run requests. A production worker pool and longer device/network/load tests remain required.','No actual mobile rendering, WebView, packet loss, inter-region latency, connection churn or production deployment is tested.']};
let privateDir,db,child,api,cookie,createdDB=false,childExited=false,logs='',inFlight=0,maxInFlight=0;
const rooms=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const rid=()=>`bench_${randomUUID().replaceAll('-','')}`;
function problem(code){const e=new Error(code);e.code=code;return e;}
function assert(ok,code){if(!ok)throw problem(code);}
function adopt(client,data){const room=data?.room||data;if(!room?.id)return;client.seq=Math.max(client.seq||0,room.me_last_seq||0);if(!client.room||room.version>=client.room.version)client.room=room;}
async function freePort(){const s=createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function request(path,body,headers={},method=body===undefined?'GET':'POST'){
 const start=performance.now();let status=0,data=null,bytes=0,error=null;
 inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
 try{const response=await fetch(api+path,{method,headers:{origin:api,...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});status=response.status;const raw=await response.text();bytes=Buffer.byteLength(raw);try{data=JSON.parse(raw);}catch{error='NON_JSON_RESPONSE';}return{status,data,headers:response.headers,bytes,error,latency_ms:performance.now()-start};}
 catch(e){error=e.name==='TimeoutError'?'REQUEST_TIMEOUT':e.name==='AbortError'?'ABORTED':'NETWORK_ERROR';return{status,data,bytes,error,latency_ms:performance.now()-start};}
 finally{inFlight--;}
}
function expect(response,status,operation){if(response.status!==status||response.error)throw problem(`${operation}:${response.status}:${response.error||response.data?.error?.code||response.data?.code||'FAILED'}`);return response.data;}
function auth(client){return{authorization:'Bearer '+client.token};}
function stats(samples){const sorted=samples.map(v=>v.latency_ms).sort((a,b)=>a-b),percent=q=>sorted.length?Number(sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*q)-1)].toFixed(2)):null;
 const status_counts={},error_codes={};for(const s of samples){status_counts[s.status]=(status_counts[s.status]||0)+1;if(s.error_code)error_codes[s.error_code]=(error_codes[s.error_code]||0)+1;}
 return{count:samples.length,http_errors:samples.filter(s=>s.status<200||s.status>=300).length,room_fault_snapshots:samples.filter(s=>s.room_fault).length,successes:samples.filter(s=>s.status>=200&&s.status<300&&!s.error_code).length,errors:samples.filter(s=>s.status<200||s.status>=300||s.error_code).length,expected_rule_rejections:samples.filter(s=>s.expected_rule_rejection).length,status_counts,error_codes,p50_ms:percent(.5),p95_ms:percent(.95),max_ms:percent(1),response_bytes_total:samples.reduce((n,s)=>n+s.bytes,0),response_bytes_max:Math.max(0,...samples.map(s=>s.bytes))};}
function logSample(samples,client,kind,response,start,worker){const error_code=response.error||response.data?.error?.code||(response.status>=400?response.data?.code||'HTTP_ERROR':null);samples.push({game:client.game,kind,status:response.status,latency_ms:response.latency_ms,bytes:response.bytes,error_code,room_fault:(response.data?.room||response.data)?.status==='fault',expected_rule_rejection:kind==='action'&&['BUSY','ALREADY_JUMPING','SLIDING','INPUT_PENDING','RATE_LIMIT','NOT_ACTIVE'].includes(error_code),started_ms:Math.round(start),worker});}
function normalAction(client){const r=client.room,g=r?.game;if(r?.status!=='active'||g?.status!=='active')return null;
 if(client.game==='bowling'){const p=g.me;return p&&!p.completed&&!p.forfeited&&!p.busyUntil&&p.shotDeadlineAt?{type:'roll',offset:0,angle:0,power:.78,spin:0}:null;}
 const p=g.players.find(p=>p.key===r.me),tick=g.snapshotTick;if(!p||p.forfeited||p.finishTick!==null||p.fallUntilTick!==null||p.stunUntilTick>tick||p.y!==0||p.sliding||p.inputNo!==p.appliedInputNo)return null;return{type:'jump'};
}
async function stage(concurrency){const start=performance.now(),deadline=start+7000,samples=[];maxInFlight=0;
 await Promise.all(Array.from({length:concurrency},async(_,worker)=>{const client=rooms[worker%rooms.length];while(performance.now()<deadline){const cycle=performance.now(),response=await request('/api/pvp/rooms/'+client.room.id,undefined,auth(client));logSample(samples,client,'poll',response,cycle-start,worker);if(response.status===200)adopt(client,response.data);
   if(worker<rooms.length&&performance.now()<deadline&&performance.now()>=client.nextActionAt){const action=normalAction(client);if(action){client.nextActionAt=performance.now()+2000;const body={request_id:rid(),seq:client.seq+1,action},at=performance.now(),a=await request('/api/pvp/rooms/'+client.room.id+'/action',body,auth(client));logSample(samples,client,'action',a,at-start,worker);if(a.status===200)adopt(client,a.data);else if(a.error||a.status>=500){/* Preserve the exact action identity on uncertain completion. */const retry=await request('/api/pvp/rooms/'+client.room.id+'/action',body,auth(client));logSample(samples,client,'action_retry',retry,performance.now()-start-retry.latency_ms,worker);if(retry.status===200)adopt(client,retry.data);}}}
   await delay(Math.max(0,400-(performance.now()-cycle)));
 }}));
 const elapsed=performance.now()-start;
 return{concurrent_poll_workers:concurrency,observed_max_http_in_flight:maxInFlight,scheduled_duration_ms:7000,elapsed_including_in_flight_drain_ms:Math.round(elapsed),completed_requests_per_second:Number((samples.length*1000/elapsed).toFixed(2)),all:stats(samples),poll:stats(samples.filter(s=>s.kind==='poll')),action:stats(samples.filter(s=>s.kind!=='poll')),by_game:Object.fromEntries(['run','bowling'].map(game=>[game,{poll:stats(samples.filter(s=>s.game===game&&s.kind==='poll')),action:stats(samples.filter(s=>s.game===game&&s.kind!=='poll'))}])),slowest_requests:samples.toSorted((a,b)=>b.latency_ms-a.latency_ms).slice(0,10).map(s=>({...s,latency_ms:Number(s.latency_ms.toFixed(2))})),samples};
}
async function cleanup(){
 if(child&&!childExited){const exit=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await Promise.race([exit,delay(3000)]);if(!childExited){child.kill('SIGKILL');await Promise.race([exit,delay(2000)]);}}
 report.cleanup.child_stopped=!child||childExited;
 if(db)await db.end();
 if(createdDB){assert(/^oasis_phase_f_bench_\d+_[a-f0-9]{10}$/.test(dbname),'UNSAFE_DATABASE_NAME');await admin.query(`DROP DATABASE IF EXISTS ${dbname} WITH (FORCE)`);report.cleanup.database_dropped=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[dbname])).rowCount===0;}else report.cleanup.database_dropped=true;
 await admin.end();if(privateDir){await rm(privateDir,{recursive:true,force:true});report.cleanup.private_directory_removed=true;}
}
try{
 try{const prior=JSON.parse(await readFile(output,'utf8'));const {previous_runs,...compact}=prior;compact.stages=compact.stages.map(({samples,...stage})=>stage);report.previous_runs=[...(previous_runs||[]),compact].slice(-3);}catch(e){if(e.code!=='ENOENT')throw e;}
 const setupStart=performance.now();privateDir=await mkdtemp(resolve(tmpdir(),'oasis-phase-f-bench-'));await chmod(privateDir,0o700);
 await admin.query(`CREATE DATABASE ${dbname}`);createdDB=true;db=new pg.Pool({connectionString:databaseURL.href,max:2});
 assert((await db.query('SELECT current_database() AS name')).rows[0].name===dbname,'ISOLATION_FAILED');
 const apiPort=await freePort();let walletPort=await freePort();while(walletPort===apiPort)walletPort=await freePort();api=`http://127.0.0.1:${apiPort}`;
 report.isolation.api_port=apiPort;report.isolation.wallet_port=walletPort;
 report.source_sha256={};for(const file of ['server/index.mjs','server/db.mjs','server/pvp/index.mjs','arena/run/engine.mjs','arena/bowling/engine.mjs','arena/bowling/physics.mjs'])report.source_sha256[file]=createHash('sha256').update(await readFile(resolve(root,file))).digest('hex');
 child=spawn(process.execPath,['--import','tsx','server/index.mjs'],{cwd:root,env:{...process.env,OASIS_DATABASE_URL:databaseURL.href,OASIS_LOCAL_DIR:privateDir,OASIS_API_PORT:String(apiPort),OASIS_WALLET_PORT:String(walletPort),OASIS_REFERENCE_WALLET_URL:`http://127.0.0.1:${walletPort}`,OASIS_WALLET_ALLOWED_ORIGINS:`http://127.0.0.1:${walletPort}`,OASIS_PUBLIC_ORIGIN:api,OASIS_START_WALLET:'1'},stdio:['ignore','pipe','pipe']});
 child.once('exit',()=>childExited=true);child.on('error',()=>{childExited=true;});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{logs=(logs+b.toString()).slice(-12000);});
 let ready=false;for(let i=0;i<200;i++){if(childExited)throw problem('CHILD_EXITED_DURING_STARTUP');try{const r=await fetch(api+'/health',{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}await delay(100);}assert(ready,'CHILD_START_TIMEOUT');
 const adminCredentials=JSON.parse(await readFile(resolve(privateDir,'development-credentials.json'),'utf8'));
 const login=await request('/api/admin/login',{username:adminCredentials.username,password:adminCredentials.password});expect(login,200,'ADMIN_LOGIN');cookie=login.headers.get('set-cookie')?.split(';')[0];assert(cookie,'COOKIE_REQUIRED');
 for(let i=0;i<12;i++){
  const created=expect(await request('/api/admin/apps',{name:`Phase F benchmark ${i+1}`},{cookie}),201,'APP_CREATE');
  const game=i%2?'bowling':'run',launch=expect(await request(`/api/admin/apps/${created.app.id}/launch`,{game_id:game,external_user_id:'demo_player'},{cookie}),200,'LAUNCH');
  const exchange=expect(await request('/v1/launch/exchange',{launch_code:launch.launch_code,client_instance_id:rid(),host_origin:api,game_id:game}),200,'EXCHANGE');
  const client={appId:created.app.id,game,token:exchange.access_token,seq:0,nextActionAt:0};
  adopt(client,expect(await request('/api/pvp/rooms',{request_id:rid(),game_id:game,capacity:game==='run'?4:2,entry_minor:'0',practice:true},auth(client)),201,'ROOM_CREATE'));rooms.push(client);
 }
 await Promise.all(rooms.map(async client=>adopt(client,expect(await request(`/api/pvp/rooms/${client.room.id}/ready`,{request_id:rid()},auth(client)),200,'ROOM_READY'))));
 // A ready response can still say funding: the normal server tick starts free games.
 const activeDeadline=performance.now()+10000;while(rooms.some(c=>c.room.status!=='active')&&performance.now()<activeDeadline){await Promise.all(rooms.map(async c=>adopt(c,expect(await request('/api/pvp/rooms/'+c.room.id,undefined,auth(c)),200,'ROOM_ACTIVE'))));await delay(100);}
 assert(rooms.every(c=>c.room.status==='active'),'ROOMS_NOT_ACTIVE');report.setup={duration_ms:Math.round(performance.now()-setupStart),apps_created_via_admin_http:12,launches_exchanged:12,active_free_rooms:12};
 for(const concurrency of [12,24])report.stages.push(await stage(concurrency));
 const appIds=rooms.map(c=>c.appId);
 report.database_evidence={rooms:(await db.query("SELECT game_id,practice,status,error->>'code' AS error_code,count(*)::int AS count,min(entry_minor)::text AS min_entry_minor,max(entry_minor)::text AS max_entry_minor FROM pvp_rooms WHERE app_id=ANY($1) GROUP BY game_id,practice,status,error->>'code' ORDER BY game_id,status",[appIds])).rows,accepted_actions:(await db.query('SELECT r.game_id,count(*)::int AS count FROM pvp_actions a JOIN pvp_rooms r ON r.id=a.room_id WHERE r.app_id=ANY($1) GROUP BY r.game_id ORDER BY r.game_id',[appIds])).rows,platform_probability_operations:(await db.query('SELECT count(*)::int AS n FROM gp_operations WHERE app_id=ANY($1)',[appIds])).rows[0].n,platform_pvp_wallet_operations:(await db.query('SELECT count(*)::int AS n FROM pvp_operations WHERE app_id=ANY($1)',[appIds])).rows[0].n,wallet_operations:(await db.query('SELECT count(*)::int AS n FROM wallet_operations o JOIN wallet_scopes s ON s.scope_id=o.scope_id WHERE s.app_id=ANY($1)',[appIds])).rows[0].n};
 assert(report.database_evidence.platform_probability_operations===0&&report.database_evidence.platform_pvp_wallet_operations===0&&report.database_evidence.wallet_operations===0,'UNEXPECTED_MONEY_OPERATION');
 assert(['run','bowling'].every(g=>report.database_evidence.accepted_actions.some(r=>r.game_id===g&&r.count>0)),'NORMAL_ACTIONS_NOT_EXERCISED');
 const leaves=await Promise.all(rooms.map(c=>request('/api/pvp/rooms/'+c.room.id+'/leave',{request_id:rid()},auth(c))));report.cleanup.practice_leave_http_statuses=leaves.map(r=>r.status);
 report.cleanup.remaining_active_test_users=(await db.query('SELECT count(*)::int AS n FROM pvp_active_users WHERE app_id=ANY($1)',[appIds])).rows[0].n;
 report.completed=true;report.evaluation={unexpected_error_responses:report.stages.reduce((n,s)=>n+s.all.errors-s.all.expected_rule_rejections,0),faulted_rooms:report.database_evidence.rooms.filter(r=>r.status==='fault').reduce((n,r)=>n+r.count,0),note:'completed means the measurement and verification ran, not that performance or reliability passed.'};report.evaluation.no_observed_errors=report.evaluation.unexpected_error_responses===0&&report.evaluation.faulted_rooms===0;if(!report.evaluation.no_observed_errors)process.exitCode=1;
}catch(e){report.failure={code:e.code||'BENCHMARK_FAILED',message:e.code||'Benchmark failed; private logs were withheld to avoid disclosing credentials.'};process.exitCode=1;}
finally{
 try{await cleanup();}catch(e){report.cleanup.error_code=e.code||'CLEANUP_FAILED';process.exitCode=1;}
 report.finished_at=new Date().toISOString();report.server_diagnostics={error_lines:logs.split('\n').filter(l=>/^\[(platform|arena recovery|recovery|integration recovery)\]/.test(l)).map(l=>l.replace(/[^a-zA-Z0-9 _:[\]-]/g,'?').slice(0,160)),raw_child_logs_published:false};
 await mkdir(resolve(root,'review/phase-f'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({report:'review/phase-f/concurrency.json',completed:report.completed,failure:report.failure?.code,stages:report.stages.map(s=>({workers:s.concurrent_poll_workers,requests:s.all.count,p95_ms:s.all.p95_ms,max_ms:s.all.max_ms,errors:s.all.errors})),cleanup:report.cleanup}));
}
