/** Actual isolated Match engine/HTTP fixture, no production or financial state. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import * as E from '../engine.mjs';

export async function matchTouchServer(){
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 const players=[{key:'p0',seatIndex:0,name:'You'},{key:'p1',seatIndex:1,name:'Bot',isBot:true}];
 let state=E.createState('12'.repeat(32),Date.now(),{players}),actions=[];
 const snapshot=()=>({id:'isolated-match-touch',game_id:'match',status:'active',practice:true,server_now:Date.now(),players:players.map(p=>({external_user_id:p.key,name:p.name,seat_index:p.seatIndex,bot:p.isBot,score:state.players[p.key].score})),game:E.view(state,'p0')});
 const source=`import React,{useState,useEffect} from 'react';import{createRoot}from'react-dom/client';import Game from './arena/match/MatchGame.jsx';const audio={enabled:false,play(){}};function App(){const[room,setRoom]=useState(null);useEffect(()=>{let alive=true;const pull=async()=>{const data=await fetch('/room').then(r=>r.json());if(alive)setRoom(data);};const safePull=()=>pull().catch(()=>{});safePull();const timer=setInterval(safePull,150);return()=>{alive=false;clearInterval(timer);};},[]);return room?<Game room={room} me="p0" locale="zh" audio={audio} onAction={async action=>{const response=await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action)});const result=await response.json();if(!response.ok)throw Error(result.error);setRoom(result.room);return result;}}/>:null;}createRoot(document.querySelector('#root')).render(<App/>);`;
 const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:'match-touch.jsx',loader:'jsx'},bundle:true,write:false,outdir:'/virtual-match-touch',format:'esm',jsx:'automatic',external:['/arena/assets/*'],logLevel:'silent'});
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
 const server=createServer(async(req,res)=>{try{
  const path=new URL(req.url,'http://local').pathname;
  if(path==='/room'){res.setHeader('content-type','application/json');res.end(JSON.stringify(snapshot()));return;}
  if(path==='/action'){let body='';for await(const part of req)body+=part;const action=JSON.parse(body),entry={action};actions.push(entry);const result=E.act(state,'p0',action,Date.now());entry.event=result.event;res.setHeader('content-type','application/json');res.end(JSON.stringify({room:snapshot(),event:result.event}));return;}
  if(path.startsWith('/arena/assets/')){const file=resolve(root,'arena/public',path.slice('/arena/'.length));if(!file.startsWith(resolve(root,'arena/public/assets')+'/'))throw Error('Unknown asset');res.setHeader('content-type',path.endsWith('.webp')?'image/webp':'image/png');res.end(await readFile(file));return;}
  if(path==='/review.js'||path==='/review.css'){res.setHeader('content-type',path.endsWith('.js')?'text/javascript':'text/css');res.end(path.endsWith('.js')?js:css);return;}
  res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/review.css"><style>html,body{margin:0}#root{max-width:460px;margin:auto}</style><div id="root"></div><script type="module" src="/review.js"></script>');
 }catch(error){res.statusCode=error.status||500;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:error.message}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return{origin:'http://127.0.0.1:'+server.address().port,state:()=>state,actions,legal:()=>E.legalMoves(state.players.p0.board),configure(fn){fn(state);},reset(seedHex='12'.repeat(32)){state=E.createState(seedHex,Date.now(),{players});actions.length=0;},async close(){await new Promise(r=>server.close(r));}};
}
