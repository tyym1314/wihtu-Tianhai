/** Shared, versioned geometry. The renderer and authoritative physics consume these same coordinates. */
export const LEVEL_VERSION='oasis-golf-islands-v1';
export const PHYSICS_VERSION='oasis-golf-fixed120-v1';
export const BALL_RADIUS=.2;
export const WALL_HALF_WIDTH=.09;
const courses=[
 {id:'palm-passage',name:'棕榈迎风',nameEn:'PALM PASSAGE',par:3,tee:{x:0,z:8},cup:{x:0,z:-8},nodes:[[0,8,1.65],[0,5.8,1.55],[-.65,3.5,1.45],[.25,.3,1.55],[.6,-3.1,1.5],[0,-5.9,1.9],[0,-8,2.1]],openEdges:[],bumpers:[{x:.77,z:1.9,r:.36}],bridgeAt:.49,accent:'#59c58f'},
 {id:'moonwater-bend',name:'月泉回廊',nameEn:'MOONWATER BEND',par:4,tee:{x:1.25,z:8},cup:{x:1.75,z:-8},nodes:[[1.25,8,1.8],[1.1,5.5,1.55],[-1.6,3.2,1.45],[-2.1,.4,1.4],[-1.6,-2.1,1.5],[.6,-3.9,1.5],[1.8,-5.7,1.65],[1.75,-8,2.1]],openEdges:[{side:'left',from:.36,to:.54}],bumpers:[{x:-.6,z:-3,r:.3}],bridgeAt:.31,accent:'#6ac46c'},
 {id:'royal-crescent',name:'王冠花园',nameEn:'ROYAL CRESCENT',par:4,tee:{x:-.8,z:8},cup:{x:.8,z:-8},nodes:[[-.8,8,1.8],[-.8,5.6,1.5],[.7,3.2,1.6],[1.15,.2,1.65],[-.65,-2.6,1.65],[-.65,-5.5,1.65],[.8,-8,2.2]],openEdges:[{side:'right',from:.23,to:.34}],bumpers:[{x:.5,z:2.7,r:.4},{x:.75,z:-1,r:.33},{x:-1.1,z:-5.2,r:.3}],bridgeAt:.65,accent:'#73c984'}
];
const lerp=(a,b,t)=>a+(b-a)*t;
function curve(a,b,c,d,t){return .5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t);}
function build(course){
 const samples=[],n=course.nodes.length;
 for(let i=0;i<n-1;i++)for(let j=0;j<12;j++){
  const t=j/12,a=course.nodes[Math.max(0,i-1)],b=course.nodes[i],c=course.nodes[i+1],d=course.nodes[Math.min(n-1,i+2)];
  samples.push({x:curve(a[0],b[0],c[0],d[0],t),z:curve(a[1],b[1],c[1],d[1],t),width:lerp(b[2],c[2],t),progress:(i+t)/(n-1)});
 }
 const end=course.nodes.at(-1);samples.push({x:end[0],z:end[1],width:end[2],progress:1});
 samples.forEach((p,i)=>{const a=samples[Math.max(0,i-1)],b=samples[Math.min(samples.length-1,i+1)],len=Math.hypot(b.x-a.x,b.z-a.z);p.tx=(b.x-a.x)/len;p.tz=(b.z-a.z)/len;p.nx=-p.tz;p.nz=p.tx;});
 const left=samples.map(p=>({x:p.x+p.nx*p.width,z:p.z+p.nz*p.width,side:'left',progress:p.progress}));
 const right=samples.map(p=>({x:p.x-p.nx*p.width,z:p.z-p.nz*p.width,side:'right',progress:p.progress}));
 const polygon=[...left],last=samples.at(-1),first=samples[0];
 for(let j=1;j<12;j++){const a=j*Math.PI/12;polygon.push({x:last.x+(last.nx*Math.cos(a)+last.tx*Math.sin(a))*last.width,z:last.z+(last.nz*Math.cos(a)+last.tz*Math.sin(a))*last.width,side:'cap',progress:1});}
 polygon.push(...right.reverse());
 for(let j=1;j<12;j++){const a=j*Math.PI/12;polygon.push({x:first.x+(-first.nx*Math.cos(a)-first.tx*Math.sin(a))*first.width,z:first.z+(-first.nz*Math.cos(a)-first.tz*Math.sin(a))*first.width,side:'cap',progress:0});}
 const walls=polygon.map((p,i)=>{const q=polygon[(i+1)%polygon.length],middle=(p.progress+q.progress)/2;return {a:{x:p.x,z:p.z},b:{x:q.x,z:q.z},solid:!course.openEdges.some(e=>p.side===e.side&&middle>=e.from&&middle<=e.to)};});
 return Object.freeze({...course,version:LEVEL_VERSION,holeRadius:.29,samples,polygon,walls});
}
export const LEVELS=Object.freeze(courses.map(build));
export function getLevel(index){if(!Number.isInteger(index)||!LEVELS[index])throw new RangeError('Invalid golf hole');return LEVELS[index];}
export function insideCourse(level,x,z){let inside=false;const p=level.polygon;for(let i=0,j=p.length-1;i<p.length;j=i++)if((p[i].z>z)!==(p[j].z>z)&&x<(p[j].x-p[i].x)*(z-p[i].z)/(p[j].z-p[i].z)+p[i].x)inside=!inside;return inside;}
export function nearestOnSegment(x,z,a,b){const dx=b.x-a.x,dz=b.z-a.z,l=dx*dx+dz*dz,t=l?Math.max(0,Math.min(1,((x-a.x)*dx+(z-a.z)*dz)/l)):0;return {x:a.x+t*dx,z:a.z+t*dz,t};}
