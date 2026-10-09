import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TigerEffects,TIGER_PARTICLE_LIMIT} from '../src/tiger/effects';

test('Tiger effect frames sleep when empty, wake once, stay bounded and clean up after hide/dispose',()=>{
 const names=['document','ResizeObserver','requestAnimationFrame','cancelAnimationFrame','matchMedia','devicePixelRatio','performance'] as const;
 const previous=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
 const doc=Object.assign(new EventTarget(),{hidden:false}),callbacks=new Map<number,FrameRequestCallback>();
 let serial=0,time=0,draws=0,clears=0;
 const gradient={addColorStop(){}},context=new Proxy({}, {get(_target,key){if(key==='clearRect')return()=>clears++;if(key==='fillRect'||key==='fill')return()=>draws++;if(String(key).startsWith('create'))return()=>gradient;return()=>{};},set(){return true;}});
 const values={document:doc,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:FrameRequestCallback)=>{callbacks.set(++serial,fn);return serial;},cancelAnimationFrame:(id:number)=>callbacks.delete(id),matchMedia:()=>({matches:false}),devicePixelRatio:3,performance:{now:()=>time}};
 for(const name of names)Object.defineProperty(globalThis,name,{configurable:true,value:values[name]});
 const canvas={getContext:()=>context,width:0,height:0} as unknown as HTMLCanvasElement;
 const game={getBoundingClientRect:()=>({width:390,height:844})} as unknown as HTMLElement;
 const step=()=>{time+=16.7;const pending=[...callbacks.values()];callbacks.clear();for(const cb of pending)cb(time);};
 let fx:TigerEffects|undefined;
 try{
  fx=new TigerEffects(canvas,game);assert.equal(callbacks.size,0,'empty canvas has no idle RAF');
  assert.equal(canvas.width,780,'existing DPR ceiling remains intact');
  for(let i=0;i<30;i++)fx.burstAt(200,100,3);
  fx.rain(60);assert.equal(callbacks.size,1,'all bursts share one animation loop');
  draws=0;step();assert.equal(draws,TIGER_PARTICLE_LIMIT,'bursts and rain share one total cap');
  for(let i=0;i<400&&callbacks.size;i++)step();
  assert.equal(callbacks.size,0,'finished particles leave no idle loop');
  const cleared=clears;for(let i=0;i<60;i++)step();assert.equal(clears,cleared,'sleep performs no canvas clears');
  fx.rain(100);assert.equal(callbacks.size,1,'a later first effect wakes immediately');step();
  doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(callbacks.size,0);
  fx.burstAt(0,0);fx.rain();assert.equal(callbacks.size,0,'hidden events cannot restart rendering');
  doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(callbacks.size,0,'old effects do not replay on resume');
  fx.burstAt(0,0);assert.equal(callbacks.size,1);fx.dispose();assert.equal(callbacks.size,0);
  fx.rain();fx.burstAt(0,0);assert.equal(callbacks.size,0,'disposed effect owner cannot wake');
 }finally{fx?.dispose();for(const name of names){const descriptor=previous.get(name);if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}}
});
