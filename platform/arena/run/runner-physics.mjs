import {LANES,COLLIDER} from './level.mjs';
import {courseGapAt} from './courses.mjs';

export const RUN_RULES=Object.freeze({hz:60,durationMs:100000,baseSpeed:8,distanceUnitsPerMeter:300,baseUnitsPerTick:40,boostUnitsPerTick:48,changeTicks:12,jumpTicks:48,jumpHeight:1.2,slideTicks:36,stunTicks:48,immuneTicks:60,respawnTicks:90,shieldTicks:480,boostTicks:180,postFinishTicks:900,maxInputAgeTicks:120,inputRateTicks:6});
const round=n=>Math.round(n*1e7)/1e7;
export function runnerPose(p,tick){const laneT=p.changeEndTick>p.changeStartTick?Math.max(0,Math.min(1,(tick-p.changeStartTick)/(p.changeEndTick-p.changeStartTick))):1,x=LANES[p.fromLane]+(LANES[p.lane]-LANES[p.fromLane])*laneT,t=p.jumpStartTick===null?1:(tick-p.jumpStartTick)/RUN_RULES.jumpTicks,y=t>=0&&t<1?4*RUN_RULES.jumpHeight*t*(1-t):0;return{x:round(x),y:round(y),sliding:tick<p.slideUntilTick};}

function applyInput(p,tick,emit){const a=p.pendingInput;if(!a||a.tick>tick)return;p.pendingInput=null;p.appliedInputNo=a.no;
 if(a.type==='left'||a.type==='right'){p.fromLane=p.lane;p.lane+=a.type==='left'?-1:1;p.changeStartTick=tick;p.changeEndTick=tick+RUN_RULES.changeTicks;}
 else if(a.type==='jump')p.jumpStartTick=tick;
 else if(a.type==='slide')p.slideUntilTick=tick+RUN_RULES.slideTicks;
 else {const item=p.inventory;p.inventory=null;if(item==='shield')p.shieldUntilTick=tick+RUN_RULES.shieldTicks;else if(item==='boost')p.boostUntilTick=tick+RUN_RULES.boostTicks;}
 emit(a.type==='item'?'item_used':a.type,{inputNo:a.no,item:a.item||null});
}

/** Step one owned runner at an integer simulation tick; the caller owns event IDs and race results. */
export function stepRunnerInPlace(p,tick,course,{at:tickAt,emit}){
 const OBSTACLES=course.obstacles,ITEMS=course.items,END=course.trackLength*300,gapAt=(x,z,r=0)=>courseGapAt(course,x,z,r);
 if(p.forfeited||p.finishTick!==null)return;applyInput(p,tick,emit);if(p.fallUntilTick!==null){if(tick<p.fallUntilTick)return;p.distanceU=p.checkpointU;p.fallUntilTick=null;p.jumpStartTick=null;p.slideUntilTick=0;p.fromLane=p.lane;p.changeStartTick=tick;p.changeEndTick=tick;p.resolvedObstacles=p.resolvedObstacles.filter(id=>OBSTACLES.find(o=>o.id===id)?.z<p.distanceU/300-1);emit('respawn',{checkpoint:p.distanceU/300});}
 const at=runnerPose(p,tick);if(tick<p.stunUntilTick)return;const previous=p.distanceU,velocity=tick<p.boostUntilTick?RUN_RULES.boostUnitsPerTick:RUN_RULES.baseUnitsPerTick;p.distanceU=Math.min(END,p.distanceU+velocity);const z=p.distanceU/300;
 if(gapAt(at.x,z,COLLIDER.radius*.35)&&at.y<.12){p.fallUntilTick=tick+RUN_RULES.respawnTicks;p.fallStartTick=tick;p.pendingInput=null;p.hits++;emit('fall',{checkpoint:p.checkpointU/300});return;}
 for(const obstacle of OBSTACLES){if(p.resolvedObstacles.includes(obstacle.id))continue;const half=obstacle.depth/2+COLLIDER.radius;if(z<obstacle.z-half||previous/300>obstacle.z+half||Math.abs(at.x-obstacle.x)>(obstacle.width/2+COLLIDER.radius))continue;const top=at.y+(at.sliding?COLLIDER.slideHeight:COLLIDER.standingHeight),blocked=at.y<obstacle.bottom+obstacle.height&&top>obstacle.bottom;if(!blocked)continue;p.resolvedObstacles.push(obstacle.id);if(tick<p.immuneUntilTick)continue;if(tick<p.shieldUntilTick){p.shieldUntilTick=0;emit('shield_hit',{obstacleId:obstacle.id});}else{p.stunUntilTick=tick+RUN_RULES.stunTicks;p.immuneUntilTick=p.stunUntilTick+RUN_RULES.immuneTicks;p.hits++;emit('hit',{obstacleId:obstacle.id});}break;}
 const checkpoint=Math.floor(z/30)*30*300;if(checkpoint>p.checkpointU&&!gapAt(at.x,z))p.checkpointU=Math.min(END,checkpoint);
 for(const item of ITEMS)if(previous<item.z*300&&p.distanceU>=item.z*300&&!p.claimedItems.includes(item.id)){p.claimedItems.push(item.id);if(p.inventory===null){p.inventory=item.type;emit('item_pickup',{item:item.type});}else emit('item_skipped',{item:item.type});}
 if(p.distanceU>=END){p.finishTick=tick;p.finishedAt=tickAt;p.pendingInput=null;emit('finish');}
}
