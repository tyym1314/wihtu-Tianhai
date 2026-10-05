/** Shared public level/collision geometry; no hidden randomness or client physics authority. */
export const LEVEL_VERSION='dune-oasis-480-v1.0.0';
export const PHYSICS_VERSION='run-60hz-v1.0.0';
export const TRACK_LENGTH=480;
export const LANES=[-1.5,0,1.5];
export const COLLIDER=Object.freeze({radius:.27,standingHeight:1.45,slideHeight:.55});
const rows=[
 [24,'crate',[1]],[43,'beam',[0,2]],[73,'crate',[0,1]],[104,'beam',[1,2]],
 [133,'crate',[0,2]],[163,'beam',[0,1]],[193,'crate',[1,2]],[222,'beam',[0,2]],
 [253,'crate',[0,1]],[283,'beam',[1]],[313,'crate',[0,2]],[344,'beam',[0,1]],
 [373,'crate',[1,2]],[403,'beam',[0,2]],[433,'crate',[0,1]],[461,'beam',[1,2]]
];
export const OBSTACLES=rows.flatMap(([z,type,lanes])=>lanes.map(lane=>({id:`${type}-${z}-${lane}`,type,lane,x:LANES[lane],z,width:1.12,depth:.65,bottom:type==='beam'?.8:0,height:type==='beam'?.6:.6})));
export const GAPS=[{start:52,end:55,lanes:[2]},{start:84,end:87,lanes:[0,1,2]},{start:143,end:146,lanes:[1,2]},{start:204,end:207,lanes:[0,1,2]},{start:264,end:267,lanes:[0,1]},{start:324,end:327,lanes:[0,1,2]},{start:384,end:387,lanes:[1,2]},{start:444,end:447,lanes:[0,1,2]}].map((g,i)=>({...g,id:`gap-${i}`}));
export const CHECKPOINTS=Array.from({length:17},(_,i)=>i*30);
export const ITEMS=[{id:'shield-60',z:60,type:'shield'},{id:'boost-180',z:180,type:'boost'},{id:'shield-300',z:300,type:'shield'}];
export const CHARACTERS=['fox','cat','bear','rabbit'];
export function gapAt(x,z,radius=0){return GAPS.find(g=>z+radius>g.start&&z-radius<g.end&&g.lanes.some(lane=>Math.abs(x-LANES[lane])<.75));}
export function visibleLevel(distance,behind=8,ahead=105){return{obstacles:OBSTACLES.filter(o=>o.z>=distance-behind&&o.z<=distance+ahead),gaps:GAPS.filter(g=>g.end>=distance-behind&&g.start<=distance+ahead),items:ITEMS.filter(i=>i.z>=distance-behind&&i.z<=distance+ahead)};}
