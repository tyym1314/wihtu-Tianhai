import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../arena/run/engine.mjs';
import {RUN_COURSES_V21,resolveRunCourse,selectRunCourse} from '../arena/run/courses.mjs';
import {readRunPracticeCourses,confirmedRunPracticeCourse} from '../arena/run/practice-course-contract.mjs';
import {newRunPracticeCourseOptions,storedRunPracticeCourse,runPracticeCourseCapability} from '../server/pvp/run-course-policy.mjs';
import {createRunPracticeFallHelp} from '../arena/run/practice-fall-help.mjs';
const players=[{key:'self',seatIndex:0,isBot:false},{key:'bot',seatIndex:1,isBot:true}];
const options={ruleVersion:engine.PRACTICE_INPUT_RULE_VERSION,startPolicy:engine.RUN_SCENE_READY_POLICY,players};
const seed=i=>i.toString(16).padStart(8,'0').padEnd(64,'0');
const room=()=>({game_id:'run',practice:true,entry_minor:'0',fee_bps:0,capacity:2,rule_version:options.ruleVersion,players:players.map(p=>({bot:p.isBot})),game_options:newRunPracticeCourseOptions('run',true,{})});
test('only new free BOT practice defaults to the existing beginner course',()=>{
 const r=room(),c=storedRunPracticeCourse(r);assert.equal(c.id,'sunrise-arches');assert.equal(c.difficulty,1);
 assert.deepEqual(r.game_options,{run_course_policy:'run-practice-course-v1',run_course_id:'sunrise-arches'});
 assert.deepEqual(newRunPracticeCourseOptions('run',false,{entry_minor:'1000'}),{});
 assert.deepEqual(newRunPracticeCourseOptions('match',true,{}),{});
 assert.deepEqual(newRunPracticeCourseOptions('run',true,{entry_minor:'1000'}),r.game_options);
 const course=resolveRunCourse(engine.createState(seed(4),0,{...options,practiceCourseId:c.id}));
 assert.equal(course,RUN_COURSES_V21[1]);assert.equal(course.gaps.some(g=>g.start<60),false);
});
test('six explicit choices use the original frozen content and server-owned difficulty',()=>{
 for(const c of RUN_COURSES_V21){const r=room();r.game_options=newRunPracticeCourseOptions('run',true,{run_course_id:c.id});
  const confirmation=storedRunPracticeCourse(r);assert.equal(confirmation.difficulty,c.difficulty);
  assert.equal(resolveRunCourse(engine.createState(seed(5),0,{...options,practiceCourseId:confirmation.id})),c);
 }
 for(const body of [{run_course_id:'unknown'},{run_course_id:null},{run_difficulty:1},{run_course_policy:'forged'}])assert.throws(()=>newRunPracticeCourseOptions('run',true,body),{code:'INVALID_RUN_COURSE'});
});
test('explicit selection is rejected for other games, paid/human rooms and invalid stored policies',()=>{
 for(const [game,practice,body] of [['match',true,{}],['run',false,{entry_minor:'1000'}],['run',true,{entry_minor:'1000'}]])assert.throws(()=>newRunPracticeCourseOptions(game,practice,{...body,run_course_id:'sunrise-arches'}),{code:'INVALID_RUN_COURSE_MODE'});
 for(const change of [{practice:false},{entry_minor:'1000'},{fee_bps:500},{rule_version:engine.RULE_VERSION},{players:[{bot:false},{bot:false}]},{game_options:{run_course_id:'sunrise-arches'}},{game_options:{run_course_policy:'future',run_course_id:'sunrise-arches'}}])assert.throws(()=>storedRunPracticeCourse({...room(),...change}),{code:'INVALID_RUN_COURSE_POLICY'});
 for(const version of ['pvp-run-v1.0.0',engine.PREVIOUS_RULE_VERSION,engine.RULE_VERSION])assert.throws(()=>engine.createState(seed(0),0,{...options,ruleVersion:version,practiceCourseId:'sunrise-arches'}),{code:'INVALID_PRACTICE_COURSE'});
 assert.throws(()=>engine.createState(seed(0),0,{...options,practiceCourseId:'unknown'}),{code:'INVALID_PRACTICE_COURSE'});
 assert.throws(()=>engine.createState(seed(0),0,{...options,practiceCourseId:'sunrise-arches',players:players.map(p=>({...p,isBot:false}))}),{code:'INVALID_PRACTICE_ROSTER'});
});
test('old missing policy retains every seed choice in both existing practice rule versions',()=>{
 assert.equal(storedRunPracticeCourse({...room(),game_options:{}}),null);
 for(const version of [engine.PRACTICE_RULE_VERSION,engine.PRACTICE_INPUT_RULE_VERSION])for(let i=0;i<6;i++){
  const state=engine.createState(seed(i),0,{...options,ruleVersion:version});assert.equal(state.courseId,selectRunCourse(seed(i),version).id);
  engine.armStart(state,0);const stored=structuredClone(state);engine.tick(stored,1000);assert.equal(stored.courseId,state.courseId);
 }
});
test('client requires explicit capability and matching server confirmation',()=>{
 assert.equal(readRunPracticeCourses({run_practice_input_protocol:'run-practice-inputs-v1'}),null);
 const cap=runPracticeCourseCapability();assert.equal(readRunPracticeCourses({run_practice_courses:cap}),cap);
 assert.equal(readRunPracticeCourses({run_practice_courses:{...cap,policy:'unknown'}}),null);
 assert.equal(readRunPracticeCourses({run_practice_courses:{...cap,courses:[cap.courses[0]]}}),null);
 const r={...room(),run_course:storedRunPracticeCourse(room())};assert.equal(confirmedRunPracticeCourse(r,'sunrise-arches').id,'sunrise-arches');
 assert.equal(confirmedRunPracticeCourse(r,'rapid-bridges'),null);assert.equal(confirmedRunPracticeCourse({...r,run_course:null},'sunrise-arches'),null);
});
const scope={roomId:'room',playerKey:'self',clockEpoch:1};
const tracker=()=>createRunPracticeFallHelp(scope);
const fall=(tick,id=tick)=>({id,tick,playerKey:'self',type:'fall',checkpoint:30});
function authority({revision=1,head=600,committed=500,events=[fall(300),fall(450)],checkpoint=30}={}){
 return {id:'room',me:'self',game_id:'run',practice:true,entry_minor:'0',game:{me:'self',ruleVersion:options.ruleVersion,snapshotTick:head,events},
  run_inputs:{...scope,protocol:'run-practice-inputs-v1',ruleVersion:options.ruleVersion,revision,headTick:head,committedThroughTick:committed,
   selfReplay:{schema:'run-practice-self-replay-v1',anchorTick:committed,player:{key:'self',checkpointU:checkpoint*300}}}};
}
const gate={canJump:true,pose:{checkpoint:30,distance:33,visualPlayer:{lane:1}},course:RUN_COURSES_V21.find(c=>c.id==='rapid-bridges')};
test('only two committed self falls at the same checkpoint enable help; changing serials cannot count twice',()=>{
 const h=tracker();assert(h.receive(authority({committed:350})));assert.equal(h.state().count,1);assert.equal(h.hint(gate),null);
 assert(h.receive(authority({revision:2,committed:400,events:[fall(300,999),fall(450)]})));assert.equal(h.state().count,1);
 assert(h.receive(authority({revision:3})));assert.equal(h.state().count,2);assert.deepEqual(h.hint(gate),{checkpoint:30,gapEnd:41});
 assert(h.receive(authority({revision:4,committed:520,events:[fall(300,1),fall(450,2)]})));assert.equal(h.state().count,2);
});
test('provisional falls removed by a revision, other players and hits never count',()=>{
 const h=tracker();h.receive(authority({committed:200}));assert.equal(h.state().count,0);
 h.receive(authority({revision:2,events:[{...fall(300),type:'hit'},{...fall(450),playerKey:'bot'}]}));assert.equal(h.state().count,0);
});
test('stale revision/epoch, inconsistent same revision and malformed authority leave help state unchanged',()=>{
 const h=tracker(),r=authority();h.receive(r);const before=h.state();
 const bads=[authority({revision:0}),authority({events:[]}),{...r,id:'other'},structuredClone(r),structuredClone(r),authority({revision:2,committed:499})];
 bads[3].run_inputs.clockEpoch=2;bads[4].game.events[0].tick=-1;
 for(const bad of bads){assert.equal(h.receive(bad),false);assert.deepEqual(h.state(),before);}
 assert.equal(h.receive(structuredClone(r)),true);assert.deepEqual(h.state(),before);
 assert.equal(createRunPracticeFallHelp({...scope,clockEpoch:2}).hint(gate),null);
});
test('display gate is read-only and hides during recovery, suspension, jumping, passed gap or advanced checkpoint',()=>{
 const h=tracker();h.receive(authority());const before=h.state();
 for(let i=0;i<100;i++)assert(h.hint(gate));assert.deepEqual(h.state(),before);
 for(const bad of [{...gate,canJump:false},{...gate,pose:null},{...gate,pose:{...gate.pose,distance:42}},{...gate,pose:{...gate.pose,checkpoint:60}}])assert.equal(h.hint(bad),null);
 h.receive(authority({revision:2,committed:600,checkpoint:60}));assert.equal(h.state().count,0);assert.equal(h.hint(gate),null);
});
