// Local, zero-value QA harness. This file is not imported by the platform entry.
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import CarromGame from './CarromGame.jsx';
import {createState,act,tick,view,botAction} from './engine.mjs';
const params=new URLSearchParams(location.search),count=params.get('players')==='4'?4:2,seat=Number(params.get('seat')||0),me=`p${seat}`,players=Array.from({length:count},(_,i)=>({key:`p${i}`,seatIndex:i,teamId:i%2?'team_b':'team_a',name:['Maya','Rashid','Lina','Omar'][i],isBot:i!==seat}));
let state=createState('12'.repeat(32),Date.now(),{players}),lastBotTurn=0;
const sounds=[];const audio={enabled:true,toggle(){this.enabled=!this.enabled;},play(kind,strength){sounds.push({kind,strength,at:Date.now()});}};
// Explicit zero-value visual fixture: an otherwise unchanged rack with one white
// coin on a clear corner-pocket line. The player must still aim and shoot; the
// real engine decides the collision, pocket, foul and retained score.
function pocketFixture(){state=createState('12'.repeat(32),Date.now(),{players});const coin=state.coins.find(c=>c.id==='w0');Object.assign(coin,{x:2.78+(4.27-2.78)*.86,y:3.36+(-4.27-3.36)*.86});lastBotTurn=Date.now();}
function snapshot(){return{id:'isolated-carrom-qa',game_id:'carrom',status:'active',capacity:count,practice:true,players:players.map(p=>({external_user_id:p.key,name:p.name,seat_index:p.seatIndex,bot:p.isBot,ready:true,connected:true})),me,entry_minor:0,pool_minor:0,prize_minor:0,server_now:Date.now(),game:view(state,me)};}
function Preview(){const[room,setRoom]=useState(snapshot());useEffect(()=>{const id=setInterval(()=>{const now=Date.now();tick(state,now);const turn=state.players.find(p=>p.key===state.turnKey);if(state.status==='active'&&state.phase==='aiming'&&turn.isBot&&now-lastBotTurn>900){const action=botAction(state,turn.key,now);if(action){act(state,turn.key,action,now);lastBotTurn=now;}}setRoom(snapshot());},150);return()=>clearInterval(id);},[]);async function onAction(action){const result=act(state,me,action,Date.now());const r=snapshot();setRoom(r);return{room:r,event:result.event};}window.carromQA={state:()=>structuredClone(state),sounds,view:()=>snapshot(),pocketFixture(){pocketFixture();setRoom(snapshot());},autoFinish(){for(let i=0;i<250&&state.status==='active';i++){const now=state.serverNow+1,action=botAction(state,state.turnKey,now);if(!action)break;act(state,state.turnKey,action,now);tick(state,state.busyUntil);}setRoom(snapshot());}};return<CarromGame room={room} me={me} onAction={onAction} audio={audio} locale={params.get('locale')||'zh'} onExit={()=>{document.title='EXIT PRESSED';}}/>;}
createRoot(document.getElementById('root')).render(<Preview/>);
