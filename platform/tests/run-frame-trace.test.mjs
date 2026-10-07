import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunFrameTrace,isRunFrameTraceSessionEnabled,RUN_FRAME_TRACE_SESSION_KEY,
 RUN_FRAME_TRACE_DEFAULT_CAPACITY,RUN_FRAME_TRACE_MAX_CAPACITY,RUN_FRAME_TRACE_FIELDS,RUN_FRAME_TRACE_PHASE} from '../arena/run/frame-trace.mjs';

const frame=(at=100)=>[at,60,12,150,8,9.2,-9.2,-.4,8,0,-1,-1,0,0,RUN_FRAME_TRACE_PHASE.racing,at+.7];

test('disabled creation and all no-op calls allocate no typed buffer or per-scene trace',()=>{
 const Native=globalThis.Float64Array;
 globalThis.Float64Array=class{constructor(){throw new Error('Disabled trace allocated a buffer');}};
 try{
  const trace=createRunFrameTrace();
  assert.equal(createRunFrameTrace({enabled:false,capacity:0}),trace);
  assert.equal(createRunFrameTrace({enabled:'1'}),trace);
  assert.equal(trace.record(...frame()),false);assert.equal(trace.reset(),false);trace.dispose();
  const result=trace.read();assert.equal(result.enabled,false);assert.equal(result.stored,0);assert.deepEqual(result.samples,[]);
  assert.equal(trace.read(),result);assert.ok(Object.isFrozen(result.samples));
 }finally{globalThis.Float64Array=Native;}
});

test('session opt-in requires exact value and cannot turn storage errors into enablement',()=>{
 let reads=0;
 const storage={getItem(key){reads++;assert.equal(key,RUN_FRAME_TRACE_SESSION_KEY);return'1';}};
 assert.equal(createRunFrameTrace().read().enabled,false);assert.equal(reads,0);
 assert.equal(isRunFrameTraceSessionEnabled(storage),true);assert.equal(reads,1);
 for(const value of [null,undefined,'0','true','yes',1,true])assert.equal(isRunFrameTraceSessionEnabled({getItem:()=>value}),false);
 assert.equal(isRunFrameTraceSessionEnabled(),false);
 assert.equal(isRunFrameTraceSessionEnabled({getItem(){throw new Error('Storage denied');}}),false);
 assert.equal(isRunFrameTraceSessionEnabled({get getItem(){throw new Error('Storage denied');}}),false);
});

test('enabled trace uses one bounded typed allocation, including repeated records',()=>{
 const Native=globalThis.Float64Array;let allocations=0,length;
 globalThis.Float64Array=class extends Native{constructor(size){super(size);allocations++;length=size;}};
 let trace;
 try{
  trace=createRunFrameTrace({enabled:true});
  assert.equal(allocations,1);assert.equal(length,RUN_FRAME_TRACE_DEFAULT_CAPACITY*RUN_FRAME_TRACE_FIELDS.length);
  assert.equal(length*8,1024*1024);
  for(let i=0;i<100;i++)assert.equal(trace.record(...frame(i)),true);
  assert.equal(allocations,1);assert.equal(trace.read().stored,100);
 }finally{trace?.dispose();globalThis.Float64Array=Native;}
});

test('capacity rejects coercion and unbounded allocations before constructing storage',()=>{
 const Native=globalThis.Float64Array;
 globalThis.Float64Array=class{constructor(){throw new Error('Invalid capacity allocated a buffer');}};
 try{
  for(const capacity of [0,-1,1.5,NaN,Infinity,'8192',null,true,RUN_FRAME_TRACE_MAX_CAPACITY+1]){
   assert.throws(()=>createRunFrameTrace({enabled:true,capacity}),{name:'RangeError',message:'INVALID_RUN_FRAME_TRACE_CAPACITY'});
  }
 }finally{globalThis.Float64Array=Native;}
 const largest=createRunFrameTrace({enabled:true,capacity:RUN_FRAME_TRACE_MAX_CAPACITY});
 assert.equal(largest.read().capacity,RUN_FRAME_TRACE_MAX_CAPACITY);largest.dispose();
});

test('ring overwrite exports newest capacity rows in chronological order and preserves exact fields',()=>{
 const trace=createRunFrameTrace({enabled:true,capacity:3});
 try{
  for(let i=0;i<8;i++)assert.equal(trace.record(...frame(i)),true);
  const result=trace.read();
  assert.deepEqual(result.samples,[frame(5),frame(6),frame(7)]);
  assert.deepEqual(result.fields,RUN_FRAME_TRACE_FIELDS);assert.equal(result.stored,3);
  assert.equal(result.recorded,8);assert.equal(result.overwritten,5);assert.equal(result.rejected,0);
  result.samples[0][0]=-900;result.samples.push(frame(99));
  assert.deepEqual(trace.read().samples,[frame(5),frame(6),frame(7)],'export copies cannot mutate the live ring');
 }finally{trace.dispose();}
});

test('invalid numeric records never evict good data or throw into the renderer',()=>{
 const trace=createRunFrameTrace({enabled:true,capacity:1});
 try{
  assert.equal(trace.record(...frame()),true);let rejected=0;
  for(let field=0;field<RUN_FRAME_TRACE_FIELDS.length;field++)for(const value of [NaN,Infinity,-Infinity,undefined,null,'secret',{}]){
   const row=frame(110);row[field]=value;
   assert.equal(trace.record(...row),false,`${RUN_FRAME_TRACE_FIELDS[field]} rejected`);rejected++;
  }
  for(const [field,value]of [[0,-1],[1,-1],[1,1.5],[2,-2],[2,Number.MAX_SAFE_INTEGER+1],[3,-1],[8,-1],[9,-1],
   [10,-2],[10,.5],[11,-2],[12,2],[12,true],[13,-1],[14,6],[14,.5],[15,99]]){
   const row=frame(110);row[field]=value;assert.equal(trace.record(...row),false);rejected++;
  }
  assert.equal(trace.record(...frame(90)),false);rejected++;
  assert.deepEqual(trace.read().samples,[frame()]);assert.equal(trace.read().recorded,1);
  assert.equal(trace.read().rejected,rejected);assert.equal(trace.read().overwritten,0);
 }finally{trace.dispose();}
});

test('unknown room version and absent fall/finish ticks remain explicit -1 sentinels',()=>{
 const trace=createRunFrameTrace({enabled:true});
 try{
  const row=frame();row[2]=-1;assert.equal(trace.record(...row),true);
  assert.equal(trace.read().samples[0][2],-1);assert.equal(trace.read().samples[0][10],-1);assert.equal(trace.read().samples[0][11],-1);
 }finally{trace.dispose();}
});

test('reset clears data and counters; dispose cannot be reset or revived',()=>{
 const trace=createRunFrameTrace({enabled:true,capacity:2});
 trace.record(...frame(500));trace.record(...frame(501));trace.record(...frame(502));trace.record(...frame(-1));
 assert.equal(trace.reset(),true);
 const clean=trace.read();assert.deepEqual(clean.samples,[]);assert.equal(clean.recorded,0);assert.equal(clean.rejected,0);assert.equal(clean.overwritten,0);
 assert.equal(trace.record(...frame(1)),true,'a new recording epoch can start after reset');
 trace.dispose();trace.dispose();assert.equal(trace.reset(),false);assert.equal(trace.record(...frame(2)),false);
 assert.equal(trace.read().enabled,false);assert.deepEqual(trace.read().samples,[]);
});

test('separate scenes never share old samples, cursors, rejections or lifetime',()=>{
 const oldScene=createRunFrameTrace({enabled:true,capacity:1});oldScene.record(...frame(1000));
 const newScene=createRunFrameTrace({enabled:true,capacity:2});assert.deepEqual(newScene.read().samples,[]);
 assert.equal(newScene.record(...frame(1)),true);oldScene.record(...frame(1001));oldScene.dispose();
 assert.deepEqual(newScene.read().samples,[frame(1)]);assert.equal(newScene.read().recorded,1);
 assert.equal(newScene.read().rejected,0);assert.equal(oldScene.record(...frame(1002)),false);
 newScene.dispose();
});
