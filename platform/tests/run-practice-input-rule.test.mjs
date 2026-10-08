import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../arena/run/engine.mjs';
import {runInstantPracticeStart,runRequiresSceneReady} from '../arena/run/start-policy.mjs';

const players=[{key:'self',seatIndex:0,isBot:false},{key:'bot',seatIndex:1,isBot:true}];
const create=(version,index=0,roster=players)=>engine.createState(index.toString(16).padStart(8,'0').padEnd(64,'0'),1000,
 {ruleVersion:version,startPolicy:engine.RUN_SCENE_READY_POLICY,players:roster});

test('V2.3 requires one human and a rendered-scene ACK before its instant practice start',()=>{
 const version=engine.PRACTICE_INPUT_RULE_VERSION;
 assert.equal(version,'pvp-run-v2.3.0');
 assert(runInstantPracticeStart(version));assert(runRequiresSceneReady(version));
 const s=create(version);engine.tick(s,1200);
 assert.equal(s.tick,0);assert.equal(s.phase,'arming');
 engine.armStart(s,1500);assert.equal(s.startedAt,1500);assert.equal(s.phase,'racing');
 assert.throws(()=>create(version,0,players.map(p=>({...p,isBot:false}))),{code:'INVALID_PRACTICE_ROSTER'});
 assert.throws(()=>engine.createState('a'.repeat(64),1000,{ruleVersion:version,players}),{code:'INVALID_START_POLICY'});
});

test('new transport profile preserves all six existing practice courses and physical starting state',()=>{
 for(let i=0;i<6;i++){
  const previous=create(engine.PRACTICE_RULE_VERSION,i),candidate=create(engine.PRACTICE_INPUT_RULE_VERSION,i);
  engine.armStart(previous,1500);engine.armStart(candidate,1500);
  for(const state of [previous,candidate]){engine.act(state,'self',{type:'jump'},1500);engine.tick(state,1800);}
  assert.notEqual(candidate.ruleVersion,previous.ruleVersion);
  assert.deepEqual({...candidate,ruleVersion:previous.ruleVersion},previous);
 }
});

test('V2.2 instant and V2.1 shared-countdown policies retain their exact start contract',()=>{
 const practice=create(engine.PRACTICE_RULE_VERSION),shared=create(engine.RULE_VERSION);
 engine.armStart(practice,1200);engine.armStart(shared,1200);
 assert.equal(practice.startedAt,1200);assert.equal(practice.phase,'racing');
 assert.equal(shared.startedAt,2700);assert.equal(shared.phase,'countdown');
 assert.equal(runInstantPracticeStart('pvp-run-v99'),false);
});
