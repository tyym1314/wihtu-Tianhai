import * as THREE from '/vendor/three.module.js';
const $=id=>document.getElementById(id), params=new URLSearchParams(location.search);
const clientId=params.get('client')||'demo-human', role=params.get('role')==='script'?'script':'manual', autoBots=params.get('bots')!=='0';
const palette=[0xe9a56b,0x74c4b3,0xb898d6,0xe2cd75];
let latency=0,lastSnapshot=null,primary,bots=[],errorCount=0,inputCount=0,frameTimes=[],lastFrame=performance.now(),lastMetrics=0,rtt=0,resumeCount=0;
function percentile(values,p){if(!values.length)return 0;return [...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*p)];}
const scene=new THREE.Scene();scene.background=new THREE.Color(0x132c37);scene.fog=new THREE.FogExp2(0x132c37,.013);
const canvas=$('scene'),renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.outputColorSpace=THREE.SRGBColorSpace;
const camera=new THREE.PerspectiveCamera(50,1,.1,180);camera.position.set(12,11,15);
scene.add(new THREE.HemisphereLight(0xcbecf3,0x64705a,2.3));const sun=new THREE.DirectionalLight(0xffdfaf,3.0);sun.position.set(-7,19,12);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-18,right:18,top:18,bottom:-100,near:1,far:150});scene.add(sun);scene.add(sun.target);
const material=(color,roughness=.7)=>new THREE.MeshStandardMaterial({color,roughness});
function box(w,h,d,color,x,y,z){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material(color));m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;scene.add(m);return m;}
box(110,.3,170,0x536761,0,-.4,-45);box(13,.3,90,0xb3aa8f,0,-.12,-39);
for(let i=0;i<=4;i++)box(.045,.012,89,0xf1e2b6,-6+i*3,.055,-39);
for(let z=2;z<82;z+=4)for(const side of [-1,1])box(.14,.3,.8,0x738a7d,side*7,.16,-z);
for(const z of [16,31,47,63])for(let lane=0;lane<4;lane++){box(2.1,.65,.65,0xce9562,-4.5+lane*3,.36,-z);box(2.13,.08,.68,0xf0d5a2,-4.5+lane*3,.72,-z);}
for(let i=0;i<10;i++)for(const side of [-1,1]){const z=-i*9+3;box(1.4,1+(i%3),1.9,0x7f8770,side*(10+(i%3)*2),.7,z);}
box(.45,5,.45,0xead7a6,-6.3,2.5,-78);box(.45,5,.45,0xead7a6,6.3,2.5,-78);box(13,1.0,.45,0xdfc690,0,5,-78);
for(let row=0;row<2;row++)for(let col=0;col<16;col++)box(.8,.025,.5,(row+col)%2?0x2b474d:0xf1e5c5,-6+col*.8,.075,-77.6-row*.5);
function makeRunner(lane){
 const rig=new THREE.Group(),body=new THREE.Group();scene.add(rig);rig.add(body);rig.position.x=-4.5+lane*3;
 const skin=material(palette[lane],.42),dark=material(0x243e47,.5);
 const torso=new THREE.Mesh(new THREE.CapsuleGeometry(.3,.48,4,10),skin);torso.position.y=.9;torso.castShadow=true;body.add(torso);
 const head=new THREE.Mesh(new THREE.SphereGeometry(.36,14,10),skin);head.position.y=1.6;head.castShadow=true;body.add(head);
 for(const side of [-1,1]){const ear=new THREE.Mesh(new THREE.ConeGeometry(.12,.31,5),skin);ear.position.set(side*.22,1.97,0);ear.rotation.z=side*.18;ear.castShadow=true;body.add(ear);const eye=new THREE.Mesh(new THREE.SphereGeometry(.045,8,6),dark);eye.position.set(side*.13,1.63,-.32);body.add(eye);}
 const limbs=[];for(let i=0;i<4;i++){const g=new THREE.Group();g.position.set((i%2?1:-1)*(i<2?.36:.16),i<2?1.05:.54,0);const limb=new THREE.Mesh(new THREE.CapsuleGeometry(i<2?.085:.12,.33,3,8),i<2?skin:dark);limb.position.y=-.2;limb.castShadow=true;g.add(limb);body.add(g);limbs.push(g);}
 const ring=new THREE.Mesh(new THREE.RingGeometry(.49,.57,28),new THREE.MeshBasicMaterial({color:palette[lane],side:THREE.DoubleSide,transparent:true,opacity:.8}));ring.rotation.x=-Math.PI/2;ring.position.y=.09;rig.add(ring);
 return {rig,body,limbs,ring,z:0,y:0};
}
const runners=[0,1,2,3].map(makeRunner);
function resize(){const rect=canvas.parentElement.getBoundingClientRect();renderer.setSize(rect.width,rect.height,false);camera.aspect=rect.width/rect.height;camera.updateProjectionMatrix();}new ResizeObserver(resize).observe(canvas.parentElement);resize();

class Connection {
 constructor(id,role,isPrimary=false){this.clientId=id;this.role=role;this.primary=isPrimary;this.ws=null;this.playerId=null;this.seq=0;this.snapshot=null;this.connected=false;this.pending=new Set();this.pings=new Map();this.jumped=new Set();this.ackMatch=null;this.connect();this.botTimer=setInterval(()=>this.act(),60);this.pingTimer=setInterval(()=>{if(this.connected){const id=`p-${performance.now()}`;this.pings.set(id,performance.now());this.send({type:'ping',id});}},1000);}
 later(fn,ms){const t=setTimeout(()=>{this.pending.delete(t);fn();},ms);this.pending.add(t);}
 connect(){const ws=new WebSocket(`ws://${location.host}`);this.ws=ws;ws.addEventListener('open',()=>{ws.send(JSON.stringify({type:'hello',clientId:this.clientId,role:this.role,resumeToken:localStorage.getItem('graybox:'+this.clientId)||undefined}));});ws.addEventListener('message',e=>{let msg;try{msg=JSON.parse(e.data);}catch{return;}const captured=ws;this.later(()=>{if(this.ws===captured)this.receive(msg);},latency/2);});ws.addEventListener('close',()=>{if(this.ws!==ws)return;this.connected=false;for(const t of this.pending)clearTimeout(t);this.pending.clear();if(this.primary)renderHud();});}
 send(msg){const ws=this.ws;this.later(()=>{if(this.ws===ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg));},latency/2);}
 receive(msg){
  if(msg.type==='welcome'){this.connected=true;this.playerId=msg.playerId;this.seq=msg.snapshot.players.find(p=>p.id===this.playerId).lastSeq;localStorage.setItem('graybox:'+this.clientId,msg.resumeToken);if(msg.resumed&&this.primary)resumeCount++;this.apply(msg.snapshot);if(this.primary&&autoBots&&!bots.length)for(let i=1;i<=3;i++)bots.push(new Connection('demo-script-'+i,'script'));}
  else if(msg.type==='snapshot')this.apply(msg.snapshot);
  else if(msg.type==='input-ack'){this.seq=Math.max(this.seq,msg.lastSeq||0);if(!msg.ok&&this.primary){errorCount++;$('errors').textContent=`${errorCount} · ${msg.code}`;}}
  else if(msg.type==='pong'){const started=this.pings.get(msg.id);if(started!==undefined){if(this.primary)rtt=performance.now()-started;this.pings.delete(msg.id);}}
  else if(msg.type==='error'){if(this.primary){errorCount++;$('errors').textContent=`${errorCount} · ${msg.code}`;$('race-status').textContent=msg.code;}console.warn('graybox',this.clientId,msg.code);}
 }
 apply(s){if(this.snapshot&&s.matchId===this.snapshot.matchId&&s.tick<this.snapshot.tick)return;if(this.snapshot?.matchId!==s.matchId){this.jumped.clear();this.ackMatch=null;}this.snapshot=s;if(this.primary){lastSnapshot=s;renderHud();}if(s.state==='finished'&&this.ackMatch!==s.matchId){this.ackMatch=s.matchId;this.send({type:'result-ack',matchId:s.matchId,resultHash:s.resultHash,winner:s.winner});}}
 jump(){if(!this.connected||!this.snapshot)return;this.seq++;if(this.primary)inputCount++;this.send({type:'input',action:'jump',seq:this.seq,matchId:this.snapshot.matchId});}
 act(){if(this.role!=='script'||!this.connected||this.snapshot?.state!=='racing')return;const p=this.snapshot.players.find(p=>p.id===this.playerId);if(!p||p.y>.03||p.finishTick!==null)return;for(let i=0;i<this.snapshot.obstacles.length;i++){const d=this.snapshot.obstacles[i]-p.z;if(d>0&&d<=2.05+latency/1000*6&&!this.jumped.has(i)){this.jumped.add(i);this.jump();break;}}}
 reconnect(delay=1200){if(!this.ws)return;const old=this.ws;old.close(4000,'User requested local reconnect test');setTimeout(()=>{if(this.ws===old)this.connect();},delay);}
}
function renderHud(){const s=lastSnapshot;if(!s)return;const me=s.players.find(p=>p.id===primary?.playerId);$('race-status').textContent=`${{waiting:'等待开始',racing:'比赛进行',finished:'全部冲线'}[s.state]} · ${(s.tick/60).toFixed(1)} s`;$('identity').textContent=`${primary?.playerId||'—'} / ${primary?.connected?'已连接':'断线中'}`;$('sequence').textContent=`发送 ${inputCount} · seq ${primary?.seq||0}`;$('tick').textContent=`${s.tick} / 60Hz`;$('hash').textContent=s.resultHash?`${s.resultHash.slice(0,20)}…`:`${s.matchId} · 快照 ${s.tick}`;
 $('roster').innerHTML=s.players.map((p,i)=>`<div class="runner"><span class="dot" style="background:#${palette[i].toString(16)}"></span><div class="label">${p.id===primary?.playerId?'当前角色':`角色 ${i+1}`} · ${p.role==='script'?'脚本测试':p.role==='manual'?'用户控制':'未接入'}<br><small>${p.connected?'● 已连接':'○ 未连接'} · 碰撞 ${p.hits}</small></div><span class="progress">${p.z.toFixed(1)} m</span></div>`).join('');
 $('start').disabled=!primary?.connected||primary?.playerId!=='runner-0'||s.state!=='waiting'||s.players.some(p=>!p.connected);$('reset').disabled=primary?.playerId!=='runner-0';$('jump').disabled=!primary?.connected||s.state!=='racing'||me?.finishTick!==null;
 $('winner').hidden=s.state!=='finished';if(s.state==='finished')$('winner').textContent=`${s.winner} 最先冲线 · 服务端已确定`;
}
primary=new Connection(clientId,role,true);
$('jump').onclick=()=>primary.jump();$('start').onclick=()=>primary.send({type:'start'});$('reset').onclick=()=>primary.send({type:'reset'});$('reconnect').onclick=()=>primary.reconnect();$('latency').oninput=e=>{latency=Number(e.target.value);$('latency-value').textContent=`${latency} ms`;};
addEventListener('keydown',e=>{if(e.code==='Space'&&e.target.tagName!=='INPUT'){e.preventDefault();primary.jump();}});
function frame(t){const elapsed=Math.min((t-lastFrame)/1000,.1);const delta=t-lastFrame;lastFrame=t;if(delta<500&&delta>0){frameTimes.push(delta);if(frameTimes.length>1800)frameTimes.shift();}
 const s=lastSnapshot;let follow=0;for(let i=0;i<4;i++){const model=runners[i],p=s?.players[i];if(!p)continue;const amount=1-Math.exp(-15*elapsed);model.z=THREE.MathUtils.lerp(model.z,p.z,amount);model.y=THREE.MathUtils.lerp(model.y,p.y,amount);model.rig.position.z=-model.z;model.body.position.y=model.y;const running=s.state==='racing'&&p.finishTick===null;const phase=t*.015+i;model.body.rotation.z=running?Math.sin(phase)*.055:0;for(let n=0;n<4;n++)model.limbs[n].rotation.x=running?Math.sin(phase+(n%2)*Math.PI+(n<2?Math.PI:0))*.7:0;model.ring.scale.setScalar(p.id===primary.playerId?1.25:1);if(p.id===primary.playerId)follow=model.z;}
 camera.position.lerp(new THREE.Vector3(11,10.3,-follow+14),1-Math.exp(-3*elapsed));camera.lookAt(0,1,-follow-10);sun.position.z=-follow+12;sun.target.position.z=-follow-12;renderer.render(scene,camera);
 if(t-lastMetrics>500){const recent=frameTimes.slice(-120);$('frame-p95').textContent=`${percentile(recent,.95).toFixed(1)} ms`;$('fps').textContent=recent.length?Math.round(1000/(recent.reduce((a,b)=>a+b,0)/recent.length)):'—';$('rtt').textContent=`${rtt.toFixed(0)} ms`;lastMetrics=t;}
 requestAnimationFrame(frame);
}requestAnimationFrame(frame);
window.__graybox={getState:()=>structuredClone(lastSnapshot),getDiagnostics:()=>({playerId:primary.playerId,connected:primary.connected,resumeCount,inputCount,errorCount,seq:primary.seq,frameP95Ms:percentile(frameTimes,.95),frameMeanMs:frameTimes.length?frameTimes.reduce((a,b)=>a+b,0)/frameTimes.length:null,rttMs:rtt,addedRttMs:latency,renderInfo:{drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles}}),jump:()=>primary.jump(),start:()=>primary.send({type:'start'}),reset:()=>primary.send({type:'reset'}),reconnect:()=>primary.reconnect(),sendRaw:msg=>primary.ws.send(JSON.stringify(msg)),setLatency:ms=>{latency=ms;$('latency').value=String(ms);$('latency-value').textContent=`${ms} ms`;}};
