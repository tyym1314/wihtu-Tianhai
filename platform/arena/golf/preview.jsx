/** Development-only scene fixture. No App wallet, no financial actions. */
import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import GolfGame from './GolfGame.jsx';
import {createState,tick,act,view,botAction} from './engine.mjs';
import {getLevel} from './levels.mjs';
const players=[{key:'you',name:'YOU',seatIndex:0},{key:'noor',name:'NOOR',seatIndex:1,isBot:true},{key:'sami',name:'SAMI',seatIndex:2,isBot:true},{key:'lina',name:'LINA',seatIndex:3,isBot:true}];
const params=new URLSearchParams(location.search),selectedHole=Math.max(0,Math.min(2,Number(params.get('hole'))||0));
function initial(){const s=createState('ab'.repeat(32),Date.now(),{players,ruleVersion:'pvp-golf-v1.0.0'});s.holeIndex=selectedHole;for(const p of s.players){p.ball={...getLevel(selectedHole).tee};p.completedScores=Array(selectedHole).fill(3);}return s;}
function Fixture(){const state=useRef(initial()),[room,setRoom]=useState(null);const refresh=()=>{const s=state.current,now=Date.now();setRoom({id:'local-scene-fixture',status:s.status==='finished'?'settled':'active',practice:true,me:'you',players:players.map(p=>({external_user_id:p.key,name:p.name,seat_index:p.seatIndex,bot:!!p.isBot})),prize_minor:'0',server_now:now,game:view(s,'you')});};
 useEffect(()=>{refresh();const timer=setInterval(()=>{const now=Date.now();tick(state.current,now);for(const p of state.current.players){if(p.isBot&&now-p.shotStartedAt>1500+p.seatIndex*500){const action=botAction(state.current,p.key,now);if(action)act(state.current,p.key,action,now);}}refresh();},200);return()=>clearInterval(timer);},[]);
 return room?<GolfGame room={room} me="you" locale={params.get('lang')||'en'} onExit={()=>location.reload()} audio={{enabled:false,setEnabled(){},play(){}}} onAction={async action=>{const result=act(state.current,'you',action,Date.now());refresh();return{room,event:result.event};}}/>:null;
}createRoot(document.getElementById('root')).render(<Fixture/>);
