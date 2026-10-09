import test from 'node:test';
import assert from 'node:assert/strict';
import {RUN_PRACTICE_PROFILES as P,resolveRunPracticeProfile,runPracticeProfileCapability} from '../shared/run-practice-profiles.mjs';
import {RUN_PRACTICE_REPLAY_LIMITS,RUN_PRACTICE_WORK_LIMITS} from '../server/pvp/run-practice-inputs.mjs';

test('only the exact new tuple selects six seconds, while the old contract keeps its original limits',()=>{
 assert.equal(resolveRunPracticeProfile(P.v2),P.v2);
 assert.equal(resolveRunPracticeProfile({...P.v1,profileId:undefined}),P.v1);
 for(const bad of [{...P.v2,profileId:undefined},{...P.v2,protocol:P.v1.protocol},{...P.v2,ruleVersion:P.v1.ruleVersion},{...P.v1,profileId:P.v2.profileId},{...P.v2,profileId:'free-bot-999-v1'}])assert.equal(resolveRunPracticeProfile(bad),null);
 assert.equal(P.v1.historyTicks,120);assert.equal(P.v1.workTicks,240);assert.equal(P.v1.serverMaxTick,6120);
 assert.equal(RUN_PRACTICE_REPLAY_LIMITS.historyTicks,120);assert.equal(RUN_PRACTICE_WORK_LIMITS.ticks,240);
 assert.equal(P.v2.historyTicks,360);assert.equal(P.v2.futureTicks,360);assert.equal(P.v2.leaseMs,6000);assert.equal(P.v2.workTicks,480);assert.equal(P.v2.serverMaxTick,6360);
 assert.equal(P.v2.clientWorkTicks,1080);assert.equal(P.v2.trajectoryFrames,721);assert.equal(P.v2.pendingCommands,64);
 for(const key of ['advanceTicks','batch','decisions','revisions','envelopeBytes','admissions','botDecisions','temporaryStates','physicalSends'])assert.equal(P.v2[key],P.v1[key]);
 assert.throws(()=>{P.v2.historyTicks=999;},TypeError);
 const cap=runPracticeProfileCapability();cap[1].profile_id='bad';assert.equal(runPracticeProfileCapability()[1].profile_id,P.v2.profileId);
 assert.deepEqual(Object.keys(cap[0]).sort(),['profile_id','protocol','rule_version']);
});
