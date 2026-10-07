import test from 'node:test';
import * as Engine from '../arena/run/engine.mjs';
import assert from 'node:assert/strict';
import {createRunPresentationEvents} from '../arena/run/presentation-events.mjs';
import {createRunSelfProjection} from '../arena/run/self-projection.mjs';
import {createRunHeldBoostFixture} from './fixtures/run-timeline-race-fixture.mjs';

const options={roomId:'effects-room',roomVersion:1},key='human';
const event=(id,tick,type='hit',playerKey=key)=>({id,tick,type,playerKey,at:1000+tick*1000/60});
const game=(tick,events=[])=>({snapshotTick:tick,events,ruleVersion:'pvp-run-v2.2.0',courseId:'course',startedAt:1000});

test('received collision waits for the actual visual tick, never snapshot arrival',()=>{
 const cursor=createRunPresentationEvents(),hit=Object.freeze(event(1,18)),g=Object.freeze(game(20,Object.freeze([hit]))),before=JSON.stringify(g);
 assert.equal(cursor.receive(g,key,options),true);
 assert.deepEqual(cursor.drain(15),[]);assert.deepEqual(cursor.drain(17.999),[]);
 assert.deepEqual(cursor.drain(18),[hit]);assert.deepEqual(cursor.drain(20),[]);
 assert.equal(JSON.stringify(g),before);
});

test('accepted visual event cannot replay after a display phase retreat or duplicate snapshot',()=>{
 const cursor=createRunPresentationEvents(),g=game(30,[event(1,28,'item_used')]);
 cursor.receive(g,key,options);assert.equal(cursor.drain(29).length,1);
 cursor.receive(g,key,{...options,roomVersion:2});assert.deepEqual(cursor.drain(27),[]);assert.deepEqual(cursor.drain(30),[]);
});

test('interleaved other-player events and unsorted transport do not suppress own new events',()=>{
 const cursor=createRunPresentationEvents();cursor.receive(game(30,[event(3,29,'fall','bot'),event(2,28,'jump'),event(1,27,'right')]),key,options);
 assert.deepEqual(cursor.drain(30).map(e=>e.id),[1,2]);
 assert.equal(cursor.receive(game(29,[event(4,29)]),key,{...options,roomVersion:2}),false);
 assert.equal(cursor.receive(game(31,[event(4,31)]),key,{...options,roomVersion:0}),false);
 assert.deepEqual(cursor.drain(31),[]);
});

test('a new room or requesting player has its own event-id scope',()=>{
 const cursor=createRunPresentationEvents();cursor.receive(game(100,[event(50,100)]),key,options);cursor.drain(100);
 cursor.receive(game(10,[event(1,10)]),key,{roomId:'other-room',roomVersion:0});assert.equal(cursor.drain(10)[0].id,1);
 cursor.receive(game(10,[event(1,10,'jump','other')]),'other',{roomId:'other-room',roomVersion:0});assert.equal(cursor.drain(10)[0].playerKey,'other');
 cursor.clear();assert.deepEqual(cursor.drain(100),[]);
});

test('background and first genuinely fresh resume snapshot cannot burst old sounds',()=>{
 const cursor=createRunPresentationEvents();cursor.receive(game(10,[event(1,10)]),key,options);cursor.suspend();assert.deepEqual(cursor.drain(10),[]);
 cursor.receive(game(20,[event(2,20)]),key,{...options,roomVersion:2});cursor.resume();
 // A cached/same-tick response is not the first actual resume synchronization.
 cursor.receive(game(20,[event(2,20)]),key,{...options,roomVersion:3});
 cursor.receive(game(30,[event(3,30)]),key,{...options,roomVersion:4});assert.deepEqual(cursor.drain(30),[]);
 cursor.receive(game(31,[event(4,31)]),key,{...options,roomVersion:5});assert.equal(cursor.drain(31)[0].id,4);
});

test('explicit resync discards a movement backlog but preserves a newly received finish',()=>{
 const cursor=createRunPresentationEvents();cursor.receive(game(30,[event(1,20,'jump'),event(2,21,'hit'),event(3,25,'finish')]),key,options);
 assert.deepEqual(cursor.drain(30,{resync:true}).map(e=>e.type),['finish']);assert.deepEqual(cursor.drain(30),[]);
});

test('stale and malformed effects stay bounded without mutating authoritative state',()=>{
 const cursor=createRunPresentationEvents();
 cursor.receive(game(100,[event(1,10),event(2,11),event(3,101),event(4,90,'unknown')]),key,options);
 assert.deepEqual(cursor.drain(100).map(e=>e.id),[2]);
 cursor.receive(game(101,Array.from({length:80},(_,i)=>event(i+5,101))),key,{...options,roomVersion:2});
 assert.equal(cursor.drain(101).length,48);
 assert.equal(cursor.receive(game(102),key,{...options,roomVersion:NaN}),false);assert.deepEqual(cursor.drain(NaN),[]);
});

test('natural boost pickup visibility and sound share the rendered crossing tick',()=>{
 const {game:latest,previousPublication:previous}=createRunHeldBoostFixture();
 const self=latest.players.find(p=>p.key===key),source=previous.players.find(p=>p.key===key),picked=self.claimedItems.find(id=>!source.claimedItems.includes(id));
 assert.ok(picked);const pickup=latest.events.find(e=>e.playerKey===key&&e.type==='item_pickup'&&e.item==='boost');assert.ok(pickup);
 const projection=createRunSelfProjection();assert.equal(projection.update(previous,key,options),true);
 const before=projection.sample((pickup.tick-previous.snapshotTick-1)*1000/60),after=projection.sample((pickup.tick-previous.snapshotTick)*1000/60);
 assert.equal(self.claimedItems.includes(picked),true);assert.equal(before.visualPlayer.claimedItems.includes(picked),false);assert.equal(after.visualPlayer.claimedItems.includes(picked),true);
 assert.ok(Object.isFrozen(after.visualPlayer.claimedItems));assert.notEqual(after.visualPlayer.claimedItems,self.claimedItems);
 assert.throws(()=>after.visualPlayer.claimedItems.push('changed'),TypeError);
 const cursor=createRunPresentationEvents();cursor.receive(latest,key,options);
 assert.equal(cursor.drain(before.tick).some(e=>e.id===pickup.id),false);assert.equal(cursor.drain(after.tick).some(e=>e.id===pickup.id),true);
});


test('resume preserves a newly authoritative finish exactly once while discarding old movement',()=>{
 const cursor=createRunPresentationEvents();cursor.receive(game(10),key,options);cursor.suspend();cursor.resume();
 cursor.receive(game(30,[event(1,21,'jump'),event(2,25,'finish')]),key,{...options,roomVersion:2});
 assert.deepEqual(cursor.drain(24,{resync:true}),[]);
 assert.deepEqual(cursor.drain(30,{resync:true}).map(e=>e.type),['finish']);
 cursor.receive(game(30,[event(2,25,'finish')]),key,{...options,roomVersion:3});assert.deepEqual(cursor.drain(30),[]);
});

test('finish received or queued while hidden survives a terminal same-tick resume',()=>{
 for(const queuedBeforeHide of [false,true]){
  const cursor=createRunPresentationEvents();cursor.receive(game(10),key,options);
  if(queuedBeforeHide)cursor.receive(game(30,[event(1,25,'finish')]),key,{...options,roomVersion:2});
  cursor.suspend();
  if(!queuedBeforeHide)cursor.receive(game(30,[event(1,25,'finish')]),key,{...options,roomVersion:2});
  assert.deepEqual(cursor.drain(30),[]);cursor.resume();
  cursor.receive(game(30,[event(1,25,'finish')]),key,{...options,roomVersion:3});
  assert.deepEqual(cursor.drain(30,{resync:true}).map(e=>e.type),['finish']);
  cursor.suspend();cursor.resume();assert.deepEqual(cursor.drain(30,{resync:true}),[]);
 }
});


test('shared pause shifts wall time without replaying the same authoritative event IDs',()=>{
 const state=Engine.createState('0'.repeat(64),1000,{ruleVersion:Engine.PRACTICE_RULE_VERSION,startPolicy:Engine.RUN_SCENE_READY_POLICY,players:[{key,seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]});
 Engine.armStart(state,1000);Engine.tick(state,state.startedAt+Math.ceil(100*1000/60));Engine.act(state,key,{type:'jump'},state.now);Engine.tick(state,state.startedAt+Math.ceil(101*1000/60));
 const cursor=createRunPresentationEvents(),before=Engine.view(state,key);cursor.receive(before,key,options);assert.equal(cursor.drain(101).length,1);
 Engine.shiftTime(state,5001);const after=Engine.view(state,key);assert.notEqual(after.startedAt,before.startedAt);
 cursor.receive(after,key,{...options,roomVersion:2});assert.deepEqual(cursor.drain(101,{resync:true}),[]);
});
