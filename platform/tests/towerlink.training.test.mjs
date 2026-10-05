import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../arena/towerlink/engine.mjs';
import {TRAINING_VERSION,TRAINING_LESSONS,getTrainingLesson,trainingBotProfile,observeTraining,updateTraining} from '../arena/towerlink/training.mjs';

import {make,play} from './fixtures/towerlink-training-scenarios.mjs';
const code=expected=>e=>e.code===expected;
const seed='01'.repeat(16);

test('Twelve browser-safe lesson descriptors declare actual objectives, setup and next-lesson order',()=>{
  assert.equal(TRAINING_LESSONS.length,12);assert.equal(new Set(TRAINING_LESSONS.map(l=>l.id)).size,12);assert.equal(getTrainingLesson('invalid'),null);
  for(const lesson of TRAINING_LESSONS){const s=make(lesson.number),v=engine.view(s,'p0');assert.equal(v.training.lessonId,lesson.id);assert.ok(v.training.objective.length>10);assert.ok(v.training.setupDescription.length>10);assert.equal(v.training.nextLessonId,TRAINING_LESSONS[lesson.number]?.id??null);assert.equal(v.training.completed,false);assert.equal(v.training.failed,false);assert.equal(s.deadlineAt-s.startedAt,lesson.durationMs);assert.ok(v.training.progress.every(p=>p.current===0&&!p.done));assert.ok(s.towers.length<=13);assert.equal(s.towers.length,lesson.number<8?([4,7].includes(lesson.number)?7:5):13);}
});

for(const lesson of TRAINING_LESSONS)test(`${lesson.id} ${lesson.title}: legal commands and actual simulation satisfy every server-owned objective`,()=>{
  const state=play(lesson.number),training=engine.view(state,'p0').training;
  assert.equal(state.status,'finished');assert.equal(training.completed,true,JSON.stringify(training));assert.equal(training.failed,false);assert.ok(training.progress.every(p=>p.done));assert.ok(training.completedAt>state.startedAt);assert.equal(engine.rank(state)[0].rank,1);assert.deepEqual(state.winnerKeys,['p0']);
  assert.equal(state.deadlineAt-state.startedAt,lesson.number===11?45000:180000);
});

for(const lesson of TRAINING_LESSONS)test(`${lesson.id}: waiting or clicking an unsupported complete command cannot award training credit`,()=>{
  const state=make(lesson.number),before=structuredClone(state);
  assert.throws(()=>engine.act(state,'p0',{type:'complete',lessonId:lesson.id},1000),code('INVALID_ACTION'));assert.deepEqual(state,before);
  engine.tick(state,state.deadlineAt);const training=engine.view(state,'p0').training;
  assert.equal(training.completed,false);assert.equal(training.failed,true);assert.equal(engine.rank(state)[0].rank,2);assert.ok(!state.winnerKeys.includes('p0'));
});

test('Continuous-line training requires real dispatch and regrowth, not merely two buttons',()=>{
  const s=make(2);engine.act(s,'p0',{type:'link',from:0,to:1},1000);engine.act(s,'p0',{type:'stop',towerId:0},1250);engine.tick(s,5000);
  assert.equal(s.training.metrics.sent??0,0);assert.equal(s.training.metrics.stopped??0,0);assert.equal(s.training.completed,false);
  engine.act(s,'p0',{type:'link',from:0,to:1},5000);engine.tick(s,13000);engine.act(s,'p0',{type:'stop',towerId:0},13000);assert.equal(s.training.completed,false);engine.tick(s,25000);assert.equal(s.training.completed,true);
});

test('Relay lesson waits for real reinforcements and the onward journey',()=>{
  const s=make(3);engine.act(s,'p0',{type:'link',from:0,to:1},1000);engine.act(s,'p0',{type:'link',from:1,to:4},1250);
  engine.tick(s,4000);assert.equal(s.training.metrics.reinforced??0,0);assert.equal(s.training.completed,false);assert.ok(s.armies.some(a=>a.from===0&&a.to===1));
  engine.tick(s,25000);assert.equal(s.training.completed,true);
});

test('Upgrade lesson waits for completion and four units of new production',()=>{
  const s=make(5);engine.act(s,'p0',{type:'upgrade',towerId:0},1000);engine.tick(s,3999);assert.equal(s.training.metrics.upgraded??0,0);assert.equal(s.training.completed,false);
  engine.tick(s,4000);assert.equal(s.training.metrics.upgraded,1);assert.equal(s.training.metrics.advancedProduced??0,0);assert.equal(s.training.completed,false);engine.tick(s,6000);assert.equal(s.training.completed,true);
});

test('Redirect training cannot pass by merely adding another route while the attack line remains active',()=>{
  const s=make(6);engine.act(s,'p0',{type:'upgrade',towerId:0},1000);engine.tick(s,4000);engine.act(s,'p0',{type:'link',from:0,to:2},4000);engine.tick(s,6000);engine.act(s,'p0',{type:'link',from:0,to:1},6000);engine.tick(s,10000);
  assert.ok(s.training.metrics.outbound>=4);assert.equal(s.training.metrics.changed??0,0);assert.equal(s.training.metrics.defended??0,0);assert.equal(s.training.completed,false);
  engine.act(s,'p0',{type:'unlink',from:0,to:2},10000);assert.equal(s.training.metrics.changed,1);engine.tick(s,20000);assert.equal(s.training.completed,true);
});

test('Redirect training also accepts stop-all followed by a new defensive route, without recalling attack troops',()=>{
  const s=make(6);engine.act(s,'p0',{type:'link',from:0,to:2},1000);engine.tick(s,5000);const departed=structuredClone(s.armies);
  engine.act(s,'p0',{type:'stop',towerId:0},5000);engine.act(s,'p0',{type:'link',from:0,to:1},5250);assert.equal(s.training.metrics.changed,1);assert.deepEqual(s.armies,departed);engine.tick(s,16000);assert.equal(s.training.completed,true);
});

test('Center challenge requires reinforcement and a continuous twelve-second hold',()=>{
  const s=make(8);engine.act(s,'p0',{type:'upgrade',towerId:8},1000);engine.act(s,'p0',{type:'link',from:0,to:8},1250);engine.tick(s,4000);engine.act(s,'p0',{type:'link',from:8,to:12},4000);
  while(!s.training.centerOwnedSince&&s.status==='active'&&s.serverNow<30000)engine.tick(s,s.serverNow+125);assert.ok(s.training.centerOwnedSince,'the upgraded supply route must capture the bridgehead');
  const capturedAt=s.training.centerOwnedSince;assert.equal(s.training.completed,false);engine.tick(s,capturedAt+11999);assert.equal(s.training.completed,false);engine.tick(s,capturedAt+12000);assert.equal(s.training.completed,true);
});

test('Three-way lesson demonstrates 5/4/2 cancellation but still requires a player conquest',()=>{
  const s=make(10);engine.tick(s,4000);const demo=s.events.find(e=>e.type==='arrival'&&e.towerId===12);
  assert.equal(demo.casualties,11);assert.equal(demo.troops,0);assert.equal(s.owners[12],null);assert.equal(s.training.metrics.coalition,1);assert.equal(s.training.completed,false);
  engine.act(s,'p0',{type:'link',from:0,to:1},4000);engine.tick(s,20000);assert.equal(s.training.completed,true);
});

test('Timed challenge runs the opposing AI and requires three distinct captures at its deadline',()=>{
  const s=play(11);assert.equal(s.training.completed,true);assert.equal(s.finishReason,'deadline');
  assert.equal(s.finishedAt,s.deadlineAt);assert.ok(s.training.metrics.distinctCaptures>=3);assert.ok(Object.keys(s.training.botLastActionAt).length>0);
});

test('Restart restores the initial lesson; next lesson is a fresh scenario without carried troops',()=>{
  const completed=play(5),initial=make(5),retry=make(5);assert.deepEqual(initial,retry);assert.equal(retry.towers[0].level,1);assert.equal(retry.towers[0].troops,30);assert.equal(retry.training.completed,false);
  const next=make(6);assert.equal(next.training.lessonId,completed.training.nextLessonId);assert.equal(next.towers[0].level,1);assert.equal(next.training.completed,false);assert.equal(next.armies.length,0);
});

test('Serialized training resumes with identical progress, and common pauses do not earn hold-time credit',()=>{
  const a=make(8);engine.act(a,'p0',{type:'upgrade',towerId:8},1000);engine.act(a,'p0',{type:'link',from:0,to:8},1250);engine.tick(a,4000);engine.act(a,'p0',{type:'link',from:8,to:12},4000);while(!a.training.centerOwnedSince&&a.status==='active'&&a.serverNow<30000)engine.tick(a,a.serverNow+125);assert.ok(a.training.centerOwnedSince);
  const b=JSON.parse(JSON.stringify(a)),capture=a.training.centerOwnedSince;engine.shiftTime(b,10000);assert.equal(b.training.centerOwnedSince,capture+10000);
  engine.tick(a,capture+4000);engine.tick(b,capture+14000);assert.deepEqual(a.training.progress,b.training.progress);assert.equal(b.training.completed,false);
  engine.tick(a,capture+12000);engine.tick(b,capture+22000);assert.equal(a.training.completed,true);assert.equal(b.training.completed,true);
});

test('Tutorial bot reaction profiles never change production or waive upgrade costs',()=>{
  const s=make(1);assert.equal(engine.botAction(s,'p1',2000),null);engine.tick(s,5000);assert.equal(s.towers[0].troops,34);assert.equal(s.towers[3].troops,34);
  const action=engine.botAction(s,'p1',61000);assert.ok(action);engine.act(s,'p1',action,61000);assert.equal(engine.botAction(s,'p1',61150),null);
  const next=engine.botAction(s,'p1',69000);assert.ok(next||s.status==='active');
});

test('Competitive games cannot inherit tutorial geometry, timings, bots or completion state',()=>{
  const competitive=engine.createState(seed,1000,{players:['p0','p1']});assert.equal(competitive.training,undefined);assert.equal(engine.view(competitive,'p0').training,null);assert.equal(competitive.towers.length,13);assert.equal(competitive.deadlineAt-competitive.startedAt,180000);
  const s=make(2);engine.act(s,'p0',{type:'link',from:0,to:1},1000);engine.tick(s,9000);engine.act(s,'p0',{type:'stop',towerId:0},9000);engine.tick(s,11000);assert.equal(s.training.completed,true);assert.equal(engine.rank(s)[0].rank,1,'tutorial goals win despite equal tower counts');
});

test('Unknown lessons and incompatible learner/bot configurations are rejected',()=>{
  assert.throws(()=>make(1,{trainingLessonId:'lesson-13'}),code('INVALID_TRAINING_LESSON'));
  assert.throws(()=>make(1,{trainingLessonId:{id:'lesson-01'}}),code('INVALID_TRAINING_LESSON'));
  assert.throws(()=>make(10,{players:[{key:'p0',seatIndex:0},{key:'p1',seatIndex:1,isBot:true}]}),code('INVALID_TRAINING_PLAYERS'));
  assert.throws(()=>make(1,{players:['p0','p1']}),code('INVALID_TRAINING_PLAYERS'));
  assert.throws(()=>make(1,{players:[{key:'p0',seatIndex:0,isBot:true},{key:'p1',seatIndex:1}]}),code('INVALID_TRAINING_PLAYERS'));
});

test('Quit marks the lesson failed and exposes no internal counters or mutable snapshot references',()=>{
  const s=make(1);engine.forfeit(s,['p0'],1500);assert.equal(s.training.failed,true);assert.equal(s.training.completed,false);assert.equal(s.training.failedReason,'已退出训练');
  const v=engine.view(s,'p0');assert.equal(v.training.metrics,undefined);assert.equal(v.training.routes,undefined);assert.equal(v.training.botLastActionAt,undefined);
  v.training.progress[0].current=999;v.training.markers[0].label='tamper';assert.notEqual(s.training.progress[0].current,999);assert.notEqual(s.training.markers[0].label,'tamper');
});

for(const lesson of TRAINING_LESSONS)test(`${lesson.id}: real opposing AI defeats an idle learner or leaves its objective failed`,()=>{
 const trace=[],state=play(lesson.number,{idle:true,trace});
 assert.equal(state.training.completed,false);assert.equal(state.training.failed,true);
 assert.ok(!state.winnerKeys.includes('p0'));assert.ok(trace.some(entry=>entry.player!=='p0'),'the opponent actually acted, not merely a deadline shortcut');
});

test('Cutting the last route completes the regrowth lesson without requiring a stop-all button',()=>{
 const s=make(2);engine.act(s,'p0',{type:'link',from:0,to:1},1000);engine.tick(s,9000);engine.act(s,'p0',{type:'unlink',from:0,to:1},9000);engine.tick(s,12000);
 assert.equal(s.training.completed,true);assert.equal(s.training.metrics.stopped,1);
});

test('Dual-flank challenge cannot be completed using the old three-command shortcut without real rear supplies',()=>{
 const state=play(7,{scheduleOverride:[[0,'upgrade',0],[500,'link',1,6],[1000,'link',2,6]]});
 assert.equal(state.training.completed,false);assert.equal(state.training.metrics.suppliedLeft??0,0);assert.equal(state.training.metrics.suppliedRight??0,0);
});

test('The counterattack requires a real flank and prevents the former direct home attack',()=>{
 const s=make(9);assert.ok(!s.towers[8].neighbors.includes(0));assert.ok(s.towers[8].neighbors.includes(1));assert.ok(s.towers[1].neighbors.includes(0));
 assert.throws(()=>engine.act(s,'p0',{type:'link',from:8,to:0},1000),code('INVALID_LINK'));
 const win=play(9);assert.ok(win.training.metrics.bridgeCaptured);assert.ok(win.training.metrics.homeHeldSeconds>=10);assert.equal(win.owners[8],'p0');
});

test('Clock recovery shifts both bridgehead and recaptured-home hold intervals',()=>{
 const s=make(9);s.training.homeOwnedSince=2000;s.training.centerOwnedSince=1500;engine.shiftTime(s,10000);assert.equal(s.training.homeOwnedSince,12000);assert.equal(s.training.centerOwnedSince,11500);
});

test('New training freezes its curriculum version and AI cadence in the serialized room',()=>{
 for(const lesson of TRAINING_LESSONS){const s=JSON.parse(JSON.stringify(make(lesson.number)));assert.equal(s.training.trainingVersion,TRAINING_VERSION);assert.equal(s.training.scenarioVersion,2);assert.deepEqual(trainingBotProfile(s.training),{intervalMs:lesson.botIntervalMs,startsAfterMs:lesson.botStartsAfterMs});}
 const s=make(7);s.training.botProfile={intervalMs:9876,startsAfterMs:12345};assert.equal(engine.botAction(s,'p1',12000),null);assert.deepEqual(trainingBotProfile(s.training),{intervalMs:9876,startsAfterMs:12345});
});

test('Older serialized training retains its original AI reaction windows',()=>{
 for(const[number,intervalMs,startsAfterMs]of[[6,6000,45000],[7,4000,15000],[8,4000,15000],[9,3600,12000],[11,8000,60000]]){const s=make(number);delete s.training.botProfile;delete s.training.scenarioVersion;delete s.training.trainingVersion;const restored=JSON.parse(JSON.stringify(s));assert.deepEqual(trainingBotProfile(restored.training),{intervalMs,startsAfterMs});assert.equal(engine.botAction(restored,'p1',startsAfterMs-1),null);}
});

test('Older counterattack progress is not silently replaced by new bridge or reserve objectives',()=>{
 const s=make(9);delete s.training.targets.reserve;delete s.training.targets.bridge;delete s.training.homeOwnedSince;
 s.training.title='夺回出生塔';s.training.objective='旧房间只要求夺回出生塔';s.training.progress=[{id:'recaptured',label:'夺回出生塔',current:0,target:1,done:false}];s.training.metrics={recaptured:1};s.owners[8]='p1';
 const restored=JSON.parse(JSON.stringify(s));updateTraining(restored,2000);assert.equal(restored.training.completed,true);assert.equal(restored.training.title,'夺回出生塔');assert.equal(restored.training.objective,'旧房间只要求夺回出生塔');assert.deepEqual(restored.training.progress.map(p=>p.id),['recaptured']);
});

test('Older timed training still requires its stored victory objective, and finished history stays frozen',()=>{
 const s=make(11);s.training.progress=[{id:'timeUp',label:'到时',current:0,target:1,done:false},{id:'won',label:'到时获胜',current:0,target:1,done:false}];delete s.training.targets.reserve;
 observeTraining(s,{type:'finish',at:s.deadlineAt,reason:'deadline',winnerKeys:['p1']});updateTraining(s,s.deadlineAt);assert.equal(s.training.completed,false);assert.equal(s.training.progress.find(p=>p.id==='won').done,false);
 observeTraining(s,{type:'finish',at:s.deadlineAt,reason:'deadline',winnerKeys:['p0']});updateTraining(s,s.deadlineAt);assert.equal(s.training.completed,true);const finished=JSON.parse(JSON.stringify(s.training));updateTraining(s,s.deadlineAt+10000);observeTraining(s,{type:'capture',ownerKey:'p1',towerId:0,at:s.deadlineAt+10000});assert.deepEqual(s.training,finished);
});
