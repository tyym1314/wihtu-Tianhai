// Explicit QA only. Commands preserve controller order; samples and renderer
// bindings use fixed buffers. Nothing is exported during ordinary rendering.
export const RUN_TIMELINE_JOURNAL_SCHEMA='run-timeline-journal-v1';
export const RUN_TIMELINE_JOURNAL_METHODS=Object.freeze(['receive','noteInput','resolveInput','sample','suspend','clear']);
export const RUN_TIMELINE_JOURNAL_SAMPLE_FIELDS=Object.freeze(['commandIndex','sampleNo','modeCode','reasonCode','displayTick','baseTick','baseVersion','poseTick','sourceTick','sourceVersion','distance','x','y','scale','boundaryCode','animationTick','eventTick','stunUntilTick','fallUntilTick','finishTick','hits','appliedInputNo','controlTick','causalTick','causalFromTick','causalToTick','causalMix','causalBoundaryCode','visualSpeed']);
export const RUN_TIMELINE_JOURNAL_FRAME_FIELDS=Object.freeze(['sampleNo','frameAtMs','renderReturnedAtMs','runnerX','runnerY','runnerZ','cameraZ']);
const METHODS=RUN_TIMELINE_JOURNAL_METHODS,SW=RUN_TIMELINE_JOURNAL_SAMPLE_FIELDS.length,FW=RUN_TIMELINE_JOURNAL_FRAME_FIELDS.length;
const EMPTY=Object.freeze({schema:RUN_TIMELINE_JOURNAL_SCHEMA,enabled:false,complete:false,reason:'disabled',commands:Object.freeze([]),samples:Object.freeze([]),frames:Object.freeze([])});
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const number=value=>finite(value)?value:NaN;
const rows=(buffer,width,count)=>Array.from({length:count},(_,index)=>Array.from(buffer.subarray(index*width,(index+1)*width),value=>Number.isNaN(value)?null:value));

// Reject lossy JSON and getters before serializing. An unsupported diagnostic
// never changes the actual controller call; it makes this recording incomplete.
function payloadText(args){
 const stack=[args],seen=new WeakSet();let visited=0;
 while(stack.length){
  const value=stack.pop();if(++visited>131072)throw Error('payload-structure-limit');
  if(value===null||typeof value==='string'||typeof value==='boolean')continue;
  if(typeof value==='number'){if(!Number.isFinite(value)||Object.is(value,-0))throw Error('unsupported-payload');continue;}
  if(typeof value!=='object'||!([Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(value))))throw Error('unsupported-payload');
  if(seen.has(value))throw Error('shared-or-cyclic-payload');seen.add(value);
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  if(Array.isArray(value)&&keys.length!==value.length+1)throw Error('unsupported-payload');
  for(const key of keys){
   if(Array.isArray(value)&&key==='length')continue;
   const item=descriptors[key];
   if(typeof key!=='string'||!item.enumerable||!Object.hasOwn(item,'value'))throw Error('unsupported-payload');
   if(Array.isArray(value)&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))throw Error('unsupported-payload');
   stack.push(item.value);
  }
 }
 return JSON.stringify(args);
}

/** Disabled wrapping preserves the exact controller identity. Enabled buffers
 * stop at their bounds, never overwrite a missing prefix and claim full replay.
 * Payloads are copied once per receive/input/lifecycle call, not per frame.
 * The payload limit counts UTF-16 storage, not compressed wire bytes. */
export function createRunTimelineJournal(inner,{enabled=false,capacity=8192,payloadBytes=8*1024*1024}={}){
 if(enabled!==true)return Object.freeze({timeline:inner,bindFrame:()=>false,read:()=>EMPTY,dispose:()=>{}});
 if(!Number.isInteger(capacity)||capacity<1||capacity>32768||!Number.isInteger(payloadBytes)||payloadBytes<1||payloadBytes>16*1024*1024)throw new RangeError('INVALID_RUN_TIMELINE_JOURNAL_CAPACITY');
 let commands=new Float64Array(capacity*3),samples=new Float64Array(capacity*SW),frames=new Float64Array(capacity*FW);
 let payloads=[],strings=[''],payloadSize=0,commandCount=0,sampleCount=0,frameCount=0,lastSampleNo=0,complete=true,reason=null,disposed=false;
 function fail(message){complete=false;reason??=message;return -1;}
 function code(value){
  if(value===null||value===undefined)return 0;
  if(typeof value!=='string'||value.length>160)return fail('unsupported-result');
  const found=strings.indexOf(value);if(found>=0)return found;
  if(strings.length>=128)return fail('result-string-limit');strings.push(value);return strings.length-1;
 }
 function command(method,args,at){
  if(disposed||!complete)return -1;
  if(commandCount>=capacity)return fail('command-capacity');
  let payload=-1;
  if(method!==3){
   let text;try{text=payloadText(args);}catch(error){
    // A rejected proxy can throw anything, including null or another proxy.
    // Diagnostics must still forward the original controller call unchanged.
    let why='unsupported-payload';try{const message=Object.getOwnPropertyDescriptor(error,'message')?.value;if(['payload-structure-limit','unsupported-payload','shared-or-cyclic-payload'].includes(message))why=message;}catch{}
    return fail(why);
   }
   if(text.length*2>payloadBytes-payloadSize)return fail('payload-capacity');
   payload=payloads.length;payloads.push(text);payloadSize+=text.length*2;
  }else if(!finite(at))return fail('unsupported-sample-time');
  const index=commandCount++,offset=index*3;commands[offset]=method;commands[offset+1]=method===3?at:payload;commands[offset+2]=NaN;return index;
 }
 function invoke(method,args,run){
  const index=command(method,args);
  try{const result=run();if(index>=0){if(result!==true&&result!==false&&result!==undefined)fail('unsupported-controller-result');commands[index*3+2]=result===true?1:result===false?0:result===undefined?-1:NaN;}return result;}
  catch(error){fail('controller-threw');throw error;}
 }
 function sample(at){
  const index=command(3,null,at);let result;
  try{result=inner.sample(at);}catch(error){fail('controller-threw');throw error;}
  if(index<0)return result;
  if(!result||typeof result!=='object'||typeof result.mode!=='string'){fail('unsupported-result');return result;}
  const p=result.pose,offset=sampleCount*SW;lastSampleNo=++sampleCount;
  commands[index*3+2]=lastSampleNo;
  samples[offset]=index;samples[offset+1]=lastSampleNo;samples[offset+2]=code(result?.mode);samples[offset+3]=code(result?.reason);
  samples[offset+4]=number(result?.displayTick);samples[offset+5]=number(result?.baseTick);samples[offset+6]=number(result?.baseVersion);
  samples[offset+7]=number(p?.tick);samples[offset+8]=number(p?.sourceTick);samples[offset+9]=number(p?.sourceVersion);
  samples[offset+10]=number(p?.distance);samples[offset+11]=number(p?.x);samples[offset+12]=number(p?.y);samples[offset+13]=number(p?.scale);
  samples[offset+14]=code(p?.boundary);samples[offset+15]=number(p?.animationTick);samples[offset+16]=number(p?.eventTick);
  samples[offset+17]=number(p?.stunUntilTick);samples[offset+18]=number(p?.fallUntilTick);samples[offset+19]=number(p?.finishTick);
  samples[offset+20]=number(p?.hits);samples[offset+21]=number(p?.appliedInputNo);samples[offset+22]=number(p?.controlTick);samples[offset+23]=number(p?.causalTick);
  samples[offset+24]=number(p?.causalFromTick);samples[offset+25]=number(p?.causalToTick);samples[offset+26]=number(p?.causalMix);samples[offset+27]=code(p?.causalBoundary);samples[offset+28]=number(p?.visualSpeed);return result;
 }
 const timeline=Object.freeze({receive:(game,key,options)=>invoke(0,[game,key,options],()=>inner.receive(game,key,options)),noteInput:input=>invoke(1,[input],()=>inner.noteInput(input)),resolveInput:input=>invoke(2,[input],()=>inner.resolveInput(input)),sample,suspend:reason=>invoke(4,[reason],()=>inner.suspend(reason)),clear:()=>invoke(5,[],()=>inner.clear())});
 function bindFrame(at,returnedAt,x,y,z,cameraZ){
  if(disposed||!complete)return false;
  if(frameCount>=capacity){fail('frame-capacity');return false;}
  if(!lastSampleNo||!finite(at)||!finite(returnedAt)||!finite(x)||!finite(y)||!finite(z)||!finite(cameraZ)||returnedAt<at){fail('invalid-render-binding');return false;}
  const offset=frameCount++*FW;frames[offset]=lastSampleNo;frames[offset+1]=at;frames[offset+2]=returnedAt;frames[offset+3]=x;frames[offset+4]=y;frames[offset+5]=z;frames[offset+6]=cameraZ;return true;
 }
 function read(){
  if(disposed)return EMPTY;
  return{schema:RUN_TIMELINE_JOURNAL_SCHEMA,enabled:true,complete,reason,capacity,payloadBytes,payloadSize,methods:METHODS,
   commandFields:['methodCode','sampleAtOrPayloadIndex','returnCodeOrSampleNo'],commands:rows(commands,3,commandCount),payloads:payloads.map(text=>JSON.parse(text)),strings:[...strings],
   sampleFields:RUN_TIMELINE_JOURNAL_SAMPLE_FIELDS,samples:rows(samples,SW,sampleCount),frameFields:RUN_TIMELINE_JOURNAL_FRAME_FIELDS,frames:rows(frames,FW,frameCount)};
 }
 function dispose(){if(disposed)return;disposed=true;commands.fill(0);samples.fill(0);frames.fill(0);commands=null;samples=null;frames=null;payloads=[];strings=[];}
 return Object.freeze({timeline,bindFrame,read,dispose});
}
