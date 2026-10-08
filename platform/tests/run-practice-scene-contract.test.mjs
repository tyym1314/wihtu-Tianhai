import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../arena/run/engine.mjs';
import {build} from 'esbuild';
// Exercise the actual scene-owned pure selection helpers. Stub only asset URL
// imports; this test neither constructs WebGL nor loads image/model bytes.
const bundled=await build({stdin:{contents:`export {projectedPose,resolveRunPracticeSceneContext,sampleRunPracticeSceneFrame} from './arena/run/scene.mjs';`,resolveDir:new URL('../',import.meta.url).pathname},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent',plugins:[{name:'scene-contract-asset-urls',setup(b){
 b.onResolve({filter:/\?url$/},a=>({path:a.path,namespace:'scene-url'}));
 b.onLoad({filter:/.*/,namespace:'scene-url'},a=>({contents:`export default ${JSON.stringify(a.path)}`,loader:'js'}));
}}]});
const {projectedPose,resolveRunPracticeSceneContext,sampleRunPracticeSceneFrame}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);

function fixture(){
 const state=engine.createState('12'.repeat(32),1000,{ruleVersion:engine.PRACTICE_INPUT_RULE_VERSION,startPolicy:engine.RUN_SCENE_READY_POLICY,players:[{key:'human',seatIndex:0,isBot:false},{key:'bot',seatIndex:1,isBot:true}]});
 engine.armStart(state,1000);engine.tick(state,1400);
 const game=engine.view(state,'human'),a={protocol:'run-practice-inputs-v1',ruleVersion:game.ruleVersion,roomId:'room',playerKey:'human',clockEpoch:1,revision:3,headTick:game.snapshotTick,serverTick:game.snapshotTick,committedThroughTick:0,resultAuthorization:null,
  selfReplay:{schema:'run-practice-self-replay-v1',anchorTick:0,player:{key:'human'},acceptedCommands:[]}};
 const room={id:'room',me:'human',game_id:'run',practice:true,entry_minor:'0',game,run_inputs:a};
 const mine=game.players.find(p=>p.key==='human');let calls=0;
 const snapshot={mode:'provisional',reason:null,headTick:a.headTick,revision:a.revision,authorityExpired:false,provisionalTick:a.headTick+1,resultAuthorization:null,
  pose:{...projectedPose(mine,game,0),distance:mine.distance+.1,tick:game.snapshotTick+1,eventTick:game.snapshotTick,visualSpeed:8,visualPlayer:{...mine}}};
 const controller={scope:Object.freeze({roomId:'room',playerKey:'human',clockEpoch:1}),sample(now){calls++;assert.ok(Number.isFinite(now));return snapshot;},state(){assert.fail('state() must not run in scene binding or sampling');}};
 const options={roomId:'room',practiceRoom:room,practiceController:controller};
 return {game,room,a,mine,controller,snapshot,options,calls:()=>calls};
}

test('only explicit free V2.3 room and controller scopes can provide the own pose',()=>{
 const f=fixture(),context=resolveRunPracticeSceneContext(f.game,'human',f.options);
 assert.equal(context.controller,f.controller);assert.equal(context.room,f.room);
 const frame=sampleRunPracticeSceneFrame(f.game,'human',context,1500);
 assert.equal(frame.pose.distance,f.snapshot.pose.distance);assert.equal(frame.pose.eventTick,f.snapshot.pose.eventTick);assert.equal(f.calls(),1);
 const old=fixture();old.game.ruleVersion=engine.PRACTICE_RULE_VERSION;
 assert.equal(resolveRunPracticeSceneContext(old.game,'human',old.options),null);assert.equal(old.calls(),0);
 for(const update of [{practice:false},{entry_minor:'1000'},{me:'other'},{id:'other'}]){
  const q=fixture();Object.assign(q.room,update);assert.equal(resolveRunPracticeSceneContext(q.game,'human',q.options),null);assert.equal(q.calls(),0);
 }
});

test('room/game identity, player, epoch and revision bindings fail closed without reading controller history',()=>{
 for(const change of [f=>f.room.game={...f.game},f=>f.a.roomId='other',f=>f.a.playerKey='other',f=>f.a.clockEpoch=0,f=>f.a.revision=-1,f=>f.a.headTick++,f=>f.a.committedThroughTick=f.a.serverTick+1]){
  const f=fixture();change(f);assert.equal(resolveRunPracticeSceneContext(f.game,'human',f.options),null);assert.equal(f.calls(),0);
 }
 for(const scope of [{roomId:'other',playerKey:'human',clockEpoch:1},{roomId:'room',playerKey:'other',clockEpoch:1},{roomId:'room',playerKey:'human',clockEpoch:2}]){
  const f=fixture();f.controller.scope=Object.freeze(scope);const ctx=resolveRunPracticeSceneContext(f.game,'human',f.options);
  assert.equal(ctx.controller,null);const frame=sampleRunPracticeSceneFrame(f.game,'human',ctx,999999);
  assert.equal(frame.mode,'authority-static');assert.equal(frame.pose.distance,f.mine.distance);assert.equal(f.calls(),0);
 }
});

test('missing replay proof or controller holds the received position at any time, including arming',()=>{
 for(const change of [f=>delete f.a.selfReplay,f=>f.a.selfReplay.schema='unknown',f=>delete f.options.practiceController,f=>{f.game.phase='arming';delete f.room.run_inputs;}]){
  const f=fixture();change(f);const ctx=resolveRunPracticeSceneContext(f.game,'human',f.options);
  const early=sampleRunPracticeSceneFrame(f.game,'human',ctx,1400),later=sampleRunPracticeSceneFrame(f.game,'human',ctx,999999);
  assert.equal(later.mode,'authority-static');assert.equal(later.authorityExpired,true);assert.deepEqual(later.pose,early.pose);assert.equal(later.pose.distance,f.mine.distance);assert.equal(later.pose.visualSpeed,0);assert.equal(f.calls(),0);
 }
});

test('stale or absent controller pose cannot replace the current authority snapshot',()=>{
 for(const change of [s=>s.revision--,s=>s.headTick--,s=>s.pose=null,s=>s.pose.distance=NaN]){
  const f=fixture();change(f.snapshot);const frame=sampleRunPracticeSceneFrame(f.game,'human',resolveRunPracticeSceneContext(f.game,'human',f.options),2000);
  assert.equal(frame.mode,'authority-static');assert.equal(frame.pose.distance,f.mine.distance);assert.equal(f.calls(),1);
 }
});

test('a newer validated controller revision can render before its React snapshot commit without falling back backwards',()=>{
 const f=fixture(),ctx=resolveRunPracticeSceneContext(f.game,'human',f.options);
 f.snapshot.revision++;f.snapshot.headTick++;f.snapshot.pose.distance+=.2;
 const frame=sampleRunPracticeSceneFrame(f.game,'human',ctx,1500);
 assert.equal(frame.mode,'provisional');assert.equal(frame.pose.distance,f.snapshot.pose.distance);assert.equal(frame.resultAuthorized,false);
});

test('predicted finish never opens the finish camera; individual committed finish need not await final rankings',()=>{
 const f=fixture();f.snapshot.pose.visualPlayer.finishTick=20;f.snapshot.pose.visualPlayer.finishedAt=1300;
 const ctx=resolveRunPracticeSceneContext(f.game,'human',f.options);
 let frame=sampleRunPracticeSceneFrame(f.game,'human',ctx,1500);
 assert.equal(frame.pose.visualPlayer.finishTick,null);assert.equal(frame.resultAuthorized,false);
 f.mine.finishTick=20;f.mine.finishedAt=1300;f.a.committedThroughTick=19;
 frame=sampleRunPracticeSceneFrame(f.game,'human',ctx,1510);assert.equal(frame.pose.visualPlayer.finishTick,null);
 f.a.committedThroughTick=20;frame=sampleRunPracticeSceneFrame(f.game,'human',ctx,1520);
 assert.equal(frame.pose.visualPlayer.finishTick,20);assert.equal(frame.pose.visualPlayer.finishedAt,1300);assert.equal(frame.resultAuthorized,false);
 assert.equal(f.snapshot.pose.visualPlayer.finishTick,20,'sample is not mutated by finish masking');
});

test('winner animation requires the exact committed result authorization, independent from individual finish',()=>{
 const f=fixture(),ctx=resolveRunPracticeSceneContext(f.game,'human',f.options);
 const auth={key:`room/1/${f.a.headTick}`,clockEpoch:1,revision:f.a.revision,terminalTick:f.a.headTick,committedThroughTick:f.a.headTick};
 f.a.committedThroughTick=f.a.headTick;f.a.resultAuthorization=auth;
 assert.equal(sampleRunPracticeSceneFrame(f.game,'human',ctx,1500).resultAuthorized,false);
 f.snapshot.resultAuthorization=auth;
 assert.equal(sampleRunPracticeSceneFrame(f.game,'human',ctx,1510).resultAuthorized,true);
 f.a.resultAuthorization={...auth,clockEpoch:2};assert.equal(sampleRunPracticeSceneFrame(f.game,'human',ctx,1520).resultAuthorized,false);
});
