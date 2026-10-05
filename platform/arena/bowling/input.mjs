import {PHYSICS} from './constants.mjs';
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n)),round=(n,places)=>Number(n.toFixed(places));
export function offsetAt(clientX,left,width){return round(clamp((clientX-left-width/2)/(width*.5)*PHYSICS.maxOffset,-PHYSICS.maxOffset,PHYSICS.maxOffset),2);}
/** Visible gesture intent only. The server still owns the entire rigid-body roll. */
export function swipeRoll(start,end,spin=0){
 const forward=start.y-end.y;if(forward<=25)return null;
 return{offset:start.offset,angle:round(clamp(Math.atan2(end.x-start.x,forward)*.18,-PHYSICS.maxAngle,PHYSICS.maxAngle),3),power:round(clamp(.25+forward/240,PHYSICS.minPower,1),2),spin};
}
