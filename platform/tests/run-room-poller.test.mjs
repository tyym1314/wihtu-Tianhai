import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {startRunRoomPolling,readRunRoomOnce} from '../arena/shared/run-room-poller.mjs';
import {startRoomPolling,ROOM_POLL_ABORT} from '../arena/shared/room-poller.mjs';
import * as Engine from '../arena/run/engine.mjs';
import {createRunTimeline} from '../arena/run/timeline.mjs';

const room=version=>({id:'room-run',me:'player-one',game_id:'run',version});
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(t,{cooperate=true,...options}={}){
 let time=0,id=0,active=0,maxActive=0;const timers=new Map(),requests=[],rooms=[],errors=[];
 const config={roomId:'room-run',playerKey:'player-one',rateScope:'test-run-player',initialDelay:0,now:()=>time,
  setTimer:(fn,ms)=>{const key=++id;timers.set(key,{fn,at:time+ms});return key;},clearTimer:key=>timers.delete(key),
  onRoom:value=>rooms.push({at:time,value}),onError:value=>errors.push({at:time,value}),
  read:signal=>new Promise((resolve,reject)=>{
   active++;maxActive=Math.max(maxActive,active);let done=false;
   const finish=fn=>value=>{if(done)return;done=true;active--;fn(value);};
   const request={at:time,signal,resolve:finish(resolve),reject:finish(reject)};requests.push(request);
   if(cooperate)signal.addEventListener('abort',()=>request.reject(signal.reason),{once:true});
  }),...options};
 const stop=startRunRoomPolling(config),stops=[stop];
 const advance=async ms=>{const end=time+ms;let iterations=0;while(true){assert.ok(++iterations<10000,'timer storm');const next=[...timers.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);time=next[1].at;next[1].fn();await flush();}time=end;await flush();};
 const dispose=async()=>{for(const stop of stops)stop();for(const r of requests)r.resolve(room(999));await flush();};
 t.after(dispose);
 return {advance,requests,rooms,errors,stop,dispose,timers,config,restart:options=>{const end=startRunRoomPolling({...config,...options});stops.push(end);return end;},get maxActive(){return maxActive;}};
}

test('normal Run latency retains 150ms start cadence without extra GETs',async t=>{
 const f=fixture(t);await f.advance(0);
 for(let i=0;i<5;i++){await f.advance(100);f.requests[i].resolve(room(i+1));await flush();await f.advance(50);}
 assert.deepEqual(f.requests.map(r=>r.at),[0,150,300,450,600,750]);assert.equal(f.maxActive,1);
});
test('one slow read gets one spare GET, whose success becomes the normal chain',async t=>{
 const f=fixture(t);await f.advance(349);assert.equal(f.requests.length,1);await f.advance(1);assert.deepEqual(f.requests.map(r=>r.at),[0,350]);
 await f.advance(50);f.requests[1].resolve(room(2));await flush();await f.advance(100);assert.equal(f.requests[2].at,500);
 await f.advance(50);f.requests[2].resolve(room(3));await flush();await f.advance(100);assert.equal(f.requests[3].at,650);
 f.requests[0].resolve(room(1));await flush();assert.deepEqual(f.rooms.map(r=>r.value.version),[2,3]);assert.equal(f.maxActive,2);
});
test('Tower Link reads at 250ms and a slow GET does not block the newer scoped snapshot',async t=>{
 const tower=version=>({...room(version),game_id:'towerlink',server_now:version*250});
 const f=fixture(t,{gameId:'towerlink',interval:()=>250});
 await f.advance(350);assert.deepEqual(f.requests.map(r=>r.at),[0,350]);
 f.requests[1].resolve(tower(2));await flush();await f.advance(250);
 assert.equal(f.requests[2].at,600);f.requests[2].resolve(tower(3));await flush();
 f.requests[0].resolve(tower(1));await flush();assert.deepEqual(f.rooms.map(r=>r.value.version),[2,3]);
 assert.equal(f.maxActive,2);
});
test('Tower Link never accepts a Run response and still accepts its next Tower snapshot',async t=>{
 const f=fixture(t,{gameId:'towerlink',interval:()=>250});await f.advance(0);
 f.requests[0].resolve(room(999));await flush();assert.equal(f.rooms.length,0);
 assert.equal(f.errors[0].value.code,'TOWER_POLL_SCOPE_MISMATCH');await f.advance(250);
 f.requests[1].resolve({...room(2),game_id:'towerlink'});await flush();assert.equal(f.rooms[0].value.version,2);
});
test('two slow or abort-ignoring reads never accumulate more requests',async t=>{
 const f=fixture(t,{cooperate:false,timeoutMs:800});await f.advance(10000);
 assert.equal(f.requests.length,2);assert.equal(f.maxActive,2);assert.ok(f.requests.every(r=>r.signal.aborted));
 f.requests[0].resolve(room(1));await flush();assert.equal(f.rooms.length,0);assert.equal(f.errors[0].value.name,'TimeoutError');
 await f.advance(150);assert.equal(f.requests.length,3);assert.equal(f.maxActive,2);
});
test('timeout is reported and holds a full retry interval',async t=>{
 const f=fixture(t,{timeoutMs:500});await f.advance(500);
 assert.equal(f.errors[0].value.message,ROOM_POLL_ABORT.timeout);assert.equal(f.requests.length,2);
 await f.advance(149);assert.equal(f.requests.length,2);await f.advance(1);assert.equal(f.requests.length,2);
 // The second outstanding GET may be hedged only at its own 350ms boundary.
 await f.advance(50);assert.equal(f.requests.length,3);assert.equal(f.requests[2].at,700);
});
test('a late ordinary failure cannot overwrite a newer successful connection state',async t=>{
 const f=fixture(t);await f.advance(350);await f.advance(50);f.requests[1].resolve(room(2));await flush();
 f.requests[0].reject(new Error('old network failure'));await flush();assert.equal(f.errors.length,0);await f.advance(100);assert.equal(f.requests[2].at,500);
});
for(const status of [401,403,429])test(`late ${status} is not hidden by a newer success`,async t=>{
 const f=fixture(t);await f.advance(350);f.requests[1].resolve(room(2));await flush();
 f.requests[0].reject(Object.assign(new Error('mandatory'),{status,retryAfterMs:1000}));await flush();assert.equal(f.errors[0].value.status,status);
 await f.advance(999);assert.equal(f.requests.length,2);await f.advance(1);assert.equal(f.requests[2].at,1350);
});
test('Retry-After without an HTTP status suppresses normal dispatch and hedge',async t=>{
 const f=fixture(t);await f.advance(350);f.requests[0].reject(Object.assign(new Error('limited'),{retryAfterMs:2000}));await flush();
 await f.advance(50);f.requests[1].resolve(room(2));await flush();await f.advance(1949);assert.equal(f.requests.length,2);await f.advance(1);assert.equal(f.requests[2].at,2350);
});
test('ordinary errors back off and cannot form an immediate hedge storm',async t=>{
 const f=fixture(t);await f.advance(350);f.requests[0].reject(new Error('network'));f.requests[1].reject(new Error('network'));await flush();
 await f.advance(149);assert.equal(f.requests.length,2);await f.advance(1);assert.equal(f.requests[2].at,500);await f.advance(349);assert.equal(f.requests.length,3);
});
test('old versions and versions overtaken by POST do not redeliver',async t=>{
 let liveVersion=1;const f=fixture(t,{readVersion:()=>liveVersion});await f.advance(0);f.requests[0].resolve(room(1));await flush();assert.equal(f.rooms.length,0);
 await f.advance(150);f.requests[1].resolve(room(2));await flush();assert.equal(f.rooms.length,1);
 await f.advance(150);liveVersion=4;f.requests[2].resolve(room(3));await flush();assert.equal(f.rooms.length,1);
 await f.advance(150);f.requests[3].resolve(room(5));await flush();assert.deepEqual(f.rooms.map(r=>r.value.version),[2,5]);
});
test('fresh same-version presence is delivered, but late equal-version hedge cannot undo it',async t=>{
 const f=fixture(t);await f.advance(350);
 f.requests[1].resolve({...room(2),server_now:200,players:[{online:true}]});await flush();
 f.requests[0].resolve({...room(2),server_now:100,players:[{online:false}]});await flush();assert.equal(f.rooms.length,1);
 await f.advance(150);f.requests[2].resolve({...room(2),server_now:250,players:[{online:false}]});await flush();
 assert.equal(f.rooms.length,2);assert.equal(f.rooms[1].value.players[0].online,false);
 await f.advance(150);f.requests[3].resolve({...room(2),server_now:240,players:[{online:true}]});await flush();assert.equal(f.rooms.length,2);
});
test('equal-version presence older than a live POST room is discarded, higher version still wins',async t=>{
 let live={...room(2),server_now:300};const f=fixture(t,{readRoom:()=>live});await f.advance(350);
 f.requests[1].resolve({...room(2),server_now:290});await flush();assert.equal(f.rooms.length,0);
 // A request started earlier can observe a later commit. Version outranks its sequence.
 f.requests[0].resolve({...room(3),server_now:310});await flush();assert.equal(f.rooms[0].value.version,3);
});
test('duplicate and presence-only responses never renew the actual timeline lease',async t=>{
 const s=Engine.createState('0'.repeat(64),1000,{ruleVersion:Engine.PRACTICE_RULE_VERSION,startPolicy:Engine.RUN_SCENE_READY_POLICY,players:[{key:'player-one',seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]});Engine.armStart(s,1000);Engine.tick(s,s.startedAt+Math.ceil(100*1000/60));
 const game=Engine.view(s,'player-one'),timeline=createRunTimeline();let delivered=0;
 const f=fixture(t,{onRoom:value=>{delivered++;timeline.receive(value.game,value.me,{roomId:value.id,roomVersion:value.version,receivedAtMs:value.server_now});}});
 await f.advance(0);f.requests[0].resolve({...room(1),server_now:0,game});await flush();assert.equal(timeline.sample(0).mode,'project');
 for(let i=1;i<=4;i++){await f.advance(150);f.requests[i].resolve({...room(1),server_now:i*150,game,players:[{online:i%2===0}]});await flush();}
 assert.equal(delivered,5);const expired=timeline.sample(651);assert.equal(expired.mode,'hold');assert.equal(expired.reason,'projection-expired');
});
for(const bad of [{version:NaN},{version:-1},{version:1.5},{version:999,id:'other-room'},{version:999,me:'other-player'},{version:999,game_id:'golf'}])test(`invalid scope/version cannot poison delivery: ${JSON.stringify(bad)}`,async t=>{
 const f=fixture(t);await f.advance(0);f.requests[0].resolve({...room(999),...bad});await flush();assert.equal(f.rooms.length,0);assert.equal(f.errors[0].value.code,'RUN_POLL_SCOPE_MISMATCH');
 await f.advance(150);f.requests[1].resolve(room(1));await flush();assert.equal(f.rooms[0].value.version,1);
});
test('background cancels both generations; foreground honors slots and ignores late results',async t=>{
 const visibility=new EventTarget();visibility.hidden=false;const f=fixture(t,{cooperate:false,visibilityTarget:visibility});
 await f.advance(350);visibility.hidden=true;visibility.dispatchEvent(new Event('visibilitychange'));assert.ok(f.requests.every(r=>r.signal.reason.message===ROOM_POLL_ABORT.background));
 await f.advance(1000);visibility.hidden=false;visibility.dispatchEvent(new Event('visibilitychange'));await f.advance(1000);assert.equal(f.requests.length,2);
 f.requests[0].resolve(room(99));await flush();await f.advance(0);assert.equal(f.requests.length,3);assert.equal(f.rooms.length,0);assert.equal(f.maxActive,2);
 f.requests[2].resolve(room(1));await flush();assert.equal(f.rooms[0].value.version,1);assert.equal(f.errors.length,0);
});
test('foreground cannot bypass Retry-After',async t=>{
 const visibility=new EventTarget();visibility.hidden=false;const f=fixture(t,{visibilityTarget:visibility});await f.advance(0);
 f.requests[0].reject(Object.assign(new Error('rate'),{status:429,retryAfterMs:2000}));await flush();visibility.hidden=true;visibility.dispatchEvent(new Event('visibilitychange'));await f.advance(500);visibility.hidden=false;visibility.dispatchEvent(new Event('visibilitychange'));
 await f.advance(1499);assert.equal(f.requests.length,1);await f.advance(1);assert.equal(f.requests[1].at,2000);
});
test('same App/player reauthorization or room change cannot bypass Retry-After',async t=>{
 const f=fixture(t,{rateScope:'app-one/player-one'});await f.advance(0);f.requests[0].reject(Object.assign(new Error('rate'),{status:429,retryAfterMs:2000}));await flush();f.stop();
 f.restart({roomId:'new-room',initialDelay:250});await f.advance(1999);assert.equal(f.requests.length,1);await f.advance(1);assert.equal(f.requests[1].at,2000);
});
test('different App/player quota is independent; stale old identity errors cannot poison it',async t=>{
 const f=fixture(t,{cooperate:false,rateScope:'app-one/player-one'});await f.advance(0);f.stop();
 f.restart({rateScope:'app-two/player-two',playerKey:'player-two'});await f.advance(0);assert.equal(f.requests.length,2);
 f.requests[0].reject(Object.assign(new Error('stale rate'),{status:429,retryAfterMs:60000}));await flush();assert.equal(f.errors.length,0);
 f.requests[1].resolve({...room(1),me:'player-two'});await flush();await f.advance(150);assert.equal(f.requests.length,3);
});
test('a recorded first-owner quota does not delay a different real identity',async t=>{
 const f=fixture(t,{rateScope:'app-one/player-one'});await f.advance(0);f.requests[0].reject(Object.assign(new Error('rate'),{status:429,retryAfterMs:2000}));await flush();f.stop();
 f.restart({rateScope:'app-two/player-two',playerKey:'player-two'});await f.advance(0);assert.equal(f.requests.length,2);assert.equal(f.requests[1].at,0);
});
test('bounded scope overflow retains deadlines conservatively and expires',async t=>{
 const f=fixture(t,{rateScope:'identity-0'});let end=f.stop;
 for(let i=0;i<129;i++){
  if(i)end=f.restart({rateScope:`identity-${i}`});await f.advance(0);assert.equal(f.requests.length,i+1);
  f.requests[i].reject(Object.assign(new Error('rate'),{status:429,retryAfterMs:2000}));await flush();end();
 }
 f.restart({rateScope:'identity-129'});await f.advance(1999);assert.equal(f.requests.length,129);await f.advance(1);assert.equal(f.requests.length,130);
});
test('one-off recovery waits for stopped reads to release a physical slot',async t=>{
 const f=fixture(t,{cooperate:false});await f.advance(350);f.stop();
 const recovery=readRunRoomOnce({...f.config,rateScope:'new-identity'});await f.advance(1000);assert.equal(f.requests.length,2);
 f.requests[0].resolve(room(99));await flush();await f.advance(150);assert.equal(f.requests.length,3);assert.equal(f.rooms.length,0);
 f.requests[2].resolve(room(1));assert.equal((await recovery).version,1);assert.equal(f.maxActive,2);
});
test('one-off reads and restarted polls share the same 150ms dispatch floor',async t=>{
 const f=fixture(t);await f.advance(0);f.stop();await flush();
 const recovery=readRunRoomOnce(f.config);await f.advance(149);assert.equal(f.requests.length,1);await f.advance(1);assert.equal(f.requests[1].at,150);
 f.requests[1].resolve(room(1));await recovery;f.restart({initialDelay:0});await f.advance(149);assert.equal(f.requests.length,2);await f.advance(1);assert.equal(f.requests[2].at,300);
});
test('one-off recovery honors shared Retry-After and writes its own quota back to polling',async t=>{
 const f=fixture(t);await f.advance(0);f.requests[0].reject(Object.assign(new Error('rate'),{status:429,retryAfterMs:1000}));await flush();f.stop();
 const recovery=readRunRoomOnce(f.config),failure=assert.rejects(recovery,{status:429});await f.advance(999);assert.equal(f.requests.length,1);await f.advance(1);assert.equal(f.requests[1].at,1000);
 f.requests[1].reject(Object.assign(new Error('rate again'),{status:429,retryAfterMs:2000}));await failure;f.restart();await f.advance(1999);assert.equal(f.requests.length,2);await f.advance(1);assert.equal(f.requests[2].at,3000);
});
test('cancelled queued recovery creates no read and consumes no slot or quota',async t=>{
 const f=fixture(t);await f.advance(0);f.stop();await flush();const controller=new AbortController();
 const recovery=readRunRoomOnce({...f.config,signal:controller.signal}),failure=assert.rejects(recovery,{name:'AbortError'});controller.abort(new DOMException('OASIS_ROOM_POLL_STOPPED','AbortError'));await failure;
 await f.advance(150);assert.equal(f.requests.length,1);const next=readRunRoomOnce(f.config);await flush();assert.equal(f.requests[1].at,150);f.requests[1].resolve(room(1));await next;
});
test('identity is rechecked after slot/Retry-After wait and before fetching with a new token',async t=>{
 const f=fixture(t);await f.advance(0);f.stop();await flush();let current=true;
 const recovery=readRunRoomOnce({...f.config,isCurrent:()=>current}),failure=assert.rejects(recovery,{code:'SESSION_CHANGED'});current=false;await f.advance(150);await failure;assert.equal(f.requests.length,1);
});
test('cancelled active recovery retains its physical slot until an abort-ignoring read settles',async t=>{
 const f=fixture(t,{cooperate:false});f.stop();const controller=new AbortController();
 const recovery=readRunRoomOnce({...f.config,signal:controller.signal}),failure=assert.rejects(recovery,{name:'AbortError'});await flush();assert.equal(f.requests.length,1);controller.abort(new DOMException('OASIS_ROOM_POLL_STOPPED','AbortError'));
 f.restart();await f.advance(500);assert.equal(f.requests.length,2);assert.equal(f.maxActive,2);
 f.requests[0].resolve(room(99));await failure;assert.equal(f.rooms.length,0);
});
test('one-off recovery pauses before dispatch when hidden and cancels if backgrounded in flight',async t=>{
 const visibility=new EventTarget();visibility.hidden=true;const f=fixture(t,{visibilityTarget:visibility});f.stop();
 const recovery=readRunRoomOnce(f.config),failure=assert.rejects(recovery,{name:'AbortError',message:ROOM_POLL_ABORT.background});await f.advance(1000);assert.equal(f.requests.length,0);
 visibility.hidden=false;visibility.dispatchEvent(new Event('visibilitychange'));await f.advance(150);assert.equal(f.requests.length,1);
 visibility.hidden=true;visibility.dispatchEvent(new Event('visibilitychange'));await failure;
});
test('stop and a new owner still share the two physical slots when abort is ignored',async t=>{
 const a=fixture(t,{cooperate:false});await a.advance(350);a.stop();assert.ok(a.requests.every(r=>r.signal.reason.message===ROOM_POLL_ABORT.stopped));
 const b=fixture(t,{cooperate:false,playerKey:'player-two'});await b.advance(1000);assert.equal(b.requests.length,0);
 a.requests[0].resolve(room(999));await flush();await b.advance(150);assert.equal(b.requests.length,1);assert.equal(a.rooms.length,0);
 b.requests[0].resolve({...room(1),me:'player-two'});await flush();assert.equal(b.rooms.length,1);assert.equal(a.errors.length,0);
});
test('stop removes timers and listeners without delivering a late read',async t=>{
 const f=fixture(t,{cooperate:false});await f.advance(350);f.stop();for(const r of f.requests)r.resolve(room(100));await flush();await f.advance(10000);
 assert.equal(f.rooms.length,0);assert.equal(f.errors.length,0);assert.equal(f.requests.length,2);assert.equal(f.timers.size,0);
});
test('initial delay and minimum send interval are respected even for immediate responses',async t=>{
 const f=fixture(t,{initialDelay:250,interval:()=>1});await f.advance(249);assert.equal(f.requests.length,0);await f.advance(1);f.requests[0].resolve(room(1));await flush();await f.advance(149);assert.equal(f.requests.length,1);await f.advance(1);assert.equal(f.requests[1].at,400);
});
test('invalid hedge timing fails before creating any read',()=>{
 for(const patch of [{initialDelay:-1},{hedgeAfterMs:149},{hedgeAfterMs:Infinity},{timeoutMs:350}])assert.throws(()=>startRunRoomPolling({read(){assert.fail('read');},onRoom(){},onError(){},roomId:'r',playerKey:'p',...patch}),TypeError);
});

test('real HTTP: a single 800ms GET does not block newer fast snapshots; all methods remain GET',async t=>{
 async function run(poll){
  let count=0,active=0,maxActive=0;const arrivals=[],delivered=[],methods=[],timers=new Set();
  const server=createServer((req,res)=>{
   const version=++count;methods.push(req.method);active++;maxActive=Math.max(maxActive,active);arrivals.push(performance.now());
   const timer=setTimeout(()=>{timers.delete(timer);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(room(version)));active--;},version===2?800:50);timers.add(timer);
  });server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;const start=performance.now();const reads=[];
  const stop=poll({roomId:'room-run',playerKey:'player-one',initialDelay:0,interval:()=>150,read:signal=>{const promise=fetch(url,{signal}).then(r=>r.json());reads.push(promise);return promise;},onRoom:value=>delivered.push({at:performance.now()-start,version:value.version}),onError:error=>{if(error.name!=='AbortError')throw error;}});
  try{await new Promise(resolve=>setTimeout(resolve,1250));}finally{stop();await Promise.allSettled(reads);for(const timer of timers)clearTimeout(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  return {arrivals:arrivals.map(at=>at-start),delivered,maxActive,methods};
 }
 const serial=await run(startRoomPolling),hedge=await run(startRunRoomPolling);
 assert.equal(serial.maxActive,1);assert.ok(serial.delivered[1].at-serial.delivered[0].at>=700);
 assert.equal(hedge.maxActive,2);assert.equal(hedge.delivered.some(x=>x.version===2),false,'late snapshot must not roll back');
 assert.ok(hedge.delivered[1].at-hedge.delivered[0].at<650,'fast hedge arrives inside existing prediction budget');
 assert.ok(hedge.delivered.length>serial.delivered.length);assert.ok(hedge.methods.every(x=>x==='GET'));assert.ok(serial.methods.every(x=>x==='GET'));
 assert.ok(hedge.arrivals.every((at,i)=>i===0||at-hedge.arrivals[i-1]>=140),'150ms dispatch cadence allows small receive-side timing variation');
 t.diagnostic(JSON.stringify({serial,hedge}));
});

test('real HTTP: persistent 800ms delay remains bounded and cannot promise a fresh snapshot by 650ms',async t=>{
 let count=0,active=0,maxActive=0;const timers=new Set(),delivered=[],reads=[],sent=[];
 const server=createServer((req,res)=>{assert.equal(req.method,'GET');const version=++count;active++;maxActive=Math.max(maxActive,active);const timer=setTimeout(()=>{timers.delete(timer);active--;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(room(version)));},800);timers.add(timer);});
 server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`,start=performance.now();
 const stop=startRunRoomPolling({roomId:'room-run',playerKey:'player-one',initialDelay:0,read:signal=>{sent.push(performance.now()-start);const read=fetch(url,{signal}).then(r=>r.json());reads.push(read);return read;},onRoom:value=>delivered.push({at:performance.now()-start,version:value.version}),onError:error=>{throw error;}});
 try{await new Promise(resolve=>setTimeout(resolve,1000));assert.equal(delivered.length,1);assert.ok(delivered[0].at>=750);assert.equal(maxActive,2);assert.ok(sent.length<=3);}
 finally{stop();await Promise.allSettled(reads);for(const timer of timers)clearTimeout(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 t.diagnostic(JSON.stringify({persistent_slow:{sent,delivered,maxActive,limitation:'Whole-path delay still exceeds the unchanged 650ms prediction allowance.'}}));
});

test('real HTTP: connection failures are surfaced with bounded retry, never POST replay or a hedge burst',async t=>{
 const sent=[],errors=[],methods=[],reads=[];const server=createServer((req,res)=>{methods.push(req.method);req.socket.destroy();});server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}`,start=performance.now();const stop=startRunRoomPolling({roomId:'room-run',playerKey:'player-one',initialDelay:0,read:signal=>{sent.push(performance.now()-start);const p=fetch(url,{signal}).then(r=>r.json());reads.push(p);return p;},onRoom:()=>assert.fail('closed connection produced room'),onError:e=>errors.push(e.name)});
 try{await new Promise(resolve=>setTimeout(resolve,650));assert.ok(errors.length>=2);assert.ok(sent.length<=5);assert.ok(sent.every((at,i)=>i===0||at-sent[i-1]>=150));assert.ok(methods.every(m=>m==='GET'));}
 finally{stop();await Promise.allSettled(reads);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 t.diagnostic(JSON.stringify({disconnected:{sent,errors,methods}}));
});

test('real HTTP: non-active Run serial waiting-room reads share the old active physical slots',async t=>{
 let active=0,maxActive=0;const oldResponses=[],reads=[],waitingRooms=[],paths=[];
 const server=createServer((req,res)=>{
  assert.equal(req.method,'GET');active++;maxActive=Math.max(maxActive,active);paths.push(req.url);
  const send=value=>{active--;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(req.url==='/old')oldResponses.push(()=>send(room(oldResponses.length)));
  else send({id:'waiting-room',me:'player-two',game_id:'run',status:'waiting',version:1});
 });server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
 // Simulate an old read implementation that ignores abort, including real HTTP.
 const oldStop=startRunRoomPolling({roomId:'room-run',playerKey:'player-one',rateScope:'http-old',initialDelay:0,read:()=>{const p=fetch(url+'/old').then(r=>r.json());reads.push(p);return p;},onRoom:()=>assert.fail('stopped owner delivered'),onError:()=>assert.fail('stopped owner errored')});
 let serialStop=()=>{};
 try{
  await new Promise(resolve=>setTimeout(resolve,450));assert.equal(oldResponses.length,2);oldStop();
  serialStop=startRoomPolling({initialDelay:0,interval:()=>500,read:signal=>readRunRoomOnce({rateScope:'http-new',signal,read:ownSignal=>{const p=fetch(url+'/waiting',{signal:ownSignal}).then(r=>r.json());reads.push(p);return p;}}),onRoom:value=>waitingRooms.push(value),onError:error=>{throw error;}});
  await new Promise(resolve=>setTimeout(resolve,200));assert.equal(paths.includes('/waiting'),false);
  oldResponses[0]();await new Promise(resolve=>setTimeout(resolve,200));assert.equal(waitingRooms.length,1);assert.equal(waitingRooms[0].status,'waiting');assert.equal(maxActive,2);assert.equal(paths.filter(p=>p==='/waiting').length,1);
 }finally{oldStop();serialStop();for(const send of oldResponses.slice(1))send();await Promise.allSettled(reads);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 t.diagnostic(JSON.stringify({waiting_room:{paths,maxActive,deliveries:waitingRooms.length}}));
});
