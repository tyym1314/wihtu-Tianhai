import test from 'node:test';
import assert from 'node:assert/strict';
import {RUN_PRACTICE_PROFILES as profiles} from '../shared/run-practice-profiles.mjs';
import {runPracticeInputBaseline,verifyRunPracticeInputAction} from '../scripts/android-game-actions.mjs';

function fixture(profile=profiles.v2){
 const before={id:'owned_room',game_id:'run',practice:true,entry_minor:'0',fee_bps:0,capacity:4,me:'owner',status:'active',
  game:{ruleVersion:profile.ruleVersion,me:'owner',snapshotTick:1,players:[
   {key:'owner',isBot:false,inputNo:0},...['bot1','bot2','bot3'].map(key=>({key,isBot:true,inputNo:0}))]},
  run_input_profile:{rule_version:profile.ruleVersion,protocol:profile.protocol,profile_id:profile.profileId},
  run_inputs:{protocol:profile.protocol,ruleVersion:profile.ruleVersion,...(profile.profileId?{profileId:profile.profileId}:{}),roomId:'owned_room',playerKey:'owner',clockEpoch:1,
   revision:1,headTick:1,serverTick:1,committedThroughTick:0,processedThroughCommandSeq:0,acceptedInputNo:0,decisions:[]}};
 const request={request_id:'owned_request_01',roomId:'owned_room',playerKey:'owner',clockEpoch:1,baseRevision:1,commands:[{commandSeq:1,type:'jump',executeTick:2}]};
 const after=structuredClone(before);after.request_id=request.request_id;after.game.players[0].inputNo=1;
 Object.assign(after.run_inputs,{revision:2,processedThroughCommandSeq:1,acceptedInputNo:1,decisions:[{commandSeq:1,type:'jump',executeTick:2,clockEpoch:1,outcome:'accepted',code:null,acceptedInputNo:1,decidedAtServerTick:1,revision:2,duplicate:false}]});
 return {before,request,after};
}

for(const profile of Object.values(profiles))test(`${profile.protocol}: exact UI POST proves its own negotiated profile`,()=>{
 const f=fixture(profile),baseline=runPracticeInputBaseline(f.before),proof=verifyRunPracticeInputAction(baseline,f.request,f.after);
 assert.equal(proof.protocol,profile.protocol);assert.equal(proof.ruleVersion,profile.ruleVersion);
 assert.equal(proof.profileId,profile.profileId??undefined);assert.equal(proof.acceptedInputNoAfter,1);
 assert.equal(Object.hasOwn(proof,'profileId'),Boolean(profile.profileId));
 const final=structuredClone(f.before);final.game.snapshotTick=6000;Object.assign(final.run_inputs,{headTick:6000,serverTick:profile.serverMaxTick,committedThroughTick:6000});
 assert.equal(runPracticeInputBaseline(final).headTick,6000);
 final.run_inputs.serverTick++;assert.throws(()=>runPracticeInputBaseline(final),{code:'RUN_INPUT_PROOF_INVALID'});
});

for(const [label,change] of [
 ['unknown profile',f=>{f.before.run_inputs.profileId='free-bot-999-v1';}],
 ['mixed old protocol',f=>{f.before.run_inputs.protocol=profiles.v1.protocol;}],
 ['missing advertised tuple',f=>{delete f.before.run_input_profile;}],
 ['different advertised tuple',f=>{f.before.run_input_profile.profile_id='free-bot-999-v1';}],
 ['unexpected profile fields',f=>{f.before.run_input_profile.historyTicks=999;}],
 ['paid entry',f=>{f.before.entry_minor='100';}],
 ['nonzero fee',f=>{f.before.fee_bps=500;}],
 ['capacity differs from roster',f=>{f.before.capacity=3;}],
 ['second human',f=>{f.before.game.players[1].isBot=false;}],
 ['duplicate player',f=>{f.before.game.players[1].key='owner';}],
 ['unknown rule with input envelope',f=>{f.before.game.ruleVersion='pvp-run-v2.5.0';}],
])test(`v2 baseline rejects ${label} before any UI mutation`,()=>{
 const f=fixture();change(f);assert.throws(()=>runPracticeInputBaseline(f.before),{code:'RUN_INPUT_PROOF_INVALID'});
});

for(const [label,change] of [
 ['GET cursor without exact request',f=>{delete f.after.request_id;}],
 ['changed response request',f=>{f.after.request_id='another_request_01';}],
 ['missing exact decision',f=>{f.after.run_inputs.decisions=[];}],
 ['business rejection',f=>{Object.assign(f.after.run_inputs.decisions[0],{outcome:'rejected',code:'AIRBORNE',acceptedInputNo:null});}],
 ['durable duplicate',f=>{f.after.run_inputs.decisions[0].duplicate=true;}],
 ['wrong accepted input number',f=>{f.after.run_inputs.decisions[0].acceptedInputNo=2;}],
 ['changed epoch',f=>{f.after.run_inputs.clockEpoch=2;}],
 ['committed command',f=>{f.after.run_inputs.committedThroughTick=2;}],
 ['batched second command',f=>{f.request.commands.push({commandSeq:2,type:'left',executeTick:3});}],
 ['response downgraded to old tuple',f=>{const old=fixture(profiles.v1).after;f.after=old;}],
])test(`v2 POST proof rejects ${label}; receipt never comes from GET`,()=>{
 const f=fixture(),baseline=runPracticeInputBaseline(f.before);change(f);
 assert.throws(()=>verifyRunPracticeInputAction(baseline,f.request,f.after),{code:'RUN_INPUT_PROOF_INVALID'});
});

test('legacy no-envelope room retains action transport',()=>{
 assert.equal(runPracticeInputBaseline({game:{ruleVersion:'pvp-run-v2.2.0'}}),null);
});
