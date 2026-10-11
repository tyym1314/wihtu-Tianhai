import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FRAMETIMELINE_TOOL,frameTimelineCaptureConfig,frameTimelineSql,parseFrameTimelineCsv,readFrameTimelineTrace,analyzeFrameTimeline} from '../scripts/android-player-frametimeline.mjs';

const sha=raw=>createHash('sha256').update(raw).digest('hex');
const scope={serial:'46dcfd25',packageName:'com.tianyahuyu.oasis.player.qa',uid:10416,androidUserId:0,pid:91,startTicks:'900719925',clockTicksPerSecond:100,
 bootId:'8c2328c2-73fb-49dc-9aa1-9417ed9954f9',layerName:'com.tianyahuyu.oasis.player.qa/MainActivity#42',surfaceFlingerPid:72,surfaceFlingerUid:1000,surfaceFlingerStartTicks:'23',versionCode:1};
function fixture(){
 const start=9007199254740993n,appFrames=[],displayFrames=[],flows=[];
 for(let index=0;index<3;index++){const t=start+BigInt(index)*16666667n,id=index+1,displayId=index+101;
  appFrames.push({id,upid:1,ts:String(t),dur:'6000000',surfaceToken:String(index+10),displayToken:String(index+90),layerName:scope.layerName,presentType:'On-time Present',isBuffer:'Yes'});
  displayFrames.push({id:displayId,upid:2,ts:String(t+8000000n),dur:'4000000',surfaceToken:null,displayToken:String(index+90),layerName:null,presentType:'On-time Present'});flows.push({id:index+1,sliceOut:id,sliceIn:displayId});
 }
 const query={schema:'android-frametimeline-query-v1',processes:[{upid:1,pid:scope.pid,uid:10416,androidUserId:0,startNs:'9007199250000000',endNs:null,cmdline:scope.packageName},
  {upid:2,pid:72,uid:1000,androidUserId:0,startNs:'230000000',endNs:null,cmdline:'/system/bin/surfaceflinger'}],packages:[{packageName:scope.packageName,uid:10416,versionCode:1},{packageName:scope.packageName,uid:1010416,versionCode:1}],
  appFrames,displayFrames,flows,clockSnapshots:[{clockName:'BOOTTIME',clockId:6,clockValue:String(start),ts:String(start)}],stats:[{name:'trace_size_bytes',severity:'info',value:'2048'}]};
 const tracePin={sha256:'a'.repeat(64)},toolPin={sha256:FRAMETIMELINE_TOOL.sha256},captureProof={exitCode:0,bootId:scope.bootId,traceSha256:tracePin.sha256,traceClock:'BOOTTIME',durationMs:120000,configurationSha256:sha(frameTimelineCaptureConfig({durationMs:120000}))};
 return {scope,scopeAfter:scope,query,tracePin,toolPin,captureProof};
}

test('capture preparation retains complete clock/process/frames without phone actions or guessed CLK_TCK',()=>{
 const config=frameTimelineCaptureConfig();assert.match(config,/record_process_age: true/);assert.match(config,/BUILTIN_CLOCK_BOOTTIME/);assert.match(config,/fill_policy: DISCARD/);assert.doesNotMatch(config,/adb|shell|atrace_apps/);
 assert.match(frameTimelineCaptureConfig({durationMs:1020000}),/duration_ms: 1020000/);assert.throws(()=>frameTimelineCaptureConfig({durationMs:1800001}));assert.throws(()=>frameTimelineSql({...scope,clockTicksPerSecond:null}));
 const sql=frameTimelineSql(scope);assert.match(sql,/FROM flow/);assert.match(sql,/CAST\(ts AS TEXT\)/);assert.match(sql,/FROM stats/);assert.doesNotMatch(sql,/strftime|ABS\(|LIMIT|ORDER BY.*dur DESC/);
});
test('exact Surface/Display tokens plus original flow prove OS intervals with nanosecond precision',()=>{
 const value=fixture(),result=analyzeFrameTimeline(value);assert.equal(result.status,'os-frame-timeline-proven');assert.equal(result.frames.length,3);assert.equal(result.intervals.length,2);assert.equal(result.intervals[0].ns,'16666667');
 assert.equal(result.frames[0].presentNs,'9007199266740993');assert.equal(result.physicalPanelPresent,false);assert.equal(result.localFeedbackMeasured,false);assert.equal(result.continuousGameWindowBound,false);assert.deepEqual(result.originalQuery,value.query);
});
test('duplicate/reused process identity, clone UID, wrong package/layer and producer clock mismatches are insufficient',()=>{
 for(const kind of ['pid-reuse','uid','ticks','clone','missing-after','package','layer','surfaceview','boot','clock','exit','loss']){
  const value=structuredClone(fixture());
  if(kind==='pid-reuse')value.query.processes.push({...value.query.processes[0],upid:99});
  if(kind==='uid')value.query.processes[0].uid=1010416;
  if(kind==='ticks')value.query.processes[0].startNs='9007199250000001';
  if(kind==='clone')value.scopeAfter.uid=1010416;
  if(kind==='missing-after')delete value.scopeAfter;
  if(kind==='package')value.query.packages[0].versionCode=2;
  if(kind==='layer')value.scope.layerName+='foreign';
  if(kind==='surfaceview'){value.scope.layerName='SurfaceView';value.query.appFrames.forEach(f=>f.layerName='SurfaceView');}
  if(kind==='boot')value.captureProof.bootId='00000000-0000-0000-0000-000000000000';
  if(kind==='clock')value.captureProof.traceClock='REALTIME';
  if(kind==='exit')value.captureProof.exitCode=1;
  if(kind==='loss')value.query.stats.push({name:'traced_buf_chunks_discarded',severity:'info',value:'1'});
  assert.equal(analyzeFrameTimeline(value).osFrameTimelineProven,false,kind);
 }
});
test('unknown, unfinished, token ambiguous or mismatched original flows remain retained and insufficient',()=>{
 for(const kind of ['unknown','unfinished','duplicate-display','flow-wrong','flow-missing','not-buffer']){
  const value=fixture();
  if(kind==='unknown')value.query.appFrames[1].presentType='Unknown Present';
  if(kind==='unfinished')value.query.appFrames[1].dur='-1';
  if(kind==='duplicate-display')value.query.displayFrames.push({...value.query.displayFrames[1],id:901});
  if(kind==='flow-wrong')value.query.flows[1].sliceIn=101;
  if(kind==='flow-missing')value.query.flows.splice(1,1);
  if(kind==='not-buffer')value.query.appFrames[1].isBuffer='No';
  const result=analyzeFrameTimeline(value);assert.equal(result.osFrameTimelineProven,false,kind);assert.equal(result.frames.length,3,kind);assert.equal(result.unknownFrames,1,kind);assert.deepEqual(result.originalQuery,value.query);
 }
});
test('OS dropped frame is not silently subtracted from the original retained timeline',()=>{
 const value=fixture();value.query.appFrames[1].presentType='Dropped Frame';const result=analyzeFrameTimeline(value);
 assert.equal(result.osFrameTimelineProven,true);assert.equal(result.droppedFrames,1);assert.equal(result.frames.length,3);assert.equal(result.frames[1].issue,'OS_DROPPED_FRAME');assert.equal(result.intervals[0].ns,'33333334');assert.equal(result.physicalPanelPresent,false);
});
test('native single-cell CSV parser retains precision and refuses extraneous or malformed results',()=>{
 const query=fixture().query,raw=Buffer.from('"proof"\n"'+JSON.stringify(query)+'"\n\n');assert.deepEqual(parseFrameTimelineCsv(raw),query);
 for(const value of [Buffer.concat([raw,Buffer.from('another row\n')]),Buffer.from('"proof"\nnull\n'),Buffer.from('"proof"\n"{}"\n')])assert.throws(()=>parseFrameTimelineCsv(value));
});
test('actual pinned native v58.2 SQL executes on a local empty fixture without promoting it to device evidence',async(t)=>{
 const toolPath=fileURLToPath(new URL('../review/android-player-20261010/root-perfetto-analysis-tool-0nkg6fng/trace_processor_shell-v58.2-mac-arm64',import.meta.url));
 try{await access(toolPath);}catch{t.skip('official native analysis artifact absent');return;}
 const directory=await mkdtemp(join(tmpdir(),'android-frametimeline-unit-'));try{const tracePath=join(directory,'empty.trace');await writeFile(tracePath,Buffer.alloc(0));
  const receipt=await readFrameTimelineTrace({toolPath,tracePath,traceSha256:sha(Buffer.alloc(0)),scope});assert.equal(receipt.exitCode,0);assert.deepEqual(receipt.query.appFrames,[]);assert.equal(receipt.toolPin.sha256,FRAMETIMELINE_TOOL.sha256);
  assert.equal(analyzeFrameTimeline({...fixture(),query:receipt.query,tracePin:receipt.tracePin,toolPin:receipt.toolPin}).osFrameTimelineProven,false);
 }finally{await rm(directory,{recursive:true,force:true});}
});
