/** Art footprint and interaction footprint deliberately use different sizes. */
export function towerMetrics(width,height){
 const artWidth=Math.max(34,Math.min(52,width*.122,height*.15));
 return{artWidth,hitWidth:48,hitHeight:52};
}
export function towerPoint(t,width,height,rotation=0){const dx=t.x-.5,dy=t.y-.5,c=Math.cos(rotation),s=Math.sin(rotation),x=.5+dx*c-dy*s,y=.5+dx*s+dy*c;return{x:20+x*(width-40),y:70+y*(height-112)};}
export function layoutTowerPoints(towers,width,height,rotation=0){
 const points=towers.map(t=>towerPoint(t,width,height,rotation)),m=towerMetrics(width,height),gap=3;
 // The authoritative graph stays the same. On short screens gently separate
 // overlapping targets in screen space; Canvas roads and DOM buttons share it.
 for(let pass=0;pass<80;pass++){
  let moved=false;
  for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){
   const a=points[i],b=points[j],dx=b.x-a.x,dy=b.y-a.y,px=m.hitWidth+gap-Math.abs(dx),py=m.hitHeight+gap-Math.abs(dy);
   if(px<=.05||py<=.05)continue;
   const axis=px<py?'x':'y',amount=(axis==='x'?px:py)+.1,direction=Math.sign(axis==='x'?dx:dy)||1;
   const aFixed=towers[i].core||towers[i].kind==='citadel',bFixed=towers[j].core||towers[j].kind==='citadel';
   if(!aFixed)a[axis]-=direction*amount*(bFixed?1:.5);
   if(!bFixed)b[axis]+=direction*amount*(aFixed?1:.5);
   moved=true;
  }
  for(const point of points){point.x=Math.max(m.hitWidth/2+3,Math.min(width-m.hitWidth/2-3,point.x));point.y=Math.max(62,Math.min(height-8,point.y));}
  if(!moved)break;
 }
 return points;
}
export function towerHitAt(points,x,y,metrics){
 let selected=null,best=Infinity;
 for(let i=0;i<points.length;i++){
  const point=points[i],dx=x-point.x,dy=y-(point.y-metrics.hitHeight*.41);
  // Finite rectangles prevent a drag in empty ground choosing a distant tower.
  if(Math.abs(dx)>metrics.hitWidth/2||Math.abs(dy)>metrics.hitHeight/2)continue;
  const distance=(dx/(metrics.hitWidth/2))**2+(dy/(metrics.hitHeight/2))**2;
  if(distance<best){best=distance;selected=i;}
 }
 return selected;
}
