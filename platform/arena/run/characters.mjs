import {createIllustratedRunner} from './atlas-characters.mjs';
import {readRunVisualAction} from './input-presentation.mjs';
import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {clone} from 'three/examples/jsm/utils/SkeletonUtils.js';
import foxUrl from './assets/characters/fox.glb?url';
import catUrl from './assets/characters/cat.glb?url';
import bearUrl from './assets/characters/bear.glb?url';
import rabbitUrl from './assets/characters/rabbit.glb?url';
export const RUN_CHARACTER_URLS={fox:foxUrl,cat:catUrl,bear:bearUrl,rabbit:rabbitUrl};
export const RUN_CHARACTER_ORDER=['fox','cat','bear','rabbit'];
export const RUN_CHARACTER_CLIPS=['idle','run','jump','land','slide','hit','fall','recover','finish','celebrate'];
const colors={fox:0x39b9b0,cat:0xe57969,bear:0xb19cda,rabbit:0x8bd8e5};
const loader=new GLTFLoader(),cache=new Map();
function asset(kind){if(!cache.has(kind))cache.set(kind,loader.loadAsync(RUN_CHARACTER_URLS[kind]).then(gltf=>{for(const required of RUN_CHARACTER_CLIPS)if(!gltf.animations.some(a=>a.name===required))throw Error(`${kind} animation missing: ${required}`);return gltf;}));return cache.get(kind);}
export function preloadRunnerAssets(){return Promise.all(RUN_CHARACTER_ORDER.map(asset));}
export function characterFor(player,index=0){return RUN_CHARACTER_ORDER.includes(player?.character)?player.character:RUN_CHARACTER_ORDER[Number(player?.seat_index??player?.seatIndex??index)%4];}
/** Real Blender-authored skinned GLB. Positions and action start times remain server-owned. */
export function createRigRunner(kind='fox',ghost=false,{onError=()=>{}}={}){
 if(!RUN_CHARACTER_ORDER.includes(kind))kind='fox';
 const root=new T.Group(),actor=new T.Group();root.name=`runner-${kind}`;root.add(actor);actor.rotation.y=Math.PI;
 const ring=new T.Mesh(new T.TorusGeometry(.40,.018,7,40),new T.MeshBasicMaterial({color:ghost?colors[kind]:0xffdd84,transparent:true,opacity:ghost?.35:.80}));ring.rotation.x=Math.PI/2;ring.position.y=.022;root.add(ring);
 const shadow=new T.Mesh(new T.CircleGeometry(.34,32),new T.MeshBasicMaterial({color:0x3a3022,transparent:true,opacity:.14,depthWrite:false}));shadow.rotation.x=-Math.PI/2;shadow.position.y=.014;root.add(shadow);
 const shield=new T.Mesh(new T.SphereGeometry(.88,28,20),new T.MeshPhysicalMaterial({color:0x68fff0,roughness:.12,metalness:.12,transparent:true,opacity:.12,depthWrite:false}));shield.position.y=.83;shield.visible=false;root.add(shield);
 let disposed=false,model=null,mixer=null,actions=new Map(),active=null,previousTime=null,lastState=null,recoveredAt=-1,finishVisualAt=null;
 root.userData={character:kind,loaded:false,clip:'loading',bones:0,modelSource:'Blender GLB'};
 const ready=asset(kind).then(gltf=>{
  if(disposed)return;model=clone(gltf.scene);actor.add(model);
  model.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;if(o.material){o.material=Array.isArray(o.material)?o.material.map(m=>m.clone()):o.material.clone();for(const material of Array.isArray(o.material)?o.material:[o.material]){material.envMapIntensity=.65;}}}if(o.isBone)root.userData.bones++;});
  mixer=new T.AnimationMixer(model);for(const clip of gltf.animations){const action=mixer.clipAction(clip);action.paused=true;action.clampWhenFinished=true;action.setLoop(T.LoopOnce,1);actions.set(clip.name,action);}
  root.userData.loaded=true;pose('idle',0,0);if(lastState)animate(...lastState);
 }).catch(error=>{root.userData.error=String(error);onError(error);});
 function pose(name,elapsed,time=elapsed){
  if(!mixer)return;const action=actions.get(name)||actions.get('idle'),loop=['idle','run','celebrate'].includes(name),duration=action.getClip().duration;
  if(active!==action){const previous=active;action.reset().play();action.paused=true;action.setEffectiveWeight(1);if(previous)action.crossFadeFrom(previous,.08,false);active=action;}
  action.time=loop?Math.max(0,elapsed)%duration:T.MathUtils.clamp(elapsed,0,duration-.001);mixer.update(previousTime===null?0:Math.min(.05,Math.max(0,time-previousTime)));previousTime=time;root.userData.clip=name;root.userData.clipTime=action.time;
 }
 function animate(p,tick,time){
  const previous=lastState?.[0];if(previous&&previous.fallUntilTick!==null&&p.fallUntilTick===null)recoveredAt=tick;lastState=[{...p},tick,time];
  const jumping=p.jumpStartTick!==null&&tick>=p.jumpStartTick&&tick<p.jumpStartTick+48,sliding=tick<p.slideUntilTick,stunned=tick<p.stunUntilTick,falling=p.fallUntilTick!==null,finished=p.finishTick!==null;
  const visual=readRunVisualAction(p.visualAction);let clip='run',elapsed=p.distance/10;
  if(finished){if(finishVisualAt===null)finishVisualAt=time-Math.max(0,(tick-p.finishTick)/60);const t=time-finishVisualAt;clip=t<1.2?'finish':p.visualWinner===false?'idle':'celebrate';elapsed=clip==='finish'?t:t-1.2;}
  else if(falling){clip='fall';elapsed=(tick-p.fallStartTick)/60;}
  else if(stunned){clip='hit';elapsed=(tick-(p.stunUntilTick-48))/60;}
  else if(tick-recoveredAt<36&&recoveredAt>=0){clip='recover';elapsed=(tick-recoveredAt)/60;}
  else if(visual){clip=visual.type;if(clip!=='run')elapsed=visual.elapsedMs/1000;}
  else if(sliding){clip='slide';elapsed=(tick-(p.slideUntilTick-36))/60;}
  else if(jumping){clip='jump';elapsed=(tick-p.jumpStartTick)/60;}
  else if(p.jumpStartTick!==null&&tick-p.jumpStartTick<58&&tick>=p.jumpStartTick+48){clip='land';elapsed=(tick-p.jumpStartTick-48)/60;}
  else if(p.speed===0){clip='idle';elapsed=time;}
  pose(clip,elapsed,time);shield.visible=tick<p.shieldUntilTick;shield.rotation.y=time*.6;ring.visible=!falling;shadow.visible=!falling;shadow.scale.setScalar(jumping?.75:1);root.userData.authoritativeTick=tick;
 }
 function getBone(name){return model?.getObjectByName(name)||model?.getObjectByName(T.PropertyBinding.sanitizeNodeName(name));}
 return{root,ready,animate,pose,getBone,dispose(){disposed=true;if(mixer){mixer.stopAllAction();mixer.uncacheRoot(model);}model?.traverse(o=>{if(o.isMesh)for(const material of Array.isArray(o.material)?o.material:[o.material])material?.dispose();});for(const m of[ring,shadow,shield]){m.geometry.dispose();m.material.dispose();}actor.clear();}};
}

export function createRunner(kind='fox',ghost=false,options={}){return options.renderer==='rig'?createRigRunner(kind,ghost,options):createIllustratedRunner(kind,ghost,options);}
