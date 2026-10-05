/** Tower Link presentation only. All troops, paths and results come from the server. */
import {TOWER_ART,TOWER_MANIFEST,artURL,getTowerImage,atlasCell} from './tower-assets.mjs';
import {createTroopProjection,createBattleEffectGate,roadBattleEffectKey,pointOnRoad} from './troop-presentation.mjs';
import {towerMetrics,towerPoint,layoutTowerPoints} from './tower-layout.mjs';
export {artURL,TOWER_ART};
export const TEAM_COLORS = ['#00b993', '#e33b2e', '#1684ea', '#9146dc'];
export const TEAM_SHAPES = ['◆', '▲', '●', '■'];
export {towerPoint};
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const circle=(ctx,x,y,r)=>{ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);};
function ellipse(ctx,x,y,rx,ry,fill){ctx.beginPath();ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2);ctx.fillStyle=fill;ctx.fill();}
function line(ctx,a,b,color,width){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
function roadControl(a,b,from,to,towers,width,height){if(towers[from]?.ring!=='outer'||towers[to]?.ring!=='outer')return null;const x=(a.x+b.x)/2,y=(a.y+b.y)/2,dx=x-width/2,dy=y-height/2,len=Math.hypot(dx,dy)||1,offset=Math.min(width,height)*.12;return{x:x+dx/len*offset,y:y+dy/len*offset};}
const alongRoad=pointOnRoad;
function roadLine(ctx,a,b,c,color,width){ctx.beginPath();ctx.moveTo(a.x,a.y);if(c)ctx.quadraticCurveTo(c.x,c.y,b.x,b.y);else ctx.lineTo(b.x,b.y);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
function shape(ctx,x,y,size,index,fill){ctx.save();ctx.translate(x,y);ctx.beginPath();if(index===2)ctx.arc(0,0,size*.75,0,Math.PI*2);else if(index===1){ctx.moveTo(0,-size);ctx.lineTo(size*.85,size*.65);ctx.lineTo(-size*.85,size*.65);ctx.closePath();}else if(index===3)ctx.rect(-size*.7,-size*.7,size*1.4,size*1.4);else{ctx.moveTo(0,-size);ctx.lineTo(size*.7,0);ctx.lineTo(0,size);ctx.lineTo(-size*.7,0);ctx.closePath();}ctx.fillStyle=fill;ctx.fill();ctx.strokeStyle='#fff2aa';ctx.lineWidth=1.2;ctx.stroke();ctx.restore();}
function fallbackTower(ctx,x,y,w,color,core=false){
 ctx.save();ctx.translate(x,y);ctx.scale(w/66,w/66);
 ellipse(ctx,0,0,31,10,'#273f2b50');ellipse(ctx,0,-3,29,11,'#d8cba7');
 ctx.fillStyle='#fff5d9';ctx.strokeStyle='#b08b45';ctx.lineWidth=1.4;
 for(const [dx,dy,r] of [[-22,-14,9],[22,-14,9],[0,-18,22]]){ctx.beginPath();ctx.roundRect(dx-r,dy-35,r*2,41,[4,4,5,5]);ctx.fill();ctx.stroke();ellipse(ctx,dx,dy-35,r,5,'#fffbe9');}
 const grd=ctx.createLinearGradient(-22,-68,22,-25);grd.addColorStop(0,'#fafbea');grd.addColorStop(.45,color);grd.addColorStop(1,'#063f47');ctx.fillStyle=grd;ctx.beginPath();ctx.moveTo(-24,-50);ctx.quadraticCurveTo(-22,-65,0,-75);ctx.quadraticCurveTo(22,-65,24,-50);ctx.quadraticCurveTo(0,-37,-24,-50);ctx.fill();ctx.strokeStyle='#e5b946';ctx.stroke();
 ctx.fillStyle='#fff8c7';ctx.fillRect(-1,-83,2,15);ellipse(ctx,0,-70,6,2,'#d8a229');
 for(const dx of [-15,15]){ctx.fillStyle=color;ctx.fillRect(dx-3,-40,6,20);ctx.strokeStyle='#efc75d';ctx.strokeRect(dx-3,-40,6,20);}
 ctx.fillStyle='#143c43';ctx.beginPath();ctx.roundRect(-8,-27,16,21,[7,7,1,1]);ctx.fill();ctx.strokeStyle='#dcb654';ctx.stroke();
 ctx.fillStyle='#fff9e9';ctx.fillRect(-12,-7,24,4);ctx.fillRect(-16,-3,32,3);
 if(core){ctx.strokeStyle='#d9a629';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(-20,-63);ctx.lineTo(-20,-75);ctx.lineTo(-11,-68);ctx.lineTo(0,-81);ctx.lineTo(11,-68);ctx.lineTo(20,-75);ctx.lineTo(20,-63);ctx.stroke();}
 ctx.restore();
}
function animatedSoldier(ctx,image,team,x,y,heading,time,offset,reduced,scale=1){
 const meta=TOWER_MANIFEST.soldiers||{},columns=meta.columns||4,rows=meta.rows||4,frame=reduced?0:Math.floor(time*(meta.frameRate||8)/1000+offset)%rows,sw=image.width/columns,sh=image.height/rows,anchor=meta.anchor||{x:.5,y:.94},size=18*scale;
 ctx.save();ctx.translate(x,y);ellipse(ctx,0,1.5,4.5*scale,2*scale,'#16392750');
 ctx.rotate(Math.sin(heading)*.14);if(Math.cos(heading)<0)ctx.scale(-1,1);
 ctx.drawImage(image,Math.max(0,team)*sw,frame*sh,sw,sh,-size*anchor.x,-size*anchor.y,size,size);ctx.restore();
}
function soldier(ctx,x,y,color,heading,phase,scale=1){
 ctx.save();ctx.translate(x,y);ctx.scale(scale,scale);const step=Math.sin(phase)*1.8;
 ellipse(ctx,0,3,3.8,1.8,'#16392750');ctx.strokeStyle='#142d37';ctx.lineWidth=2.2;ctx.lineCap='round';
 line(ctx,{x:-1.4,y:0},{x:-2.2+step,y:3},'#172c38',1.9);line(ctx,{x:1.4,y:0},{x:2.2-step,y:3},'#172c38',1.9);
 ctx.fillStyle=color;ctx.beginPath();ctx.ellipse(0,-2.5,3.1,4,heading*.12,0,Math.PI*2);ctx.fill();ctx.stroke();
 circle(ctx,0,-7,2.9);ctx.fillStyle='#d8f8e7';ctx.fill();ctx.strokeStyle='#304b49';ctx.lineWidth=1;ctx.stroke();
 ctx.fillStyle=color;ctx.beginPath();ctx.arc(0,-7.8,2.8,Math.PI,Math.PI*2);ctx.fill();line(ctx,{x:3,y:-4},{x:4,y:-9},'#f8d991',1.1);ctx.restore();
}
export function createTowerScene(canvas, read, onAssets){
 const ctx=canvas.getContext('2d',{alpha:true,desynchronized:true});if(!ctx)return()=>{};
 let width=0,height=0,dpr=1,frame=0,disposed=false,staticKey='',background=null,lastDraw=0,layoutKey='',layoutPoints=[];
 const images={}, pendingImages=new Set(), effectCache=new Map(), seenEvents=new Set(), battleEffects=createBattleEffectGate();
 let projection=null,projectionGame=null,roundId=null,lastVisualAt=-Infinity;
 let loaded=0,failed=0;const names=[...new Set(Object.values(TOWER_MANIFEST.files||{}))].filter(name=>TOWER_ART[name]);
 for(const name of names){const cached=getTowerImage(name);if(cached){images[name]=cached;loaded++;continue;}const im=new Image();pendingImages.add(im);const complete=()=>{pendingImages.delete(im);im.onload=null;im.onerror=null;};im.onload=()=>{complete();if(disposed)return;images[name]=im;loaded++;staticKey='';onAssets?.({loaded,failed,total:names.length});};im.onerror=()=>{complete();if(disposed)return;failed++;onAssets?.({loaded,failed,total:names.length});};im.src=TOWER_ART[name];}
 if(!names.length)onAssets?.({loaded:0,failed:0,total:0});
 const img=(...keys)=>keys.map(k=>images[k]).find(Boolean);
 const observer=new ResizeObserver(entries=>{const r=entries[0].contentRect;width=Math.max(1,r.width);height=Math.max(1,r.height);dpr=Math.min(2,window.devicePixelRatio||1);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);staticKey='';});observer.observe(canvas);
 function terrain(g,points,rotation,roomId){
  const key=`${roomId}:${width}:${height}:${g.level?.id}:${g.towers?.length}:${g.training?.lessonId||''}:${loaded}:${rotation}`;
  if(key===staticKey&&background)return;staticKey=key;background=document.createElement('canvas');background.width=canvas.width;background.height=canvas.height;const c=background.getContext('2d');c.scale(dpr,dpr);
  const island=img(TOWER_MANIFEST.files?.terrain,'battlefield.webp','battlefield.png','terrain.webp','terrain.png');
  if(island)c.drawImage(island,0,-height*.05,width,height*1.33);
  else {const grad=c.createLinearGradient(0,0,0,height);grad.addColorStop(0,'#90ac72');grad.addColorStop(.7,'#609548');grad.addColorStop(1,'#afbd8b');c.fillStyle=grad;c.beginPath();c.ellipse(width*.5,height*.54,width*.49,height*.45,0,0,Math.PI*2);c.fill();c.strokeStyle='#e3d8b2';c.lineWidth=9;c.stroke();for(let i=0;i<95;i++){const x=(Math.sin(i*71.13)*.5+.5)*width,y=(Math.cos(i*37.1)*.5+.5)*height;if(Math.pow((x-width/2)/(width*.46),2)+Math.pow((y-height*.54)/(height*.41),2)>1)continue;c.fillStyle=i%3?'#456f32':'#dce3a0';circle(c,x,y,1.5+i%3);c.fill();}}
  if(g.board?.terrain==='river'){
   const left=towerPoint({x:.04,y:.46},width,height,rotation),right=towerPoint({x:.96,y:.46},width,height,rotation);c.lineCap='round';line(c,left,right,'#d5d9ab',27);line(c,left,right,'#407e89',21);line(c,left,right,'#83c6cbbd',13);
  }else if(g.board?.terrain==='broken-road'&&points[0]&&points[8]){
   const a=points[0],b=points[8],middle={x:(a.x+b.x)/2,y:(a.y+b.y)/2};c.strokeStyle='#624f37';c.lineWidth=5;c.beginPath();c.moveTo(middle.x-23,middle.y-7);c.lineTo(middle.x-7,middle.y+3);c.lineTo(middle.x+5,middle.y-5);c.lineTo(middle.x+24,middle.y+7);c.stroke();
  }
  c.lineCap='round';for(const [a,b] of g.edges||[]){if(!points[a]||!points[b])continue;const control=roadControl(points[a],points[b],a,b,g.towers,width,height);roadLine(c,points[a],points[b],control,'#56674670',14);roadLine(c,points[a],points[b],control,'#bfaa75',11);roadLine(c,points[a],points[b],control,'#fff2cf',8);roadLine(c,points[a],points[b],control,'#dbccaa',.8);}
  for(const p of points){ellipse(c,p.x,p.y,12,7,'#cfbd90');ellipse(c,p.x,p.y-1,10,6,'#fcf1cd');ellipse(c,p.x,p.y-1,7,4,'#e8ddbf');}
 }
 function render(ts){
  frame=0;if(disposed||document.hidden)return;frame=requestAnimationFrame(render);const s=read();if(!s||!width||!height)return;
  const fps=s.reduced?30:60;if(ts-lastDraw<1000/fps-2)return;lastDraw=ts;
  const g=s.game,towers=g.towers||[],players=g.players||[],nextLayoutKey=`${s.roomId??g.startedAt}:${width}:${height}:${g.level?.id}:${towers.length}:${s.rotation}`;
  if(nextLayoutKey!==layoutKey){layoutKey=nextLayoutKey;layoutPoints=layoutTowerPoints(towers,width,height,s.rotation);}
  const pts=layoutPoints;
  const currentRound=s.roomId??g.startedAt;
  if(currentRound!==roundId){roundId=currentRound;projectionGame=null;lastVisualAt=-Infinity;effectCache.clear();seenEvents.clear();battleEffects.clear();}
  const currentServer=s.serverTime(), frozen=g.status==='active'?Infinity:(g.finishedAt||g.deadlineAt||s.serverAt),now=Math.min(Math.max(lastVisualAt,g.simulationAt??-Infinity,Math.min(currentServer,s.serverAt+1400)),frozen); // Stop extrapolating during prolonged disconnection.
  lastVisualAt=now;
  if(projectionGame!==g){projectionGame=g;projection=createTroopProjection(g);}
  const presentation=projection.at(now);
  function addBattleEffect(ev){if(!battleEffects.accept(ev,now))return;effectCache.set(roadBattleEffectKey(ev),{...ev,start:ts-Math.max(0,now-ev.at)});s.onRoadBattle?.(ev);}
  const color=owner=>TEAM_COLORS[Math.max(0,players.findIndex(p=>p.key===owner))]||TEAM_COLORS[0];
  terrain(g,pts,s.rotation,currentRound);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);ctx.drawImage(background,0,0,width,height);
  const orders=g.orders||[];ctx.lineCap='round';
  for(const order of orders){const a=pts[order.from],b=pts[order.to];if(!a||!b)continue;const col=color(order.ownerKey),control=roadControl(a,b,order.from,order.to,towers,width,height);roadLine(ctx,a,b,control,order.from===s.selected?'#173c3a90':col+'30',order.from===s.selected?9:7);roadLine(ctx,a,b,control,order.from===s.selected?col:col+'c0',order.from===s.selected?4.5:2.7);const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy),phase=s.reduced?0:(now%1000)/1000;for(let f=.2+phase*.17;f<.86;f+=.18){const point=alongRoad(a,b,control,f),next=alongRoad(a,b,control,Math.min(1,f+.01)),x=point.x,y=point.y,ang=Math.atan2(next.y-y,next.x-x);ctx.save();ctx.translate(x,y);ctx.rotate(ang);ctx.beginPath();ctx.moveTo(-3,-3);ctx.lineTo(1,0);ctx.lineTo(-3,3);ctx.strokeStyle='#faffeb';ctx.lineWidth=1.5;ctx.stroke();ctx.restore();}}
  if(s.selected!=null&&pts[s.selected]&&g.owners?.[s.selected]===s.me){const from=pts[s.selected];for(const to of towers[s.selected]?.neighbors||[]){if(!pts[to])continue;ctx.setLineDash([3,6]);roadLine(ctx,from,pts[to],roadControl(from,pts[to],s.selected,to,towers,width,height),'#fff9ceaa',1.5);ctx.setLineDash([]);ellipse(ctx,pts[to].x,pts[to].y,15,8,'#ffffff35');}if(s.aim){const finger={x:s.aim.x*width,y:s.aim.y*height},pos=s.aim.valid&&pts[s.aim.target]?pts[s.aim.target]:finger,control=s.aim.valid?roadControl(from,pos,s.selected,s.aim.target,towers,width,height):null;roadLine(ctx,from,pos,control,s.aim.remove?'#ffd08c':s.aim.valid?'#fff8b5':'#ff645e',4);ellipse(ctx,pos.x,pos.y,11,8,s.aim.valid?'#edffb077':'#e3393355');}}
  const byDepth=[];
  towers.forEach((tower,i)=>byDepth.push({type:'tower',i,y:pts[i].y}));
  const armies=presentation.armies;for(const army of armies){const a=pts[army.from],b=pts[army.to];if(!a||!b)continue;const fraction=clamp((now-army.departedAt)/Math.max(1,army.arrivesAt-army.departedAt),0,1);if(fraction>=1)continue;const control=roadControl(a,b,army.from,army.to,towers,width,height),point=alongRoad(a,b,control,fraction),next=alongRoad(a,b,control,Math.min(1,fraction+.01));byDepth.push({type:'army',army,x:point.x,y:point.y,heading:Math.atan2(next.y-point.y,next.x-point.x),fraction});}
  for(const ev of presentation.collisions)addBattleEffect(ev);
  byDepth.sort((a,b)=>a.y-b.y);
  const spriteNames=['green','red','blue','purple'],soldiersImage=img(TOWER_MANIFEST.files?.soldiers,'soldiers-atlas.webp');const tw=towerMetrics(width,height).artWidth;
  for(const item of byDepth){
   if(item.type==='tower'){
    const i=item.i,t=towers[i],p=pts[i],owner=g.owners?.[i],team=players.findIndex(v=>v.key===owner),col=owner?color(owner):'#84949d',isCore=t.kind==='citadel'||t.core;
    if(s.selected===i){ellipse(ctx,p.x,p.y,tw*.55,tw*.22,'#13fac75c');ctx.beginPath();ctx.ellipse(p.x,p.y,tw*.55,tw*.22,0,0,Math.PI*2);ctx.strokeStyle='#b4ffe8';ctx.lineWidth=2.5;ctx.stroke();}
    const atlas=img(TOWER_MANIFEST.files?.barracks,'barracks-atlas.webp','barracks-atlas.png');
    const image=isCore?img(TOWER_MANIFEST.files?.citadel,'citadel.png','citadel.webp'):img(`barracks-${owner?spriteNames[team]:'neutral'}.png`,`barracks-${owner?spriteNames[team]:'neutral'}.webp`);
    const extra=isCore?1.45:1;if(!isCore&&atlas){const cell=atlasCell(atlas,owner?team:-1,t.level||1),iw=tw*cell.scale*1.22,ih=iw*cell.height/cell.width;ctx.drawImage(atlas,cell.x,cell.y,cell.width,cell.height,p.x-iw*cell.anchor.x,p.y-ih*cell.anchor.y,iw,ih);}else if(image){const ih=tw*extra*image.height/image.width;ctx.drawImage(image,p.x-tw*extra/2,p.y-ih+8,tw*extra,ih);}else fallbackTower(ctx,p.x,p.y,tw*extra,col,isCore);
    if(owner&&(!atlas||isCore))shape(ctx,p.x,p.y-tw*.65,tw*.1,team,col);
    if(t.upgrade){const progress=clamp((now-t.upgrade.startedAt)/(t.upgrade.completesAt-t.upgrade.startedAt),0,1);ctx.beginPath();ctx.ellipse(p.x,p.y,tw*.49,tw*.21,0,-Math.PI/2,Math.PI*2*progress-Math.PI/2);ctx.strokeStyle='#ffd772';ctx.lineWidth=3;ctx.stroke();if(!s.reduced){for(let k=0;k<4;k++){const f=((now/900+k*.23)%1);circle(ctx,p.x+Math.sin(k*5+now/1000)*tw*.32,p.y-tw*.6*f,1.2);ctx.fillStyle='#fff1b0';ctx.fill();}}}
    if(!s.reduced){const wave=Math.sin(ts/650+i);ctx.save();ctx.translate(p.x+tw*.25,p.y-tw*.56);ctx.fillStyle=col;ctx.beginPath();ctx.moveTo(0,0);ctx.quadraticCurveTo(5,-2+wave,10,wave);ctx.lineTo(9,8+wave);ctx.quadraticCurveTo(4,6,0,7);ctx.fill();ctx.strokeStyle='#edcb68';ctx.lineWidth=.6;ctx.stroke();ctx.restore();}
   } else {
    const {army,x,y,heading}=item,col=color(army.ownerKey),glyphs=armies.length>80?1:Math.min(army.count,2);for(let j=0;j<glyphs;j++){const trail=j*8,sx=x-Math.cos(heading)*trail,sy=y-Math.sin(heading)*trail;if(soldiersImage)animatedSoldier(ctx,soldiersImage,players.findIndex(p=>p.key===army.ownerKey),sx,sy,heading,now,j,s.reduced,clamp(width/390,.9,1.2));else soldier(ctx,sx,sy,col,heading,s.reduced?0:now/70+j,clamp(width/390,.82,1.15));}if(army.count>glyphs){ctx.font='bold 9px system-ui';ctx.textAlign='center';ctx.lineWidth=3;ctx.strokeStyle='#14342b';ctx.strokeText(`×${army.count}`,x,y-23);ctx.fillStyle='#fffbe8';ctx.fillText(`×${army.count}`,x,y-23);}
   }
  }
  for(const ev of g.recentEvents||[g.lastEvent].filter(Boolean)){
   if(!ev.id||seenEvents.has(ev.id)||ev.at>now)continue;seenEvents.add(ev.id);if(seenEvents.size>400){const first=seenEvents.values().next().value;seenEvents.delete(first);}if(currentServer-(ev.at||0)>1800)continue;
   if(ev.type==='road-battle')addBattleEffect(ev);
   else if(['capture','arrival','upgrade-complete'].includes(ev.type))effectCache.set(ev.id,{...ev,start:ts-Math.max(0,now-ev.at)});
  }
  for(const [id,ev]of effectCache){const age=ts-ev.start;if(age>1000){effectCache.delete(id);continue;}const towerId=ev.towerId??ev.tower??ev.to;let p=pts[towerId];if(!p&&ev.edge){const a=pts[ev.edge[0]],b=pts[ev.edge[1]],fraction=ev.position??.5;if(a&&b)p=alongRoad(a,b,roadControl(a,b,ev.edge[0],ev.edge[1],towers,width,height),fraction);}if(!p&&ev.from!=null&&ev.to!=null){const a=pts[ev.from],b=pts[ev.to];if(a&&b)p={x:(a.x+b.x)/2,y:(a.y+b.y)/2};}if(!p)continue;const strength=1-age/1000;if(ev.type==='arrival'&&!ev.battle&&!ev.casualties)continue;ctx.save();ctx.globalAlpha=strength;const gold=ev.type==='capture'||ev.type==='upgrade-complete';ctx.strokeStyle=gold?'#ffe8a2':'#fff4b7';ctx.lineWidth=2;circle(ctx,p.x,p.y-14,8+age*.035);ctx.stroke();if(!s.reduced)for(let j=0;j<7;j++){const angle=j*Math.PI*2/7;circle(ctx,p.x+Math.cos(angle)*age*.03,p.y-14+Math.sin(angle)*age*.02,1.8*strength);ctx.fillStyle=gold?'#ffe295':'#fffad6';ctx.fill();}ctx.restore();}
 }
 function visibility(){if(disposed)return;cancelAnimationFrame(frame);frame=0;if(!document.hidden){lastDraw=0;frame=requestAnimationFrame(render);}}
 document.addEventListener('visibilitychange',visibility);visibility();
 return()=>{disposed=true;cancelAnimationFrame(frame);frame=0;document.removeEventListener('visibilitychange',visibility);observer.disconnect();for(const im of pendingImages){im.onload=null;im.onerror=null;im.src='';}pendingImages.clear();effectCache.clear();seenEvents.clear();battleEffects.clear();background=null;};
}
