/** Progressive Tower art. Gameplay never waits for these optional textures. */
import {preloadImages} from '../shared/image-preloader.mjs';
const urls=import.meta.glob('./assets/v2/*.webp',{eager:true,query:'?url',import:'default'});
const manifests=import.meta.glob('./assets/v2/manifest.json',{eager:true,import:'default'});
export const TOWER_ART=Object.fromEntries(Object.entries(urls).map(([path,url])=>[path.split('/').pop(),url]));
export const TOWER_MANIFEST=Object.values(manifests)[0]||{files:{sky:'sky-backdrop.webp',terrain:'battlefield.webp',barracks:'barracks-atlas.webp',citadel:'citadel.webp',soldiers:'soldiers-atlas.webp'},atlas:{columns:5,rows:3,anchor:{x:.5,y:.92}}};
export const artURL=(...names)=>names.map(name=>TOWER_ART[name]).find(Boolean);
export const coreAssetURL=kind=>TOWER_ART[TOWER_MANIFEST.files?.[kind]];
let readyPromise=null;
const loadedImages=new Map();
const failedImages=new Set();
const listeners=new Set();
let loading=false;
const coreKinds=['sky','terrain','barracks','citadel','soldiers'];
const coreFiles=()=>coreKinds.map(kind=>[kind,TOWER_MANIFEST.files?.[kind]]);
export const towerAssetStatus=()=>({loaded:loadedImages.size,failed:failedImages.size,total:coreKinds.length,loading,failures:[...failedImages]});
function notify(name,image){const status=towerAssetStatus();for(const listener of listeners)listener({name,image,...status});}
export function subscribeTowerAssets(listener){
 listeners.add(listener);
 for(const [name,image] of loadedImages)listener({name,image,...towerAssetStatus()});
 listener(towerAssetStatus());
 return()=>listeners.delete(listener);
}
export const getTowerImage=name=>loadedImages.get(name);
export function preloadTowerAssets(){
 // Keep one barrier even if callers request retry while it is pending. Failed
 // barriers are evicted below; successful images stay in the shared cache.
 if(readyPromise)return readyPromise;
 const files=coreFiles();
 const promise=(async()=>{
  const errors=[];
  loading=true;notify();
  await Promise.all(files.map(async([kind,name])=>{
   const failure=`${kind}:${name||'missing'}`;
   const url=TOWER_ART[name];
   if(!name||!url){errors.push(failure);failedImages.add(failure);notify();return;}
   if(loadedImages.has(name)){failedImages.delete(failure);return;}
   try{const [image]=await preloadImages([url]);loadedImages.set(name,image);failedImages.delete(failure);notify(name,image);}
   catch{errors.push(failure);failedImages.add(failure);notify();}
  }));
  loading=false;notify();
  if(errors.length){const e=new Error('部分战场画面资源加载失败');e.code='TOWER_ASSETS_FAILED';e.failures=errors;throw e;}
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
