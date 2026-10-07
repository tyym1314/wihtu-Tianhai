/** Match-only local browser profile. This is a diagnostic, not release acceptance. */
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {createState,act,view,rank,legalMoves} from '../arena/match/engine.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const label=process.argv[2];
if(!/^(before|after)$/.test(label||''))throw Error('Usage: node tests/match-frame-profile.mjs before|after');
const out=path.join(root,'arena/match/qa/frame-20261007');
const players=[{key:'you',name:'LINA',seatIndex:0},{key:'omar',name:'OMAR',seatIndex:1,isBot:true},{key:'noor',name:'NOOR',seatIndex:2,isBot:true},{key:'zain',name:'ZAIN',seatIndex:3,isBot:true}];
let state=createState('12'.repeat(32),Date.now(),{players});
const snapshot=()=>({id:'match-frame-local',game_id:'match',status:'ACTIVE',practice:true,players:rank(state).map(p=>({external_user_id:p.playerKey,name:state.players[p.playerKey].name,seat_index:state.players[p.playerKey].seatIndex,score:p.score,rank:p.rank,connected:true,bot:state.players[p.playerKey].isBot})),me:'you',entry_minor:'0',prize_minor:'0',server_now:Date.now(),end_at:state.deadlineAt,game:view(state,'you')});
const source=`import React,{useState,useEffect,Profiler} from 'react';import{createRoot}from'react-dom/client';import MatchGame from './arena/match/MatchGame.jsx';function App(){const[room,setRoom]=useState(null);useEffect(()=>{const pull=()=>fetch('/room').then(r=>r.json()).then(setRoom);pull();const id=setInterval(pull,300);return()=>clearInterval(id)},[]);return room?<Profiler id="MatchGame" onRender={(_id,_phase,actualDuration)=>window.__matchProfile?.commits.push(actualDuration)}><MatchGame room={room} me="you" locale="en" audio={{enabled:false,play(){},setEnabled(){}}} onAction={async action=>{const r=await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action)});const data=await r.json();if(!r.ok)throw Error(data.error);setRoom(data.room);return data;}}/></Profiler>:null}createRoot(document.getElementById('root')).render(<App/>);`;
const built=await build({stdin:{contents:source,resolveDir:root,sourcefile:'match-frame-profile.jsx',loader:'jsx'},bundle:true,write:false,outdir:'/virtual-match',format:'esm',jsx:'automatic',external:['/arena/assets/*'],logLevel:'silent'});
const js=built.outputFiles.find(f=>f.path.endsWith('.js')).text,css=built.outputFiles.find(f=>f.path.endsWith('.css')).text;
const assetsRoot=path.join(root,'arena/public/assets');
const contentType=file=>file.endsWith('.webp')?'image/webp':file.endsWith('.png')?'image/png':'application/octet-stream';
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/room'){res.setHeader('content-type','application/json');res.end(JSON.stringify(snapshot()));return;}
  if(url.pathname==='/action'){let body='';for await(const chunk of req)body+=chunk;const result=act(state,'you',JSON.parse(body),Date.now());state=result.state;res.setHeader('content-type','application/json');res.end(JSON.stringify({room:snapshot(),event:result.event}));return;}
  if(url.pathname.startsWith('/arena/assets/')){const file=path.resolve(assetsRoot,'.'+url.pathname.slice('/arena/assets'.length));if(!file.startsWith(assetsRoot+path.sep)){res.statusCode=400;res.end();return;}res.setHeader('content-type',contentType(file));res.end(await fs.readFile(file));return;}
  if(url.pathname==='/review.js'){res.setHeader('content-type','text/javascript');res.end(js);return;}
  if(url.pathname==='/review.css'){res.setHeader('content-type','text/css');res.end(css);return;}
  res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/review.css"><style>html,body{margin:0;background:#090913}#root{max-width:460px;margin:auto}</style></head><body><div id="root"></div><script type="module" src="/review.js"></script></body></html>');
 }catch(error){res.statusCode=500;res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
 const page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',response=>{if(response.url().startsWith(origin)&&response.status()>=400)errors.push(`${response.status()} ${response.url()}`);});
 await page.addInitScript(()=>{
  const probe={frames:[],commits:[],longTasks:[],active:false,previous:null};window.__matchProfile=probe;
  try{new PerformanceObserver(list=>{if(probe.active)for(const item of list.getEntries())probe.longTasks.push({start:item.startTime,duration:item.duration});}).observe({type:'longtask',buffered:false});}catch{}
  window.__startMatchProfile=()=>{probe.active=true;probe.previous=null;const tick=timestamp=>{if(!probe.active)return;if(probe.previous!==null)probe.frames.push(timestamp-probe.previous);probe.previous=timestamp;requestAnimationFrame(tick);};requestAnimationFrame(tick);};
  window.__stopMatchProfile=()=>{probe.active=false;return{frames:probe.frames,commits:probe.commits,longTasks:probe.longTasks};};
 });
 await page.goto(origin);await page.locator('.match-piece').nth(35).waitFor();
 await page.evaluate(()=>Promise.all([document.fonts.ready,...[...document.images].map(image=>image.decode().catch(()=>{}))]));
 await page.waitForFunction(()=>document.querySelector('.match-board')?.classList.contains('match-phase-idle')&&!document.querySelector('[data-cell="0"]').disabled);
 const started=Date.now();await page.evaluate(()=>{window.__matchProfile.commits=[];window.__startMatchProfile();});
 const actions=[];
 for(let n=0;n<47;n++){
  await page.waitForFunction(()=>document.querySelector('.match-board')?.classList.contains('match-phase-idle')&&!document.querySelector('[data-cell="0"]').disabled);
  const move=legalMoves(state.players.you.board)[0];assert.ok(move,`no legal move at ${n}`);
  const responsePromise=page.waitForResponse(response=>response.url()===origin+'/action');
  await page.locator(`[data-cell="${move.from}"]`).click();await page.locator(`[data-cell="${move.to}"]`).click();
  const response=await responsePromise;assert.equal(response.status(),200);
  const data=await response.json();assert.equal(data.event.valid,true);
  actions.push({from:move.from,to:move.to,atMs:Date.now()-started,waves:data.event.waves?.length||0});
  await page.waitForTimeout(100);
 }
 const rest=Math.max(0,65000-(Date.now()-started));if(rest)await page.waitForTimeout(rest);
 const probe=await page.evaluate(()=>window.__stopMatchProfile());
 const sorted=[...probe.frames].sort((a,b)=>a-b),percentile=p=>sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)];
 const summary={label,at:new Date().toISOString(),environment:{browser:browser.version(),viewport:{width:390,height:844},dpr:2,network:'loopback',cpuThrottling:1,visible:true,reactProfiler:true},scope:'65s local isolated Match UI with authoritative engine, 47 real clicks; diagnostic only',activeMs:Date.now()-started,actions:actions.length,frames:{count:sorted.length,p95:percentile(.95),p99:percentile(.99),max:sorted.at(-1),over50:sorted.filter(v=>v>50).length,over100:sorted.filter(v=>v>=100).length},commits:{count:probe.commits.length,totalActualDurationMs:probe.commits.reduce((a,b)=>a+b,0),maxActualDurationMs:Math.max(...probe.commits)},longTasks:probe.longTasks,errors};
 assert.deepEqual(errors,[]);
 await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,`${label}.json`),JSON.stringify({summary,actions,frames:probe.frames,commits:probe.commits},null,2)+'\n');
 console.log(JSON.stringify(summary,null,2));
 await context.close();
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
