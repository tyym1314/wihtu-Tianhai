import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm,writeFile,symlink,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequestTimingSink,startRequestTimingSink} from '../server/request-timing-sink.mjs';

const rid='a'.repeat(32),bootId='b'.repeat(32);
const microtasks=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(options={}){
 let mono=0,epoch=1000000,next=0,closed=0;const scheduled=new Map(),chunks=[];
 const timers={setTimeout(fn,delay){const timer={id:++next,at:mono+delay,fn,unref(){}};scheduled.set(timer.id,timer);return timer;},clearTimeout(timer){scheduled.delete(timer?.id);}};
 const clock=()=>({epoch_ms:epoch,mono_ms:mono});
 const writer={async write(buffer){chunks.push(Buffer.from(buffer));return buffer.length;},async close(){closed++;}};
 const sink=createRequestTimingSink({writer,clock,timers,bootId,pid:42,...options});
 async function advance(amount){const end=mono+amount;for(;;){const due=[...scheduled.values()].filter(t=>t.at<=end).sort((a,b)=>a.at-b.at||a.id-b.id)[0];if(!due)break;epoch+=due.at-mono;mono=due.at;scheduled.delete(due.id);due.fn();await microtasks();}epoch+=end-mono;mono=end;await microtasks();}
 return{sink,writer,timers,clock,chunks,advance,rows:()=>Buffer.concat(chunks).toString().trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)),move:(m,e=epoch+m-mono)=>{mono=m;epoch=e;},closed:()=>closed,pending:()=>scheduled.size,event:(phase='entry',extra={})=>({phase,request_id:rid,...clock(),...extra})};
}

test('default off does not open a file or initialize a monitor',async()=>{
 let called=0;assert.equal(await startRequestTimingSink({}, {openFile(){called++;throw Error();},monitorFactory(){called++;throw Error();}}),null);assert.equal(called,0);
 for(const value of ['relative.ndjson','bad\0name',42])assert.equal(await startRequestTimingSink({OASIS_ROOM_TIMING_FILE:value}),null);
});

test('request schema keeps only approved scalars and captures paired clocks',async()=>{
 const f=fixture();assert.equal(await f.sink.ready,true);
 assert.equal(f.sink.record(f.event()),true);f.move(4);
 assert.equal(f.sink.record(f.event('headers',{app_ms:4})),true);f.move(5);
 assert.equal(f.sink.record(f.event('finish',{status:200})),true);
 const result=await f.sink.close({reason:'shutdown'});const rows=f.rows();
 assert.equal(result.state,'closed');assert.equal(result.incomplete,false);assert.equal(rows[0].boot_id,bootId);assert.equal(rows[0].pid,42);
 assert.deepEqual(rows.filter(r=>r.kind==='request').map(r=>r.phase),['entry','headers','finish']);
 assert.deepEqual(rows[1],{kind:'request',phase:'entry',request_id:rid,epoch_ms:1000000,mono_ms:0});
 assert.equal(rows.at(-1).kind,'end');assert.equal(rows.at(-1).complete,true);assert.equal(f.pending(),0);assert.equal(f.closed(),1);
});

test('eager closed promise settles once with the same boot identity on automatic expiry and later shutdown',async()=>{
 const f=fixture({limits:{windowMs:100}});await f.sink.ready;let completions=0,completion;
 f.sink.closed.then(value=>{completions++;completion=value;});
 await f.advance(100);const result=await f.sink.closed;
 assert.equal(f.sink.close({reason:'shutdown'}),f.sink.closed);assert.equal(await f.sink.close(),result);await microtasks();
 assert.equal(completions,1);assert.equal(completion.state,'closed');assert.equal(result.reason,'window');
 assert.equal(result.boot_id,bootId);assert.equal(result.pid,42);assert.equal(f.rows()[0].boot_id,result.boot_id);assert.equal(f.rows()[0].pid,result.pid);
});

test('unknown fields, getters, invalid IDs, phases, status and clocks are rejected without serializing secrets',async()=>{
 const f=fixture();await f.sink.ready;let getters=0;
 const invalid=[{url:'/private'}, {token:'do-not-write'}, {body:'secret'}, {phase:'other'}, {request_id:'caller-secret'}, {epoch_ms:NaN}, {mono_ms:-1}, {mono_ms:1}, {status:200}, {app_ms:0}];
 for(const value of invalid)assert.equal(f.sink.record({...f.event(),...value}),false);
 const getter={...f.event()};Object.defineProperty(getter,'token',{get(){getters++;return 'secret';},enumerable:true});assert.equal(f.sink.record(getter),false);assert.equal(getters,0);
 assert.equal(f.sink.record(f.event('headers')),false);assert.equal(f.sink.record(f.event('finish',{status:NaN})),false);assert.equal(f.sink.record(f.event('close',{status:600})),false);
 assert.equal(f.sink.record(f.event('close',{status:401})),true);
 const result=await f.sink.close();assert.equal(result.incomplete,true);assert.equal(result.dropped.invalid,14);
 assert.equal(Buffer.concat(f.chunks).toString().includes('secret'),false);assert.equal(f.rows().at(-1).complete,false);
});

test('record and clock access exceptions cannot escape into a request',async()=>{
 let valid=true;const f=fixture({clock:()=>{if(!valid)throw Error('private config');return{epoch_ms:1000000,mono_ms:0};}});await f.sink.ready;
 const proxy=new Proxy({}, {getPrototypeOf(){throw Error('secret');}});assert.doesNotThrow(()=>assert.equal(f.sink.record(proxy),false));
 valid=false;assert.doesNotThrow(()=>assert.equal(f.sink.record({}),false));await microtasks();
 assert.equal((await f.sink.close()).reason,'invalid_clock');assert.equal(Buffer.concat(f.chunks).toString().includes('private'),false);
});

test('monotonic duration expires despite backwards wall clock; no renewal after120s',async()=>{
 const f=fixture();await f.sink.ready;f.move(119999,1);assert.equal(f.sink.record(f.event()),true);
 f.move(120000,2);assert.equal(f.sink.record(f.event()),false);await microtasks();
 const before=Buffer.concat(f.chunks);f.move(1000000,3);assert.equal(f.sink.record(f.event()),false);
 const result=await f.sink.close();assert.equal(result.reason,'window');assert.equal(result.state,'closed');assert.deepEqual(Buffer.concat(f.chunks),before);
 assert.equal(f.rows()[1].epoch_ms,1);
});

test('backwards monotonic clock disables observations and marks end incomplete',async()=>{
 const f=fixture();await f.sink.ready;f.move(10);assert.equal(f.sink.record(f.event()),true);f.move(9);
 assert.equal(f.sink.record(f.event()),false);assert.equal((await f.sink.close()).reason,'invalid_clock');assert.equal(f.rows().at(-1).complete,false);
});

test('record cap includes start/end and stops admitting before reserved metadata',async()=>{
 const f=fixture({limits:{maxRecords:6}});await f.sink.ready;
 for(let i=0;i<4;i++)assert.equal(f.sink.record(f.event()),true);
 assert.equal(f.sink.record(f.event()),false);const result=await f.sink.close();
 assert.equal(f.rows().length,6);assert.equal(result.confirmed_written_records,6);assert.equal(result.reason,'record_limit');assert.equal(f.rows().at(-1).dropped.record_limit,1);assert.equal(f.rows().at(-1).complete,false);
});

test('default4096-record budget includes all metadata under sustained drained traffic',async()=>{
 const f=fixture();await f.sink.ready;
 for(let i=0;i<4094;i++){assert.equal(f.sink.record(f.event()),true);if(i%32===31)await f.advance(25);}
 assert.equal(f.sink.record(f.event()),false);const result=await f.sink.close();
 assert.equal(f.rows().length,4096);assert.equal(result.confirmed_written_records,4096);assert.ok(Buffer.concat(f.chunks).length<=1048576);assert.equal(result.dropped.backpressure,0);
});

test('byte cap includes UTF8/newlines and leaves a bounded end with drop counters',async()=>{
 const f=fixture({limits:{maxBytes:3072}});await f.sink.ready;
 let admitted=0;while(f.sink.record(f.event()))admitted++;
 const result=await f.sink.close();const content=Buffer.concat(f.chunks);
 assert.ok(admitted>0);assert.ok(content.length<=3072);assert.equal(result.confirmed_written_bytes,content.length);assert.equal(result.reason,'byte_limit');assert.equal(f.rows().at(-1).dropped.byte_limit,1);
});

test('backpressure bounds queued plus in-flight records and later reports dropped/incomplete',async()=>{
 let release,writeCount=0;const chunks=[];
 const writer={async write(buffer){writeCount++;if(writeCount===2)await new Promise(resolve=>{release=resolve;});chunks.push(Buffer.from(buffer));return buffer.length;},async close(){}};
 const f=fixture({writer,limits:{queueRecords:4}});await f.sink.ready;
 assert.equal(f.sink.record(f.event()),true);await f.advance(25);
 for(let i=0;i<3;i++)assert.equal(f.sink.record(f.event()),true);
 for(let i=0;i<20;i++)assert.equal(f.sink.record(f.event()),false);
 assert.equal(f.sink.stats().pending_records,4);assert.ok(f.sink.stats().pending_bytes<=65536);
 const ending=f.sink.close();assert.equal(f.sink.record(f.event()),false);release();await microtasks();
 const result=await ending;const rows=Buffer.concat(chunks).toString().trim().split('\n').map(JSON.parse);
 assert.equal(result.state,'closed');assert.equal(rows.at(-1).dropped.backpressure,20);assert.equal(rows.at(-1).dropped.after_close,1);assert.equal(rows.at(-1).complete,false);
});

test('byte backpressure is independent of the queue record limit',async()=>{
 let release,count=0;const f=fixture({limits:{queueBytes:1024},writer:{async write(buffer){if(++count===2)await new Promise(resolve=>{release=resolve;});return buffer.length;},async close(){}}});await f.sink.ready;
 f.sink.record(f.event());await f.advance(25);
 let accepted=1;while(f.sink.record(f.event()))accepted++;
 assert.ok(accepted<128);assert.ok(f.sink.stats().pending_bytes<=1024);assert.equal(f.sink.stats().dropped.backpressure,1);
 const result=f.sink.close();release();await microtasks();assert.equal((await result).state,'closed');
});

test('write rejection or a short injected write disables the sink and never fabricates a successful footer',async()=>{
 for(const behavior of ['reject','short']){
  const chunks=[];let count=0;
  const f=fixture({writer:{async write(buffer){if(++count===1){chunks.push(Buffer.from(buffer));return buffer.length;}if(behavior==='reject')throw Error('token: secret');return buffer.length-1;},async close(){}}});
  await f.sink.ready;f.sink.record(f.event());await f.advance(25);
  const result=await f.sink.close();assert.equal(result.state,'failed');assert.equal(result.incomplete,true);assert.equal(result.reason,'writer_error');assert.equal(f.sink.record(f.event()),false);
  assert.equal(Buffer.concat(chunks).toString().includes('"kind":"end"'),false);
 }
});

test('close is idempotent, bounded for a hung write and never resumes queued work after timeout',async()=>{
 let release,count=0;const chunks=[];const f=fixture({writer:{async write(buffer){if(++count===2)await new Promise(resolve=>{release=resolve;});chunks.push(Buffer.from(buffer));return buffer.length;},async close(){}}});
 await f.sink.ready;f.sink.record(f.event());await f.advance(25);f.sink.record(f.event());
 const a=f.sink.close(),b=f.sink.close();assert.equal(a,b);await f.advance(1000);
 const result=await a;assert.equal(result.state,'timed_out');assert.equal(result.incomplete,true);assert.equal(result.dropped.discarded_on_failure,1);
 release();await microtasks();assert.equal(count,2);assert.equal(Buffer.concat(chunks).toString().includes('"kind":"end"'),false);
});

test('hung writer.close also obeys shutdown bound',async()=>{
 const chunks=[];const f=fixture({writer:{async write(b){chunks.push(Buffer.from(b));return b.length;},close(){return new Promise(()=>{});}}});await f.sink.ready;
 const ending=f.sink.close();await microtasks();await f.advance(1000);assert.equal((await ending).state,'timed_out');
 const end=JSON.parse(Buffer.concat(chunks).toString().trim().split('\n').at(-1));assert.equal(end.writer_close,'not_yet_observed_use_close_result');assert.equal(end.scope,'diagnostic_records_before_end_only');
});

test('loop statistics are process interval aggregates with no request correlation and share limits',async()=>{
 let stopped=0;const f=fixture({loopSample:()=>({count:50,max_ms:42,p50_ms:20,p99_ms:40,request_id:'ignored-secret'}),onStop:()=>stopped++});
 await f.sink.ready;await f.advance(1000);await f.advance(25);const result=await f.sink.close();
 const row=f.rows().find(r=>r.kind==='event_loop_interval');assert.ok(row);assert.equal(row.scope,'process_interval_aggregate_not_per_request');assert.equal(row.start_mono_ms,0);assert.equal(row.end_mono_ms,1000);assert.equal(row.count,50);assert.equal(row.max_ms,42);assert.equal('request_id' in row,false);assert.equal(stopped,1);assert.equal(result.incomplete,false);
});

test('unsafe construction settings cannot enlarge fixed caps',()=>{
 for(const limits of [{windowMs:120001},{maxRecords:4097},{maxBytes:1048577},{queueRecords:129},{shutdownMs:1001},{unknown:1}])assert.throws(()=>fixture({limits}),/INVALID_TIMING_LIMIT/);
});

test('real startup exclusively creates0600 and refuses existing/symlink/missing-parent paths',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'oasis-timing-sink-'));
 try{
  const file=join(folder,'room.ndjson');const sink=await startRequestTimingSink({OASIS_ROOM_TIMING_FILE:file});assert.ok(sink);
  const now={epoch_ms:Date.now(),mono_ms:performance.now()};assert.equal(sink.record({phase:'entry',request_id:rid,...now}),true);assert.equal((await sink.close()).state,'closed');
  const info=await stat(file);assert.equal(info.mode&0o777,0o600);assert.equal(info.nlink,1);const content=await readFile(file,'utf8');assert.equal(JSON.parse(content.split('\n')[0]).kind,'start');
  assert.equal(await startRequestTimingSink({OASIS_ROOM_TIMING_FILE:file}),null);assert.equal(await readFile(file,'utf8'),content);
  const target=join(folder,'target');await writeFile(target,'private-existing');const link=join(folder,'link');await symlink(target,link);
  assert.equal(await startRequestTimingSink({OASIS_ROOM_TIMING_FILE:link}),null);assert.equal(await readFile(target,'utf8'),'private-existing');
  assert.equal(await startRequestTimingSink({OASIS_ROOM_TIMING_FILE:join(folder,'missing','new')}),null);
 }finally{await rm(folder,{recursive:true,force:true});}
});

test('file adapter completes partial OS writes and persisted content remains parseable',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'oasis-timing-partial-'));let writes=0;
 try{
  const file=join(folder,'log');const sink=await startRequestTimingSink({OASIS_ROOM_TIMING_FILE:file},{openFile:async(...args)=>{const h=await open(...args);return{stat:()=>h.stat(),close:()=>h.close(),write:(buffer,offset,length,position)=>{writes++;return h.write(buffer,offset,Math.min(length,13),position);}};}});
  assert.ok(sink);await sink.close();const rows=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows[0].kind,'start');assert.equal(rows.at(-1).kind,'end');assert.ok(writes>2);
 }finally{await rm(folder,{recursive:true,force:true});}
});

test('startup open timeout returns disabled then closes a late descriptor without creating a sink',async()=>{
 let release,closed=0,monitors=0;
 const value=await startRequestTimingSink({OASIS_ROOM_TIMING_FILE:'/owned-fixture/log'},{startupTimeoutMs:5,openFile:()=>new Promise(resolve=>{release=resolve;}),monitorFactory:()=>{monitors++;throw Error();}});
 assert.equal(value,null);release({close:async()=>{closed++;}});await microtasks();assert.equal(closed,1);assert.equal(monitors,0);
});

test('final partial loop interval is captured, but a delayed deadline does not report a beyond-window bucket',async()=>{
 const options={loopSample:()=>({count:1,max_ms:20,p50_ms:20,p99_ms:20})};
 const f=fixture(options);await f.sink.ready;f.move(450);await f.sink.close();
 const bucket=f.rows().find(x=>x.kind==='event_loop_interval');assert.equal(bucket.start_mono_ms,0);assert.equal(bucket.end_mono_ms,450);
 assert.equal(f.pending(),0,'final interval must not recreate a flush timer after shutdown cleared timers');
 const late=fixture(options);await late.sink.ready;late.move(120050);assert.equal(late.sink.record(late.event()),false);await late.sink.close();
 assert.equal(late.rows().filter(x=>x.kind==='event_loop_interval').length,0);
});

test('startup timeout during stat never initializes a monitor after returning disabled',async()=>{
 let release,closed=0,monitors=0;
 const value=await startRequestTimingSink({OASIS_ROOM_TIMING_FILE:'/owned-fixture/log'},{startupTimeoutMs:5,openFile:async()=>({stat:()=>new Promise(resolve=>{release=resolve;}),close:async()=>{closed++;}}),monitorFactory:()=>{monitors++;throw Error();}});
 assert.equal(value,null);release({isFile:()=>true,nlink:1,mode:0o600,uid:process.getuid()});await microtasks();assert.equal(closed,1);assert.equal(monitors,0);
});

test('write failure with hung resource close still settles and does not leak error text',async()=>{
 const f=fixture({writer:{async write(){throw Error('private-password');},close(){return new Promise(()=>{});}}});
 assert.equal(await f.sink.ready,false);const closing=f.sink.close();await f.advance(1000);const result=await closing;
 assert.equal(result.state,'failed');assert.equal(result.reason,'writer_error');assert.equal(JSON.stringify(result).includes('private-password'),false);
});
