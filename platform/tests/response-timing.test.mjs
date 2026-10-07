import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import * as Run from '../arena/run/engine.mjs';
import {compactRoomSnapshot} from '../server/pvp/snapshot-transfer.mjs';
import {createRoomResponseTiming} from '../arena/shared/response-timing.mjs';

const path='/api/pvp/rooms/timing-room',auth={app_id:'timing-app',game_id:'run',external_user_id:'human'};
const clone=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
let instance=0;
function fixture(){
 const state=Run.createState('12'.repeat(32),1000,{players:[{key:'human',seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]});
 return{id:'timing-room',game_id:'run',me:'human',version:2,server_now:1000,game:Run.view(state,'human')};
}
const full=()=>clone(compactRoomSnapshot(fixture(),undefined,{runKey:'full',session:auth}));
function response(value,clock,{headersAt=20,bodyAt=30,status=200,jsonError}={}){
 clock.now=headersAt;
 return{ok:status>=200&&status<300,status,headers:new Headers(),json:async()=>{clock.now=bodyAt;if(jsonError)throw jsonError;return value;}};
}
async function withClient(fn){
 const oldFetch=globalThis.fetch,descriptors=Object.fromEntries(['performance','crypto'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)])),clock={now:10};
 Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>clock.now}});
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto});
 const client=await import(`../arena/shared/client.mjs?response-timing=${++instance}`);client.authorize('timing-a');
 try{await fn(client,clock);}finally{client.authorize('');globalThis.fetch=oldFetch;for(const[name,descriptor]of Object.entries(descriptors)){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
}
const timing=(start,headers,body,restored)=>({requestStartedAtMs:start,headersObservedAtMs:headers,bodyParsedAtMs:body,restoredAtMs:restored});

test('successful full GET binds only the restored room and includes asynchronous WebCrypto completion',async()=>withClient(async(c,clock)=>{
 const raw=full(),wire=JSON.stringify(raw),entered=deferred(),release=deferred();let calls=0;
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:async(...args)=>{entered.resolve();await release.promise;clock.now=80;return webcrypto.subtle.digest(...args);}}}});
 globalThis.fetch=async()=>{calls++;return response(raw,clock);};
 const pending=c.api(path);await entered.promise;
 assert.equal(c.readRoomResponseTiming(raw),undefined);clock.now=65;release.resolve();
 const room=await pending,observed=c.readRoomResponseTiming(room);
 assert.notEqual(room,raw);assert.deepEqual(observed,timing(10,20,30,80));assert.ok(Object.isFrozen(observed));assert.equal(calls,1);
 assert.equal(c.readRoomResponseTiming(raw),undefined);assert.equal(c.readRoomResponseTiming(room.game),undefined);assert.equal(c.readRoomResponseTiming({...room}),undefined);
 assert.equal(JSON.stringify(room),wire);assert.equal(JSON.stringify(raw),wire);assert.deepEqual(Object.getOwnPropertySymbols(room),[]);assert.deepEqual(Object.getOwnPropertySymbols(room.game),[]);
 assert.throws(()=>observed.restoredAtMs=0,TypeError);
}));

test('scene-ready and direct or wrapped action POST mark their returned room without adding requests or changing receipts',async()=>withClient(async(c,clock)=>{
 const calls=[];
 for(const [suffix,wrapped]of [['scene-ready',false],['action',false],['action',true]]){
  const room=fixture(),value=wrapped?{room,action_receipt:{request_id:'unchanged',accepted_tick:1}}:{...room,action_receipt:{request_id:'unchanged'}},before=JSON.stringify(value);
  clock.now=10;globalThis.fetch=async(url,options)=>{calls.push({url,options});return response(value,clock);};
  const result=await c.api(path+'/'+suffix,{request_id:'unchanged',action:{type:'jump'}}),returned=wrapped?result.room:result;
  assert.equal(result,value);assert.deepEqual(c.readRoomResponseTiming(returned),timing(10,20,30,30));assert.equal(JSON.stringify(result),before);
  if(wrapped)assert.equal(c.readRoomResponseTiming(result),undefined);
  assert.equal(calls.at(-1).options.method,'POST');assert.equal(calls.at(-1).options.headers['X-Oasis-Known-Run-Game'],undefined);
 }
 assert.equal(calls.length,3);
}));

test('two responses sharing an immutable game retain separate room observations and unchanged transfer hashes',async()=>withClient(async(c,clock)=>{
 const firstRaw=full();globalThis.fetch=async()=>response(firstRaw,clock);
 const first=await c.api(path),firstTiming=c.readRoomResponseTiming(first),key=first.run_game_transfer.key;
 const next=fixture();next.server_now=4000;const nextRaw=clone(compactRoomSnapshot(next,undefined,{runKey:key,session:auth}));assert.equal(nextRaw.run_game_transfer.omitted,true);
 clock.now=100;globalThis.fetch=async()=>response(nextRaw,clock,{headersAt:110,bodyAt:130});
 const second=await c.api(path);
 assert.equal(second.game,first.game);assert.notEqual(second,first);assert.equal(second.run_game_transfer.key,key);assert.equal(second.server_now,4000);
 assert.equal(c.readRoomResponseTiming(first),firstTiming);assert.deepEqual(firstTiming,timing(10,20,30,30));assert.deepEqual(c.readRoomResponseTiming(second),timing(100,110,130,130));
 assert.equal(c.readRoomResponseTiming(second.game),undefined);assert.equal(c.readRoomResponseTiming(nextRaw),undefined);
}));

test('same-token authorize preserves observations; token changes and logout clear all previous objects',async()=>withClient(async(c,clock)=>{
 globalThis.fetch=async()=>response(fixture(),clock);const first=await c.api(path),observed=c.readRoomResponseTiming(first);
 c.authorize('timing-a');assert.equal(c.readRoomResponseTiming(first),observed);
 c.authorize('timing-b');assert.equal(c.readRoomResponseTiming(first),undefined);
 clock.now=100;globalThis.fetch=async()=>response(fixture(),clock,{headersAt:110,bodyAt:120});const second=await c.api(path);assert.ok(c.readRoomResponseTiming(second));
 c.authorize('');assert.equal(c.readRoomResponseTiming(second),undefined);c.authorize('timing-a');assert.equal(c.readRoomResponseTiming(first),undefined);
}));

test('same-token authorization during WebCrypto keeps the one current response valid',async()=>withClient(async(c,clock)=>{
 const entered=deferred(),release=deferred();let calls=0;
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:async(...args)=>{entered.resolve();await release.promise;clock.now=80;return webcrypto.subtle.digest(...args);}}}});
 globalThis.fetch=async()=>{calls++;return response(full(),clock);};const pending=c.api(path);await entered.promise;c.authorize('timing-a');release.resolve();
 assert.deepEqual(c.readRoomResponseTiming(await pending),timing(10,20,30,80));assert.equal(calls,1);
}));

for(const stage of ['headers','body','restore'])test(`identity changes during ${stage} discard old response without timing or a replay`,async()=>withClient(async(c,clock)=>{
 const gate=deferred(),entered=deferred(),raw=full();let calls=0;
 if(stage==='restore')Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:async(...args)=>{entered.resolve();await gate.promise;clock.now=90;return webcrypto.subtle.digest(...args);}}}});
 globalThis.fetch=async()=>{
  calls++;if(stage==='headers'){entered.resolve();await gate.promise;}
  const result=response(raw,clock);
  if(stage==='body')result.json=async()=>{entered.resolve();await gate.promise;clock.now=70;return raw;};
  return result;
 };
 const pending=c.api(path);await entered.promise;c.authorize('timing-b');c.authorize('timing-a');gate.resolve();
 await assert.rejects(pending,{code:'SESSION_CHANGED'});assert.equal(calls,1);assert.equal(c.readRoomResponseTiming(raw),undefined);
}));

test('GET recovery timing starts at its final request and includes only that response restoration',async()=>withClient(async(c,clock)=>{
 const bad=full(),good=full(),calls=[];bad.run_game_transfer.key='f'.repeat(64);let digests=0;
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:async(...args)=>{clock.now=++digests===1?60:120;return webcrypto.subtle.digest(...args);}}}});
 globalThis.fetch=async(url,options)=>{calls.push(options);return calls.length===1?response(bad,clock):response(good,clock,{headersAt:75,bodyAt:80});};
 const room=await c.api(path);
 assert.deepEqual(c.readRoomResponseTiming(room),timing(60,75,80,120));assert.equal(calls.length,2);assert.equal(calls[1].headers['X-Oasis-Known-Run-Game'],'full');
 assert.equal(c.readRoomResponseTiming(bad),undefined);assert.equal(c.readRoomResponseTiming(good),undefined);assert.equal(room.run_game_transfer.key,good.run_game_transfer.key);
}));

test('a second invalid GET stops at two attempts; neither failed body is marked',async()=>withClient(async(c,clock)=>{
 const bodies=[];let calls=0;
 globalThis.fetch=async()=>{calls++;const body=full();body.run_game_transfer={};bodies.push(body);return response(body,clock,{headersAt:10+calls*10,bodyAt:15+calls*10});};
 await assert.rejects(c.api(path),{code:'SNAPSHOT_REFRESH_REQUIRED'});assert.equal(calls,2);for(const body of bodies)assert.equal(c.readRoomResponseTiming(body),undefined);
}));

test('WebCrypto failure uses final unnegotiated full GET timing without inventing network or one-way durations',async()=>withClient(async(c,clock)=>{
 const calls=[];Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:async()=>{clock.now=60;throw Error('unavailable');}}}});
 globalThis.fetch=async(url,options)=>{calls.push(options);return calls.length===1?response(full(),clock):response(fixture(),clock,{headersAt:90,bodyAt:100});};
 const room=await c.api(path);assert.deepEqual(c.readRoomResponseTiming(room),timing(60,90,100,100));assert.equal(calls.length,2);assert.equal(calls[1].headers['X-Oasis-Known-Run-Game'],undefined);
}));

for(const method of ['GET','POST'])test(`${method} network, JSON and HTTP errors remain failures without timing or retries`,async()=>withClient(async(c,clock)=>{
 for(const kind of ['network','json','http']){
  let calls=0;const raw=fixture(),expected=Error('network unavailable');raw.error={code:'ROOM_BUSY',message:'Busy'};
  clock.now=10;globalThis.fetch=async()=>{calls++;if(kind==='network')throw expected;return response(raw,clock,{status:kind==='http'?409:200,jsonError:kind==='json'?Error('truncated'):undefined});};
  const pending=c.api(method==='GET'?path:path+'/action',method==='GET'?undefined:{seq:1,action:{type:'jump'}});
  if(kind==='network')await assert.rejects(pending,error=>error===expected);
  else if(kind==='json')await assert.rejects(pending,/Connection interrupted/);
  else await assert.rejects(pending,{code:'ROOM_BUSY',status:409});
  assert.equal(calls,1);assert.equal(c.readRoomResponseTiming(raw),undefined);
 }
}));

test('an obsolete action POST response is not marked and its mutation is never replayed',async()=>withClient(async(c,clock)=>{
 const gate=deferred(),raw={room:fixture(),action_receipt:{request_id:'already-accepted'}};let calls=0;
 globalThis.fetch=async()=>{calls++;await gate.promise;return response(raw,clock);};const pending=c.api(path+'/action',{seq:1,action:{type:'jump'}});
 c.authorize('timing-b');gate.resolve();await assert.rejects(pending,{code:'SESSION_CHANGED'});assert.equal(calls,1);assert.equal(c.readRoomResponseTiming(raw.room),undefined);
}));

for(const digestFails of [false,true])test(`abort during restore ${digestFails?'with a digest failure':'after successful digest'} cannot mark or retry`,async()=>withClient(async(c,clock)=>{
 const controller=new AbortController(),entered=deferred(),release=deferred(),raw=full();let calls=0;
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:async(...args)=>{entered.resolve();await release.promise;clock.now=90;if(digestFails)throw Error('digest unavailable');return webcrypto.subtle.digest(...args);}}}});
 globalThis.fetch=async()=>{calls++;return response(raw,clock);};const pending=c.api(path,undefined,{signal:controller.signal});await entered.promise;
 controller.abort();release.resolve();await assert.rejects(pending,{name:'AbortError'});assert.equal(calls,1);assert.equal(c.readRoomResponseTiming(raw),undefined);
}));

test('abort after parsing stops restoration and preserves the original abort reason without timing',async()=>withClient(async(c,clock)=>{
 const controller=new AbortController(),raw=fixture(),reason=Error('cancelled locally');let calls=0;
 globalThis.fetch=async()=>{calls++;const result=response(raw,clock);result.json=async()=>{clock.now=30;controller.abort(reason);return raw;};return result;};
 await assert.rejects(c.api(path,undefined,{signal:controller.signal}),error=>error===reason);assert.equal(calls,1);assert.equal(c.readRoomResponseTiming(raw),undefined);
}));

test('unrelated session/non-Run data and object copies do not gain room timing',async()=>withClient(async(c,clock)=>{
 for(const raw of [{game_id:'run',active_room_id:'timing-room'},{...fixture(),game_id:'match'},{...fixture(),game:{gameId:'run',me:'somebody-else'}}]){
  clock.now=10;globalThis.fetch=async()=>response(raw,clock);const result=await c.api('/api/arena/session');assert.equal(c.readRoomResponseTiming(result),undefined);
 }
 for(const value of [null,undefined,0,'room',{}])assert.equal(c.readRoomResponseTiming(value),undefined);
}));

test('timing store copies only finite monotonic local observations and clears its WeakMap',()=>{
 const store=createRoomResponseTiming(),room=fixture(),input={...timing(10,20,30,40),serverRtt:999,oneWayMs:123};store.record(room,input);input.restoredAtMs=900;
 assert.deepEqual(store.read(room),timing(10,20,30,40));assert.equal(store.read({...room}),undefined);
 for(const bad of [timing(20,10,30,40),timing(0,1,NaN,3),timing(0,1,2,Infinity),timing(-1,1,2,3)]){const other=fixture();store.record(other,bad);assert.equal(store.read(other),undefined);}
 store.clear();assert.equal(store.read(room),undefined);
});
