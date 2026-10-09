import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTrajectoryView,trajectoryBound} from '../arena/shared/trajectory-view.mjs';

test('irregular authority frames interpolate exact position, spin and pocket fade with reusable objects',()=>{
 const source=[{t:0,positions:[[0,0,0,1,0],[8,5,1,1,2]]},{t:40,positions:[[0,4,2,1,4],[8,9,3,0,6]]},{t:150,positions:[[0,8,6,1,8]]}];
 const before=JSON.stringify(source),view=createTrajectoryView(source,{withRoll:true});
 const sample=view.sample(20),ball=sample[0];
 assert.deepEqual({...ball},{n:0,x:2,y:1,alpha:1,roll:2});
 assert.equal(sample[1].alpha,.5);
 assert.equal(view.sample(39),sample);assert.equal(sample[0],ball,'no new ball object per frame');
 assert.equal(view.sample(40).some(p=>p.n===8),false,'pocketed frame removes the ball');
 assert.equal(view.sample(250)[0].x,8,'never extrapolate past authored trajectory');
 assert.equal(view.sample(-10)[0].x,0,'never extrapolate before first frame');
 const trail=view.trail(150,110);assert.deepEqual(trail,{start:1,end:3});assert.equal(view.trail(40,20),trail);
 assert.equal(JSON.stringify(source),before,'authoritative rows remain immutable');
});

test('Pool delta frames retain omitted rows; Carrom complete frames do not invent coins',()=>{
 const frames=[{t:0,positions:[[0,1,2,1,0],[1,5,6,1,0]]},{t:50,positions:[[0,3,4,1,1]]}];
 const pool=createTrajectoryView(frames,{expandDeltas:true,withRoll:true});
 assert.equal(pool.sample(50).length,2);assert.equal(pool.frames[1].positions.get(1)[1],5);
 const carrom=createTrajectoryView(frames,{idField:'id',kindForId:id=>id===0?'striker':'white'});
 assert.equal(carrom.sample(50).length,1);assert.equal(carrom.sample(25)[1].kind,'white');
 assert.equal(carrom.sample(0)[0].id,0);
 assert.deepEqual(createTrajectoryView([]).sample(100),[]);
 assert.equal(trajectoryBound(frames,0),0);assert.equal(trajectoryBound(frames,0,true),1);
 assert.equal(trajectoryBound(frames,51),2);
});
