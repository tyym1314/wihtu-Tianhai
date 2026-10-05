import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../arena/run/engine.mjs';
import {projectedPose,createRunSnapshotClock,RUN_PROJECTION_LIMIT_MS} from '../arena/run/presentation.mjs';

const initial=()=>E.view(E.createState('02'.repeat(32),10000,{players:[{key:'p0',seatIndex:0},{key:'p1',seatIndex:1}]}),'p0');
test('ordinary 350/400/600 ms snapshot intervals keep presentation moving between responses',()=>{
 for(const interval of [350,400,600]){
  const clock=createRunSnapshotClock();let game=initial(),previous=-1;
  for(let time=0;time<2400;time+=10){
   if(time%interval===0){game={...game,snapshotTick:time*.06,players:game.players.map(p=>({...p,distance:time*.008}))};clock.receive(game,time);}
   const pose=projectedPose(game.players[0],game,clock.elapsed(time));
   assert.ok(pose.distance>previous,`Visual stall at ${time} ms with ${interval} ms receipts`);previous=pose.distance;
  }
 }
});
test('network outage holds after bounded projection and repeated/old snapshots do not reset its clock',()=>{
 const game=initial(),clock=createRunSnapshotClock();clock.receive(game,100);
 assert.equal(clock.receive(game,500),true);assert.equal(clock.elapsed(600),500);
 const stale={...game,snapshotTick:-1};assert.equal(clock.receive(stale,700),false);
 const atLimit=projectedPose(game.players[0],game,RUN_PROJECTION_LIMIT_MS);
 assert.deepEqual(projectedPose(game.players[0],game,5000),atLimit);
 assert.equal(atLimit.distance,8*RUN_PROJECTION_LIMIT_MS/1000);
 assert.equal(game.snapshotTick,0,'Presentation never modifies the tick submitted to the server');
});
test('fall, stopped runner, finish and course boundary remain bounded by authoritative state',()=>{
 const g=initial(),p=g.players[0];
 assert.equal(projectedPose({...p,speed:0,distance:21},g,600).distance,21);
 assert.equal(projectedPose({...p,speed:0,distance:480,finishTick:0},g,600).distance,480);
 assert.equal(projectedPose({...p,distance:479},g,600).distance,480);
 const falling=projectedPose({...p,distance:21,fallStartTick:0,fallUntilTick:90},g,600);
 assert.equal(falling.distance,21);assert.ok(falling.y<0);assert.ok(falling.scale>0);
 assert.deepEqual(projectedPose(p,g,-100),projectedPose(p,g,0));
});
