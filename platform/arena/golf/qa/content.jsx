import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Golf from '../GolfGame.jsx';
import * as engine from '../engine.mjs';
import {GOLF_HOLES,roundGolfHole,selectGolfHoles} from '../content.mjs';
const players=[{key:'p0',seatIndex:0,name:'Maya'},{key:'p1',seatIndex:1,name:'Omar',isBot:true}],seedFor=k=>Math.floor(k/2).toString(16).padStart(8,'0')+(k%2).toString(16).padStart(8,'0')+'00'.repeat(24);
const id=new URLSearchParams(location.search).get('hole')||GOLF_HOLES[0].id;
const seed=Array.from({length:6},(_,i)=>seedFor(i)).find(s=>selectGolfHoles(s).includes(id));if(!seed)throw Error('Unknown fixture hole');
let state=engine.createState(seed,Date.now(),{players}),accepted=[];
// Isolated visual starting fixture, never available in server state creation.
// Full no-position-edit playable proofs live in golf-content.test.mjs.
state.holeIndex=state.holeIds.indexOf(id);for(const p of state.players){p.ball={...roundGolfHole(state).tee};p.completedScores=Array(state.holeIndex).fill(3);}
const snapshot=()=>({id:'local-golf-content',status:'active',practice:true,entry_minor:'0',prize_minor:'0',server_now:Date.now(),players:players.map(p=>({external_user_id:p.key,name:p.name,bot:p.isBot})),game:engine.view(state,'p0')});
function App(){const[room,setRoom]=useState(snapshot);useEffect(()=>{const timer=setInterval(()=>{engine.tick(state,Date.now());setRoom(snapshot());},100);return()=>clearInterval(timer);},[]);
 window.golfContentReview={state:()=>structuredClone(state),accepted:()=>structuredClone(accepted)};
 async function onAction(action){const result=engine.act(state,'p0',action,Date.now());accepted.push({action,...result.event});setRoom(snapshot());return{room:snapshot(),event:result.event};}
 return <Golf room={room} me="p0" onAction={onAction} onExit={()=>location.reload()} locale="zh"/>;
}
createRoot(document.getElementById('root')).render(<App/>);
