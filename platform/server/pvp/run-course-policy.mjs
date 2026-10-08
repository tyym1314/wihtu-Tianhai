import {fail} from '../security.mjs';
import {RUN_COURSES_V21} from '../../arena/run/courses.mjs';
import {runInstantPracticeStart} from '../../arena/run/start-policy.mjs';
import {RUN_PRACTICE_COURSE_POLICY,RUN_PRACTICE_DEFAULT_COURSE} from '../../arena/run/practice-course-contract.mjs';
const metadata=course=>({id:course.id,title:{...course.title},difficulty:course.difficulty});
export function runPracticeCourseCapability(){return {policy:RUN_PRACTICE_COURSE_POLICY,default_course_id:RUN_PRACTICE_DEFAULT_COURSE,courses:RUN_COURSES_V21.map(metadata)};}
export function newRunPracticeCourseOptions(gameId,practice,body){
 const explicit=body.run_course_id!==undefined||body.run_course_policy!==undefined||body.run_difficulty!==undefined;
 if(body.run_course_policy!==undefined||body.run_difficulty!==undefined)fail(400,'INVALID_RUN_COURSE');
 if(gameId!=='run'||!practice){
  if(explicit)fail(400,'INVALID_RUN_COURSE_MODE');
  return {};
 }
 // Existing clients may send a stake alongside practice; the coordinator
 // already normalizes it to zero. Preserve that legacy normalization while
 // rejecting an explicit course request that claims a paid entry.
 if(explicit&&body.entry_minor!==undefined&&body.entry_minor!=='0')fail(400,'INVALID_RUN_COURSE_MODE');
 const id=body.run_course_id===undefined?RUN_PRACTICE_DEFAULT_COURSE:body.run_course_id;
 if(!RUN_COURSES_V21.some(c=>c.id===id))fail(400,'INVALID_RUN_COURSE');
 return {run_course_policy:RUN_PRACTICE_COURSE_POLICY,run_course_id:id};
}
// Only persisted, explicitly versioned new rooms opt in. Missing old options
// remain absent through waiting, recovery and start; never retrofit a default.
export function storedRunPracticeCourse(room){
 const options=room.game_options;
 if(options?.run_course_policy===undefined&&options?.run_course_id===undefined)return null;
 const course=RUN_COURSES_V21.find(c=>c.id===options.run_course_id);
 if(options.run_course_policy!==RUN_PRACTICE_COURSE_POLICY||!course||room.game_id!=='run'||room.practice!==true||room.entry_minor!=='0'
  ||room.fee_bps!==0||!runInstantPracticeStart(room.rule_version)||!Array.isArray(room.players)
  ||room.players.length<2||room.players.length!==room.capacity||room.players.filter(p=>p.bot===false).length!==1
  ||room.players.some(p=>typeof p.bot!=='boolean'))fail(409,'INVALID_RUN_COURSE_POLICY');
 return {policy:RUN_PRACTICE_COURSE_POLICY,...metadata(course)};
}
