// Opt-in numeric diagnostics only. No storage access occurs during import or
// factory creation. The scene must explicitly check its session opt-in first.
export const RUN_FRAME_TRACE_SESSION_KEY='oasis:run:frame-trace:v1';
export const RUN_FRAME_TRACE_DEFAULT_CAPACITY=8192;
export const RUN_FRAME_TRACE_MAX_CAPACITY=32768;
export const RUN_FRAME_TRACE_PHASE=Object.freeze({unknown:0,arming:1,countdown:2,racing:3,'finish-window':4,finished:5});
export const RUN_FRAME_TRACE_FIELDS=Object.freeze([
 'frameAtMs','snapshotTick','roomVersion','elapsedMs','authorityDistance','projectedDistance',
 'runnerZ','cameraZ','speed','stunUntilTick','fallUntilTick','finishTick','forfeited','hits','phaseCode','renderReturnedAtMs',
]);
const WIDTH=RUN_FRAME_TRACE_FIELDS.length,SCHEMA='oasis-run-frame-trace-v1';
const empty=Object.freeze({schema:SCHEMA,enabled:false,capacity:0,stored:0,recorded:0,overwritten:0,rejected:0,
 fields:RUN_FRAME_TRACE_FIELDS,samples:Object.freeze([])});
const disabled=Object.freeze({record:()=>false,read:()=>empty,reset:()=>false,dispose:()=>{}});
const nonnegativeInteger=value=>Number.isSafeInteger(value)&&value>=0;
const optionalTick=value=>Number.isSafeInteger(value)&&value>=-1;
const nonnegative=value=>Number.isFinite(value)&&value>=0;

/** Only sessionStorage's exact string "1" enables a trace; errors fail closed. */
export function isRunFrameTraceSessionEnabled(storage){
 try{return storage?.getItem(RUN_FRAME_TRACE_SESSION_KEY)==='1';}catch{return false;}
}

/**
 * Each scene owns its own trace. Disabled creation allocates no buffer or trace
 * object and does not read browser state. Enabled memory is one Float64Array:
 * 1 MiB by default, at most 4 MiB. No identifiers, arbitrary fields or strings
 * can be recorded. record() has a fixed numeric signature: no rest arguments,
 * per-frame arrays, objects, clocks, DOM, logging, storage or network calls.
 *
 * frameAtMs and renderReturnedAtMs share the document's performance/RAF time
 * origin, not wall-clock time or the authoritative game's startedAt. snapshotTick
 * is the server's tick since that game's startedAt. elapsedMs is the scene
 * snapshot clock's elapsed time, including carried projection; it is neither
 * GET RTT nor server_now minus game.serverNow. roomVersion uses -1 if unknown;
 * fallUntilTick/finishTick use -1 for null; forfeited is 0 or 1; phaseCode uses
 * RUN_FRAME_TRACE_PHASE. renderReturnedAtMs measures the JS render call return,
 * not GPU completion or physical screen presentation. Invalid records are
 * rejected, never thrown into render.
 * read() allocates chronological export copies only on explicit invocation.
 */
export function createRunFrameTrace(options){
 if(options?.enabled!==true)return disabled;
 const capacity=options.capacity===undefined?RUN_FRAME_TRACE_DEFAULT_CAPACITY:options.capacity;
 if(!Number.isInteger(capacity)||capacity<1||capacity>RUN_FRAME_TRACE_MAX_CAPACITY)throw new RangeError('INVALID_RUN_FRAME_TRACE_CAPACITY');
 let buffer=new Float64Array(capacity*WIDTH),cursor=0,stored=0,recorded=0,rejected=0,lastFrameAt=-Infinity;
 function record(frameAtMs,snapshotTick,roomVersion,elapsedMs,authorityDistance,projectedDistance,
  runnerZ,cameraZ,speed,stunUntilTick,fallUntilTick,finishTick,forfeited,hits,phaseCode,renderReturnedAtMs){
  if(buffer===null)return false;
  if(!nonnegative(frameAtMs)||frameAtMs<lastFrameAt||!nonnegativeInteger(snapshotTick)||!optionalTick(roomVersion)
   ||!nonnegative(elapsedMs)||!Number.isFinite(authorityDistance)||!Number.isFinite(projectedDistance)
   ||!Number.isFinite(runnerZ)||!Number.isFinite(cameraZ)||!nonnegative(speed)||!nonnegativeInteger(stunUntilTick)
   ||!optionalTick(fallUntilTick)||!optionalTick(finishTick)||(forfeited!==0&&forfeited!==1)||!nonnegativeInteger(hits)
   ||!Number.isInteger(phaseCode)||phaseCode<0||phaseCode>5||!nonnegative(renderReturnedAtMs)||renderReturnedAtMs<frameAtMs){rejected++;return false;}
  const offset=cursor*WIDTH;
  buffer[offset]=frameAtMs;buffer[offset+1]=snapshotTick;buffer[offset+2]=roomVersion;buffer[offset+3]=elapsedMs;
  buffer[offset+4]=authorityDistance;buffer[offset+5]=projectedDistance;buffer[offset+6]=runnerZ;buffer[offset+7]=cameraZ;
  buffer[offset+8]=speed;buffer[offset+9]=stunUntilTick;buffer[offset+10]=fallUntilTick;buffer[offset+11]=finishTick;
  buffer[offset+12]=forfeited;buffer[offset+13]=hits;buffer[offset+14]=phaseCode;buffer[offset+15]=renderReturnedAtMs;
  cursor=(cursor+1)%capacity;if(stored<capacity)stored++;recorded++;lastFrameAt=frameAtMs;return true;
 }
 function read(){
  if(buffer===null)return empty;
  const samples=new Array(stored),first=(cursor-stored+capacity)%capacity;
  for(let i=0;i<stored;i++){
   const row=new Array(WIDTH),offset=((first+i)%capacity)*WIDTH;
   for(let field=0;field<WIDTH;field++)row[field]=buffer[offset+field];
   samples[i]=row;
  }
  return{schema:SCHEMA,enabled:true,capacity,stored,recorded,overwritten:recorded-stored,rejected,
   fields:RUN_FRAME_TRACE_FIELDS,samples};
 }
 function reset(){
  if(buffer===null)return false;
  buffer.fill(0);cursor=0;stored=0;recorded=0;rejected=0;lastFrameAt=-Infinity;return true;
 }
 function dispose(){if(buffer===null)return;reset();buffer=null;}
 return Object.freeze({record,read,reset,dispose});
}
