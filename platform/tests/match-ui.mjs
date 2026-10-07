/** Isolated UI/authoritative-engine integration review. No payments or mock scores. */
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createState, act, view, rank, legalMoves } from '../arena/match/engine.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=path.join(root,'arena/match/review');
let state=createState('12'.repeat(32),Date.now(),{players:[{key:'you',name:'LINA',seatIndex:0},{key:'omar',name:'OMAR',seatIndex:1,isBot:true},{key:'noor',name:'NOOR',seatIndex:2,isBot:true},{key:'zain',name:'ZAIN',seatIndex:3,isBot:true}]});
let acceptedActions=0,roomPollsDuringBusy=0;
const assetResponses=[];
const assetNames=['match-palace.png','match-palace-mobile-09ad602636.webp','restoration/player-portraits-v2-mobile-e193e8ea76.webp',...['fox-idle-v3','fox-cheer-v3'].flatMap(name=>['png','webp'].map(extension=>`restoration/${name}.${extension}`)),...['gems','fox-poses','player-portraits'].flatMap(name=>['png','webp'].map(extension=>`restoration/${name}-v2.${extension}`))];
const assets=new Map(assetNames.map(name=>[`/arena/assets/${name}`,{file:path.join(root,'arena/public/assets',name),mime:name.endsWith('.webp')?'image/webp':'image/png'}]));
const snapshot=()=>({id:'isolated-match-review',game_id:'match',status:'ACTIVE',practice:true,players:rank(state).map(p=>({external_user_id:p.playerKey,name:state.players[p.playerKey].name,seat_index:state.players[p.playerKey].seatIndex,score:p.score,rank:p.rank,connected:true,bot:state.players[p.playerKey].isBot})),me:'you',entry_minor:'0',prize_minor:'0',server_now:Date.now(),end_at:state.deadlineAt,game:view(state,'you')});
const source=`import React,{useState,useEffect} from 'react';import{createRoot}from'react-dom/client';import MatchGame from './arena/match/MatchGame.jsx';function App(){const[room,setRoom]=useState(null);useEffect(()=>{const pull=()=>fetch('/room').then(r=>r.json()).then(setRoom);pull();const id=setInterval(pull,300);return()=>clearInterval(id)},[]);return room?<MatchGame room={room} me="you" locale={new URLSearchParams(location.search).get('locale')||'en'} audio={{enabled:true,play(){},setEnabled(){}}} onAction={async action=>{const r=await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action)});const data=await r.json();if(!r.ok)throw new Error(data.error);setRoom(data.room);return data;}}/>:null}createRoot(document.getElementById('root')).render(<App/>);`;
const built=await build({stdin:{contents:source,resolveDir:root,sourcefile:'review.jsx',loader:'jsx'},bundle:true,write:false,outdir:'/virtual-match',format:'esm',jsx:'automatic',external:['/arena/assets/*'],logLevel:'silent'});
const js=built.outputFiles.find(f=>f.path.endsWith('.js')).text,css=built.outputFiles.find(f=>f.path.endsWith('.css')).text;
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/room'){if(Date.now()<state.players.you.busyUntil)roomPollsDuringBusy++;res.setHeader('content-type','application/json');res.end(JSON.stringify(snapshot()));return;}
  if(url.pathname==='/action'){let body='';for await(const c of req)body+=c;const result=act(state,'you',JSON.parse(body),Date.now());state=result.state;acceptedActions++;res.setHeader('content-type','application/json');res.end(JSON.stringify({room:snapshot(),event:result.event}));return;}
  if(url.pathname.startsWith('/arena/assets/')){const asset=assets.get(url.pathname);if(!asset){res.statusCode=404;res.end();return;}res.setHeader('content-type',asset.mime);res.end(await fs.readFile(asset.file));assetResponses.push({path:url.pathname,mime:asset.mime});return;}
  if(url.pathname==='/review.js'){res.setHeader('content-type','text/javascript');res.end(js);return;}
  if(url.pathname==='/review.css'){res.setHeader('content-type','text/css');res.end(css);return;}
  if(url.pathname!=='/'){res.statusCode=404;res.end();return;}
  res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/review.css"><style>html,body{margin:0;background:#090913}#root{max-width:460px;margin:auto}</style></head><body><div id="root"></div><script type="module" src="/review.js"></script></body></html>');
 }catch(e){res.statusCode=e.status||500;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:e.message}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const errors=[],failedResources=[];
const track=page=>{page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.url().startsWith(origin)&&r.status()>=400)failedResources.push({url:r.url(),status:r.status()});});};
async function waitIdle(page){await page.waitForFunction(()=>document.querySelector('.match-board')?.classList.contains('match-phase-idle'));await page.waitForFunction(()=>!document.querySelector('[data-cell="0"]').disabled);}
async function tap(page,move){const response=page.waitForResponse(r=>r.url()===origin+'/action');await page.locator(`[data-cell="${move.from}"]`).click();await page.locator(`[data-cell="${move.to}"]`).click();const r=await response;assert.equal(r.status(),200);return r.json();}
async function assertBoardAndScore(page){assert.equal(await page.locator('.match-piece').count(),36,'board did not refill');assert.equal(await page.locator('.match-pieces span.match-gem').count(),36,'gem atlas elements missing');assert.equal((await page.locator('.match-player-me .match-player-score').evaluate(el=>el.firstChild?.textContent||'')).replaceAll(',',''),String(state.players.you.score),'display score differs from server');}
try{
 await fs.mkdir(out,{recursive:true});
 const context=await browser.newContext({viewport:{width:390,height:844}}),p=await context.newPage();track(p);
 await p.goto(origin);await p.locator('.match-piece').nth(35).waitFor();await p.evaluate(()=>document.fonts.ready);
 assert.equal(await p.locator('.match-pieces span.match-gem').count(),36);
 assert.equal(await p.locator('.match-avatar .oasis-portrait').count(),4);
 assert.equal(await p.locator('.match-fox-actor').getAttribute('data-pose'),'idle');
 const firstTimer=await p.locator('.match-timer strong').textContent();
 await p.waitForFunction(previous=>document.querySelector('.match-timer strong')?.textContent!==previous,firstTimer,{timeout:2500});
 // Decode the assets actually referenced by CSS, rather than only checking an HTTP status.
 const decodedAssets=await p.evaluate(async()=>{
  const selectors=['.match-gem-surface','.match-fox-actor','.oasis-portrait'];
  return Promise.all(selectors.map(async selector=>{const image=getComputedStyle(document.querySelector(selector)).backgroundImage,match=image.match(/url\(["']?(.*?)["']?\)/);if(!match)throw Error('No atlas for '+selector);const picture=new Image();picture.src=match[1];await picture.decode();return{selector,url:new URL(picture.src).pathname,width:picture.naturalWidth,height:picture.naturalHeight};}));
 });
 assert.ok(decodedAssets.every(v=>v.width>0&&v.height>0));
 // Both delivered formats remain readable, and the HTTP MIME agrees with the file format.
 const deliveredAssets=[];for(const [url,asset] of assets){const r=await fetch(origin+url);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),asset.mime);assert.ok((await r.arrayBuffer()).byteLength>0);deliveredAssets.push({path:url,mime:asset.mime});}
 await p.screenshot({path:path.join(out,'match-390.png')});
 const action=legalMoves(state.players.you.board)[0],payload=await tap(p,action);assert.equal(payload.event.valid,true,'valid swap failed');
 await p.waitForFunction(()=>document.querySelector('.match-board').classList.contains('match-phase-clear'));
 assert.equal(await p.locator('.match-fox-actor').getAttribute('data-pose'),'cheer');
 await p.screenshot({path:path.join(out,'match-clearing-390.png')});await waitIdle(p);await assertBoardAndScore(p);
 // Swipe is a real pointer interaction using the next authoritative legal action.
 await p.waitForTimeout(200);const move=legalMoves(state.players.you.board)[0],a=await p.locator(`[data-cell="${move.from}"]`).boundingBox(),b=await p.locator(`[data-cell="${move.to}"]`).boundingBox();
 const dragResponse=p.waitForResponse(r=>r.url()===origin+'/action');await p.mouse.move(a.x+a.width/2,a.y+a.height/2);await p.mouse.down();await p.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:4});await p.mouse.up();const swipePayload=await(await dragResponse).json();assert.equal(swipePayload.event.valid,true);await waitIdle(p);await assertBoardAndScore(p);await p.screenshot({path:path.join(out,'match-played-390.png')});
 const legal=legalMoves(state.players.you.board);let invalid;for(let from=0;from<36&&!invalid;from++)for(const to of[from+1,from+6])if(to<36&&(to===from+6||Math.floor(from/6)===Math.floor(to/6))&&!legal.some(m=>m.from===from&&m.to===to)){invalid={from,to};break;}
 assert.ok(invalid,'fixture must exercise a non-matching adjacent pair');await p.waitForTimeout(200);const before=state.players.you.score,beforeBoard=structuredClone(state.players.you.board),rejected=await tap(p,invalid);assert.equal(rejected.event.valid,false);await p.getByText('No match. Try another pair!',{exact:true}).waitFor();await waitIdle(p);assert.equal(state.players.you.score,before,'invalid score');assert.deepEqual(state.players.you.board,beforeBoard,'invalid swap changed authoritative board');await assertBoardAndScore(p);
 assert.ok(roomPollsDuringBusy>0,'no actual polling occurred while a server animation was busy');
 for(const width of[360,390]){await p.setViewportSize({width,height:844});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow '+width);}
 await p.setViewportSize({width:412,height:866});
 assert.equal(await p.evaluate(()=>Math.max(document.documentElement.scrollHeight,document.body.scrollHeight)>innerHeight),false,'412×866 vertical overflow');
 assert.equal(await p.locator('.match-scene').count(),1);
 await p.waitForTimeout(250);
 await p.screenshot({path:path.join(out,'match-412x866.png')});
 await p.goto(origin+'/?locale=zh');await p.getByRole('button',{name:'玩法说明',exact:true}).click();await p.getByRole('dialog').waitFor();await p.getByRole('button',{name:'知道了',exact:true}).last().click();await p.goto(origin+'/?locale=ar');await p.locator('.match-piece').nth(35).waitFor();assert.equal(await p.locator('.match-scene').getAttribute('dir'),'rtl');
 // Reduced motion changes decoration only: the same engine still accepts, animates and scores a swap.
 const reducedContext=await browser.newContext({viewport:{width:360,height:844},reducedMotion:'reduce'}),reduced=await reducedContext.newPage();track(reduced);await reduced.goto(origin);await reduced.locator('.match-piece').nth(35).waitFor();await waitIdle(reduced);
 assert.equal(await reduced.locator('.match-fox-actor').evaluate(el=>getComputedStyle(el).animationName),'none');assert.equal(await reduced.locator('.match-master-gem .match-gem-orbit').evaluate(el=>getComputedStyle(el).animationName),'none');
 const reducedResult=await tap(reduced,legalMoves(state.players.you.board)[0]);assert.equal(reducedResult.event.valid,true);await reduced.waitForFunction(()=>document.querySelector('.match-board').classList.contains('match-phase-clear'));assert.equal(await reduced.locator('.match-hero-shards').evaluate(el=>getComputedStyle(el).display),'none');await waitIdle(reduced);await assertBoardAndScore(reduced);await reduced.screenshot({path:path.join(out,'match-reduced-motion-360.png')});
 assert.deepEqual(errors,[]);assert.deepEqual(failedResources,[]);
 const report={at:new Date().toISOString(),scope:'Desktop Chrome mobile viewports, independent HTTP authoritative engine, no wallet or platform service',engineBackedTap:true,engineBackedSwipe:true,bounceScoreZero:true,bouncePreservesBoard:true,pollingDuringAnimations:true,roomPollsDuringBusy,acceptedActions,boardCells:36,gemElement:'span.match-gem',foxActorPoses:['idle','cheer'],portraits:4,reducedMotion:{mascotAnimation:'none',orbitAnimation:'none',shardsDisplay:'none',authoritativeSwapAndScore:true},mobileWidths:[360,390],locales:['en','zh','ar'],decodedAssets,deliveredAssets,pageErrors:errors,failedResources};
 await fs.writeFile(path.join(out,'restoration-validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
