import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../arena/run/engine.mjs';
import {createRunPracticeInputs,applyRunPracticeInputs,advanceRunPracticeInputs} from '../server/pvp/run-practice-inputs.mjs';
import {runEngineTask,enginePoolStats,closeEnginePool} from '../server/pvp/engine-pool.mjs';

test('Run input batches and background replay use the bounded worker pool and match pure results',async()=>{
  const state=engine.createState('12'.repeat(32),1000,{ruleVersion:engine.PRACTICE_INPUT_RULE_VERSION,startPolicy:engine.RUN_SCENE_READY_POLICY,
    players:[{key:'human',seatIndex:0,isBot:false},{key:'bot',seatIndex:1,isBot:true}]});
  engine.armStart(state,1000);
  const envelope=createRunPracticeInputs({roomId:'room_one',playerKey:'human',practice:true,entryMinor:'0',clockEpoch:1,state}).envelope;
  const request={roomId:'room_one',playerKey:'human',clockEpoch:1,baseRevision:0,commands:[{commandSeq:1,type:'jump',executeTick:1}]};
  const before=structuredClone(envelope),base={kind:'run-practice-inputs',gameId:'run',ruleVersion:engine.PRACTICE_INPUT_RULE_VERSION};
  try{
    const actual=await runEngineTask({...base,operation:'apply',envelope,request,serverTick:30});
    assert.deepEqual(actual,applyRunPracticeInputs(envelope,request,30));
    assert.deepEqual(await runEngineTask({...base,operation:'advance',envelope:actual.envelope,serverTick:60}),advanceRunPracticeInputs(actual.envelope,60));
    assert.deepEqual(envelope,before);assert.equal(enginePoolStats().submitted,2);assert.equal(enginePoolStats().completed,2);
    await assert.rejects(runEngineTask({...base,ruleVersion:engine.PRACTICE_RULE_VERSION,operation:'advance',envelope,serverTick:30}),{code:'PINNED_RULE_UNAVAILABLE'});
    await assert.rejects(runEngineTask({...base,operation:'unknown',envelope,serverTick:30}),{code:'INVALID_ENGINE_TASK'});
  }finally{await closeEnginePool();}
});
