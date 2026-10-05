import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateRoll,PIN_LAYOUT,PHYSICS_VERSION} from '../arena/bowling/physics.mjs';
import * as engine from '../arena/bowling/engine.mjs';
import {offsetAt,swipeRoll} from '../arena/bowling/input.mjs';
const pins=PIN_LAYOUT.map(p=>p.id),base={type:'roll',offset:0,angle:0,power:.78,spin:0};
test('public physics results survive JSON persistence without signed-zero drift',()=>{
 for(const action of[base,{...base,offset:.24,power:1},{...base,angle:-.2}]){
  const result=simulateRoll(pins,action);assert.deepEqual(result,JSON.parse(JSON.stringify(result)));
 }
});
test('centre no longer guarantees strikes across low, default and maximum power',()=>{
 const counts=[.25,.35,.6,.65,.78,1].map(power=>{const r=simulateRoll(pins,{...base,power});assert.equal(r.outcome,'settled');return r.down.length;});
 assert.ok(counts.every(n=>n>0&&n<10));assert.ok(new Set(counts).size>=3);
});
test('left and right pocket shots can strike through collision without scoring correction',()=>{
 for(const offset of[-.2,.24]){const a={...base,offset,power:1},r=simulateRoll(pins,a);assert.equal(r.outcome,'settled');assert.equal(r.down.length,10);assert.ok(r.events.some(e=>e.type==='hit'));assert.deepEqual(simulateRoll(pins,a),r);}
});
test('large angles physically miss into both gutters and cannot score by reentry',()=>{
 for(const angle of[-.2,.2]){const r=simulateRoll(pins,{...base,angle});assert.equal(r.gutter,true);assert.deepEqual(r.down,[]);assert.equal(r.contact,false);}
});
test('touch preview and release use the same start offset, direction and power',()=>{
 const offset=offsetAt(240,0,390),start={x:240,y:600,offset};
 const straight=swipeRoll(start,{x:240,y:450},.1),right=swipeRoll(start,{x:300,y:450},.1),left=swipeRoll(start,{x:180,y:450},.1);
 assert.equal(straight.offset,offset);assert.equal(straight.angle,0);assert.equal(right.angle,-left.angle);assert.ok(right.angle>0);assert.equal(right.power,straight.power);assert.equal(straight.spin,.1);
 assert.equal(swipeRoll(start,{x:240,y:585}),null);
 assert.equal(offsetAt(-100,0,390),-.85);assert.equal(offsetAt(500,0,390),.85);
});
test('pinned old accepted result is revealed unchanged and new-version actions are rejected',()=>{
 const s=engine.createState('a'.repeat(64),1000,{players:[{key:'p0',seatIndex:0},{key:'p1',seatIndex:1}]});
 assert.equal(PHYSICS_VERSION,'bowling-rigid-v1.1.0');s.ruleVersion='pvp-bowling-v1.0.0';s.physicsVersion='bowling-rigid-v1.0.0';
 const p=s.players[0];p.shotId=1;p.shotStartedAt=2000;p.busyUntil=3000;p.pending={down:[...pins],remaining:[],gutter:false};p.trajectory=[{t:0,b:[0,.215,1.2,0,0,0,1],p:[]}];const accepted=structuredClone(p.trajectory);
 assert.throws(()=>engine.act(s,'p0',base,2100),{code:'PINNED_RULE_UNAVAILABLE'});engine.tick(s,3000);assert.deepEqual(p.frames,[[10],[],[]]);assert.deepEqual(p.trajectory,accepted);assert.equal(s.ruleVersion,'pvp-bowling-v1.0.0');
});
test('late pocket pin motion settles naturally beyond the old ten-second cap',()=>{
 for(const[offset,power]of[[-.22,.6],[-.28,.9],[.16,.9]]){const r=simulateRoll(pins,{...base,offset,power});assert.equal(r.outcome,'settled');assert.ok(r.duration>10000&&r.duration<=15000);assert.equal(r.maxPinSpeed,0);assert.equal(r.maxPinAngular,0);}
});
