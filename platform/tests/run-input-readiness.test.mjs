import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunInputGuard,RUN_INPUT_FRESH_MS} from '../arena/run/input-readiness.mjs';
const game=(snapshotTick,serverNow=10000+snapshotTick*1000/60)=>({snapshotTick,serverNow});

test('Run cold start requires rendered assets and a subsequent authoritative tick',()=>{
 const gate=createRunInputGuard();gate.receive(game(20),10400,0);
 assert.equal(gate.current(100).ready,false);
 gate.sceneReady(true);assert.equal(gate.current(100).ready,false);
 gate.receive(game(20),10500,100);assert.equal(gate.current(100).ready,false);
 gate.receive(game(21),10400,120);assert.equal(gate.current(120).ready,true);
 assert.equal(gate.current(120).tick,21);
});
test('Run click-time freshness catches a blocked JS frame without a React clock update',()=>{
 const gate=createRunInputGuard();gate.receive(game(1),10020,0);gate.sceneReady(true);gate.receive(game(2),10040,50);
 assert.equal(gate.current(55).ready,true);
 assert.equal(gate.current(50+RUN_INPUT_FRESH_MS).ready,false);
 assert.equal(gate.current(3500).tick,2,'No projected observed tick is generated');
});
test('Repeated or reordered reads cannot rejuvenate old simulation snapshots',()=>{
 const gate=createRunInputGuard();gate.receive(game(1),10020,0);gate.sceneReady(true);gate.receive(game(2),10040,10);
 assert.equal(gate.receive(game(2),12500,2500),false);
 assert.equal(gate.receive(game(1),12500,2500),false);
 assert.equal(gate.current(2500).ready,false);
 assert.equal(gate.current(2500).tick,2);
});
test('Server snapshot age is included even for a newly received response',()=>{
 const gate=createRunInputGuard();gate.receive(game(1),10020,0);gate.sceneReady(true);
 gate.receive(game(2),12000,20);assert.equal(gate.current(20).ready,false);
 gate.receive(game(3),10500,30);assert.equal(gate.current(30).ready,true);
});
test('STALE_INPUT waits for a newer real tick; context loss disables movement',()=>{
 const gate=createRunInputGuard();gate.receive(game(1),10020,0);gate.sceneReady(true);gate.receive(game(2),10040,10);
 gate.rejectStale();assert.equal(gate.current(20).ready,false);
 gate.receive(game(2),10040,30);assert.equal(gate.current(30).ready,false);
 gate.receive(game(3),10060,40);assert.equal(gate.current(40).ready,true);
 gate.sceneReady(false);assert.equal(gate.current(50).ready,false);
 gate.sceneReady(true);assert.equal(gate.current(60).ready,false);
 gate.receive(game(4),10070,70);assert.equal(gate.current(70).ready,true);
});
test('Invalid snapshot fields never enable movement',()=>{
 const gate=createRunInputGuard();gate.sceneReady(true);
 for(const bad of [{snapshotTick:NaN,serverNow:1},{snapshotTick:-1,serverNow:1},{snapshotTick:1.2,serverNow:1},{snapshotTick:1}])assert.equal(gate.receive(bad,1,1),false);
 assert.equal(gate.current(2).ready,false);
});
