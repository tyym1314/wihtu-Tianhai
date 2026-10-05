/** Isolated real HTTP engines and current UIs; never connects to platform rooms. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,extname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import * as ludo from '../engine.mjs';
import * as jackaroo from '../../jackaroo/engine.mjs';
import * as domino from '../../domino/engine.mjs';

export async function mobileBoardServer(){
 const root=fileURLToPath(new URL('../../../',import.meta.url)),engines={ludo,jackaroo,domino},players=Array.from({length:4},(_,i)=>({key:'p'+i,name:i?'BOT '+i:'You',seatIndex:i,isBot:i>0,teamId:i%2?'team_b':'team_a'}));
 const states={},actions=[],generation={};
 function reset(game,mode='normal'){
  const state=engines[game].createState('12'.repeat(32),Date.now(),{players:game==='jackaroo'?players:players.slice(0,2)});generation[game]=(generation[game]||0)+1;
  if(game==='ludo'){state.turnKey='p0';state.pendingNext=null;state.dice=6;state.revealed=true;state.sixes=1;state.thirdSix=false;state.busyUntil=Date.now();state.lastEvent=null;}
  states[game]=state;
 }
 for(const game of Object.keys(engines))reset(game);
 const snapshot=game=>{const now=Date.now();engines[game].tick(states[game],now);return{id:game+'-touch-'+generation[game],game_id:game,status:'active',practice:true,capacity:states[game].players.length,server_now:now,players,game:engines[game].view(states[game],'p0')};};
 const source=`
import React,{useEffect,useState}from'react';
import{createRoot}from'react-dom/client';
import Ludo from './arena/ludo/LudoGame.jsx';
import Jackaroo from './arena/jackaroo/JackarooGame.jsx';
import Domino from './arena/domino/DominoGame.jsx';
const game=new URL(location.href).searchParams.get('game')||'ludo',Game={ludo:Ludo,jackaroo:Jackaroo,domino:Domino}[game],audio={enabled:false,play(){},unlock(){}};
function App(){
 const[room,setRoom]=useState(null);
 useEffect(()=>{
  let alive=true,timer;const controller=new AbortController(),pending=new Set();
  const pull=()=>{
   if(window.__boardPollPaused||!alive)return;
   const task=(async()=>{
    try{const room=await fetch('/room?game='+game,{signal:controller.signal}).then(r=>r.json());if(alive)setRoom(room);}
    catch(e){if(!(controller.signal.aborted&&e.name==='AbortError'))throw e;}
   })();
   pending.add(task);
   // Keep unexpected failures visible as page errors while settling the tracked
   // promise: navigation waits for all explicitly aborted requests to finish.
   task.then(()=>pending.delete(task),error=>{pending.delete(task);queueMicrotask(()=>{throw error;});});
  };
  const stop=()=>{alive=false;controller.abort();clearInterval(timer);};
  const stopAndDrain=async()=>{const pendingAtStop=pending.size;stop();await Promise.allSettled([...pending]);return{game,pendingAtStop,pendingAfterDrain:pending.size,stopped:!alive,aborted:controller.signal.aborted};};
  window.__boardFixtureStopAndDrain=stopAndDrain;
  pull();timer=setInterval(pull,100);window.addEventListener('pagehide',stop);
  return()=>{stop();window.removeEventListener('pagehide',stop);if(window.__boardFixtureStopAndDrain===stopAndDrain)delete window.__boardFixtureStopAndDrain;};
 },[]);
 return room?<Game key={room.id} room={room} me="p0" locale="zh" audio={audio} onExit={()=>{}} onAction={async action=>{const r=await fetch('/action?game='+game,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action)}),data=await r.json();if(!r.ok)throw Error(data.error);setRoom(data.room);return data;}}/>:null;
}
createRoot(document.querySelector('#root')).render(<App/>);`;

 const plugin={name:'static-assets',setup(b){b.onLoad({filter:/\.[cm]?[jt]sx?$/},async args=>{
  if(!args.path.startsWith(resolve(root,'arena')+'/'))return;
  let contents=await readFile(args.path,'utf8');const imports=[];
  contents=contents.replace(/new URL\(\s*(['"])(\.{1,2}\/[^'"]+\.(?:png|webp|jpe?g|svg))\1\s*,\s*import\.meta\.url\s*\)\.href/g,(_,quote,path)=>{const name='__asset'+imports.length;imports.push(`import ${name} from ${JSON.stringify(path)};`);return name;});
  if(args.path.endsWith('/jackaroo/JackarooGame.jsx')){contents=contents.replace(/const effectKey=a=>([^;]+);/,(_,expression)=>'const effectKey=a=>{window.__jackDeriveVisits=(window.__jackDeriveVisits||0)+1;return '+expression+';};').replace('const Board=memo(function Board({players,selectable,selectedPiece,onSelect,preview,effect,visual,locale}){','const Board=memo(function Board({players,selectable,selectedPiece,onSelect,preview,effect,visual,locale}){window.__jackBoardRenders=(window.__jackBoardRenders||0)+1;');}
  return{contents:imports.join('\n')+'\n'+contents,loader:args.path.endsWith('x')?'jsx':'js',resolveDir:dirname(args.path)};
 });}};
 const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:'mobile-board.jsx',loader:'jsx'},bundle:true,write:false,outdir:'/virtual-mobile-board',entryNames:'review',assetNames:'[name]-[hash]',format:'esm',jsx:'automatic',plugins:[plugin],loader:{'.png':'file','.webp':'file','.jpg':'file','.jpeg':'file','.svg':'file'},external:['/arena/assets/*'],logLevel:'silent'});
 const files=new Map(bundle.outputFiles.map(f=>['/'+basename(f.path),f.contents]));
 const mime={'.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
 const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://local'),path=url.pathname,game=url.searchParams.get('game');
  if(path==='/room'){res.setHeader('content-type','application/json');res.end(JSON.stringify(snapshot(game)));return;}
  if(path==='/action'){let body='';for await(const chunk of req)body+=chunk;const action=JSON.parse(body),entry={game,action};actions.push(entry);const result=engines[game].act(states[game],'p0',action,Date.now());entry.event=result?.event;res.setHeader('content-type','application/json');res.end(JSON.stringify({room:snapshot(game),event:result?.event}));return;}
  if(files.has(path)){res.setHeader('content-type',mime[extname(path)]);res.end(files.get(path));return;}
  if(path.startsWith('/arena/assets/')){const file=resolve(root,'arena/public',path.slice('/arena/'.length));if(!file.startsWith(resolve(root,'arena/public/assets')+'/'))throw Error('Unknown asset');res.setHeader('content-type',mime[extname(path)]);res.end(await readFile(file));return;}
  if(path!=='/'){res.statusCode=404;res.end('Not found');return;}
  res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/review.css"><style>html,body{margin:0;background:#071824}#root{max-width:460px;margin:auto}button{touch-action:manipulation}</style><div id="root"></div><script type="module" src="/review.js"></script>');
 }catch(error){res.statusCode=error.status||500;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:error.message}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return{origin:'http://127.0.0.1:'+server.address().port,actions,reset,state:game=>states[game],configure(game,fn){fn(states[game]);},async close(){await new Promise(r=>server.close(r));}};
}
