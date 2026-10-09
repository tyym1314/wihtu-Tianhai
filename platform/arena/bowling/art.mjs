import {LoadingManager,Texture,SRGBColorSpace} from 'three';
import {DRACOLoader} from 'three/examples/jsm/loaders/DRACOLoader.js';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
/** Decode once; each mounted lane owns its GPU geometry/material/texture clones. */
const venueModel=new URL('./assets/models/neon-private-venue.glb',import.meta.url).href;
const desktopModels=[venueModel,new URL('./assets/models/neon-competition-pin.glb',import.meta.url).href,new URL('./assets/models/neon-pearl-ball-runtime-v1.glb',import.meta.url).href];
const mobileModels=[venueModel,new URL('./assets/models/neon-competition-pin-mobile-v1.glb',import.meta.url).href,new URL('./assets/models/neon-pearl-ball-mobile-v1.glb',import.meta.url).href];
function mobileArtwork(){return globalThis.matchMedia?.('(pointer: coarse)').matches||Math.min(globalThis.innerWidth||Infinity,globalThis.innerHeight||Infinity)<=600;}
const images=[new URL('./assets/textures/pearl-resin-imagegen.webp',import.meta.url).href,new URL('./assets/textures/crown-wall-imagegen.webp',import.meta.url).href];
function release(roots,textures){const geometry=new Set(),materials=new Set(),maps=new Set(textures);for(const root of roots)root.traverse(o=>{if(o.geometry)geometry.add(o.geometry);for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[]){materials.add(m);for(const value of Object.values(m))if(value?.isTexture)maps.add(value);}});for(const g of geometry)g.dispose();for(const m of materials)m.dispose();for(const t of maps)t.dispose();}
async function loadSourceArt({signal,timeoutMs=20000,mobileQuality=mobileArtwork()}={}){
 const models=mobileQuality?mobileModels:desktopModels;
 const manager=new LoadingManager();manager.setURLModifier(u=>u.endsWith('draco_wasm_wrapper.js')?new URL('./assets/draco/draco_wasm_wrapper.js',import.meta.url).href:u.endsWith('draco_decoder.wasm')?new URL('./assets/draco/draco_decoder.wasm',import.meta.url).href:u);
 const draco=new DRACOLoader(manager).setDecoderPath('oasis-draco/').setWorkerLimit(2),loader=new GLTFLoader(manager).setDRACOLoader(draco),roots=[],textures=[],controller=new AbortController();
 const timeoutError=new Error('Bowling artwork preparation timed out');let active=true,timer,rejectCancelled;
 const cancelled=new Promise((_,reject)=>{rejectCancelled=reject;});cancelled.catch(()=>{});
 const cancel=(reason=signal?.reason||new DOMException('Artwork loading cancelled','AbortError'))=>{if(!active)return;active=false;controller.abort(reason);manager.abort();for(const worker of draco.workerPool)for(const callback of Object.values(worker._callbacks||{}))callback.reject(reason);draco.dispose();rejectCancelled(reason);};
 const abort=()=>cancel();signal?.addEventListener('abort',abort,{once:true});
 // Three r180's decoder library loader otherwise shares pending URLs globally.
 // Own each generation's fetch so a cancelled old request cannot poison retry.
 draco._loadLibrary=async(name,type)=>{const response=await fetch(manager.resolveURL(draco.decoderPath+name),{signal:controller.signal});if(!response.ok)throw new Error('Bowling decoder load failed');const result=await(type==='arraybuffer'?response.arrayBuffer():response.text());if(!active)throw timeoutError;return result;};
 const loadTexture=async url=>{
  const response=await fetch(url,{signal:controller.signal});if(!response.ok)throw new Error('Bowling image load failed');const blob=await response.blob();if(!active)throw controller.signal.reason||timeoutError;
  // A unique object URL prevents Image's URL cache joining an abandoned request.
  return new Promise((resolve,reject)=>{
   const image=new Image(),objectURL=URL.createObjectURL(blob);image.decoding='async';let done=false;
   const finish=error=>{if(done)return;done=true;image.onload=image.onerror=null;controller.signal.removeEventListener('abort',stop);URL.revokeObjectURL(objectURL);if(error){image.src='';reject(error);return;}const texture=new Texture(image);texture.needsUpdate=true;textures.push(texture);resolve(texture);};
   const stop=()=>finish(controller.signal.reason||timeoutError);controller.signal.addEventListener('abort',stop,{once:true});
   image.onload=()=>{Promise.resolve().then(()=>image.decode?.()).then(()=>finish(active?null:timeoutError),()=>finish(new Error('Bowling image decode failed')));};image.onerror=()=>finish(new Error('Bowling image load failed'));image.src=objectURL;
  });
 };
 try{
  timer=setTimeout(()=>cancel(timeoutError),timeoutMs);if(signal?.aborted)cancel();
  draco.preload();
  // _getWorker waits on this exact promise; a late decoder must never spawn.
  draco.decoderPending=draco.decoderPending.then(()=>{if(!active){draco.dispose();throw timeoutError;}});
  const tasks=[...models.map(async url=>{const response=await fetch(url,{signal:controller.signal});if(!response.ok)throw new Error('Bowling model load failed');const data=await response.arrayBuffer();if(!active)throw timeoutError;const gltf=await loader.parseAsync(data,new URL('.',url).href);if(!active){release([gltf.scene],[]);throw timeoutError;}roots.push(gltf.scene);return gltf;}),...images.map(loadTexture),draco.decoderPending];
  const results=await Promise.race([Promise.all(tasks),cancelled]);
  const[venue,pin,ball,resin,wall]=results;wall.colorSpace=SRGBColorSpace;
 resin.colorSpace=SRGBColorSpace;resin.anisotropy=4;for(const a of[venue,pin,ball])a.scene.traverse(o=>{if(o.isMesh){o.castShadow=a!==venue;o.receiveShadow=true;for(const m of Array.isArray(o.material)?o.material:[o.material]){m.envMapIntensity=a===venue?.24:.85;if(a===venue&&!m.emissive?.getHex())m.roughness=Math.max(m.roughness,.34);if(a===venue){m.clearcoat=0;if(/titanium/i.test(m.name)){m.color.set('#070b26');m.roughness=.25;m.metalness=.82;m.envMapIntensity=.12;}if(/acoustic/i.test(m.name)){m.color.set('#03040e');m.roughness=.88;m.metalness=0;m.envMapIntensity=.025;}if(/anodized/i.test(m.name)){m.color.set('#050714');m.roughness=.65;m.metalness=.25;m.envMapIntensity=.035;}if(/leather/i.test(m.name)){m.color.set('#0a0a18');m.roughness=.74;m.metalness=0;m.envMapIntensity=.07;}if(/diffuser/i.test(m.name)){m.color.setRGB(.001,.001,.003);m.metalness=0;m.roughness=1;m.emissive.setRGB(.002,.025,1);m.emissiveIntensity=11;}if(/neon glass/i.test(m.name)){m.color.setRGB(.001,.001,.003);m.metalness=0;m.roughness=1;m.emissive.setRGB(.075,.002,1);m.emissiveIntensity=8;}}if(a===ball){if(/bore/i.test(m.name)){m.map=null;m.color.set('#020106');m.roughness=.86;m.metalness=0;m.envMapIntensity=.04;}else{m.map=resin;m.color.set('#b49cff');m.roughness=.13;m.metalness=.38;}}if(a===pin){m.envMapIntensity=.35;m.roughness=.26;if(/porcelain/i.test(m.name))m.color.multiplyScalar(.61);}m.needsUpdate=true;}}});
  return{venue:venue.scene,pin:pin.scene,ball:ball.scene,wall,quality:mobileQuality?'mobile-lod-v1':'desktop'};
 }catch(error){cancel(error);release(roots,textures);roots.length=0;textures.length=0;throw error;}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);draco.dispose();}
}
/** Each failed/abandoned attempt owns its abort and can never replace a newer one. */
export function createNeonArtPreloader({timeoutMs=20000,mobileQuality=mobileArtwork()}={}){
 let generation=null;
 return function preload({signal}={}){
  if(signal?.aborted)return Promise.reject(signal.reason||new DOMException('Artwork loading cancelled','AbortError'));
  if(!generation){const current={controller:new AbortController(),users:0,settled:false};generation=current;current.promise=loadSourceArt({signal:current.controller.signal,timeoutMs,mobileQuality}).then(value=>{current.settled=true;return value;},error=>{current.settled=true;if(generation===current)generation=null;throw error;});}
  const current=generation;current.users++;
  return new Promise((resolve,reject)=>{let done=false;const finish=(error,value)=>{if(done)return;done=true;signal?.removeEventListener('abort',abort);current.users--;if(!current.settled&&!current.users){if(generation===current)generation=null;current.controller.abort(new DOMException('Artwork loading cancelled','AbortError'));}error?reject(error):resolve(value);};const abort=()=>finish(signal.reason||new DOMException('Artwork loading cancelled','AbortError'));signal?.addEventListener('abort',abort,{once:true});current.promise.then(value=>finish(null,value),error=>finish(error));});
 };
}
export const preloadNeonArt=createNeonArtPreloader();
export async function loadNeonArt(options){
 const source=await preloadNeonArt(options),geometries=new Map(),materials=new Map(),textures=new Map();let disposed=false;
 const texture=t=>{if(!textures.has(t)){const clone=t.clone();clone.needsUpdate=true;textures.set(t,clone);}return textures.get(t);};
 const material=m=>{if(!materials.has(m)){const clone=m.clone();for(const[key,value]of Object.entries(m))if(value?.isTexture)clone[key]=texture(value);materials.set(m,clone);}return materials.get(m);};
 const scene=root=>{const clone=root.clone(true);clone.traverse(o=>{if(!o.isMesh)return;if(!geometries.has(o.geometry))geometries.set(o.geometry,o.geometry.clone());o.geometry=geometries.get(o.geometry);o.material=Array.isArray(o.material)?o.material.map(material):material(o.material);});return clone;};
 return{venue:scene(source.venue),pin:scene(source.pin),ball:scene(source.ball),wall:texture(source.wall),quality:source.quality,dispose(){if(disposed)return;disposed=true;for(const g of geometries.values())g.dispose();for(const m of materials.values())m.dispose();for(const t of textures.values())t.dispose();}};
}
