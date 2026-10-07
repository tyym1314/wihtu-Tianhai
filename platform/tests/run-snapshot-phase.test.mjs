import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../arena/run/engine.mjs';
import {projectedPose,createRunSnapshotClock,RUN_PROJECTION_LIMIT_MS} from '../arena/run/presentation.mjs';
const base=()=>engine.view(engine.createState('02'.repeat(32),10000,{players:[{key:'p0',seatIndex:0},{key:'p1',seatIndex:1}]}),'p0');
const atTick=(tick,extra={})=>{const game={...base(),snapshotTick:tick};game.players=game.players.map(p=>({...p,distance:tick*40/300,...extra}));return game;};
const near=(a,b)=>assert(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('a newer snapshot cannot be evaluated before its receipt by an older RAF timestamp',()=>{
 // Android public06: the frame timestamp was 8.8 ms earlier than the new
 // snapshot callback, after the preceding snapshot reached its 650 ms cap.
 const clock=createRunSnapshotClock(),old=atTick(2647,{distance:314.26666666666665});
 clock.receive(old,47071.9);
 const before=projectedPose(old.players[0],old,clock.elapsed(47775.5));
 const next=atTick(2677,{distance:318.26666666666665});
 clock.receive(next,47801);
 const atReceipt=projectedPose(next.players[0],next,clock.elapsed(47801));
 const staleFrame=projectedPose(next.players[0],next,clock.elapsed(47792.2));
 near(before.tick,2686);near(atReceipt.tick,2686);
 assert.deepEqual(staleFrame,atReceipt);
 near(staleFrame.distance,before.distance);
 assert(projectedPose(next.players[0],next,clock.elapsed(47808.9)).distance>staleFrame.distance);
});
test('old frame timestamps and duplicate receipts do not extend a carried projection budget',()=>{
 const clock=createRunSnapshotClock(),old=atTick(0),next=atTick(30);
 clock.receive(old,0);clock.receive(next,750);
 near(clock.elapsed(741.2),150);
 clock.receive(next,900);
 near(clock.elapsed(891.2),300);
 const atLimit=projectedPose(next.players[0],next,650);
 assert.deepEqual(projectedPose(next.players[0],next,clock.elapsed(1250)),atLimit);
 clock.receive(next,2000);
 assert.deepEqual(projectedPose(next.players[0],next,clock.elapsed(1991.2)),atLimit);
 assert.equal(clock.receive(atTick(29),2100),false);
 assert.deepEqual(projectedPose(next.players[0],next,clock.elapsed(20000)),atLimit);
});
test('old RAF timestamps do not defer authoritative fall or finish corrections',()=>{
 for(const correction of [{distance:49,speed:0,fallStartTick:115,fallUntilTick:205},
                          {distance:480,speed:0,finishTick:115}]){
  const clock=createRunSnapshotClock(),old=atTick(100,{distance:50});clock.receive(old,0);
  const next=atTick(115,correction);clock.receive(next,400);
  const result=projectedPose(next.players[0],next,clock.elapsed(391.2));
  assert.deepEqual(result,projectedPose(next.players[0],next,clock.elapsed(400)));
  near(result.distance,correction.distance);
 }
});

test('150 ms reads / 250 ms publications / varying RTT do not rewind unobstructed motion',()=>{
 const delays=[18,95,27,74,12,110,36,89,7,66],events=[];
 for(let sent=0,index=0;sent<=18000;sent+=150,index++){const tick=Math.floor(Math.floor(sent/250)*250*.06);events.push({at:sent+delays[index%delays.length],game:atTick(tick)});}
 const clock=createRunSnapshotClock();let index=0,game,previous=-Infinity,oldReceived=0,oldTick=-1,oldPrevious=-Infinity,oldRewinds=0,maxAhead=0;
 for(let at=0;at<18000;at+=5){
  while(index<events.length&&events[index].at<=at){const event=events[index++];clock.receive(event.game,event.at);if(event.game.snapshotTick>oldTick){oldTick=event.game.snapshotTick;oldReceived=event.at;}game=event.game;}
  if(!game)continue;
  const pose=projectedPose(game.players[0],game,clock.elapsed(at)),oldPose=projectedPose(game.players[0],game,at-oldReceived);
  assert(pose.distance>=previous-1e-8,`backward at ${at} ms: ${previous} → ${pose.distance}`);assert(pose.tick-game.snapshotTick<=39+1e-8);maxAhead=Math.max(maxAhead,pose.tick-game.snapshotTick);previous=pose.distance;
  if(oldPose.distance<oldPrevious-1e-8)oldRewinds++;oldPrevious=oldPose.distance;
 }
 assert(oldRewinds>10,'the same jitter schedule must expose the previous reset-to-zero bug');assert(maxAhead<39,'normal delivery must not spend its whole disconnection budget');
});
test('new snapshot retains consumed phase instead of resetting an already passed tick',()=>{
 const clock=createRunSnapshotClock();clock.receive(atTick(42),0);near(projectedPose(atTick(42).players[0],atTick(42),clock.elapsed(400)).tick,66);
 clock.receive(atTick(60),400);near(clock.elapsed(400),100);near(projectedPose(atTick(60).players[0],atTick(60),clock.elapsed(400)).tick,66);
});
test('duplicate/old ticks cannot renew carried phase or extend the 650 ms budget',()=>{
 const clock=createRunSnapshotClock();clock.receive(atTick(0),0);clock.receive(atTick(15),400);const receivedElapsed=clock.elapsed(400);clock.receive(atTick(15),500);near(clock.elapsed(500),receivedElapsed+100);assert.equal(clock.receive(atTick(14),550),false);
 const game=atTick(15),limit=projectedPose(game.players[0],game,RUN_PROJECTION_LIMIT_MS);assert.deepEqual(projectedPose(game.players[0],game,clock.elapsed(10000)),limit);
 clock.receive(atTick(16),10000);const next=atTick(16),pose=projectedPose(next.players[0],next,clock.elapsed(10000));near(pose.tick,54);near(pose.tick-next.snapshotTick,38);near(projectedPose(next.players[0],next,clock.elapsed(20000)).tick,55);
});
test('authority that jumps beyond projected time is accepted without a hidden lerp or distance clamp',()=>{
 const clock=createRunSnapshotClock();clock.receive(atTick(10),0);clock.receive(atTick(500),100);near(clock.elapsed(100),0);const game=atTick(500);near(projectedPose(game.players[0],game,clock.elapsed(100)).distance,game.players[0].distance);
});
test('carried time does not mask real collision or checkpoint corrections',()=>{
 const clock=createRunSnapshotClock(),old=atTick(100,{distance:50});clock.receive(old,0);const predicted=projectedPose(old.players[0],old,clock.elapsed(400));
 const hit=atTick(115,{distance:49,speed:0,stunUntilTick:160});clock.receive(hit,400);const afterHit=projectedPose(hit.players[0],hit,clock.elapsed(400));assert(afterHit.distance<predicted.distance);near(afterHit.distance,49);
 const respawn=atTick(130,{distance:30,checkpoint:30,fallUntilTick:null});clock.receive(respawn,800);const afterRespawn=projectedPose(respawn.players[0],respawn,clock.elapsed(800));assert(afterRespawn.distance<afterHit.distance);assert(afterRespawn.distance>=30);
});
