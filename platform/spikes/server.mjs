import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import { RaceEngine, TICK_RATE } from './engine.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const HOST='127.0.0.1', PORT=8796, ORIGIN=`http://${HOST}:${PORT}`;
let engine=new RaceEngine(),generation=1;
let events=[],acks={}, maxStepMs=0, totalTicks=0, activeConnections=0;
const append=(type,data={})=>{ events.push({type,at:new Date().toISOString(),...data}); if(events.length>400)events.shift(); };
function resultHash(s) { if(s.state!=='finished')return null; return createHash('sha256').update(JSON.stringify({matchId:s.matchId,winner:s.winner,finishers:s.finishers,players:s.players.map(p=>({id:p.id,z:p.z,hits:p.hits,finishTick:p.finishTick}))})).digest('hex'); }
function snapshot() { const s=engine.snapshot(); return {...s,resultHash:resultHash(s),serverTime:performance.now(),connections:activeConnections}; }
const send=(ws,data)=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(data));};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  if(req.headers.host!==`${HOST}:${PORT}`) { res.writeHead(403);res.end('Loopback host only');return; }
  if(req.headers.origin && req.headers.origin!==ORIGIN){res.writeHead(403);res.end('Origin forbidden');return;}
  const url=new URL(req.url,ORIGIN);
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(url.pathname==='/api/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(snapshot()));return;}
  if(url.pathname==='/api/evidence'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'LOCAL_TECHNICAL_GRAYBOX_ONLY',snapshot:snapshot(),acks,events,rejections:engine.rejections,stats:{maxStepMs,totalTicks,activeConnections},scope:'desktop loopback; no real coins, no mobile or cross-region performance claim'}));return;}
  if(url.pathname==='/api/reset-room' && req.method==='POST' && req.headers['x-graybox-test']==='local-only'){
    generation++;for(const ws of wss.clients)ws.close(4001,'QA reset room');engine=new RaceEngine();activeConnections=0;events=[];acks={};append('room-reset');res.writeHead(204);res.end();return;
  }
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  const files={'/':path.join(root,'index.html'),'/client.mjs':path.join(root,'client.mjs'),'/style.css':path.join(root,'style.css'),'/vendor/three.module.js':path.join(root,'../node_modules/three/build/three.module.js'),'/vendor/three.core.js':path.join(root,'../node_modules/three/build/three.core.js')};
  const target=files[url.pathname];if(!target){res.writeHead(404);res.end('Not found');return;}
  try{res.setHeader('Content-Type',mime[path.extname(target)]||'application/octet-stream');res.end(await fs.readFile(target));}catch{res.writeHead(500);res.end('Missing local dependency. Install platform dependencies first.');}
});
const wss=new WebSocketServer({server,maxPayload:2048,verifyClient:({origin,req})=>req.headers.host===`${HOST}:${PORT}`&&(!origin||origin===ORIGIN)});
wss.on('connection',ws=>{
  ws.generation=generation;ws.playerId=null;activeConnections++;
  const helloTimeout=setTimeout(()=>{if(!ws.playerId)ws.close(4000,'Hello required');},5000);
  ws.on('message',raw=>{
    if(ws.generation!==generation)return;
    let msg;try{msg=JSON.parse(raw.toString());}catch{send(ws,{type:'error',code:'INVALID_JSON'});return;}
    if(!msg || typeof msg!=='object' || Array.isArray(msg)){send(ws,{type:'error',code:'INVALID_MESSAGE'});return;}
    if(msg.type==='hello'){
      if(ws.playerId){send(ws,{type:'error',code:'ALREADY_JOINED'});return;}
      const result=engine.connect(msg.clientId,msg.resumeToken,msg.role,()=>randomBytes(24).toString('hex'));
      if(result.error){send(ws,{type:'error',code:result.error});return;}
      ws.playerId=result.player.id;clearTimeout(helloTimeout);
      append(result.resumed?'resumed':'joined',{playerId:ws.playerId,clientId:result.player.clientId,role:result.player.role,z:result.player.z,lastSeq:result.player.lastSeq});
      send(ws,{type:'welcome',playerId:ws.playerId,resumeToken:result.player.token,resumed:result.resumed,snapshot:snapshot()});return;
    }
    if(!ws.playerId){send(ws,{type:'error',code:'HELLO_REQUIRED'});return;}
    if(msg.type==='input'){const result=engine.input(ws.playerId,msg);send(ws,{type:'input-ack',...result,lastSeq:engine.players.find(p=>p.id===ws.playerId).lastSeq});return;}
    if(msg.type==='start' || msg.type==='reset'){
      if(ws.playerId!=='runner-0'){send(ws,{type:'error',code:'OWNER_ONLY'});return;}
      if(msg.type==='reset'){engine.reset();acks={};append('race-reset',{matchId:engine.matchId});}
      else if(!engine.start()){send(ws,{type:'error',code:'ROOM_NOT_READY'});return;}
      else append('started',{matchId:engine.matchId});
      broadcast();return;
    }
    if(msg.type==='ping'){send(ws,{type:'pong',id:msg.id});return;}
    if(msg.type==='result-ack'){
      const s=snapshot();if(msg.matchId===s.matchId&&msg.resultHash===s.resultHash&&s.state==='finished'){
        acks[ws.playerId]={playerId:ws.playerId,clientId:engine.players.find(p=>p.id===ws.playerId).clientId,winner:msg.winner,resultHash:msg.resultHash,matchId:msg.matchId,validWinner:msg.winner===s.winner};
      }return;
    }
    send(ws,{type:'error',code:'UNKNOWN_MESSAGE'});
  });
  ws.on('close',()=>{clearTimeout(helloTimeout);if(ws.generation!==generation)return;activeConnections--;if(ws.playerId){engine.disconnect(ws.playerId);append('disconnected',{playerId:ws.playerId});}});
});
function broadcast(){const data={type:'snapshot',snapshot:snapshot()};for(const ws of wss.clients)if(ws.playerId&&ws.generation===generation)send(ws,data);}
let last=performance.now(),acc=0,wasFinished=false;
const timer=setInterval(()=>{
  const now=performance.now();acc+=Math.min((now-last)/1000,.25);last=now;
  let steps=0;while(acc>=1/TICK_RATE&&steps<16){const begin=performance.now();engine.step();maxStepMs=Math.max(maxStepMs,performance.now()-begin);totalTicks++;acc-=1/TICK_RATE;steps++;}
  if(engine.state==='finished'&&!wasFinished){append('finished',{matchId:engine.matchId,winner:engine.winner,resultHash:resultHash(engine.snapshot())});wasFinished=true;}
  if(engine.state!=='finished')wasFinished=false;
},8);
const sync=setInterval(broadcast,50);
server.listen(PORT,HOST,()=>console.log(`Technical graybox only: ${ORIGIN} (60 Hz authority, 20 Hz snapshots, zero coin integration)`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);clearInterval(sync);wss.close();server.close(()=>process.exit(0));for(const ws of wss.clients)ws.terminate();});
