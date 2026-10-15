import {t as $t} from '../shared/i18n.mjs';
import React,{useEffect,useRef,useState}from'react';
import * as T from'three';
import{RoomEnvironment}from'three/examples/jsm/environments/RoomEnvironment.js';
import{createRunner,characterFor}from'./characters.mjs';
/** Presentation only. Ranks and identities are supplied by the settled server result. */
export default function RunPodium({players=[],meId, className=''}){
 const mount=useRef(null),[error,setError]=useState('');
 const roster=players.map((p,i)=>({id:p.external_user_id||p.playerKey||p.id||String(i),rank:p.rank,character:characterFor(p,i),seatIndex:p.seat_index??p.seatIndex??i,name:p.name||'',forfeited:!!p.forfeited}));
 const signature=JSON.stringify(roster);
 useEffect(()=>{
  if(!mount.current)return;let renderer,dead=false,raf,observer;const models=[],disposables=[],root=mount.current;
  const mobileQuality=window.matchMedia?.('(pointer: coarse)').matches||Math.min(window.innerWidth,window.innerHeight)<=600;
  try{renderer=new T.WebGLRenderer({antialias:!mobileQuality,alpha:true,powerPreference:'high-performance'});}catch{setError($t("角色领奖台暂不可用"));return;}
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,mobileQuality?1.2:1.5));renderer.setClearColor(0x000000,0);renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1;renderer.shadowMap.enabled=!mobileQuality;renderer.shadowMap.type=T.PCFSoftShadowMap;root.dataset.renderQuality=mobileQuality?'mobile':'desktop';root.append(renderer.domElement);
  const scene=new T.Scene(),camera=new T.PerspectiveCamera(35,1,.1,50);camera.position.set(0,3.2,8.0);camera.lookAt(0,1.68,0);
  const pmrem=new T.PMREMGenerator(renderer),roomEnv=new RoomEnvironment(),env=pmrem.fromScene(roomEnv,.06);scene.environment=env.texture;pmrem.dispose();roomEnv.dispose();scene.add(new T.HemisphereLight(0xd5f3ff,0x4c351c,1.25));
  const key=new T.DirectionalLight(0xffe4bc,2.4);key.position.set(-3,7,5);key.castShadow=true;key.shadow.mapSize.set(1024,1024);scene.add(key);const rim=new T.DirectionalLight(0xffcc76,1.5);rim.position.set(3,4,-4);scene.add(rim);
  function mat(p){const m=new T.MeshStandardMaterial(p);disposables.push(m);return m;}const stone=mat({color:0xd2b17b,roughness:.8}),trim=mat({color:0xb98a41,roughness:.36,metalness:.55}),gold=mat({color:0xf0bb48,roughness:.2,metalness:.85}),dark=mat({color:0x173b3b,roughness:.55});
  function mesh(g,m,x,y,z){disposables.push(g);const o=new T.Mesh(g,m);o.position.set(x,y,z);o.castShadow=true;o.receiveShadow=true;scene.add(o);return o;}
  mesh(new T.CylinderGeometry(2.6,2.7,.16,64),stone,0,-.1,0);
  const ordered=[...roster].sort((a,b)=>(a.rank??99)-(b.rank??99)||a.seatIndex-b.seatIndex);const positions=ordered.length<=2?[0,-1.32]:ordered.length===3?[0,-1.3,1.3]:[0,-1.25,1.25,2.35];
  const centerShift=ordered.length===4?-.43:0;const cups=[];
  ordered.forEach((p,i)=>{
   const winner=p.rank===1&&!p.forfeited,height=winner?1.05:Math.max(.20,.72-i*.18),x=positions[i]+centerShift,z=i===3?.36:0;
   mesh(new T.CylinderGeometry(.53,.58,height,32),stone,x,height/2,z);mesh(new T.CylinderGeometry(.54,.54,.045,32),trim,x,height+.022,z);
   const badge=document.createElement('canvas');badge.width=badge.height=128;const paint=badge.getContext('2d');paint.textAlign='center';paint.textBaseline='middle';paint.font='bold 98px Georgia';paint.fillStyle='#65451b';paint.fillText(String(p.rank??'—'),64,69);const rankTexture=new T.CanvasTexture(badge);rankTexture.colorSpace=T.SRGBColorSpace;disposables.push(rankTexture);const rankMaterial=new T.MeshBasicMaterial({map:rankTexture,transparent:true,depthWrite:false});disposables.push(rankMaterial);mesh(new T.PlaneGeometry(.32,.32),rankMaterial,x,Math.max(.15,height*.52),z+.586);
   for(let row=0;row<Math.ceil(height/.22);row++){const ring=mesh(new T.TorusGeometry(.55,.009,4,32),trim,x,.12+row*.22,z);ring.rotation.x=Math.PI/2;}
   const actor=createRunner(p.character,p.id!==meId,{onError:e=>!dead&&setError(String(e.message||e))});actor.root.position.set(x,height+.035,z);actor.root.scale.setScalar(winner?1.58:i===3?1.12:1.30);actor.root.rotation.y=Math.PI+(i===0?-.08:i%2?.12:-.12);scene.add(actor.root);models.push({actor,player:p});
   if(winner){const cup=new T.Group();cups.push({cup,actor});const profile=[[.07,0],[.09,.03],[.045,.07],[.035,.17],[.11,.20],[.15,.26],[.16,.39],[.13,.43]].map(([r,y])=>new T.Vector2(r,y));const body=new T.Mesh(new T.LatheGeometry(profile,28),gold);disposables.push(body.geometry);cup.add(body);for(const side of[-1,1]){const handle=new T.Mesh(new T.TorusGeometry(.105,.015,7,22,Math.PI*1.6),gold);handle.position.set(side*.15,.29,0);handle.rotation.z=side>0?-.7:Math.PI+.7;cup.add(handle);disposables.push(handle.geometry);}scene.add(cup);}
  });
  const confetti=[];for(let i=0;i<30;i++){const m=new T.MeshBasicMaterial({color:i%3===0?0x45b9ae:0xffd170,side:T.DoubleSide});disposables.push(m);const p=mesh(new T.PlaneGeometry(.05,.095),m,(i%7-3)*.55,2+(i%11)*.22,-.7);p.castShadow=false;confetti.push({p,phase:i*.83});}
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;root.dataset.reducedMotion=String(reduced);const origin=performance.now(),v=new T.Vector3();function render(now){if(dead)return;raf=requestAnimationFrame(render);const t=reduced?.35:(now-origin)/1000;for(const{actor,player}of models)actor.pose(player.rank===1?'celebrate':'idle',t,t);for(const{cup,actor}of cups){if(actor.root.userData.renderer==='atlas'){cup.visible=false;root.dataset.trophyAttached='true';root.dataset.trophySource='illustrated character pose';continue;}const hand=actor.getBone('hand.R');if(hand){hand.getWorldPosition(v);cup.position.copy(v).add(new T.Vector3(0,.04,0));cup.rotation.y=.2;cup.visible=true;root.dataset.trophyAttached='true';}else cup.visible=false;}for(const{p,phase}of confetti){p.position.y=3.7-((t*.24+phase)%2.9);p.position.x=Math.sin(t*.4+phase)*2.2;p.rotation.set(t+phase,t*.7,phase+t*.3);}root.dataset.characterRenderer='illustrated-atlas';root.dataset.modelsReady=String(models.filter(m=>m.actor.root.userData.loaded).length);root.dataset.ranks=ordered.map(p=>`${p.id}:${p.rank??'out'}:${p.character}`).join(',');renderer.render(scene,camera);}
  const resize=()=>{const b=root.getBoundingClientRect();renderer.setSize(Math.max(1,b.width),Math.max(1,b.height),false);camera.aspect=b.width/Math.max(1,b.height);camera.updateProjectionMatrix();};observer=new ResizeObserver(resize);observer.observe(root);resize();raf=requestAnimationFrame(render);
  return()=>{dead=true;cancelAnimationFrame(raf);observer.disconnect();models.forEach(m=>m.actor.dispose());disposables.forEach(d=>d.dispose());env.dispose();renderer.dispose();renderer.domElement.remove();};
 },[signature,meId]);
 return <div className={`run-podium ${className}`} data-testid="run-podium" ref={mount} style={{position:'relative',width:'100%',height:'100%',minHeight:270}} aria-label={$t("实际比赛名次的动物领奖台")}>{error&&<small role="status" style={{position:'absolute',bottom:8,left:12,color:'#ffe5ac',fontSize:10}}>{error}</small>}</div>;
}
