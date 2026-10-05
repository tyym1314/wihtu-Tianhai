export const RING_SIZE=52;
export const SAFE=[0,8,13,21,26,34,39,47];
// One continuous 52-cell outer track. Every fourth quadrant is a 90-degree rotation.
const first=[[0,6],[1,6],[2,6],[3,6],[4,6],[5,6],[6,5],[6,4],[6,3],[6,2],[6,1],[6,0],[7,0]];
const rotate=([x,y],turns)=>{for(let n=0;n<turns;n++)[x,y]=[14-y,x];return[x,y];};
export const RING=Array.from({length:4},(_,q)=>first.map(p=>rotate(p,q))).flat();
export const HOMES=Array.from({length:4},(_,q)=>Array.from({length:6},(_,i)=>rotate([i+1,7],q)));
export const BASES=Array.from({length:4},(_,q)=>[[2,2],[4,4]].map(p=>rotate(p,q)));
export function point(color,progress,piece=0){return progress<0?BASES[color][piece]:progress>=52?HOMES[color][progress-52]:RING[(color*13+progress)%52];}
