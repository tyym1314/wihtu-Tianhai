/** Short desktop-browser resource lifecycle check with the current real HTTP
 * engine and trusted touch. This is not a phone or sustained-frame benchmark.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {createState,act,view,rank,legalMoves} from '../arena/match/engine.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),out=resolve(process.env.OASIS_MATCH_ART_OUT||resolve(root,'review/ui-optimization-'+new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8),'match-art'));
await mkdir(out,{recursive:true});
const players=[{key:'you',name:'You',seatIndex:0},{key:'bot',name:'Bot',seatIndex:1,isBot:true}];let state,attempts=0;
const reset=()=>{state=createState('12'.repeat(32),Date.now(),{players});attempts=0;};reset();
const snapshot=()=>({id:'match-art-test',game_id:'match',status:'ACTIVE',practice:true,players:rank(state).map(p=>({external_user_id:p.playerKey,name:state.players[p.playerKey].name,seat_index:state.players[p.playerKey].seatIndex,score:p.score,rank:p.rank,connected:true})),server_now:Date.now(),game:view(state,'you')});
const source=`import React,{useState,useEffect}from'react';import{createRoot}from'react-dom/client';import MatchGame from './arena/match/MatchGame.jsx';import{preloadMatchAssets}from './arena/match/assets.mjs';const audio={enabled:false,play(){}};function App(){const[room,setRoom]=useState(null);useEffect(()=>{let alive=true;Promise.all([preloadMatchAssets(),fetch('/room').then(r=>r.json())]).then(([,room])=>{if(alive)setRoom(room);});return()=>{alive=false;};},[]);return room?<MatchGame room={room} me="you" locale="zh" audio={audio} onAction={async action=>{const response=await fetch('/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action)}),data=await response.json();if(!response.ok)throw Error(data.error);setRoom(data.room);return data;}}/>:null;}createRoot(document.getElementById('root')).render(<App/>);`;
const bundled=await build({stdin:{contents:source,resolveDir:root,sourcefile:'match-art-test.jsx',loader:'jsx'},bundle:true,write:false,outdir:'/virtual-match-art',format:'esm',jsx:'automatic',metafile:true,external:['/arena/assets/*'],logLevel:'silent'});
const js=bundled.outputFiles.find(f=>f.path.endsWith('.js')).contents,css=bundled.outputFiles.find(f=>f.path.endsWith('.css')).contents;
const assets=resolve(root,'arena/public/assets'),cheerPath='/arena/assets/restoration/fox-cheer-v3.webp',cheerBody=await readFile(resolve(assets,'restoration/fox-cheer-v3.webp'));
const boundSources=Object.keys(bundled.metafile.inputs).filter(p=>!p.endsWith('match-art-test.jsx')&&!p.includes('node_modules')).map(p=>resolve(p));
boundSources.push(resolve(root,'arena/match/engine.mjs'),resolve(root,'arena/match/engine-v1.mjs'),resolve(root,'arena/match/objectives.mjs'),fileURLToPath(import.meta.url));
async function hashes(){return Object.fromEntries(await Promise.all([...new Set(boundSources)].map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));}
const before=await hashes(),server=createServer(async(req,res)=>{try{
 const path=new URL(req.url,'http://local').pathname;
 if(path==='/room'){res.setHeader('content-type','application/json');res.end(JSON.stringify(snapshot()));return;}
 if(path==='/action'){attempts++;let body='';for await(const chunk of req)body+=chunk;const result=act(state,'you',JSON.parse(body),Date.now());state=result.state;res.setHeader('content-type','application/json');res.end(JSON.stringify({room:snapshot(),event:result.event}));return;}
 if(path.startsWith('/arena/assets/')){const file=resolve(assets,'.'+path.slice('/arena/assets'.length));assert(file.startsWith(assets+'/'));res.setHeader('content-type',extname(file)==='.webp'?'image/webp':'image/png');res.end(await readFile(file));return;}
 if(path==='/review.js'||path==='/review.css'){res.setHeader('content-type',path.endsWith('.js')?'text/javascript':'text/css');res.end(path.endsWith('.js')?js:css);return;}
 if(path!=='/'){res.statusCode=404;res.end();return;}
 res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/review.css"><style>html,body{margin:0;background:#090913}#root{max-width:460px;margin:auto}</style><div id="root"></div><script type="module" src="/review.js"></script>');
}catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port,report={scope:'Current Match UI, real isolated HTTP engine, desktop Chrome 390x844 trusted native touch; optional image is deliberately held or failed. Not physical-device/performance acceptance.',cases:[],errors:[],cleanup:{},sourceBefore:before};let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-proxy-server']});
 for(const mode of['held','failed']){
  reset();const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:2}),page=await context.newPage(),cdp=await context.newCDPSession(page);let held,requests=0,failed=false;
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.addInitScript(()=>{window.__trustedMatch=[];addEventListener('pointerup',event=>window.__trustedMatch.push({trusted:event.isTrusted,pointer:event.pointerType}),true);});
  await page.route('**/fox-cheer-v3.webp',async route=>{requests++;if(mode==='held'&&requests===1||mode==='failed'&&requests===2){held=route;return;}if(mode==='failed'&&requests===1){failed=true;await route.abort('failed');return;}await route.fulfill({status:200,contentType:'image/webp',body:cheerBody});});
  await page.goto(origin,{waitUntil:'domcontentloaded'});await page.locator('.match-piece').nth(35).waitFor();await page.waitForFunction(()=>!document.querySelector('[data-cell="0"]').disabled);
  const wait=async fn=>{const end=Date.now()+4000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('optional request did not start');};await wait(()=>mode==='held'?held:failed);
  async function swap(){
   await page.waitForFunction(()=>document.querySelector('.match-board')?.classList.contains('match-phase-idle')&&!document.querySelector('[data-cell="0"]').disabled);
   const move=legalMoves(state.players.you.board)[0],first=page.locator('[data-cell="'+move.from+'"]'),last=page.locator('[data-cell="'+move.to+'"]');await first.scrollIntoViewIfNeeded();const a=await first.boundingBox(),b=await last.boundingBox();
   const response=page.waitForResponse(r=>r.url()===origin+'/action');await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:a.x+a.width/2,y:a.y+a.height/2,id:1}]});
   for(let i=1;i<=5;i++){await page.waitForTimeout(20);await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:a.x+a.width/2+(b.x-a.x)*i/5,y:a.y+a.height/2+(b.y-a.y)*i/5,id:1}]});}
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});const accepted=await(await response).json();assert.equal(accepted.event.valid,true);return accepted;
  }
  const count=attempts;await swap();assert.equal(attempts,count+1);await page.waitForFunction(()=>document.querySelector('.match-combo-pop'));
  assert.equal(await page.locator('.match-fox-actor').getAttribute('data-pose'),'idle','unprepared first cheer keeps the decoded idle mascot');
  assert.match(await page.locator('.match-fox-actor').evaluate(el=>getComputedStyle(el).backgroundImage),/fox-idle-v3/);
  await page.screenshot({path:resolve(out,mode+'-first-idle.png')});
  if(held){await held.fulfill({status:200,contentType:'image/webp',body:cheerBody});held=null;}
  await page.waitForTimeout(200);await swap();assert.equal(attempts,count+2);await page.waitForFunction(()=>document.querySelector('.match-fox-actor')?.dataset.pose==='cheer');
  assert.match(await page.locator('.match-fox-actor').evaluate(el=>getComputedStyle(el).backgroundImage),/fox-cheer-v3/);
  assert((await page.evaluate(()=>window.__trustedMatch)).some(e=>e.trusted&&e.pointer==='touch'));
  await page.screenshot({path:resolve(out,mode+'-ready-cheer.png')});report.cases.push({mode,acceptedSwaps:2,optionalRequests:requests,firstActionIdleFallback:true,laterCheerDecoded:true,trustedTouch:true});await context.close();
 }
 assert.deepEqual(report.errors,[]);report.sourceAfter=await hashes();assert.deepEqual(report.sourceAfter,before,'declared component sources remained frozen');report.passed=true;
}catch(error){report.failure=error.stack;report.passed=false;process.exitCode=1;}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));report.cleanup={browserClosed:true,serverClosed:true};await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,cases:report.cases,failure:report.failure,out}));}
