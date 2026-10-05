/** One geometry source for SVG and authoritative hit testing. Radius 1 is the outer double wire. */
export const BOARD_VERSION='darts-board-v1';
export const SEGMENTS=Object.freeze([20,1,18,4,13,6,10,15,2,17,3,19,7,16,8,11,14,9,12,5]);
export const RINGS=Object.freeze({innerBull:6.35/170,outerBull:15.9/170,tripleIn:99/170,tripleOut:107/170,doubleIn:162/170,doubleOut:1});
const invalid=(message)=>{const e=new Error(message);e.code='INVALID_GESTURE';e.status=400;throw e;};
export function scorePoint(x,y){
 if(!Number.isFinite(x)||!Number.isFinite(y))invalid('Finite target geometry required');const radius=Math.hypot(x,y);
 if(radius>=1)return{score:0,label:'MISS',number:0,multiplier:0,x,y};
 if(radius<RINGS.innerBull)return{score:50,label:'BULL',number:50,multiplier:1,x,y};
 if(radius<RINGS.outerBull)return{score:25,label:'25',number:25,multiplier:1,x,y};
 const theta=(Math.atan2(x,-y)+Math.PI*2+Math.PI/20)%(Math.PI*2),number=SEGMENTS[Math.floor(theta/(Math.PI/10))];
 const multiplier=radius>=RINGS.doubleIn?2:radius>=RINGS.tripleIn&&radius<RINGS.tripleOut?3:1;
 return{score:number*multiplier,label:(multiplier===3?'T':multiplier===2?'D':'')+number,number,multiplier,x,y};
}
export function mapGesture(gesture){
 if(!Array.isArray(gesture)||gesture.length<3||gesture.length>128)invalid('Use a recorded drag with 3–128 samples');
 let distance=0;for(let i=0;i<gesture.length;i++){const p=gesture[i];if(!p||Object.keys(p).some(k=>!['x','y','t'].includes(k))||!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1.6||Math.abs(p.y)>1.6||!Number.isInteger(p.t)||p.t<0)invalid('Invalid gesture coordinates');if(i){const q=gesture[i-1],dt=p.t-q.t,travel=Math.hypot(p.x-q.x,p.y-q.y);if(dt<=0||travel/dt>.045)invalid('Gesture samples must have plausible increasing timestamps');distance+=travel;}else if(p.t!==0)invalid('Gesture must start at t=0');}
 const first=gesture[0],last=gesture.at(-1);if(last.t<80||last.t>2000||distance<.06||distance>6)invalid('Drag for 80–2000 ms before release');
 let anchor=gesture.length-2;while(anchor>0&&last.t-gesture[anchor].t<60)anchor--;const velocity=gesture[anchor],dt=last.t-velocity.t;
 // Fixed, public release mapping: the full displacement and final ~60ms velocity matter.
 const x=last.x+.1*(last.x-first.x)+15*(last.x-velocity.x)/dt,y=last.y+.1*(last.y-first.y)+15*(last.y-velocity.y)/dt;
 return{...scorePoint(Number(x.toFixed(6)),Number(y.toFixed(6))),durationMs:last.t,distance:Number(distance.toFixed(6))};
}
/** Server test/BOT input helper. It still creates a legal gesture evaluated by mapGesture. */
export function gestureToward(x,y){const dy=-.22,duration=400,adjust=.1*dy+15*dy/duration,ey=y-adjust;return[0,100,200,300,400].map(t=>({x,y:ey-dy+dy*t/duration,t}));}
export function sectorPath(inner,outer,index){const lo=(index*18-9)*Math.PI/180,hi=(index*18+9)*Math.PI/180;const p=(r,a)=>`${(Math.sin(a)*r).toFixed(6)} ${(-Math.cos(a)*r).toFixed(6)}`;return`M ${p(inner,lo)} L ${p(outer,lo)} A ${outer} ${outer} 0 0 1 ${p(outer,hi)} L ${p(inner,hi)} A ${inner} ${inner} 0 0 0 ${p(inner,lo)} Z`;}
