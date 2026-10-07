import test from 'node:test';
import assert from 'node:assert/strict';
import * as current from '../arena/run/engine.mjs';
import * as legacy from '../arena/run/engine-v1.mjs';
import {activityRoomState,canExercise,canExerciseRunJump,runContinuousActions} from '../scripts/mobile-continuous-driver.mjs';
function fixture(engine=current){
 const state=engine.createState('a'.repeat(64),1000,{players:[{key:'a',seatIndex:0},{key:'b',seatIndex:1}]});
 const room=()=>({id:'run-room',game_id:'run',status:'active',me:'a',me_last_seq:1,server_now:state.now,game:engine.view(state,'a')});
 return{engine,state,room,at:tick=>engine.tick(state,1000+Math.ceil(tick*1000/60))};
}
for(const engine of [current,legacy]){
 const version=engine===current?current.PREVIOUS_RULE_VERSION:engine.RULE_VERSION;
 test(version+': pending first jump and airborne snapshots block a second UI jump until the authoritative admission tick',()=>{
  const f=fixture(engine);engine.act(f.state,'a',{type:'jump'},1000);assert.equal(canExercise('run',f.room()),false);
  f.at(1);assert.equal(canExercise('run',f.room()),false);
  f.at(47);assert.equal(canExercise('run',f.room()),false);assert.throws(()=>engine.act(structuredClone(f.state),'a',{type:'jump'},f.state.now),{code:'ALREADY_JUMPING'});
  f.at(48);assert.equal(canExercise('run',f.room()),true);assert.doesNotThrow(()=>engine.act(structuredClone(f.state),'a',{type:'jump'},f.state.now));
 });
 test(version+': slide admission boundary agrees with the actual engine',()=>{
  const f=fixture(engine);engine.act(f.state,'a',{type:'slide'},1000);f.at(35);assert.equal(canExerciseRunJump(f.room()),false);assert.throws(()=>engine.act(structuredClone(f.state),'a',{type:'jump'},f.state.now),{code:'SLIDING'});f.at(36);assert.equal(canExerciseRunJump(f.room()),true);assert.doesNotThrow(()=>engine.act(structuredClone(f.state),'a',{type:'jump'},f.state.now));
 });
 test(version+': collision stun waits until the actual input-admission tick',()=>{
  const f=fixture(engine);f.state.players[0].stunUntilTick=4;f.at(2);assert.equal(canExerciseRunJump(f.room()),false);assert.throws(()=>engine.act(structuredClone(f.state),'a',{type:'jump'},f.state.now),{code:'BUSY'});f.at(3);assert.equal(canExerciseRunJump(f.room()),true);assert.doesNotThrow(()=>engine.act(structuredClone(f.state),'a',{type:'jump'},f.state.now));
 });
 test(version+': fall recovery requires an observed respawn, not guessed elapsed wall time',()=>{
  const f=fixture(engine);f.state.players[0].fallStartTick=0;f.state.players[0].fallUntilTick=3;f.at(2);assert.equal(canExerciseRunJump(f.room()),false);const stale=f.room();stale.server_now+=10000;assert.equal(canExerciseRunJump(stale),false);f.at(3);assert.equal(canExerciseRunJump(f.room()),true);assert.doesNotThrow(()=>engine.act(structuredClone(f.state),'a',{type:'jump'},f.state.now));
 });
}
test('v2.1 continuous jump waits for scene arming and shared countdown, then accepts racing',()=>{
 const state=current.createState('a'.repeat(64),1000,{ruleVersion:current.RULE_VERSION,startPolicy:current.RUN_SCENE_READY_POLICY,players:[{key:'a',seatIndex:0},{key:'b',seatIndex:1}]});
 const room=()=>({id:'run-room',game_id:'run',status:'active',me:'a',me_last_seq:1,server_now:state.now,game:current.view(state,'a')});
 assert.equal(canExercise('run',room()),false);
 current.armStart(state,1000);
 assert.equal(canExercise('run',room()),false);
 current.tick(state,state.startedAt);
 assert.equal(canExercise('run',room()),true);
});
test('lane input rate limit is checked when the public input event identifies its tick',()=>{const f=fixture();current.act(f.state,'a',{type:'left'},1000);f.at(1);assert.equal(canExerciseRunJump(f.room()),false);assert.throws(()=>current.act(structuredClone(f.state),'a',{type:'jump'},f.state.now),{code:'RATE_LIMIT'});f.at(6);assert.equal(canExerciseRunJump(f.room()),true);assert.doesNotThrow(()=>current.act(structuredClone(f.state),'a',{type:'jump'},f.state.now));});
for(const [name,change]of [
 ['countdown',r=>r.server_now=r.game.startedAt-1],['deadline',r=>r.server_now=r.game.deadlineAt],
 ['finished player',r=>r.game.players[0].finishTick=0],['forfeited player',r=>r.game.players[0].forfeited=true],
 ['finished game',r=>r.game.status='finished'],['fault phase',r=>r.game.phase='fault'],
 ['unknown rule',r=>r.game.ruleVersion='future-unreviewed'],['missing tick',r=>delete r.game.snapshotTick],
 ['missing jump state',r=>delete r.game.players[0].jumpStartTick],['missing pending input acknowledgement',r=>delete r.game.players[0].appliedInputNo],
 ['missing own player',r=>r.game.players.shift()],
])test('Run continuous jump rejects '+name,()=>{const r=fixture().room();change(r);assert.equal(canExercise('run',r),false);});
test('finish-window permits a remaining active runner, without continuing after that runner finishes',()=>{const f=fixture();f.state.phase='finish-window';f.state.players[1].finishTick=0;assert.equal(canExercise('run',f.room()),true);f.state.players[0].finishTick=0;assert.equal(activityRoomState(f.room(),'run','run-room'),'terminal');assert.equal(canExercise('run',f.room()),false);});
test('a first-action ACK ahead of the observed snapshot cannot trigger another trusted action',async()=>{
 let time=0,sequence=0;const calls=[],f=fixture();const room=()=>({...f.room(),me_last_seq:sequence});
 const result=await runContinuousActions({game:'run',roomId:'run-room',initialSequence:1,readRoom:room,deadlineAt:1000,minimumActionBudgetMs:100,clock:()=>time,sleep:async ms=>{time+=ms;if(time>=250)sequence=1;},playAction:async controls=>{await controls.beforeAction();calls.push(time);sequence++;return{roomId:'run-room',sequenceBefore:sequence-1,sequenceAfter:sequence};}});
 assert.deepEqual(calls,[250]);assert.equal(result.initial_sequence,1);assert.equal(result.reason,'deadline');assert.equal(result.rejections.length,0);
});
test('ALREADY_JUMPING remains a recorded hard driver failure instead of a retry whitelist entry',async()=>{
 let calls=0;const f=fixture();const result=await runContinuousActions({game:'run',roomId:'run-room',readRoom:f.room,deadlineAt:3000,clock:()=>0,playAction:async()=>{calls++;throw Object.assign(Error('unexpected double jump'),{code:'ALREADY_JUMPING',status:409});}});assert.equal(calls,1);assert.equal(result.reason,'action-failed');assert.equal(result.rejections[0].code,'ALREADY_JUMPING');
});
