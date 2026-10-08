import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {randomBytes} from 'node:crypto';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';

const CAPS=Object.freeze({windowMs:120000,maxRecords:4096,maxBytes:1024*1024,queueRecords:128,queueBytes:65536,batchRecords:32,shutdownMs:1000});
const END_RESERVE=2048;
const defaultClock=()=>({epoch_ms:Date.now(),mono_ms:performance.now()});
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const clockValid=value=>value&&finite(value.epoch_ms)&&finite(value.mono_ms);
const line=value=>Buffer.from(JSON.stringify(value)+'\n');
const increment=(object,key,n=1)=>{object[key]=Math.min(Number.MAX_SAFE_INTEGER,object[key]+n);};
const unref=timer=>{timer?.unref?.();return timer;};

/** Injected writer contract: write(Buffer) resolves only after ALL bytes are
 * written (optionally returning their count); close() releases its resource.
 * The factory has no filesystem/environment access. Request callers only use
 * synchronous record(); neither writes nor shutdown are gameplay dependencies.
 */
export function createRequestTimingSink({writer,clock=defaultClock,bootId=randomBytes(16).toString('hex'),pid=process.pid,
 timers={setTimeout,clearTimeout},limits={},loopSample=null,onStop=()=>{}}={}){
 const settings={...CAPS,...limits};
 for(const key of Object.keys(settings))if(!Object.hasOwn(CAPS,key)||!Number.isInteger(settings[key])||settings[key]<1||settings[key]>CAPS[key])throw new TypeError('INVALID_TIMING_LIMIT');
 if(settings.maxRecords<3||settings.maxBytes<END_RESERVE+1024||settings.queueBytes<1024||!writer||typeof writer.write!=='function'||typeof writer.close!=='function'||!/^[a-f0-9]{32}$/.test(bootId)||!Number.isSafeInteger(pid)||pid<1)throw new TypeError('INVALID_TIMING_SINK');
 const start=clock();if(!clockValid(start))throw new TypeError('INVALID_TIMING_CLOCK');
 let lastClock={...start},lastEventMono=start.mono_ms,loopStart={...start},state='open',reason=null,incomplete=false;
 let queue=[],queueBytes=0,inflightRecords=0,inflightBytes=0,pumping=false,flushTimer,windowTimer,loopTimer,closeTimer;
 let acceptedRecords=0,reservedBytes=0,writtenRecords=0,writtenBytes=0,terminalQueued=false,stopped=false;
 let readyResolve,closeResolve,closePromise,readyDone=false;
 const ready=new Promise(resolve=>{readyResolve=resolve;});
 const dropped={invalid:0,backpressure:0,record_limit:0,byte_limit:0,after_close:0,discarded_on_failure:0};
 function stats(){return{boot_id:bootId,pid,state,reason,incomplete,accepted_records:acceptedRecords,confirmed_written_records:writtenRecords,confirmed_written_bytes:writtenBytes,reserved_bytes:reservedBytes,pending_records:queue.length+inflightRecords,pending_bytes:queueBytes+inflightBytes,dropped:{...dropped},window_ms:settings.windowMs};}
 function finishReady(value){if(!readyDone){readyDone=true;readyResolve(value);}}
 function stopTimers(){
  for(const timer of [flushTimer,windowTimer,loopTimer])if(timer!==undefined)timers.clearTimeout(timer);
  flushTimer=windowTimer=loopTimer=undefined;
  if(!stopped){stopped=true;try{onStop();}catch{incomplete=true;}}
 }
 function observeClock(){
  let value;try{value=clock();}catch{return null;}
  if(!clockValid(value)||value.mono_ms<lastClock.mono_ms)return null;
  lastClock={epoch_ms:value.epoch_ms,mono_ms:value.mono_ms};return lastClock;
 }
 function settleClose(){if(closeTimer!==undefined)timers.clearTimeout(closeTimer);closeTimer=undefined;closeResolve?.(stats());}
 function startCloseTimer(){
  if(closeTimer!==undefined)return;
  // Deliberately referenced: an awaited shutdown must settle even if a writer
  // hangs and there are no other live handles. Never exceed the fixed bound.
  closeTimer=timers.setTimeout(()=>{
   if(state==='closed'||state==='failed'||state==='timed_out')return;
   state='timed_out';reason='shutdown_timeout';incomplete=true;
   increment(dropped,'discarded_on_failure',queue.length);queue=[];queueBytes=0;
   finishReady(false);try{Promise.resolve(writer.close()).catch(()=>{});}catch{}
   settleClose();
  },settings.shutdownMs);
 }
 function ensureClosePromise(){if(!closePromise)closePromise=new Promise(resolve=>{closeResolve=resolve;});return closePromise;}
 function fail(){
  if(state==='closed'||state==='failed'||state==='timed_out')return;
  state='failed';reason='writer_error';incomplete=true;stopTimers();
  increment(dropped,'discarded_on_failure',queue.length);queue=[];queueBytes=0;finishReady(false);
  ensureClosePromise();
  // An uncooperative close must not keep the returned promise pending. State
  // remains failed; no success/end record is fabricated after a write error.
  const timer=timers.setTimeout(settleClose,settings.shutdownMs);
  try{Promise.resolve(writer.close()).catch(()=>{}).finally(()=>{timers.clearTimeout(timer);settleClose();});}catch{timers.clearTimeout(timer);settleClose();}
 }
 function append(buffer,kind){queue.push({buffer,kind});queueBytes+=buffer.length;acceptedRecords++;reservedBytes+=buffer.length;}
 function endRecord(){
  const value={kind:'end',reason,epoch_ms:lastClock.epoch_ms,mono_ms:lastClock.mono_ms,complete:!incomplete,
   accepted_records_before_end:acceptedRecords,confirmed_written_records_before_end:writtenRecords,
   dropped:{...dropped},scope:'diagnostic_records_before_end_only',writer_close:'not_yet_observed_use_close_result'};
  const buffer=line(value);
  if(buffer.length>END_RESERVE||reservedBytes+buffer.length>settings.maxBytes||acceptedRecords+1>settings.maxRecords){fail();return;}
  terminalQueued=true;append(buffer,'end');
 }
 async function pump(){
  if(pumping||['closed','failed','timed_out'].includes(state))return;
  pumping=true;
  try{
   while(!['closed','failed','timed_out'].includes(state)){
    if(!queue.length){
     if(state==='closing'&&!terminalQueued){endRecord();continue;}
     break;
    }
    const batch=queue.splice(0,settings.batchRecords);const buffer=Buffer.concat(batch.map(v=>v.buffer));
    queueBytes-=buffer.length;inflightRecords=batch.length;inflightBytes=buffer.length;
    const result=await writer.write(buffer);
    if(result!==undefined&&result!==buffer.length)throw new Error('INCOMPLETE_TIMING_WRITE');
    writtenRecords+=batch.length;writtenBytes+=buffer.length;inflightRecords=0;inflightBytes=0;
    if(['failed','timed_out'].includes(state))break;
    if(batch.some(v=>v.kind==='start'))finishReady(true);
    if(batch.some(v=>v.kind==='end')){
     await writer.close();
     if(state==='closing'){state='closed';settleClose();}
     break;
    }
   }
  }catch{inflightRecords=0;inflightBytes=0;fail();}
  finally{pumping=false;}
 }
 function flush(){flushTimer=undefined;void pump();}
 function scheduleFlush(){if(state==='open'&&!pumping&&flushTimer===undefined)flushTimer=unref(timers.setTimeout(flush,25));}
 function close({reason:requested='shutdown'}={}){
  ensureClosePromise();
  if(['closed','failed','timed_out'].includes(state)){settleClose();return closePromise;}
  if(state==='closing')return closePromise;
  reason=['shutdown','window','record_limit','byte_limit','invalid_clock','startup_error'].includes(requested)?requested:'shutdown';
  if(!['shutdown','window'].includes(reason))incomplete=true;
  if(!observeClock()){incomplete=true;reason='invalid_clock';}
  state='closing';stopTimers();startCloseTimer();
  // Include the final partial process interval, but never pretend a delayed
  // timer's beyond-window histogram belongs to the bounded diagnostic window.
  if(loopSample&&lastClock.mono_ms>loopStart.mono_ms&&lastClock.mono_ms-start.mono_ms<=settings.windowMs)sampleLoop(lastClock);
  void pump();return closePromise;
 }
 function admit(value){
  const buffer=line(value);
  if(acceptedRecords>=settings.maxRecords-1){increment(dropped,'record_limit');incomplete=true;void close({reason:'record_limit'});return false;}
  if(reservedBytes+buffer.length>settings.maxBytes-END_RESERVE){increment(dropped,'byte_limit');incomplete=true;void close({reason:'byte_limit'});return false;}
  if(queue.length+inflightRecords>=settings.queueRecords||queueBytes+inflightBytes+buffer.length>settings.queueBytes){increment(dropped,'backpressure');incomplete=true;return false;}
  append(buffer,value.kind);scheduleFlush();return true;
 }
 function record(input){
  try{
   if(state!=='open'){increment(dropped,'after_close');return false;}
   const now=observeClock();if(!now){increment(dropped,'invalid');incomplete=true;void close({reason:'invalid_clock'});return false;}
   if(now.mono_ms-start.mono_ms>=settings.windowMs){void close({reason:'window'});increment(dropped,'after_close');return false;}
   if(!input||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new Error();
   const descriptors=Object.getOwnPropertyDescriptors(input),keys=Reflect.ownKeys(descriptors);
   const allowed=['phase','request_id','epoch_ms','mono_ms','status','app_ms'];
   if(keys.some(k=>!allowed.includes(k)||!Object.hasOwn(descriptors[k],'value')))throw new Error();
   const v=Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));
   if(!['entry','headers','finish','close'].includes(v.phase)||typeof v.request_id!=='string'||!/^[a-f0-9]{32}$/.test(v.request_id)||!finite(v.epoch_ms)||!finite(v.mono_ms)||v.mono_ms<lastEventMono||v.mono_ms>now.mono_ms)throw new Error();
   if(v.phase==='headers'){if(!finite(v.app_ms)||Object.hasOwn(v,'status'))throw new Error();}
   else if(Object.hasOwn(v,'app_ms'))throw new Error();
   if(['finish','close'].includes(v.phase)){if(!Number.isInteger(v.status)||v.status<100||v.status>599)throw new Error();}
   else if(Object.hasOwn(v,'status'))throw new Error();
   lastEventMono=v.mono_ms;return admit({kind:'request',...v});
  }catch{increment(dropped,'invalid');incomplete=true;return false;}
 }
 function sampleLoop(now){
  try{
   const sample=loopSample();
   if(!sample||!Number.isSafeInteger(sample.count)||sample.count<0||!['max_ms','p50_ms','p99_ms'].every(k=>finite(sample[k]))||sample.p50_ms>sample.p99_ms||sample.p99_ms>sample.max_ms)throw new Error();
   admit({kind:'event_loop_interval',scope:'process_interval_aggregate_not_per_request',start_epoch_ms:loopStart.epoch_ms,start_mono_ms:loopStart.mono_ms,end_epoch_ms:now.epoch_ms,end_mono_ms:now.mono_ms,count:sample.count,max_ms:sample.max_ms,p50_ms:sample.p50_ms,p99_ms:sample.p99_ms});
  }catch{increment(dropped,'invalid');incomplete=true;}
  loopStart={...now};
 }
 function captureLoop(){
  if(state!=='open')return;
  const now=observeClock();if(!now){incomplete=true;void close({reason:'invalid_clock'});return;}
  if(now.mono_ms-start.mono_ms>=settings.windowMs){void close({reason:'window'});return;}
  sampleLoop(now);if(state==='open')loopTimer=unref(timers.setTimeout(captureLoop,1000));
 }
 append(line({kind:'start',schema:'oasis-room-timing-v1',boot_id:bootId,pid,epoch_ms:start.epoch_ms,mono_ms:start.mono_ms,
  limits:{window_ms:settings.windowMs,records_including_metadata:settings.maxRecords,bytes_including_metadata:settings.maxBytes,queue_records:settings.queueRecords,queue_bytes:settings.queueBytes},event_loop_scope:'process_intervals_not_per_request'}),'start');
 windowTimer=unref(timers.setTimeout(()=>{void close({reason:'window'});},settings.windowMs));
 if(loopSample)loopTimer=unref(timers.setTimeout(captureLoop,1000));
 void pump();
 return Object.freeze({record,close,stats,ready,closed:ensureClosePromise()});
}

/** Startup only. Missing config performs no filesystem/monitor/timer work.
 * Existing files (including symlinks) are never followed or overwritten.
 * Creation/open/write failures disable diagnostics, never the HTTP service.
 */
export async function startRequestTimingSink(env=process.env,{openFile=open,clock=defaultClock,monitorFactory=monitorEventLoopDelay,startupTimeoutMs=1000}={}){
 const path=env?.OASIS_ROOM_TIMING_FILE;
 if(typeof path!=='string'||!path)return null;
 if(!isAbsolute(path)||path.includes('\0'))return null;
 let handle,sink,monitor,expired=false,timer;
 const timeout=new Promise(resolve=>{timer=setTimeout(()=>{expired=true;resolve(null);},Math.min(1000,Math.max(1,startupTimeoutMs)));});
 const attempt=(async()=>{
  try{
   handle=await openFile(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   if(expired){await handle.close();return null;}
   const metadata=await handle.stat();
   if(!metadata.isFile()||metadata.nlink!==1||(metadata.mode&0o777)!==0o600||typeof process.getuid==='function'&&metadata.uid!==process.getuid())throw new Error('UNSAFE_TIMING_FILE');
   if(expired){await handle.close();return null;}
   const writer={async write(buffer){let offset=0;while(offset<buffer.length){const result=await handle.write(buffer,offset,buffer.length-offset,null);if(!Number.isInteger(result.bytesWritten)||result.bytesWritten<=0||result.bytesWritten>buffer.length-offset)throw new Error('TIMING_WRITE_FAILED');offset+=result.bytesWritten;}return offset;},close:()=>handle.close()};
   monitor=monitorFactory({resolution:20});monitor.enable();
   sink=createRequestTimingSink({writer,clock,loopSample:()=>{const count=Number(monitor.count),value={count,max_ms:count?monitor.max/1e6:0,p50_ms:count?monitor.percentile(50)/1e6:0,p99_ms:count?monitor.percentile(99)/1e6:0};monitor.reset();return value;},onStop:()=>monitor.disable()});
   if(!await sink.ready||expired){void sink.close({reason:'startup_error'});return null;}
   return sink;
  }catch{try{monitor?.disable();}catch{}try{await handle?.close();}catch{}return null;}
 })();
 const result=await Promise.race([attempt,timeout]);clearTimeout(timer);
 if(expired){try{monitor?.disable();}catch{}if(sink)void sink.close({reason:'startup_error'});}
 return result;
}
