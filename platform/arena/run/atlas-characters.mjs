import * as T from 'three';
import foxRun from './assets/atlases/run-fox-v4-mobile-bd3571fd7e.webp?url';
import catRun from './assets/atlases/run-cat-v4-mobile-e8ac410768.webp?url';
import bearRun from './assets/atlases/run-bear-v4-mobile-9b7c40a00c.webp?url';
import rabbitRun from './assets/atlases/run-rabbit-v4-mobile-415ab8b203.webp?url';
import actionUrl from './assets/atlases/action-back-mobile-81e5c62e42.webp?url';
import frontUrl from './assets/atlases/front-win-mobile-902055527a.webp?url';
import {createRunSourceCache,loadRunTexture,prepareRunAssets} from './asset-loading.mjs';
import {selectRunPreloadKinds} from './asset-selection.mjs';
export const RUN_CYCLE_URLS={fox:foxRun,cat:catRun,bear:bearRun,rabbit:rabbitRun};
export const RUN_ATLAS_URLS={run:foxRun,action:actionUrl,front:frontUrl};
export const RUN_CYCLE_FRAMES=8;
// Fetch owns cancellation. CSS portraits lease a Blob URL from the same front
// source; WebKit otherwise splits native fetch and CSS image cache entries.
const order=['fox','cat','bear','rabbit'],cache=new Map();
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n)),TAU=Math.PI*2;
function texture(url,options){
 if(!cache.has(url))cache.set(url,createRunSourceCache(async options=>{const t=await loadRunTexture(url,{...options,retainBlob:url===frontUrl});t.colorSpace=T.SRGBColorSpace;t.magFilter=T.LinearFilter;t.minFilter=T.LinearFilter;t.generateMipmaps=false;return t;}));
 return cache.get(url)(options);
}
export function preloadIllustratedRunners(kinds,options){return prepareRunAssets([...selectRunPreloadKinds(kinds).map(kind=>RUN_CYCLE_URLS[kind]),actionUrl,frontUrl].map(url=>options=>texture(url,options)),options);}
/** One DOM-owned URL for all portraits; keep the original CSS crop and image pixels. */
export async function createRunPortraitLease(options={}){
 const source=await texture(frontUrl,options);if(options.signal?.aborted)throw options.signal.reason;
 const url=URL.createObjectURL(source.userData.sourceBlob);let disposed=false;
 return{url,dispose(){if(!disposed){disposed=true;URL.revokeObjectURL(url);}}};
}
/** Original fixed-angle artwork. Motion follows projected server positions, with no gameplay decisions. */
export function createIllustratedRunner(kind='fox',ghost=false,{onError=()=>{}}={}){
 if(!order.includes(kind))kind='fox';
 const row=order.indexOf(kind),root=new T.Group();
 const sprite=new T.Sprite(new T.SpriteMaterial({transparent:true,alphaTest:.12,depthTest:true,depthWrite:false,toneMapped:false}));
 // Three's default Sprite geometry is global; renderer listeners must belong
 // to this runner and be released when its scene exits.
 sprite.geometry=sprite.geometry.clone();
 sprite.center.set(.5,.035);sprite.scale.set(1.65,1.65,1);root.add(sprite);sprite.visible=false;
 const shadow=new T.Mesh(new T.CircleGeometry(.38,32),new T.MeshBasicMaterial({color:0x342b19,transparent:true,opacity:.18,depthWrite:false}));
 shadow.name='runner-ground-shadow';shadow.rotation.x=-Math.PI/2;shadow.position.y=.012;root.add(shadow);
 const ring=new T.Mesh(new T.TorusGeometry(.42,.016,6,36),new T.MeshBasicMaterial({color:ghost?0x64bbb4:0xffd47b,transparent:true,opacity:ghost?.32:.75}));
 ring.rotation.x=-Math.PI/2;ring.position.y=.018;root.add(ring);
 const shield=new T.Mesh(new T.SphereGeometry(.85,24,18),new T.MeshPhysicalMaterial({color:0x65fff1,transparent:true,opacity:.09,roughness:.1,depthWrite:false}));
 shield.position.y=.78;shield.visible=false;root.add(shield);
 root.userData={character:kind,loaded:false,bones:0,clip:'loading',modelSource:'8-frame illustrated cycle on authoritative 3D trajectory',renderer:'atlas',trophy:'embedded',runFrameCount:RUN_CYCLE_FRAMES};
 const controller=new AbortController();let textures=null,dead=false,lastArgs=null,lastFall=null,recoverTick=-100,finishVisual=null,lastSheet=null,lastFrame=null;
 const ready=preloadIllustratedRunners([kind],{signal:controller.signal}).then(source=>{
  if(dead)return;
  textures=Object.fromEntries(['run','action','front'].map((key,i)=>{const t=source[i].clone();t.needsUpdate=true;return[key,t];}));
  root.userData.loaded=true;sprite.visible=true;if(lastArgs)pose(...lastArgs);else pose('idle',0,0);
 }).catch(error=>{if(!dead)onError(error);});
 function frame(sheet,index){
  if(!textures)return;
  if(sheet===lastSheet&&index===lastFrame)return;
  const t=textures[sheet],columns=4,rows=sheet==='run'?2:4,cellRow=sheet==='run'?Math.floor(index/4):row,column=index%4;
  // Inset half a texel to prevent adjacent frames leaking at filtered edges.
  const dx=.5/t.image.width,dy=.5/t.image.height;
  t.repeat.set(1/columns-2*dx,1/rows-2*dy);t.offset.set(column/columns+dx,1-(cellRow+1)/rows+dy);
  if(sheet!==lastSheet){const firstMap=!sprite.material.map;sprite.material.map=t;if(firstMap)sprite.material.needsUpdate=true;lastSheet=sheet;}
  lastFrame=index;
  root.userData.sheet=sheet;root.userData.frame=index;root.userData.uv=t.offset.toArray();
 }
 function pose(clip,elapsed,time=elapsed){
  lastArgs=[clip,elapsed,time];let sheet='front',index=3,bob=0,tilt=0,sy=1,sx=1;
  if(clip==='run'){
   // elapsed is travelled distance / 4.4m: cadence follows actual movement.
   const phase=Math.max(0,elapsed)%1;sheet='run';index=Math.floor(phase*RUN_CYCLE_FRAMES);
   bob=.012*(1-Math.cos(phase*TAU*2));tilt=Math.sin(phase*TAU)*.014;
  }else if(['jump','land','slide','hit','fall','recover'].includes(clip)){
   sheet='action';index=clip==='slide'?1:clip==='hit'?2:clip==='fall'?3:0;
   if(clip==='jump'){const phase=clamp(elapsed/.8,0,1);sy=1+.045*Math.sin(phase*Math.PI);sx=1-.025*Math.sin(phase*Math.PI);tilt=.025*Math.sin(phase*TAU);}
   if(clip==='slide'){const press=Math.sin(clamp(elapsed/.6,0,1)*Math.PI);sy=.9-.035*press;sx=1+.025*press;}
   if(clip==='fall')tilt=Math.min(1.5,elapsed*1.8);
   if(clip==='land'){sheet='run';index=0;const press=Math.sin(clamp(elapsed/(10/60),0,1)*Math.PI);sy=1-.11*press;sx=1+.07*press;}
   if(clip==='recover'){sheet='run';index=0;sy=.86+.14*clamp(elapsed/.6,0,1);}
   if(clip==='hit'){tilt=Math.sin(elapsed*24)*.06*Math.max(0,1-elapsed/.8);sy=1-.045*Math.sin(clamp(elapsed/.8,0,1)*Math.PI);}
  }else if(clip==='finish'){
   sheet='front';index=0;bob=Math.sin(clamp(elapsed/1.2,0,1)*Math.PI)*.06;
  }else if(clip==='celebrate'){
   sheet='front';index=Math.floor(Math.max(0,elapsed)/1.3)%2+1;bob=Math.sin(elapsed*3)*.025;tilt=Math.sin(elapsed*2)*.015;
  }else if(clip==='rear-idle'){
   sheet='run';index=0;
  }
  frame(sheet,index);sprite.position.y=bob;sprite.material.rotation=tilt;
  sprite.scale.set(1.65*sx,1.65*sy,1);root.userData.clip=clip;root.userData.clipTime=elapsed;
 }
 function animate(p,tick,time){
  if(lastFall!==null&&p.fallUntilTick===null)recoverTick=tick;
  lastFall=p.fallUntilTick;let clip='run',elapsed=Math.max(0,p.visualDistance??p.distance)/4.4;
  if(p.finishTick!==null){
   if(finishVisual===null)finishVisual=time-Math.max(0,(tick-p.finishTick)/60);
   const t=time-finishVisual;clip=t<1.2?'finish':p.visualWinner===false?'idle':'celebrate';elapsed=t<1.2?t:t-1.2;
  }else if(p.fallUntilTick!==null){clip='fall';elapsed=(tick-p.fallStartTick)/60;}
  else if(tick<p.stunUntilTick){clip='hit';elapsed=(tick-(p.stunUntilTick-48))/60;}
  else if(tick-recoverTick<36&&recoverTick>=0){clip='recover';elapsed=(tick-recoverTick)/60;}
  else if(tick<p.slideUntilTick){clip='slide';elapsed=(tick-(p.slideUntilTick-36))/60;}
  else if(p.jumpStartTick!==null&&tick>=p.jumpStartTick&&tick-p.jumpStartTick<48){clip='jump';elapsed=(tick-p.jumpStartTick)/60;}
  else if(p.jumpStartTick!==null&&tick-p.jumpStartTick>=48&&tick-p.jumpStartTick<58){clip='land';elapsed=(tick-p.jumpStartTick-48)/60;}
  else if(p.speed===0){clip='rear-idle';elapsed=0;}
  pose(clip,elapsed,time);shield.visible=tick<p.shieldUntilTick;shield.rotation.y=time*.6;
  const airborne=Math.max(0,p.visualHeight??0),scale=Math.max(.001,root.scale.y);
  shadow.visible=ring.visible=p.fallUntilTick===null;
  shadow.position.y=(.012-airborne)/scale;ring.position.y=(.018-airborne)/scale;
  shadow.scale.setScalar(1-.30*clamp(airborne/1.3,0,1));shadow.material.opacity=.18-.08*clamp(airborne/1.3,0,1);
  root.userData.groundShadowHeight=airborne+shadow.position.y*scale;root.userData.authoritativeTick=tick;
 }
 return{root,ready,pose,animate,getBone(){return null},dispose(){if(dead)return;dead=true;controller.abort();for(const t of Object.values(textures||{}))t.dispose();for(const m of[sprite,ring,shadow,shield]){m.geometry?.dispose();m.material.dispose();}root.clear();}};
}
