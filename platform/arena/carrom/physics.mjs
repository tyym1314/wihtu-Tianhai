import {BOARD,POCKETS,strikerPosition,shotDirection} from './geometry.mjs';
export const PHYSICS=Object.freeze({dt:1/240,maxSeconds:12,maxSpeed:18,friction:2.4,coinRestitution:.91,wallRestitution:.8,stopSpeed:.025,sampleHz:30});
const round=n=>Math.round(n*1e9)/1e9,sample=n=>Math.round(n*1e4)/1e4;
/** Fixed-step planar disc physics. Only server engine calls this to create an authoritative result. */
export function simulateShot(coins,seat,count,action){
 const pos=strikerPosition(seat,count,action.offset),dir=shotDirection(seat,count,action.angle);
 const bodies=coins.filter(c=>!c.pocketed).map(c=>({...c,r:BOARD.coinRadius,m:1,vx:0,vy:0,active:true}));
 bodies.push({id:'striker',kind:'striker',x:pos.x,y:pos.y,r:BOARD.strikerRadius,m:1.5,vx:dir.x*action.power*PHYSICS.maxSpeed,vy:dir.y*action.power*PHYSICS.maxSpeed,active:true});
 const trajectory=[],events=[],pocketed=[],ejected=[];let t=0,fault=false,lastHit=-100;
 const frame=()=>trajectory.push({t,positions:bodies.map(b=>[b.id,sample(b.x),sample(b.y),b.active?1:0])});frame();
 const capture=()=>{for(const b of bodies){if(!b.active)continue;const p=POCKETS.find(p=>Math.hypot(b.x-p.x,b.y-p.y)<BOARD.captureRadius);if(p){b.active=false;b.vx=b.vy=0;pocketed.push(b.id);events.push({type:'pocket',id:b.id,kind:b.kind,pocket:p.id,t,x:sample(p.x),y:sample(p.y)});}else if(Math.abs(b.x)>BOARD.half+1||Math.abs(b.y)>BOARD.half+1){b.active=false;b.vx=b.vy=0;ejected.push(b.id);events.push({type:'ejected',id:b.id,kind:b.kind,t,x:sample(b.x),y:sample(b.y)});}}};
 for(let step=1;step<=PHYSICS.maxSeconds/PHYSICS.dt;step++){
  t=Math.round(step*PHYSICS.dt*1000);
  for(const b of bodies){if(!b.active)continue;const speed=Math.hypot(b.vx,b.vy),next=Math.max(0,speed-PHYSICS.friction*PHYSICS.dt),f=speed?next/speed:0;b.vx*=f;b.vy*=f;b.x+=b.vx*PHYSICS.dt;b.y+=b.vy*PHYSICS.dt;}
  capture();
  for(let pass=0;pass<2;pass++){
   for(let i=0;i<bodies.length;i++){const a=bodies[i];if(!a.active)continue;for(let j=i+1;j<bodies.length;j++){const b=bodies[j];if(!b.active)continue;let dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy),limit=a.r+b.r;if(d>=limit)continue;if(d<1e-10){dx=1;dy=0;d=1e-10;}const nx=dx/(d<1e-9?1:d),ny=dy/(d<1e-9?1:d),invA=1/a.m,invB=1/b.m,sum=invA+invB,overlap=limit-d+.00001;a.x-=nx*overlap*invA/sum;a.y-=ny*overlap*invA/sum;b.x+=nx*overlap*invB/sum;b.y+=ny*overlap*invB/sum;const approach=(b.vx-a.vx)*nx+(b.vy-a.vy)*ny;
    if(approach<0){const impulse=-(1+PHYSICS.coinRestitution)*approach/sum;a.vx-=impulse*nx*invA;a.vy-=impulse*ny*invA;b.vx+=impulse*nx*invB;b.vy+=impulse*ny*invB;if(t-lastHit>35){events.push({type:'hit',a:a.id,b:b.id,t,x:sample((a.x+b.x)/2),y:sample((a.y+b.y)/2),strength:sample(Math.min(1,Math.abs(approach)/12))});lastHit=t;}}
   }}
   capture();
   for(const b of bodies){if(!b.active)continue;const edge=BOARD.half-b.r;let bounce=false;if(b.x>edge){b.x=edge;if(b.vx>0){b.vx=-b.vx*PHYSICS.wallRestitution;bounce=true;}}else if(b.x< -edge){b.x=-edge;if(b.vx<0){b.vx=-b.vx*PHYSICS.wallRestitution;bounce=true;}}if(b.y>edge){b.y=edge;if(b.vy>0){b.vy=-b.vy*PHYSICS.wallRestitution;bounce=true;}}else if(b.y< -edge){b.y=-edge;if(b.vy<0){b.vy=-b.vy*PHYSICS.wallRestitution;bounce=true;}}if(bounce&&t-lastHit>35){events.push({type:'bounce',id:b.id,t,x:sample(b.x),y:sample(b.y),strength:sample(Math.min(1,Math.hypot(b.vx,b.vy)/10))});lastHit=t;}}
  }
  let moving=false;for(const b of bodies){b.x=round(b.x);b.y=round(b.y);b.vx=round(b.vx);b.vy=round(b.vy);if(Math.hypot(b.vx,b.vy)<=PHYSICS.stopSpeed)b.vx=b.vy=0;if(b.active&&(b.vx||b.vy))moving=true;if(!Number.isFinite(b.x+b.y+b.vx+b.vy)){fault=true;moving=false;}}
  if(step%8===0||!moving)frame();if(!moving)break;if(step===PHYSICS.maxSeconds/PHYSICS.dt)fault=true;
 }
 return {duration:Math.max(200,t),fault,pocketed,ejected,trajectory,events,coins:coins.map(c=>{const b=bodies.find(b=>b.id===c.id);return b?{id:c.id,kind:c.kind,x:b.x,y:b.y,pocketed:!b.active}:{...c};})};
}
