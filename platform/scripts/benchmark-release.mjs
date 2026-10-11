/** Isolated multi-tenant release load probe; never targets a deployed API. */
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,mkdir,rm,lstat,readdir} from 'node:fs/promises';
import {tmpdir,cpus,totalmem} from 'node:os';
import {resolve,dirname} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {signedHeaders} from '../specs/examples/sdk-node.mjs';
import {workloadCompleted,evaluateMobileCapacity} from './benchmark-evaluation.mjs';
import {BENCHMARK_ARENA_GAMES,BENCHMARK_PROBABILITY_GAMES,BENCHMARK_GAMES,planArenaGroups,benchmarkAction} from './benchmark-workload.mjs';

/** Keep the first cause, including asynchronous child errors, through cleanup. */
export function rememberBenchmarkFailure(report,error,stage){
 const row={code:String(error?.code||error?.message||'BENCHMARK_FAILED').slice(0,512),message:String(error?.message||error||'BENCHMARK_FAILED').slice(0,2048),stage,at_ms:Date.now()};
 report.failure??=row;return row;
}

/** Observes only this spawned child. A send callback is required even after a
 * connected check: the channel can close between the check and the send. */
export function createBenchmarkChildMonitor(child,{onFailure=()=>{},onEvent=()=>{},logLimitBytes=65536,eventLimit=128}={}){
 const runtime={pid:child.pid??null,event_limit:eventLimit,events:[],events_dropped:0,stdout:{bytes_seen:0},stderr:{bytes_seen:0}};
 const tails={stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)},pending=new Set(),ownedSignals=new Set();let expectedStop=false,phase='startup',closed=false,exitResolve,closeResolve;
 const exited=new Promise(resolve=>{exitResolve=resolve;}),closedPromise=new Promise(resolve=>{closeResolve=resolve;});
 const event=(kind,values={})=>{const row={kind,at_ms:Date.now(),phase,...values};if(runtime.events.length<eventLimit){runtime.events.push(row);onEvent(row);}else runtime.events_dropped++;return row;};
 const errorRow=error=>({code:String(error?.code||'CHILD_PROCESS_ERROR').slice(0,512),message:String(error?.message||error).slice(0,2048),stack:String(error?.stack||'').slice(0,4096)});
 const failure=(error,stage)=>{runtime.failure??={...errorRow(error),stage,at_ms:Date.now()};onFailure(error,stage);};
 const failed=(code,message=code)=>Object.assign(new Error(message),{code});
 const rejectPending=error=>{for(const wait of [...pending])wait.finish(error);};
 const ownedExit=(code,signal)=>expectedStop&&(code===0&&ownedSignals.size>0||Boolean(signal&&ownedSignals.has(signal)));
 for(const name of ['stdout','stderr']){
  child[name]?.on('data',chunk=>{const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);runtime[name].bytes_seen+=bytes.length;tails[name]=Buffer.from(Buffer.concat([tails[name],bytes]).subarray(-logLimitBytes));});
  child[name]?.on('error',error=>{event(name+'-error',errorRow(error));failure(error,'child-'+name);rejectPending(error);});
 }
 child.on('error',error=>{event('error',errorRow(error));failure(error,'child-error');rejectPending(error);});
 child.on('disconnect',()=>{runtime.disconnect=event('disconnect');const error=failed('ERR_IPC_CHANNEL_CLOSED');if(!expectedStop)failure(error,'child-disconnect');rejectPending(error);});
 child.on('exit',(code,signal)=>{runtime.exit=event('exit',{code,signal});exitResolve(runtime.exit);const error=failed('SERVER_CHILD_EXITED');if(!ownedExit(code,signal))failure(error,'child-exit');rejectPending(error);});
 child.on('close',(code,signal)=>{closed=true;runtime.close=event('close',{code,signal});closeResolve(runtime.close);exitResolve(runtime.exit??runtime.close);const error=failed('SERVER_CHILD_CLOSED');if(!ownedExit(code,signal))failure(error,'child-close');rejectPending(error);});
 child.on('message',message=>{for(const wait of [...pending])if(message?.type===wait.responseType)wait.finish(null,message);});
 return {runtime,exited,closed:closedPromise,setPhase:value=>{phase=value;},expectStop:()=>{expectedStop=true;phase='cleanup';event('owned-stop-requested');},stopSignal:(signal,sent)=>{if(sent)ownedSignals.add(signal);event('owned-stop-signal',{signal,sent});},
  logs:()=>Object.fromEntries(['stdout','stderr'].map(name=>[name,{bytes:Buffer.from(tails[name]),bytes_seen:runtime[name].bytes_seen}])),
  measurement(type,{timeoutMs=5000}={}){
   const responseType=type==='measure-start'?'measure-started':type==='measure-stop'?'measure-summary':null;
   if(!responseType)throw Error('INVALID_MEASUREMENT_MESSAGE');
   return new Promise((resolve,reject)=>{
    let timer,settled=false;const wait={responseType,finish:(error,message)=>{if(settled)return;settled=true;clearTimeout(timer);pending.delete(wait);if(error){failure(error,type);reject(error);}else resolve(message);}};
    pending.add(wait);timer=setTimeout(()=>{const error=failed(type==='measure-start'?'OBSERVER_START_TIMEOUT':'OBSERVER_STOP_TIMEOUT');event('measurement-timeout',{type,timeout_ms:timeoutMs});wait.finish(error);},timeoutMs);
    if(closed||child.exitCode!==null||child.signalCode||child.connected!==true){event('send-refused',{type});wait.finish(failed('ERR_IPC_CHANNEL_CLOSED'));return;}
    event('send',{type});
    try{child.send({type},error=>{if(error){event('send-error',{type,...errorRow(error)});wait.finish(error);}});}catch(error){event('send-throw',{type,...errorRow(error)});wait.finish(error);}
   });
  },
 };
}

/** Bounded original stream tails stay beside the report, outside the removed
 * temporary server directory. Stream failures cannot suppress the report. */
export async function persistBenchmarkRuntime(monitor,output,report){
 if(!monitor)return;report.server_runtime=monitor.runtime;
 for(const [name,log]of Object.entries(monitor.logs())){
  const path=output+'.server-'+name+'.log',row=monitor.runtime[name];Object.assign(row,{path,bytes_retained:log.bytes.length,truncated:log.bytes_seen>log.bytes.length,sha256:createHash('sha256').update(log.bytes).digest('hex')});
  try{await mkdir(dirname(path),{recursive:true});await writeFile(path,log.bytes,{mode:0o600});row.persisted=true;}
  catch(error){row.persisted=false;row.persistence_error=rememberBenchmarkFailure(report,error,'persist-child-'+name);}
 }
}

export async function persistBenchmarkReport(report,output){
 try{await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});return true;}
 catch(error){const row=rememberBenchmarkFailure(report,error,'persist-report');report.report_persistence_errors??=[];if(report.report_persistence_errors.length<128)report.report_persistence_errors.push({...row,path:output});else report.report_persistence_errors_dropped=(report.report_persistence_errors_dropped||0)+1;return false;}
}

export function createBenchmarkCheckpointQueue(report,output,{onFailure=()=>{}}={}){
 let pending=Promise.resolve();return {save(){
  pending=pending.then(async()=>{const snapshot={...report,completed:false,diagnostic_only:true,diagnostic_saved_at_ms:Date.now()};
   if(!await persistBenchmarkReport(snapshot,output)){report.failure??=snapshot.failure;report.report_persistence_errors??=snapshot.report_persistence_errors;onFailure(snapshot.failure);}
  }).catch(error=>{rememberBenchmarkFailure(report,error,'diagnostic-checkpoint');onFailure(error);});return pending;
 },drain:()=>pending};
}

export async function benchmarkDirectoryIdentity(path){
 const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw Object.assign(Error('PRIVATE_DIRECTORY_NOT_OWN_DIRECTORY'),{code:'PRIVATE_DIRECTORY_NOT_OWN_DIRECTORY'});
 return {path:resolve(path),dev:stat.dev,ino:stat.ino,uid:stat.uid,gid:stat.gid,mode:stat.mode};
}

export async function assertBenchmarkDirectoryIdentity(path,identity){
 const actual=await benchmarkDirectoryIdentity(path);
 if(!identity||identity.path!==resolve(path)||dirname(resolve(path))!==resolve(tmpdir())||!resolve(path).startsWith(resolve(tmpdir(),'oasis-release-bench-'))||['dev','ino','uid','gid','mode'].some(key=>actual[key]!==identity[key]))throw Object.assign(Error('PRIVATE_DIRECTORY_IDENTITY_CHANGED'),{code:'PRIVATE_DIRECTORY_IDENTITY_CHANGED'});
 return actual;
}

export async function removeBenchmarkDirectory(path,identity){
 await assertBenchmarkDirectoryIdentity(path,identity);
 await rm(path,{recursive:true,force:false});
 try{await lstat(path);throw Object.assign(Error('PRIVATE_DIRECTORY_REMAINS'),{code:'PRIVATE_DIRECTORY_REMAINS'});}catch(error){if(error.code!=='ENOENT')throw error;}
}

export async function snapshotBenchmarkDirectory(path,identity){
 await assertBenchmarkDirectoryIdentity(path,identity);const names=(await readdir(path)).sort(),files=[];
 for(const name of names.slice(0,128)){
  const file=resolve(path,name),stat=await lstat(file),entry={name,dev:stat.dev,ino:stat.ino,uid:stat.uid,gid:stat.gid,mode:stat.mode,bytes:stat.size,mtime_ms:stat.mtimeMs,type:stat.isSymbolicLink()?'symlink':stat.isFile()?'file':stat.isDirectory()?'directory':'other'};
  if(stat.isFile()&&stat.size<=4*1024*1024)entry.sha256=createHash('sha256').update(await readFile(file)).digest('hex');
  files.push(entry);
 }
 return {identity,files,entries_seen:names.length,entries_limit:128,truncated:names.length>128};
}

export async function cleanupBenchmarkResources({child,monitor,db,admin,createdDB,dbname,privateDir,privateDirIdentity,report,stopTimeoutMs=15000}){
 const errors=[];report.cleanup??={};
 const step=async(stage,run)=>{try{await run();}catch(error){errors.push(rememberBenchmarkFailure(report,error,stage));}};
 const wait=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('OWN_CHILD_STOP_TIMEOUT'),{code:'OWN_CHILD_STOP_TIMEOUT'})),stopTimeoutMs);})]);}finally{clearTimeout(timer);}};
 await step('cleanup-server',async()=>{
  if(child&&child.exitCode===null&&!child.signalCode&&Number.isInteger(child.pid)){
   monitor.expectStop();monitor.stopSignal('SIGTERM',child.kill('SIGTERM'));try{await wait(monitor.closed);}catch(error){monitor.stopSignal('SIGKILL',child.kill('SIGKILL'));await wait(monitor.closed);}
  }else if(child&&!monitor.runtime.close)await wait(monitor.closed);
 });
 report.cleanup.server_stopped=!child||child.exitCode!==null||Boolean(child.signalCode)||Boolean(!child.pid&&monitor?.runtime.close);
 await step('cleanup-db-pool',async()=>db?.end());
 await step('cleanup-database',async()=>{if(createdDB){
  if(!/^oasis_release_bench_\d+_[a-f0-9]{10}$/.test(dbname))throw Object.assign(Error('UNSAFE_DB_NAME'),{code:'UNSAFE_DB_NAME'});
  await admin.query(`DROP DATABASE "${dbname}" WITH (FORCE)`);report.cleanup.database_dropped=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[dbname])).rowCount===0;
 }});
 await step('cleanup-admin-pool',async()=>admin.end());
 await step('cleanup-private-directory-evidence',async()=>{if(privateDir)report.cleanup.private_directory_before_remove=await snapshotBenchmarkDirectory(privateDir,privateDirIdentity);});
 await step('cleanup-private-directory',async()=>{if(privateDir){
  if(!report.cleanup.server_stopped)throw Object.assign(Error('PRIVATE_DIRECTORY_RETAINED_FOR_RUNNING_CHILD'),{code:'PRIVATE_DIRECTORY_RETAINED_FOR_RUNNING_CHILD'});
  await removeBenchmarkDirectory(privateDir,privateDirIdentity);report.cleanup.private_directory_removed=true;
 }});
 if(errors.length){report.cleanup.errors=errors;report.cleanup.error=errors[0].code;return false;}return true;
}

export async function runBenchmarkRelease(){
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--duration-seconds','--users','--output','--poll-ms','--client-rates','--renew-after-seconds'].includes(args[i])||!args[i+1])throw Error('Usage: node scripts/benchmark-release.mjs --duration-seconds 900 --users 100 --client-rates 1 --output review/release/load.json; client-rates selects Run150/others500ms fixed stress slots, not browser replay');options[args[i]]=args[i+1];}
const duration=Number(options['--duration-seconds']||60),userCount=Number(options['--users']||100),pollMs=Number(options['--poll-ms']||400),clientRates=options['--client-rates']==='1',renewAfter=options['--renew-after-seconds']?Number(options['--renew-after-seconds']):null;
if(renewAfter!==null&&(!Number.isInteger(renewAfter)||renewAfter<1||renewAfter>870))throw Error('renew-after-seconds must be 1..870; test-only early renewal, server TTL is unchanged');
if(!Number.isInteger(duration)||duration<5||duration>1800||!Number.isInteger(userCount)||userCount<100||userCount>400||userCount%20||!Number.isInteger(pollMs)||pollMs<150||pollMs>2000||options['--client-rates']&&!['0','1'].includes(options['--client-rates'])||clientRates&&options['--poll-ms'])throw Error('Require duration 5..1800s; users100..400 in multiples of20; poll150..2000ms OR client-rates1 (Run150ms, others500ms)');
const gamePollMs=Object.fromEntries(BENCHMARK_GAMES.map(game=>[game,clientRates?(game==='run'?150:500):pollMs]));
const root=resolve(import.meta.dirname,'..'),output=resolve(root,options['--output']||'review/release/load.json');
const dbname=`oasis_release_bench_${process.pid}_${randomBytes(5).toString('hex')}`;
const adminURL=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
if(!['127.0.0.1','localhost','[::1]'].includes(adminURL.hostname))throw Error('LOCAL_POSTGRES_REQUIRED');adminURL.pathname='/postgres';
const databaseURL=new URL(adminURL);databaseURL.pathname='/'+dbname;
const admin=new pg.Pool({connectionString:adminURL.href,max:1}),clients=[],groups=[],apps=[],metrics=new Map(),inflight=new Set(),telemetry=[];
const rid=()=>`load_${randomUUID().replaceAll('-','')}`,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={schema_version:2,started_at:new Date().toISOString(),kind:'isolated-release-load',completed:false,
 scope:'Thirteen-game fixed-slot stress workload using independent synthetic human accounts over real HTTP, PostgreSQL and reference-wallet test coins; no server BOT seats. Not an exact browser workload, physical-device, real partner-wallet, or regional network acceptance.',
 workload:{users:userCount,partners:4,apps:4,pvp_users:userCount*.8,probability_users:userCount*.2,games:BENCHMARK_GAMES,pvp_capacity_by_game:Object.fromEntries(BENCHMARK_ARENA_GAMES.map(game=>[game,game==='jackaroo'?4:2])),pvp_entry_minor:'1000',towerlink_mode:'paid-duel',run_scene_ready:'synthetic protocol acknowledgement without browser rendering',duration_seconds:duration,poll_ms:clientRates?null:pollMs,client_rates:clientRates,interval_preset:clientRates?'arena-intervals-fixed-slots':'uniform-fixed-slots',game_poll_ms:gamePollMs,offered_poll_slots_per_second:null,probability_spin_interval_ms:5000,session_renewal:{mode:'resume same session before expiry',advance_seconds:30,test_early_after_seconds:renewAfter},model:'Fixed wall-clock per-user polling slots. Poll and action share one in-flight client task, so action waits drop poll slots. The browser serializes GETs with cadence measured from request start and polls independently of actions; funding also has a bounded fast cadence. Busy users, scheduler lateness and room recreation drops are reported explicitly.'},
 machine:{node:process.version,cpu:cpus()[0]?.model,logical_cpus:cpus().length,memory_gib:Math.round(totalmem()/2**30)},
 isolation:{database:dbname,listen_host:'127.0.0.1',public_services_used:false},schedule:{offered:0,dispatched:0,skipped_busy:0,skipped_late:0,skipped_room_restart:0,action_opportunities:0,actions_legal:0,max_lateness_ms:0},cleanup:{},session_renewal:{count:0,during_measurement:0,by_game:{},same_session_id:true,users_renewed:0},limitations:['All 13 released games receive real HTTP actions or spins from public server-issued state; this is a synthetic fixed-slot protocol workload, not human skill or complete-play acceptance.','Run scene-ready is a synthetic protocol acknowledgement without a rendered WebGL frame and cannot validate launch fairness on devices.','Fixed offered slots differ from the browser serial GET scheduler; synthetic action waits suppress polls unlike the browser independent action/poll loops. Funding acceleration is not replayed.','Dispatch ratio is a property of this stress model, not a standalone hardware-capacity or exact-browser-concurrency measurement.','Load generator, API and PostgreSQL share this machine.','No production-wallet, browser rendering or regional-network claim.','No injected network faults in this load run; recovery fault tests are separate.']};
report.harness_execution=import.meta.benchmarkDiagnostic??{mode:'direct',entry_url:import.meta.url};
let db,privateDir,privateDirIdentity,child,childMonitor,api,cookie,createdDB=false,measuring=false,provisionWallet,unseal,readWalletSnapshot,stopping=false;
const checkpointPath=output+'.diagnostic.json';report.diagnostic_checkpoint={path:checkpointPath,scope:'Incomplete diagnostic only; cannot satisfy capacity acceptance'};
const checkpoints=createBenchmarkCheckpointQueue(report,checkpointPath,{onFailure:()=>{stopping=true;process.exitCode=1;}}),queueCheckpoint=()=>checkpoints.save();
function assert(ok,code){if(!ok)throw Object.assign(new Error(code),{code});}
async function freePort(){const s=createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});const port=s.address().port;await new Promise(r=>s.close(r));return port;}
function record(game,kind,r){
 if(!measuring)return;const key=game+':'+kind;let m=metrics.get(key);if(!m){m={game,kind,count:0,latencies:[],statuses:{},codes:{},error_status_codes:{},bytes:0};metrics.set(key,m);}
 m.count++;m.latencies.push(r.ms);m.statuses[r.status]=(m.statuses[r.status]||0)+1;m.bytes+=r.bytes;const code=r.error||r.body?.error?.code||r.body?.code;if(r.status>=400||r.status===0){m.codes[code||'HTTP_ERROR']=(m.codes[code||'HTTP_ERROR']||0)+1;const pair=r.status+':'+(code||'HTTP_ERROR');m.error_status_codes[pair]=(m.error_status_codes[pair]||0)+1;}
}
async function request(path,body,headers={},kind='setup',game='platform'){
 const at=performance.now();let result;
 try{const res=await fetch(api+path,{method:body===undefined?'GET':'POST',headers:{origin:api,'content-type':'application/json',...headers,'x-oasis-benchmark-game':game},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)}),text=await res.text();let parsed;try{parsed=JSON.parse(text);}catch{parsed={error:{code:'NON_JSON'}};}result={status:res.status,body:parsed,headers:res.headers,bytes:Buffer.byteLength(text),ms:performance.now()-at};}
 catch(e){result={status:0,error:e.name==='TimeoutError'?'REQUEST_TIMEOUT':'NETWORK_ERROR',body:null,bytes:0,ms:performance.now()-at};}
 record(game,kind,result);return result;
}
function expect(r,status,label){assert(r.status===status,`${label}:${r.status}:${r.body?.error?.code||r.body?.code||r.error||'FAILED'}`);return r.body;}
const auth=c=>({authorization:'Bearer '+c.token});
function adopt(c,room){if(room?.id&&(!c.room||c.room.id!==room.id||room.version>=c.room.version)){c.room=room;c.seq=room.me_last_seq||0;}}
async function launch(c){
 const previousSessionId=c.sessionId;
 const app=apps[c.tenant],body={...app.scope,request_id:rid(),external_user_id:c.userId,game_id:c.game,locale:'en',host_platform:'web',host_origin:api,...(previousSessionId?{resume_session_id:previousSessionId}:{})};
 const headers=signedHeaders({keyId:app.credentials.key_id,secretBase64:app.credentials.secret_base64,method:'POST',path:'/v1/sessions',rawBody:JSON.stringify(body),requestId:body.request_id});
 const created=expect(await request('/v1/sessions',body,headers,previousSessionId?'renew_session':'create_session',c.game),201,'CREATE_SESSION');
 const exchanged=expect(await request('/v1/launch/exchange',{launch_code:created.launch_code,client_instance_id:rid(),host_origin:api,game_id:c.game},{},previousSessionId?'renew':'launch',c.game),200,'EXCHANGE');
 assert(!previousSessionId||exchanged.session_id===previousSessionId,'RENEW_CHANGED_SESSION');
 assert(Number.isFinite(Number(exchanged.expires_in))&&Number(exchanged.expires_in)>30,'INVALID_TOKEN_TTL');
 c.token=exchanged.access_token;c.sessionId=exchanged.session_id;c.refreshAt=performance.now()+Math.min(Number(exchanged.expires_in)-30,renewAfter??Infinity)*1000;
 if(previousSessionId){report.session_renewal.count++;if(measuring)report.session_renewal.during_measurement++;report.session_renewal.by_game[c.game]=(report.session_renewal.by_game[c.game]||0)+1;if(!c.renewed){c.renewed=true;report.session_renewal.users_renewed++;}}
}
async function ensureSession(c){if(performance.now()>=c.refreshAt)await launch(c);}
async function startRoom(group,claimed=false){
 if(group.restarting&&!claimed)return;group.restarting=true;
 try{
  for(const c of group.clients){await ensureSession(c);c.room=null;c.seq=0;c.pendingAction=null;}
  const lead=group.clients[0],created=expect(await request('/api/pvp/rooms',{request_id:rid(),game_id:lead.game,capacity:group.capacity,entry_minor:'1000',practice:false},auth(lead),'create',lead.game),201,'ROOM_CREATE');group.roomId=created.id;adopt(lead,created);
  for(const c of group.clients.slice(1))adopt(c,expect(await request(`/api/pvp/rooms/${created.code}/join`,{request_id:rid()},auth(c),'join',c.game),200,'ROOM_JOIN'));
  for(const c of group.clients)adopt(c,expect(await request(`/api/pvp/rooms/${created.id}/ready`,{request_id:rid()},auth(c),'ready',c.game),200,'ROOM_READY'));
  if(lead.game==='run')await armRunGroup(group);
  group.rounds=(group.rounds||0)+1;
 }finally{group.restarting=false;}
}
async function armRunGroup(group){
 const deadline=Date.now()+25000;
 while(Date.now()<deadline){
  const lead=group.clients[0],snapshot=expect(await request(`/api/pvp/rooms/${group.roomId}`,undefined,auth(lead),'poll',lead.game),200,'RUN_WAIT_ACTIVE');adopt(lead,snapshot);
  if(snapshot.status==='active'&&['countdown','racing','finish-window'].includes(snapshot.game?.phase))return;
  if(snapshot.status==='active'&&snapshot.game?.phase==='arming'){
   // This probes the real scene-ready HTTP route under load. No browser is
   // rendered by the generator, so the report explicitly excludes visual proof.
   for(const c of group.clients)adopt(c,expect(await request(`/api/pvp/rooms/${group.roomId}/scene-ready`,{request_id:rid()},auth(c),'scene_ready','run'),200,'RUN_SCENE_READY'));
   return;
  }
  if(['voided','cancelled','fault'].includes(snapshot.status))throw Object.assign(Error('RUN_ARMED_ROOM_TERMINATED'),{code:'RUN_ARMED_ROOM_TERMINATED'});
  await sleep(100);
 }
 throw Object.assign(Error('RUN_SCENE_READY_TIMEOUT'),{code:'RUN_SCENE_READY_TIMEOUT'});
}
async function pollClient(c,at){
 await ensureSession(c);
 if(c.group){
  if(!c.room)return;const r=await request('/api/pvp/rooms/'+c.room.id,undefined,auth(c),'poll',c.game);if(r.status!==200)return;adopt(c,r.body);
  if(['settled','voided','cancelled'].includes(c.room.status)){
   if(c.room.status==='cancelled'||c.room.status==='voided'){report.room_failure={game:c.game,status:c.room.status,code:c.room.error?.code||c.room.result?.reason||'UNEXPECTED_ROOM_TERMINATION'};throw Object.assign(new Error('ROOM_TERMINATED_WITHOUT_PLAY'),{code:'ROOM_TERMINATED_WITHOUT_PLAY'});}
   if(!stopping&&!c.group.restarting){const group=c.group;group.restarting=true;const task=Promise.all(group.clients.filter(p=>p!==c&&p.task).map(p=>p.task)).then(()=>startRoom(group,true)).catch(e=>{report.room_restart_error=e.code||'ROOM_RESTART_FAILED';rememberBenchmarkFailure(report,e,'room-restart');stopping=true;});inflight.add(task);task.finally(()=>inflight.delete(task));}return;
  }
  if(at>=c.nextAction){c.nextAction=at+2000;report.schedule.action_opportunities++;const action=c.pendingAction?.action||benchmarkAction(c.room);if(action){report.schedule.actions_legal++;const body=c.pendingAction||{request_id:rid(),seq:c.seq+1,action};c.pendingAction=body;const response=await request(`/api/pvp/rooms/${c.room.id}/action`,body,auth(c),'action',c.game);if(response.status===200){adopt(c,response.body);c.pendingAction=null;}else if(response.status>0&&response.status<500)c.pendingAction=null;}}
 }else{
  if(c.pendingRound){const ack=await request(`/api/play/${c.game}/ack`,{roundId:c.pendingRound},auth(c),'ack',c.game);if(ack.status===200){c.state=ack.body.session;c.pendingRound=null;}return;}
  const r=await request(`/api/play/${c.game}/session`,undefined,auth(c),'poll',c.game);if(r.status!==200)return;c.state=r.body;
  if(c.state.pendingRound){c.pendingRound=c.state.pendingRound.id;c.pendingSpin=null;return;}
  if(at>=c.nextAction||c.pendingSpin){c.nextAction=at+5000;const body=c.pendingSpin||{requestId:rid(),bet:10,expectedVersion:c.state.stateVersion};c.pendingSpin=body;const spin=await request(`/api/play/${c.game}/spin`,body,auth(c),'spin',c.game);if(spin.status===200){c.state=spin.body.session;c.pendingRound=spin.body.round.id;c.pendingSpin=null;}else if(spin.status>0&&spin.status<500)c.pendingSpin=null;}
 }
}
function summary(m){const sorted=m.latencies.sort((a,b)=>a-b),q=p=>Math.round(sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]*100)/100;const{latencies,...rest}=m;return{...rest,p50_ms:q(.5),p95_ms:q(.95),p99_ms:q(.99),max_ms:q(1)};}
async function cleanup(){
 stopping=true;
 if(!await cleanupBenchmarkResources({child,monitor:childMonitor,db,admin,createdDB,dbname,privateDir,privateDirIdentity,report}))process.exitCode=1;
}
try{
 report.isolation.private_directory_parent=await benchmarkDirectoryIdentity(tmpdir());
 privateDir=await mkdtemp(resolve(tmpdir(),'oasis-release-bench-'));report.isolation.private_directory={path:privateDir};privateDirIdentity=await benchmarkDirectoryIdentity(privateDir);report.isolation.private_directory=privateDirIdentity;await queueCheckpoint();assert(!report.failure,'DIAGNOSTIC_CHECKPOINT_FAILED');
 await admin.query(`CREATE DATABASE "${dbname}"`);createdDB=true;db=new pg.Pool({connectionString:databaseURL.href,max:4});assert((await db.query('SELECT current_database() n')).rows[0].n===dbname,'ISOLATION_FAILED');
 const apiPort=await freePort();let walletPort=await freePort();while(walletPort===apiPort)walletPort=await freePort();api='http://127.0.0.1:'+apiPort;
 report.isolation.api_port=apiPort;report.isolation.wallet_port=walletPort;
 report.source_sha256={};for(const path of ['server/pvp/index.mjs','server/pvp/schema.sql','server/pvp/engine-pool.mjs','server/pvp/engine-worker.mjs','server/db.mjs','server/wallet/index.mjs','server/cycles.mjs','server/index.mjs',...BENCHMARK_ARENA_GAMES.map(game=>`arena/${game}/engine.mjs`),'scripts/benchmark-release.mjs','scripts/benchmark-workload.mjs','scripts/benchmark-observer.mjs','scripts/benchmark-evaluation.mjs'])report.source_sha256[path]=createHash('sha256').update(await readFile(resolve(root,path))).digest('hex');
 const bootstrap="import{installBenchmarkObserver}from'./scripts/benchmark-observer.mjs';installBenchmarkObserver(Number(process.env.OASIS_API_PORT));import{monitorEventLoopDelay}from'node:perf_hooks';const delay=monitorEventLoopDelay({resolution:10});delay.enable();await import('./server/index.mjs');const{enginePoolStats}=await import('./server/pvp/engine-pool.mjs');const{dbPoolStats,walletPool}=await import('./server/db.mjs');const{walletQueueStats}=await import('./server/wallet/index.mjs');setInterval(()=>{process.send?.({type:'metrics',at:Date.now(),memory:process.memoryUsage(),cpu:process.cpuUsage(),event_loop_p95_ms:delay.percentile(95)/1e6,event_loop_max_ms:delay.max/1e6,engine_pool:enginePoolStats(),db_pools:dbPoolStats(),wallet_queue:walletQueueStats(walletPool)});delay.reset();},1000).unref();";
 child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',bootstrap],{cwd:root,env:{...process.env,OASIS_ENVIRONMENT:'sandbox',OASIS_DATABASE_URL:databaseURL.href,OASIS_LOCAL_DIR:privateDir,OASIS_PUBLIC_ORIGIN:api,OASIS_API_PORT:String(apiPort),OASIS_WALLET_PORT:String(walletPort),OASIS_START_WALLET:'1',OASIS_REFERENCE_WALLET_URL:'http://127.0.0.1:'+walletPort,OASIS_WALLET_ALLOWED_ORIGINS:'http://127.0.0.1:'+walletPort,OASIS_TRUST_LOOPBACK_PROXY:'0'},stdio:['ignore','pipe','pipe','ipc']});
 childMonitor=createBenchmarkChildMonitor(child,{onFailure:(error,stage)=>{rememberBenchmarkFailure(report,error,stage);stopping=true;},onEvent:queueCheckpoint});report.server_runtime=childMonitor.runtime;
 child.on('message',m=>{if(m.type==='metrics'&&measuring)telemetry.push(m);});await queueCheckpoint();assert(!report.failure,'SERVER_CHILD_FAILED');
 let ready=false;for(let i=0;i<200;i++){assert(child.exitCode===null,'SERVER_START_FAILED');try{if((await fetch(api+'/health')).ok){ready=true;break;}}catch{}await sleep(100);}assert(ready,'START_TIMEOUT');
 const credentials=JSON.parse(await readFile(resolve(privateDir,'development-credentials.json'),'utf8')),login=await request('/api/admin/login',credentials);expect(login,200,'ADMIN_LOGIN');cookie=login.headers.get('set-cookie').split(';')[0];
 for(let i=0;i<4;i++){
  const username='load_'+randomBytes(8).toString('hex'),password=randomBytes(18).toString('base64url');expect(await request('/api/admin/partner-accounts',{name:'Load partner '+i,username,password},{cookie}),201,'PARTNER');
  const login=await request('/api/partner/login',{username,password});expect(login,200,'PARTNER_LOGIN');const partnerCookie=login.headers.get('set-cookie').split(';')[0];
  const item=expect(await request('/api/partner/apps',{name:'Release load '+i},{cookie:partnerCookie}),201,'APP');item.scope={partner_id:item.app.partner_id,app_id:item.app.id,environment:'sandbox',wallet_scope_id:item.app.wallet_scope_id,currency_id:item.app.currency_id};apps.push(item);
 }
 const groupPlans=planArenaGroups(userCount);
 for(const [i,plan]of groupPlans.entries()){const group={clients:[],tenant:i%4,restarting:false,capacity:plan.capacity};for(let j=0;j<plan.capacity;j++){const c={userId:'load_'+clients.length,tenant:group.tenant,game:plan.game,group,seq:0,nextAction:0};group.clients.push(c);clients.push(c);}groups.push(group);}
 assert(clients.length===userCount*.8,'ARENA_SEAT_ALLOCATION');
 const arenaSeats=clients.length;for(let i=arenaSeats;i<userCount;i++)clients.push({userId:'load_'+i,tenant:i%4,game:BENCHMARK_PROBABILITY_GAMES[(i-arenaSeats)%BENCHMARK_PROBABILITY_GAMES.length],nextAction:0});
 process.env.OASIS_LOCAL_DIR=privateDir;({unseal}=await import('../server/security.mjs'));({provisionWallet,readWalletSnapshot}=await import('../server/wallet/index.mjs'));
 for(let i=0;i<apps.length;i++){const item=apps[i],key=(await db.query("SELECT * FROM gp_keys WHERE app_id=$1 AND direction='platform-to-wallet' AND active",[item.app.id])).rows[0];await provisionWallet(db,{scope:item.scope,key_id:key.id,secret_base64:unseal(key.secret_enc),users:clients.filter(c=>c.tenant===i).map(c=>({external_user_id:c.userId,balance_minor:'100000000'})),treasury_minor:'1000000000000'});}
 for(let i=0;i<clients.length;i+=10)await Promise.all(clients.slice(i,i+10).map(launch));
 for(let i=0;i<groups.length;i+=4)await Promise.all(groups.slice(i,i+4).map(startRoom));
 report.workload.offered_poll_slots_per_second=clients.reduce((n,c)=>n+1000/gamePollMs[c.game],0);
 report.workload.game_users=Object.fromEntries(Object.keys(gamePollMs).map(g=>[g,clients.filter(c=>c.game===g).length]));
 report.setup={independent_users:clients.length,distinct_session_ids:new Set(clients.map(c=>c.sessionId)).size,partners:new Set(apps.map(a=>a.app.partner_id)).size,apps:apps.length,initial_paid_rooms:groups.length,initial_social_rooms:0,initial_room_games:Object.fromEntries(BENCHMARK_ARENA_GAMES.map(game=>[game,groups.filter(g=>g.clients[0].game===game).length]))};
 childMonitor.setPhase('measurement-start');await childMonitor.measurement('measure-start');
 const start=performance.now(),end=start+duration*1000;for(let i=0;i<clients.length;i++){clients[i].pollMs=gamePollMs[clients[i].game];clients[i].nextAt=start+i*clients[i].pollMs/clients.length;clients[i].nextAction=start+(i%10)*250;}
 childMonitor.setPhase('measurement');measuring=true;let nextProgressAt=start+60000;
 while(performance.now()<end&&!stopping){const now=performance.now();for(const c of clients){if(now<c.nextAt)continue;const slots=1+Math.floor((now-c.nextAt)/c.pollMs),scheduled=c.nextAt;c.nextAt+=slots*c.pollMs;report.schedule.offered+=slots;report.schedule.skipped_late+=slots-1;report.schedule.max_lateness_ms=Math.max(report.schedule.max_lateness_ms,now-scheduled);
  if(c.task){report.schedule.skipped_busy++;continue;}if(c.group?.restarting){report.schedule.skipped_room_restart++;continue;}
  report.schedule.dispatched++;const task=pollClient(c,now).catch(e=>{report.client_error=e.code||'CLIENT_FAILED';rememberBenchmarkFailure(report,e,'client-workload');stopping=true;});c.task=task;inflight.add(task);task.finally(()=>{c.task=null;inflight.delete(task);});
 }if(now>=nextProgressAt){nextProgressAt=now+60000;console.log(JSON.stringify({progress_seconds:Math.round((now-start)/1000),http_requests:[...metrics.values()].reduce((n,m)=>n+m.count,0),dispatched_slots:report.schedule.dispatched,session_renewals:report.session_renewal.during_measurement}));}await sleep(10);}
 report.scheduled_duration_ms=performance.now()-start;stopping=true;await Promise.allSettled([...inflight]);report.actual_duration_ms=Math.round(performance.now()-start);measuring=false;
 childMonitor.setPhase('measurement-stop');report.internal_measurements=(await childMonitor.measurement('measure-stop')).result;
 // End liabilities through the same public protocol; no clock/result/ledger
 // fixtures are rewritten to manufacture a clean final balance.
 for(const c of clients)await ensureSession(c);
 for(const group of groups)for(const c of group.clients)if(c.room)await request(`/api/pvp/rooms/${c.room.id}/leave`,{request_id:rid()},auth(c));
 report.presentation_cleanup={acknowledged:0,free_continuations:0,new_paid_spins:0};
 for(const c of clients.filter(c=>!c.group)){
  let finished=false;
  for(let i=0;i<300;i++){
   await ensureSession(c);
   const session=expect(await request(`/api/play/${c.game}/session`,undefined,auth(c)),200,'CLEANUP_SESSION');
   if(session.pendingRound){expect(await request(`/api/play/${c.game}/ack`,{roundId:session.pendingRound.id},auth(c)),200,'CLEANUP_ACK');report.presentation_cleanup.acknowledged++;}
   else if(session.freeSpins>0){
    assert([10,50,100,200,500].includes(session.lockedBet),'CLEANUP_LOCKED_BET');
    const free=expect(await request(`/api/play/${c.game}/spin`,{requestId:rid(),bet:session.lockedBet,expectedVersion:session.stateVersion},auth(c)),200,'CLEANUP_FREE_SPIN');
    if(free.round.isFreeSpin!==true)report.presentation_cleanup.new_paid_spins++;assert(free.round.isFreeSpin===true,'CLEANUP_OPENED_PAID_CYCLE');report.presentation_cleanup.free_continuations++;
   }else{finished=true;break;}
  }
  assert(finished,'PRESENTATION_CLEANUP_LIMIT');
 }

 const appIds=apps.map(a=>a.app.id);for(let i=0;i<60;i++){const unresolved=(await db.query("SELECT(SELECT count(*) FROM pvp_rooms WHERE app_id=ANY($1) AND status NOT IN ('settled','voided','cancelled'))+(SELECT count(*) FROM gp_cycles WHERE app_id=ANY($1) AND status NOT IN ('SETTLED','REJECTED')) AS n",[appIds])).rows[0].n;if(Number(unresolved)===0)break;await sleep(500);}
 const wallets=[];for(const app of apps){const s=await readWalletSnapshot(db,{scope:app.scope});wallets.push({partner_id:app.app.partner_id,users:s.users.length,operations:s.operations.length,ledger_sum:s.ledger.reduce((n,l)=>n+BigInt(l.delta_available)+BigInt(l.delta_reserved),0n).toString(),negative_users:s.users.filter(u=>BigInt(u.available)<0n||BigInt(u.reserved)<0n).length,reserved:s.users.reduce((n,u)=>n+BigInt(u.reserved),0n).toString(),credit_pending:s.users.reduce((n,u)=>n+BigInt(u.credit_pending),0n).toString()});}
 report.database_evidence={wallets,rooms:(await db.query("SELECT game_id,status,practice,entry_minor,count(*)::int n FROM pvp_rooms WHERE app_id=ANY($1) GROUP BY game_id,status,practice,entry_minor",[appIds])).rows,actions:(await db.query('SELECT r.game_id,count(*)::int n FROM pvp_actions a JOIN pvp_rooms r ON r.id=a.room_id WHERE r.app_id=ANY($1) GROUP BY r.game_id',[appIds])).rows,cycles:(await db.query('SELECT game_id,status,count(*)::int n FROM gp_cycles WHERE app_id=ANY($1) GROUP BY game_id,status',[appIds])).rows,bot_seats:(await db.query("SELECT count(*)::int n FROM pvp_rooms r,jsonb_array_elements(r.players) p WHERE r.app_id=ANY($1) AND (p->>'bot')::boolean",[appIds])).rows[0].n,active_users:(await db.query('SELECT count(*)::int n FROM pvp_active_users WHERE app_id=ANY($1)',[appIds])).rows[0].n};
 report.database_evidence.pending_presentations=(await db.query("SELECT count(*)::int n FROM gp_sessions s LEFT JOIN gp_cycles c ON c.id=s.state->>'cycleId' WHERE s.app_id=ANY($1) AND ((s.state->>'pendingPlay') IS NOT NULL OR COALESCE((s.state->>'nextIndex')::int,0)<COALESCE(jsonb_array_length(c.result->'rounds'),0))",[appIds])).rows[0].n;
 assert(report.database_evidence.pending_presentations===0,'PENDING_PRESENTATIONS_REMAIN');
 assert(report.setup.independent_users===userCount&&report.setup.distinct_session_ids===userCount&&report.setup.partners===4,'IDENTITY_COVERAGE');assert(report.database_evidence.bot_seats===0,'UNEXPECTED_BOTS');
 assert(wallets.every(w=>w.ledger_sum==='0'&&w.negative_users===0&&w.reserved==='0'&&w.credit_pending==='0'),'WALLET_INVARIANT');assert(report.database_evidence.active_users===0,'ACTIVE_USERS_REMAIN');
 assert(BENCHMARK_ARENA_GAMES.every(g=>report.database_evidence.actions.some(a=>a.game_id===g&&a.n>0)),'MISSING_REAL_ACTIONS');assert(BENCHMARK_PROBABILITY_GAMES.every(g=>report.database_evidence.cycles.some(a=>a.game_id===g&&a.status==='SETTLED'&&a.n>0)),'MISSING_PROBABILITY_SETTLEMENTS');
 assert(report.database_evidence.rooms.every(r=>['settled','voided','cancelled'].includes(r.status))&&report.database_evidence.cycles.every(c=>['SETTLED','REJECTED'].includes(c.status)),'UNRESOLVED_LIABILITIES');
 report.completed=true;
}catch(e){rememberBenchmarkFailure(report,e,'workload');process.exitCode=1;}
finally{
 try{await cleanup();}catch(e){report.cleanup.error=e.code||'CLEANUP_FAILED';rememberBenchmarkFailure(report,e,'cleanup');process.exitCode=1;}
 try{await persistBenchmarkRuntime(childMonitor,output,report);}catch(e){rememberBenchmarkFailure(report,e,'persist-child-runtime');process.exitCode=1;}
 await checkpoints.drain();
 try{
 report.metrics=[...metrics.values()].map(summary);report.telemetry=telemetry;report.finished_at=new Date().toISOString();
 // A rule-level 409 RATE_LIMIT is an input cooldown; a gateway HTTP 429 is
 // overload/rate rejection and must never be hidden as an expected game rule.
 const expected=new Set(['BUSY','ALREADY_JUMPING','SLIDING','INPUT_PENDING','RATE_LIMIT','NOT_ACTIVE','NOT_YOUR_TURN','TURN_EXPIRED','STALE_INPUT','DEADLINE_PASSED'].map(code=>'409:'+code));
 report.evaluation={unexpected_error_responses:report.metrics.reduce((n,m)=>n+Object.entries(m.error_status_codes).filter(([k])=>!expected.has(k)&&!(m.game==='towerlink'&&k==='403:NOT_YOUR_TOWER')).reduce((n,[,v])=>n+v,0),0),scheduled_slots_completed_ratio:report.schedule.dispatched/Math.max(1,report.schedule.offered),note:'Expected stale-turn and cooldown rule rejections remain visible in per-game metrics; HTTP 429 and unlisted errors are failures. Every arena game uses paid two-human rooms except four-human Jackaroo; probability games use sandbox reference-wallet cycles. Run scene-ready is a synthetic HTTP acknowledgement, not WebGL readiness evidence. Completion requires database-proven accepted actions/spins for all 13 games and a clean ledger. Review skipped slots, per-route percentiles, queue pressure and resource usage before asserting capacity.'};
 report.evaluation.thresholds={minimum_slot_dispatch_ratio:.95,poll_p95_ms:300,poll_p99_ms:1000,action_p95_ms:1500,action_p99_ms:3000};
 if(report.cleanup.error||!['server_stopped','database_dropped','private_directory_removed'].every(key=>report.cleanup[key]===true))report.failure??={code:report.cleanup.error||'INCOMPLETE_PROBE_CLEANUP'};
 report.completed=workloadCompleted({completed:report.completed,durationSeconds:duration,actualDurationMs:report.scheduled_duration_ms,clientError:report.client_error,roomRestartError:report.room_restart_error,failure:report.failure});
 if(!report.completed&&!report.failure)report.failure={code:report.client_error||report.room_restart_error||'WORKLOAD_ENDED_EARLY'};
 report.evaluation.capacity_pass=report.completed&&report.evaluation.unexpected_error_responses===0&&report.evaluation.scheduled_slots_completed_ratio>=.95&&report.metrics.filter(m=>m.kind==='poll').every(m=>m.p95_ms<=300&&m.p99_ms<=1000)&&report.metrics.filter(m=>['action','spin'].includes(m.kind)).every(m=>m.p95_ms<=1500&&m.p99_ms<=3000);
 report.evaluation.long_run_completed=duration>=600&&report.completed;
 report.mobile_quality_v1=evaluateMobileCapacity({completed:report.completed,durationSeconds:duration,actualDurationMs:report.scheduled_duration_ms,clientError:report.client_error,roomRestartError:report.room_restart_error,failure:report.failure,internal:report.internal_measurements,requiredGames:report.workload.games,databaseEvidence:report.database_evidence,unexpectedErrors:report.evaluation.unexpected_error_responses,httpRequests:report.metrics.reduce((n,m)=>n+m.count,0)});
 report.evaluation.http_requests=report.metrics.reduce((n,m)=>n+m.count,0);report.evaluation.completed_http_rps=report.evaluation.http_requests/(report.actual_duration_ms/1000);
 if(report.evaluation.unexpected_error_responses||report.room_restart_error||report.client_error)process.exitCode=1;
 if(!report.completed||!report.evaluation.capacity_pass||report.mobile_quality_v1.status==='fail')process.exitCode=1;
 }catch(e){rememberBenchmarkFailure(report,e,'report-finalization');report.completed=false;report.evaluation??={};report.evaluation.capacity_pass=false;report.mobile_quality_v1={status:'fail',reasons:['report-finalization-failed']};process.exitCode=1;}
 const saved=await persistBenchmarkReport(report,output);if(!saved){process.exitCode=1;report.completed=false;report.evaluation.capacity_pass=false;console.error(JSON.stringify({code:'BENCHMARK_REPORT_WRITE_FAILED',path:output,failure:report.failure}));}
 console.log(JSON.stringify({report:output,report_written:saved,completed:report.completed,failure:report.failure,users:report.setup?.independent_users,duration_seconds:duration,schedule:report.schedule,evaluation:report.evaluation,cleanup:report.cleanup},null,2));
}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runBenchmarkRelease();
