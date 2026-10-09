// Isolated art review: fixed presentation time; never a performance/physics proof.
import * as THREE from 'three';
import {loadOasisArt} from '../art.mjs';
import {createGolfScene} from '../scene.mjs';
import * as engine from '../engine.mjs';
import {roundGolfHole} from '../content.mjs';
const query=new URLSearchParams(location.search),artIndex=Number(query.get('course')||0),closeup=query.get('view')==='closeup',epoch=1700000000000;
const players=[{key:'p0',seatIndex:0,name:'Maya'},{key:'p1',seatIndex:1,name:'Omar',isBot:true}],state=engine.createState('12'.repeat(32),epoch,{players});
state.holeIndex=[0,1,2].find(index=>roundGolfHole(state,index).artIndex===artIndex);const level=roundGolfHole(state);
for(const p of state.players){p.ball={...level.tee};p.completedScores=Array(state.holeIndex).fill(3);}
if(closeup){const p=state.players[0];p.ball={...level.cup};p.completed=true;p.lastEvent={type:'hole',at:epoch-900};}
const game=engine.view(state,'p0'),nativeRAF=window.requestAnimationFrame.bind(window),targetFrames=180;
window.golfLODReview={frame:0,finished:false,scope:'Static art fixture with fixed presentation time, authored camera and deterministic render timestamps; not frame performance or gameplay acceptance.'};
Object.defineProperty(performance,'now',{value:()=>0});
window.requestAnimationFrame=callback=>callback.name!=='animate'?nativeRAF(callback):nativeRAF(()=>{if(window.golfLODReview.frame>=targetFrames)return;const n=++window.golfLODReview.frame;callback(5000+n*1000/60);if(n===targetFrames)window.golfLODReview.finished=true;});
const nativeSceneHook=THREE.Scene.prototype.onBeforeRender;
THREE.Scene.prototype.onBeforeRender=function(renderer,scene,camera,...args){nativeSceneHook?.call(this,renderer,scene,camera,...args);if(camera.fov===41&&scene.children.some(o=>o.isWater))window.golfLODReview.camera={position:camera.position.toArray(),matrixWorld:camera.matrixWorld.toArray(),projection:camera.projectionMatrix.toArray()};};
const art=await loadOasisArt({artIndex}),container=document.getElementById('scene'),scene=createGolfScene(container,{art,initialGame:game,onError:error=>{window.golfLODReview.error=String(error);}});
scene.update(game,'p0',Math.atan2(level.cup.x-level.tee.x,level.tee.z-level.cup.z),.58,epoch);window.golfLODReview.dispose=()=>scene.dispose();window.golfLODReview.artIndex=artIndex;window.golfLODReview.closeup=closeup;
