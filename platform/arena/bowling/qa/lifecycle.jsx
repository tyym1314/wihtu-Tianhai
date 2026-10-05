import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import Bowling from '../BowlingGame.jsx';
import {preloadNeonArt} from '../art.mjs';
import * as engine from '../engine.mjs';
import {PMREMGenerator} from 'three';
import {EffectComposer} from 'three/examples/jsm/postprocessing/EffectComposer.js';
const originalPMREM=PMREMGenerator.prototype.fromScene,originalAdd=EffectComposer.prototype.addPass,originalObserve=ResizeObserver.prototype.observe;
PMREMGenerator.prototype.fromScene=function(...args){if(window.__laneFaults?.construct==='pmrem')throw Error('Injected PMREM failure');return originalPMREM.apply(this,args);};
EffectComposer.prototype.addPass=function(...args){if(window.__laneFaults?.construct==='composer')throw Error('Injected composer failure');return originalAdd.apply(this,args);};
ResizeObserver.prototype.observe=function(...args){if(window.__laneFaults?.construct==='resize')throw Error('Injected resize failure');return originalObserve.apply(this,args);};
const players=[0,1].map(i=>({key:'p'+i,seatIndex:i,name:'Player '+i,isBot:i>0}));
function room(){const state=engine.createState('12'.repeat(32),Date.now(),{players});return{id:'local-bowling-lifecycle',status:'active',practice:true,entry_minor:'0',prize_minor:'0',server_now:Date.now(),players:players.map(p=>({external_user_id:p.key,name:p.name,bot:p.isBot})),game:engine.view(state,'p0')};}
function Fixture(){const[visible,setVisible]=useState(true),[snapshot,setRoom]=useState(()=>room());window.bowlingLifecycle={hide:()=>setVisible(false),show:()=>{setRoom(room());setVisible(true);},sourceListeners:async()=>{const art=await preloadNeonArt(),objects=new Set([art.wall]);for(const root of[art.venue,art.pin,art.ball])root.traverse(o=>{if(o.geometry)objects.add(o.geometry);for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[]){objects.add(m);for(const v of Object.values(m))if(v?.isTexture)objects.add(v);}});return[...objects].reduce((n,o)=>n+Object.values(o._listeners||{}).reduce((sum,list)=>sum+list.length,0),0);}};return visible?<Bowling room={snapshot} me="p0" onExit={()=>setVisible(false)} onAction={async()=>{throw Error('Lifecycle fixture never submits actions');}} locale="zh"/>:<p data-testid="unmounted">Exited</p>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
