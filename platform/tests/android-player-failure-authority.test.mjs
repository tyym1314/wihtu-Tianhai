import test from 'node:test';
import assert from 'node:assert/strict';
import {failureAuthority,capturePerformanceRoundFailure} from '../scripts/android-player-performance.mjs';
import {assertOwnedPlayerArenaState} from '../scripts/android-player-acceptance-checks.mjs';
import {assertPerformanceRoom,activeMotionState,hash} from '../scripts/android-player-performance-checks.mjs';

// Original-response shape fixtures only. No device, browser, network or game is run.
const game='run',baseline={appId:'app_fixture',externalUserId:'player_fixture'};
function fixture(){
 const identity={game,sessionId:'session_fixture',playerId:baseline.externalUserId,appId:baseline.appId};
 return {...identity,androidBaseline:{...identity},ownedRooms:new Set(['room_fixture']),creations:[{game,practice:true,entry:'0'}],probabilityRequests:[],room:{id:'room_fixture',game_id:game,me:baseline.externalUserId,status:'waiting',version:1,server_now:1000,me_last_seq:0,practice:true,entry_minor:'0',fee_bps:0,players:[{external_user_id:baseline.externalUserId,bot:false},{external_user_id:'bot_fixture',bot:true}],game:null}};
}
const options={game,baseline};

// Frozen predecessor: its SHA locks the successful active-room projection to
// the exact implementation before the waiting-null exception was introduced.
function originalFailureAuthority(state,{game,baseline}){
 assertOwnedPlayerArenaState(state,baseline);assertPerformanceRoom(state.room,{game,baseline,ownedRooms:state.ownedRooms});
 const room=state.room,g=room.game,own=g.me&&typeof g.me==='object'?g.me:g.players?.find?.(player=>player.key===room.me),inputs=room.run_inputs;
 const scalar=(source,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(source||{},key)).map(key=>{const value=source[key];assert.ok(value===null||['number','boolean','string'].includes(typeof value),'FAILED_ROUND_AUTHORITY_NONSCALAR');return[key,value];}));
 return {schema:'owned-performance-failure-authority-v1',source:'Latest retained original authorized room reply; no additional request or mutation',authoritySha256:hash(JSON.stringify(room)),roomIdHash:hash(room.id),playerKeyHash:hash(room.me),sessionIdHash:hash(state.sessionId),room:scalar(room,['status','version','server_now','me_last_seq','practice','entry_minor']),game:scalar(g,['status','phase','ruleVersion','snapshotTick','startedAt','serverNow','deadlineAt']),own:scalar(own,['inputNo','appliedInputNo','lastInputTick','jumpStartTick','slideUntilTick','stunUntilTick','fallStartTick','fallUntilTick','finishTick','forfeited','distanceU','distance','checkpointU','checkpoint']),runInputs:inputs?scalar(inputs,['protocol','profileId','ruleVersion','clockEpoch','revision','headTick','serverTick','committedThroughTick','processedThroughCommandSeq','acceptedInputNo']):null};
}

test('a retained owned free waiting-room view with game:null produces explicit null engine/own evidence without mutation or active motion',()=>{
 const state=fixture(),original=JSON.stringify(state.room),snapshot=failureAuthority(state,options);
 assert.throws(()=>originalFailureAuthority(state,options),/Cannot read properties of null/);
 assert.equal(snapshot.game,null);assert.equal(snapshot.own,null);assert.equal(snapshot.runInputs,null);
 assert.deepEqual(snapshot.room,{status:'waiting',version:1,server_now:1000,me_last_seq:0,practice:true,entry_minor:'0'});
 assert.equal(snapshot.authoritySha256,hash(original));assert.equal(snapshot.roomIdHash,hash(state.room.id));assert.equal(snapshot.playerKeyHash,hash(state.room.me));assert.equal(snapshot.sessionIdHash,hash(state.sessionId));assert.equal(JSON.stringify(state.room),original);
 assert.deepEqual(activeMotionState(game,state.room),{active:false,moving:false,reason:'not-active'});assert.equal(state.room.status,'waiting');
});

test('active engine.me and engine.players authority retain the exact predecessor fields and hashes',()=>{
 const predecessor=originalFailureAuthority.toString().replace('originalFailureAuthority','failureAuthority');assert.equal(hash(predecessor),'ec5f63956a259150eeb78b40cde5ac798c64c100bdc90d23aa62b671b930410b');
 const own={key:baseline.externalUserId,inputNo:1,appliedInputNo:2,lastInputTick:3,jumpStartTick:4,slideUntilTick:5,stunUntilTick:6,fallStartTick:null,fallUntilTick:null,finishTick:null,forfeited:false,distanceU:7,distance:8,checkpointU:9,checkpoint:10,unprojected:'kept only in raw hash'};
 for(const projection of [{me:own},{players:[{key:'bot_fixture',inputNo:99},own]}]){
  const state=fixture();state.room.status='active';state.room.game={status:'active',phase:'racing',ruleVersion:'fixture-v1',snapshotTick:11,startedAt:12,serverNow:13,deadlineAt:14,unprojected:{raw:true},...projection};state.room.run_inputs={protocol:'fixture',profileId:'fixture',ruleVersion:'fixture-v1',clockEpoch:15,revision:16,headTick:17,serverTick:18,committedThroughTick:19,processedThroughCommandSeq:20,acceptedInputNo:21,unprojected:22};
  const before=JSON.stringify(state.room);assert.deepEqual(failureAuthority(state,options),originalFailureAuthority(state,options));assert.equal(JSON.stringify(state.room),before);
 }
});

test('the null exception is exact waiting/null; missing, primitive and array engine data still fail',()=>{
 for(const status of ['active','finished','cancelled','fault',undefined]){const state=fixture();state.room.status=status;assert.throws(()=>failureAuthority(state,options),/FAILED_ROUND_ENGINE_AUTHORITY_REQUIRED/);}
 for(const value of [undefined,false,0,'engine',[]]){const state=fixture();state.room.game=value;assert.throws(()=>failureAuthority(state,options),/FAILED_ROUND_ENGINE_AUTHORITY_REQUIRED/);}
 const missing=fixture();delete missing.room.game;assert.throws(()=>failureAuthority(missing,options),/FAILED_ROUND_ENGINE_AUTHORITY_REQUIRED/);
 const waitingWithEngine=fixture();waitingWithEngine.room.game={status:'arming',me:{inputNo:0}};assert.deepEqual(failureAuthority(waitingWithEngine,options),originalFailureAuthority(waitingWithEngine,options));
});

test('waiting-null evidence retains original identity, ownership, free-bot and mutation rejections',()=>{
 const cases=[
  state=>{delete state.androidBaseline;},state=>{state.appId='foreign_app';},state=>{state.playerId='foreign_player';},state=>{state.sessionId='foreign_session';},state=>{state.game='foreign_game';},state=>{state.probabilityRequests.push({});},
  state=>{state.creations[0].game='foreign_game';},state=>{state.creations[0].practice=false;},state=>{state.creations[0].entry='1';},
  state=>{state.room=null;},state=>{delete state.room;},state=>{state.room.game_id='foreign_game';},state=>{state.room.me='foreign_player';},state=>{state.ownedRooms.clear();},state=>{state.room.fee_bps=1;},state=>{state.room.practice=false;},state=>{state.room.entry_minor='1';},
  state=>{state.room.players[1].bot=false;},state=>{state.room.players[1].external_user_id=baseline.externalUserId;},state=>{state.room.players[0].bot=true;},state=>{state.room.players=[];}
 ];
 for(const mutate of cases){const state=fixture();mutate(state);let originalError;assert.throws(()=>originalFailureAuthority(state,options),error=>{originalError=error;return true;});assert.throws(()=>failureAuthority(state,options),error=>error.code===originalError.code&&error.message===originalError.message);}
});

test('original non-scalar authority rejection remains fatal in waiting and active snapshots',()=>{
 for(const change of [state=>{state.room.version={bad:true};},state=>{state.room.status='active';state.room.game={phase:{bad:true},me:{}};},state=>{state.room.status='active';state.room.game={me:{inputNo:{bad:true}}};},state=>{state.room.run_inputs={revision:{bad:true}};}]){
  const state=fixture();change(state);assert.throws(()=>originalFailureAuthority(state,options),/FAILED_ROUND_AUTHORITY_NONSCALAR|Cannot read properties of null/);assert.throws(()=>failureAuthority(state,options),/FAILED_ROUND_AUTHORITY_NONSCALAR/);
 }
});

test('failure capture preserves the original failure while recording waiting authority without authorizing any unbound document read',async()=>{
 const state=fixture(),round={},error=Object.assign(Error('original setup failure'),{code:'ORIGINAL_SETUP_FAILURE'}),calls=[];
 const collector={async evaluate(){calls.push('evaluate');throw Error('unexpected unbound read');},actions:[],actionRequestDiagnostics:()=>[]};
 const observation=await capturePerformanceRoundFailure({round,error,collector,state,baseline,game,origin:'https://fixture.example',nonce:'fixture',now:()=>1000});
 assert.equal(round.error,error.message);assert.equal(observation.error,error.message);assert.equal(observation.code,error.code);assert.deepEqual(observation.authorityBeforeDOM,failureAuthority(state,options));assert.deepEqual(observation.authorityAfterDOM,observation.authorityBeforeDOM);assert.equal(observation.authorityBeforeDOM.game,null);assert.equal(observation.authorityBeforeDOM.own,null);assert.equal(observation.authorityError,undefined);assert.equal(observation.authorityAfterDOMError,undefined);assert.deepEqual(calls,[]);assert.equal(observation.probeError,'No previously bound owned game document');assert.equal(observation.domError,'No previously bound owned game document');assert.equal(round.documentId,undefined);assert.equal(round.sampleStartedAt,undefined);assert.equal(state.room.status,'waiting');
});
