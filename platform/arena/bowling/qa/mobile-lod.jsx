/** Isolated visual comparison fixture. No wallet, public API or platform route. */
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Bowling from '../BowlingGame.jsx';
import * as engine from '../engine.mjs';
const players=[{key:'p0',seatIndex:0,name:'Player'},{key:'p1',seatIndex:1,name:'Opponent'}];
let state=engine.createState('12'.repeat(32),Date.now(),{players}),actions=[];
function snapshot(){return{id:'visual-zero-money',status:'active',practice:true,entry_minor:'0',prize_minor:'0',server_now:Date.now(),players:players.map(p=>({external_user_id:p.key,name:p.name})),game:engine.view(state,'p0')};}
function Fixture(){
 const [visible,setVisible]=useState(true),[room,setRoom]=useState(snapshot);
 useEffect(()=>{const timer=setInterval(()=>{engine.tick(state,Date.now());setRoom(snapshot());},100);return()=>clearInterval(timer);},[]);
 async function act(action){const result=engine.act(state,'p0',action,Date.now());actions.push(action);setRoom(snapshot());return{room:snapshot(),event:result.event};}
 window.bowlingVisual={actions,room:snapshot,hide:()=>setVisible(false),show:()=>{state=engine.createState('12'.repeat(32),Date.now(),{players});setRoom(snapshot());setVisible(true);}};
 return visible?<Bowling room={room} me="p0" onAction={act} onExit={()=>setVisible(false)} locale="en"/>:<p data-testid="unmounted">Exited</p>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
