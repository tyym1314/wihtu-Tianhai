import * as T from 'three';
import {createRunSourceCache,loadRunTexture,prepareRunAssets} from './asset-loading.mjs';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import kitUrl from './assets/environment/oasis-kit-runtime-v1.glb?url';
import stoneUrl from '../golf/assets/textures/aged-sandstone-imagegen-mobile-dcc28108d4.webp?url';
import normalUrl from '../golf/assets/textures/sandstone-normal.webp?url';
import backdropUrl from '../golf/assets/textures/oasis-distant-palace-mobile-e251f780d8.webp?url';
const backdrop=createRunSourceCache(async options=>{const texture=await loadRunTexture(backdropUrl,options);texture.colorSpace=T.SRGBColorSpace;return texture;});
const albedoMap=createRunSourceCache(async options=>{const texture=await loadRunTexture(stoneUrl,options);texture.colorSpace=T.SRGBColorSpace;texture.wrapS=texture.wrapT=T.RepeatWrapping;texture.anisotropy=4;return texture;});
const normalMap=createRunSourceCache(async options=>{const texture=await loadRunTexture(normalUrl,options);texture.wrapS=texture.wrapT=T.RepeatWrapping;texture.anisotropy=4;return texture;});
export const loadOasisBackdrop=options=>backdrop(options);
export const loadStoneTextures=options=>prepareRunAssets([albedoMap,normalMap],options).then(([albedo,normal])=>({albedo,normal}));
function worldUV(geometry){const g=geometry.clone(),p=g.attributes.position,n=g.attributes.normal,uv=new Float32Array(p.count*2);for(let i=0;i<p.count;i++){const ax=Math.abs(n.getX(i)),ay=Math.abs(n.getY(i)),az=Math.abs(n.getZ(i));uv[i*2]=(ax>=ay&&ax>=az?p.getZ(i):p.getX(i))*.85;uv[i*2+1]=(ay>=ax&&ay>=az?p.getZ(i):p.getY(i))*.85;}g.setAttribute('uv',new T.BufferAttribute(uv,2));return g;}
/** Original Blender cosmetic prefabs. Shared original sandstone art documented in Golf assets/PROVENANCE.md. */
function releaseModel(root){const geometries=new Set(),materials=new Set();root?.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[])materials.add(m);});for(const g of geometries)g.dispose();for(const m of materials)m.dispose();}
const kit=createRunSourceCache(async({signal})=>{
 let source=null;const replacedGeometries=new Set(),mapsPending=loadStoneTextures({signal});mapsPending.catch(()=>{});
 try{
  const response=await fetch(kitUrl,{signal});if(!response.ok)throw new Error('Run scenery download failed');const data=await response.arrayBuffer();if(signal.aborted)throw signal.reason;
  // This GLB embeds geometry only: no Draco, external buffers or image loaders.
  const gltf=await new GLTFLoader().parseAsync(data,new URL('.',new URL(kitUrl,import.meta.url)).href);source=gltf.scene;if(signal.aborted)throw signal.reason;
  const maps=await mapsPending;if(signal.aborted)throw signal.reason;
  source.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;if(/leaf/i.test(o.material.name))o.material.side=T.DoubleSide;if(/stone|grout/i.test(o.material.name)){replacedGeometries.add(o.geometry);o.geometry=worldUV(o.geometry);o.material.map=maps.albedo;o.material.normalMap=maps.normal;o.material.normalScale=new T.Vector2(.22,.22);o.material.roughness=.87;o.material.color.set(0xd4c5ac);}o.material.envMapIntensity=.45;}});
  for(const geometry of replacedGeometries)geometry.dispose();replacedGeometries.clear();
  return{source:kitUrl,clone(name){const node=source.getObjectByName(name);if(!node)throw new Error(`Missing oasis prefab ${name}`);return node.clone(true);},dispose(){releaseModel(source);}};
 }catch(error){releaseModel(source);for(const geometry of replacedGeometries)geometry.dispose();throw error;}
});
export const loadOasisKit=options=>kit(options);
