import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as Engine from '../arena/run/engine.mjs';
import {createRunProvisionalSimulation,RUN_PROVISIONAL_MAX_TICKS} from '../arena/run/provisional-simulation.mjs';
import {RUN_SELF_PROJECTION_SCHEMA} from '../arena/run/self-projection.mjs';
import {makeRunActionReceipt} from '../shared/run-action-receipt.mjs';
import {createRunHeldBoostFixture} from './fixtures/run-timeline-race-fixture.mjs';

// Independent complete pre-extraction engine. No predictor/shared step oracle.
const source=await readFile(new URL('./fixtures/run-engine-before-runner-physics.mjs',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'0c102a4160114510e20959a9f276186be5867247e93c4d1bfe5c098706b4c5e8');
const resolved=source.replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL(path,new URL('../arena/run/engine.mjs',import.meta.url)).href}'`);
const E=await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);
const clone=value=>structuredClone(value),freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const time=(s,tick)=>Math.ceil(s.startedAt+tick*1000/60);
function state(index=0){const s=E.createState(index.toString(16).padStart(8,'0').padEnd(64,'0'),1000,{ruleVersion:E.PRACTICE_RULE_VERSION,startPolicy:E.RUN_SCENE_READY_POLICY,players:[{key:'self',seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]});E.armStart(s,1000);return s;}
function room(s,{version=1,seq=s.players[0].inputNo,id='practice_room'}={}){
 const game=E.view(s,s.players[0].key),p=s.players[0];
 game.selfPrediction={schema:RUN_SELF_PROJECTION_SCHEMA,resolvedObstacles:[...p.resolvedObstacles],pendingInput:clone(p.pendingInput),lastInputTick:p.lastInputTick};
 return {id,game_id:'run',practice:true,entry_minor:'0',status:'active',me:p.key,me_last_seq:seq,version,game};
}
function post(s,type,{version,seq,requestId,id='practice_room'}={}){
 const {event}=E.act(s,s.players[0].key,{type,observed_tick:s.tick},s.now);
 const raw=room(s,{version,seq,id});raw.action_receipt=makeRunActionReceipt({roomId:id,playerKey:raw.me,request_id:requestId,seq,type,ruleVersion:s.ruleVersion,event});return raw;
}
function checkState(actual,expected){assert.ok(actual);for(const [key,value]of Object.entries(actual))if(key!=='tick')assert.deepEqual(value,expected[key],key);}
function start(s=state()){const m=createRunProvisionalSimulation();assert.equal(m.receive(room(s),0).ok,true);return m;}
const submit=(m,seq,type,submittedTick)=>{const result=m.submit({seq,type,submittedTick});assert.equal(result.ok,true,JSON.stringify(result));return result;};
const tokens=new WeakMap();
const bind=(m,seq,wireSeq=seq)=>{const requestId=`request_${seq}`,result=m.bindDispatch({seq,wireSeq,requestId});assert.equal(result.ok,true);if(!tokens.has(m))tokens.set(m,new Map());tokens.get(m).set(seq,result.token);return requestId;};
const resolve=(m,{seq,...args})=>m.resolve({token:tokens.get(m)?.get(seq),...args});

test('strict scope: only free single-human BOT V2.2 practice is eligible',()=>{
 for(const mutate of [r=>r.practice=false,r=>r.entry_minor='1',r=>r.game.ruleVersion=E.RULE_VERSION,r=>r.game.players[1].isBot=false,r=>delete r.game.selfPrediction]){
  const m=createRunProvisionalSimulation(),r=room(state());mutate(r);assert.equal(m.receive(r,0).ok,false);assert.equal(m.sample(100).pose,null);
 }
 assert.throws(()=>createRunProvisionalSimulation({maxPredictionTicks:121}),RangeError);
});

test('all six real courses match independent full engine for 120 integer ticks',()=>{
 for(let i=0;i<6;i++){
  const s=state(i),m=start(s);
  for(let tick=0;tick<=RUN_PROVISIONAL_MAX_TICKS;tick++){
   if(tick)E.testing.step(s);
   checkState(m.stateAtTick(tick),s.players[0]);
  }
 }
});

test('ordered local lane/jump/slide use exact admission and match every oracle step without receipts',()=>{
 const s=state(),m=start(s),actions=new Map([[1,'right'],[13,'left'],[19,'jump'],[67,'slide']]);
 let seq=0;for(const [tick,type]of actions)assert.equal(submit(m,++seq,type,tick).localAdmission,'predicted');
 for(let tick=1;tick<=120;tick++){
  if(actions.has(tick))E.act(s,'self',{type:actions.get(tick)},time(s,tick-1));
  E.testing.step(s);checkState(m.stateAtTick(tick),s.players[0]);
 }
 const v=m.sample(700);assert.equal(v.authority.leaseExpired,true);assert.equal(v.mode,'provisional');assert.ok(v.pose.distance>0);
 assert.equal(v.authority.inputNo,0);assert.ok(v.intents.every(i=>i.outcome==='unresolved'&&i.receipt===null));
 assert.equal('score'in v,false);assert.equal('winnerKeys'in v,false);
});

test('local rejected admission is not HTTP rejection, and seq/tick duplicates are not replayed',()=>{
 const m=start();submit(m,1,'jump',1);assert.equal(submit(m,2,'slide',7).localAdmission,'AIRBORNE');
 assert.equal(m.submit({seq:2,type:'right',submittedTick:13}).ok,false);
 assert.equal(m.submit({seq:4,type:'right',submittedTick:13}).ok,false);
 assert.equal(m.sample(200).intents[1].outcome,'unresolved');
 const s=state(),local=start(s);submit(local,1,'left',1);assert.equal(submit(local,2,'left',13).localAdmission,'TRACK_EDGE');
 assert.equal(local.bindDispatch({seq:1,wireSeq:2,requestId:'invalid_sequence'}).ok,false);
});

test('held item uses natural pickup and real engine admission; no local inventory invention',()=>{
 const {state:s}=createRunHeldBoostFixture();
 const raw=room(s),m=createRunProvisionalSimulation();assert.equal(m.receive(raw,0).ok,true);
 assert.equal(submit(m,1,'item',s.tick+1).localAdmission,'predicted');
 const reference=clone(s);Engine.act(reference,reference.players[0].key,{type:'item'},reference.now);
 for(let i=1;i<=120;i++){E.testing.step(reference);checkState(m.stateAtTick(s.tick+i),reference.players[0]);}
 const empty=start();assert.equal(submit(empty,1,'item',1).localAdmission,'NO_ITEM');
});

test('real collision/fall/respawn follow oracle; local predicted finish cannot award a result',()=>{
 for(const [index,baseTick]of [[0,270],[2,235]]){
  const s=state(index);E.tick(s,time(s,baseTick));const m=start(s),reference=clone(s);
  for(let i=1;i<=120;i++){E.testing.step(reference);checkState(m.stateAtTick(baseTick+i),reference.players[0]);}
  assert.ok(m.sample(1200).pose.hits>0);
 }
 const s=state();
 // Reach finish using actual engine-admitted BOT guidance, no hand-set poses.
 while(s.tick<5990&&s.players[0].distanceU<479*300&&s.status==='active'){
  const action=E.botAction(s,'self',s.now);if(action){try{E.act(s,'self',action,s.now);}catch{}}
  E.tick(s,time(s,s.tick+1));
 }
 assert.ok(s.players[0].distanceU>=479*300,'natural near-finish fixture');
 const m=start(s),v=m.sample(2000);assert.equal(v.pose.distance,480);assert.equal(v.pose.provisionalFinish,true);assert.equal(v.pose.visualPlayer.finishTick,null);assert.equal(v.authority.inputNo,s.players[0].inputNo);
});

test('650ms authority lease stays expired while provisional motion continues to explicit 120 tick cap',()=>{
 const s=state(),m=start(s),at650=m.sample(650),at1000=m.sample(1000),at2000=m.sample(2000);
 assert.equal(at650.authority.leaseExpired,true);assert.equal(at650.mode,'provisional');assert.ok(at1000.pose.distance>at650.pose.distance);
 assert.equal(at2000.mode,'disconnected');assert.equal(at2000.displayTick,120);assert.deepEqual(m.sample(9000).pose,at2000.pose);
 assert.equal(m.receive(room(s,{version:2}),9100).ok,true);assert.equal(m.sample(9100).mode,'disconnected');assert.equal(m.sample(9100).authority.receivedAtMs,0);
 assert.equal(m.submit({seq:1,type:'jump',submittedTick:120}).ok,false);
});

test('original exact POST receipt incorporates input; stale ACK cannot rewind state or renew lease',()=>{
 const s=state(),m=start(s);submit(m,1,'right',1);const requestId=bind(m,1);
 const raw=post(s,'right',{version:2,seq:1,requestId});const bad=clone(raw);bad.action_receipt.request_id='another_request';
 assert.equal(resolve(m, {seq:1,outcome:'accepted',room:bad,resolvedAtMs:10}).reason,'invalid-receipt');
 E.tick(s,time(s,12));assert.equal(m.receive(room(s,{version:3}),200).ok,true);
 const before=m.sample(250);assert.equal(before.intents[0].incorporated,true);assert.equal(before.intents[0].outcome,'unresolved');
 assert.equal(resolve(m, {seq:1,outcome:'accepted',room:raw,resolvedAtMs:300}).ok,true);
 const after=m.sample(250);assert.deepEqual(after.pose,before.pose);assert.equal(after.authority.receivedAtMs,200);
 assert.equal(after.intents[0].outcome,'accepted');assert.equal(resolve(m, {seq:1,outcome:'accepted',room:raw,resolvedAtMs:400}).ok,false);
});

test('out-of-order ACKs retain exact intent identity; transport denial may reuse wire seq',()=>{
 const s=state(),m=start(s);submit(m,1,'right',1);const id1=bind(m,1),r1=post(s,'right',{version:2,seq:1,requestId:id1});
 E.tick(s,time(s,12));assert.equal(m.receive(room(s,{version:3}),200).ok,true);
 submit(m,2,'left',13);const id2=bind(m,2),r2=post(s,'left',{version:4,seq:2,requestId:id2});
 assert.equal(resolve(m, {seq:2,outcome:'accepted',room:r2,resolvedAtMs:220}).ok,true);
 assert.equal(resolve(m, {seq:1,outcome:'accepted',room:r1,resolvedAtMs:300}).ok,true);
 assert.equal(m.sample(300).authority.inputNo,2);
 const denied=start();submit(denied,1,'right',1);bind(denied,1);denied.sample(100);
 assert.equal(resolve(denied, {seq:1,outcome:'rejected'}).ok,true);assert.equal(denied.sample(100).correction.cause,'input-rejected');
 submit(denied,2,'jump',7);assert.equal(denied.bindDispatch({seq:2,wireSeq:1,requestId:'second_request'}).ok,true);
});

test('reconciliation replays remaining unacked future intents at original submitted ticks',()=>{
 const s=state(),m=start(s);submit(m,1,'right',1);bind(m,1);submit(m,2,'jump',31);
 E.act(s,'self',{type:'right'},s.now);E.tick(s,time(s,20));assert.equal(m.receive(room(s,{version:2}),350).ok,true);
 for(let tick=21;tick<=100;tick++){if(tick===31)E.act(s,'self',{type:'jump'},time(s,30));E.testing.step(s);checkState(m.stateAtTick(tick),s.players[0]);}
 assert.equal(m.sample(700).intents[1].outcome,'unresolved');
});

test('passed unacked tick is exposed, not silently retimed or declared rejected',()=>{
 const s=state(),m=start(s);submit(m,1,'jump',1);bind(m,1);m.sample(200);
 E.tick(s,time(s,12));assert.equal(m.receive(room(s,{version:2}),220).ok,true);
 const v=m.sample(220);assert.deepEqual(v.issues,[{seq:1,reason:'unacked-input-before-authority'}]);assert.equal(v.intents[0].outcome,'unresolved');assert.equal(v.pose.y,0);assert.notEqual(v.correction,null);
});

test('negative protocol proof: server arrival after local jump tick causes real fall and explicit correction',()=>{
 // canal gap is [34,37] across all lanes. Initial authority is a natural,
 // unobstructed tick 240 (32m). Local jump at 241 clears it; delayed server
 // arrival at 258 is already falling and must reject BUSY.
 const s=state(2);E.tick(s,time(s,240));assert.equal(s.players[0].hits,0);
 const m=start(s);submit(m,1,'jump',241);bind(m,1);const local=m.sample(300);
 assert.equal(local.pose.hits,0);assert.ok(local.pose.y>0);assert.equal(local.pose.fallUntilTick,null);
 E.tick(s,time(s,258));assert.ok(s.players[0].fallUntilTick!==null);assert.throws(()=>E.act(s,'self',{type:'jump',observed_tick:240},s.now),{code:'BUSY'});
 assert.equal(m.receive(room(s,{version:2}),320).ok,true);
 const corrected=m.sample(320);assert.equal(corrected.correction.authoritativeCollision,true);assert.equal(corrected.pose.hits,1);assert.notEqual(corrected.pose.fallUntilTick,null);
 assert.equal(corrected.intents[0].outcome,'unresolved');assert.equal(resolve(m, {seq:1,outcome:'rejected'}).ok,true);
});

test('late accepted tick mismatch is explicit, not hidden by locally successful admission',()=>{
 const s=state(),m=start(s);submit(m,1,'jump',1);const requestId=bind(m,1);m.sample(300);
 E.tick(s,time(s,12));const raw=post(s,'jump',{version:2,seq:1,requestId});
 const result=resolve(m, {seq:1,outcome:'accepted',room:raw,resolvedAtMs:300});assert.equal(result.executionTickMismatch,true);
 const v=m.sample(300);assert.equal(v.correction.cause,'execution-tick-mismatch');assert.equal(v.correction.submittedTick,1);assert.equal(v.correction.acceptedTick,13);assert.notEqual(v.correction.yDelta,0);
});

test('visibility freeze and room reset require fresh authority; room/identity never leaks intents',()=>{
 const s=state(),m=start(s);submit(m,1,'jump',1);const first=m.sample(100);m.suspend();
 E.tick(s,time(s,6));m.receive(room(s,{version:2}),150);assert.equal(m.sample(500).mode,'suspended');assert.deepEqual(m.sample(500).pose,first.pose);
 m.resume();m.receive(room(s,{version:3}),550);assert.equal(m.sample(600).mode,'suspended');
 E.tick(s,time(s,7));m.receive(room(s,{version:4}),650);assert.equal(m.sample(650).mode,'provisional');
 const other=room(state(),{id:'different_room'});assert.equal(m.receive(other,700).ok,true);assert.deepEqual(m.sample(700).intents,[]);assert.equal(m.sample(700).displayTick,0);
 assert.equal(resolve(m, {seq:1,outcome:'accepted',room:other,resolvedAtMs:710}).ok,false);
 m.clear();assert.equal(m.sample(800).pose,null);
});

test('unknown counter advances, mapping changes, and terminal authority fail explicitly',()=>{
 const s=state(),m=start(s);E.act(s,'self',{type:'jump'},s.now);assert.equal(m.receive(room(s,{version:2}),10).reason,'unmapped-authoritative-input');
 const fresh=start(),changed=room(state(),{version:2});changed.game.startedAt+=1000;changed.game.serverNow+=1000;changed.game.deadlineAt+=1000;assert.equal(fresh.receive(changed,10).reason,'mapping-changed');
 const terminal=start(),done=room(state(),{version:2});done.status='settled';done.game.status='finished';assert.equal(terminal.receive(done,50).mode,'authoritative-terminal');assert.equal(terminal.sample(100).pose,null);
 assert.equal(terminal.receive(room(state(),{version:3}),150).reason,'terminal-room');
});

test('authoritative input and public snapshots remain unchanged and returned model values are owned',()=>{
 const s=state(),raw=freeze(room(s)),before=JSON.stringify(raw),m=createRunProvisionalSimulation();m.receive(raw,0);submit(m,1,'jump',1);const v=m.sample(100);
 assert.equal(JSON.stringify(raw),before);assert.ok(Object.isFrozen(v));assert.ok(Object.isFrozen(v.pose.visualPlayer.claimedItems));assert.ok(Object.isFrozen(m.stateAtTick(6)));
 assert.throws(()=>v.pose.visualPlayer.resolvedObstacles.push('fake'),TypeError);assert.equal(s.players[0].inputNo,0);
});

test('prediction work and outstanding intents are bounded; unresolved timeout is never denial',()=>{
 const m=start();for(let seq=1;seq<=128;seq++)submit(m,seq,'jump',1);
 assert.equal(m.submit({seq:129,type:'jump',submittedTick:1}).reason,'intent-capacity');
 bind(m,1);assert.equal(resolve(m,{seq:1,outcome:'unresolved'}).ok,true);
 const v=m.sample(3000);assert.equal(v.mode,'disconnected');assert.equal(v.intents.length,128);assert.ok(v.intents.every(i=>i.outcome==='unresolved'));
 assert.equal(m.stateAtTick(121),null);
});

test('new authority ahead of presentation starts its own advancing clock, not a wait for the old origin',()=>{
 const s=state(),m=start(s);m.sample(50);E.tick(s,time(s,15));m.receive(room(s,{version:2}),100);
 assert.equal(m.sample(100).displayTick,15);assert.equal(m.sample(200).displayTick,21);
 assert.ok(m.sample(200).correction);assert.equal(m.sample(200).authority.leaseExpired,false);
});

test('late old-room denial cannot consume a new room intent with the same local and wire seq',()=>{
 const m=start();submit(m,1,'jump',1);const old=m.bindDispatch({seq:1,wireSeq:1,requestId:'same_request'}).token;
 m.receive(room(state(),{id:'another_room'}),10);submit(m,1,'jump',1);const fresh=m.bindDispatch({seq:1,wireSeq:1,requestId:'same_request'}).token;
 assert.equal(m.resolve({token:old,outcome:'rejected'}).ok,false);
 assert.equal(m.resolve({token:clone(fresh),outcome:'rejected'}).ok,false,'a token is an opaque lifetime binding');
 assert.equal(m.sample(20).intents[0].outcome,'unresolved');assert.equal(m.resolve({token:fresh,outcome:'rejected'}).ok,true);
});
