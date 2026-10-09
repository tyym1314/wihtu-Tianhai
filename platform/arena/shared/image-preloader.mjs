/** Same-origin Image/CSS cache mode; the deadline covers download AND decode. */
export function createImagePreloader({ImageClass=globalThis.Image,timeoutMs=20000,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 const cache=new Map();
 const load=(src,fetchPriority)=>{
  if(cache.has(src))return cache.get(src);
  const promise=new Promise((resolve,reject)=>{
   const image=new ImageClass();let done=false;
   const finish=error=>{if(done)return;done=true;clearTimer(timer);image.onload=image.onerror=null;if(error){image.src='';reject(error);}else resolve(image);};
   const timer=setTimer(()=>finish(new Error('Image preparation timed out')),timeoutMs);
   image.decoding='async';image.fetchPriority=fetchPriority;image.onload=()=>{Promise.resolve().then(()=>image.decode?.()).then(()=>finish(),()=>finish(new Error('Image decode failed')));};
   image.onerror=()=>finish(new Error('Image download failed'));image.src=src;
  }).catch(error=>{if(cache.get(src)===promise)cache.delete(src);throw error;});
  cache.set(src,promise);return promise;
 };
 return (urls,{fetchPriority='auto'}={})=>Promise.all([...new Set(urls)].map(src=>load(src,fetchPriority)));
}
let preload;
export const preloadImages=(urls,options)=>(preload??=createImagePreloader())(urls,options);
