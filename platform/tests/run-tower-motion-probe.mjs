/** Diagnostic only. Install before navigation; never combine with FRAME timing. */
export function installRunTowerMotionProbe({maxFrames=12000,maxSnapshots=2400}={}) {
 if(window.__actualMotion)return;
 const d=window.__actualMotion={schema:'actual-draw-motion-v1',timeOrigin:performance.timeOrigin,run:[],tower:[],snapshots:[],errors:[],dropped:0,active:false};
 const stamp=()=>({at:performance.now(),visibility:document.visibilityState,online:navigator.onLine});
 let latest=null,sequence=0;
 const recordRoom=body=>{
  const r=body?.room||body;if(!r?.id||!['run','towerlink'].includes(r.game_id)||!r.game)return;
  if(latest?.room.id===r.id&&Number(r.version)<Number(latest.room.version))return;
  const g=r.game;
  const room={id:r.id,version:r.version,status:r.status,game_id:r.game_id,me:r.me,server_now:r.server_now,game:{status:g.status,ruleVersion:g.ruleVersion,physicsVersion:g.physicsVersion,phase:g.phase,startedAt:g.startedAt,finishedAt:g.finishedAt,deadlineAt:g.deadlineAt,serverNow:g.serverNow,simulationAt:g.simulationAt,snapshotTick:g.snapshotTick,board:g.board,players:g.players,towers:g.towers,armies:g.armies,events:g.events}};
  const item={index:sequence++,...stamp(),room:JSON.parse(JSON.stringify(room))};latest=item;
  if(d.snapshots.length<maxSnapshots)d.snapshots.push(item);else d.dropped++;
 };
 // Observe the same decoded response the application consumes. No second fetch,
 // no response replacement and no authority mutations. Timing is diagnostic.
 const json=Response.prototype.json;
 Response.prototype.json=async function(...args){const value=await json.apply(this,args);try{if(/\/api\/pvp\/rooms(?:\/|$)/.test(new URL(this.url,location.href).pathname))recordRoom(value);}catch(e){d.errors.push(String(e));}return value;};
 const add=(list,row)=>{if(list.length<maxFrames)list.push(row);else d.dropped++;};
 const matrix=data=>data&&Array.from(data).every(Number.isFinite)&&data.length===16;
 const contexts=new WeakMap(),locations=new WeakMap(),programs=new WeakMap();let nextProgram=0;
 const contextState=gl=>{let s=contexts.get(gl);if(!s){s={program:null,framebuffer:null,frame:0,clearAt:-1,row:null};contexts.set(gl,s);}return s;};
 const programState=p=>{if(!p)return null;let s=programs.get(p);if(!s){s={id:++nextProgram};programs.set(p,s);}return s;};
 const hooked=new Set();
 const wrap=(prototype,name,after)=>{if(!prototype||typeof prototype[name]!=='function')return;const original=prototype[name];if(hooked.has(original))return;const fn=function(...args){const result=original.apply(this,args);try{after.call(this,args,result);}catch(e){if(d.errors.length<20)d.errors.push(name+': '+e.message);}return result;};hooked.add(fn);prototype[name]=fn;};
 for(const proto of [globalThis.WebGLRenderingContext?.prototype,globalThis.WebGL2RenderingContext?.prototype]){
  wrap(proto,'getUniformLocation',function(args,result){if(result)locations.set(result,{program:args[0],name:args[1]});});
  wrap(proto,'useProgram',function([p]){contextState(this).program=p;});
  wrap(proto,'bindFramebuffer',function([target,value]){if(target===this.FRAMEBUFFER||target===this.DRAW_FRAMEBUFFER)contextState(this).framebuffer=value;});
  wrap(proto,'uniformMatrix4fv',function([location,transpose,value,offset=0]){
   const info=locations.get(location);if(!info||!['viewMatrix','projectionMatrix','modelViewMatrix'].includes(info.name))return;
   const values=Array.from(value||[]).slice(offset,offset+16);if(!matrix(values)||transpose)return;
   programState(info.program)[info.name]={values,at:performance.now()};
  });
  wrap(proto,'clear',function([bits]){const s=contextState(this);if(s.framebuffer===null&&(bits&this.COLOR_BUFFER_BIT)){s.frame++;s.clearAt=performance.now();s.row=null;}});
  for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced'])wrap(proto,name,function(){
   if(!d.active||!this.canvas?.matches?.('[data-testid="run-track"] canvas'))return;
   const s=contextState(this),p=programState(s.program),view=p?.viewMatrix,projection=p?.projectionMatrix;
   // Shadow/cubemap render targets, orthographic passes and unknown model
   // transforms cannot certify camera movement. Retain unchanged uniforms:
   // Three legitimately skips their upload, and frozen draws must stay visible.
   if(s.framebuffer!==null||!view||!projection||Math.abs(projection.values[11]+1)>1e-5||Math.abs(projection.values[15])>1e-5)return;
   const track=this.canvas.closest('[data-testid="run-track"]'),m=view.values;
   const camera=[-(m[0]*m[12]+m[1]*m[13]+m[2]*m[14]),-(m[4]*m[12]+m[5]*m[13]+m[6]*m[14]),-(m[8]*m[12]+m[9]*m[13]+m[10]*m[14])];
   if(!s.row){s.row={...stamp(),frame:s.frame,snapshot:latest?.index,sceneTick:Number(track.dataset.tick),cinematic:track.dataset.cinematic,program:p.id,viewMatrix:m,viewUploadedAt:view.at,projectionMatrix:projection.values,modelViewMatrix:p.modelViewMatrix?.values||null,camera,draws:1,conflictingCamera:false};add(d.run,s.row);}
   else{s.row.draws++;if(camera.some((v,i)=>Math.abs(v-s.row.camera[i])>.002))s.row.conflictingCamera=true;}
  });
 }
 const frames=new WeakMap(),proto=globalThis.CanvasRenderingContext2D?.prototype;
 const transform=proto?.getTransform;
 wrap(proto,'clearRect',function(){
  if(!d.active||!this.canvas.matches?.('.tl-world-canvas'))return;
  const row={...stamp(),snapshot:latest?.index,width:this.canvas.clientWidth,height:this.canvas.clientHeight,canvasWidth:this.canvas.width,canvasHeight:this.canvas.height,nodes:[...this.canvas.parentElement.querySelectorAll('[data-tower]')].map(e=>({id:Number(e.dataset.tower),x:parseFloat(e.style.left),y:parseFloat(e.style.top)})),soldiers:[]};frames.set(this,row);add(d.tower,row);
 });
 wrap(proto,'drawImage',function(args){
  if(!d.active||!this.canvas.matches?.('.tl-world-canvas')||args.length!==9)return;
  const [image,sx,sy,sw,sh,dx,dy,dw,dh]=args,src=image.currentSrc||image.src||'';
  if(!/\/soldiers-atlas(?:-[A-Za-z0-9_-]+)?\.webp(?:\?|$)/.test(src))return;
  const row=frames.get(this);if(!row)return;
  const m=transform.call(this),scale=Math.hypot(m.a,m.b);
  if(!scale||row.soldiers.length>=256){d.dropped++;return;}
  row.soldiers.push({source:new URL(src,location.href).pathname,team:sx/sw,atlasRow:sy/sh,x:m.e/scale,y:m.f/scale,matrix:[m.a,m.b,m.c,m.d,m.e,m.f],sourceRect:[sx,sy,sw,sh],destinationRect:[dx,dy,dw,dh]});
 });
 d.begin=()=>{d.active=true;};d.end=()=>{d.active=false;};
 d.read=()=>({schema:d.schema,timeOrigin:d.timeOrigin,run:d.run,tower:d.tower,snapshots:d.snapshots,errors:d.errors,dropped:d.dropped});
}
