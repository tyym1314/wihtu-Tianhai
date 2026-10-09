/** Successful source objects are module-owned; pending generations are owned by consumers. */
export function createGolfSourceCache(load) {
 const entries=new Map();
 return function acquire(key,{signal}={}) {
  const aborted=()=>signal?.reason||new DOMException('Golf artwork preparation cancelled','AbortError');
  if(signal?.aborted)return Promise.reject(aborted());
  let entry=entries.get(key);
  if(!entry){
   entry={controller:new AbortController(),consumers:0,pending:true};entries.set(key,entry);
   entry.promise=Promise.resolve().then(()=>load(key,entry.controller.signal)).then(source=>{entry.pending=false;return source;},error=>{entry.pending=false;if(entries.get(key)===entry)entries.delete(key);throw error;});
  }
  entry.consumers++;
  return new Promise((resolve,reject)=>{
   let finished=false;
   const release=()=>{if(finished)return false;finished=true;signal?.removeEventListener('abort',abort);entry.consumers--;if(entry.pending&&entry.consumers===0){if(entries.get(key)===entry)entries.delete(key);entry.controller.abort(aborted());}return true;};
   const abort=()=>{if(release())reject(aborted());};signal?.addEventListener('abort',abort,{once:true});
   entry.promise.then(source=>{if(release())resolve(source);},error=>{if(release())reject(error);});
  });
 };
}
