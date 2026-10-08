import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const original=await fs.readFile(new URL('./fixtures/arena-audio-before-preparation.mjs',import.meta.url),'utf8');
const candidate=await fs.readFile(new URL('../arena/shared/audio.mjs',import.meta.url),'utf8');
const main=await fs.readFile(new URL('../arena/main.jsx',import.meta.url),'utf8');
// Exercise the actual small React effect without importing game boot/network code.
const gestureEffect=main.split('\n').find(line=>line.startsWith(' useEffect(()=>{const unlock='));
assert.ok(gestureEffect,'Arena gesture effect must be explicitly reviewed if moved');
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

function harness(source=candidate,options={}){
 const state={constructors:0,contexts:[],gains:[],oscillators:[],timers:new Map(),gesture:false,resumeGestures:[],gainCalls:0,connectCalls:0};
 let timerId=0;
 const listeners={window:new Map(),document:new Map()};
 const eventTarget=kind=>({addEventListener(name,fn){if(!listeners[kind].has(name))listeners[kind].set(name,new Set());listeners[kind].get(name).add(fn);},removeEventListener(name,fn){listeners[kind].get(name)?.delete(fn);}});
 const param=()=>({value:1,calls:[],setValueAtTime(...args){this.value=args[0];this.calls.push(['set',...args]);},setTargetAtTime(...args){this.value=args[0];this.calls.push(['target',...args]);},linearRampToValueAtTime(...args){this.calls.push(['linear',...args]);},exponentialRampToValueAtTime(...args){this.calls.push(['exponential',...args]);}});
 class Context{
  constructor(){state.constructors++;if(state.constructors<=(options.constructorFailures||0))throw Error('constructor denied');this.state=options.initialState||'suspended';this.currentTime=2;this.destination={};this.closeCount=0;this.resumeCount=0;this.gains=[];this.requests=[];state.contexts.push(this);}
  createGain(){if(++state.gainCalls===options.failGainAt)throw Error('gain denied');const gain={gain:param(),disconnectCount:0,connect(target){if(++state.connectCalls===options.failConnectAt)throw Error('connect denied');this.target=target;},disconnect(){this.disconnectCount++;}};this.gains.push(gain);state.gains.push(gain);return gain;}
  createOscillator(){const oscillator={frequency:param(),type:'sine',disconnectCount:0,startCalls:[],stopCalls:[],connect(target){this.target=target;},disconnect(){this.disconnectCount++;},start(...args){this.startCalls.push(args);},stop(...args){this.stopCalls.push(args);}};state.oscillators.push(oscillator);return oscillator;}
  resume(){this.resumeCount++;state.resumeGestures.push(state.gesture);if(options.resumeMode==='throw')throw Error('resume threw');if(options.resumeMode==='reject')return Promise.reject(Error('gesture denied'));if(options.resumeMode==='pending')return new Promise((resolve,reject)=>this.requests.push({resolve:()=>{this.state='running';resolve();},reject}));this.state='running';return Promise.resolve();}
  close(){this.closeCount++;this.state='closed';if(options.closeMode==='throw')throw Error('close threw');if(options.closeMode==='reject')return Promise.reject(Error('close rejected'));return Promise.resolve();}
 }
 const window={...eventTarget('window'),...(options.noContext?{}:options.webkit?{webkitAudioContext:Context}:{AudioContext:Context})};
 const document={...eventTarget('document'),hidden:false};
 const timer=(kind,fn,ms)=>{const id=++timerId;state.timers.set(id,{kind,fn,ms});return id;};
 const globals={window,document,console,setTimeout:(fn,ms)=>timer('timeout',fn,ms),clearTimeout:id=>state.timers.delete(id),setInterval:(fn,ms)=>timer('interval',fn,ms),clearInterval:id=>state.timers.delete(id),module:{exports:{}}};
 vm.runInNewContext(source.replace('export class ArenaAudio','class ArenaAudio')+'\nmodule.exports={ArenaAudio};',globals);
 const audio=new globals.module.exports.ArenaAudio(options.theme||'match');
 return{audio,state,document,window,options,
  unlock(){state.gesture=true;try{return audio.unlock();}finally{state.gesture=false;}},
  fire(kind,name,event={}){for(const fn of listeners[kind].get(name)||[])fn(event);},
  timeout(){for(const[id,t]of[...state.timers])if(t.kind==='timeout'){state.timers.delete(id);t.fn();}},
  tick(){for(const t of [...state.timers.values()])if(t.kind==='interval')t.fn();},
  intervals(){return[...state.timers.values()].filter(t=>t.kind==='interval');},
  listenerCount(){return[...listeners.window.values(),...listeners.document.values()].reduce((n,set)=>n+set.size,0);},
  spectrum(){return state.oscillators.map(o=>({type:o.type,frequency:o.frequency.calls,gain:o.target.gain.calls,start:o.startCalls,stop:o.stopCalls,music:o.target.target===audio.music}));},
 };
}

test('entry creates one silent complete graph without sources, resume or timers',()=>{
 const h=harness();assert.equal(h.state.constructors,1);assert.equal(h.state.gains.length,2);
 assert.equal(h.audio.master.gain.value,0);assert.equal(h.audio.music.gain.value,.16);
 assert.equal(h.state.oscillators.length,0);assert.deepEqual(h.state.resumeGestures,[]);assert.equal(h.state.timers.size,0);h.audio.dispose();
});

test('score tables, score tick, SFX selection and tone envelopes remain byte-identical',()=>{
 const line=(source,needle)=>source.split('\n').find(line=>line.includes(needle));
 for(const needle of ['const scores=','const tick='])assert.equal(line(candidate,needle),line(original,needle));
 const effects=source=>source.slice(source.indexOf('  play(kind,'),source.indexOf('  silence()'));
 assert.equal(effects(candidate),effects(original));
 const tone=source=>line(source,'  tone(freq,').split('const start=')[1];
 assert.equal(tone(candidate),tone(original));
});

test('first gesture restores the original master level immediately, with no extra fade-in',async()=>{
 for(const [detail,gain]of [[{},.38],[{voiceActive:true},.095],[{muted:true},0],[{visible:false},0]]){
  const h=harness(candidate,{resumeMode:'pending'});h.fire('window','oasis:host-state',{detail});assert.equal(h.audio.master.gain.value,0);
  const pending=h.unlock();assert.equal(h.audio.master.gain.value,gain);h.audio.dispose();await pending;
 }
});

test('autoplay-allowed graph remains silent before actual unlock, including preference changes',()=>{
 const h=harness(candidate,{initialState:'running'});h.audio.play('clear');h.audio.setEnabled(false);h.audio.setEnabled(true);h.audio.setMusic(false);h.audio.setMusic(true);h.audio.duck(true);
 h.fire('window','oasis:host-state',{detail:{voiceActive:true}});h.fire('document','visibilitychange');
 assert.equal(h.state.oscillators.length,0);assert.equal(h.audio.master.gain.value,0);assert.equal(h.state.timers.size,0);h.audio.dispose();
});

for(const initialState of ['suspended','interrupted'])test(`${initialState}: gesture resumes synchronously and schedules exactly one music interval`,async()=>{
 const h=harness(candidate,{initialState});const pending=h.unlock();assert.deepEqual(h.state.resumeGestures,[true]);await pending;
 assert.equal(h.state.constructors,1);assert.equal(h.audio.master.gain.value,.38);assert.equal(h.intervals().length,1);
 await h.unlock();await h.unlock();assert.equal(h.intervals().length,1);assert.equal(h.state.contexts[0].resumeCount,1);h.audio.dispose();
});

test('running graph unlock uses the original graph, no redundant resume',async()=>{
 const h=harness(candidate,{initialState:'running'});await h.unlock();assert.deepEqual(h.state.resumeGestures,[]);assert.equal(h.intervals().length,1);h.audio.dispose();
});

test('early constructor denial retries inside gesture',async()=>{
 const h=harness(candidate,{constructorFailures:1});assert.equal(h.audio.ctx,undefined);await h.unlock();assert.equal(h.state.constructors,2);assert.deepEqual(h.state.resumeGestures,[true]);assert.equal(h.intervals().length,1);h.audio.dispose();
});

for(const failure of [{failGainAt:2},{failConnectAt:2}])test(`partial ${Object.keys(failure)[0]} graph disconnects/closes and is never published`,async()=>{
 const h=harness(candidate,failure);const failed=h.state.contexts[0];assert.equal(h.audio.ctx,undefined);assert.equal(failed.closeCount,1);assert.ok(failed.gains.every(g=>g.disconnectCount===1));
 await h.unlock();assert.equal(h.state.contexts.length,2);assert.equal(h.intervals().length,1);h.audio.dispose();assert.equal(failed.closeCount,1);
});

for(const resumeMode of ['reject','throw'])test(`${resumeMode} resume is contained and a later gesture retries`,async()=>{
 const h=harness(candidate,{resumeMode});await h.unlock();assert.equal(h.state.timers.size,0);assert.equal(h.state.oscillators.length,0);
 h.options.resumeMode='resolve';await h.unlock();assert.deepEqual(h.state.resumeGestures,[true,true]);assert.equal(h.intervals().length,1);h.audio.dispose();
});

test('pending resume is single-flight, times out, and late completion cannot duplicate music',async()=>{
 const h=harness(candidate,{resumeMode:'pending'});const first=h.unlock();assert.equal(first,h.unlock());assert.equal(h.state.contexts[0].resumeCount,1);
 h.timeout();await first;assert.equal(h.state.timers.size,0);const second=h.unlock();assert.equal(h.state.contexts[0].resumeCount,2);
 h.state.contexts[0].requests[1].resolve();await second;assert.equal(h.intervals().length,1);
 h.state.contexts[0].requests[0].resolve();await flush();assert.equal(h.intervals().length,1);h.audio.dispose();
});

test('dispose settles pending resume, removes listeners and cannot resurrect sound on late completion',async()=>{
 const h=harness(candidate,{resumeMode:'pending'});const pending=h.unlock();h.audio.dispose();await pending;
 assert.equal(h.state.timers.size,0);assert.equal(h.listenerCount(),0);assert.equal(h.state.contexts[0].closeCount,1);
 h.state.contexts[0].requests[0].resolve();await flush();await h.unlock();h.audio.startMusic();h.audio.play('clear');h.audio.setEnabled(true);h.audio.dispose();
 assert.equal(h.state.oscillators.length,0);assert.equal(h.state.timers.size,0);assert.equal(h.state.constructors,1);assert.equal(h.state.contexts[0].closeCount,1);
});

test('dispose disconnects active voices and graph exactly once',async()=>{
 const h=harness();await h.unlock();h.audio.play('clear');const voices=[...h.audio.voices];h.audio.dispose();h.audio.dispose();
 assert.equal(h.audio.voices.size,0);assert.ok(voices.every(v=>v.o.onended===null&&v.o.disconnectCount===1&&v.g.disconnectCount===1));
 assert.equal(h.audio.master.disconnectCount,1);assert.equal(h.audio.music.disconnectCount,1);assert.equal(h.state.timers.size,0);
});

test('host mute/voice ducking, enable, music and SFX switches retain their gains and gating',async()=>{
 const h=harness();await h.unlock();h.fire('window','oasis:host-state',{detail:{voiceActive:true}});assert.equal(h.audio.master.gain.value,.095);
 h.fire('window','oasis:host-state',{detail:{muted:true}});assert.equal(h.audio.master.gain.value,0);h.fire('window','oasis:host-state',{detail:{visible:false}});assert.equal(h.audio.master.gain.value,0);
 h.fire('window','oasis:host-state',{detail:{}});assert.equal(h.audio.master.gain.value,.38);h.audio.duck(true);assert.equal(h.audio.music.gain.value,.035);h.audio.duck(false);assert.equal(h.audio.music.gain.value,.16);
 h.audio.setSfx(false);const count=h.state.oscillators.length;h.audio.play('clear');assert.equal(h.state.oscillators.length,count);h.audio.setSfx(true);h.audio.play('clear');assert.equal(h.state.oscillators.length,count+3);
 h.audio.setMusic(false);assert.equal(h.intervals().length,0);h.audio.setMusic(true);assert.equal(h.intervals().length,1);h.audio.setEnabled(false);assert.equal(h.intervals().length,0);h.audio.setEnabled(true);assert.equal(h.intervals().length,1);h.audio.dispose();
});

test('hidden page cannot restart music from an async resume; later visible event restores one interval',async()=>{
 const h=harness(candidate,{resumeMode:'pending'});const pending=h.unlock();h.document.hidden=true;h.fire('document','visibilitychange');h.state.contexts[0].requests[0].resolve();await pending;assert.equal(h.intervals().length,0);
 h.document.hidden=false;h.fire('document','visibilitychange');h.fire('document','visibilitychange');assert.equal(h.intervals().length,1);h.audio.dispose();
});

test('a later iOS interruption resumes on a later gesture without duplicate interval',async()=>{
 const h=harness();await h.unlock();h.document.hidden=true;h.fire('document','visibilitychange');h.state.contexts[0].state='interrupted';h.document.hidden=false;h.fire('document','visibilitychange');assert.equal(h.intervals().length,0);
 await h.unlock();assert.deepEqual(h.state.resumeGestures,[true,true]);assert.equal(h.intervals().length,1);h.audio.dispose();
});

for(const contextState of ['suspended','interrupted'])test(`already-unlocked setEnabled(true) synchronously resumes ${contextState}`,async()=>{
 const h=harness();await h.unlock();h.audio.setEnabled(false);h.state.contexts[0].state=contextState;
 h.state.gesture=true;h.audio.setEnabled(true);h.state.gesture=false;
 assert.deepEqual(h.state.resumeGestures,[true,true]);await flush();assert.equal(h.intervals().length,1);
 h.audio.setEnabled(false);h.state.contexts[0].state=contextState;h.audio.setEnabled(true);
 assert.deepEqual(h.state.resumeGestures,[true,true,false]);await flush();assert.equal(h.intervals().length,1);h.audio.dispose();
});

function installGestureEffect(h){
 let cleanup;vm.runInNewContext(gestureEffect,{audio:h.audio,window:h.window,useEffect(fn){cleanup=fn();}});return cleanup;
}

for(const type of ['pointerdown','click','keydown'])test(`actual main effect synchronously unlocks trusted ${type} and remains available after rejection`,async()=>{
 const h=harness(candidate,{resumeMode:'reject'}),cleanup=installGestureEffect(h);
 // A fresh preference update alone is not a gesture and must remain silent.
 h.audio.setEnabled(false);h.audio.setEnabled(true);assert.equal(h.state.contexts[0].resumeCount,0);
 h.state.gesture=true;h.fire('window',type,{type,isTrusted:true,key:'Enter'});h.state.gesture=false;
 assert.deepEqual(h.state.resumeGestures,[true]);await flush();h.options.resumeMode='resolve';
 h.state.gesture=true;h.fire('window',type,{type,isTrusted:true,key:'Enter'});h.state.gesture=false;await flush();
 assert.deepEqual(h.state.resumeGestures,[true,true]);assert.equal(h.intervals().length,1);
 cleanup();h.audio.dispose();assert.equal(h.listenerCount(),0);
});

test('actual main effect ignores synthetic events, modifier-only keys and shortcut/repeat keydowns',async()=>{
 const h=harness(),cleanup=installGestureEffect(h);
 for(const type of ['pointerdown','click','keydown'])h.fire('window',type,{type,isTrusted:false,key:'Enter'});
 for(const key of ['Shift','Control','Alt','Meta','CapsLock','Fn'])h.fire('window','keydown',{type:'keydown',isTrusted:true,key});
 for(const flag of ['repeat','altKey','ctrlKey','metaKey'])h.fire('window','keydown',{type:'keydown',isTrusted:true,key:'Enter',[flag]:true});
 assert.equal(h.state.contexts[0].resumeCount,0);assert.equal(h.state.oscillators.length,0);assert.equal(h.state.timers.size,0);
 cleanup();h.audio.dispose();assert.equal(h.listenerCount(),0);
});

for(const option of [{noContext:true},{webkit:true},{failGainAt:2,closeMode:'reject'},{failGainAt:2,closeMode:'throw'}])test(`unavailable/fallback cleanup ${JSON.stringify(option)}`,async()=>{
 const h=harness(candidate,option);await h.unlock();h.audio.dispose();await flush();assert.equal(h.state.timers.size,0);
});

test('all eleven original scores have identical oscillator schedules and tempo',async()=>{
 for(const theme of ['towerlink','match','golf','carrom','darts','ludo','jackaroo','domino','pool','bowling','run']){
  const before=harness(original,{theme}),after=harness(candidate,{theme});await before.unlock();await after.unlock();
  for(let i=0;i<20;i++){before.tick();after.tick();}
  assert.deepEqual(after.spectrum(),before.spectrum(),theme);assert.deepEqual(after.intervals().map(t=>t.ms),before.intervals().map(t=>t.ms),theme);before.audio.dispose();after.audio.dispose();
 }
});

test('all original effect kinds/intensities retain exact oscillator spectra, envelopes and delays',async()=>{
 const kinds=['swap','click','select','invalid','error','water','clear','match','combo','cascade','special','shot','hit','bounce','throw','impact','rail','hole','win','victory','finish','home','bull','checkout','strike','spare','ready','start','countdown','dice','roll','card','deal','tile','place','move','pass','pocket','capture','queen','jump','boost','pickup','shield','slide','lane','gutter','crash','pin','pinfall','rolling','timeout','bust','foul','lose'];
 for(const kind of kinds)for(const intensity of [1,3,5]){
  const before=harness(original),after=harness();before.audio.setMusic(false);after.audio.setMusic(false);await before.unlock();await after.unlock();before.audio.play(kind,intensity);after.audio.play(kind,intensity);
  assert.deepEqual(after.spectrum(),before.spectrum(),kind+':'+intensity);before.audio.dispose();after.audio.dispose();
 }
});
