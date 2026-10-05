import * as CANNON from 'cannon-es';
import{PHYSICS_VERSION,LANE,PIN_LAYOUT,PHYSICS}from'./constants.mjs';
export{PHYSICS_VERSION,LANE,PIN_LAYOUT,PHYSICS};
// JSON persistence canonicalizes -0 to 0. Return the same public trajectory on
// its first response and an idempotent replay loaded from the database.
const r=n=>{const value=Math.round(n*1e4)/1e4;return value===0?0:value;};
function error(code,message){const e=new Error(message);e.code=code;e.status=400;throw e;}
export function validateRoll(a){if(!a||a.type!=='roll'||Object.keys(a).some(k=>!['type','offset','angle','power','spin'].includes(k))||!Number.isFinite(a.offset)||Math.abs(a.offset)>.85||!Number.isFinite(a.angle)||Math.abs(a.angle)>.20||!Number.isFinite(a.power)||a.power<.25||a.power>1||!Number.isFinite(a.spin)||Math.abs(a.spin)>1)error('INVALID_ACTION','Submit bounded offset, angle, power and spin only');return a;}
export function pinDown(p){const up=new CANNON.Quaternion(...p.q).vmult(new CANNON.Vec3(0,1,0));return up.y<.85||Math.abs(p.x)>1.45||p.z> -11.8||p.z< -15.25||p.y<.16;}
const pinPose=b=>({id:b.pinId,x:r(b.position.x),y:r(b.position.y),z:r(b.position.z),q:[r(b.quaternion.x),r(b.quaternion.y),r(b.quaternion.z),r(b.quaternion.w)]});
/** Authoritative 60Hz compound-rigid-body simulation. No scripted hit counts or canned pin falls. */
export function simulateRoll(standing,action){
 validateRoll(action);if(!Array.isArray(standing)||new Set(standing).size!==standing.length||standing.some(id=>!PIN_LAYOUT.some(p=>p.id===id)))error('INVALID_PINS','Invalid standing pin set');
 const world=new CANNON.World({gravity:new CANNON.Vec3(0,-9.81,0),allowSleep:true});world.broadphase=new CANNON.NaiveBroadphase();world.narrowphase.enableFrictionReduction=false;world.solver.iterations=12;world.solver.tolerance=1e-5;world.defaultContactMaterial.contactEquationStiffness=1e6;world.defaultContactMaterial.contactEquationRelaxation=8;
 const laneMat=new CANNON.Material('lane'),pinMat=new CANNON.Material('pin'),ballMat=new CANNON.Material('ball');
 world.addContactMaterial(new CANNON.ContactMaterial(laneMat,ballMat,{contactEquationStiffness:1e6,contactEquationRelaxation:4,frictionEquationStiffness:1e6,frictionEquationRelaxation:4,friction:.015,restitution:.12}));world.addContactMaterial(new CANNON.ContactMaterial(laneMat,pinMat,{contactEquationStiffness:1e6,contactEquationRelaxation:4,frictionEquationStiffness:1e6,frictionEquationRelaxation:4,friction:.38,restitution:.10}));world.addContactMaterial(new CANNON.ContactMaterial(ballMat,pinMat,{contactEquationStiffness:1e6,contactEquationRelaxation:4,frictionEquationStiffness:1e6,frictionEquationRelaxation:4,friction:.23,restitution:.50}));world.addContactMaterial(new CANNON.ContactMaterial(pinMat,pinMat,{contactEquationStiffness:1e6,contactEquationRelaxation:4,frictionEquationStiffness:1e6,frictionEquationRelaxation:4,friction:.18,restitution:.32}));
 const ground=new CANNON.Body({mass:0,material:laneMat,shape:new CANNON.Plane(),quaternion:new CANNON.Quaternion().setFromEuler(-Math.PI/2,0,0),collisionFilterGroup:1});world.addBody(ground);
 const pinBodies=standing.map(id=>{const p=PIN_LAYOUT.find(p=>p.id===id),b=new CANNON.Body({mass:1.58,material:pinMat,position:new CANNON.Vec3(p.x,LANE.pinCOM,p.z),linearDamping:.20,angularDamping:.50,allowSleep:true,sleepSpeedLimit:PHYSICS.sleepSpeed,sleepTimeLimit:PHYSICS.sleepSeconds,collisionFilterGroup:2});b.pinId=id;b.addShape(new CANNON.Cylinder(.115,.095,.30,8),new CANNON.Vec3(0,-.17,0));b.addShape(new CANNON.Cylinder(.045,.115,.26,8),new CANNON.Vec3(0,.11,0));b.addShape(new CANNON.Cylinder(.045,.045,.11,6),new CANNON.Vec3(0,.295,0));b.addShape(new CANNON.Sphere(.073),new CANNON.Vec3(0,.41,0));world.addBody(b);return b;});
 const ball=new CANNON.Body({mass:7,material:ballMat,shape:new CANNON.Sphere(LANE.ballRadius),position:new CANNON.Vec3(action.offset,LANE.ballRadius+.001,LANE.startZ),linearDamping:.006,angularDamping:.006,allowSleep:false,collisionFilterGroup:4});const speed=6+action.power*4;ball.velocity.set(Math.sin(action.angle)*speed,0,-Math.cos(action.angle)*speed);ball.angularVelocity.set(-speed/LANE.ballRadius,action.spin*12,0);world.addBody(ball);
 let gutter=false,contact=false,elapsed=0,lastCollision=-1000,settleSince=null;const events=[],trajectory=[];
 const restHistory=new Map();for(const b of pinBodies)b.addEventListener('wakeup',()=>restHistory.delete(b.pinId));
 // Resting contacts can retain noisy solver velocities despite sub-millimetre pose jitter.
 // Sleep only after 600ms of measured pose stability; a subsequent physical impact wakes the body.
 const updateSleep=()=>{for(const b of pinBodies){if(b.sleepState===CANNON.Body.SLEEPING)continue;const h=restHistory.get(b.pinId)||[],p=b.position,q=b.quaternion,fallen=pinDown(pinPose(b)),linearRest=fallen?.012:.003,angularRest=fallen?.065:.018;h.push([p.x,p.y,p.z,q.x,q.y,q.z,q.w]);if(h.length>13)h.shift();restHistory.set(b.pinId,h);if(h.length===13&&b.velocity.length()<.2&&b.angularVelocity.length()<1&&h.every(v=>Math.hypot(p.x-v[0],p.y-v[1],p.z-v[2])<linearRest&&2*Math.acos(Math.min(1,Math.abs(q.x*v[3]+q.y*v[4]+q.z*v[5]+q.w*v[6])))<angularRest))b.sleep();}};
 const previousPins=new Map();const snapshot=t=>{const changed=[];for(const body of pinBodies){const p=pinPose(body),values=[p.id,p.x,p.y,p.z,...p.q],old=previousPins.get(p.id);if(!old||values.some((v,i)=>i&&Math.abs(v-old[i])>.001)){changed.push(values);previousPins.set(p.id,values);}}return{t,b:[r(ball.position.x),r(ball.position.y),r(ball.position.z),r(ball.quaternion.x),r(ball.quaternion.y),r(ball.quaternion.z),r(ball.quaternion.w)],p:changed};};
 for(const b of pinBodies)b.addEventListener('collide',event=>{if(event.body===ball&&!gutter){contact=true;if(elapsed-lastCollision>90){events.push({type:'hit',t:elapsed,pinId:b.pinId});lastCollision=elapsed;}}else if(event.body.pinId&&elapsed-lastCollision>90){events.push({type:'pin_hit',t:elapsed,pinId:b.pinId});lastCollision=elapsed;}});
 trajectory.push(snapshot(0));
 for(let step=1;step<=Math.round(PHYSICS.maxMs/(PHYSICS.dt*1000));step++){
  elapsed=Math.round(step*1000/60);
  if(!gutter&&ball.position.z>LANE.deckZ-.5){ball.force.x+=action.spin*1.05;}
  world.step(PHYSICS.dt);
  if(!gutter&&Math.abs(ball.position.x)>LANE.halfWidth-LANE.ballRadius*.3){gutter=true;ball.collisionFilterMask=1;events.push({type:'gutter',t:elapsed});}
  if(ball.position.z<LANE.backZ+.4||ball.position.y< -3||(contact&&ball.position.z>LANE.deckZ+1&&ball.velocity.z>0)){ball.velocity.set(0,0,0);ball.angularVelocity.set(0,0,0);ball.collisionFilterMask=0;}
  if(step%PHYSICS.sampleEvery===0){updateSleep();trajectory.push(snapshot(elapsed));}
  const passed=ball.position.z<LANE.backZ-.6||ball.collisionFilterMask===0||(contact&&elapsed>5000); 
  const stable=pinBodies.every(p=>p.sleepState===CANNON.Body.SLEEPING||(p.velocity.length()<PHYSICS.sleepSpeed&&p.angularVelocity.length()<PHYSICS.sleepSpeed));
  if(passed&&stable){settleSince??=elapsed;if(elapsed-settleSince>=400)break;}else settleSince=null;
 }
 if(trajectory.at(-1).t!==elapsed)trajectory.push(snapshot(elapsed));
 const final=pinBodies.map(pinPose),stable=pinBodies.every(p=>p.sleepState===CANNON.Body.SLEEPING||(p.velocity.length()<.15&&p.angularVelocity.length()<.15)),timedOut=elapsed>=PHYSICS.maxMs&&!stable;
 const down=final.filter(pinDown).map(p=>p.id),remaining=standing.filter(id=>!down.includes(id));events.push({type:timedOut?'physics_timeout':'settled',t:elapsed,down:[...down]});
 return{physicsVersion:PHYSICS_VERSION,outcome:timedOut?'fault':'settled',duration:elapsed,gutter,contact,down,remaining,finalPins:final,maxPinSpeed:r(Math.max(...pinBodies.map(p=>p.velocity.length()))),maxPinAngular:r(Math.max(...pinBodies.map(p=>p.angularVelocity.length()))),trajectory,events};
}
