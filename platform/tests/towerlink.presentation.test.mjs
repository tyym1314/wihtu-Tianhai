import test from 'node:test';
import assert from 'node:assert/strict';
import {createTroopProjection,projectTroops,pointOnRoad,createBattleEffectGate,roadBattleEffectKey} from '../arena/towerlink/troop-presentation.mjs';
import * as engine from '../arena/towerlink/engine.mjs';

const packet=(id,ownerKey,from,to,count,departedAt=1000,duration=2000)=>({id,ownerKey,from,to,count,departedAt,arrivesAt:departedAt+duration});
const snapshot=(armies,simulationAt=1000)=>({simulationAt,serverNow:simulationAt,armies});
const counts=armies=>Object.fromEntries(armies.map(a=>[a.id,a.count]));

test('Equal opponents disappear at the exact contact before the next 500 ms snapshot',()=>{
  const source=snapshot([packet('a','green',0,1,4),packet('b','red',1,0,4)]),copy=structuredClone(source),projection=createTroopProjection(source);
  assert.deepEqual(counts(projection.at(1999).armies),{a:4,b:4});
  assert.deepEqual(projection.at(2000).armies,[]);
  assert.deepEqual(projection.at(2250).armies,[]);
  assert.deepEqual(projection.at(2000).collisions.map(e=>({at:e.at,position:e.position,casualties:e.casualties})),[{at:2000,position:.5,casualties:8}]);
  assert.deepEqual(source,copy,'authoritative input is never modified');
});

test('Four against two leaves two travelling on their original schedule',()=>{
  const source=snapshot([packet('a','green',0,1,4),packet('b','red',1,0,2)]),result=projectTroops(source,2100);
  assert.deepEqual(result.armies,[{...source.armies[0],count:2}]);
  assert.equal(result.collisions[0].survivors,2);
  assert.equal(projectTroops(source,2999).armies.length,1);
  assert.equal(projectTroops(source,3000).armies.length,0);
});

test('Offset departures collide at their actual off-centre position',()=>{
  const source=snapshot([packet('a','green',0,1,4),packet('b','red',1,0,4,1500)]);
  assert.equal(projectTroops(source,2249).armies.length,2);
  const result=projectTroops(source,2250);
  assert.equal(result.armies.length,0);
  assert.equal(result.collisions[0].position,.625);
});

test('Friendly opponents, same-direction packets, and different roads never cancel',()=>{
  for(const second of [packet('b','green',1,0,4),packet('b','red',0,1,4),packet('b','red',2,3,4)]) {
    const result=projectTroops(snapshot([packet('a','green',0,1,4),second]),2000);
    assert.equal(result.armies.length,2);
    assert.equal(result.collisions.length,0);
  }
});

test('Simultaneous three-team contact is coalition cancellation, independent of input order',()=>{
  for(const amounts of [[5,4,2],[12,4,2]]) {
    const batch=[packet('a','green',0,1,amounts[0]),packet('b','red',1,0,amounts[1]),packet('c','blue',1,0,amounts[2])];
    const a=projectTroops(snapshot(batch),2000),b=projectTroops(snapshot([...batch].reverse()),2000);
    assert.deepEqual(counts(a.armies),counts(b.armies));
    assert.deepEqual(counts(a.armies),amounts[0]===5?{}:{a:6});
    assert.equal(a.collisions.length,1);
  }
});

test('Partial survivors can meet a later packet without disappearing or freezing early',()=>{
  const source=snapshot([packet('a','green',0,1,7),packet('b','red',1,0,3),packet('c','blue',1,0,2,1500)]),projection=createTroopProjection(source);
  assert.deepEqual(counts(projection.at(2000).armies),{a:4,c:2});
  assert.deepEqual(counts(projection.at(2249).armies),{a:4,c:2});
  assert.deepEqual(counts(projection.at(2250).armies),{a:2});
  assert.equal(projection.at(2250).collisions.length,2);
});

test('A new simulationAt rebase applies only new collisions, never old losses twice',()=>{
  const source=snapshot([packet('a','green',0,1,7),packet('b','red',1,0,3),packet('c','blue',1,0,2,1500)]);
  const first=projectTroops(source,2000),confirmed=snapshot(first.armies,2000),frozen=structuredClone(confirmed);
  assert.deepEqual(counts(projectTroops(confirmed,2000).armies),{a:4,c:2});
  assert.deepEqual(counts(projectTroops(confirmed,2250).armies),{a:2});
  assert.equal(projectTroops(confirmed,2250).collisions.length,1);
  assert.deepEqual(confirmed,frozen);
  const corrected=snapshot([packet('a','green',0,1,7)],2125);
  assert.deepEqual(counts(projectTroops(corrected,2200).armies),{a:7},'a correction replaces the projection, never mutates authoritative counts');
});

test('Projection starts after simulationAt, even when the response serverNow is later',()=>{
  const source=snapshot([packet('a','green',0,1,4,1000,2250),packet('b','red',1,0,4,1000,2250)],2000);
  source.serverNow=2200;
  assert.equal(projectTroops(source,2124).armies.length,2);
  assert.equal(projectTroops(source,2125).armies.length,0);
});

test('Curved roads and their reversed travel share exactly the same contact point',()=>{
  const a={x:30,y:230},b={x:180,y:40},c={x:-10,y:100};
  for(const t of [.1,.375,.5,.625,.9]) {
    const forward=pointOnRoad(a,b,c,t),reverse=pointOnRoad(b,a,c,1-t);
    assert.ok(Math.abs(forward.x-reverse.x)<1e-10);
    assert.ok(Math.abs(forward.y-reverse.y)<1e-10);
  }
});

test('One effect and one sound gate per geometric battle across render frames and confirmation',()=>{
  const gate=createBattleEffectGate(),predicted={type:'road-battle',edge:[0,1],at:2000,position:.625};
  assert.equal(gate.accept(predicted,1999),false);
  assert.equal(gate.accept(predicted,2000),true);
  assert.equal(gate.accept(predicted,2016),false);
  const confirmed={...predicted,id:'towerlink:81'};
  assert.equal(roadBattleEffectKey(predicted),roadBattleEffectKey(confirmed));
  assert.equal(gate.accept(confirmed,2400),false);
  assert.equal(gate.accept({...confirmed,at:2500,id:'towerlink:82'},2500),true);
  assert.equal(gate.accept({...confirmed,at:900,id:'towerlink:80'},2500),false,'stale battles do not replay on reconnect');
  gate.clear();
  assert.equal(gate.accept(predicted,2000),true,'a separate round can reuse event coordinates');
});

test('Differential: presentation agrees with authoritative road battles over 60 seeded scenarios',()=>{
  let randomState=0x5a7a;const random=n=>{randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return randomState%n;};
  for(let scenario=0;scenario<60;scenario++) {
    const state=engine.createState('0123456789abcdef0123456789abcdef',1000,{players:['p0','p1','p2','p3']});
    const [from,to]=state.edges[0],road=state.roads.find(r=>r.from===from&&r.to===to),duration=road.travelMs;
    state.simulationAt=2000;state.serverNow=2000;
    state.armies=Array.from({length:4+random(12)},(_,i)=>{const reverse=random(2);return packet(`s${scenario}:${i}`,'p'+random(4),reverse?to:from,reverse?from:to,1+random(8),1000+random(5)*125,duration);});
    // Start before any encounter; all packet departure times are already known.
    const earliest=1000+duration/2;
    state.simulationAt=Math.min(2000,Math.floor((earliest-1)/125)*125);state.serverNow=state.simulationAt;
    const before=engine.view(state,'p0'),projection=createTroopProjection(before),firstArrival=Math.min(...state.armies.map(a=>a.arrivesAt));
    for(let at=state.simulationAt+125;at<firstArrival;at+=125) {
      const projected=projection.at(at);engine.tick(state,at);
      assert.deepEqual(counts(projected.armies),counts(state.armies),`scenario ${scenario} at ${at}`);
      assert.deepEqual(projected.collisions.map(({at,position,casualties,survivors})=>({at,position,casualties,survivors})),state.events.filter(e=>e.type==='road-battle').map(({at,position,casualties,survivors})=>({at,position,casualties,survivors})));
    }
  }
});
