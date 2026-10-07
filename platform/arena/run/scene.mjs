import * as T from 'three';
import {createRunner} from './characters.mjs';
import {loadOasisKit,loadStoneTextures,loadOasisBackdrop} from './environment.mjs';
import {projectedPose,createRunSnapshotClock} from './presentation.mjs';
import {batchRunScenery,RUN_SCENERY_CHUNK_METRES} from './static-batches.mjs';
export {projectedPose} from './presentation.mjs';
import {RoundedBoxGeometry} from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {LANES} from './level.mjs';
import {createRunSceneResources} from './scene-resources.mjs';
import {resolveRunCourse} from './courses.mjs';
const mix=(a,b,t)=>a+(b-a)*t,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export function createRunScene(container,{onError=()=>{},onEvent=()=>{},onReady=()=>{},onFrame=()=>{},course=resolveRunCourse(null)}={}){
 const assetController=new AbortController(),cleanups=[],cleanupErrors=[];let renderer,disposed=false,raf=0;
 const defer=fn=>{let pending=true;const run=()=>{if(pending){pending=false;fn();}};cleanups.push(run);return run;};
 function dispose(){if(disposed)return;disposed=true;assetController.abort();cancelAnimationFrame(raf);for(const cleanup of cleanups.reverse())try{cleanup();}catch(error){cleanupErrors.push(error);}cleanups.length=0;}
 function fail(error){if(disposed)return;dispose();onError(error);}
 const geometries=[],materials=[],groups=[],runners=new Map(),items=[],particles=[],decorations=[];
 defer(()=>{try{renderer?.dispose();}finally{try{renderer?.forceContextLoss();}finally{renderer?.domElement.remove();}}});
 defer(()=>geometries.forEach(g=>g.dispose()));defer(()=>materials.forEach(m=>m.dispose()));defer(()=>runners.forEach(r=>r.dispose()));
 try{
 const {obstacles:OBSTACLES,gaps:GAPS,items:ITEMS,trackLength:TRACK_LENGTH}=course;container.dataset.courseId=course.id;
 for(const key of ['rendered','modelsReady','backgroundReady','environmentReady','ready'])delete container.dataset[key];
 const mobileQuality=window.matchMedia?.('(pointer: coarse)').matches||Math.min(window.innerWidth,window.innerHeight)<=600;
 renderer=new T.WebGLRenderer({antialias:!mobileQuality,alpha:false,powerPreference:'high-performance'});
 renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,mobileQuality?1.2:1.5));renderer.shadowMap.enabled=!mobileQuality;renderer.shadowMap.type=T.PCFSoftShadowMap;renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=.87;renderer.domElement.setAttribute('aria-label','Three-dimensional desert oasis race');container.dataset.renderQuality=mobileQuality?'mobile':'desktop';container.appendChild(renderer.domElement);
 const scene=new T.Scene();defer(()=>{scene.traverse(o=>{if(o.isInstancedMesh)o.dispose();});scene.clear();});scene.background=new T.Color(0xbad7de);scene.fog=new T.FogExp2(0xd4dfd3,.009);const camera=new T.PerspectiveCamera(49,1,.1,220);camera.position.set(.5,4.2,7.8);
 const pmrem=new T.PMREMGenerator(renderer),releasePMREM=defer(()=>pmrem.dispose());const roomEnvironment=new RoomEnvironment(),releaseRoom=defer(()=>roomEnvironment.dispose());const environment=pmrem.fromScene(roomEnvironment,.06);defer(()=>environment.dispose());scene.environment=environment.texture;scene.environmentIntensity=mobileQuality?.18:.24;releasePMREM();releaseRoom();
 scene.add(new T.HemisphereLight(0xffedc3,0x315773,.48));const sun=new T.DirectionalLight(0xffddb0,3.1);sun.position.set(-8,15,10);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-12,right:12,top:15,bottom:-12,near:1,far:55});sun.shadow.bias=-.001;sun.shadow.normalBias=.018;scene.add(sun,sun.target);
 let backdrop=null;defer(()=>backdrop?.dispose());loadOasisBackdrop({signal:assetController.signal}).then(source=>{if(disposed)return;backdrop=source.clone();backdrop.needsUpdate=true;scene.background=backdrop;container.dataset.backgroundReady='true';}).catch(fail);
 const resources=createRunSceneResources();defer(()=>resources.dispose());
 const geom=g=>(geometries.push(g),g),mat=(color,roughness=.75,metalness=0)=>{const m=new T.MeshStandardMaterial({color,roughness,metalness});materials.push(m);return m;};
 const box=geom(new T.BoxGeometry(1,1,1)),sphere=geom(new T.SphereGeometry(1,16,12)),cylinder=geom(new T.CylinderGeometry(1,1,1,12)),cone=geom(new T.ConeGeometry(1,1,7)),torus=geom(new T.TorusGeometry(1,.035,6,36));
 const gapStone=mat(0xd3bb90,.9),gapRecess=mat(0x6e634d,.95);
 const sand=mat(0xf4f1e8),edge=mat(0xf4d699),gold=mat(0xdcb65e,.34,.55),wood=mat(0x915c38),brick=mat(0xc28852),leaf=mat(0x316e48),darkLeaf=mat(0x225c40),trunk=mat(0xa2764a),turquoise=mat(0x139a9a,.28,.3),stone=mat(0xf4d8aa),red=mat(0xb84637),cream=mat(0xffebc3),blue=mat(0x29b1b8,.25,.25);
 const stoneCanvas=document.createElement('canvas');stoneCanvas.width=stoneCanvas.height=512;const ctx=stoneCanvas.getContext('2d');ctx.fillStyle='#c8b388';ctx.fillRect(0,0,512,512);for(let i=0;i<6800;i++){const x=(i*47)%512,y=(i*79)%512;ctx.fillStyle=i%2?'#8e724229':'#fff6d12a';ctx.fillRect(x,y,1+i%4,1);}for(let row=0;row<8;row++){const y=row*64;ctx.fillStyle='#715d405a';ctx.fillRect(0,y,512,2);ctx.fillStyle='#ead4a871';ctx.fillRect(0,y+2,512,2);for(let x=(row%2)*64;x<512;x+=128){ctx.fillStyle='#715d4055';ctx.fillRect(x,y,2,64);}}const stoneTexture=new T.CanvasTexture(stoneCanvas);defer(()=>stoneTexture.dispose());stoneTexture.colorSpace=T.SRGBColorSpace;stoneTexture.wrapS=stoneTexture.wrapT=T.RepeatWrapping;stoneTexture.anisotropy=4;sand.map=stoneTexture;stone.map=stoneTexture;stone.bumpMap=stoneTexture;stone.bumpScale=.055;sand.bumpMap=stoneTexture;sand.bumpScale=.035;loadStoneTextures({signal:assetController.signal}).then(({albedo,normal})=>{if(disposed)return;albedo=resources.texture(albedo);normal=resources.texture(normal);for(const m of[sand,stone,gapStone]){m.map=albedo;m.bumpMap=null;m.normalMap=normal;m.normalScale=new T.Vector2(.20,.20);m.color.set(m===gapStone?0xb8ab92:0xe2d4bc);m.roughness=.88;m.needsUpdate=true;}}).catch(fail);
 function mesh(g,m,x,y,z,sx=1,sy=1,sz=1,parent=scene){const a=new T.Mesh(g,m);a.position.set(x,y,z);a.scale.set(sx,sy,sz);a.castShadow=true;a.receiveShadow=true;parent.add(a);return a;}
 // Actual missing bridge slabs expose water; visual and authoritative gaps use one data source.
 const tileData=[];for(let z=-12;z<TRACK_LENGTH+14;z+=1.5)for(let lane=0;lane<3;lane++){const pieces=[{a:z,b:z+1.5}];for(const gap of GAPS.filter(g=>g.lanes.includes(lane))){for(let i=pieces.length-1;i>=0;i--){const p=pieces[i];if(gap.start<p.b&&gap.end>p.a){pieces.splice(i,1);if(p.a<gap.start)pieces.push({a:p.a,b:gap.start});if(p.b>gap.end)pieces.push({a:gap.end,b:p.b});}}}for(const p of pieces)if(p.b-p.a>.01)tileData.push({lane,...p});}
 const dummy=new T.Object3D(),slabChunks=new Map();
 for(const [index,tile] of tileData.entries()){tile.shadeIndex=index;const cell=Math.floor(tile.a/RUN_SCENERY_CHUNK_METRES);if(!slabChunks.has(cell))slabChunks.set(cell,[]);slabChunks.get(cell).push(tile);}
 for(const [cell,tiles] of slabChunks){const group=new T.Group();group.userData.z=(cell+.5)*RUN_SCENERY_CHUNK_METRES;group.userData.span=RUN_SCENERY_CHUNK_METRES/2;const slabs=new T.InstancedMesh(box,sand,tiles.length),slabEdges=new T.InstancedMesh(box,edge,tiles.length);slabs.receiveShadow=true;slabs.castShadow=true;
  tiles.forEach((p,i)=>{dummy.position.set(LANES[p.lane],-.21,-(p.a+p.b)/2);dummy.scale.set(1.485,.42,p.b-p.a-.018);dummy.updateMatrix();slabs.setMatrixAt(i,dummy.matrix);slabs.setColorAt(i,new T.Color().setHSL(.105,.06,.88+(p.shadeIndex%5)*.015));dummy.position.y=.007;dummy.scale.set(1.35,.016,Math.min(.024,p.b-p.a));dummy.position.z=-p.a-.02;dummy.updateMatrix();slabEdges.setMatrixAt(i,dummy.matrix);});
  slabs.computeBoundingSphere();slabEdges.computeBoundingSphere();group.add(slabs,slabEdges);scene.add(group);groups.push(group);
 }

 // The playable opening stays exactly GAPS. Masonry grows downward and into the
 // existing solid deck, never into a missing lane at the walkable y=0 plane.
 const fractureBlock=geom(new RoundedBoxGeometry(1,1,1,1,.055));
 for(const gap of GAPS){
  const group=new T.Group();group.userData.z=(gap.start+gap.end)/2;group.name=`gap-depth-${gap.id}`;scene.add(group);groups.push(group);const blocks=[];
  const clusters=[];for(const lane of gap.lanes){const last=clusters.at(-1);if(last&&lane===last.at(-1)+1)last.push(lane);else clusters.push([lane]);}
  for(const lanes of clusters){
   const left=LANES[lanes[0]]-.7425,right=LANES[lanes.at(-1)]+.7425,width=right-left,columns=lanes.length*3;
   for(const[end,direction]of[[gap.start,1],[gap.end,-1]]){
    const faceZ=-end+direction*.16;
    mesh(box,gapRecess,(left+right)/2,-.425,faceZ+direction*.15,width,.79,.24,group);
    for(let row=0;row<3;row++)for(let col=0;col<columns;col++){
     const w=width/columns-.018,x=left+(col+.5)*width/columns,jitter=((col*13+row*7+Math.round(end))%5-2)*.009;
     blocks.push({x,y:-.035-(row+.5)*.255,z:faceZ+direction*jitter,sx:w,sy:.239,sz:.28,shade:((col+row*3)%5)*.025});
    }
   }
   // Partial-lane water cuts expose the side face of the surviving adjacent lane.
   for(const[x,lane]of[[left-.15,lanes[0]-1],[right+.15,lanes.at(-1)+1]])if(lane>=0&&lane<3&&!gap.lanes.includes(lane)){
    mesh(box,gapRecess,x,-.425,-(gap.start+gap.end)/2,.26,.79,gap.end-gap.start,group);
    for(let row=0;row<3;row++)for(let col=0;col<6;col++)blocks.push({x,y:-.035-(row+.5)*.255,z:-gap.start-(col+.5)*(gap.end-gap.start)/6,sx:.28,sy:.239,sz:(gap.end-gap.start)/6-.018,shade:(row+col)%4*.025});
   }
  }
  const masonry=new T.InstancedMesh(fractureBlock,gapStone,blocks.length);masonry.name='Recessed sandstone end faces';masonry.castShadow=true;masonry.receiveShadow=false;
  blocks.forEach((b,i)=>{dummy.position.set(b.x,b.y,b.z);dummy.scale.set(b.sx,b.sy,b.sz);dummy.rotation.set(0,0,0);dummy.updateMatrix();masonry.setMatrixAt(i,dummy.matrix);masonry.setColorAt(i,new T.Color().setRGB(1-b.shade,.97-b.shade,.89-b.shade));});group.add(masonry);
  group.userData.masonryBlocks=blocks.length;
 }
 const cosmeticPlacements=[];
 for(let z=0;z<TRACK_LENGTH;z+=6){if(GAPS.some(g=>g.start<z+3.1&&g.end>z-3.1))continue;cosmeticPlacements.push({name:'BridgeSupport',x:0,y:0,z,size:1});}
 for(let i=0;i<=TRACK_LENGTH;i+=30){const g=new T.Group();g.userData.z=i;scene.add(g);for(const side of[-1,1]){mesh(cylinder,gold,side*2.35,.52,-i,.08,1.08,.08,g);mesh(sphere,turquoise,side*2.35,1.08,-i,.13,.13,.13,g);}mesh(box,gold,0,.015,-i,4.4,.018,.055,g);groups.push(g);}
 for(const o of OBSTACLES){const g=new T.Group();g.userData.z=o.z;scene.add(g);if(o.type==='crate'){mesh(box,brick,o.x,.3,-o.z,o.width,.6,o.depth,g);for(const side of[-1,1]){mesh(box,gold,o.x+side*.4,.3,-o.z,.055,.65,.7,g);}mesh(box,wood,o.x,.3,-o.z-.34,1.12,.055,.025,g);mesh(box,gold,o.x,.62,-o.z,1.13,.045,.67,g);}else{for(const side of[-1,1])mesh(cylinder,wood,o.x+side*.54,.61,-o.z,.035,1.22,.035,g);mesh(box,red,o.x,1.1,-o.z,1.12,.6,.65,g);for(let n=-2;n<=2;n++)mesh(box,gold,o.x+n*.21,1.1,-o.z+.33,.1,.58,.028,g);}groups.push(g);}
 const waterMaterial=new T.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{time:{value:0}},vertexShader:'varying vec3 pos; void main(){pos=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:'uniform float time;varying vec3 pos;void main(){float wave=sin(pos.x*3.+time*.9+sin(pos.y*.6))*sin(pos.y*2.2-time*.7);float streak=pow(max(0.,sin(pos.x*12.+pos.y*4.+time)),18.);vec3 col=mix(vec3(.025,.36,.38),vec3(.08,.65,.64),wave*.3+.6)+streak*.065;gl_FragColor=vec4(col,.15);}',side:T.DoubleSide});materials.push(waterMaterial);const water=mesh(geom(new T.PlaneGeometry(70,550)),waterMaterial,0,-2.4,-240);water.rotation.x=-Math.PI/2;water.receiveShadow=false;water.castShadow=false;
 for(let z=4;z<510;z+=18)for(const side of[-1,1]){
  if(z%54===4)cosmeticPlacements.push({name:'RockBank',x:side*8.0,y:-.55,z,size:.92,rotation:side*.3});
  if(z%54===4)cosmeticPlacements.push({name:'Palm',x:side*6.8,y:-.25,z,size:.92,rotation:z*.2});
  if(z%162===4)cosmeticPlacements.push({name:'Palace',x:side*19,y:-1.1,z:z+15,size:1.0,rotation:side*.2});
 }
 // Cascades are actual moving water surfaces, positioned outside every collision lane.
 const fallMat=new T.ShaderMaterial({transparent:true,side:T.DoubleSide,uniforms:{time:{value:0}},vertexShader:'varying vec2 v;void main(){v=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:'varying vec2 v;uniform float time;void main(){float s=pow(.5+.5*sin(v.x*110.+sin(v.y*22.+time*7.)),5.);float a=.10+s*.07;gl_FragColor=vec4(mix(vec3(.22,.68,.67),vec3(.90,.99,.95),s),a*sin(v.x*3.14159));}'});materials.push(fallMat);
 for(let z=20;z<510;z+=54)for(const side of[-1,1]){const f=mesh(geom(new T.PlaneGeometry(1.6,2.5)),fallMat,side*3.4,-1.2,-z);f.rotation.y=side*Math.PI/2;f.castShadow=false;decorations.push({root:f,z});}
 for(const item of ITEMS){const g=new T.Group();g.position.set(0,1.18,-item.z);scene.add(g);const m=item.type==='shield'?blue:gold;const ring=mesh(torus,m,0,0,0,.53,.53,.53,g);g.add(ring);mesh(geom(new T.OctahedronGeometry(.33,0)),m,0,0,0,1,1,1,g);items.push({root:g,...item});}
 cosmeticPlacements.push({name:'FinishGate',x:0,y:0,z:479,size:1});
 const finishRibbon=mesh(box,turquoise,0,.9,-479.9,4.45,.16,.018);finishRibbon.castShadow=false;
 loadOasisKit({signal:assetController.signal}).then(kit=>{if(disposed)return;for(const batch of batchRunScenery(kit,cosmeticPlacements,resources)){scene.add(batch.root);decorations.push(batch);}container.dataset.environmentReady='true';container.dataset.environmentSource='Blender GLB';}).catch(fail);
 const particleGeo=geom(new T.IcosahedronGeometry(.035,0));for(let i=0;i<44;i++){const m=new T.MeshBasicMaterial({color:i%2?0xffdc76:0x8dfff0,transparent:true});materials.push(m);const p=mesh(particleGeo,m,0,0,0);p.visible=false;p.castShadow=false;particles.push({mesh:p,life:0,v:new T.Vector3()});}
 const snapshotClock=createRunSnapshotClock();
 // A new atlas UV array means a real sheet/frame switch. Publish that mutation
 // even when two sheets happen to use the same numeric offset for QA observers.
 let game=null,me=null,received=performance.now(),lastEvent=0,last=performance.now(),cameraDistance=null,shake=0,feedbackAt=0,finishSeenAt=null,readyAnnounced=false,warming=false,warmed=false,lastAtlasUv=null;
 const diagnosticValues=new Map();
 function publishDiagnostic(key,value){
  if(diagnosticValues.has(key)&&diagnosticValues.get(key)===value)return;
  diagnosticValues.set(key,value);
  container.dataset[key]=String(value);
 }
 function burst(p,kind){const location=projectedPose(p,game,0);for(let i=0;i<particles.length;i++){const part=particles[i];if(part.life>0)continue;part.life=.55+(i%5)*.06;part.mesh.position.set(location.x,.7,-location.distance);part.mesh.visible=true;const a=i*2.399;part.v.set(Math.cos(a)*2,1+(i%4)*.6,Math.sin(a)*2);if(i>22)break;}if(kind==='hit'||kind==='fall')shake=.2;}
 function update(g,key){if(!g||disposed)return;const at=performance.now();if(!snapshotClock.receive(g,at))return;game=g;me=key;received=at-snapshotClock.elapsed(at);for(const p of g.players){if(!runners.has(p.key)){const runner=createRunner(p.character,p.key!==me,{onError:fail});scene.add(runner.root);runners.set(p.key,runner);}}for(const e of g.events||[]){if(e.id<=lastEvent)continue;lastEvent=Math.max(lastEvent,e.id);const p=g.players.find(v=>v.key===e.playerKey);if(p&&e.playerKey===me&&g.snapshotTick-e.tick<90){if(['hit','fall','shield_hit','item_used','item_pickup','finish'].includes(e.type))burst(p,e.type);onEvent(e.type,e);}}}
 function render(time){if(disposed||document.hidden)return;try{raf=requestAnimationFrame(render);const dt=Math.min(.04,(time-last)/1000);last=time;waterMaterial.uniforms.time.value=time*.001;fallMat.uniforms.time.value=time*.001;const mine=game?.players.find(p=>p.key===me);if(mine){const elapsed=time-received,pose=projectedPose(mine,game,elapsed);cameraDistance=pose.distance;const distance=cameraDistance;if(backdrop){const rx=Math.min(1,camera.aspect/(1024/1536)),ry=Math.min(1,(1024/1536)/camera.aspect);backdrop.repeat.set(rx,ry);backdrop.offset.set((1-rx)/2+pose.x*.006,(1-ry)/2+Math.sin(distance*.005)*.006);}for(const p of game.players){const r=runners.get(p.key),v=projectedPose(p,game,elapsed);r.root.visible=!p.forfeited&&Math.abs(v.distance-distance)<110&&(p.key===me||Math.abs(v.distance-pose.distance)>.65||Math.abs(v.x-pose.x)>.65);r.root.position.set(v.x,v.y,-v.distance);r.root.scale.setScalar(v.scale);r.root.rotation.z=p.fallUntilTick!==null?(v.tick-p.fallStartTick)*.06:0;r.animate({...p,visualDistance:v.distance,visualHeight:v.y,visualWinner:game.ranks?.find(v=>v.playerKey===p.key)?.rank===1},v.tick,time*.001);}
  for(const g of groups)g.visible=g.userData.z+(g.userData.span||0)>distance-(mine.finishTick!==null?110:10)&&g.userData.z-(g.userData.span||0)<distance+95;for(const d of decorations){const nearDecor=['Palm','RockBank'].includes(d.prefab);d.root.visible=d.prefab!=='Palace'&&d.z+(d.span||0)>distance-(nearDecor?8:mine.finishTick!==null?120:25)&&d.z-(d.span||0)<distance+(nearDecor?11:140);}for(const item of items){item.root.visible=!mine.claimedItems.includes(item.id)&&item.z>distance-3&&item.z<distance+100;item.root.rotation.y=time*.0017;item.root.position.y=1.2+Math.sin(time*.003)*.1;}
  const boost=pose.tick<mine.boostUntilTick;if(mine.finishTick!==null){if(finishSeenAt===null)finishSeenAt=time-Math.max(0,(pose.tick-mine.finishTick)*1000/60);const ft=clamp((time-finishSeenAt)/1200,0,1),ease=ft*ft*(3-2*ft);camera.position.set(Math.sin(ease*Math.PI)*5.5+mix(.12+pose.x*.2,pose.x,ease),mix(3.75,1.8,ease),-distance+Math.cos(ease*Math.PI)*mix(8.8,6.2,ease));camera.lookAt(mix(pose.x*.18,pose.x,ease),mix(.75,1,ease),-distance+mix(-10,0,ease));finishRibbon.scale.x=Math.max(.01,4.45*(1-ease));finishRibbon.rotation.z=ease*.2;publishDiagnostic('cinematic','finish-front');publishDiagnostic('finishElapsed',Math.round(time-finishSeenAt));}else{camera.position.set(.12+pose.x*.2+Math.sin(time*.05)*shake,3.75+(boost?.13:0),-distance+8.8);camera.lookAt(pose.x*.18,.75,-distance-10.0);publishDiagnostic('cinematic','race');}const nextFov=mix(camera.fov,boost?54:49,dt*5);if(nextFov!==camera.fov){camera.fov=nextFov;camera.updateProjectionMatrix();}sun.position.set(-8,15,-distance+8);sun.target.position.set(0,0,-distance-7);shake=Math.max(0,shake-dt);publishDiagnostic('tick',game.snapshotTick);publishDiagnostic('characters',runners.size);publishDiagnostic('modelsReady',[...runners.values()].filter(r=>r.root.userData.loaded).length);publishDiagnostic('modelSource','Illustrated atlas on authoritative 3D trajectory');const runnerState=runners.get(me)?.root.userData;publishDiagnostic('clip',runnerState?.clip||'loading');publishDiagnostic('atlasFrame',runnerState?.frame??-1);publishDiagnostic('atlasSheet',runnerState?.sheet||'');if(runnerState?.uv!==lastAtlasUv){lastAtlasUv=runnerState?.uv;container.dataset.atlasUv=JSON.stringify(lastAtlasUv||[]);}}
 for(const p of particles){if(p.life<=0)continue;p.life-=dt;p.mesh.visible=p.life>0;p.mesh.position.addScaledVector(p.v,dt);p.v.y-=dt*5;p.mesh.material.opacity=Math.max(0,p.life);}
 // Compile every material variant, including the first recessed gap and shield,
 // before allowing input. Rendering fallback materials while textures arrive
 // forced several synchronous recompiles, then another at the first water gap.
 if(!warmed){
  const assetsReady=mine&&container.dataset.backgroundReady==='true'&&container.dataset.environmentReady==='true'&&game.players.length>0&&[...runners.values()].every(r=>r.root.userData.loaded);
  if(assetsReady&&!warming){
   warming=true;
   // Keep compilation inside this guarded loading phase. compileAsync starts
   // with a synchronous compile and retains polling callbacks that can outlive
   // renderer disposal. compile has neither unhandled throws nor pending polls.
   try{renderer.compile(scene,camera);warmed=true;}catch(error){fail(error);}
  }
  return;
 }
 renderer.render(scene,camera);onFrame(time);if(mine&&!readyAnnounced){readyAnnounced=true;container.dataset.rendered='true';container.dataset.ready='true';onReady();}}catch(error){fail(error);}}
 const resize=()=>{const {width,height}=container.getBoundingClientRect();renderer.setSize(width,Math.max(1,height));camera.aspect=width/Math.max(1,height);camera.updateProjectionMatrix();};const observer=new ResizeObserver(()=>{if(disposed)return;try{resize();}catch(error){fail(error);}});defer(()=>observer.disconnect());observer.observe(container);resize();
 const lost=e=>{e.preventDefault();fail(new Error('WebGL context lost'));};renderer.domElement.addEventListener('webglcontextlost',lost);defer(()=>renderer.domElement.removeEventListener('webglcontextlost',lost));
 const visibility=()=>{cancelAnimationFrame(raf);if(!document.hidden&&!disposed){last=performance.now();raf=requestAnimationFrame(render);}};document.addEventListener('visibilitychange',visibility);defer(()=>document.removeEventListener('visibilitychange',visibility));if(!document.hidden)raf=requestAnimationFrame(render);
 return{update,feedback(){if(disposed)return;feedbackAt=performance.now();container.dataset.feedback=String(feedbackAt);},dispose};
 }catch(error){dispose();if(cleanupErrors.length)error.cleanupErrors=cleanupErrors;throw error;}
}
