import test from 'node:test';
import assert from 'node:assert/strict';
import {ROOM_POLL_ABORT,startRoomPolling} from '../arena/shared/room-poller.mjs';

function fixture(options={}){
 let time=0,id=0;const timers=new Map(),requests=[],rooms=[],errors=[];
 const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
 const stop=startRoomPolling({initialDelay:0,interval:()=>150,now:()=>time,
  setTimer:(fn,ms)=>{timers.set(++id,{fn,at:time+ms});return id;},clearTimer:id=>timers.delete(id),
  read:signal=>new Promise((resolve,reject)=>{requests.push({at:time,resolve,reject,signal});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}),
  onRoom:r=>rooms.push(r),onError:e=>errors.push(e),...options});
 const advance=async ms=>{const end=time+ms;while(true){const next=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;time=next[1].at;timers.delete(next[0]);next[1].fn();await flush();}time=end;await flush();};
 return{advance,flush,stop,requests,rooms,errors,timers};
}

test('normal network latency does not add another full interval after each response',async()=>{
 const f=fixture();await f.advance(0);assert.equal(f.requests.length,1);
 await f.advance(100);f.requests[0].resolve({version:1});await f.flush();
 await f.advance(49);assert.equal(f.requests.length,1);
 await f.advance(1);assert.equal(f.requests[1].at,150);assert.deepEqual(f.rooms,[{version:1}]);f.stop();
});

test('an early-ready Run client receives the shared start with 1.2s left at 150ms RTT',async()=>{
 const f=fixture();await f.advance(0);
 // The first read began before the final player's ACK at t=1, so its reply is stale.
 const serverArmAt=1,sharedStartAt=serverArmAt+1500;
 await f.advance(149);f.requests[0].resolve({version:1,starts_at:null});await f.flush();
 await f.advance(1);assert.equal(f.requests[1].at,150);
 await f.advance(150);f.requests[1].resolve({version:2,starts_at:sharedStartAt});await f.flush();
 assert.equal(f.rooms.at(-1).starts_at,sharedStartAt);
 assert.ok(sharedStartAt-300>=1200);
 f.stop();
});

test('slow reads remain serial with no catch-up burst',async()=>{
 const f=fixture();await f.advance(0);await f.advance(500);assert.equal(f.requests.length,1);
 f.requests[0].resolve({version:1});await f.flush();await f.advance(0);
 assert.equal(f.requests.length,2);assert.equal(f.requests[1].at,500);
 await f.advance(500);assert.equal(f.requests.length,2);f.stop();
});

test('stop aborts outstanding read and never applies a late result',async()=>{
 const f=fixture();await f.advance(0);f.stop();f.requests[0].resolve({version:99});await f.flush();await f.advance(10000);
 assert.equal(f.requests[0].signal.aborted,true);assert.equal(f.requests.length,1);assert.deepEqual(f.rooms,[]);assert.deepEqual(f.errors,[]);assert.equal(f.timers.size,0);
 assert.equal(f.requests[0].signal.reason.name,'AbortError');assert.equal(f.requests[0].signal.reason.message,ROOM_POLL_ABORT.stopped);
});

test('errors keep a full retry delay and honor rate-limit Retry-After',async()=>{
 const f=fixture();await f.advance(0);await f.advance(100);f.requests[0].reject(Object.assign(new Error('limited'),{retryAfterMs:2000}));await f.flush();
 await f.advance(1999);assert.equal(f.requests.length,1);await f.advance(1);assert.equal(f.requests[1].at,2100);assert.equal(f.errors.length,1);f.stop();
});

test('timeout releases the serial read and does not retry immediately',async()=>{
 const f=fixture({timeoutMs:800});await f.advance(800);assert.equal(f.requests[0].signal.aborted,true);assert.equal(f.errors.length,1);
 assert.equal(f.errors[0],f.requests[0].signal.reason);assert.equal(f.errors[0].name,'TimeoutError');assert.equal(f.errors[0].message,ROOM_POLL_ABORT.timeout);
 await f.advance(149);assert.equal(f.requests.length,1);await f.advance(1);assert.equal(f.requests[1].at,950);f.stop();
});

test('hidden pages stop polling and resume immediately without applying an old response',async()=>{
 const visibility=new EventTarget();visibility.hidden=false;
 const f=fixture({visibilityTarget:visibility});await f.advance(0);
 visibility.hidden=true;visibility.dispatchEvent(new Event('visibilitychange'));await f.flush();
 assert.equal(f.requests[0].signal.aborted,true);await f.advance(30000);assert.equal(f.requests.length,1);assert.equal(f.errors.length,0);
 assert.equal(f.requests[0].signal.reason.name,'AbortError');assert.equal(f.requests[0].signal.reason.message,ROOM_POLL_ABORT.background);
 visibility.hidden=false;visibility.dispatchEvent(new Event('visibilitychange'));await f.advance(0);assert.equal(f.requests.length,2);
 f.requests[1].resolve({version:2});await f.flush();assert.deepEqual(f.rooms,[{version:2}]);f.stop();assert.equal(f.timers.size,0);
});

test('rapid background/foreground transitions do not overlap a read that ignores abort',async()=>{
 const visibility=new EventTarget();visibility.hidden=false;const pending=[];
 const f=fixture({visibilityTarget:visibility,read:signal=>new Promise(resolve=>pending.push({signal,resolve}))});await f.advance(0);
 visibility.hidden=true;visibility.dispatchEvent(new Event('visibilitychange'));visibility.hidden=false;visibility.dispatchEvent(new Event('visibilitychange'));
 await f.advance(100);assert.equal(pending.length,1);pending[0].resolve({version:1});await f.flush();await f.advance(0);assert.equal(pending.length,2);assert.deepEqual(f.rooms,[]);
 pending[1].resolve({version:2});await f.flush();assert.deepEqual(f.rooms,[{version:2}]);f.stop();
});

test('foreground resume cannot bypass a server Retry-After deadline',async()=>{
 const visibility=new EventTarget();visibility.hidden=false;const f=fixture({visibilityTarget:visibility});await f.advance(0);f.requests[0].reject(Object.assign(new Error('limited'),{retryAfterMs:2000}));await f.flush();
 visibility.hidden=true;visibility.dispatchEvent(new Event('visibilitychange'));await f.advance(500);visibility.hidden=false;visibility.dispatchEvent(new Event('visibilitychange'));
 await f.advance(1499);assert.equal(f.requests.length,1);await f.advance(1);assert.equal(f.requests.length,2);f.stop();
});
