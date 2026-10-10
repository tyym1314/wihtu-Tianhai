import {Texture} from 'three';
import {runAssetAborted as aborted} from './source-cache.mjs';
import {acquireRunImageSource} from './asset-sources.mjs';
export {createRunSourceCache,prepareRunAssets} from './source-cache.mjs';
/** Same-origin no-cors/include matches CSS image fetching; Blob URLs own decode. */
export async function loadRunTexture(url,{signal,retainBlob=false}={}){
 if(signal?.aborted)throw aborted(signal);
 const blob=await acquireRunImageSource(url,{signal});if(signal?.aborted)throw aborted(signal);
 return new Promise((resolve,reject)=>{
  const image=new Image(),objectURL=URL.createObjectURL(blob);image.decoding='async';let done=false;
  const finish=error=>{if(done)return;done=true;image.onload=image.onerror=null;signal?.removeEventListener('abort',cancel);URL.revokeObjectURL(objectURL);if(error){image.src='';reject(error);return;}const texture=new Texture(image);if(retainBlob)texture.userData.sourceBlob=blob;texture.needsUpdate=true;resolve(texture);};
  const cancel=()=>finish(aborted(signal));signal?.addEventListener('abort',cancel,{once:true});
  image.onload=()=>Promise.resolve().then(()=>image.decode?.()).then(()=>finish(signal?.aborted?aborted(signal):null),()=>finish(new Error('Run image decode failed')));image.onerror=()=>finish(new Error('Run image download failed'));try{image.src=objectURL;}catch(error){finish(error);}
 });
}
