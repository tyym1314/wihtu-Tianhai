import React,{useState}from'react';
import{createRoot}from'react-dom/client';
import Golf from'../GolfGame.jsx';
import {preloadOasisArt} from '../art.mjs';
import * as engine from'../engine.mjs';
import{roundGolfHole}from'../content.mjs';
const players=[0,1].map(i=>({key:'p'+i,seatIndex:i,name:'Player '+i,isBot:i>0}));
function room(hole=0){const state=engine.createState('12'.repeat(32),Date.now(),{players});state.holeIndex=hole;for(const p of state.players){p.ball={...roundGolfHole(state,hole).tee};p.completedScores=Array(hole).fill(3);}return{id:'local-lifecycle',status:'active',practice:true,entry_minor:'0',prize_minor:'0',server_now:Date.now(),players:players.map(p=>({external_user_id:p.key,name:p.name,bot:p.isBot})),game:engine.view(state,'p0')};}
function Fixture(){const[visible,setVisible]=useState(true),[snapshot,setRoom]=useState(()=>room());window.golfLifecycle={hide:()=>setVisible(false),show:()=>{setRoom(room());setVisible(true);},hole:index=>setRoom(room(index)),sourceListeners:async()=>{const common=await preloadOasisArt(),parts=await Promise.all([0,1,2].map(artIndex=>preloadOasisArt({artIndex}))),objects=new Set([...parts.flatMap(part=>part.ao),common.grass,common.grassNormal,common.distant]);for(const root of[...parts.flatMap(part=>part.courses),common.botanicals])root.traverse(o=>{if(o.geometry)objects.add(o.geometry);for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[]){objects.add(m);for(const v of Object.values(m))if(v?.isTexture)objects.add(v);}});return[...objects].reduce((n,o)=>n+Object.values(o._listeners||{}).reduce((sum,list)=>sum+list.length,0),0);}};return visible?<Golf room={snapshot} me="p0" onExit={()=>setVisible(false)} onAction={async()=>{throw Error('Lifecycle fixture never submits actions');}} locale="zh"/>:<p data-testid="unmounted">Exited</p>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
