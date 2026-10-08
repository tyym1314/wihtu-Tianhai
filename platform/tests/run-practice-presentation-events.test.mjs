import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunPracticePresentationEvents} from '../arena/run/practice-presentation-events.mjs';
const scope={roomId:'room',playerKey:'human',clockEpoch:1};
const make=(revision,head,committed,events)=>({id:'room',me:'human',run_inputs:{...scope,protocol:'run-practice-inputs-v1',ruleVersion:'pvp-run-v2.3.0',revision,headTick:head,committedThroughTick:committed},game:{ruleVersion:'pvp-run-v2.3.0',snapshotTick:head,events}});
const event=(id,tick,type,extra={})=>({id,playerKey:'human',tick,type,...extra});
test('a corrected suffix removes unplayed collisions without replaying unchanged sounds under new serials',()=>{
 const p=createRunPracticePresentationEvents(scope);
 assert.equal(p.receive(make(1,20,0,[event(1,10,'jump',{inputNo:1}),event(2,19,'hit',{obstacleId:'rock'})])),true);
 assert.deepEqual(p.drain(12).map(e=>e.type),['jump']);
 assert.equal(p.receive(make(2,20,0,[event(9,10,'jump',{inputNo:1}),event(10,19,'item_pickup',{item:'shield'})])),true);
 assert.deepEqual(p.drain(20).map(e=>e.type),['item_pickup']);assert.equal(p.drain(20).length,0);
});
test('individual finish effects wait for their committed tick, regardless of speculative finish or serial',()=>{
 const p=createRunPracticePresentationEvents(scope);
 p.receive(make(1,100,90,[event(1,99,'finish')]));assert.equal(p.drain(100).length,0);
 p.receive(make(2,110,100,[event(8,99,'finish')]));assert.deepEqual(p.drain(110).map(e=>e.type),['finish']);
 p.receive(make(3,111,101,[event(9,99,'finish')]));assert.equal(p.drain(111).length,0);
 p.receive(make(4,1000,880,[event(25,99,'finish')]));assert.equal(p.drain(1000).length,0);
 p.receive(make(5,1001,881,[event(26,99,'finish')]));assert.equal(p.drain(1001).length,0);
});
test('scope/epoch/revision and malformed self events refuse without mutating cursor',()=>{
 const p=createRunPracticePresentationEvents(scope),room=make(2,20,0,[event(1,10,'jump')]);p.receive(room);const before=p.state();
 for(const bad of [{...room,id:'other'},{...room,me:'other'},{...room,run_inputs:{...room.run_inputs,clockEpoch:2}},make(1,20,0,[]),make(3,21,1,[event(2,22,'hit')])]){assert.equal(p.receive(bad),false);assert.deepEqual(p.state(),before);}
});
test('a same-revision conflict cannot erase pending effects or advance the commit watermark',()=>{
 const p=createRunPracticePresentationEvents(scope),first=make(1,20,0,[event(1,19,'hit')]);p.receive(first);const before=p.state();
 assert.equal(p.receive(make(1,20,0,[])),false);assert.equal(p.receive(make(1,21,1,[event(1,19,'hit')])),false);
 assert.deepEqual(p.state(),before);assert.equal(p.receive(structuredClone(first)),true);assert.deepEqual(p.drain(20).map(e=>e.type),['hit']);
});
test('a committed undrained finish survives suspension and event-ring eviction exactly once',()=>{
 const p=createRunPracticePresentationEvents(scope);p.receive(make(1,110,100,[event(1,99,'finish')]));p.suspend();
 p.receive(make(2,500,380,[]));p.resume();assert.deepEqual(p.drain(500).map(e=>e.type),['finish']);
 p.suspend();p.resume();assert.equal(p.drain(500).length,0);
 const uncommitted=createRunPracticePresentationEvents(scope);uncommitted.receive(make(1,110,90,[event(1,99,'finish')]));uncommitted.suspend();uncommitted.receive(make(2,500,380,[]));uncommitted.resume();assert.equal(uncommitted.drain(500).length,0);
});
test('hidden and resync do not play a backlog, and event history stays bounded',()=>{
 const p=createRunPracticePresentationEvents(scope);p.receive(make(1,20,0,[event(1,19,'hit')]));p.suspend();assert.equal(p.drain(20).length,0);
 p.receive(make(2,40,20,[event(2,30,'jump')]));p.resume();p.receive(make(3,41,21,[event(2,30,'jump'),event(3,41,'slide')]));assert.deepEqual(p.drain(41).map(e=>e.type),['slide']);
 for(let tick=42;tick<2000;tick++){p.receive(make(tick,tick,Math.max(21,tick-120),[event(tick,tick,'jump',{inputNo:tick})]));p.drain(tick);assert.ok(p.state().played<=256);assert.ok(p.state().pending<=48);}
 p.clear();assert.equal(p.receive(make(2001,2001,1881,[])),false);assert.equal(p.drain(2001).length,0);
});
