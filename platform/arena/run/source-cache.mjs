export const runAssetAborted=signal=>signal?.reason||new DOMException('Run asset loading cancelled','AbortError');
/** One bounded CPU source generation; scenes always clone its GPU objects. */
export function createRunSourceCache(load,{dispose=value=>value?.dispose?.(),timeoutMs=20000}={}){
 let current=null;
 return function acquire({signal}={}){
  if(signal?.aborted)return Promise.reject(runAssetAborted(signal));
  if(!current){
   const entry={controller:new AbortController(),users:0,settled:false};current=entry;
   const cancellation=new Promise((_,reject)=>{entry.rejectAbort=()=>reject(runAssetAborted(entry.controller.signal));entry.controller.signal.addEventListener('abort',entry.rejectAbort,{once:true});});
   const timer=setTimeout(()=>entry.controller.abort(new Error('Run artwork preparation timed out')),timeoutMs);
   const loading=Promise.resolve().then(()=>{if(entry.controller.signal.aborted)throw runAssetAborted(entry.controller.signal);return load({signal:entry.controller.signal});}).then(value=>{if(entry.controller.signal.aborted){dispose(value);throw runAssetAborted(entry.controller.signal);}return value;});
   entry.promise=Promise.race([loading,cancellation]).then(value=>{entry.settled=true;return value;},error=>{entry.settled=true;if(current===entry)current=null;entry.controller.abort(error);throw error;}).finally(()=>{clearTimeout(timer);entry.controller.signal.removeEventListener('abort',entry.rejectAbort);});
  }
  // React effect cleanup/setup can hand a pending source to a new roster in one turn.
  const entry=current;entry.users++;
  return new Promise((resolve,reject)=>{
   let done=false;const finish=(success,value)=>{if(done)return;done=true;signal?.removeEventListener('abort',cancel);entry.users--;if(!entry.settled&&!entry.users)queueMicrotask(()=>{if(!entry.settled&&!entry.users){if(current===entry)current=null;entry.controller.abort(new DOMException('Run asset loading cancelled','AbortError'));}});success?resolve(value):reject(value);};
   const cancel=()=>finish(false,runAssetAborted(signal));signal?.addEventListener('abort',cancel,{once:true});entry.promise.then(value=>finish(true,value),error=>finish(false,error));
  });
 };
}
/** Failed aggregate preparation cancels only its own consumers of shared assets. */
export async function prepareRunAssets(tasks,{signal}={}){
 if(signal?.aborted)throw runAssetAborted(signal);
 const controller=new AbortController(),cancel=()=>controller.abort(runAssetAborted(signal));signal?.addEventListener('abort',cancel,{once:true});
 try{return await Promise.all(tasks.map(task=>{try{return Promise.resolve(task({signal:controller.signal}));}catch(error){return Promise.reject(error);}}));}catch(error){controller.abort(error);throw error;}finally{signal?.removeEventListener('abort',cancel);}
}
