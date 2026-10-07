/** Actual RunGame and Arena UI, injected scene/assets/API promises; no public API or device. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
import * as engine from '../arena/run/engine.mjs';

const root=resolve(new URL('..',import.meta.url).pathname),out=resolve(root,'review/run-request-feedback');
const game=engine.view(engine.createState('02'.repeat(32),10000,{players:[{key:'p0',seatIndex:0},{key:'p1',seatIndex:1}]}),'p0');
const fixture=`
const originalSetTimeout=window.setTimeout.bind(window),originalClearTimeout=window.clearTimeout.bind(window),feedbackTimers=new Set();
window.setTimeout=(fn,ms,...args)=>{let id;id=originalSetTimeout(()=>{feedbackTimers.delete(id);fn(...args)},ms);if(ms===170)feedbackTimers.add(id);return id};
window.clearTimeout=id=>{feedbackTimers.delete(id);originalClearTimeout(id)};
const game=${JSON.stringify(game)};game.startedAt=Date.now()-1000;game.deadlineAt=Date.now()+600000;game.phase='racing';
window.runQA={roomId:'room-a',seq:0,version:1,actions:[],reads:[],rooms:{},sounds:[],scenesCreated:0,scenesDisposed:0,feedbackTimers:()=>feedbackTimers.size,
 context:{game_id:'run',external_user_id:'p0',scope:{app_id:'fixture-app'},active_room_id:'room-a',competitive_fee_bps:0},
 snapshot(){game.snapshotTick++;game.serverNow=Date.now();const room={id:this.roomId,code:'FIXTURE',game_id:'run',status:'active',capacity:2,practice:true,team_size:1,me:'p0',me_last_seq:this.seq,version:++this.version,server_now:Date.now(),starts_at:game.startedAt,entry_minor:'0',fee_bps:0,prize_minor:'0',players:game.players.map(p=>({external_user_id:p.key,seat_index:p.seatIndex,name:p.name,bot:p.isBot,ready:true})),game:structuredClone(game)};this.rooms[this.roomId]=room;return room},
 action(path,body){const id=path.split('/').at(-2),room=structuredClone(this.rooms[id]||this.snapshot());return new Promise((resolve,reject)=>this.actions.push({path,room,body:structuredClone(body),resolve,reject,done:false}))},
 resolve(index){const action=this.actions[index];if(action.done)throw Error('Action already completed');action.done=true;let room;if(action.room.id===this.roomId){this.seq=action.body.seq??this.seq+1;room=this.snapshot()}else{room=structuredClone(action.room);room.me_last_seq=action.body.seq??room.me_last_seq+1;room.version++;}action.resolve({room})},
 reject(index,status=503,code){const action=this.actions[index];if(action.done)throw Error('Action already completed');action.done=true;action.reject(Object.assign(new Error(status===null?'Injected timeout':'Injected unavailable'),{status:status??undefined,code:code||(status===429?'RATE_LIMIT':'INJECTED_UNAVAILABLE')}))},
 async api(path,body){if(path==='/api/arena/session')return this.context;if(path.endsWith('/action'))return this.action(path,body);if(body===undefined&&path.startsWith('/api/pvp/rooms/')){const id=path.split('/').at(-1),room=id===this.roomId?this.snapshot():structuredClone(this.rooms[id]);if(!room)throw Error('Unknown fixture room');if(this.holdNextRead){this.holdNextRead=false;return new Promise(resolve=>this.reads.push({room,resolve}))}return room}throw Error('Unexpected fixture API '+path)},
 recent(){game.players[0].lastEvent={type:'item_pickup',at:Date.now()}},
 resetRoom(id,tick=0){this.roomId=id;this.seq=0;game.snapshotTick=tick;game.startedAt=Date.now()-1000;game.serverNow=Date.now();},
 authorizeRoom(id,tick=0){this.resetRoom(id,tick);this.context={...this.context,active_room_id:id};window.dispatchEvent(new CustomEvent('oasis:authorized',{detail:{context:this.context}}))}
};`;
const component=`import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';import RunGame from './arena/run/RunGame.jsx';
function App(){const q=window.runQA,[room,setRoom]=useState(()=>q.snapshot()),[shown,show]=useState(true);q.hide=()=>show(false);q.show=()=>show(true);q.swap=id=>{q.resetRoom(id);setRoom(q.snapshot())};useEffect(()=>{const timer=setInterval(()=>setRoom(q.snapshot()),80);return()=>clearInterval(timer)},[]);return <><output data-testid="fixture-room">{room.id}</output>{shown&&<RunGame key={room.id+':p0'} room={room} me="p0" audio={{enabled:false,play:kind=>q.sounds.push(kind)}} onExit={()=>{}} onAction={action=>q.action('/component-action',{action})}/>}</>};createRoot(document.getElementById('root')).render(<App/>);`;
const modules={
 'scene.mjs':`export function createRunScene(container,{onReady,onFrame}){window.runQA.scenesCreated++;let dead=false,ready=false;container.dataset.ready='true';return{update(game){container.dataset.tick=game.snapshotTick;onFrame(performance.now());if(!ready){ready=true;queueMicrotask(()=>{if(!dead)onReady()})}},feedback(){},dispose(){if(!dead)window.runQA.scenesDisposed++;dead=true}}}`,
 'atlas-characters.mjs':`export const preloadIllustratedRunners=async()=>[];export const createRunPortraitLease=async()=>({url:null,dispose(){}});`,
 'environment.mjs':`export const loadOasisKit=async()=>({});export const loadOasisBackdrop=async()=>({});`,
 'audio.mjs':`export class ArenaAudio{constructor(){this.enabled=false}subscribe(){return()=>{}}unlock(){}play(kind){window.runQA.sounds.push(kind)}dispose(){}toggle(){}setEnabled(){}}`,
 'client.mjs':`export const api=(...args)=>window.runQA.api(...args);let sequence=0;export const requestId=()=>String(++sequence);export const waitForLaunch=async()=>window.runQA.context;export const registerHostControls=()=>()=>{};export const completeHostReturn=()=>{};export const coins=String;`,
};
const bundle=await build({entryPoints:{arena:resolve(root,'arena/main.jsx'),component:'feedback-component'},bundle:true,write:false,outdir:'/virtual-run-feedback',format:'esm',jsx:'automatic',logLevel:'silent',loader:{'.webp':'dataurl','.svg':'dataurl'},plugins:[{name:'bounded-feedback-fixtures',setup(b){
 b.onResolve({filter:/^feedback-component$/},()=>({path:'feedback-component',namespace:'fixture'}));
 b.onResolve({filter:/^\/arena\/assets\//},()=>({path:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',external:true}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:component,loader:'jsx',resolveDir:root}));
 b.onLoad({filter:/\/arena\/run\/(scene\.mjs|atlas-characters\.mjs|environment\.mjs)$/},a=>({contents:modules[a.path.split('/').at(-1)],loader:'js'}));
 b.onLoad({filter:/\/arena\/shared\/(audio|client)\.mjs$/},a=>({contents:modules[a.path.split('/').at(-1)],loader:'js'}));
 b.onLoad({filter:/\/arena\/shared\/(ThemeResult|PlayerPortrait|LobbyArt)\.jsx$/},()=>({contents:'export default function Empty(){return null}',loader:'jsx'}));
 b.onLoad({filter:/\/arena\/(match|golf|towerlink|carrom|darts|ludo|jackaroo|domino|pool|bowling)\/.*Game\.jsx$/},()=>({contents:'export default function Empty(){return null}',loader:'jsx'}));
}}]});
const files=new Map(bundle.outputFiles.map(file=>['/'+file.path.split('/').at(-1),file.text]));
const server=createServer((req,res)=>{if(files.has(req.url)){res.setHeader('content-type',req.url.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');return res.end(files.get(req.url));}const name=req.url.startsWith('/play/')?'arena':'component';res.setHeader('content-type','text/html; charset=utf-8');res.end(`<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/${name}.css"><div id="root"></div><script>${fixture}</script><script type="module" src="/${name}.js"></script>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browserName=process.env.RUN_FEEDBACK_BROWSER||'chromium',browser=await(browserName==='webkit'?webkit.launch({headless:true}):chromium.launch({channel:'chrome',headless:true}));
const report={scope:'Actual Arena + RunGame React UI. Scene, assets and API promises injected in an isolated local fixture; no physics, performance, public-host or physical-device claim.',browser:browserName,checks:[],errors:[]};
const origin=`http://127.0.0.1:${server.address().port}`;
const count=page=>page.evaluate(()=>runQA.actions.length);
const ready=page=>page.waitForFunction(()=>document.querySelector('[data-testid=run-jump]')?.disabled===false);
const caption=page=>page.locator('.run-speed [role=status]').textContent();
const disabled=page=>page.evaluate(()=>['left','right','jump','slide','item'].every(name=>document.querySelector('[data-testid=run-'+name+']').disabled));
async function newPage(path){const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text())});await page.goto(origin+path);await ready(page);return page;}
try{
 const page=await newPage('/component');
 await page.getByTestId('run-left').tap();assert.equal(await count(page),1);await page.waitForTimeout(220);
 await page.evaluate(()=>runQA.resolve(0));await ready(page);await page.getByTestId('run-jump').tap();assert.equal(await count(page),2);
 await page.waitForTimeout(220);assert.match(await page.getByTestId('run-scene').getAttribute('class'),/run-feedback-jump/);assert.equal(await page.evaluate(()=>runQA.feedbackTimers()),0);
 report.checks.push('The previous ACK clear timer cannot erase the next action feedback while its response is pending');
 await page.evaluate(()=>runQA.resolve(1));await ready(page);assert.equal(await page.evaluate(()=>runQA.feedbackTimers()),1);
 await page.evaluate(()=>runQA.hide());await page.getByTestId('run-scene').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>runQA.feedbackTimers()),0);
 report.checks.push('Unmount cancels the outstanding feedback clear timer');
 await page.evaluate(()=>runQA.show());await ready(page);await page.getByTestId('run-left').tap();assert.equal(await count(page),3);
 await page.evaluate(()=>runQA.swap('room-b'));await ready(page);await page.getByTestId('run-right').tap();assert.equal(await count(page),4);
 await page.evaluate(()=>runQA.resolve(2));await page.waitForTimeout(220);assert.match(await page.getByTestId('run-scene').getAttribute('class'),/run-feedback-right/);assert.equal(await disabled(page),true);assert.equal(await page.evaluate(()=>runQA.feedbackTimers()),0);
 report.checks.push('A late ACK from the previous room cannot clear the new room pending flag or feedback');
 await page.evaluate(()=>runQA.resolve(3));await ready(page);await page.waitForTimeout(180);
 assert.doesNotMatch(await page.getByTestId('run-scene').getAttribute('class'),/run-feedback-/);
 await page.getByTestId('run-jump').tap();await page.evaluate(()=>runQA.hide());await page.getByTestId('run-scene').waitFor({state:'detached'});await page.evaluate(()=>runQA.reject(4));await page.waitForTimeout(220);assert.equal(await page.evaluate(()=>runQA.feedbackTimers()),0);
 report.checks.push('A response rejected after unmount cannot schedule a new clear timer');await page.close();

 const arena=await newPage('/play/run');
 await arena.getByTestId('run-jump').tap();assert.equal(await count(arena),1);assert.equal(await disabled(arena),true);assert.match(await caption(arena),/正在确认上一动作/);
 await arena.evaluate(()=>runQA.recent());await arena.waitForTimeout(180);assert.match(await caption(arena),/正在确认上一动作/);
 const box=await arena.getByTestId('run-track').boundingBox();
 // Real touch tap targets the same canvas waiting gate. Pointer swipe lifecycle
 // is exercised below with DOM PointerEvents to run identically in both engines.
 await arena.touchscreen.tap(box.x+box.width*.5,box.y+box.height*.5);
 await arena.evaluate(()=>{const track=document.querySelector('[data-testid=run-track]');for(const[type,x]of[['pointerdown',200],['pointermove',130],['pointerup',130]])track.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:91,pointerType:'touch',isPrimary:true,button:0,clientX:x,clientY:420}));});
 assert.equal(await count(arena),1);assert.match(await caption(arena),/暂不能操作/);
 report.checks.push('In-flight input disables every action, reports waiting ahead of recent events, and never queues another canvas gesture');
 await arena.evaluate(()=>runQA.reject(0));await arena.getByRole('button',{name:'重试原请求'}).waitFor();assert.equal(await disabled(arena),true);assert.match(await caption(arena),/上一动作结果待确认/);
 await mkdir(out,{recursive:true});await arena.screenshot({path:resolve(out,`${browserName}-unresolved.png`)});
 await arena.keyboard.press('ArrowLeft');assert.equal(await count(arena),1);assert.equal(await arena.getByRole('button',{name:'重试原请求'}).isEnabled(),true);
 report.checks.push('An uncertain 503 outcome keeps Run controls disabled while the parent retry remains available');
 await arena.getByRole('button',{name:'重试原请求'}).tap();assert.equal(await count(arena),2);assert.equal(await disabled(arena),true);assert.match(await caption(arena),/正在确认上一动作/);
 assert.deepEqual(await arena.evaluate(()=>runQA.actions[1].body),await arena.evaluate(()=>runQA.actions[0].body));
 await arena.evaluate(()=>runQA.resolve(1));await ready(arena);await arena.locator('.arena-error').waitFor({state:'detached'});assert.doesNotMatch(await caption(arena),/Injected|待确认|正在确认/);
 report.checks.push('Retry retains the exact request ID/sequence/body; success unlocks controls and removes the old error from Run');
 await arena.waitForTimeout(180);await arena.getByTestId('run-left').tap();assert.equal(await count(arena),3);await arena.evaluate(()=>runQA.reject(2,429));await arena.getByRole('button',{name:'重试原请求'}).waitFor();assert.equal(await disabled(arena),true);assert.match(await caption(arena),/上一动作结果待确认/);
 await arena.getByRole('button',{name:'重试原请求'}).tap();await arena.evaluate(()=>runQA.resolve(3));await ready(arena);
 report.checks.push('The existing 429/recovery path also stays blocked until the original intent is confirmed');
 await arena.waitForTimeout(180);await arena.getByTestId('run-jump').tap();assert.equal(await count(arena),5);await arena.evaluate(()=>runQA.reject(4,null));await arena.getByRole('button',{name:'重试原请求'}).waitFor();assert.equal(await disabled(arena),true);
 await arena.getByRole('button',{name:'重试原请求'}).tap();await arena.evaluate(()=>runQA.resolve(5));await ready(arena);
 report.checks.push('A transport error also retains the explicit original-request retry instead of enabling fresh actions');

 await arena.evaluate(()=>runQA.resetRoom('room-a',1800));await arena.waitForFunction(()=>Number(document.querySelector('[data-testid=run-track]').dataset.tick)>=1800);
 await arena.waitForTimeout(180);await arena.getByTestId('run-jump').tap();assert.equal(await count(arena),7);
 const beforeSwap=await arena.evaluate(()=>({created:runQA.scenesCreated,disposed:runQA.scenesDisposed}));
 await arena.evaluate(()=>runQA.authorizeRoom('room-b',3));await arena.waitForFunction(()=>Number(document.querySelector('[data-testid=run-track]')?.dataset.tick)<100);
 assert.equal(await disabled(arena),true);await arena.evaluate(()=>runQA.resolve(6));await ready(arena);await arena.waitForTimeout(350);
 assert.ok(Number(await arena.getByTestId('run-track').getAttribute('data-tick'))<100);
 assert.deepEqual(await arena.evaluate(()=>({created:runQA.scenesCreated,disposed:runQA.scenesDisposed})),{created:beforeSwap.created+1,disposed:beforeSwap.disposed+1});
 await arena.getByTestId('run-left').tap();assert.equal(await arena.evaluate(()=>runQA.actions[7].path),'/api/pvp/rooms/room-b/action');assert.ok(await arena.evaluate(()=>runQA.actions[7].body.action.observed_tick<100));await arena.evaluate(()=>runQA.resolve(7));await ready(arena);
 report.checks.push('Actual Arena remounts high-tick A into low-tick B once, disposes A, and a late A success cannot restore A or its input tick');

 await arena.waitForTimeout(180);await arena.getByTestId('run-jump').tap();assert.equal(await count(arena),9);
 await arena.evaluate(()=>{runQA.holdNextRead=true;runQA.reject(8,409,'STALE_INPUT')});await arena.waitForFunction(()=>runQA.reads.length===1);
 const beforeReadSwap=await arena.evaluate(()=>runQA.scenesCreated);
 await arena.evaluate(()=>runQA.authorizeRoom('room-c',3));await arena.waitForFunction(created=>runQA.scenesCreated===created+1,beforeReadSwap);
 await arena.evaluate(()=>runQA.reads[0].resolve(runQA.reads[0].room));await ready(arena);await arena.waitForTimeout(200);
 assert.equal(await arena.evaluate(()=>runQA.scenesCreated),beforeReadSwap+1);
 await arena.getByTestId('run-right').tap();assert.equal(await arena.evaluate(()=>runQA.actions[9].path),'/api/pvp/rooms/room-c/action');assert.ok(await arena.evaluate(()=>runQA.actions[9].body.action.observed_tick<100));await arena.evaluate(()=>runQA.resolve(9));await ready(arena);
 report.checks.push('A recovery GET begun for rejected B input cannot replace C after same-owner authorization restores another room');

 await arena.waitForTimeout(180);await arena.getByTestId('run-jump').tap();assert.equal(await count(arena),11);
 const beforeRetrySwap=await arena.evaluate(()=>runQA.scenesCreated);
 await arena.evaluate(()=>runQA.authorizeRoom('room-d',3));await arena.waitForFunction(created=>runQA.scenesCreated===created+1,beforeRetrySwap);
 await arena.evaluate(()=>runQA.reject(10));await arena.getByRole('button',{name:'重试原请求'}).waitFor();assert.equal(await disabled(arena),true);
 await arena.getByRole('button',{name:'重试原请求'}).tap();assert.equal(await count(arena),12);
 assert.deepEqual(await arena.evaluate(()=>({path:runQA.actions[11].path,body:runQA.actions[11].body})),await arena.evaluate(()=>({path:runQA.actions[10].path,body:runQA.actions[10].body})));
 await arena.evaluate(()=>runQA.resolve(11));await ready(arena);await arena.waitForTimeout(200);assert.equal(await arena.evaluate(()=>runQA.scenesCreated),beforeRetrySwap+1);
 await arena.getByTestId('run-left').tap();assert.equal(await arena.evaluate(()=>runQA.actions[12].path),'/api/pvp/rooms/room-d/action');await arena.evaluate(()=>runQA.resolve(12));await ready(arena);
 report.checks.push('Retry of an uncertain old-room intent confirms that exact request without replacing the restored room or its next input');
 await arena.waitForTimeout(180);await arena.getByTestId('run-jump').tap();assert.equal(await count(arena),14);
 const beforeRejectSwap=await arena.evaluate(()=>runQA.scenesCreated);
 await arena.evaluate(()=>runQA.authorizeRoom('room-e',3));await arena.waitForFunction(created=>runQA.scenesCreated===created+1,beforeRejectSwap);
 await arena.evaluate(()=>runQA.reject(13,409,'INVALID_SEQUENCE'));await ready(arena);await arena.locator('.arena-error').waitFor({state:'detached'});assert.doesNotMatch(await caption(arena),/待确认|正在确认/);
 await arena.getByTestId('run-left').tap();assert.equal(await arena.evaluate(()=>runQA.actions[14].path),'/api/pvp/rooms/room-e/action');await arena.evaluate(()=>runQA.resolve(14));await ready(arena);
 report.checks.push('A definite old-room 409 clears only its pending prompt and leaves the restored room playable');
 await mkdir(out,{recursive:true});await arena.screenshot({path:resolve(out,`${browserName}-recovered.png`)});await arena.close();
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.failure=error.stack;process.exitCode=1;}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));await mkdir(out,{recursive:true});await writeFile(resolve(out,`${browserName}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
