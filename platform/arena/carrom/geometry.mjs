export const LEVEL_VERSION='oasis-carrom-wood-v1';
export const PHYSICS_VERSION='oasis-carrom-fixed240-v1';
export const BOARD=Object.freeze({half:4.5,outerHalf:5.05,coinRadius:.22,strikerRadius:.29,baseline:3.36,placementHalf:2.78,pocketRadius:.48,captureRadius:.43,pocketInset:4.27});
export const POCKETS=Object.freeze([[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y],i)=>Object.freeze({id:i,x:x*BOARD.pocketInset,y:y*BOARD.pocketInset,r:BOARD.pocketRadius})));
export function physicalSide(seatIndex,count){return count===2?seatIndex*2:seatIndex;}
/** Local seat coordinates have +Y toward the player and angle zero into the board. */
export function localToWorld(x,y,side){const a=side*Math.PI/2;return{x:x*Math.cos(a)-y*Math.sin(a),y:x*Math.sin(a)+y*Math.cos(a)};}
export function worldToLocal(x,y,side){return localToWorld(x,y,(4-side)%4);}
export function strikerPosition(seatIndex,count,offset){return localToWorld(offset*BOARD.placementHalf,BOARD.baseline,physicalSide(seatIndex,count));}
export function shotDirection(seatIndex,count,angle){return localToWorld(Math.sin(angle),-Math.cos(angle),physicalSide(seatIndex,count));}
export function initialCoins(seedHex){
 const coins=[{id:'queen',kind:'queen',x:0,y:0,pocketed:false}],rotation=parseInt(seedHex.slice(0,2),16)/256*Math.PI/3;let white=0,black=0;
 for(const ring of [1,2]){
  const points=[];for(let q=-ring;q<=ring;q++)for(let r=-ring;r<=ring;r++)if(Math.max(Math.abs(q),Math.abs(r),Math.abs(q+r))===ring){const x=(q+r/2)*.465,y=r*Math.sqrt(3)/2*.465;points.push({x,y,a:Math.atan2(y,x)});}
  points.sort((a,b)=>a.a-b.a);points.forEach((p,i)=>{const kind=i%2?'black':'white',id=kind==='white'?`w${white++}`:`b${black++}`;coins.push({id,kind,x:p.x*Math.cos(rotation)-p.y*Math.sin(rotation),y:p.x*Math.sin(rotation)+p.y*Math.cos(rotation),pocketed:false});});
 }return coins;
}
export function canPlace(coins,x,y,r=BOARD.strikerRadius,excludeId=null){return Math.abs(x)+r<=BOARD.half&&Math.abs(y)+r<=BOARD.half&&!POCKETS.some(p=>Math.hypot(x-p.x,y-p.y)<p.r+r)&&!coins.some(c=>!c.pocketed&&c.id!==excludeId&&Math.hypot(c.x-x,c.y-y)<BOARD.coinRadius+r+.006);}
export function validOffset(coins,seat,count,offset){if(!Number.isFinite(offset)||offset< -1||offset>1)return false;const p=strikerPosition(seat,count,offset);return canPlace(coins,p.x,p.y);}
export function nearestLegalOffset(coins,seat,count,wanted=0){for(let step=0;step<=200;step++){for(const sign of step?[1,-1]:[1]){const v=Math.max(-1,Math.min(1,wanted+sign*step*.01));if(validOffset(coins,seat,count,v))return Math.round(v*1e6)/1e6;}}return null;}
export function returnPosition(coins,id){
 const candidates=[{x:0,y:0}];for(let ring=1;ring<=10;ring++){const r=ring*.48,n=ring*12;for(let i=0;i<n;i++){const a=i/n*Math.PI*2;candidates.push({x:Math.sin(a)*r,y:-Math.cos(a)*r});}}
 // Clockwise square-grid rings are the deterministic final fallback.
 for(let ring=1;ring<=9;ring++){for(let x=-ring;x<ring;x++)candidates.push({x:x*.47,y:-ring*.47});for(let y=-ring;y<ring;y++)candidates.push({x:ring*.47,y:y*.47});for(let x=ring;x>-ring;x--)candidates.push({x:x*.47,y:ring*.47});for(let y=ring;y>-ring;y--)candidates.push({x:-ring*.47,y:y*.47});}
 return candidates.find(p=>canPlace(coins,p.x,p.y,BOARD.coinRadius,id))||null;
}
