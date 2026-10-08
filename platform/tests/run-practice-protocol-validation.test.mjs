import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as engine from '../arena/run/engine.mjs';
import {createRunPracticeInputs,applyRunPracticeInputs,advanceRunPracticeInputs,compactRunPracticeDecisions} from '../server/pvp/run-practice-inputs.mjs';
import {closeEnginePool,enginePoolStats} from '../server/pvp/engine-pool.mjs';

// No PG/HTTP. security.mjs's import-time key belongs only to this test's temp
// directory; the original local directory and environment are never adopted.
const original={local:process.env.OASIS_LOCAL_DIR,environment:process.env.OASIS_ENVIRONMENT};
let localDir,protocol;
before(async()=>{
 localDir=await mkdtemp(join(tmpdir(),'oasis-run-protocol-validation-'));
 process.env.OASIS_LOCAL_DIR=localDir;process.env.OASIS_ENVIRONMENT='sandbox';
 protocol=await import('../server/pvp/run-practice-protocol.mjs');
});
after(async()=>{
 try{await closeEnginePool();}finally{
  if(localDir)await rm(localDir,{recursive:true,force:true});
  for(const [name,value]of [['OASIS_LOCAL_DIR',original.local],['OASIS_ENVIRONMENT',original.environment]]){
   if(value===undefined)delete process.env[name];else process.env[name]=value;
  }
 }
});

const copy=structuredClone;
const command=(commandSeq,type,executeTick)=>({commandSeq,type,executeTick});
function room(){
 const players=[{external_user_id:'human_a',seat_index:0,bot:false},{external_user_id:'bot_a',seat_index:1,bot:true}];
 const state=engine.createState('00'.repeat(32),1000,{ruleVersion:engine.PRACTICE_INPUT_RULE_VERSION,startPolicy:engine.RUN_SCENE_READY_POLICY,
  players:players.map(p=>({key:p.external_user_id,seatIndex:p.seat_index,isBot:p.bot}))});
 engine.armStart(state,1000);
 const envelope=createRunPracticeInputs({roomId:'room_a',playerKey:'human_a',practice:true,entryMinor:'0',clockEpoch:1,state}).envelope;
 return {id:'room_a',game_id:'run',rule_version:engine.PRACTICE_INPUT_RULE_VERSION,practice:true,entry_minor:'0',fee_bps:0,
  terms:{rule_version:engine.PRACTICE_INPUT_RULE_VERSION},players,game_state:envelope.current,run_input_state:envelope,last_tick_at:1000};
}
function body(r,commands=[command(1,'right',1)]){
 return {request_id:'request_test',roomId:r.id,playerKey:'human_a',clockEpoch:r.run_input_state.clockEpoch,baseRevision:r.run_input_state.revision,commands};
}
function durableFixture(){
 const r=room(),commands=[command(1,'item',1),command(2,'right',1)];
 const applied=applyRunPracticeInputs(r.run_input_state,{roomId:r.id,playerKey:'human_a',clockEpoch:1,baseRevision:0,commands},0);
 const rows=applied.decisions.map(({duplicate,...decision})=>({command_seq:String(decision.commandSeq),decision}));
 const compact=compactRunPracticeDecisions(applied.envelope,{throughSeq:2}).envelope;
 r.run_input_state=advanceRunPracticeInputs(compact,6).envelope;r.game_state=r.run_input_state.current;r.last_tick_at=1100;
 return {r,commands,rows};
}
function mockDb(rows){
 const calls=[];
 return {calls,async query(sql,params){calls.push({sql,params:copy(params)});assert.match(sql,/SELECT command_seq,decision FROM pvp_run_input_decisions/);return {rows:copy(rows)};}};
}

test('valid bound helper fixture exposes public authority without internal history',()=>{
 const r=room(),before=copy(r),a=protocol.runInputAuthority(r);
 assert.equal(a.roomId,r.id);assert.equal(a.playerKey,'human_a');assert.equal(a.clockEpoch,1);
 assert.equal(a.resultAuthorization,null);assert.equal(protocol.runInputResultCommitted(r),false);
 assert.equal(a.anchor,undefined);assert.equal(a.current,undefined);assert.equal(a.integrity,undefined);assert.deepEqual(r,before);
});

const bindingMutations=[
 ['complete A envelope attached to outer room B',r=>{r.id='room_b';}],
 ['different outer human',r=>{r.players[0].external_user_id='human_b';}],
 ['swapped outer seats',r=>{r.players[0].seat_index=1;r.players[1].seat_index=0;}],
 ['swapped outer human and BOT roles',r=>{r.players[0].bot=true;r.players[1].bot=false;}],
 ['wrong envelope player binding',r=>{r.run_input_state.playerKey='bot_a';}],
 ['wrong envelope protocol',r=>{r.run_input_state.protocol='other-protocol';}],
 ['wrong anchor rule',r=>{r.run_input_state.anchor.ruleVersion=engine.PRACTICE_RULE_VERSION;}],
 ['wrong current rule',r=>{r.run_input_state.current.ruleVersion=engine.PRACTICE_RULE_VERSION;}],
 ['wrong anchor seat',r=>{r.run_input_state.anchor.players[1].seatIndex=0;}],
 ['wrong current BOT flag',r=>{r.run_input_state.current.players[1].isBot=false;}],
];
for(const [name,mutate]of bindingMutations)test(`binding rejects ${name} before view, result, advance, shift or DB preparation`,async()=>{
 const r=room();mutate(r);const before=copy(r),submissions=enginePoolStats().submitted??0;
 const db={async query(){assert.fail('scope mismatch must fail before DB access');}};
 const expected={status:503,code:'INVALID_PRACTICE_SCOPE'};
 assert.throws(()=>protocol.runInputAuthority(r),expected);
 assert.throws(()=>protocol.runInputResultCommitted(r),expected);
 await assert.rejects(protocol.advanceRunInputRoom(r,1200),expected);
 await assert.rejects(protocol.shiftRunInputRoom(r,100),expected);
 await assert.rejects(protocol.prepareRunInputBatch(r,'human_a',body(r),db),expected);
 assert.deepEqual(r,before);assert.equal(enginePoolStats().submitted??0,submissions);
});

test('old public rule never adopts new input protocol',async()=>{
 const r=room();r.rule_version=engine.PRACTICE_RULE_VERSION;r.terms.rule_version=r.rule_version;
 const before=copy(r),db={async query(){assert.fail('unsupported room must not query DB');}};
 for(const read of [()=>protocol.runInputAuthority(r),()=>protocol.runInputResultCommitted(r)])assert.throws(read,{status:503,code:'INVALID_PRACTICE_SCOPE'});
 await assert.rejects(protocol.advanceRunInputRoom(r,1200),{status:503,code:'INVALID_PRACTICE_SCOPE'});
 await assert.rejects(protocol.shiftRunInputRoom(r,100),{status:503,code:'INVALID_PRACTICE_SCOPE'});
 // HTTP preparation keeps its explicit unsupported-profile client response.
 await assert.rejects(protocol.prepareRunInputBatch(r,'human_a',body(r),db),{status:409,code:'UNSUPPORTED_INPUT_PROTOCOL'});
 assert.deepEqual(r,before);
});

const decisionMutations=[
 ['unknown outcome',rows=>{rows[1].decision.outcome='unknown';}],
 ['accepted inputNo null',rows=>{rows[1].decision.acceptedInputNo=null;}],
 ['accepted inputNo zero',rows=>{rows[1].decision.acceptedInputNo=0;}],
 ['accepted inputNo beyond the authoritative counter',rows=>{rows[1].decision.acceptedInputNo=999;}],
 ['accepted code non-null',rows=>{rows[1].decision.code='BUSY';}],
 ['rejected inputNo non-null',rows=>{rows[0].decision.acceptedInputNo=1;}],
 ['rejected code empty',rows=>{rows[0].decision.code='';}],
 ['rejected code not a durable business decision',rows=>{rows[0].decision.code='COMMAND_SEQUENCE_GAP';}],
 ['rejected code unknown',rows=>{rows[0].decision.code='SOMETHING_ELSE';}],
 ['revision zero',rows=>{rows[1].decision.revision=0;}],
 ['revision ahead of authority',rows=>{rows[1].decision.revision=999;}],
 ['revision not an integer',rows=>{rows[1].decision.revision=.5;}],
 ['decision timestamp ahead of server tick',rows=>{rows[1].decision.decidedAtServerTick=999;}],
 ['epoch invalid',rows=>{rows[1].decision.clockEpoch=0;}],
 ['missing required key',rows=>{delete rows[1].decision.code;}],
 ['unexpected extra key',rows=>{rows[1].decision.extra='unexpected';}],
 ['stored transport duplicate flag',rows=>{rows[1].decision.duplicate=false;}],
];
for(const [name,mutate]of decisionMutations)test(`malformed durable ${name} fails 503 before any fresh command runs`,async()=>{
 const {r,commands,rows}=durableFixture();mutate(rows);
 const before=copy(r),db=mockDb(rows),submissions=enginePoolStats().submitted??0;
 await assert.rejects(protocol.prepareRunInputBatch(r,'human_a',body(r,[...commands,command(3,'jump',7)]),db),{status:503,code:'INVALID_DURABLE_DECISION'});
 assert.deepEqual(r,before);assert.equal(enginePoolStats().submitted??0,submissions);assert.equal(db.calls.length,1);
});

test('missing durable row never admits the fresh tail or fabricates rejection',async()=>{
 const {r,commands,rows}=durableFixture(),before=copy(r),db=mockDb(rows.slice(1));
 await assert.rejects(protocol.prepareRunInputBatch(r,'human_a',body(r,[...commands,command(3,'jump',7)]),db),{status:503,code:'DURABLE_DECISION_MISSING'});
 assert.deepEqual(r,before);
});

test('conflicting exact old payload is an atomic conflict, not a new business denial',async()=>{
 const {r,commands,rows}=durableFixture(),before=copy(r),db=mockDb(rows);
 commands[1].type='left';
 await assert.rejects(protocol.prepareRunInputBatch(r,'human_a',body(r,[...commands,command(3,'jump',7)]),db),{status:409,code:'COMMAND_CONFLICT'});
 assert.deepEqual(r,before);
});

test('old duplicates plus fresh command preserve the original decision and query exact scope',async()=>{
 const {r,commands,rows}=durableFixture(),before=copy(r),saved=copy(rows),db=mockDb(rows);
 const result=await protocol.prepareRunInputBatch(r,'human_a',body(r,[...commands,command(3,'jump',7)]),db);
 assert.deepEqual(result.decisions.slice(0,2),saved.map(row=>({...row.decision,duplicate:true})));
 assert.equal(result.decisions[0].outcome,'rejected');assert.equal(result.decisions[0].acceptedInputNo,null);
 assert.equal(result.decisions[1].acceptedInputNo,1);assert.ok(result.decisions[1].revision<result.envelope.revision);
 assert.equal(result.decisions[2].outcome,'accepted');assert.equal(result.decisions[2].acceptedInputNo,2);
 assert.equal(result.decisions[2].duplicate,false);assert.deepEqual(result.newDecisions,[result.decisions[2]]);
 assert.deepEqual(db.calls[0].params,['room_a','human_a',[1,2]]);
 assert.deepEqual(rows,saved);assert.deepEqual(r,before,'prepare does not persist or mutate the room');
 const {newDecisions,...again}=await protocol.prepareRunInputBatch(r,'human_a',body(r,commands),db);
 assert.deepEqual(newDecisions,[]);assert.deepEqual(again.envelope,r.run_input_state);assert.equal(again.correction,null);
 assert.deepEqual(again.decisions,saved.map(row=>({...row.decision,duplicate:true})));
});

test('valid old decision from a prior epoch cannot be adopted by the new epoch',async()=>{
 const {r,commands,rows}=durableFixture();await protocol.shiftRunInputRoom(r,100);
 assert.equal(r.run_input_state.clockEpoch,2);assert.equal(r.run_input_state.lastCommandSeq,2);
 const before=copy(r),db=mockDb(rows);
 await assert.rejects(protocol.prepareRunInputBatch(r,'human_a',body(r,commands),db),{status:409,code:'DECISION_EPOCH_MISMATCH'});
 const stale=body(r,commands);stale.clockEpoch=1;
 await assert.rejects(protocol.prepareRunInputBatch(r,'human_a',stale,db),{status:409,code:'STALE_CLOCK_EPOCH'});
 assert.deepEqual(r,before);
});
