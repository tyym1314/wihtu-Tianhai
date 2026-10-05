import test from 'node:test';
import assert from 'node:assert/strict';
import * as current from '../arena/run/engine.mjs';
import * as legacy from '../arena/run/engine-v1.mjs';
import {projectedPose,createRunSnapshotClock,RUN_PROJECTION_LIMIT_MS} from '../arena/run/presentation.mjs';

const versions=[current,legacy],near=(actual,expected,label)=>assert(Math.abs(actual-expected)<1e-8,`${label}: ${actual} != ${expected}`);
function fixture(engine,{tick=739,stun=740,boost=0}={}){
 const state=engine.createState('02'.repeat(32),10000,{players:[{key:'p0',seatIndex:0},{key:'p1',seatIndex:1}]});state.tick=tick;state.now=10000+Math.ceil(tick*1000/60);const p=state.players[0];p.distanceU=300;p.stunUntilTick=stun;p.boostUntilTick=boost;return{state,game:engine.view(state,'p0')};
}
for(const engine of versions){
 test(`${engine.RULE_VERSION}: stun and boost boundaries match actual engine integer steps`,()=>{
  for(const {tick,stun,boost}of[{tick:739,stun:740,boost:0},{tick:100,stun:103,boost:105},{tick:100,stun:103,boost:102},{tick:100,stun:0,boost:103},{tick:100,stun:140,boost:160}]){
   const {state,game}=fixture(engine,{tick,stun,boost}),serialized=JSON.stringify(game);
   for(let delta=0;delta<=39;delta++){
    const oracle=structuredClone(state);for(let i=0;i<delta;i++)engine.testing.step(oracle);
    near(projectedPose(game.players[0],game,delta*1000/60).distance,oracle.players[0].distanceU/300,`stun=${stun} boost=${boost} tick=${tick+delta}`);
   }
   assert.equal(JSON.stringify(game),serialized,'projection cannot rewrite accepted authority');
  }
 });
 test(`${engine.RULE_VERSION}: no early recovery; boundary includes precisely one authoritative step`,()=>{
  const {game}=fixture(engine),p=game.players[0],boundary=1000/60;
  near(projectedPose(p,game,boundary-.001).distance,p.distance,'immediately before recovery');
  near(projectedPose(p,game,boundary).distance,p.distance+40/300,'recovery integer step');
  near(projectedPose(p,game,boundary+.001).distance,p.distance+40/300+.001*.008,'immediately after recovery');
 });
 test(`${engine.RULE_VERSION}: boost expiry uses the base increment on the threshold step`,()=>{
  const {game}=fixture(engine,{tick:100,stun:0,boost:102}),p=game.players[0];
  near(projectedPose(p,game,1000/60).distance,p.distance+48/300,'last boosted step');
  near(projectedPose(p,game,2000/60).distance,p.distance+(48+40)/300,'expiry step');
 });
 test(`${engine.RULE_VERSION}: duplicate/old snapshots cannot extend a recovery prediction beyond 650 ms`,()=>{
  const {game}=fixture(engine),p=game.players[0],clock=createRunSnapshotClock();clock.receive(game,100);clock.receive(game,600);
  assert.equal(clock.elapsed(750),650);const limit=projectedPose(p,game,RUN_PROJECTION_LIMIT_MS);
  assert.deepEqual(projectedPose(p,game,5000),limit);assert.equal(clock.receive({...game,snapshotTick:738},1000),false);assert.deepEqual(projectedPose(p,game,clock.elapsed(5100)),limit);
 });
 test(`${engine.RULE_VERSION}: fall waits for authority; slide does not remove stun or slow travel`,()=>{
  const {game}=fixture(engine),p=game.players[0];
  const falling={...p,fallStartTick:650,fallUntilTick:740,checkpoint:0};assert.equal(projectedPose(falling,game,600).distance,p.distance,'even known fall expiry does not fabricate respawn');
  const sliding={...p,sliding:true,slideUntilTick:745};near(projectedPose(sliding,game,100).distance,projectedPose(p,game,100).distance,'slide speed semantics');
 });
}
test('unexplained zero speed and inactive/unknown profiles never infer a recovery',()=>{
 const {game}=fixture(current,{stun:0}),p=game.players[0];
 for(const [player,g]of[[{...p,speed:0},game],[{...p,forfeited:true},game],[{...p,finishTick:739},game],[p,{...game,status:'finished'}],[p,{...game,status:'waiting'}],[p,{...game,serverNow:9999,startedAt:10000}],[p,{...game,ruleVersion:'unknown'}],[p,{...game,physicsVersion:'unknown'}]])assert.equal(projectedPose(player,g,600).distance,p.distance);
});
