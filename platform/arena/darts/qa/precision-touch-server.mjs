/** Isolated real HTTP engines and current UIs; never connects to platform rooms. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,extname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import * as darts from '../engine.mjs';
import * as carrom from '../../carrom/engine.mjs';
import * as pool from '../../pool/engine.mjs';

export async function precisionTouchServer(){
 const root=fileURLToPath(new URL('../../../',import.meta.url)),engines={darts,carrom,pool},players=[{key:'p0',name:'You',seatIndex:0},{key:'p1',name:'Bot',seatIndex:1,isBot:true}];
 const states={},actions=[],generation={};
 function reset(game,mode='normal'){
  const state=engines[game].createState('12'.repeat(32),Date.now(),{players});state.turnKey='p0';generation[game]=(generation[game]||0)+1;
  if(game==='pool'&&mode==='free'){state.breakPending=false;state.ballInHand=true;state.cuePlaced=false;}
  if(game==='pool'&&mode==='eight'){state.breakPending=false;state.players[0].group='solids';state.players[1].group='stripes';for(const b of state.balls)if(b.n>=1&&b.n<=7)b.pocketed=true;}
  states[game]=state;
 }
 for(const game of Object.keys(engines))reset(game);
 const snapshot=game=>{const now=Date.now();engines[game].tick(states[game],now);return{id:game+'-touch-'+generation[game],game_id:game,status:'active',practice:true,server_now:now,players,game:engines[game].view(states[game],'p0')};};
 const source=`import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';import Darts from './arena/darts/DartsGame.jsx';import Carrom from './arena/carrom/CarromGame.jsx';import Pool from './arena/pool/PoolGame.jsx';const game=new URL(location.href).searchParams.get('game')||'darts',Game={darts:Darts,carrom:Carrom,pool:Pool}[game],audio={enabled:false,play(){},unlock(){}};function App(){const[room,setRoom]=useState(null);useEffect(()=>{let alive=true;const pull=async()=>{const room=await fetch('/room?game='+game).then(r=>r.json());if(alive)setRoom(room);};pull();const timer=setInterval(pull,100);return()=>{alive=false;clearInterval(timer);};},[]);return room?<Game key={room.id} room={room} me="p0" audio={audio} onExit={()=>{}} onAction={async action=>{const r=await fetch('/action?game='+game,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action)}),data=await r.json();if(!r.ok)throw Error(data.error);setRoom(data.room);return data;}}/>:null;}createRoot(document.querySelector('#root')).render(<App/>);`;
 const plugin={name:'static-assets-and-observe-carrom-aim',setup(b){b.onLoad({filter:/\.[cm]?[jt]sx?$/},async args=>{
  if(!args.path.startsWith(resolve(root,'arena')+'/'))return;
  let contents=await readFile(args.path,'utf8');const imports=[];
  contents=contents.replace(/new URL\(\s*(['"])(\.{1,2}\/[^'"]+\.(?:png|webp|jpe?g|svg))\1\s*,\s*import\.meta\.url\s*\)\.href/g,(_,quote,path)=>{const name='__asset'+imports.length;imports.push(`import ${name} from ${JSON.stringify(path)};`);return name;});
  if(args.path.endsWith('/carrom/board.mjs'))contents=contents.replace('export function createCarromBoard(canvas,{get,onGesture,onSound}){','export function createCarromBoard(canvas,{get,onGesture,onSound}){const original=onGesture;onGesture=v=>{(window.__aimUpdates??=[]).push(v);original(v);};');
  return{contents:imports.join('\n')+'\n'+contents,loader:args.path.endsWith('x')?'jsx':'js',resolveDir:dirname(args.path)};
 });}};
 const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:'precision-touch.jsx',loader:'jsx'},bundle:true,write:false,outdir:'/virtual-precision-touch',entryNames:'review',assetNames:'[name]-[hash]',format:'esm',jsx:'automatic',plugins:[plugin],loader:{'.png':'file','.webp':'file','.jpg':'file','.jpeg':'file','.svg':'file'},external:['/arena/assets/*'],logLevel:'silent'});
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
