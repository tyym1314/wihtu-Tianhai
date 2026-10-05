import {Texture} from 'three';
const aborted=signal=>signal?.reason||new DOMException('Run asset loading cancelled','AbortError');
/** One bounded CPU source generation; scenes always clone its GPU objects. */
export function createRunSourceCache(load,{dispose=value=>value?.dispose?.(),timeoutMs=20000}={}){
 let current=null;
 return function acquire({signal}={}){
  if(signal?.aborted)return Promise.reject(aborted(signal));
  if(!current){
   const entry={controller:new AbortController(),users:0,settled:false};current=entry;
   const cancellation=new Promise((_,reject)=>{entry.rejectAbort=()=>reject(aborted(entry.controller.signal));entry.controller.signal.addEventListener('abort',entry.rejectAbort,{once:true});});
   const timer=setTimeout(()=>entry.controller.abort(new Error('Run artwork preparation timed out')),timeoutMs);
   const loading=Promise.resolve().then(()=>{if(entry.controller.signal.aborted)throw aborted(entry.controller.signal);return load({signal:entry.controller.signal});}).then(value=>{if(entry.controller.signal.aborted){dispose(value);throw aborted(entry.controller.signal);}return value;});
   entry.promise=Promise.race([loading,cancellation]).then(value=>{entry.settled=true;return value;},error=>{entry.settled=true;if(current===entry)current=null;entry.controller.abort(error);throw error;}).finally(()=>{clearTimeout(timer);entry.controller.signal.removeEventListener('abort',entry.rejectAbort);});
  }
  // React effect cleanup/setup can hand a pending source to a new roster in one turn.
  const entry=current;entry.users++;
  return new Promise((resolve,reject)=>{
   let done=false;const finish=(success,value)=>{if(done)return;done=true;signal?.removeEventListener('abort',cancel);entry.users--;if(!entry.settled&&!entry.users)queueMicrotask(()=>{if(!entry.settled&&!entry.users){if(current===entry)current=null;entry.controller.abort(new DOMException('Run asset loading cancelled','AbortError'));}});success?resolve(value):reject(value);};
   const cancel=()=>finish(false,aborted(signal));signal?.addEventListener('abort',cancel,{once:true});entry.promise.then(value=>finish(true,value),error=>finish(false,error));
  });
 };
}
/** Failed aggregate preparation cancels only its own consumers of shared assets. */
export async function prepareRunAssets(tasks,{signal}={}){
 if(signal?.aborted)throw aborted(signal);
 const controller=new AbortController(),cancel=()=>controller.abort(aborted(signal));signal?.addEventListener('abort',cancel,{once:true});
 try{return await Promise.all(tasks.map(task=>{try{return Promise.resolve(task({signal:controller.signal}));}catch(error){return Promise.reject(error);}}));}catch(error){controller.abort(error);throw error;}finally{signal?.removeEventListener('abort',cancel);}
}
/** Same-origin no-cors/include matches CSS image fetching; Blob URLs own decode. */
export async function loadRunTexture(url,{signal,retainBlob=false}={}){
 if(signal?.aborted)throw aborted(signal);
 const response=await fetch(url,{signal,mode:'no-cors',credentials:'include'});if(!response.ok)throw new Error('Run image download failed');const blob=await response.blob();if(signal?.aborted)throw aborted(signal);
 return new Promise((resolve,reject)=>{
  const image=new Image(),objectURL=URL.createObjectURL(blob);image.decoding='async';let done=false;
  const finish=error=>{if(done)return;done=true;image.onload=image.onerror=null;signal?.removeEventListener('abort',cancel);URL.revokeObjectURL(objectURL);if(error){image.src='';reject(error);return;}const texture=new Texture(image);if(retainBlob)texture.userData.sourceBlob=blob;texture.needsUpdate=true;resolve(texture);};
  const cancel=()=>finish(aborted(signal));signal?.addEventListener('abort',cancel,{once:true});
  image.onload=()=>Promise.resolve().then(()=>image.decode?.()).then(()=>finish(signal?.aborted?aborted(signal):null),()=>finish(new Error('Run image decode failed')));image.onerror=()=>finish(new Error('Run image download failed'));try{image.src=objectURL;}catch(error){finish(error);}
 });
}
