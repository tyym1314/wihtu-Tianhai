import * as legacy from './level.mjs';

export const CONTENT_VERSION='dune-courses-v2.0.0';
export const SAFE_INTRO_CONTENT_VERSION='dune-courses-v2.1.0';
export const SAFE_INTRO_METERS=30;
const all=[0,1,2];
// Each 60m segment has safe boundaries and 30m checkpoints. Compositions are
// authored and replay-tested; arbitrary random concatenation is not allowed.
const SEGMENTS={
 weave:{rows:[[14,'crate',[1,2]],[38,'beam',[0,1]]],gaps:[[48,51,[1,2]]],lanes:[[3,0],[26,2]]},
 arches:{rows:[[14,'crate',all],[40,'beam',all]],gaps:[],lanes:[]},
 stepping:{rows:[[14,'beam',[0,1]],[42,'crate',[1,2]]],gaps:[[24,27,[0]]],lanes:[[3,2],[34,0]]},
 water:{rows:[[36,'beam',all],[50,'crate',all]],gaps:[[14,17,all]],lanes:[]},
 cross:{rows:[[14,'crate',[1,2]],[50,'beam',[0,1]]],gaps:[[34,37,all]],lanes:[[3,0],[44,2]]},
 rhythm:{rows:[[14,'beam',all],[28,'crate',all],[46,'beam',all]],gaps:[],lanes:[]},
 pulse:{rows:[[10,'crate',all],[22,'beam',all],[50,'crate',all]],gaps:[[38,41,all]],lanes:[]},
 zigzag:{rows:[[10,'beam',[0,1]],[24,'crate',[1,2]],[50,'beam',all]],gaps:[[38,41,[0,1]]],lanes:[[2,2],[16,0],[30,2]]},
};
const definitions=[
 ['palm-weave',1,'椰影换道','Palm Weave',['weave','stepping','arches','weave','arches','stepping','weave','arches']],
 ['sunrise-arches',1,'晨光拱廊','Sunrise Arches',['arches','arches','stepping','arches','weave','arches','stepping','arches']],
 ['canal-crossing',2,'运河交错','Canal Crossing',['cross','water','weave','cross','rhythm','water','cross','arches']],
 ['red-beam-rhythm',2,'红梁节奏','Red Beam Rhythm',['rhythm','cross','rhythm','water','rhythm','stepping','rhythm','cross']],
 ['rapid-bridges',3,'急流连桥','Rapid Bridges',['pulse','zigzag','water','pulse','rhythm','pulse','zigzag','pulse']],
 ['oasis-switchbacks',3,'绿洲折返','Oasis Switchbacks',['zigzag','pulse','zigzag','cross','zigzag','rhythm','pulse','zigzag']],
];
const deepFreeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;};
function build([id,difficulty,titleZh,titleEn,segments]){
 const obstacles=[],gaps=[],guide=[];
 segments.forEach((name,index)=>{const offset=index*60,segment=SEGMENTS[name];
  for(const[z,type,lanes]of segment.rows)for(const lane of lanes)obstacles.push({id:`${id}-${index}-${type}-${z}-${lane}`,type,lane,x:legacy.LANES[lane],z:offset+z,width:1.12,depth:.65,bottom:type==='beam'?.8:0,height:.6});
  for(const[start,end,lanes]of segment.gaps)gaps.push({id:`${id}-${index}-gap-${start}`,start:offset+start,end:offset+end,lanes:[...lanes]});
  for(const[z,lane]of segment.lanes)guide.push({z:offset+z,lane});
 });
 return deepFreeze({id,contentVersion:CONTENT_VERSION,levelVersion:`${CONTENT_VERSION}/${id}`,physicsVersion:legacy.PHYSICS_VERSION,trackLength:480,difficulty,title:{zh:titleZh,en:titleEn,ar:titleEn},segments:[...segments],obstacles,gaps,items:legacy.ITEMS.map(x=>({...x})),checkpoints:[...legacy.CHECKPOINTS],guide});
}
export const RUN_COURSES=deepFreeze(definitions.map(build));
// V2.1 keeps the six pinned routes and their later challenge, but gives every
// lane a hazard-free first 30 m. V2.0 objects remain byte-for-byte unchanged.
export const RUN_COURSES_V21=deepFreeze(RUN_COURSES.map(course=>({
 ...course,contentVersion:SAFE_INTRO_CONTENT_VERSION,
 levelVersion:`${SAFE_INTRO_CONTENT_VERSION}/${course.id}`,
 obstacles:course.obstacles.filter(obstacle=>obstacle.z>=SAFE_INTRO_METERS),
 gaps:course.gaps.filter(gap=>gap.start>=SAFE_INTRO_METERS),
})));
const original=deepFreeze({id:'golden-causeway-v1',contentVersion:legacy.LEVEL_VERSION,levelVersion:legacy.LEVEL_VERSION,physicsVersion:legacy.PHYSICS_VERSION,trackLength:legacy.TRACK_LENGTH,difficulty:1,title:{zh:'金色绿洲长桥',en:'Oasis Crossing',ar:'جسر الواحة'},obstacles:legacy.OBSTACLES,gaps:legacy.GAPS,items:legacy.ITEMS,checkpoints:legacy.CHECKPOINTS,guide:[]});
export function selectRunCourse(seed,ruleVersion='pvp-run-v2.0.0'){const courses=ruleVersion==='pvp-run-v2.1.0'?RUN_COURSES_V21:RUN_COURSES;return courses[Number.parseInt(seed.slice(0,8),16)%courses.length];}
export function resolveRunCourse(state){
 if(['pvp-run-v2.0.0','pvp-run-v2.1.0'].includes(state?.ruleVersion)&&!state.courseId)throw new Error('Missing pinned Dune Dash course');
 if(!state?.courseId&&(!state?.levelVersion||state.levelVersion===legacy.LEVEL_VERSION))return original;
 const courses=state?.ruleVersion==='pvp-run-v2.1.0'?RUN_COURSES_V21:RUN_COURSES;
 const course=courses.find(c=>c.id===state.courseId);
 if(!course||state.contentVersion!==course.contentVersion||state.levelVersion!==course.levelVersion)throw new Error('Unsupported pinned Dune Dash course');
 return course;
}
export function courseGapAt(course,x,z,radius=0){return course.gaps.find(g=>z+radius>g.start&&z-radius<g.end&&g.lanes.some(lane=>Math.abs(x-legacy.LANES[lane])<.75));}
export function visibleCourse(course,distance,behind=8,ahead=105){return{obstacles:course.obstacles.filter(o=>o.z>=distance-behind&&o.z<=distance+ahead),gaps:course.gaps.filter(g=>g.end>=distance-behind&&g.start<=distance+ahead),items:course.items.filter(i=>i.z>=distance-behind&&i.z<=distance+ahead)};}
