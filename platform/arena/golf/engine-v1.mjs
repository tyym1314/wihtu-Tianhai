import {LEVELS,getLevel,insideCourse,nearestOnSegment,BALL_RADIUS,WALL_HALF_WIDTH,LEVEL_VERSION,PHYSICS_VERSION} from './levels-v1.mjs';
export const RULE_VERSION='pvp-golf-v1.0.0';
export const PHYSICS=Object.freeze({dt:1/120,maxSeconds:8,maxSpeed:11.6,friction:1.8,restitution:.68,stopSpeed:.035,holeMaxSpeed:3.1});
const round=n=>Math.round(n*1e9)/1e9;
function error(code,message,status=409){const e=new Error(message||code);e.code=code;e.status=status;throw e;}
function validNow(now){if(!Number.isSafeInteger(now)||now<0)error('INVALID_TIME','Invalid server clock',400);}
function copyPoint(p){return{x:p.x,z:p.z};}
/** No randomness, no player-player collision, no client time or position input. */
export function simulateShot(level,start,angle,power){
 if(!Number.isFinite(angle)||angle< -Math.PI||angle>Math.PI||!Number.isFinite(power)||power<.02||power>1)error('INVALID_ACTION','Angle or power outside permitted range',400);
 if(!insideCourse(level,start.x,start.z))error('INVALID_STATE','Ball is not on the course');
 let x=start.x,z=start.z,vx=Math.sin(angle)*power*PHYSICS.maxSpeed,vz=-Math.cos(angle)*power*PHYSICS.maxSpeed;
 const trajectory=[{t:0,x,z}],events=[];let outcome='stopped',duration=0;
 for(let i=1;i<=PHYSICS.maxSeconds/PHYSICS.dt;i++){
  const speed=Math.hypot(vx,vz),next=Math.max(0,speed-PHYSICS.friction*PHYSICS.dt),f=speed?next/speed:0;vx*=f;vz*=f;
  x=round(x+vx*PHYSICS.dt);z=round(z+vz*PHYSICS.dt);duration=Math.round(i*PHYSICS.dt*1000);
  for(const wall of level.walls){if(!wall.solid)continue;const q=nearestOnSegment(x,z,wall.a,wall.b),dx=x-q.x,dz=z-q.z,d=Math.hypot(dx,dz),radius=BALL_RADIUS+WALL_HALF_WIDTH;if(d>=radius||d<1e-10)continue;
   const nx=dx/d,nz=dz/d,approach=vx*nx+vz*nz;if(approach<0){x=q.x+nx*(radius+.0001);z=q.z+nz*(radius+.0001);vx-=approach*(1+PHYSICS.restitution)*nx;vz-=approach*(1+PHYSICS.restitution)*nz;if(!events.length||duration-events.at(-1).t>80)events.push({type:'bounce',t:duration,x:round(x),z:round(z)});}
  }
  for(const b of level.bumpers){const dx=x-b.x,dz=z-b.z,d=Math.hypot(dx,dz),r=b.r+BALL_RADIUS;if(d<r&&d>1e-9){const nx=dx/d,nz=dz/d,a=vx*nx+vz*nz;x=b.x+nx*(r+.0001);z=b.z+nz*(r+.0001);if(a<0){vx-=a*(1+PHYSICS.restitution)*nx;vz-=a*(1+PHYSICS.restitution)*nz;events.push({type:'bounce',t:duration,x:round(x),z:round(z)});}}}
  x=round(x);z=round(z);vx=round(vx);vz=round(vz);
  if(!insideCourse(level,x,z)){outcome='water';events.push({type:'water',t:duration,x,z});trajectory.push({t:duration,x,z});break;}
  if(Math.hypot(x-level.cup.x,z-level.cup.z)<level.holeRadius&&Math.hypot(vx,vz)<=PHYSICS.holeMaxSpeed){outcome='hole';x=level.cup.x;z=level.cup.z;events.push({type:'hole',t:duration,x,z});trajectory.push({t:duration,x,z});break;}
  if(i%4===0)trajectory.push({t:duration,x,z});
  if(Math.hypot(vx,vz)<=PHYSICS.stopSpeed){if(trajectory.at(-1).t!==duration)trajectory.push({t:duration,x,z});break;}
  if(i===PHYSICS.maxSeconds/PHYSICS.dt)outcome='fault';
 }
 return {outcome,duration:Math.max(160,duration),ball:outcome==='water'?copyPoint(start):{x:round(x),z:round(z)},trajectory,events};
}
function playerInit(p,now){return{key:p.key,seatIndex:p.seatIndex,name:p.name||p.key,isBot:!!p.isBot,ball:copyPoint(LEVELS[0].tee),strokes:0,completed:false,completedScores:[],completedAt:null,forfeited:false,forfeitedAt:null,timeouts:0,shotDeadlineAt:now+20000,busyUntil:0,shotStartedAt:0,shotId:0,trajectory:[],events:[],pending:null,lastEvent:null};}
export function createState(seedHex,now,options={}){
 validNow(now);if(typeof seedHex!=='string'||!/^[a-f0-9]{64}$/i.test(seedHex))error('INVALID_SEED','A 256-bit server seed is required',400);
 const players=options.players;if(!Array.isArray(players)||players.length<2||players.length>4||new Set(players.map(p=>p.key)).size!==players.length||players.some(p=>typeof p.key!=='string'||!p.key))error('INVALID_PLAYERS','Golf supports 2–4 unique players',400);
 return{gameId:'golf',ruleVersion:RULE_VERSION,levelVersion:LEVEL_VERSION,physicsVersion:PHYSICS_VERSION,status:'active',phase:'playing',holeIndex:0,holeStartedAt:now,holeDeadlineAt:now+90000,deadlineAt:now+90000,nextHoleAt:null,serverNow:now,players:players.map(p=>playerInit(p,now)),winnerKeys:[],outcome:null,finishedAt:null};
}
function finishHole(p,score,at,event){p.completed=true;p.completedAt=at;p.completedScores.push(score);p.pending=null;p.busyUntil=0;p.shotDeadlineAt=null;p.lastEvent={type:event,at,score};}
function finish(state,at,outcome='completed'){
 state.status='finished';state.phase='finished';state.finishedAt=at;state.outcome=outcome;state.deadlineAt=at;state.nextHoleAt=null;
 const eligible=state.players.filter(p=>!p.forfeited||p.completedScores.length===3);
 if(!eligible.length){state.outcome='void';state.winnerKeys=[];return;}
 const min=Math.min(...eligible.map(p=>p.completedScores.reduce((a,b)=>a+b,0)));state.winnerKeys=outcome==='forfeit'?eligible.map(p=>p.key):eligible.filter(p=>p.completedScores.reduce((a,b)=>a+b,0)===min).map(p=>p.key);
}
function terminalCheck(state,now){
 const eligible=state.players.filter(p=>!p.forfeited||p.completedScores.length===3);
 if(eligible.length<2){finish(state,now,eligible.length?'forfeit':'void');return true;}
 if(state.players.every(p=>p.forfeited||p.completedScores.length===3)){finish(state,now);return true;}return false;
}
function startHole(state,at){
 state.holeIndex++;state.phase='playing';state.holeStartedAt=at;state.holeDeadlineAt=at+90000;state.deadlineAt=at+90000;state.nextHoleAt=null;
 for(const p of state.players){if(p.forfeited)continue;p.ball=copyPoint(getLevel(state.holeIndex).tee);p.strokes=0;p.completed=false;p.completedAt=null;p.pending=null;p.busyUntil=0;p.shotDeadlineAt=at+20000;p.trajectory=[];p.events=[];p.lastEvent={type:'next_hole',at};}
}
function tickInternal(state,now,deferTerminal=false){
 validNow(now);if(now<state.serverNow)error('CLOCK_REWIND','Server time cannot go backwards');state.serverNow=now;if(state.status!=='active'||state.phase==='fault')return;
 for(let pass=0;pass<8;pass++){
  if(state.phase==='intermission'){if(now<state.nextHoleAt)return;startHole(state,state.nextHoleAt);}
  const horizon=Math.min(now,state.holeDeadlineAt);
  for(const p of state.players){
   if(p.forfeited||p.completed)continue;
   if(p.pending&&p.busyUntil<=horizon){const at=p.busyUntil,result=p.pending;p.ball=result.ball;p.pending=null;p.busyUntil=0;
    if(result.outcome==='water'){p.strokes++;p.lastEvent={type:'water',at,penalty:1};}
    else p.lastEvent={type:result.outcome,at};
    if(result.outcome==='hole'&&p.strokes<=10)finishHole(p,p.strokes,at,'hole');
    else if(p.strokes>=10)finishHole(p,12,at,'stroke_limit');
    else p.shotDeadlineAt=at+20000;
   }
   while(!p.completed&&!p.pending&&!p.forfeited&&p.shotDeadlineAt<=horizon){const at=p.shotDeadlineAt;p.strokes++;p.timeouts++;p.lastEvent={type:'shot_timeout',at,penalty:1};p.shotDeadlineAt=at+20000;
    // A third timeout cannot manufacture a protected final-hole completion.
    if(p.timeouts>=3){p.forfeited=true;p.forfeitedAt=at;p.shotDeadlineAt=null;p.lastEvent={type:'forfeit_timeout',at};}
    else if(p.strokes>=10)finishHole(p,12,at,'stroke_limit');
   }
   if(!p.forfeited&&!p.completed&&now>=state.holeDeadlineAt)finishHole(p,12,state.holeDeadlineAt,'hole_timeout');
  }
  if(!deferTerminal&&terminalCheck(state,now))return;
  const active=state.players.filter(p=>!p.forfeited);
  if(deferTerminal&&active.length<2)return;
  if(active.every(p=>p.completed)){
   if(state.holeIndex===2){if(!deferTerminal)finish(state,Math.max(...active.map(p=>p.completedAt)));return;}
   const ended=Math.max(...active.map(p=>p.completedAt));state.phase='intermission';state.nextHoleAt=ended+5000;state.deadlineAt=state.nextHoleAt;
   if(now>=state.nextHoleAt)continue;
  }
  return;
 }
}
export function tick(state,now){tickInternal(state,now);return {state};}
export function act(state,playerKey,action,now){
 tickInternal(state,now);if(state.status!=='active'||state.phase!=='playing')error('NOT_ACTIVE','This hole is not accepting shots');
 const p=state.players.find(p=>p.key===playerKey);if(!p)error('PLAYER_NOT_FOUND','Player not in match',403);
 if(p.forfeited||p.completed)error('NOT_ACTIVE','This player has finished the hole');
 if(p.pending||now<p.busyUntil)error('BUSY','Wait for the ball to stop');
 if(!action||action.type!=='shot'||Object.keys(action).some(k=>!['type','angle','power'].includes(k)))error('INVALID_ACTION','Only angle and power can be submitted',400);
 const result=simulateShot(getLevel(state.holeIndex),p.ball,action.angle,action.power);
 if(result.outcome==='fault'){state.phase='fault';state.fault={code:'PHYSICS_TIMEOUT',at:now};return {state,event:state.fault};}
 p.strokes++;p.timeouts=0;p.shotId++;p.shotStartedAt=now;p.busyUntil=now+result.duration;p.shotDeadlineAt=p.busyUntil+20000;p.trajectory=result.trajectory;p.events=result.events;p.pending=result;p.lastEvent={type:'shot',at:now};
 return {state,event:{type:'shot',playerKey,holeIndex:state.holeIndex,shotId:p.shotId,startedAt:now,busyUntil:p.busyUntil,trajectory:p.trajectory,events:p.events}};
}
/** Batch a single authoritative tick's forfeits before deciding a winner. Finished scores remain valid. */
export function forfeit(state,keys,now){
 tickInternal(state,now,true);if(state.status!=='active')return {state};
 for(const p of state.players)if(keys.includes(p.key)&&p.completedScores.length<3){p.forfeited=true;p.forfeitedAt=now;p.pending=null;p.busyUntil=0;p.lastEvent={type:'forfeit',at:now};}
 terminalCheck(state,now);return{state,event:{type:'forfeit',playerKeys:keys,at:now}};
}
function publicPlayer(p){const score=p.completedScores.reduce((a,b)=>a+b,0);return{key:p.key,name:p.name,seatIndex:p.seatIndex,isBot:p.isBot,ball:copyPoint(p.ball),strokes:p.strokes,completed:p.completed,completedScores:[...p.completedScores],score,forfeited:p.forfeited,timeouts:p.timeouts,shotDeadlineAt:p.shotDeadlineAt,busyUntil:p.busyUntil,shotId:p.shotId,shotStartedAt:p.shotStartedAt,trajectory:p.trajectory.map(q=>({...q})),events:p.events.map(q=>({...q})),lastEvent:p.lastEvent?{...p.lastEvent}:null};}
export function view(state,key){const players=state.players.map(publicPlayer);return{gameId:'golf',status:state.status,phase:state.phase,ruleVersion:state.ruleVersion,levelVersion:state.levelVersion,physicsVersion:state.physicsVersion,holeIndex:state.holeIndex,holeStartedAt:state.holeStartedAt,holeDeadlineAt:state.holeDeadlineAt,nextHoleAt:state.nextHoleAt,serverNow:state.serverNow,winnerKeys:[...state.winnerKeys],outcome:state.outcome,fault:state.fault?{...state.fault}:null,me:players.find(p=>p.key===key)||null,players};}
export function rank(state){
 const eligible=state.players.filter(p=>!p.forfeited||p.completedScores.length===3),scores=eligible.map(p=>p.completedScores.reduce((a,b)=>a+b,0));
 return state.players.map(p=>{const score=p.completedScores.reduce((a,b)=>a+b,0),ok=eligible.includes(p);return{playerKey:p.key,rank:ok?(state.outcome==='forfeit'?1:1+scores.filter(n=>n<score).length):eligible.length+1,score,forfeited:!ok,eligible:ok,completed:p.completedScores.length===3,winner:state.winnerKeys.includes(p.key)};}).sort((a,b)=>a.rank-b.rank);
}
export function shiftTime(state,deltaMs){
 if(!Number.isSafeInteger(deltaMs)||deltaMs<0)error('INVALID_TIME','Pause delta must be nonnegative',400);
 for(const k of ['holeStartedAt','holeDeadlineAt','deadlineAt','nextHoleAt','serverNow','finishedAt'])if(typeof state[k]==='number')state[k]+=deltaMs;
 for(const p of state.players){for(const k of ['shotDeadlineAt','busyUntil','completedAt','forfeitedAt'])if(typeof p[k]==='number'&&(p[k]!==0||!['busyUntil'].includes(k)))p[k]+=deltaMs;if(p.shotId>0)p.shotStartedAt+=deltaMs;if(p.lastEvent)p.lastEvent.at+=deltaMs;}
 if(state.fault)state.fault.at+=deltaMs;return state;
}
export function botAction(state,key,now){
 const p=state.players.find(p=>p.key===key);if(!p||p.forfeited||p.completed||p.pending||state.status!=='active'||state.phase!=='playing'||now<p.busyUntil)return null;
 const level=getLevel(state.holeIndex);let nearest=0;for(let i=1;i<level.samples.length;i++)if(Math.hypot(p.ball.x-level.samples[i].x,p.ball.z-level.samples[i].z)<Math.hypot(p.ball.x-level.samples[nearest].x,p.ball.z-level.samples[nearest].z))nearest=i;
 let target=level.cup,travel=0;for(let i=nearest+1;i<level.samples.length;i++){travel+=Math.hypot(level.samples[i].x-level.samples[i-1].x,level.samples[i].z-level.samples[i-1].z);if(travel>=3.7){target=level.samples[i];break;}}
 const d=Math.hypot(target.x-p.ball.x,target.z-p.ball.z);return{type:'shot',angle:Math.atan2(target.x-p.ball.x,p.ball.z-target.z),power:Math.max(.04,Math.min(.78,Math.sqrt(2*PHYSICS.friction*(d+.12))/PHYSICS.maxSpeed))};
}
