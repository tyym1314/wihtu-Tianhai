export const RING_SIZE=64;
// 16 holes per quadrant around a continuous stepped cross; clockwise from the left arm.
const quarter=[[0,8],[0,7],[0,6],[0,5],[0,4],[1,4],[2,4],[3,4],[4,4],[4,3],[4,2],[4,1],[4,0],[5,0],[6,0],[7,0]];
const rotate=([x,y],turns)=>{for(let n=0;n<turns;n++)[x,y]=[16-y,x];return[x,y];};
export const RING=Array.from({length:4},(_,q)=>quarter.map(p=>rotate(p,q))).flat();
export const HOMES=Array.from({length:4},(_,q)=>Array.from({length:4},(_,i)=>rotate([i+1,9],q)));
export const BASES=Array.from({length:4},(_,q)=>[[2,2],[3.5,2],[2,3.5],[3.5,3.5]].map(p=>rotate(p,q)));
export function point(seat,progress,piece=0){return progress<0?BASES[seat][piece]:progress>=64?HOMES[seat][progress-64]:RING[(seat*16+progress)%64];}
