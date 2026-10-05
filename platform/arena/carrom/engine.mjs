import {BOARD,LEVEL_VERSION,PHYSICS_VERSION,initialCoins,physicalSide,nearestLegalOffset,validOffset,returnPosition,strikerPosition,shotDirection,POCKETS} from './geometry.mjs';
import {simulateShot} from './physics.mjs';
export {simulateShot} from './physics.mjs';
export const RULE_VERSION='pvp-carrom-v1.0.0';
function fail(code,message=code,status=409){const e=new Error(message);e.code=code;e.status=status;throw e;}
function clock(s,now){if(!Number.isSafeInteger(now)||now<0)fail('INVALID_TIME','Invalid server time',400);if(s&&now<s.serverNow)fail('CLOCK_REWIND');}
const teamFor=(s,key)=>s.teams.find(t=>t.id===s.players.find(p=>p.key===key)?.teamId);
const activeTeams=s=>s.teams.filter(t=>!t.forfeited);
function finish(s,winnerTeams,at,outcome){s.status='finished';s.phase='finished';s.finishedAt=at;s.outcome=outcome;s.winnerTeamIds=[...winnerTeams];s.winnerKeys=s.players.filter(p=>winnerTeams.includes(p.teamId)).map(p=>p.key);s.turnDeadlineAt=null;s.busyUntil=0;}
function dropoutTerminal(s,now){const active=activeTeams(s);if(active.length>1)return false;finish(s,active.map(t=>t.id),now,active.length?'forfeit':'void');return true;}
function limits(s,at){if(s.status!=='active'||s.pending||at<s.matchDeadlineAt&&s.shotCount<200)return false;const active=activeTeams(s),best=Math.max(...active.map(t=>t.captured.length)),equal=active.filter(t=>t.captured.length===best),covered=equal.filter(t=>s.queen.status==='covered'&&s.queen.teamId===t.id);finish(s,(covered.length?covered:equal).map(t=>t.id),at,'limit');return true;}
function putBack(s,id,reason,returned){const c=s.coins.find(c=>c.id===id);if(!c)return;c.pocketed=true;const p=returnPosition(s.coins,id);if(!p){s.phase='fault';s.fault={code:'RETURN_POSITION_UNAVAILABLE',at:s.serverNow};return;}Object.assign(c,p,{pocketed:false});for(const t of s.teams)t.captured=t.captured.filter(v=>v!==id);returned?.push({id,reason,x:p.x,y:p.y});}
function restoreQueen(s,reason,returned){putBack(s,'queen',reason,returned);s.queen={status:'board',teamId:null,coverPlayerKey:null};}
function nextTurn(s,at,continueTurn=false){if(!continueTurn){const p=s.players.findIndex(p=>p.key===s.turnKey);for(let i=1;i<=s.players.length;i++){const next=s.players[(p+i)%s.players.length];if(!next.forfeited){s.turnKey=next.key;break;}}}s.turnStartedAt=at;s.turnDeadlineAt=at+20000;s.phase='aiming';}
function markTeams(s,keys,at){const ids=new Set(s.players.filter(p=>keys.includes(p.key)).map(p=>p.teamId));for(const t of s.teams)if(ids.has(t.id))t.forfeited=true;for(const p of s.players)if(ids.has(p.teamId)){p.forfeited=true;p.forfeitedAt=at;}}
export function createState(seedHex,now,{players}={}){
 clock(null,now);if(typeof seedHex!=='string'||!/^[a-f0-9]{64}$/i.test(seedHex))fail('INVALID_SEED','256-bit seed required',400);
 if(!Array.isArray(players)||![2,4].includes(players.length)||new Set(players.map(p=>p.key)).size!==players.length||players.some(p=>typeof p.key!=='string'||!p.key))fail('INVALID_PLAYERS','Carrom supports 2 or 4 unique players',400);
 const ps=players.map(p=>({...p,teamId:p.teamId??`team_${p.seatIndex%2}`,name:p.name||p.key,isBot:!!p.isBot,forfeited:false,timeouts:0,forfeitedAt:null})).sort((a,b)=>a.seatIndex-b.seatIndex);
 if(ps.some((p,i)=>p.seatIndex!==i)||new Set(ps.map(p=>p.teamId)).size!==2)fail('INVALID_PLAYERS','Two frozen opposing teams and contiguous seats are required',400);
 if(ps.length===4&&(ps[0].teamId!==ps[2].teamId||ps[1].teamId!==ps[3].teamId||ps[0].teamId===ps[1].teamId))fail('INVALID_PLAYERS','Team members must occupy opposite seats',400);
 const teams=[{id:ps[0].teamId,color:'white'},{id:ps[1].teamId,color:'black'}].map(t=>({...t,captured:[],everCollected:false,debt:0,forfeited:false}));
 return {gameId:'carrom',ruleVersion:RULE_VERSION,levelVersion:LEVEL_VERSION,physicsVersion:PHYSICS_VERSION,status:'active',phase:'aiming',serverNow:now,startedAt:now,matchDeadlineAt:now+600000,deadlineAt:now+600000,players:ps,teams,coins:initialCoins(seedHex),queen:{status:'board',teamId:null,coverPlayerKey:null},turnKey:ps[0].key,turnStartedAt:now,turnDeadlineAt:now+20000,shotCount:0,shotId:0,shotStartedAt:0,busyUntil:0,pending:null,trajectory:[],events:[],lastEvent:null,winnerKeys:[],winnerTeamIds:[],outcome:null,finishedAt:null};
}
/** Authoritative adjudicator: HTTP inputs never call this directly. Exposed for rule fixtures. */
export function resolveShot(s,result,at){
 const player=s.players.find(p=>p.key===s.turnKey),own=teamFor(s,player.key),opponent=s.teams.find(t=>t.id!==own.id),priorOwn=[...own.captured],eligibleBefore=own.everCollected,wasPending=s.queen.status==='pending',returned=[];
 s.coins=result.coins.map(c=>({...c}));
 const ownNew=result.pocketed.filter(id=>s.coins.find(c=>c.id===id)?.kind===own.color),oppNew=result.pocketed.filter(id=>s.coins.find(c=>c.id===id)?.kind===opponent.color),queenNew=result.pocketed.includes('queen');
 const ownEjected=result.ejected.some(id=>s.coins.find(c=>c.id===id)?.kind===own.color),queenEjected=result.ejected.includes('queen');
 const foul=result.pocketed.includes('striker')||result.ejected.includes('striker')||ownEjected||!!result.illegal;
 const credit=(team,ids)=>{const retained=[];for(const id of ids){if(team.debt>0){team.debt--;putBack(s,id,'penalty_debt',returned);}else{if(!team.captured.includes(id))team.captured.push(id);retained.push(id);}}if(retained.length)team.everCollected=true;return retained;};
 credit(opponent,oppNew);let retained=[];
 for(const id of result.ejected)if(id!=='striker')putBack(s,id,'ejected',returned);
 if(foul){
  for(const id of ownNew)putBack(s,id,'foul_return',returned);
  if(queenNew||wasPending||queenEjected)restoreQueen(s,'queen_foul',returned);
  const penalty=priorOwn.at(-1);if(penalty)putBack(s,penalty,'foul_penalty',returned);else own.debt++;
 }else{
  retained=credit(own,ownNew);
  if(queenNew){if(!eligibleBefore)restoreQueen(s,'queen_ineligible',returned);else if(retained.length){s.queen={status:'covered',teamId:own.id,coverPlayerKey:null};}else s.queen={status:'pending',teamId:own.id,coverPlayerKey:player.key};}
  else if(wasPending){if(retained.length)s.queen={status:'covered',teamId:own.id,coverPlayerKey:null};else restoreQueen(s,'queen_uncovered',returned);}
  if(queenEjected)restoreQueen(s,'queen_ejected',returned);
 }
 if(s.queen.status!=='covered')for(const t of s.teams)if(t.captured.length>=9){const id=t.captured.at(-1);putBack(s,id,'last_before_queen',returned);retained=retained.filter(v=>v!==id);}
 const cleared=s.teams.filter(t=>t.captured.length===9&&!t.forfeited);const winners=foul?cleared.filter(t=>t.id!==own.id):cleared;
 s.pending=null;s.busyUntil=0;s.lastEvent={type:foul?'foul':s.queen.status==='covered'&&(queenNew||wasPending)?'queen_covered':s.queen.status==='pending'?'queen_pending':retained.length?'score':'miss',at,playerKey:player.key,teamId:own.id,captured:retained.length,opponentCaptured:oppNew.length,returned,foul,debt:own.debt};
 if(s.phase==='fault')return {state:s,event:s.fault};
 if(s.queen.status==='covered'&&winners.length){finish(s,winners.map(t=>t.id),at,'cleared');return {state:s,event:s.lastEvent};}
 nextTurn(s,at,!foul&&!queenEjected&&(retained.length>0||s.queen.status==='pending'&&s.queen.teamId===own.id));
 return {state:s,event:s.lastEvent};
}
function tickInternal(s,now,deferDropout=false){
 clock(s,now);s.serverNow=now;if(s.status!=='active'||s.phase==='fault')return;
 if(s.pending){if(now<s.busyUntil)return;resolveShot(s,s.pending,s.busyUntil);if(s.status!=='active'||s.phase==='fault')return;}
 if(!deferDropout&&dropoutTerminal(s,now))return;
 // Catch up expired turns before the match clock; recovery cannot erase earlier forfeits.
 if(!deferDropout&&s.shotCount>=200&&limits(s,now))return;
 for(let n=0;n<40&&s.status==='active'&&!s.pending&&s.turnDeadlineAt<=now&&s.turnDeadlineAt<=s.matchDeadlineAt;n++){
  const at=s.turnDeadlineAt,p=s.players.find(p=>p.key===s.turnKey);if(p.forfeited){nextTurn(s,at);continue;}
  p.timeouts++;const returned=[];if(s.queen.status==='pending')restoreQueen(s,'queen_cover_timeout',returned);
  s.lastEvent={type:'timeout',at,playerKey:p.key,timeouts:p.timeouts,returned};if(p.timeouts>=3)markTeams(s,[p.key],at);nextTurn(s,at);
  if(activeTeams(s).length<2){if(!deferDropout)dropoutTerminal(s,at);return;}
 }
 if(!deferDropout){dropoutTerminal(s,now);limits(s,now);}
}
export function tick(s,now){tickInternal(s,now);return {state:s};}
export function act(s,key,action,now){
 tickInternal(s,now);if(s.status!=='active'||s.phase==='fault')fail('NOT_ACTIVE');if(s.pending||now<s.busyUntil)fail('BUSY','Wait until every disc is at rest');if(key!==s.turnKey)fail('NOT_YOUR_TURN');const p=s.players.find(p=>p.key===key);if(!p||p.forfeited)fail('NOT_ACTIVE');
 if(!action||action.type!=='shot'||Object.keys(action).some(k=>!['type','offset','angle','power'].includes(k))||!Number.isFinite(action.angle)||Math.abs(action.angle)>Math.PI||!Number.isFinite(action.power)||action.power<.02||action.power>1||!Number.isFinite(action.offset)||Math.abs(action.offset)>1)fail('INVALID_ACTION','Expected bounded offset, angle and power only',400);
 if(!validOffset(s.coins,p.seatIndex,s.players.length,action.offset))fail('STRIKER_BLOCKED','Choose a clear place on your own baseline',400);
 const result=simulateShot(s.coins,p.seatIndex,s.players.length,action);if(result.fault){s.phase='fault';s.fault={code:'PHYSICS_TIMEOUT',at:now};return{state:s,event:s.fault};}
 p.timeouts=0;s.shotId++;s.shotCount++;s.shotStartedAt=now;s.busyUntil=now+result.duration;s.pending=result;s.phase='rolling';s.trajectory=result.trajectory;s.events=result.events;s.lastAction={...action,playerKey:key,seatIndex:p.seatIndex};s.lastEvent={type:'shot',at:now,playerKey:key};return{state:s,event:{type:'shot',shotId:s.shotId,playerKey:key,busyUntil:s.busyUntil,trajectory:s.trajectory,events:s.events}};
}
export function forfeit(s,keys,now){tickInternal(s,now,true);if(s.status!=='active')return{state:s};markTeams(s,keys,now);if(dropoutTerminal(s,now))return{state:s};if(s.players.find(p=>p.key===s.turnKey)?.forfeited){if(s.queen.status==='pending')restoreQueen(s,'queen_team_forfeit');s.pending=null;s.busyUntil=0;nextTurn(s,now);}limits(s,now);return{state:s};}
export function rank(s){const winners=s.winnerTeamIds||[],active=activeTeams(s);return s.players.map(p=>{const t=teamFor(s,p.key),n=t.captured.length,queen=s.queen.status==='covered'&&s.queen.teamId===t.id;let r=1+active.filter(o=>o.captured.length>n||o.captured.length===n&&!queen&&s.queen.status==='covered'&&s.queen.teamId===o.id).length;if(s.status==='finished')r=winners.includes(t.id)?1:2;if(t.forfeited)r=2;return{playerKey:p.key,teamId:t.id,rank:r,score:n,scoreLabel:`${n}/9${queen?' · QUEEN':''}`,forfeited:t.forfeited,winner:winners.includes(t.id)};}).sort((a,b)=>a.rank-b.rank);}
export function view(s,key){const ps=s.players.map(p=>{const t=teamFor(s,p.key);return{key:p.key,name:p.name,seatIndex:p.seatIndex,side:physicalSide(p.seatIndex,s.players.length),teamId:p.teamId,color:t.color,isBot:p.isBot,forfeited:p.forfeited,timeouts:p.timeouts,score:t.captured.length,scoreLabel:`${t.captured.length}/9`};}),turn=s.players.find(p=>p.key===s.turnKey),me=ps.find(p=>p.key===key);return{gameId:'carrom',status:s.status,phase:s.phase,ruleVersion:s.ruleVersion,levelVersion:s.levelVersion,physicsVersion:s.physicsVersion,serverNow:s.serverNow,matchDeadlineAt:s.matchDeadlineAt,turnKey:s.turnKey,turnSeat:turn?.seatIndex,turnSide:turn?physicalSide(turn.seatIndex,s.players.length):0,turnDeadlineAt:s.turnDeadlineAt,turnStartedAt:s.turnStartedAt,shotCount:s.shotCount,shotId:s.shotId,shotStartedAt:s.shotStartedAt,busyUntil:s.busyUntil,coins:s.coins.map(c=>({...c})),queen:{...s.queen},teams:s.teams.map(t=>({...t,captured:[...t.captured]})),players:ps,me,defaultOffset:turn?nearestLegalOffset(s.coins,turn.seatIndex,s.players.length):null,trajectory:s.trajectory,events:s.events,lastAction:s.lastAction?{...s.lastAction}:null,lastEvent:s.lastEvent?JSON.parse(JSON.stringify(s.lastEvent)):null,winnerKeys:[...s.winnerKeys],outcome:s.outcome,fault:s.fault?{...s.fault}:null};}
export function shiftTime(s,ms){if(!Number.isSafeInteger(ms)||ms<0)fail('INVALID_TIME');for(const k of ['startedAt','matchDeadlineAt','deadlineAt','serverNow','turnStartedAt','turnDeadlineAt','finishedAt'])if(typeof s[k]==='number')s[k]+=ms;if(s.busyUntil)s.busyUntil+=ms;if(s.shotId)s.shotStartedAt+=ms;if(s.lastEvent)s.lastEvent.at+=ms;if(s.fault)s.fault.at+=ms;for(const p of s.players)if(p.forfeitedAt!==null)p.forfeitedAt+=ms;return s;}
export function botAction(s,key,now){
 if(s.status!=='active'||s.phase!=='aiming'||s.turnKey!==key||s.pending||now>=s.turnDeadlineAt)return null;const p=s.players.find(p=>p.key===key),team=teamFor(s,key);if(!p||p.forfeited)return null;const eligible=s.coins.filter(c=>!c.pocketed&&(c.kind===team.color||c.kind==='queen'&&team.everCollected));let best=null;
 for(const offset of [-.8,-.4,0,.4,.8]){if(!validOffset(s.coins,p.seatIndex,s.players.length,offset))continue;const start=strikerPosition(p.seatIndex,s.players.length,offset);for(const target of eligible){for(const pocket of POCKETS){const dx=pocket.x-target.x,dy=pocket.y-target.y,d=Math.hypot(dx,dy),contact={x:target.x-dx/d*(BOARD.coinRadius+BOARD.strikerRadius),y:target.y-dy/d*(BOARD.coinRadius+BOARD.strikerRadius)},vx=contact.x-start.x,vy=contact.y-start.y,l=Math.hypot(vx,vy),normal=shotDirection(p.seatIndex,s.players.length,0),right=shotDirection(p.seatIndex,s.players.length,Math.PI/2),angle=Math.atan2(vx*right.x+vy*right.y,vx*normal.x+vy*normal.y);if(!Number.isFinite(angle)||l<.1)continue;
  const aligned=(vx*dx+vy*dy)/(l*d),obstruct=s.coins.some(c=>!c.pocketed&&c.id!==target.id&&segmentDistance(c.x,c.y,start,contact)<BOARD.coinRadius+BOARD.strikerRadius+.03);const score=aligned*5-l*.15-d*.12-(obstruct?5:0)+(target.kind==='queen'&&team.captured.length>=6?.6:0);if(!best||score>best.score)best={score,type:'shot',offset,angle,power:Math.max(.28,Math.min(.94,Math.sqrt(2*2.4*(l+d*.8))*1.15/18))};
 }}}
 if(best){const{score,...action}=best;return action;}const offset=nearestLegalOffset(s.coins,p.seatIndex,s.players.length);return offset===null?null:{type:'shot',offset,angle:0,power:.72};
}
function segmentDistance(x,y,a,b){const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy)));return Math.hypot(x-a.x-t*dx,y-a.y-t*dy);}
