import {createRunSourceCache,prepareRunAssets,runAssetAborted} from './source-cache.mjs';

// No Three import: real downloads can run while the renderer module is loading.
// Retain the original consumed Blob/arrayBuffer, never a clone or a second GET.
const images=new Map(),models=new Map();
function acquire(cache,url,load,options){
 if(!cache.has(url))cache.set(url,createRunSourceCache(load));
 return cache.get(url)(options);
}
export function acquireRunImageSource(url,options){
 return acquire(images,url,async({signal})=>{
  // Share the real connection with launch/model requests at lower urgency.
  // Every original texture still participates in the complete readiness gate.
  const response=await fetch(url,{signal,mode:'no-cors',credentials:'include',priority:'low'});if(!response.ok)throw new Error('Run image download failed');
  const blob=await response.blob();if(signal.aborted)throw runAssetAborted(signal);return blob;
 },options);
}
export function acquireRunModelSource(url,options){
 return acquire(models,url,async({signal})=>{
  const response=await fetch(url,{signal,priority:'high'});if(!response.ok)throw new Error('Run scenery download failed');
  const data=await response.arrayBuffer();if(signal.aborted)throw runAssetAborted(signal);return data;
 },options);
}
export function preloadRunSources({images,models},options){
 return prepareRunAssets([...new Set(images)].map(url=>options=>acquireRunImageSource(url,options)).concat([...new Set(models)].map(url=>options=>acquireRunModelSource(url,options))),options);
}
/** Source and decoded preparation share one cancellation/failure barrier. */
export function prepareRunGameSources(plan,prepareDecoded,options){
 return prepareRunAssets([options=>preloadRunSources(plan,options),prepareDecoded],options);
}
