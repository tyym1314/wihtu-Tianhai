export const RUN_PRACTICE_COURSE_POLICY='run-practice-course-v1';
export const RUN_PRACTICE_DEFAULT_COURSE='sunrise-arches';
const metadata=c=>c&&typeof c.id==='string'&&/^[a-z-]+$/.test(c.id)&&[1,2,3].includes(c.difficulty)&&typeof c.title?.zh==='string'&&typeof c.title?.en==='string';
// An older server does not advertise this contract: never imply that it will
// honour a locally selected course merely because it supports practice input.
export function readRunPracticeCourses(context){
 const value=context?.run_practice_courses;
 return value?.policy===RUN_PRACTICE_COURSE_POLICY&&value.default_course_id===RUN_PRACTICE_DEFAULT_COURSE
  &&Array.isArray(value.courses)&&value.courses.length===6&&value.courses.every(metadata)
  &&new Set(value.courses.map(c=>c.id)).size===6&&value.courses.some(c=>c.id===value.default_course_id&&c.difficulty===1)?value:null;
}
export function confirmedRunPracticeCourse(room,expectedId){
 const c=room?.run_course;
 return room?.game_id==='run'&&room.practice===true&&room.entry_minor==='0'
  &&c?.policy===RUN_PRACTICE_COURSE_POLICY&&metadata(c)&&(!expectedId||c.id===expectedId)?c:null;
}
