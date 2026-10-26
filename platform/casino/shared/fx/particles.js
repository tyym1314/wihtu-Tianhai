import {activeHalf} from '../half.mjs';
/**
 * Full-screen canvas particles (coins, sparks, confetti, fireworks) above the game, below dialogs.
 * One canvas per page, created on first use; draws only while particles are alive.
 * Coordinates are CSS pixels of the viewport; callers convert from design pixels with toScreen().
 */
const TAU=Math.PI*2;
let canvas=null,ctx=null,parts=[],raf=0,last=0,dpr=1,rains=[];
const lowEnd=()=>(navigator.hardwareConcurrency||4)<=4;
const MAX=()=>lowEnd()?260:520;

function ensure(){
 if(canvas)return;
 canvas=document.createElement('canvas');canvas.className='cs-fx-canvas';
 Object.assign(canvas.style,{position:'fixed',inset:'0',width:'100%',height:'100%',pointerEvents:'none',zIndex:'40'});
 document.body.appendChild(canvas);ctx=canvas.getContext('2d');resize();window.addEventListener('resize',resize);
}
function resize(){if(!canvas)return;dpr=Math.min(2,window.devicePixelRatio||1);canvas.width=innerWidth*dpr;canvas.height=innerHeight*dpr;}

/** Theme: colours for sparks / confetti and the coin tint (per game, see themes.js). */
const GEMS=['#5ad8ff','#9a6bff','#ff4fa3','#4fffa0','#fff3a0'];
const DEFAULT_THEME={coin:['#ffe58a','#f5b52e','#a86a0e'],spark:['#fff6c8','#ffd34d','#ff9f2e'],confetti:['#ffd34d','#ff5c7a','#56d1ff','#7dff8a','#c58bff']};

function spawn(p){if(parts.length<MAX())parts.push(p);}
const rnd=(a,b)=>a+Math.random()*(b-a),pick=a=>a[Math.floor(Math.random()*a.length)];

/** Burst at (x,y): kind = coins | sparks | confetti | firework. size scales speed and particle size. */
export function burst({kind='coins',x=innerWidth/2,y=innerHeight/2,count=40,size=1,theme=DEFAULT_THEME,angle=null,speed=null}={}){
 ensure();const t=theme||DEFAULT_THEME;
 for(let i=0;i<count;i++){
  // angle: [fromDeg, toDeg] for directional bursts (confetti cannons); 0deg = right, -90deg = up.
  const a=angle?rnd(angle[0],angle[1])*Math.PI/180:kind==='coins'?rnd(-Math.PI*0.92,-Math.PI*0.08):rnd(0,TAU),v=(speed?rnd(speed*0.6,speed):rnd(4,kind==='firework'?9:12))*size;
  if(kind==='coins')spawn({k:'coin',x,y,vx:Math.cos(a)*v*0.7,vy:Math.sin(a)*v*1.25,g:0.42*size,r:rnd(9,15)*size,spin:rnd(0,TAU),vs:rnd(0.15,0.35),life:rnd(70,110),c:t.coin});
  else if(kind==='sparks')spawn({k:'spark',x,y,vx:Math.cos(a)*v,vy:Math.sin(a)*v,g:0.06,r:rnd(1.6,3.2)*size,life:rnd(26,48),c:pick(t.spark)});
  else if(kind==='gem')spawn({k:'gem',x,y,vx:Math.cos(a)*v*0.6,vy:Math.sin(a)*v,g:0.3,r:rnd(7,12)*size,spin:rnd(0,TAU),vs:rnd(0.05,0.2),life:rnd(90,140),c:pick(t.gem||GEMS)});
  else if(kind==='confetti')spawn({k:'conf',x,y,vx:Math.cos(a)*v*0.8,vy:Math.sin(a)*v*0.8-4,g:0.16,r:rnd(5,9)*size,spin:rnd(0,TAU),vs:rnd(0.1,0.3),life:rnd(90,150),c:pick(t.confetti)});
  else spawn({k:'spark',x,y,vx:Math.cos(a)*v,vy:Math.sin(a)*v,g:0.05,r:rnd(1.8,3)*size,life:rnd(40,70),c:pick(t.confetti),trail:1});
 }
 run();
}
/** Coins (or confetti) falling from the top for `ms`; rate per second. */
export function rain({kind='coins',ms=2500,rate=40,size=1,theme=DEFAULT_THEME}={}){ensure();rains.push({kind,until:performance.now()+ms,rate,size,theme,acc:0});run();}
/** Firework shells rising from the bottom and bursting, for `ms`. */
export function fireworks({ms=3000,every=420,theme=DEFAULT_THEME,size=1}={}){
 ensure();const end=performance.now()+ms;
 const shoot=()=>{if(performance.now()>end)return;const x=rnd(innerWidth*0.15,innerWidth*0.85),y=rnd(innerHeight*0.15,innerHeight*0.45);
  burst({kind:'firework',x,y,count:lowEnd()?36:60,size,theme});burst({kind:'sparks',x,y,count:14,size,theme});setTimeout(shoot,every*rnd(0.7,1.3));};
 shoot();
}
export function clearFx(){parts=[];rains=[];}

function run(){if(!raf){last=performance.now();raf=requestAnimationFrame(frame);}}
function frame(now){
 const dt=Math.min(3,(now-last)/16.67);last=now;
 for(const r of rains){if(now>r.until)continue;r.acc+=r.rate*dt/60;while(r.acc>=1){r.acc--;
  if(r.kind==='coins')spawn({k:'coin',x:rnd(0,innerWidth),y:-20,vx:rnd(-1,1),vy:rnd(2,5)*r.size,g:0.22*r.size,r:rnd(9,15)*r.size,spin:rnd(0,TAU),vs:rnd(0.15,0.35),life:200,c:r.theme.coin});
  else if(r.kind==='gem')spawn({k:'gem',x:rnd(0,innerWidth),y:-20,vx:rnd(-1,1),vy:rnd(2,4)*r.size,g:0.2,r:rnd(7,12)*r.size,spin:rnd(0,TAU),vs:rnd(0.05,0.2),life:220,c:pick(r.theme.gem||GEMS)});
  else spawn({k:'conf',x:rnd(0,innerWidth),y:-20,vx:rnd(-1.5,1.5),vy:rnd(1.5,3.5),g:0.04,r:rnd(5,9)*r.size,spin:rnd(0,TAU),vs:rnd(0.1,0.3),life:260,c:pick(r.theme.confetti)});}}
 rains=rains.filter(r=>now<=r.until);
 ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,innerWidth,innerHeight);
 const alive=[];
 for(const p of parts){
  p.vy+=p.g*dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.life-=dt;if(p.spin!==undefined)p.spin+=p.vs*dt;
  if(p.life<=0||p.y>innerHeight+40)continue;alive.push(p);
  const fade=Math.min(1,p.life/20);ctx.globalAlpha=fade;
  if(p.k==='coin'){const w=Math.abs(Math.cos(p.spin))*p.r+1.5;ctx.fillStyle=p.c[2];ctx.beginPath();ctx.ellipse(p.x+1.5,p.y+1.5,w,p.r,0,0,TAU);ctx.fill();
   const g=ctx.createLinearGradient(p.x-w,p.y-p.r,p.x+w,p.y+p.r);g.addColorStop(0,p.c[0]);g.addColorStop(1,p.c[1]);ctx.fillStyle=g;ctx.beginPath();ctx.ellipse(p.x,p.y,w,p.r,0,0,TAU);ctx.fill();
   ctx.fillStyle='rgba(255,255,255,.55)';ctx.beginPath();ctx.ellipse(p.x-w*0.3,p.y-p.r*0.35,w*0.25,p.r*0.22,0,0,TAU);ctx.fill();}
  else if(p.k==='gem'){ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.spin);ctx.fillStyle=p.c;ctx.beginPath();ctx.moveTo(0,-p.r);ctx.lineTo(p.r*0.7,0);ctx.lineTo(0,p.r);ctx.lineTo(-p.r*0.7,0);ctx.closePath();ctx.fill();
   ctx.fillStyle='rgba(255,255,255,.65)';ctx.beginPath();ctx.moveTo(0,-p.r);ctx.lineTo(p.r*0.35,-p.r*0.2);ctx.lineTo(-p.r*0.2,-p.r*0.1);ctx.closePath();ctx.fill();ctx.restore();}
  else if(p.k==='conf'){ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.spin);ctx.fillStyle=p.c;ctx.fillRect(-p.r/2,-p.r/4,p.r,p.r/2*Math.abs(Math.cos(p.spin*1.7))+1);ctx.restore();}
  else{ctx.fillStyle=p.c;ctx.globalCompositeOperation='lighter';ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,TAU);ctx.fill();
   if(p.trail){ctx.globalAlpha=fade*0.35;ctx.beginPath();ctx.arc(p.x-p.vx*1.5,p.y-p.vy*1.5,p.r*0.8,0,TAU);ctx.fill();}ctx.globalCompositeOperation='source-over';}
 }
 ctx.globalAlpha=1;parts=alive;
 if(parts.length||rains.length)raf=requestAnimationFrame(frame);else{raf=0;ctx.clearRect(0,0,innerWidth,innerHeight);}
}

/** Design pixel (relative to the .cs-stage element) to viewport CSS pixel. */
export function toScreen(x,y){
 const st=document.querySelector('.cs-stage');if(!st)return [innerWidth/2,innerHeight/2];
 // Half layout: full-plate y is mapped onto the shortened plate.
 const r=st.getBoundingClientRect(),my=activeHalf?activeHalf.map(y):y;return [r.left+x*r.width/st.offsetWidth,r.top+my*r.height/st.offsetHeight];
}
