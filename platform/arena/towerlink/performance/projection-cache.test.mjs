import test from 'node:test';
import assert from 'node:assert/strict';
import {createTroopProjection} from '../troop-presentation.mjs';
const snapshot={simulationAt:1000,serverNow:1000,armies:[
 {id:'green',ownerKey:'green',from:0,to:1,count:7,departedAt:1000,arrivesAt:3000},
 {id:'red',ownerKey:'red',from:1,to:0,count:3,departedAt:1000,arrivesAt:3000},
 {id:'blue',ownerKey:'blue',from:1,to:0,count:2,departedAt:1500,arrivesAt:3500},
]};
const counts=view=>view.armies.map(({id,count})=>[id,count]);
test('frame reuse ends exactly at departure, collision and arrival; seeking preserves retained frames',()=>{
 const projection=createTroopProjection(snapshot),before=projection.at(1000);
 assert.strictEqual(projection.at(1499.999),before);
 assert.deepEqual(counts(before),[['green',7],['red',3]]);
 const departed=projection.at(1500);
 assert.deepEqual(counts(departed),[['green',7],['red',3],['blue',2]]);
 assert.strictEqual(projection.at(1999.999),departed);
 const collided=projection.at(2000);
 assert.deepEqual(counts(collided),[['green',4],['blue',2]]);
 assert.strictEqual(projection.at(2249.999),collided);
 const second=projection.at(2250);
 assert.deepEqual(counts(second),[['green',2]]);
 assert.strictEqual(projection.at(2999.999),second);
 assert.deepEqual(counts(projection.at(3000)),[]);
 assert.deepEqual(counts(projection.at(1400)),[['green',7],['red',3]]);
 assert.deepEqual(counts(before),[['green',7],['red',3]],'later intervals never mutate a retained result');
 assert.deepEqual(counts(collided),[['green',4],['blue',2]]);
 assert.deepEqual(snapshot.armies.map(({id,count})=>[id,count]),[['green',7],['red',3],['blue',2]],'authoritative snapshot remains intact');
});
test('an empty snapshot reuses its result across arbitrary finite clocks',()=>{
 const projection=createTroopProjection({simulationAt:1000,armies:[]}),first=projection.at(1000);
 assert.deepEqual(first,{armies:[],collisions:[]});
 assert.strictEqual(projection.at(100000),first);
 assert.strictEqual(projection.at(0),first);
});
