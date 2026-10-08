import test from 'node:test';
import assert from 'node:assert/strict';
import * as Engine from '../arena/run/engine.mjs';
import {createRunTimeline} from '../arena/run/timeline.mjs';
import {
 createRunTimelineJournal, RUN_TIMELINE_JOURNAL_SCHEMA,
 RUN_TIMELINE_JOURNAL_METHODS, RUN_TIMELINE_JOURNAL_SAMPLE_FIELDS,
 RUN_TIMELINE_JOURNAL_FRAME_FIELDS,
} from '../arena/run/timeline-journal.mjs';
import {makeRunActionReceipt} from '../shared/run-action-receipt.mjs';
import {createRunAnimatedBoostFixture} from './fixtures/run-timeline-animation-fixture.mjs';

const KEY='human',ROOM='journal-room',RULE=Engine.PRACTICE_RULE_VERSION;
const clone=structuredClone;
const options=(roomVersion,receivedAtMs,roomId=ROOM)=>({roomId,roomVersion,receivedAtMs});
function state(course=0){
 const s=Engine.createState(course.toString(16).padStart(8,'0').padEnd(64,'a'),1000,{
  ruleVersion:RULE,startPolicy:Engine.RUN_SCENE_READY_POLICY,
  players:[{key:KEY,seatIndex:0},{key:'bot',seatIndex:1,isBot:true}],
 });
 Engine.armStart(s,1000);return s;
}
function viewAt(s,tick){Engine.tick(s,s.startedAt+Math.ceil(tick*1000/60));return clone(Engine.view(s,KEY));}
const dispatch=(type='jump',seq=1,dispatchedAtMs=40)=>({
 token:`journal-token-${seq}`,roomId:ROOM,playerKey:KEY,request_id:`journal_request_${seq}`,
 seq,type,ruleVersion:RULE,dispatchedAtMs,
});
function recorder(config={}){
 const journal=createRunTimelineJournal(createRunTimeline(),{enabled:true,capacity:256,...config}),results=[];
 function call(method,...args){const result=journal.timeline[method](...args);results.push(clone(result));return result;}
 return {journal,results,call};
}
const finiteOrNull=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
function verifySampleRow(report,row,output,index,sampleNo){
 const actual=Object.fromEntries(report.sampleFields.map((name,i)=>[name,row[i]]));
 assert.equal(actual.commandIndex,index);assert.equal(actual.sampleNo,sampleNo);
 for(const name of report.sampleFields){
  if(name==='commandIndex'||name==='sampleNo')continue;
  if(name.endsWith('Code')){
   const field=name.slice(0,-4),value=field==='mode'||field==='reason'?output?.[field]:output?.pose?.[field];
   assert.equal(report.strings[actual[name]],value??'',name);
  }else{
   const value=name==='poseTick'?output?.pose?.tick:
    ['displayTick','baseTick','baseVersion'].includes(name)?output?.[name]:output?.pose?.[name];
   assert.equal(actual[name],finiteOrNull(value),name);
  }
 }
}
function replay(report,originalResults){
 assert.equal(report.complete,true,report.reason);assert.equal(report.schema,RUN_TIMELINE_JOURNAL_SCHEMA);
 assert.deepEqual(report.methods,RUN_TIMELINE_JOURNAL_METHODS);
 assert.deepEqual(report.sampleFields,RUN_TIMELINE_JOURNAL_SAMPLE_FIELDS);
 const target=createRunTimeline();let sampleNo=0;
 for(let index=0;index<report.commands.length;index++){
  const [methodCode,input,returned]=report.commands[index],method=report.methods[methodCode];
  const result=method==='sample'?target.sample(input):target[method](...clone(report.payloads[input]));
  assert.deepEqual(result,originalResults[index],`replay command ${index} ${method}`);
  if(method==='sample'){
   sampleNo++;assert.equal(returned,sampleNo);verifySampleRow(report,report.samples[sampleNo-1],result,index,sampleNo);
  }else assert.equal(returned,result===true?1:result===false?0:-1);
 }
 assert.equal(report.samples.length,sampleNo);
 return target;
}

test('disabled and nonliteral enable flags preserve controller identity without touching it',()=>{
 const inner=new Proxy({}, {get(){throw Error('disabled wrapper inspected controller');}});
 for(const enabled of [undefined,false,null,0,1,'true']){
  const j=createRunTimelineJournal(inner,{enabled,capacity:'invalid',payloadBytes:-1});
  assert.strictEqual(j.timeline,inner);assert.equal(j.bindFrame(0,0,0,0,0,0),false);
  const report=j.read();assert.equal(report.enabled,false);assert.equal(report.complete,false);
  assert.equal(report.reason,'disabled');assert.ok(Object.isFrozen(report));assert.ok(Object.isFrozen(report.commands));
  j.dispose();j.dispose();assert.strictEqual(j.read(),report);
 }
});

test('exact replay covers real engine input receipts, versions, samples, suspension, scope reset and terminal state',()=>{
 const {journal,results,call}=recorder(),s=state(),first=viewAt(s,100);
 assert.equal(call('receive',first,KEY,options(1,0)),true);
 call('sample',0);call('sample',40);const input=dispatch();assert.equal(call('noteInput',input),true);call('sample',80);
 viewAt(s,108);const accepted=Engine.act(s,KEY,{type:'jump'},s.now);
 const receipt=makeRunActionReceipt({...input,event:accepted.event});
 assert.equal(call('resolveInput',{token:input.token,receipt,resolvedAtMs:130}),true);
 call('receive',clone(Engine.view(s,KEY)),KEY,options(2,130));call('sample',130);call('sample',200);
 const v120=viewAt(s,120);call('receive',v120,KEY,options(3,300));call('sample',300);
 call('suspend','background');assert.equal(call('sample',340).reason,'background');
 call('receive',v120,KEY,options(4,500));assert.equal(call('sample',500).reason,'background');
 call('receive',viewAt(s,131),KEY,options(5,600));assert.equal(call('sample',600).reason,'resume-background');
 const rejected=dispatch('left',2,620);assert.equal(call('noteInput',rejected),true);
 assert.equal(call('resolveInput',{token:'not-the-token',outcome:'rejected',resolvedAtMs:625}),false);
 assert.equal(call('resolveInput',{token:rejected.token,outcome:'rejected',resolvedAtMs:630}),true);
 call('sample',630);assert.equal(call('receive',v120,KEY,options(4,650)),false);
 call('clear');assert.equal(call('sample',700).mode,'fallback');
 const second=state(1);call('receive',viewAt(second,90),KEY,options(1,800,'journal-second-room'));call('sample',800);
 Engine.forfeit(second,[KEY,'bot'],second.now+1);
 call('receive',clone(Engine.view(second,KEY)),KEY,options(2,850,'journal-second-room'));
 assert.equal(call('sample',900).reason,'authoritative-terminal');
 const report=journal.read();assert.equal(report.commands.length,results.length);
 assert.deepEqual(new Set(report.commands.map(c=>report.methods[c[0]])),new Set(RUN_TIMELINE_JOURNAL_METHODS));
 replay(report,results);
});

test('exact replay retains the real 46-tick authority bridge and its expired lease hold',()=>{
 const {journal,results,call}=recorder(),s=state();
 call('receive',viewAt(s,100),KEY,options(1,0));call('sample',0);
 assert.equal(call('sample',650).reason,'projection-expired');call('sample',840);
 call('receive',viewAt(s,146),KEY,options(2,840));assert.equal(call('sample',840).mode,'project');
 call('sample',856.6666667);call('sample',1000);call('sample',1491);
 replay(journal.read(),results);
});

for(const [name,course,start,end] of [['hit',0,270,286],['fall',2,248,264]])test(`real ${name} boundary and causal sample fields replay exactly`,()=>{
 const {journal,results,call}=recorder(),s=state(course);
 call('receive',viewAt(s,start),KEY,options(1,0));call('sample',0);
 const next=viewAt(s,end);assert.ok(next.players[0].hits>0);
 call('receive',next,KEY,options(2,100));
 for(const at of [100,150,166.6666666,166.6666667,200,266.6666667,300,500,650])call('sample',at);
 assert.ok(results.some(r=>r?.pose?.hits>0));replay(journal.read(),results);
});

test('real animated boost reconciliation and duplicate ACK retain exact recorded pose/animation state',()=>{
 const fixture=createRunAnimatedBoostFixture({animation:'jump'}),{journal,results,call}=recorder();
 call('receive',fixture.game,KEY,options(1,0,fixture.dispatch.roomId));call('sample',0);
 assert.equal(call('noteInput',fixture.dispatch),true);call('sample',80);call('sample',100);
 assert.equal(call('resolveInput',{token:fixture.dispatch.token,receipt:fixture.receipt,resolvedAtMs:100}),true);
 const corrected=call('sample',100);assert.ok(corrected.reconciliation);assert.ok(Number.isFinite(corrected.pose.animationTick));
 call('sample',150);call('resolveInput',{token:fixture.dispatch.token,receipt:fixture.receipt,resolvedAtMs:150});
 for(const at of [150,300,650,900])call('sample',at);
 replay(journal.read(),results);
});

function spyController({returns={},sampleResult={mode:'project',reason:null,displayTick:1,baseTick:1,baseVersion:1,pose:{tick:1,distance:2,x:0,y:.1,scale:1}}}={}){
 const calls=[];const inner=Object.fromEntries(RUN_TIMELINE_JOURNAL_METHODS.map(method=>[method,(...args)=>{
  calls.push({method,args});return method==='sample'?sampleResult:Object.hasOwn(returns,method)?returns[method]:true;
 }]));return {inner,calls,sampleResult};
}

test('payloads are copied before the actual call and every read returns fresh mutable copies',()=>{
 const payload={nested:{value:'before'},array:[1,{value:'before'}]},calls=[];
 const spy=spyController();spy.inner.noteInput=input=>{calls.push(input);input.nested.value='inner';return true;};
 const j=createRunTimelineJournal(spy.inner,{enabled:true});assert.equal(j.timeline.noteInput(payload),true);
 assert.strictEqual(calls[0],payload);payload.array[1].value='caller';
 const first=j.read();assert.deepEqual(first.payloads[0],[{nested:{value:'before'},array:[1,{value:'before'}]}]);
 first.payloads[0][0].nested.value='reader';first.commands[0][0]=999;first.strings.push('reader');
 const second=j.read();assert.equal(second.payloads[0][0].nested.value,'before');assert.equal(second.commands[0][0],1);
 assert.ok(!second.strings.includes('reader'));assert.equal(second.complete,true);
});

const invalidPayloads=[
 ['getter',()=>Object.defineProperty({},'value',{enumerable:true,get(){throw Error('getter must not run');}}),'unsupported-payload'],
 ['toJSON getter',()=>Object.defineProperty({},'toJSON',{enumerable:true,get(){throw Error('toJSON must not run');}}),'unsupported-payload'],
 ['toJSON function',()=>({toJSON(){throw Error('toJSON must not run');}}),'unsupported-payload'],
 ['cycle',()=>{const x={};x.self=x;return x;},'shared-or-cyclic-payload'],
 ['shared reference',()=>{const x={};return {left:x,right:x};},'shared-or-cyclic-payload'],
 ['sparse array',()=>Array(2),'unsupported-payload'],
 ['array extra key',()=>Object.assign([1],{extra:2}),'unsupported-payload'],
 ['sparse array hiding an extra key',()=>Object.assign(Array(1),{extra:2}),'unsupported-payload'],
 ['sparse array hiding noncanonical index',()=>Object.assign(Array(1),{'01':2}),'unsupported-payload'],
 ['sparse array hiding negative index',()=>Object.assign(Array(1),{'-1':2}),'unsupported-payload'],
 ['nonenumerable value',()=>Object.defineProperty({},'hidden',{value:1}),'unsupported-payload'],
 ['symbol key',()=>({[Symbol('hidden')]:1}),'unsupported-payload'],
 ['undefined',()=>({value:undefined}),'unsupported-payload'],
 ['BigInt',()=>({value:1n}),'unsupported-payload'],
 ['negative zero',()=>({value:-0}),'unsupported-payload'],
 ['NaN',()=>({value:NaN}),'unsupported-payload'],
 ['Infinity',()=>({value:Infinity}),'unsupported-payload'],
 ['Date',()=>({value:new Date(0)}),'unsupported-payload'],
 ['Map',()=>({value:new Map()}),'unsupported-payload'],
 ['structure bound',()=>Array(131073).fill(null),'payload-structure-limit'],
];
for(const [name,make,reason] of invalidPayloads)test(`${name} marks journal incomplete without reading getters or suppressing actual calls`,()=>{
 const {inner,calls,sampleResult}=spyController(),j=createRunTimelineJournal(inner,{enabled:true});
 assert.equal(j.timeline.noteInput({valid:'prefix'}),true);const prefix=j.read().commands;
 const value=make();assert.equal(j.timeline.noteInput(value),true);assert.strictEqual(calls[1].args[0],value);
 assert.strictEqual(j.timeline.sample(10),sampleResult);assert.equal(j.timeline.suspend('background'),true);
 assert.equal(calls.length,4);assert.equal(j.bindFrame(10,11,0,0,0,0),false);
 const report=j.read();assert.equal(report.complete,false);assert.equal(report.reason,reason);
 assert.deepEqual(report.commands,prefix);assert.equal(report.samples.length,0);
});

for(const [name,make] of [
 ['null from prototype trap',()=>new Proxy({}, {getPrototypeOf(){throw null;}})],
 ['undefined from ownKeys trap',()=>new Proxy({}, {ownKeys(){throw undefined;}})],
 ['null from JSON toJSON lookup',()=>new Proxy({value:1}, {get(target,key){if(key==='toJSON')throw null;return Reflect.get(target,key);}})],
 ['thrown object with throwing message getter',()=>new Proxy({}, {getPrototypeOf(){throw Object.defineProperty({},'message',{get(){throw Error('message getter must not escape');}});}})],
])test(`${name} cannot make diagnostic serialization abort the actual controller call`,()=>{
 const {inner,calls,sampleResult}=spyController(),j=createRunTimelineJournal(inner,{enabled:true});
 const value=make();assert.equal(j.timeline.noteInput(value),true);
 assert.strictEqual(calls[0].args[0],value);assert.strictEqual(j.timeline.sample(5),sampleResult);
 const report=j.read();assert.equal(report.complete,false);assert.equal(typeof report.reason,'string');assert.ok(report.reason.length>0);
 assert.equal(report.commands.length,0);assert.equal(calls.length,2);
});

test('capacity and payload limits reject invalid configurations only when enabled',()=>{
 for(const capacity of [0,-1,1.5,32769,NaN,Infinity,'10'])assert.throws(()=>createRunTimelineJournal({}, {enabled:true,capacity}),RangeError);
 for(const payloadBytes of [0,-1,1.5,16*1024*1024+1,NaN,Infinity,'10'])assert.throws(()=>createRunTimelineJournal({}, {enabled:true,payloadBytes}),RangeError);
 for(const capacity of [1,32768]){const j=createRunTimelineJournal({}, {enabled:true,capacity,payloadBytes:1});assert.equal(j.read().complete,true);j.dispose();}
});

test('command capacity keeps the complete prefix and continues forwarding real methods',()=>{
 const {inner,calls,sampleResult}=spyController(),j=createRunTimelineJournal(inner,{enabled:true,capacity:2});
 j.timeline.noteInput({token:'first'});j.timeline.sample(1);const before=j.read();
 assert.strictEqual(j.timeline.sample(2),sampleResult);j.timeline.clear();j.timeline.receive({},'k',{});
 const after=j.read();assert.equal(calls.length,5);assert.equal(after.reason,'command-capacity');assert.equal(after.complete,false);
 assert.deepEqual(after.commands,before.commands);assert.deepEqual(after.samples,before.samples);assert.deepEqual(after.payloads,before.payloads);
});

test('UTF-16 payload budget has an exact boundary and never evicts earlier payloads',()=>{
 const input={value:'😀汉字'},bytes=JSON.stringify([input]).length*2;
 const {inner,calls}=spyController(),j=createRunTimelineJournal(inner,{enabled:true,payloadBytes:bytes});
 j.timeline.noteInput(input);const before=j.read();assert.equal(before.complete,true);assert.equal(before.payloadSize,bytes);
 j.timeline.noteInput({next:true});j.timeline.clear();const after=j.read();
 assert.equal(calls.length,3);assert.equal(after.reason,'payload-capacity');assert.deepEqual(after.payloads,before.payloads);assert.equal(after.payloadSize,bytes);
 const tiny=createRunTimelineJournal(inner,{enabled:true,payloadBytes:bytes-1});tiny.timeline.noteInput(input);
 assert.equal(tiny.read().reason,'payload-capacity');assert.equal(tiny.read().commands.length,0);
});

for(const at of [NaN,Infinity,-Infinity,undefined,'10'])test(`unsupported sample timestamp ${String(at)} keeps the actual sample result`,()=>{
 const {inner,calls,sampleResult}=spyController(),j=createRunTimelineJournal(inner,{enabled:true});
 assert.strictEqual(j.timeline.sample(at),sampleResult);assert.strictEqual(calls[0].args[0],at);
 assert.equal(j.read().complete,false);assert.equal(j.read().reason,'unsupported-sample-time');assert.equal(j.read().samples.length,0);
});

test('non-sample true/false/undefined returns are preserved exactly and other returns fail the recording',()=>{
 const unusual={opaque:true},{inner}=spyController({returns:{receive:true,noteInput:false,resolveInput:undefined,suspend:unusual,clear:undefined}});
 const j=createRunTimelineJournal(inner,{enabled:true});
 assert.equal(j.timeline.receive({},'k',{}),true);assert.equal(j.timeline.noteInput({}),false);assert.equal(j.timeline.resolveInput({}),undefined);
 assert.deepEqual(j.read().commands.map(c=>c[2]),[1,0,-1]);assert.strictEqual(j.timeline.suspend('background'),unusual);
 assert.equal(j.read().reason,'unsupported-controller-result');assert.equal(j.timeline.clear(),undefined);
});

for(const method of RUN_TIMELINE_JOURNAL_METHODS)test(`a thrown ${method} error is rethrown unchanged and invalidates replay`,()=>{
 const error=new Error('original-controller-failure'),{inner,calls}=spyController();
 inner[method]=(...args)=>{calls.push({method,args});throw error;};
 const j=createRunTimelineJournal(inner,{enabled:true});
 const args={receive:[{},'k',{}],noteInput:[{}],resolveInput:[{}],sample:[10],suspend:['background'],clear:[]}[method];
 assert.throws(()=>j.timeline[method](...args),e=>e===error);assert.equal(calls.length,1);
 const report=j.read();assert.equal(report.complete,false);assert.equal(report.reason,'controller-threw');
 assert.equal(report.commands.length,1);assert.equal(report.commands[0][2],null);assert.equal(report.samples.length,0);
 assert.equal(j.bindFrame(10,11,0,0,0,0),false);
});

test('frame rows bind exact renderer values to the latest sample and read copies cannot change buffers',()=>{
 const {inner}=spyController(),j=createRunTimelineJournal(inner,{enabled:true});
 j.timeline.noteInput({});j.timeline.sample(10);assert.equal(j.bindFrame(10,13,1,2,3,4),true);
 j.timeline.sample(20);assert.equal(j.bindFrame(20,24,5,6,7,8),true);
 const first=j.read();assert.deepEqual(first.frameFields,RUN_TIMELINE_JOURNAL_FRAME_FIELDS);
 assert.deepEqual(first.frames.map(row=>Object.fromEntries(first.frameFields.map((k,i)=>[k,row[i]]))),[
  {sampleNo:1,frameAtMs:10,renderReturnedAtMs:13,runnerX:1,runnerY:2,runnerZ:3,cameraZ:4},
  {sampleNo:2,frameAtMs:20,renderReturnedAtMs:24,runnerX:5,runnerY:6,runnerZ:7,cameraZ:8},
 ]);
 first.frames[0][0]=999;first.samples[0][0]=999;
 assert.equal(j.read().frames[0][0],1);assert.equal(j.read().samples[0][0],1);
});

test('binding without a sample fails closed but does not stop the controller',()=>{
 const {inner,calls}=spyController(),j=createRunTimelineJournal(inner,{enabled:true});
 assert.equal(j.bindFrame(1,2,0,0,0,0),false);j.timeline.sample(2);
 assert.equal(j.read().reason,'invalid-render-binding');assert.equal(j.read().frames.length,0);assert.equal(calls.length,1);
});

for(const args of [[10,9,0,0,0,0],[10,11,NaN,0,0,0],[10,11,0,Infinity,0,0],[10,11,0,0,0,undefined]])test(`invalid renderer binding ${JSON.stringify(args)} is never a complete recording`,()=>{
 const {inner}=spyController(),j=createRunTimelineJournal(inner,{enabled:true});j.timeline.sample(10);
 assert.equal(j.bindFrame(...args),false);assert.equal(j.read().complete,false);assert.equal(j.read().reason,'invalid-render-binding');
 assert.equal(j.read().frames.length,0);
});

test('frame capacity cannot overwrite a prior sample binding',()=>{
 const {inner}=spyController(),j=createRunTimelineJournal(inner,{enabled:true,capacity:1});j.timeline.sample(0);
 assert.equal(j.bindFrame(0,1,1,2,3,4),true);const first=j.read().frames;
 assert.equal(j.bindFrame(0,2,9,9,9,9),false);assert.equal(j.read().reason,'frame-capacity');assert.deepEqual(j.read().frames,first);
});

test('result string bounds mark incomplete without suppressing real samples',()=>{
 let count=0;const {inner}=spyController();inner.sample=()=>({mode:'project',reason:`unique-${count++}`,pose:null});
 const j=createRunTimelineJournal(inner,{enabled:true,capacity:256});for(let i=0;i<140;i++)assert.equal(j.timeline.sample(i).reason,`unique-${i}`);
 assert.equal(count,140);assert.equal(j.read().reason,'result-string-limit');assert.ok(j.read().strings.length<=128);
 const malformed=spyController({sampleResult:{mode:'x'.repeat(161),pose:null}}),other=createRunTimelineJournal(malformed.inner,{enabled:true});
 assert.strictEqual(other.timeline.sample(0),malformed.sampleResult);assert.equal(other.read().reason,'unsupported-result');
});

test('dispose is idempotent, drops retained diagnostics, and all controller calls continue unchanged',()=>{
 const {inner,calls,sampleResult}=spyController(),j=createRunTimelineJournal(inner,{enabled:true});
 j.timeline.noteInput({private:'copied'});j.timeline.sample(10);j.bindFrame(10,11,0,0,0,0);const ownedCopy=j.read();
 j.dispose();j.dispose();const empty=j.read();assert.equal(empty.enabled,false);assert.equal(empty.complete,false);
 assert.equal(empty.commands.length,0);assert.equal(empty.samples.length,0);assert.equal(empty.frames.length,0);
 assert.equal(j.timeline.receive({},'k',{}),true);assert.equal(j.timeline.noteInput({}),true);assert.equal(j.timeline.resolveInput({}),true);
 assert.strictEqual(j.timeline.sample(20),sampleResult);assert.equal(j.timeline.suspend('background'),true);assert.equal(j.timeline.clear(),true);
 assert.equal(j.bindFrame(20,21,0,0,0,0),false);assert.strictEqual(j.read(),empty);assert.equal(calls.length,8);
 assert.equal(ownedCopy.payloads[0][0].private,'copied','previous caller-owned export remains its own copy');
});
