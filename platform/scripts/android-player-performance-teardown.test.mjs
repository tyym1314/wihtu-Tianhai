import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
const {boundedPerformanceTeardown,recordPerformanceCheckpoint,createPhysicalNetworkCollector,cleanupPerformanceRound}=await import('./android-player-performance.mjs');
const {ANDROID_PERFORMANCE_SCHEMA}=await import('./android-player-performance-checks.mjs');
const origin='https://owned-player.example',game='run',nonce='own-test-only',entryUrl=origin+'/player',url=origin+'/play/run',documentId='d'.repeat(32),timeOrigin=1000;
function options(extra={}){return {stage:'TEST_CLOSE',timeoutMs:20,...extra};}
async function fakeCollector({evaluate=()=>new Promise(()=>{}),detach=async()=>{},checkpoint=async()=>{}}={}){
 const cdp=new EventEmitter(),round={id:'run-cold-1',documentId,observerErrors:[]};
 cdp.send=async(method,args)=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'top',url:entryUrl},childFrames:[{frame:{id:'game',parentId:'top',url}}]}}:method==='Runtime.evaluate'?evaluate(args.expression):{};cdp.detach=detach;
 const collector=await createPhysicalNetworkCollector({context:{newCDPSession:async()=>cdp},page:{url:()=>entryUrl},origin,game,state:{},baseline:{},manifest:{expected:new Map()},nonce,round,entryUrl,drainTimeoutMs:20,checkpoint});
 cdp.emit('Page.frameNavigated',{frame:{id:'game',url}});cdp.emit('Runtime.executionContextCreated',{context:{id:11,origin,auxData:{isDefault:true,frameId:'game'}}});await collector.bind();return {collector,round,cdp};
}
const probe={schema:ANDROID_PERFORMANCE_SCHEMA,nonce,documentId,url,timeOrigin,frames:[],longTasks:[],gestures:[]};

test('host bound keeps returned values and exact original rejection identities; invalid configuration invokes no cleanup',async()=>{
 const receipts=[];assert.equal(await boundedPerformanceTeardown(options({operation:()=>42,checkpoint:async(...args)=>receipts.push(args)})),42);assert.deepEqual(receipts,[['TEST_CLOSE','started'],['TEST_CLOSE','returned']]);
 for(const failure of [Error('original failure'),null,0,false,undefined]){let caught=false;try{await boundedPerformanceTeardown(options({operation:()=>Promise.reject(failure)}));}catch(error){caught=true;assert.equal(error,failure);}assert.equal(caught,true);}
 let calls=0;for(const timeoutMs of [0,-1,1.5,20001,NaN])await assert.rejects(boundedPerformanceTeardown({stage:'TEST_CLOSE',timeoutMs,operation:()=>calls++}),/BOUNDED_TEARDOWN_TIMEOUT_REQUIRED/);
 await assert.rejects(boundedPerformanceTeardown(options({stage:'private token',operation:()=>calls++})),/TEARDOWN_STAGE_REQUIRED/);assert.equal(calls,0);
});

test('real child with never-settling close stays alive until the ref timer, preserves primary failure and runs the next independent close',t=>{
 const code=`import assert from 'node:assert/strict';\n${boundedPerformanceTeardown.toString()}\nconst primary=Error('original round failure'),errors=[],events=[];let failure=primary;const started=Date.now();try{await boundedPerformanceTeardown({operation:()=>new Promise(()=>{}),stage:'BROWSER_CLOSE',timeoutMs:25,checkpoint:async(stage,outcome)=>events.push([stage,outcome])});}catch(error){errors.push(error.code);}await boundedPerformanceTeardown({operation:()=>events.push(['OWNED_FORWARD_REMOVE','returned']),stage:'NEXT_CLOSE',timeoutMs:25});assert.equal(failure,primary);assert.deepEqual(errors,['PERFORMANCE_TEARDOWN_TIMEOUT']);assert.ok(Date.now()-started>=20);assert.ok(events.some(row=>row[0]==='OWNED_FORWARD_REMOVE'));console.log(JSON.stringify({elapsedMs:Date.now()-started,errors,events,nextCloseCompleted:true,primaryPreserved:true}));`;
 const child=spawnSync(process.execPath,['--input-type=module','--eval',code],{encoding:'utf8',timeout:2000});t.diagnostic(JSON.stringify({childStatus:child.status,childSignal:child.signal,childStdout:child.stdout,childStderr:child.stderr}));assert.equal(child.status,0,child.stderr);assert.equal(child.signal,null);const result=JSON.parse(child.stdout);assert.equal(result.nextCloseCompleted,true);assert.equal(result.primaryPreserved,true);assert.ok(result.elapsedMs<1000);assert.equal(child.stderr,'');
});

test('never-settling resource-final probe and CDP detach do not prevent the independent native observer detach',async()=>{
 const checkpoints=[],{collector,round,cdp}=await fakeCollector({detach:()=>new Promise(()=>{}),checkpoint:async(...row)=>checkpoints.push(row)}),events=[],result={js_errors:[],resource_errors:[],observer_errors:[],http_errors:[],network_errors:[]};round.error='original gameplay failure';
 const cleanup=await cleanupPerformanceRound({active:{state:{creations:[],actionRequests:[],inputsRequests:[],practiceRequested:false},round,result,collector,observer:{drain:async()=>{},detach:()=>events.push('native-detached')}},baseline:{},stopUI:async row=>{row.uiStopped=true;},api:async()=>{throw Error('unexpected API call');},until:async()=>{},newId:()=>{throw Error('unexpected ID call');},checkpoint:async(...row)=>checkpoints.push(row)});
 assert.equal(cleanup.passed,true,'Separate no-mutation own API cleanup remains independently proven');assert.deepEqual(events,['native-detached']);assert.equal(round.error,'original gameplay failure');assert.equal(round.pendingWork,0);assert.equal(round.resourceEvidence,undefined);assert.ok(round.observerErrors.includes('CDP_CLOSE: PERFORMANCE_TEARDOWN_TIMEOUT: CDP_DETACH'));assert.ok(round.observerErrors.includes('RESOURCE_FINAL_EVIDENCE: PERFORMANCE_TEARDOWN_TIMEOUT: RESOURCE_FINAL_PROBE'));assert.equal(cdp.listenerCount('Runtime.executionContextCreated'),0);assert.ok(checkpoints.some(row=>row[0]==='RESOURCE_FINAL_PROBE'&&row[1]==='timed-out'));assert.ok(checkpoints.some(row=>row[0]==='CDP_DETACH'&&row[1]==='timed-out'));assert.ok(checkpoints.findIndex(row=>row[0]==='ROUND_NATIVE_DETACH')>checkpoints.findIndex(row=>row[0]==='CDP_DETACH'));
});

test('stop failure stays the final-resource error when its fallback snapshot never settles; it cannot claim finalized evidence',async()=>{
 const receipts=[],failure=Error('original resource stop failed'),{collector,round}=await fakeCollector({evaluate:expression=>expression.includes('__oasisPhysicalPerf')?{result:{value:probe}}:expression.endsWith('.stop()')?Promise.reject(failure):new Promise(()=>{}),checkpoint:async(...row)=>receipts.push(row)});
 await collector.close();assert.ok(collector.errors.includes('RESOURCE_FINAL_EVIDENCE: original resource stop failed'));assert.equal(round.resourceEvidence,undefined);assert.ok(receipts.some(row=>row[0]==='RESOURCE_FINAL_SNAPSHOT'&&row[1]==='timed-out'));assert.ok(receipts.some(row=>row[0]==='CDP_DETACH'&&row[1]==='returned'));
});

test('the original network-drain error survives a secondary detach timeout, including a falsy primary',async()=>{
 for(const failure of [Error('original network drain failed'),null]){const {collector}=await fakeCollector({detach:()=>new Promise(()=>{})});collector.drain=()=>Promise.reject(failure);let caught=false;try{await collector.close();}catch(error){caught=true;assert.equal(error,failure);}assert.equal(caught,true);assert.deepEqual(collector.errors,['CDP_DETACH: PERFORMANCE_TEARDOWN_TIMEOUT: CDP_DETACH']);}
});

test('ordinary evidence verification receives no new host bound, while close-path verification is bounded',async()=>{
 const checkpoints=[],{collector}=await fakeCollector({checkpoint:async(...row)=>checkpoints.push(row)});let settled=false;void collector.verifyResourceEvidence({finish:true}).then(()=>{settled=true;},()=>{settled=true;});await new Promise(resolve=>setTimeout(resolve,35));assert.equal(settled,false);assert.deepEqual(checkpoints,[]);await collector.close();assert.ok(collector.errors.some(row=>row.includes('RESOURCE_FINAL_PROBE')));
});

test('progress ledger stores only bounded stage/round/clock/outcome fields and retains the latest step after history reaches its cap',()=>{
 const report={};for(let i=0;i<300;i++)recordPerformanceCheckpoint(report,{stage:'TEST_CLOSE',roundId:'run-cold-1',atEpochMs:i});assert.equal(report.progress.records.length,256);assert.equal(report.progress.total,300);assert.equal(report.progress.omitted,44);assert.equal(report.progress.latest.sequence,300);assert.deepEqual(Object.keys(report.progress.latest),['sequence','stage','outcome','roundId','atEpochMs']);assert.throws(()=>recordPerformanceCheckpoint(report,{stage:'Authorization secret'}),/TEARDOWN_STAGE_REQUIRED/);assert.throws(()=>recordPerformanceCheckpoint(report,{stage:'TEST_CLOSE',roundId:'private-token'}),/TEARDOWN_ROUND_REQUIRED/);
});

