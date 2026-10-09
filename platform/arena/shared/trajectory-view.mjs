/** Index immutable, server-authored rows once per shot. No physics is predicted.
 * Reuse visible piece objects and trail ranges while rendering that trajectory.
 */
export function trajectoryBound(frames,time,inclusive=false){
 let lo=0,hi=frames.length;
 while(lo<hi){const mid=(lo+hi)>>>1;if(frames[mid].t<time||(inclusive&&frames[mid].t===time))lo=mid+1;else hi=mid;}
 return lo;
}
export function createTrajectoryView(source,{idField='n',withRoll=false,expandDeltas=false,kindForId}={}){
 const remembered=new Map(),pieces=new Map(),visible=[],range={start:0,end:0};
 const frames=source.map(frame=>{
  const positions=new Map(expandDeltas?remembered:[]);
  for(const row of frame.positions)positions.set(row[0],row);
  if(expandDeltas){remembered.clear();for(const [id,row]of positions)remembered.set(id,row);}
  return{t:frame.t,positions,rows:[...positions.values()]};
 });
 function sample(elapsed){
  visible.length=0;if(!frames.length)return visible;
  const index=Math.max(0,trajectoryBound(frames,elapsed,true)-1),a=frames[index],b=frames[Math.min(index+1,frames.length-1)];
  const f=b.t===a.t?0:Math.max(0,Math.min(1,(elapsed-a.t)/(b.t-a.t)));
  for(const row of a.rows){
   if(!row[3])continue;
   const id=row[0],next=b.positions.get(id)||row;
   let piece=pieces.get(id);
   if(!piece){piece={[idField]:id};if(kindForId)piece.kind=kindForId(id);pieces.set(id,piece);}
   piece.x=row[1]+(next[1]-row[1])*f;piece.y=row[2]+(next[2]-row[2])*f;piece.alpha=next[3]?1:1-f;
   if(withRoll)piece.roll=row[4]+(next[4]-row[4])*f;
   visible.push(piece);
  }
  return visible;
 }
 function trail(elapsed,tail){range.start=trajectoryBound(frames,elapsed-tail);range.end=trajectoryBound(frames,elapsed,true);return range;}
 return{frames,sample,trail};
}
