/** Isolated visual QA. Engine fixtures only; no API, credentials or wallet. Not a production entry. */
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Match from './match/MatchGame.jsx';
import ThemeResult from './shared/ThemeResult.jsx';
import useResultPresentation from './shared/useResultPresentation.jsx';
import {ArenaAudio} from './shared/audio.mjs';
import {ARENA_GAMES} from '../shared/games.mjs';
import './shell.css';
const params=new URLSearchParams(location.search),game=params.get('game')||'match',mode=params.get('mode')||'play',me='p0';
const components={match:Match,golf:(await import('./golf/GolfGame.jsx')).default,towerlink:(await import('./towerlink/TowerLinkGame.jsx')).default,carrom:(await import('./carrom/CarromGame.jsx')).default,darts:(await import('./darts/DartsGame.jsx')).default,ludo:(await import('./ludo/LudoGame.jsx')).default,jackaroo:(await import('./jackaroo/JackarooGame.jsx')).default,domino:(await import('./domino/DominoGame.jsx')).default,pool:(await import('./pool/PoolGame.jsx')).default,bowling:(await import('./bowling/BowlingGame.jsx')).default,run:(await import('./run/RunGame.jsx')).default};
const count=game==='towerlink'&&[2,3,4].includes(Number(params.get('players')))?Number(params.get('players')):(ARENA_GAMES[game].players.includes(4)?4:2);
const serverBacked=['match','ludo','jackaroo','towerlink'].includes(game),engines=import.meta.glob(['./*/engine.mjs','!./match/engine.mjs','!./ludo/engine.mjs','!./jackaroo/engine.mjs','!./towerlink/engine.mjs']),engine=serverBacked?null:await engines[`./${game}/engine.mjs`](),Game=components[game],meta=ARENA_GAMES[game];
let remote=null;
async function fixtureCall(op,extra={}){const response=await fetch('/__art-match',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op,id:remote?.id,game,...extra})}),next=await response.json();if(!response.ok)throw Error(next.error||'Art fixture failed');if(!remote||next.id!==remote.id||next.revision>=remote.revision)remote=next;return next;}
if(serverBacked)await fixtureCall('init',{players:count,...(game==='towerlink'&&/^[0-9a-f]{64}$/i.test(params.get('seed')||'')?{seed:params.get('seed')}:{})});
const players=Array.from({length:count},(_,i)=>({key:'p'+i,name:['Maya','Omar','Lina','Noor'][i],seatIndex:i,isBot:i>0,teamId:i%2?'team_b':'team_a'}));
let state=remote?.state||engine.createState('12'.repeat(32),Date.now(),{players}),lastEvent=null,forced=null,actionCount=0;
const audio=new ArenaAudio(game);audio.setEnabled(params.get('sound')==='1');
const sounds=[];const play=audio.play.bind(audio);audio.play=(kind,strength)=>{sounds.push({kind,strength});play(kind,strength);};
function snapshot(){const rank=remote?.rank||engine.rank(state);return{id:'isolated-art-fixture',game_id:game,status:forced||'active',practice:false,capacity:count,team_size:game==='jackaroo'||game==='carrom'?2:1,me,entry_minor:'10000',prize_minor:count===4?'38000':'19000',fee_bps:500,server_now:remote?.view?.serverNow||Date.now(),players:players.map((p,i)=>({external_user_id:p.key,name:p.name,seat_index:i,team_id:p.teamId,bot:p.isBot,ready:true,connected:true,score:rank.find(r=>r.playerKey===p.key)?.score||0,rank:forced?(['jackaroo','carrom'].includes(game)?(i%2?2:1):i+1):undefined,payout_minor:forced?(['jackaroo','carrom'].includes(game)?(i%2?'0':'19000'):i===0?(count===4?'38000':'19000'):'0'):'0'})),game:{...(remote?.view||engine.view(state,me)),...(game==='match'?{lastEvent}:{})},...(forced?{result:{fee_minor:count===4?'2000':'1000'}}:{})};}
if(mode==='result')forced='settled';
function Preview(){const[room,setRoom]=useState(snapshot),{presenting,presentationRoom}=useResultPresentation(room);
 const refresh=()=>setRoom(snapshot());
 useEffect(()=>{let stopped=false,busy=false;const timer=setInterval(async()=>{if(!forced&&!busy){busy=true;try{if(serverBacked){await fixtureCall('tick');state=remote.state;}else engine.tick(state,Date.now());if(!stopped)refresh();}catch(e){console.error(e);}finally{busy=false;}}},120);return()=>{stopped=true;clearInterval(timer);audio.dispose();};},[]);
 async function onAction(action){if(forced)throw Error('Presentation locked');actionCount++;const result=serverBacked?await fixtureCall('act',{action}):engine.act(state,me,action,Date.now());if(serverBacked)state=remote.state;lastEvent=result.event;const r=snapshot();setRoom(r);return{room:r,event:result.event};}
 window.artReview={state:()=>structuredClone(state),room:()=>structuredClone(room),sounds,actions:()=>actionCount,legal:()=>remote?.legal||(!serverBacked?engine.botAction(state,me,Date.now()):null),finish(){forced='settled';refresh();},async reset(){if(serverBacked){await fixtureCall('reset');state=remote.state;}else state=engine.createState('12'.repeat(32),Date.now(),{players});forced=null;lastEvent=null;refresh();},async move(){const a=remote?.legal||(!serverBacked?engine.botAction(state,me,Date.now()):null);if(!a)return null;return onAction(a);},async fixture(type){if(serverBacked){await fixtureCall('fixture',{type});state=remote.state;refresh();}},async setScore(value){if(game==='match'){await fixtureCall('score',{value});state=remote.state;refresh();}}};
 return <main className={`arena-app theme-${game}`}><div style={{position:'fixed',left:4,top:2,zIndex:100,fontSize:7,color:'#fff9',pointerEvents:'none'}}>ART PREVIEW · NO WALLET</div>{(!forced||presenting)?<Game room={presentationRoom} me={me} onAction={onAction} audio={audio} onExit={()=>location.reload()} locale={params.get('locale')||'en'}/>:<div className="arena-shell has-themed-result"><div style={{height:35}}/><ThemeResult game={game} room={room} meId={me} meta={meta} onAgain={()=>window.artReview.reset()}/></div>}</main>;
}
createRoot(document.getElementById('root')).render(<Preview/>);
