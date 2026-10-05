/** Shared readiness gate: resolving means every declared core texture decoded. */
import {preloadImages} from '../shared/image-preloader.mjs';
const urls=import.meta.glob('./assets/v2/*.webp',{eager:true,query:'?url',import:'default'});
const manifests=import.meta.glob('./assets/v2/manifest.json',{eager:true,import:'default'});
export const TOWER_ART=Object.fromEntries(Object.entries(urls).map(([path,url])=>[path.split('/').pop(),url]));
export const TOWER_MANIFEST=Object.values(manifests)[0]||{files:{sky:'sky-backdrop.webp',terrain:'battlefield.webp',barracks:'barracks-atlas.webp',citadel:'citadel.webp',soldiers:'soldiers-atlas.webp'},atlas:{columns:5,rows:3,anchor:{x:.5,y:.92}}};
export const artURL=(...names)=>names.map(name=>TOWER_ART[name]).find(Boolean);
export const coreAssetURL=kind=>TOWER_ART[TOWER_MANIFEST.files?.[kind]];
let readyPromise=null;
const loadedImages=new Map();
export const getTowerImage=name=>loadedImages.get(name);
export function preloadTowerAssets(){
 // Keep one barrier even if callers request retry while it is pending. Failed
 // barriers are evicted below; successful images stay in the shared cache.
 if(readyPromise)return readyPromise;
 const files=Object.entries(TOWER_MANIFEST.files||{}).filter(([key])=>['sky','terrain','barracks','citadel','soldiers'].includes(key));
 const promise=(async()=>{
  const errors=[];
  if(files.length!==5)errors.push('manifest:missing-core-assets');
  const images=await Promise.all(files.map(async([kind,name])=>{const url=TOWER_ART[name];if(!url){errors.push(`${kind}:${name||'missing'}`);return;}
   try{const [image]=await preloadImages([url]);return[name,image];}catch{errors.push(`${kind}:${name}`);}
  }));
  if(errors.length){const e=new Error('战场资源未就绪，请重试加载');e.code='TOWER_ASSETS_FAILED';e.failures=errors;throw e;}
  // Publish only a complete decoded set. A timed-out decode has no remaining
  // path to this map, so its late completion cannot replace a retry's image.
  for(const [name,image] of images)loadedImages.set(name,image);
  return{images:loadedImages,manifest:TOWER_MANIFEST};
 })().catch(error=>{if(readyPromise===promise)readyPromise=null;throw error;});
 readyPromise=promise;
 return readyPromise;
}
export function atlasCell(image,teamIndex,level=1){
 const a=TOWER_MANIFEST.atlas||{},columns=a.columns||5,rows=a.rows||3,column=teamIndex<0?0:Math.min(columns-1,teamIndex+1),row=Math.max(0,Math.min(rows-1,level-1));
 const cellWidth=image.width/columns,rect=a.rowRects?.[row],cellHeight=rect?.height||image.height/rows;
 return{x:column*cellWidth,y:rect?.y??row*cellHeight,width:cellWidth,height:cellHeight,anchor:a.anchor||{x:.5,y:.92},scale:a.contentScale||1};
}
