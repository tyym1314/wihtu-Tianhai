import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Game from '../TowerLinkGame.jsx';
import {preloadTowerAssets} from '../tower-assets.mjs';
import '../../shell.css';
void preloadTowerAssets().catch(()=>{});
const params=new URLSearchParams(location.search),audio={enabled:false,play(){},unlock(){},silence(){},subscribe(){return()=>{};}};
let data=await fetch('/__tower-ui-state?'+params).then(r=>r.json());
function App(){const[room,setRoom]=useState(data.room);
 const refresh=async(action)=>{const res=action?await fetch('/__tower-ui-state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:room.id,action})}):await fetch('/__tower-ui-state?id='+room.id);const next=await res.json();if(!res.ok)throw Object.assign(new Error(next.error),{code:next.error});data=next;setRoom(next.room);};
 useEffect(()=>{const id=setInterval(()=>refresh().catch(console.error),500);return()=>clearInterval(id);},[room.id]);
 window.towerReview={room:()=>room,actions:()=>data.actions};
 return <Game room={room} me="p0" onAction={refresh} audio={audio} onExit={()=>{}} locale="zh"/>;
}
createRoot(document.getElementById('root')).render(<App/>);
