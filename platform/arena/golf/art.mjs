import * as THREE from 'three';
import {golfMobileQuality} from './quality.mjs';
import {createGolfSourceCache} from './asset-generation-cache.mjs';
import {softenSurface} from './materials.mjs';
import {DRACOLoader} from 'three/examples/jsm/loaders/DRACOLoader.js';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
/** Authored visuals only; collision and scoring use the versioned level data. */
const desktopModels=[new URL('./assets/models/oasis-botanical-library.glb',import.meta.url).href,new URL('./assets/models/oasis-course-1.glb',import.meta.url).href,new URL('./assets/models/oasis-course-2.glb',import.meta.url).href,new URL('./assets/models/oasis-course-3.glb',import.meta.url).href];
const mobileModels=[new URL('./assets/models/oasis-botanical-library-mobile-lod-v1-38844d1da9.glb',import.meta.url).href,new URL('./assets/models/oasis-course-1-mobile-lod-v1-71a9d710b1.glb',import.meta.url).href,new URL('./assets/models/oasis-course-2-mobile-lod-v1-70fe432002.glb',import.meta.url).href,new URL('./assets/models/oasis-course-3-mobile-lod-v1-d03b8e3b89.glb',import.meta.url).href];
const images=[new URL('./assets/textures/aged-sandstone-imagegen-mobile-dcc28108d4.webp',import.meta.url).href,new URL('./assets/textures/sandstone-normal.webp',import.meta.url).href,new URL('./assets/textures/putting-grass-imagegen-mobile-6d969fa6fc.webp',import.meta.url).href,new URL('./assets/textures/fine-grass-normal.webp',import.meta.url).href,new URL('./assets/textures/course-1-contact-ao-mobile-21f6644136.webp',import.meta.url).href,new URL('./assets/textures/course-2-contact-ao-mobile-dde247036b.webp',import.meta.url).href,new URL('./assets/textures/course-3-contact-ao-mobile-32988f4c70.webp',import.meta.url).href,new URL('./assets/textures/oasis-distant-palace-mobile-e251f780d8.webp',import.meta.url).href];
function worldUV(g){const p=g.getAttribute('position'),n=g.getAttribute('normal'),a=[];for(let i=0;i<p.count;i++){const y=Math.abs(n.getY(i)),x=Math.abs(n.getX(i));a.push((y>.6?p.getX(i):x>.6?p.getZ(i):p.getX(i))*.9,(y>.6?p.getZ(i):p.getY(i))*.9);}g.setAttribute('uv',new THREE.Float32BufferAttribute(a,2));}
function release(roots,textures,borrowed=new Set()){const geometry=new Set(),materials=new Set(),maps=new Set(textures);for(const root of roots)root.traverse(o=>{if(o.geometry)geometry.add(o.geometry);for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[]){materials.add(m);for(const value of Object.values(m))if(value?.isTexture)maps.add(value);}});for(const g of geometry)g.dispose();for(const m of materials)m.dispose();for(const t of maps)if(!borrowed.has(t))t.dispose();}
async function loadSourceArt(key,signal){
 const [tier,resource]=key.split(':'),models=tier==='mobile'?mobileModels:desktopModels,courseIndex=resource==='common'?null:Number(resource),selectedModels=courseIndex===null?[models[0]]:[models[courseIndex+1]],selectedImages=courseIndex===null?[...images.slice(0,4),images[7]]:[images[courseIndex+4]],borrowed=new Set();
 const manager=new THREE.LoadingManager();manager.setURLModifier(u=>u.endsWith('draco_wasm_wrapper.js')?new URL('./assets/draco/draco_wasm_wrapper.js',import.meta.url).href:u.endsWith('draco_decoder.wasm')?new URL('./assets/draco/draco_decoder.wasm',import.meta.url).href:u);
 const draco=new DRACOLoader(manager).setDecoderPath('oasis-draco/').setWorkerLimit(2),loader=new GLTFLoader(manager).setDRACOLoader(draco),roots=[],textures=[],controller=new AbortController();
 const commonPromise=courseIndex===null?null:acquireSource(tier+':common',{signal:controller.signal});
 // Use this generation's native fetch for decoder files too. Three FileLoader
 // shares pending URL requests globally; an uncancellable old request must not
 // be silently reused by a fresh retry (including browsers without Signal.any).
 draco._loadLibrary=async(name,type)=>{const response=await fetch(manager.resolveURL(draco.decoderPath+name),{signal:controller.signal});if(!response.ok)throw new Error('Golf decoder load failed');return type==='arraybuffer'?response.arrayBuffer():response.text();};
 const timeoutError=new Error('Golf artwork preparation timed out');let active=true,timer;
 const aborted=()=>signal?.reason||new DOMException('Golf artwork preparation cancelled','AbortError');
 const cancel=(error=timeoutError)=>{if(!active)return;active=false;controller.abort(error);manager.abort();for(const worker of draco.workerPool)for(const callback of Object.values(worker._callbacks||{}))callback.reject(error);draco.dispose();};
 let rejectCancellation;const cancellation=new Promise((_,reject)=>{rejectCancellation=reject;});const abortSource=()=>{const error=aborted();cancel(error);rejectCancellation(error);};signal?.addEventListener('abort',abortSource,{once:true});if(signal?.aborted)abortSource();
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{cancel();reject(timeoutError);},20000);});
 const loadTexture=async url=>{
  const response=await fetch(url,{signal:controller.signal});if(!response.ok)throw new Error('Golf image load failed');const blob=await response.blob();if(!active)throw controller.signal.reason||timeoutError;
  const objectUrl=URL.createObjectURL(blob);
  return new Promise((resolve,reject)=>{
   const image=new Image();image.decoding='async';let done=false;
   const finish=error=>{if(done)return;done=true;image.onload=image.onerror=null;controller.signal.removeEventListener('abort',abort);URL.revokeObjectURL(objectUrl);if(error){image.src='';reject(error);return;}const texture=new THREE.Texture(image);texture.needsUpdate=true;textures.push(texture);resolve(texture);};
   const abort=()=>finish(controller.signal.reason||timeoutError);controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted){abort();return;}
   image.onload=()=>{Promise.resolve().then(()=>image.decode?.()).then(()=>finish(active?null:timeoutError),()=>finish(new Error('Golf image decode failed')));};image.onerror=()=>finish(new Error('Golf image load failed'));image.src=objectUrl;
  });
 };

 try{
  // Start small decoder dependencies before this common/current-course bundle
  // occupies the connection pool. Include its pending promise in the bounded
  // preparation barrier so an early decoder failure cannot go unhandled.
  draco.preload();
  // Three's worker acquisition waits on decoderPending. Guard that exact
  // promise so a decoder that arrives after cancellation cannot spawn workers.
  draco.decoderPending=draco.decoderPending.then(()=>{if(!active){draco.dispose();throw timeoutError;}});
  const tasks=[...selectedModels.map(async url=>{const response=await fetch(url,{signal:controller.signal});if(!response.ok)throw new Error('Golf model load failed');const data=await response.arrayBuffer();if(!active)throw timeoutError;const gltf=await loader.parseAsync(data,new URL('.',url).href);if(!active){release([gltf.scene],[]);throw timeoutError;}roots.push(gltf.scene);return gltf.scene;}),...selectedImages.map(loadTexture),draco.decoderPending];
  // Each task has a cancellation/late-result owner; failure can now unblock
  // retry promptly instead of waiting forever for an unrelated pending load.
  const results=await Promise.race([Promise.all([...tasks,commonPromise]),deadline,cancellation]);
  const botanicals=courseIndex===null?results[0]:null,courses=courseIndex===null?[]:[results[0]],ownTextures=results.slice(selectedModels.length,selectedModels.length+selectedImages.length),common=courseIndex===null?null:results.at(-1);
  const [stone,normal,grass,grassNormal,distant]=courseIndex===null?ownTextures:[common.stone,common.normal,common.grass,common.grassNormal,common.distant];
  if(common)for(const t of[stone,normal,grass,grassNormal,distant])borrowed.add(t);
  const ao=courseIndex===null?[]:ownTextures;
  if(courseIndex===null)for(const t of[stone,normal,grass,grassNormal]){t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=4;}if(courseIndex===null){stone.colorSpace=grass.colorSpace=THREE.SRGBColorSpace;grass.repeat.set(.34,.34);grassNormal.repeat.set(2,2);}
  const prepared=new Set();for(const root of[...courses,...(botanicals?[botanicals]:[])])root.traverse(o=>{o.userData.imported=true;if(!o.isMesh)return;o.castShadow=o.receiveShadow=true;for(const m of Array.isArray(o.material)?o.material:[o.material]){if(/sandstone|coping/i.test(m.name))worldUV(o.geometry);if(prepared.has(m))continue;prepared.add(m);if(/sandstone|coping/i.test(m.name)){m.map=stone;m.normalMap=normal;m.normalScale.set(.22,.22);m.color.multiplyScalar(1.12);m.roughness=.89;softenSurface(m,'stone');}if(/leaf|flower/i.test(m.name)){m.side=THREE.DoubleSide;m.envMapIntensity=.15;if(/leaf/i.test(m.name)){m.color.multiplyScalar(.62);m.roughness=.78;softenSurface(m,'leaf');}}m.needsUpdate=true;}});
  for(const t of ao){t.channel=1;t.anisotropy=4;}
  return{ao,courses,botanicals,stone,normal,grass,grassNormal,distant,dispose(){release(roots,textures,borrowed);}};
 }catch(error){cancel(error);release(roots,textures,borrowed);roots.length=0;textures.length=0;throw error;}finally{clearTimeout(timer);signal?.removeEventListener('abort',abortSource);draco.dispose();}
}
const acquireSource=createGolfSourceCache(loadSourceArt);
/** The lobby warms only common art: it does not yet know the pinned first hole. */
export function preloadOasisArt({signal,artIndex,mobileQuality=golfMobileQuality()}={}){
 if(artIndex!==undefined&&(!Number.isInteger(artIndex)||artIndex<0||artIndex>2))return Promise.reject(new RangeError('Invalid golf artwork index'));
 return acquireSource((mobileQuality?'mobile:':'desktop:')+(artIndex===undefined?'common':String(artIndex)),{signal});
}
export async function loadOasisArt({signal,artIndex=0,mobileQuality=golfMobileQuality()}={}){
 const controller=new AbortController(),abort=()=>controller.abort(signal.reason||new DOMException('Golf artwork preparation cancelled','AbortError'));
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 let source,first;
 try{[source,first]=await Promise.all([preloadOasisArt({signal:controller.signal,mobileQuality}),preloadOasisArt({signal:controller.signal,artIndex,mobileQuality})]);}catch(error){controller.abort(error);signal?.removeEventListener('abort',abort);throw error;}
 if(controller.signal.aborted){signal?.removeEventListener('abort',abort);throw controller.signal.reason;}
 const geometries=new Map(),materials=new Map(),textures=new Map();
 const texture=t=>{if(!textures.has(t)){const clone=t.clone();clone.needsUpdate=true;textures.set(t,clone);}return textures.get(t);};
 const material=m=>{if(!materials.has(m)){const clone=m.clone();clone.onBeforeCompile=m.onBeforeCompile;clone.customProgramCacheKey=m.customProgramCacheKey;for(const [key,value]of Object.entries(m))if(value?.isTexture)clone[key]=texture(value);materials.set(m,clone);}return materials.get(m);};
 const scene=root=>{const clone=root.clone(true);clone.traverse(o=>{if(!o.isMesh)return;if(!geometries.has(o.geometry))geometries.set(o.geometry,o.geometry.clone());o.geometry=geometries.get(o.geometry);o.material=Array.isArray(o.material)?o.material.map(material):material(o.material);});return clone;};
 let disposed=false;const courses=Array(3).fill(null),ao=Array(3).fill(null),pending=new Map();
 const install=(index,bundle)=>{if(disposed||controller.signal.aborted)throw controller.signal.reason||new DOMException('Golf artwork disposed','AbortError');courses[index]=scene(bundle.courses[0]);ao[index]=texture(bundle.ao[0]);return courses[index];};
 install(artIndex,first);
 const art={courses,ao,tier:mobileQuality?'mobile':'desktop',botanicals:scene(source.botanicals),grass:texture(source.grass),grassNormal:texture(source.grassNormal),distant:texture(source.distant),
  ensureCourse(index){
   if(!Number.isInteger(index)||index<0||index>2)return Promise.reject(new RangeError('Invalid golf artwork index'));
   if(disposed)return Promise.reject(new DOMException('Golf artwork disposed','AbortError'));
   if(courses[index])return Promise.resolve(courses[index]);
   if(!pending.has(index)){const promise=preloadOasisArt({signal:controller.signal,artIndex:index,mobileQuality}).then(bundle=>install(index,bundle)).finally(()=>pending.delete(index));pending.set(index,promise);}
   return pending.get(index);
  },
  dispose(){if(disposed)return;disposed=true;controller.abort(new DOMException('Golf artwork disposed','AbortError'));signal?.removeEventListener('abort',abort);for(const g of geometries.values())g.dispose();for(const m of materials.values())m.dispose();for(const t of textures.values())t.dispose();}
 };
 return art;
}
