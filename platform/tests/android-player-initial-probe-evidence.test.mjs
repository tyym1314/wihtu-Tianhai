import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {INITIAL_PROBE_FAILURE_LIMITS,readInitialPerformanceProbe,capturePerformanceRoundFailure,createPhysicalNetworkCollector} from '../scripts/android-player-performance.mjs';
import {verifyProbe,hash} from '../scripts/android-player-performance-checks.mjs';

// Deterministic collector/CDP-return fixtures only; no browser, device, network
// or performance sample is run by this suite.
const origin='https://owned-probe.example',game='run',nonce='owned-initial-probe',documentId='a'.repeat(32),url=origin+'/play/run',entryUrl=origin+'/player';
const binding={frameId:'own-game-frame',contextId:7,url};
const frame=(at=20,ms=10)=>({at,ms,visible:true,active:false,moving:false,eligibleDurationMs:0});
const probe=(frames=[frame()])=>({schema:'android-physical-performance-v1',nonce,documentId,url,timeOrigin:1000,frames,longTasks:[],gestures:[],visibility:[],dropped:0,active:false,moving:false,validUntil:0,stopped:false,longTaskSupported:true});
function fixture(value){
 const round={id:'run-cold-1',entry:null,loadTimeline:{startEpochMs:500}},calls=[];
 const collector={async bind(){calls.push('bind');return binding;},async evaluate(expression){calls.push(['evaluate',expression]);assert.deepEqual(round.initialProbeValidation.binding,binding);assert.equal(round.initialProbeValidation.probeIdentityVerified,false);return value;},actions:[],actionRequestDiagnostics:()=>[]};
 return {value,round,calls,collector,args:{round,collector,origin,game,nonce}};
}
const authorizedFields=round=>['documentId','documentTimeOrigin','context','probe'].filter(key=>Object.hasOwn(round,key));
async function rejected(f,pattern){let error;await assert.rejects(readInitialPerformanceProbe(f.args),value=>{error=value;assert.match(value.message,pattern);return true;});return error;}

test('first bind is retained before the sole initial read; success returns the original verified probe without moving scope or clocks',async()=>{
 const value=probe(),before=JSON.stringify(value),f=fixture(value),returned=await readInitialPerformanceProbe(f.args);
 assert.equal(returned,value);assert.deepEqual(f.calls,['bind',['evaluate','(()=>globalThis.__oasisPhysicalPerf)()']]);assert.equal(f.round.initialProbeValidation.probeIdentityVerified,true);assert.equal(f.round.initialProbeValidation.failureEvidence,undefined);
 assert.deepEqual(authorizedFields(f.round),[]);assert.equal(f.round.loadTimeline.startEpochMs,500);assert.equal(f.round.entry,null);assert.equal(JSON.stringify(value),before);assert.notEqual(f.round.initialProbeValidation.binding,binding);
});

test('zero RAF interval stays fatal and is retained with exact original JSON, field types and neighboring rows, without a second read',async()=>{
 const value=probe([frame(10,10),frame(10,0),frame(30,20)]),before=JSON.stringify(value),f=fixture(value),error=await rejected(f,/INVALID_FRAME_OBSERVATION/);
 assert.equal(error.code,'ERR_ASSERTION');assert.deepEqual(f.calls,['bind',['evaluate','(()=>globalThis.__oasisPhysicalPerf)()']]);assert.equal(f.round.initialProbeValidation.probeIdentityVerified,false);assert.deepEqual(authorizedFields(f.round),[]);
 const evidence=f.round.initialProbeValidation.failureEvidence;assert.equal(evidence.rawProbe.complete,true);assert.equal(evidence.rawProbe.json,before);assert.equal(evidence.rawProbe.sha256,hash(before));assert.equal(evidence.rawProbe.bytes,Buffer.byteLength(before));assert.equal(evidence.invalidRowsDetectedInInspectedFrames,1);
 assert.deepEqual(evidence.invalidRows,[{index:1,rowType:'object',fieldTypes:{at:'number',ms:'number',visible:'boolean',active:'boolean',moving:'boolean'},nonfiniteNumbers:{},invalidFields:['ms:not-positive']}]);
 assert.deepEqual(evidence.adjacentRows.map(row=>[row.index,JSON.parse(row.raw.json)]),value.frames.map((row,index)=>[index,row]));assert.equal(JSON.parse(evidence.rawProbe.json).frames[1].ms,0);assert.equal(JSON.stringify(value),before);
 assert.throws(()=>verifyProbe(value,{origin,game,nonce}),/INVALID_FRAME_OBSERVATION/);
});

test('nonfinite, missing, wrong-type and null rows retain diagnostic types and JSON-lossy number facts without correcting the input',async()=>{
 const missing=frame();delete missing.active;
 const value=probe([frame(20,NaN),{...frame(),at:Infinity,visible:'true',moving:0},missing,null,frame(40,-5)]),f=fixture(value);await rejected(f,/INVALID_FRAME_OBSERVATION/);
 const evidence=f.round.initialProbeValidation.failureEvidence;assert.deepEqual(evidence.invalidRows.map(row=>row.index),[0,1,2,3,4]);assert.deepEqual(evidence.invalidRows[0].nonfiniteNumbers,{ms:'NaN'});assert.deepEqual(evidence.invalidRows[1].nonfiniteNumbers,{at:'Infinity'});assert.deepEqual(evidence.invalidRows[4].invalidFields,['ms:not-positive']);
 assert.equal(evidence.invalidRows[0].fieldTypes.ms,'number');assert.equal(evidence.invalidRows[1].fieldTypes.visible,'string');assert.equal(evidence.invalidRows[1].fieldTypes.moving,'number');assert.equal(evidence.invalidRows[2].fieldTypes.active,'undefined');assert.equal(evidence.invalidRows[3].rowType,'null');
 assert.equal(evidence.rawProbe.json,JSON.stringify(value));assert.equal(JSON.parse(evidence.rawProbe.json).frames[0].ms,null);assert.equal(JSON.parse(evidence.rawProbe.json).frames[4].ms,-5);assert.ok(Number.isNaN(value.frames[0].ms));assert.equal(value.frames[1].at,Infinity);assert.equal(Object.hasOwn(value.frames[2],'active'),false);assert.equal(value.frames[3],null);assert.equal(value.frames[4].ms,-5);
});

test('unverified raw document identity never authorizes later failure-capture DOM/probe reads, including owner-validation failures',async()=>{
 for(const value of [probe([frame(20,0)]),{...probe(),nonce:'foreign-owner'}]){
  const f=fixture(value),error=await rejected(f,/INVALID_FRAME_OBSERVATION|PROBE_OWNER_CHANGED/),initialCalls=f.calls.length,evidence=f.round.initialProbeValidation.failureEvidence;
  assert.equal(JSON.parse(evidence.rawProbe.json).documentId,documentId);assert.equal(f.round.initialProbeValidation.probeIdentityVerified,false);
  const observation=await capturePerformanceRoundFailure({...f.args,error,state:{},baseline:{},now:()=>9000});
  assert.equal(f.calls.length,initialCalls);assert.deepEqual(authorizedFields(f.round),[]);assert.equal(observation.probeError,'No previously bound owned game document');assert.equal(observation.domError,'No previously bound owned game document');assert.equal(f.round.error,error.message);assert.equal(f.round.initialProbeValidation.failureEvidence,evidence);
  if(error.message.startsWith('PROBE_OWNER_CHANGED'))assert.equal(evidence.invalidRowsDetectedInInspectedFrames,0);
 }
});

test('oversize raw JSON and adjacent rows use exact bounded UTF-8 byte prefixes; invalid-row omissions are explicit',async()=>{
 const frames=Array.from({length:100},(_,index)=>frame(index*10,index%3===1?0:10));frames[2].extra='界'.repeat(3000);
 const value={...probe(frames),extra:'界'.repeat(INITIAL_PROBE_FAILURE_LIMITS.rawProbeBytes)},f=fixture(value);await rejected(f,/INVALID_FRAME_OBSERVATION/);
 const evidence=f.round.initialProbeValidation.failureEvidence,bytes=Buffer.from(JSON.stringify(value)),raw=evidence.rawProbe;
 assert.equal(raw.complete,false);assert.equal(raw.serialization,'json-byte-prefix-base64');assert.deepEqual(Buffer.from(raw.base64,'base64'),bytes.subarray(0,INITIAL_PROBE_FAILURE_LIMITS.rawProbeBytes));assert.equal(raw.sha256,hash(bytes));assert.equal(raw.bytes,bytes.length);assert.equal(raw.retainedBytes,INITIAL_PROBE_FAILURE_LIMITS.rawProbeBytes);assert.equal(raw.omittedBytes,bytes.length-raw.retainedBytes);assert.equal(raw.json,undefined);
 assert.equal(evidence.invalidRowsDetectedInInspectedFrames,33);assert.equal(evidence.invalidRows.length,16);assert.equal(evidence.invalidRowsOmitted,17);assert.equal(evidence.adjacentRows.length,INITIAL_PROBE_FAILURE_LIMITS.adjacentRows);
 const neighbor=evidence.adjacentRows.find(row=>row.index===2).raw,neighborBytes=Buffer.from(JSON.stringify(frames[2]));assert.equal(neighbor.complete,false);assert.deepEqual(Buffer.from(neighbor.base64,'base64'),neighborBytes.subarray(0,INITIAL_PROBE_FAILURE_LIMITS.adjacentRowBytes));
 for(const row of evidence.adjacentRows)assert.ok(row.raw.retainedBytes<=INITIAL_PROBE_FAILURE_LIMITS.adjacentRowBytes);assert.ok(Buffer.byteLength(JSON.stringify(evidence))<512*1024);
});

test('diagnostic scan caps its scope and does not claim uninspected rows are valid after the original array-bound failure',async()=>{
 const length=INITIAL_PROBE_FAILURE_LIMITS.inspectedFrames+3,frames=Array(length).fill(frame());frames[0]=frame(10,0);frames[length-1]=frame(20,0);
 const f=fixture(probe(frames));await rejected(f,/PROBE_BOUND_EXCEEDED/);const evidence=f.round.initialProbeValidation.failureEvidence;
 assert.equal(evidence.frameCount,length);assert.equal(evidence.inspectedFrames,INITIAL_PROBE_FAILURE_LIMITS.inspectedFrames);assert.equal(evidence.uninspectedFrames,3);assert.equal(evidence.invalidRowsDetectedInInspectedFrames,1);assert.deepEqual(evidence.invalidRows.map(row=>row.index),[0]);assert.equal(evidence.rawProbe.complete,false);assert.deepEqual(authorizedFields(f.round),[]);
});

test('diagnostic serialization failure preserves the original validation error and remains explicitly unavailable',async()=>{
 const value={...probe(),nonce:'foreign-owner',unsupported:1n},f=fixture(value),error=await rejected(f,/PROBE_OWNER_CHANGED/);
 assert.equal(error.code,'ERR_ASSERTION');assert.equal(f.round.initialProbeValidation.validationError.message,error.message.slice(0,256));assert.match(f.round.initialProbeValidation.evidenceError,/BigInt/);assert.equal(f.round.initialProbeValidation.failureEvidence,undefined);assert.equal(f.round.initialProbeValidation.probeIdentityVerified,false);assert.deepEqual(authorizedFields(f.round),[]);
 const original=Object.assign(Error('original validation property read'),{code:'ORIGINAL_VALIDATION_ERROR'}),unreadable=probe();Object.defineProperty(unreadable,'schema',{enumerable:true,get(){throw original;}});const g=fixture(unreadable);
 await assert.rejects(readInitialPerformanceProbe(g.args),value=>value===original);assert.equal(g.round.initialProbeValidation.validationError.code,original.code);assert.equal(g.round.initialProbeValidation.evidenceError,original.message);assert.equal(g.round.initialProbeValidation.probeIdentityVerified,false);assert.deepEqual(authorizedFields(g.round),[]);
});

test('real collector bind uses the original Page frame tree/default realm and its sole CDP return is the failure evidence',async()=>{
 const cdp=new EventEmitter(),calls=[],value=probe([frame(20,0)]),round={};
 cdp.send=async(method,args)=>{calls.push({method,args});if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'top',url:entryUrl},childFrames:[{frame:{id:binding.frameId,parentId:'top',url}}]}};if(method==='Runtime.evaluate')return {result:{value}};return {};};cdp.detach=async()=>{};
 const collector=await createPhysicalNetworkCollector({context:{async newCDPSession(){return cdp;}},page:{url:()=>entryUrl},origin,game,state:{},baseline:{},manifest:{},nonce,round,entryUrl});
 cdp.emit('Page.frameNavigated',{frame:{id:binding.frameId,parentId:'top',url}});cdp.emit('Runtime.executionContextCreated',{context:{id:99,origin,auxData:{isDefault:false,frameId:binding.frameId}}});cdp.emit('Runtime.executionContextCreated',{context:{id:binding.contextId,origin,auxData:{isDefault:true,frameId:binding.frameId}}});
 await assert.rejects(readInitialPerformanceProbe({collector,round,origin,game,nonce}),/INVALID_FRAME_OBSERVATION/);assert.deepEqual(round.initialProbeValidation.binding,binding);assert.equal(round.initialProbeValidation.failureEvidence.rawProbe.json,JSON.stringify(value));
 const reads=calls.filter(row=>row.method==='Runtime.evaluate');assert.equal(reads.length,1);assert.deepEqual(reads[0].args,{expression:'(()=>globalThis.__oasisPhysicalPerf)()',contextId:binding.contextId,returnByValue:true,awaitPromise:true});await collector.close();assert.equal(cdp.listenerCount('Runtime.executionContextCreated'),0);assert.deepEqual(collector.errors,[]);
});

test('actual entry callsite validates before original verified scope assignments and retains the cold start line',async()=>{
 const source=await readFile(new URL('../scripts/android-player-performance.mjs',import.meta.url),'utf8'),readAt=source.indexOf('const probe=await readInitialPerformanceProbe({collector,round,origin,game,nonce});'),documentAt=source.indexOf('round.documentId=probe.documentId;',readAt),clockAt=source.indexOf('round.documentTimeOrigin=probe.timeOrigin;',readAt),contextAt=source.indexOf('round.context=await collector.bind();',readAt);
 assert.ok(readAt>=0&&documentAt>readAt&&clockAt>documentAt&&contextAt>clockAt);const start=source.split('\n').find(line=>line.includes('const start=Date.now();round.startedAt='))+'\n';assert.equal(hash(start),'3765c4dd2baa96efc9321a4a92e35001df6d9feca335bc062e9e8a218bcaab2c');
});
