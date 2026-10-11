import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,writeFile,rm,lstat,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createBenchmarkChildMonitor,rememberBenchmarkFailure,persistBenchmarkRuntime,persistBenchmarkReport,createBenchmarkCheckpointQueue,benchmarkDirectoryIdentity,removeBenchmarkDirectory,cleanupBenchmarkResources} from '../scripts/benchmark-release.mjs';
import {evaluateMobileCapacity,workloadCompleted} from '../scripts/benchmark-evaluation.mjs';
import {BENCHMARK_GAMES,BENCHMARK_PROBABILITY_GAMES} from '../scripts/benchmark-workload.mjs';

class FixtureChild extends EventEmitter {
 constructor(send=(_message,callback)=>callback(null)){super();this.pid=12345;this.connected=true;this.exitCode=null;this.signalCode=null;this.stdout=new EventEmitter();this.stderr=new EventEmitter();this.send=send;}
 finish(code,signal=null){this.connected=false;this.exitCode=code;this.signalCode=signal;this.emit('exit',code,signal);this.emit('close',code,signal);}
}
const tracked=child=>{const report={completed:false,metrics:[{game:'run',kind:'poll',count:12}],telemetry:[{type:'metrics',at:123}]};const monitor=createBenchmarkChildMonitor(child,{onFailure:(error,stage)=>rememberBenchmarkFailure(report,error,stage)});return{report,monitor};};
async function files(run){const dir=await mkdtemp(join(tmpdir(),'oasis-benchmark-ipc-fixture-'));try{return await run(dir);}finally{await rm(dir,{recursive:true,force:true});}}

test('closed IPC is a rejected measurement and a saved strict failure with original samples',async()=>files(async dir=>{
 const child=new FixtureChild();child.connected=false;const {report,monitor}=tracked(child);
 await assert.rejects(monitor.measurement('measure-stop'),{code:'ERR_IPC_CHANNEL_CLOSED'});child.finish(1);
 await persistBenchmarkRuntime(monitor,join(dir,'report.json'),report);assert.equal(await persistBenchmarkReport(report,join(dir,'report.json')),true);
 const saved=JSON.parse(await readFile(join(dir,'report.json')));assert.equal(saved.completed,false);assert.equal(saved.failure.code,'ERR_IPC_CHANNEL_CLOSED');assert.equal(saved.metrics[0].count,12);assert.equal(saved.telemetry[0].at,123);
 assert.equal(saved.server_runtime.exit.code,1);assert.equal(saved.server_runtime.exit.signal,null);assert.ok(Number.isFinite(saved.server_runtime.exit.at_ms));assert.equal(saved.server_runtime.close.code,1);
}));

test('channel closing between connected check and send cannot escape as an unhandled error event',async()=>{
 let child;child=new FixtureChild((_message,callback)=>queueMicrotask(()=>{const error=Object.assign(Error('Channel closed'),{code:'ERR_IPC_CHANNEL_CLOSED'});child.emit('error',error);callback(error);}));
 const {report,monitor}=tracked(child);await assert.rejects(monitor.measurement('measure-stop'),{code:'ERR_IPC_CHANNEL_CLOSED'});
 assert.equal(report.failure.code,'ERR_IPC_CHANNEL_CLOSED');assert.equal(report.failure.stage,'child-error');assert.equal(monitor.runtime.events.filter(e=>e.kind==='error').length,1);assert.equal(monitor.runtime.events.filter(e=>e.kind==='send-error').length,1);
 child.finish(1);await monitor.closed;
});

test('early child disconnect/exit rejects pending collection and retains exit signal without replacing first failure',async()=>{
 const child=new FixtureChild(()=>{}),{report,monitor}=tracked(child);rememberBenchmarkFailure(report,Object.assign(Error('first workload failure'),{code:'CLIENT_FAILED'}),'client-workload');
 const wait=monitor.measurement('measure-stop');child.connected=false;child.emit('disconnect');child.finish(null,'SIGKILL');
 await assert.rejects(wait,{code:'ERR_IPC_CHANNEL_CLOSED'});assert.equal(report.failure.code,'CLIENT_FAILED');assert.equal(monitor.runtime.exit.signal,'SIGKILL');assert.equal(monitor.runtime.close.signal,'SIGKILL');assert.equal(monitor.runtime.disconnect.kind,'disconnect');
});

test('original stderr/error are retained separately with bounded private stream persistence',async()=>files(async dir=>{
 const child=new FixtureChild(),report={completed:false},monitor=createBenchmarkChildMonitor(child,{logLimitBytes:32,onFailure:(e,stage)=>rememberBenchmarkFailure(report,e,stage)});
 child.stdout.emit('data',Buffer.from('public stdout'));child.stderr.emit('data',Buffer.from('x'.repeat(100)+'\nactual child failure'));
 child.emit('error',Object.assign(Error('original child error'),{code:'EPIPE'}));child.finish(1);
 await persistBenchmarkRuntime(monitor,join(dir,'report.json'),report);const stdout=await readFile(monitor.runtime.stdout.path),stderr=await readFile(monitor.runtime.stderr.path);
 assert.equal(stdout.toString(),'public stdout');assert.equal(stderr.length,32);assert.ok(stderr.toString().endsWith('actual child failure'));assert.equal(monitor.runtime.stderr.bytes_seen,121);assert.equal(monitor.runtime.stderr.truncated,true);
 assert.equal(monitor.runtime.stderr.sha256,createHash('sha256').update(stderr).digest('hex'));assert.equal((await lstat(monitor.runtime.stderr.path)).mode&0o777,0o600);assert.equal(report.failure.code,'EPIPE');assert.match(monitor.runtime.events.find(e=>e.kind==='error').stack,/original child error/);
}));

test('successful start and complete summary use original IPC messages; false send return is only backpressure',async()=>{
 let child;const sent=[];child=new FixtureChild((message,callback)=>{sent.push(message);callback(null);queueMicrotask(()=>child.emit('message',message.type==='measure-start'?{type:'measure-started'}:{type:'measure-summary',result:{duration_ms:900001,routes:[{count:1,p95_ms:99,p99_ms:249}]}}));return false;});
 const {report,monitor}=tracked(child);assert.equal((await monitor.measurement('measure-start')).type,'measure-started');assert.equal((await monitor.measurement('measure-stop')).result.duration_ms,900001);assert.deepEqual(sent,[{type:'measure-start'},{type:'measure-stop'}]);assert.equal(report.failure,undefined);
 monitor.expectStop();monitor.stopSignal('SIGTERM',true);child.finish(0);await monitor.closed;assert.equal(report.failure,undefined);assert.equal(monitor.runtime.exit.code,0);
});

test('cleanup intent alone cannot classify an abnormal child exit as an owned successful stop',async()=>{
 const child=new FixtureChild(),{report,monitor}=tracked(child);monitor.expectStop();monitor.stopSignal('SIGTERM',true);child.finish(1);await monitor.closed;
 assert.equal(report.failure.code,'SERVER_CHILD_EXITED');assert.equal(monitor.runtime.exit.code,1);assert.equal(monitor.runtime.events.find(e=>e.kind==='owned-stop-signal').sent,true);
});

test('a callback success without an original summary times out and cannot become a pass',async()=>{
 const child=new FixtureChild(),{report,monitor}=tracked(child);await assert.rejects(monitor.measurement('measure-stop',{timeoutMs:5}),{code:'OBSERVER_STOP_TIMEOUT'});assert.equal(report.failure.code,'OBSERVER_STOP_TIMEOUT');assert.equal(report.completed,false);child.finish(1);
});

test('cleanup keeps first failure and still removes the precisely owned temp directory when DB pool close fails',async()=>{
 const privateDir=await mkdtemp(join(tmpdir(),'oasis-release-bench-'));const identity=await benchmarkDirectoryIdentity(privateDir),report={completed:false,cleanup:{}},calls=[];
 await writeFile(join(privateDir,'master.key'),'fixture-secret',{mode:0o600});rememberBenchmarkFailure(report,Object.assign(Error('original channel failure'),{code:'ERR_IPC_CHANNEL_CLOSED'}),'measure-stop');
 try{
  const clean=await cleanupBenchmarkResources({db:{end:async()=>{throw Object.assign(Error('pool-close-failed'),{code:'DB_POOL_CLOSE_FAILED'});}},admin:{query:async(sql)=>{calls.push(sql);return{rowCount:0};},end:async()=>calls.push('admin.end')},createdDB:true,dbname:'oasis_release_bench_12345_1234567890',privateDir,privateDirIdentity:identity,report});
  assert.equal(clean,false);assert.equal(report.failure.code,'ERR_IPC_CHANNEL_CLOSED');assert.equal(report.cleanup.database_dropped,true);assert.equal(report.cleanup.private_directory_removed,true);assert.equal(calls.at(-1),'admin.end');await assert.rejects(lstat(privateDir),{code:'ENOENT'});
  const evidence=report.cleanup.private_directory_before_remove;assert.equal(evidence.identity.ino,identity.ino);assert.equal(evidence.files[0].sha256,createHash('sha256').update('fixture-secret').digest('hex'));assert.equal(JSON.stringify(report).includes('fixture-secret'),false);
 }finally{await rm(privateDir,{recursive:true,force:true});}
});

test('identity replacement retains the new directory rather than deleting it',async()=>{
 const privateDir=await mkdtemp(join(tmpdir(),'oasis-release-bench-')),identity=await benchmarkDirectoryIdentity(privateDir),retained=privateDir+'-old';
 const {rename}=await import('node:fs/promises');await rename(privateDir,retained);await mkdir(privateDir,{mode:0o700});
 try{await assert.rejects(removeBenchmarkDirectory(privateDir,identity),{code:'PRIVATE_DIRECTORY_IDENTITY_CHANGED'});assert.equal((await lstat(privateDir)).isDirectory(),true);}finally{await rm(privateDir,{recursive:true,force:true});await rm(retained,{recursive:true,force:true});}
});

test('report persistence failure is explicit and cannot replace the original child cause',async()=>files(async dir=>{
 const file=join(dir,'not-directory');await writeFile(file,'fixture');const report={completed:false};rememberBenchmarkFailure(report,Object.assign(Error('child failed'),{code:'SERVER_CHILD_EXITED'}),'child-exit');
 assert.equal(await persistBenchmarkReport(report,join(file,'report.json')),false);assert.equal(report.failure.code,'SERVER_CHILD_EXITED');
}));

test('checkpoint writes are diagnostic only and propagate their first failure to the main report',async()=>files(async dir=>{
 const report={completed:true,isolation:{private_directory:{path:'/fixture/owned',ino:1}}},checkpoint=createBenchmarkCheckpointQueue(report,join(dir,'checkpoint.json'));
 await checkpoint.save();const saved=JSON.parse(await readFile(join(dir,'checkpoint.json')));assert.equal(saved.completed,false);assert.equal(saved.diagnostic_only,true);assert.equal(report.completed,true);assert.equal(saved.isolation.private_directory.ino,1);
 const blocker=join(dir,'not-directory');await writeFile(blocker,'fixture');let failed=0;const failedQueue=createBenchmarkCheckpointQueue(report,join(blocker,'checkpoint.json'),{onFailure:()=>failed++});await failedQueue.save();await failedQueue.drain();
 assert.equal(failed,1);assert.equal(report.failure.stage,'persist-report');assert.ok(report.report_persistence_errors.length>0);
}));

test('the original 100 users, 900 seconds, all thirteen games and capacity thresholds remain unchanged',async()=>{
 const source=await readFile(new URL('../scripts/benchmark-release.mjs',import.meta.url),'utf8');
 assert.match(source,/userCount<100\|\|userCount>400\|\|userCount%20/);assert.match(source,/minimum_slot_dispatch_ratio:\.95,poll_p95_ms:300,poll_p99_ms:1000,action_p95_ms:1500,action_p99_ms:3000/);assert.match(source,/const gamePollMs=.*game==='run'\?150:500/);
 assert.equal(BENCHMARK_GAMES.length,13);const probability=new Set(BENCHMARK_PROBABILITY_GAMES),histogram={count:1,p50_ms:10,p95_ms:99,p99_ms:249,max_ms:249};
 const input={completed:true,durationSeconds:900,actualDurationMs:900001,unexpectedErrors:0,httpRequests:1000,requiredGames:BENCHMARK_GAMES,internal:{duration_ms:900001,routes:[{route:'GET /api/pvp/rooms/:id',...histogram}],game_routes:BENCHMARK_GAMES.map(game=>({game,route:probability.has(game)?'POST /api/play/'+game+'/spin':'POST /api/pvp/rooms/:id/action',...histogram})),event_loop:{count:1,p95_ms:1,p99_ms:49,max_ms:49},cpu:{logical_cpus:4,average_percent_of_one_core:20,average_percent_of_machine:5,peak_1s_percent_of_one_core:200,peak_1s_percent_of_machine:69}},databaseEvidence:{actions:BENCHMARK_GAMES.filter(game=>!probability.has(game)).map(game_id=>({game_id,n:1})),cycles:BENCHMARK_PROBABILITY_GAMES.map(game_id=>({game_id,status:'SETTLED',n:1}))}};
 assert.equal(evaluateMobileCapacity(input).status,'pass');assert.equal(evaluateMobileCapacity({...input,actualDurationMs:899999}).status,'fail');assert.equal(evaluateMobileCapacity({...input,failure:{code:'ERR_IPC_CHANNEL_CLOSED'}}).status,'fail');assert.equal(workloadCompleted({...input,failure:{code:'ERR_IPC_CHANNEL_CLOSED'}}),false);
});
