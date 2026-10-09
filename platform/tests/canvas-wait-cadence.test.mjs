import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPoolTable} from '../arena/pool/table.mjs';
import {createCarromBoard} from '../arena/carrom/board.mjs';
import * as pool from '../arena/pool/engine.mjs';
import * as carrom from '../arena/carrom/engine.mjs';

for(const [name,engine,create]of[['pool',pool,createPoolTable],['carrom',carrom,createCarromBoard]])test(`${name}: wait redraws are bounded; changed aim and authoritative rolling draw on the next frame`,()=>{
 const names=['document','window','ResizeObserver','Image','requestAnimationFrame','cancelAnimationFrame','devicePixelRatio'];
 const saved=new Map(names.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const callbacks=new Map(),doc=Object.assign(new EventTarget(),{hidden:false}),win=new EventTarget();let id=0,stamp=0,draws=0;
 function canvas(count=false){const ctx=new Proxy({}, {get(_object,key){if(key==='clearRect')return()=>{if(count)draws++;};if(String(key).startsWith('create'))return()=>({addColorStop(){}});return()=>{};},set(){return true;}});return Object.assign(new EventTarget(),{getContext:()=>ctx,getBoundingClientRect:()=>({width:390,height:390,left:0,top:0}),hasPointerCapture:()=>true,setPointerCapture(){},width:0,height:0});}
 doc.createElement=()=>canvas();
 const values={document:doc,window:win,ResizeObserver:class{observe(){}disconnect(){}},Image:class{complete=false;naturalWidth=0;},requestAnimationFrame:fn=>{callbacks.set(++id,fn);return id;},cancelAnimationFrame:id=>callbacks.delete(id),devicePixelRatio:2};
 for(const key of names)Object.defineProperty(globalThis,key,{configurable:true,value:values[key]});
 const players=[{key:'p0',seatIndex:0,name:'You'},{key:'p1',seatIndex:1,name:'Bot'}],state=engine.createState('12'.repeat(32),1000,{players});state.turnKey='p0';
 let game=engine.view(state,'p0'),angle=0,controller;
 const get=()=>({game,angle,offset:0,power:.72,canInput:true,canShoot:true,now:1000+stamp,placement:null});
 function step(){stamp+=1000/60;const pending=[...callbacks.values()];callbacks.clear();for(const fn of pending)fn(stamp);}
 try{
  controller=create(canvas(true),{get,onGesture(){},onAim(){},onPlace(){},onCall(){},onSound(){}});
  for(let i=0;i<60;i++)step();assert(draws>=15&&draws<=21,`wait rendered ${draws} of 60 RAFs`);
  const before=draws;angle=.25;step();assert.equal(draws,before+1,'aim wakes a draw inside the idle interval');
  const action=name==='pool'?{type:'shot',angle:0,power:.84,spinX:0,spinY:0}:{type:'shot',offset:0,angle:0,power:.72};
  engine.act(state,'p0',action,Math.ceil(1000+stamp));assert.equal(state.phase,'rolling');game=engine.view(state,'p0');const source=JSON.stringify(game.trajectory);
  const movingBefore=draws;for(let i=0;i<12;i++)step();assert.equal(draws,movingBefore+12,'all authored motion frames render');
  assert.equal(JSON.stringify(game.trajectory),source,'view sampling never modifies authority rows');
  doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(callbacks.size,0,'background cancels rendering');
  doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(callbacks.size,1,'foreground wakes exactly one loop');
  controller.dispose();assert.equal(callbacks.size,0);
 }finally{controller?.dispose();for(const key of names){const descriptor=saved.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
