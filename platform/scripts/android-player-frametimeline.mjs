/** Local-only original Perfetto FrameTimeline analysis. No phone/ADB, trace
 * capture, screenshots, nearest-time joins, frame subtraction or gate changes.
 * OS display completion is supplementary evidence, not optical presentation or
 * proof that a particular CDP PNG / command was the displayed frame.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,isAbsolute} from 'node:path';

const execute=promisify(execFile),sha=raw=>createHash('sha256').update(raw).digest('hex');
export const FRAMETIMELINE_TOOL=Object.freeze({version:'Perfetto v58.2-add693d8b',bytes:13597976,
 sha256:'d29864d1ba3b36855527bb1b0ca3aa7f703cdce338b9680bb922c5c151b358fa'});
const integer=(value,code)=>{assert.ok(typeof value==='string'&&/^[0-9]+$/.test(value),code);return BigInt(value);};
const identityKeys=['dev','ino','mode','uid','gid','size','nlink','mtimeNs','ctimeNs'];
const statPin=s=>Object.fromEntries(identityKeys.map(key=>[key,s[key].toString()]));
const equal=(a,b)=>assert.deepEqual(a,b,'FRAMETIMELINE_ORIGINAL_FILE_CHANGED');

function assertScope(scope){
 assert.equal(scope?.serial,'46dcfd25','FRAMETIMELINE_PHYSICAL_SERIAL_REQUIRED');assert.equal(scope.packageName,'com.tianyahuyu.oasis.player.qa','FRAMETIMELINE_QA_PACKAGE_REQUIRED');
 assert.equal(scope.uid,10416,'FRAMETIMELINE_EXACT_UID_REQUIRED');assert.equal(scope.androidUserId,0,'FRAMETIMELINE_CURRENT_USER_REQUIRED');
 assert.ok(Number.isSafeInteger(scope.pid)&&scope.pid>0,'FRAMETIMELINE_MAIN_PID_REQUIRED');integer(scope.startTicks,'FRAMETIMELINE_START_TICKS_REQUIRED');
 assert.ok(Number.isSafeInteger(scope.clockTicksPerSecond)&&scope.clockTicksPerSecond>0,'FRAMETIMELINE_ACTUAL_CLK_TCK_REQUIRED');
 assert.match(scope.bootId??'',/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,'FRAMETIMELINE_BOOT_ID_REQUIRED');
 assert.ok(typeof scope.layerName==='string'&&scope.layerName.length>0&&scope.layerName.length<=1024&&!scope.layerName.includes('\0'),'FRAMETIMELINE_EXACT_LAYER_REQUIRED');
 assert.ok(Number.isSafeInteger(scope.surfaceFlingerPid)&&scope.surfaceFlingerPid>0&&scope.surfaceFlingerPid!==scope.pid,'FRAMETIMELINE_SF_PID_REQUIRED');
 assert.ok(Number.isSafeInteger(scope.surfaceFlingerUid)&&scope.surfaceFlingerUid>=0,'FRAMETIMELINE_SF_UID_REQUIRED');integer(scope.surfaceFlingerStartTicks,'FRAMETIMELINE_SF_IDENTITY_REQUIRED');
 assert.ok(Number.isSafeInteger(scope.versionCode)&&scope.versionCode>0,'FRAMETIMELINE_APK_VERSION_REQUIRED');
}

/** A preparation string only. The operator must save these exact bytes and
 * capture the trace independently, including producer/exit/boot/process proof.
 * All trace phases remain recorded. This module does not label game motion.
 */
export function frameTimelineCaptureConfig({durationMs=120000}={}){
 // A bounded trace may include pre/post proof around a full 15-minute sample.
 // This is a capture bound, never a reduced game sample requirement.
 assert.ok(Number.isSafeInteger(durationMs)&&durationMs>=1000&&durationMs<=1800000,'FRAMETIMELINE_DURATION_BOUND');
 return `buffers { size_kb: 131072 fill_policy: DISCARD }
duration_ms: ${durationMs}
prefer_suspend_clock_for_duration: true
write_into_file: true
file_write_period_ms: 1000
builtin_data_sources { primary_trace_clock: BUILTIN_CLOCK_BOOTTIME snapshot_interval_ms: 1000 }
data_sources { config { name: "android.surfaceflinger.frametimeline" target_buffer: 0 } }
data_sources { config { name: "android.packages_list" target_buffer: 0 } }
data_sources { config { name: "linux.process_stats" target_buffer: 0
  process_stats_config { scan_all_processes_on_start: true record_process_age: true proc_stats_poll_ms: 1000 } } }
`;
}

const literal=value=>"'"+value.replaceAll("'","''")+"'";
/** The pinned processor creates original Surface→Display flows from the actual
 * display token. Both raw tokens and the original flow must agree uniquely.
 * All candidate app layers are retained so a selector cannot hide ambiguity.
 */
export function frameTimelineSql(scope){
 assertScope(scope);
 const pids=`${scope.pid},${scope.surfaceFlingerPid}`,frames=`SELECT * FROM actual_frame_timeline_slice WHERE upid IN (SELECT upid FROM process WHERE pid=${scope.pid})`;
 const frameRow=`json_object('id',id,'upid',upid,'ts',CAST(ts AS TEXT),'dur',CAST(dur AS TEXT),
 'surfaceToken',CAST(surface_frame_token AS TEXT),'displayToken',CAST(display_frame_token AS TEXT),
 'layerName',layer_name,'presentType',present_type,'onTimeFinish',on_time_finish,'gpuComposition',gpu_composition,
 'jankType',jank_type,'predictionType',prediction_type,'isBuffer',EXTRACT_ARG(arg_set_id,'Is Buffer?'))`;
 return `WITH app AS (${frames}), display AS (
 SELECT * FROM actual_frame_timeline_slice WHERE upid IN (SELECT upid FROM process WHERE pid=${scope.surfaceFlingerPid})
 AND display_frame_token IN (SELECT display_frame_token FROM app))
SELECT json_object('schema','android-frametimeline-query-v1',
 'processes',json((SELECT json_group_array(json_object('upid',upid,'pid',pid,'uid',uid,'androidUserId',android_user_id,
  'startNs',CAST(start_ts AS TEXT),'endNs',CAST(end_ts AS TEXT),'name',name,'cmdline',cmdline)) FROM process WHERE pid IN (${pids}))),
 'packages',json((SELECT json_group_array(json_object('packageName',package_name,'uid',uid,'versionCode',version_code)) FROM package_list WHERE package_name=${literal(scope.packageName)})),
 'appFrames',json((SELECT json_group_array(${frameRow}) FROM (SELECT * FROM app ORDER BY ts,id))),
 'displayFrames',json((SELECT json_group_array(${frameRow}) FROM (SELECT * FROM display ORDER BY ts,id))),
 'flows',json((SELECT json_group_array(json_object('id',id,'sliceOut',slice_out,'sliceIn',slice_in)) FROM flow WHERE slice_out IN (SELECT id FROM app))),
 'clockSnapshots',json((SELECT json_group_array(json_object('id',id,'ts',CAST(ts AS TEXT),'clockId',clock_id,
  'clockName',clock_name,'clockValue',CAST(clock_value AS TEXT),'snapshotId',snapshot_id)) FROM clock_snapshot)),
 'stats',json((SELECT json_group_array(json_object('name',name,'idx',idx,'severity',severity,'source',source,'value',CAST(value AS TEXT))) FROM stats))) AS proof;`;
}

export function parseFrameTimelineCsv(raw){
 assert.ok(Buffer.isBuffer(raw)&&raw.length<=128*1024*1024,'FRAMETIMELINE_QUERY_BYTES_BOUND');
 // Pinned native v58.2 wraps text cells in quotes but leaves inner JSON quotes
 // literal; it does not emit RFC4180 doubled quotes. Verify its exact one-row
 // output rather than silently accepting a different decoder/format.
 const found=raw.toString('utf8').match(/^"proof"\r?\n"(\{[^\r\n]*\})"\r?\n(?:\r?\n)?$/);
 assert.ok(found,'FRAMETIMELINE_SINGLE_ORIGINAL_QUERY_REQUIRED');const value=JSON.parse(found[1]);
 assert.equal(value?.schema,'android-frametimeline-query-v1');return value;
}

async function originalFile(path,expected,maxBytes){
 assert.ok(isAbsolute(path)&&path===resolve(path),'FRAMETIMELINE_ABSOLUTE_PATH_REQUIRED');const before=await lstat(path,{bigint:true});assert.ok(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size<=BigInt(maxBytes),'FRAMETIMELINE_REGULAR_ORIGINAL_FILE_REQUIRED');
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const pin=statPin(await fd.stat({bigint:true}));equal(pin,statPin(before));const bytes=await fd.readFile();equal(pin,statPin(await fd.stat({bigint:true})));equal(pin,statPin(await lstat(path,{bigint:true})));
  assert.match(expected??'',/^[a-f0-9]{64}$/,'FRAMETIMELINE_EXPECTED_SHA_REQUIRED');assert.equal(sha(bytes),expected,'FRAMETIMELINE_ORIGINAL_SHA_CHANGED');return {...pin,sha256:expected};
 }finally{await fd.close();}
}

/** Execute only the exact official local tool against an existing original
 * trace. No tool download, trace file write, SQL file loading or extension.
 * Return original stdout/stderr for the operator's private EXCL evidence sink.
 */
export async function readFrameTimelineTrace({toolPath,tracePath,traceSha256,scope}){
 assertScope(scope);const toolPin=await originalFile(toolPath,FRAMETIMELINE_TOOL.sha256,FRAMETIMELINE_TOOL.bytes);
 assert.equal(toolPin.size,String(FRAMETIMELINE_TOOL.bytes),'FRAMETIMELINE_TOOL_SIZE_CHANGED');const tracePin=await originalFile(tracePath,traceSha256,512*1024*1024);
 const sql=frameTimelineSql(scope),started={epochMs:Date.now(),monotonicMs:performance.now()};
 let result;try{result=await execute(toolPath,['query',tracePath,sql],{encoding:'buffer',maxBuffer:128*1024*1024,timeout:60000,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});}
 catch(error){const stdout=Buffer.isBuffer(error.stdout)?error.stdout:Buffer.from(error.stdout||''),stderr=Buffer.isBuffer(error.stderr)?error.stderr:Buffer.from(error.stderr||'');
  throw Object.assign(error,{proof:{schema:'android-frametimeline-original-local-read-v1',passed:false,toolPin,tracePin,sqlSha256:sha(sql),started,
   finished:{epochMs:Date.now(),monotonicMs:performance.now()},exitCode:Number.isInteger(error.code)?error.code:null,signal:error.signal||null,
   stdout,stderr,stdoutSha256:sha(stdout),stderrSha256:sha(stderr)}});}
 equal(toolPin,await originalFile(toolPath,FRAMETIMELINE_TOOL.sha256,FRAMETIMELINE_TOOL.bytes));equal(tracePin,await originalFile(tracePath,traceSha256,512*1024*1024));
 const receipt={schema:'android-frametimeline-original-local-read-v1',scope:structuredClone(scope),toolPin,tracePin,sql,sqlSha256:sha(sql),
  started,finished:{epochMs:Date.now(),monotonicMs:performance.now()},exitCode:0,stdout:result.stdout,stderr:result.stderr,
  stdoutSha256:sha(result.stdout),stderrSha256:sha(result.stderr)};
 try{receipt.query=parseFrameTimelineCsv(result.stdout);}catch(error){throw Object.assign(error,{proof:{...receipt,passed:false}});}return receipt;
}

const presented=new Set(['On-time Present','Late Present','Early Present']);
const signedNs=(value,code)=>{assert.ok(typeof value==='string'&&/^-?[0-9]+$/.test(value),code);return BigInt(value);};
/** Strict OS scope/token/flow evidence. All frames and dropped/unknown rows are
 * retained. No alignment to JS performance.now(), no inferred motion interval,
 * no particular command→pixels proof and no physical optical present claim.
 */
export function analyzeFrameTimeline({scope,scopeAfter,query,tracePin,toolPin,captureProof}){
 const result={schema:'android-frametimeline-supplement-v1',status:'insufficient',osFrameTimelineProven:false,physicalPanelPresent:false,
  localFeedbackMeasured:false,continuousGameWindowBound:false,reasons:[],frames:[],intervals:[],droppedFrames:0,unknownFrames:0,
  limitations:['SurfaceFrame completion is app/GPU/post completion; only its unique DisplayFrame end is OS-reported presentation',
   'OS-reported display presentation is not optical panel measurement or a bound CDP PNG/command',
   'Trace-clock intervals are not the JS continuous moving interval without an independent exact clock/scope bridge',
   'Trace-wide foreground/idle/proof phases remain present; no screenshots or pauses are subtracted',
   'SurfaceView or absent/ambiguous layer attribution remains insufficient']};
 try{
  assertScope(scope);assert.deepEqual(scopeAfter,scope,'FRAMETIMELINE_PROCESS_OR_BOOT_CHANGED');assert.equal(query?.schema,'android-frametimeline-query-v1');
  assert.equal(toolPin?.sha256,FRAMETIMELINE_TOOL.sha256);assert.match(tracePin?.sha256??'',/^[a-f0-9]{64}$/,'FRAMETIMELINE_ORIGINAL_TRACE_PIN_REQUIRED');
  result.originalQuery=structuredClone(query);
  assert.equal(captureProof?.exitCode,0,'FRAMETIMELINE_ACTUAL_PRODUCER_EXIT_REQUIRED');assert.equal(captureProof?.bootId,scope.bootId,'FRAMETIMELINE_CAPTURE_BOOT_CHANGED');
  assert.equal(captureProof?.traceSha256,tracePin.sha256,'FRAMETIMELINE_CAPTURE_TRACE_CHANGED');assert.equal(captureProof?.traceClock,'BOOTTIME','FRAMETIMELINE_TRACE_CLOCK_REQUIRED');
  assert.equal(captureProof?.configurationSha256,sha(frameTimelineCaptureConfig({durationMs:captureProof.durationMs})),'FRAMETIMELINE_CONFIG_PIN_REQUIRED');
  assert.ok(query.stats.length>0&&query.stats.every(s=>/^-?[0-9]+$/.test(s.value)),'FRAMETIMELINE_ORIGINAL_STATS_REQUIRED');
  const lost=query.stats.filter(s=>BigInt(s.value)!==0n&&(['error','data_loss'].includes(s.severity)||/overrun|overwrite|discard|data_loss|parser_errors|unpaired|packet_loss|read.*fail|skipped.*packet/i.test(s.name)));
  result.lossStats=structuredClone(lost);assert.equal(lost.length,0,'FRAMETIMELINE_TRACE_LOSS_OR_PARSER_ERROR');
  const packages=query.packages.filter(p=>p.uid===scope.uid);assert.equal(packages.length,1,'FRAMETIMELINE_PACKAGE_UID_UNPROVEN');assert.equal(packages[0].packageName,scope.packageName);assert.equal(packages[0].versionCode,scope.versionCode);
  const process=(pid,uid,ticks)=>{const rows=query.processes.filter(p=>p.pid===pid);assert.equal(rows.length,1,'FRAMETIMELINE_PID_REUSED_OR_UNKNOWN');const row=rows[0];assert.equal(row.uid,uid,'FRAMETIMELINE_PROCESS_UID_CHANGED');
   assert.equal(signedNs(row.startNs,'FRAMETIMELINE_PROCESS_START_UNPROVEN'),integer(ticks,'FRAMETIMELINE_PROCESS_TICKS_REQUIRED')*1000000000n/BigInt(scope.clockTicksPerSecond),'FRAMETIMELINE_PROCESS_START_CHANGED');return row;};
  const app=process(scope.pid,scope.uid,scope.startTicks),sf=process(scope.surfaceFlingerPid,scope.surfaceFlingerUid,scope.surfaceFlingerStartTicks);assert.equal(app.androidUserId,0,'FRAMETIMELINE_CLONED_USER_REJECTED');
  assert.equal(app.cmdline,scope.packageName,'FRAMETIMELINE_MAIN_PROCESS_NAME_UNPROVEN');assert.equal(sf.cmdline,'/system/bin/surfaceflinger','FRAMETIMELINE_DISPLAY_PROCESS_UNPROVEN');
  assert.ok(query.clockSnapshots.some(c=>c.clockName==='BOOTTIME'||c.clockId===6),'FRAMETIMELINE_BOOTTIME_SNAPSHOT_REQUIRED');
  assert.ok(Array.isArray(query.appFrames)&&query.appFrames.length>0,'FRAMETIMELINE_OWN_SURFACE_ABSENT');
  assert.ok(query.appFrames.every(f=>f.upid===app.upid),'FRAMETIMELINE_FOREIGN_APP_FRAME');
  result.candidateLayers=[...new Set(query.appFrames.map(f=>f.layerName))];const frames=query.appFrames.filter(f=>f.layerName===scope.layerName);
  assert.ok(frames.length>0,'FRAMETIMELINE_EXACT_LAYER_ABSENT');assert.ok(!/SurfaceView/i.test(scope.layerName),'FRAMETIMELINE_SURFACEVIEW_UNPROVEN');
  assert.equal(new Set(frames.map(f=>f.surfaceToken)).size,frames.length,'FRAMETIMELINE_AMBIGUOUS_SURFACE_TOKEN');
  const displayMap=new Map();for(const d of query.displayFrames){assert.equal(d.upid,sf.upid,'FRAMETIMELINE_FOREIGN_DISPLAY_PROCESS');integer(d.displayToken,'FRAMETIMELINE_DISPLAY_TOKEN_REQUIRED');const rows=displayMap.get(d.displayToken)||[];rows.push(d);displayMap.set(d.displayToken,rows);}
  for(const frame of frames){const row={surface:structuredClone(frame),display:null,presentNs:null,issue:null};result.frames.push(row);
   try{assert.ok(integer(frame.surfaceToken,'FRAMETIMELINE_SURFACE_TOKEN_REQUIRED')>0n);assert.equal(frame.isBuffer,'Yes','FRAMETIMELINE_BUFFER_FRAME_REQUIRED');
    const start=signedNs(frame.ts,'FRAMETIMELINE_SURFACE_TIME_REQUIRED'),dur=signedNs(frame.dur,'FRAMETIMELINE_SURFACE_DURATION_REQUIRED');assert.ok(start>=0n&&dur>=0n,'FRAMETIMELINE_SURFACE_UNFINISHED');
    if(frame.presentType==='Dropped Frame'){result.droppedFrames++;row.issue='OS_DROPPED_FRAME';continue;}
    assert.ok(presented.has(frame.presentType),'FRAMETIMELINE_SURFACE_PRESENT_UNKNOWN');const displays=displayMap.get(frame.displayToken)||[];assert.equal(displays.length,1,'FRAMETIMELINE_UNIQUE_DISPLAY_REQUIRED');const display=displays[0];row.display=structuredClone(display);
    assert.equal(display.surfaceToken,null,'FRAMETIMELINE_DISPLAY_IS_SURFACE');assert.ok(presented.has(display.presentType),'FRAMETIMELINE_DISPLAY_PRESENT_UNKNOWN');
    const flow=query.flows.filter(f=>f.sliceOut===frame.id);assert.equal(flow.length,1,'FRAMETIMELINE_UNIQUE_ORIGINAL_FLOW_REQUIRED');assert.equal(flow[0].sliceIn,display.id,'FRAMETIMELINE_FLOW_TOKEN_DISAGREEMENT');
    const dStart=signedNs(display.ts,'FRAMETIMELINE_DISPLAY_TIME_REQUIRED'),dDur=signedNs(display.dur,'FRAMETIMELINE_DISPLAY_DURATION_REQUIRED');assert.ok(dStart>=start&&dDur>=0n&&dStart+dDur>=start+dur,'FRAMETIMELINE_DISPLAY_END_INVALID');row.presentNs=String(dStart+dDur);row.flow=structuredClone(flow[0]);
   }catch(error){row.issue=error.message;result.unknownFrames++;}
  }
  const displayed=[...new Map(result.frames.filter(f=>f.presentNs!==null).map(f=>[f.display.id,f])).values()].sort((a,b)=>signedNs(a.presentNs)-signedNs(b.presentNs)>0n?1:-1);
  for(let i=1;i<displayed.length;i++){const before=displayed[i-1],after=displayed[i],ns=signedNs(after.presentNs)-signedNs(before.presentNs);assert.ok(ns>0n,'FRAMETIMELINE_NONINCREASING_DISPLAY_END');result.intervals.push({fromDisplayId:before.display.id,toDisplayId:after.display.id,fromNs:before.presentNs,toNs:after.presentNs,ns:String(ns),ms:Number(ns)/1000000});}
  assert.equal(result.unknownFrames,0,'FRAMETIMELINE_UNRESOLVED_FRAME_RETAINED');assert.ok(displayed.length>=2,'FRAMETIMELINE_DISPLAY_INTERVALS_ABSENT');result.status='os-frame-timeline-proven';result.osFrameTimelineProven=true;
 }catch(error){result.reasons.push(error.message);}
 return result;
}
