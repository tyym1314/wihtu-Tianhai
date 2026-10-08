const HZ=60;
const physical=new Set(['hit','shield_hit','fall','respawn','collision']);
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));

/** Renderer-only integration of one already computed interval. Canonical state
 * and its integer clock are untouched. A fixed previous interval is retained,
 * never another interval for each recovery. All end-state metadata follows the
 * causal endpoint; controlTick is only for the hit-animation expiry predicate.
 * The caller owns and validates any inherited two-frame predecessor capsule. */
export function sampleRunCausalFrames(frames,sourceTick,sourceVersion,elapsed,limitMs,predecessor=null){
 if(!frames||!Number.isFinite(elapsed))return null;
 let offset=Math.min(frames.length-1,clamp(elapsed,0,limitMs)*HZ/1000);
 const nearest=Math.round(offset);if(Math.abs(offset-nearest)<=Number.EPSILON*Math.max(1,offset)*4)offset=nearest;
 const index=Math.floor(offset),fraction=offset-index,anchor=index===0&&predecessor===null;
 if(index===0&&predecessor&&(predecessor.previous?.tick!==sourceTick-1||predecessor.endpoint?.tick!==sourceTick))return null;
 const left=index?frames[index-1]:predecessor?.previous??frames[0];
 // A received base has no historical event label. Inherit that label only
 // from the trajectory whose full canonical endpoint the timeline verified.
 const originalRight=frames[index],boundary=index===0&&predecessor?predecessor.endpoint.boundary:originalRight.boundary;
 const boundaryEvents=index===0&&predecessor?predecessor.endpoint.boundaryEvents:originalRight.boundaryEvents;
 const hard=physical.has(boundary)||(boundaryEvents??[]).some(type=>physical.has(type));
 const mix=anchor||hard?0:fraction,causalTick=anchor?sourceTick:sourceTick+offset-1;
 const distance=left.distance+(originalRight.distance-left.distance)*mix;
 return{...left,
  x:left.x+(originalRight.x-left.x)*mix,y:left.y+(originalRight.y-left.y)*mix,
  distance:Math.min(480,distance),scale:left.scale+(originalRight.scale-left.scale)*mix,
  tick:causalTick,causalTick,eventTick:causalTick,controlTick:sourceTick+offset,
  projected:true,sourceTick,sourceVersion,
  visualSpeed:anchor||hard||offset>=frames.length-1||elapsed>=limitMs?0:Math.max(0,(originalRight.distance-left.distance)*HZ),
  causalFromTick:left.tick,causalToTick:originalRight.tick,causalMix:mix,causalBoundary:boundary,
  // Keep the look-ahead diagnostic separate from the owned visible state.
  boundary:fraction>0&&boundary!==null?boundary:left.boundary,
 };
}
