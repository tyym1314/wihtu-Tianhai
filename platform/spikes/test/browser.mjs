import { chromium } from '../../node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const out=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../evidence');await fs.mkdir(out,{recursive:true});
const origin='http://127.0.0.1:8796';
async function resetRoom(){const r=await fetch(origin+'/api/reset-room',{method:'POST',headers:{'x-graybox-test':'local-only'}});assert.equal(r.status,204);}
await resetRoom();
const browser=await chromium.launch({headless:true,channel:process.env.GRAYBOX_BROWSER_CHANNEL||'chrome',args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
const pages=[],contexts=[],pageErrors=[];
const startedAt=new Date().toISOString();let report;
try{
 for(let i=0;i<4;i++){
  const ctx=await browser.newContext({viewport:{width:1280,height:900}});contexts.push(ctx);const page=await ctx.newPage();pages.push(page);page.on('pageerror',e=>pageErrors.push({client:i,message:e.message}));
  await page.goto(`${origin}/?client=qa-${i}&role=${i?'script':'manual'}&bots=0`);
  await page.waitForFunction(()=>window.__graybox?.getDiagnostics().connected,{timeout:15000});
 }
 await pages[0].waitForFunction(()=>window.__graybox.getState().players.every(p=>p.connected));
 const initial=await pages[0].evaluate(()=>window.__graybox.getState());assert.equal(initial.players.length,4);assert.deepEqual(initial.players.map(p=>p.clientId),['qa-0','qa-1','qa-2','qa-3']);
 await pages[0].screenshot({path:path.join(out,'graybox-ready.png'),fullPage:true});
 const addedRttMs=[100,150,200,250];for(let i=0;i<4;i++)await pages[i].evaluate(ms=>window.__graybox.setLatency(ms),addedRttMs[i]);
 await pages[0].evaluate(()=>window.__graybox.start());await pages[0].waitForFunction(()=>window.__graybox.getState().state==='racing');
 await pages[0].evaluate(()=>{const s=window.__graybox.getState();window.__graybox.sendRaw({type:'input',action:'jump',seq:1,matchId:s.matchId,z:999});window.__graybox.sendRaw({type:'input',action:'jump',seq:1,matchId:s.matchId});window.__graybox.sendRaw({type:'input',action:'jump',seq:1,matchId:s.matchId});});
 await pages[0].waitForFunction(()=>window.__graybox.getState().tick>=110);
 await pages[0].screenshot({path:path.join(out,'graybox-racing.png'),fullPage:true});
 const beforeReconnect=await pages[0].evaluate(()=>({player:window.__graybox.getState().players.find(p=>p.id===window.__graybox.getDiagnostics().playerId),diagnostics:window.__graybox.getDiagnostics()}));
 await pages[0].evaluate(()=>window.__graybox.reconnect());
 await pages[1].waitForFunction(()=>!window.__graybox.getState().players[0].connected);
 await pages[0].waitForFunction(()=>window.__graybox.getDiagnostics().connected&&window.__graybox.getDiagnostics().resumeCount===1,{timeout:15000});
 const afterReconnect=await pages[0].evaluate(()=>({player:window.__graybox.getState().players.find(p=>p.id===window.__graybox.getDiagnostics().playerId),diagnostics:window.__graybox.getDiagnostics()}));
 assert.equal(afterReconnect.player.id,beforeReconnect.player.id);assert.equal(afterReconnect.player.clientId,beforeReconnect.player.clientId);assert.ok(afterReconnect.player.z>beforeReconnect.player.z);assert.ok(afterReconnect.player.lastSeq>=beforeReconnect.player.lastSeq);
 await Promise.all(pages.map(p=>p.waitForFunction(()=>window.__graybox.getState().state==='finished',{timeout:35000})));
 const finals=await Promise.all(pages.map(p=>p.evaluate(()=>({state:window.__graybox.getState(),diagnostics:window.__graybox.getDiagnostics(),userAgent:navigator.userAgent}))));
 assert.equal(new Set(finals.map(f=>f.state.winner)).size,1);assert.equal(new Set(finals.map(f=>f.state.resultHash)).size,1);assert.ok(finals.every(f=>f.state.players.every(p=>p.finishTick!==null&&p.z===78)));
 await pages[0].waitForTimeout(700);
 const evidence=await (await fetch(origin+'/api/evidence')).json();assert.equal(evidence.snapshot.connections,4);assert.equal(Object.keys(evidence.acks).length,4);assert.ok(Object.values(evidence.acks).every(a=>a.validWinner&&a.resultHash===finals[0].state.resultHash));assert.ok(evidence.rejections.INVALID_INPUT>=1);assert.ok(evidence.rejections.DUPLICATE_SEQUENCE>=1);assert.equal(evidence.events.filter(e=>e.type==='joined').length,4);assert.equal(evidence.events.filter(e=>e.type==='resumed').length,1);assert.deepEqual(pageErrors,[]);
 await pages[0].screenshot({path:path.join(out,'graybox-finished.png'),fullPage:true});
 report={status:'PASS_LOCAL_DESKTOP_TECHNICAL_SPIKE',startedAt,finishedAt:new Date().toISOString(),environment:{os:os.platform(),osRelease:os.release(),arch:os.arch(),node:process.version,browser:browser.version(),viewport:{width:1280,height:900},network:'127.0.0.1 actual WebSockets; browser queues add controlled delays; not mobile/cross-region'},addedRttMs,beforeReconnect,afterReconnect,finals,evidence,pageErrors,assertions:['4 independent browser contexts and WebSocket identities','server rejected client teleport and duplicate sequence','same role/ID/sequence preserved after disconnect; authoritative progress continued','all four clients reported identical winner and final result hash','all four result acknowledgements validated against server','no uncaught browser page errors']};
 await fs.writeFile(path.join(out,'browser-validation.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({status:report.status,winner:finals[0].state.winner,resultHash:finals[0].state.resultHash,connections:evidence.snapshot.connections,acks:Object.keys(evidence.acks).length,resumes:1,pageErrors:pageErrors.length,frameP95Ms:finals.map(f=>Number(f.diagnostics.frameP95Ms.toFixed(2))),rttMs:finals.map(f=>Math.round(f.diagnostics.rttMs))},null,2));
}finally{await browser.close();await resetRoom();}
