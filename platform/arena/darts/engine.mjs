import {BOARD_VERSION,RINGS,SEGMENTS,mapGesture,gestureToward} from './geometry.mjs';
export const RULE_VERSION='pvp-darts-v1.0.0';
const TURN_MS=20000,FLIGHT_MS=650;
function fail(code,message=code,status=409){const e=new Error(message);e.code=code;e.status=status;throw e;}
function time(now){if(!Number.isSafeInteger(now)||now<0)fail('INVALID_TIME','Invalid server timestamp',400);}
const active=s=>s.players.filter(p=>!p.forfeited);
function finish(s,now,outcome='completed'){s.status='finished';s.outcome=outcome;s.finishedAt=now;s.turnKey=null;s.turnDeadlineAt=null;const ps=active(s);if(!ps.length){s.outcome='void';s.winnerKeys=[];}else{const min=Math.min(...ps.map(p=>p.remaining));s.winnerKeys=(outcome==='forfeit'?ps:ps.filter(p=>p.remaining===min)).map(p=>p.key);}}
function eligibility(s,now){if(active(s).length<2){finish(s,now,active(s).length?'forfeit':'void');return true;}return false;}
function beginTurn(s,index,at){const p=s.players[index];s.turnIndex=index;s.turnKey=p.key;s.turnStartedAt=at;s.turnDeadlineAt=at+TURN_MS;s.turnStartRemaining=p.remaining;s.currentDarts=[];s.turnHadThrow=false;}
function endTurn(s,at,reason,defer=false){
 const p=s.players[s.turnIndex];p.turns.push({round:s.round,start:s.turnStartRemaining,remaining:p.remaining,darts:s.currentDarts.map(d=>({...d})),reason});
 if(reason==='timeout'&&!s.turnHadThrow){p.timeouts++;if(p.timeouts>=3)p.forfeited=true;}
 if(active(s).length<2){if(!defer)eligibility(s,at);else s.deferredEnd=true;return;}
 if(s.turnIndex===1){if(s.players.some(p=>p.remaining===0)||s.round===10){if(defer)s.deferredRoundEnd=true;else finish(s,at);return;}s.round++;beginTurn(s,0,at);}else beginTurn(s,1,at);
}
export function createState(seedHex,now,{players}={}){
 time(now);if(!/^[a-f0-9]{64}$/i.test(seedHex||''))fail('INVALID_SEED','A 256-bit server seed is required',400);
 if(!Array.isArray(players)||players.length!==2||new Set(players.map(p=>p.key)).size!==2||players.some(p=>typeof p.key!=='string'||!p.key)||new Set(players.map(p=>p.seatIndex)).size!==2)fail('INVALID_PLAYERS','Darts requires two unique players/seats',400);
 const s={gameId:'darts',ruleVersion:RULE_VERSION,boardVersion:BOARD_VERSION,status:'active',outcome:null,startedAt:now,serverNow:now,deadlineAt:now+413000,round:1,players:[...players].sort((a,b)=>a.seatIndex-b.seatIndex).map(p=>({key:p.key,name:p.name||p.key,seatIndex:p.seatIndex,isBot:!!p.isBot,remaining:301,forfeited:false,timeouts:0,turns:[]})),busyUntil:now,version:0,lastEvent:null,winnerKeys:[]};beginTurn(s,0,now);return s;
}
function tickInternal(s,now,defer=false){time(now);if(now<s.serverNow)fail('CLOCK_REWIND');s.serverNow=now;if(s.status!=='active')return;for(let i=0;i<24&&s.status==='active'&&now>=s.turnDeadlineAt;i++){const at=s.turnDeadlineAt;endTurn(s,at,'timeout',defer);s.version++;s.lastEvent={id:s.version,type:'timeout',at,turnKey:s.turnKey};if(s.deferredEnd||s.deferredRoundEnd)break;}}
export function tick(s,now){tickInternal(s,now);return{state:s};}
export function act(s,key,action,now){
 time(now);if(!action||action.type!=='throw'||Object.keys(action).some(k=>!['type','gesture'].includes(k)))fail('INVALID_ACTION','Only a recorded throw gesture is accepted',400);
 const hit=mapGesture(action.gesture);tickInternal(s,now);if(s.status!=='active')fail('NOT_ACTIVE');if(s.turnKey!==key)fail('NOT_YOUR_TURN');if(now<s.busyUntil)fail('BUSY');
 if(now-s.turnStartedAt<hit.durationMs)fail('INVALID_GESTURE','Gesture cannot begin before this turn',400);
 const p=s.players[s.turnIndex];if(p.forfeited)fail('NOT_A_PLAYER');const before=p.remaining,next=before-hit.score;p.timeouts=0;s.turnHadThrow=true;s.version++;
 const dart={...hit,at:now,round:s.round,playerKey:key,dartIndex:s.currentDarts.length};s.currentDarts.push(dart);s.busyUntil=now+FLIGHT_MS;
 let bust=false;if(next<0){p.remaining=s.turnStartRemaining;bust=true;}else p.remaining=next;
 const event={id:s.version,type:'throw',playerKey:key,round:s.round,dartIndex:dart.dartIndex,hit,before,remaining:p.remaining,bust,checkout:p.remaining===0,at:now,busyUntil:s.busyUntil};s.lastEvent=event;
 if(bust||p.remaining===0||s.currentDarts.length===3)endTurn(s,now+FLIGHT_MS,bust?'bust':p.remaining===0?'checkout':'three_darts');
 return{state:s,event};
}
export function forfeit(s,keys,now){time(now);if(s.status!=='active')return{state:s};if(!Array.isArray(keys)||keys.some(k=>!s.players.some(p=>p.key===k)))fail('INVALID_PLAYER');tickInternal(s,now,true);if(s.status!=='active')return{state:s};for(const p of s.players)if(keys.includes(p.key))p.forfeited=true;s.version++;
 if(!eligibility(s,now)){if(s.deferredRoundEnd)finish(s,now);else if(s.deferredEnd)beginTurn(s,s.turnIndex===0?1:0,now);}
 delete s.deferredEnd;delete s.deferredRoundEnd;return{state:s,event:{type:'forfeit',playerKeys:keys,at:now}};
}
export function shiftTime(s,ms){if(!Number.isSafeInteger(ms)||ms<0)fail('INVALID_PAUSE','Invalid pause',400);for(const k of ['startedAt','serverNow','deadlineAt','turnStartedAt','turnDeadlineAt','busyUntil'])if(typeof s[k]==='number')s[k]+=ms;return s;}
export function rank(s){const ps=active(s);return s.players.map(p=>({playerKey:p.key,rank:p.forfeited?null:s.outcome==='forfeit'?1:1+ps.filter(q=>q.remaining<p.remaining).length,score:p.remaining,forfeited:p.forfeited}));}
export function view(s,key){if(!s.players.some(p=>p.key===key))fail('NOT_A_PLAYER','Not in room',403);return{gameId:'darts',status:s.status,outcome:s.outcome,ruleVersion:s.ruleVersion,boardVersion:s.boardVersion,serverNow:s.serverNow,deadlineAt:s.deadlineAt,round:s.round,maxRounds:10,turnKey:s.turnKey,turnStartedAt:s.turnStartedAt,turnDeadlineAt:s.turnDeadlineAt,busyUntil:s.busyUntil,currentDarts:s.currentDarts.map(d=>({...d})),turnStartRemaining:s.turnStartRemaining,players:s.players.map(p=>({...p,turns:p.turns.map(t=>({...t,darts:t.darts.map(d=>({...d}))}))})),lastEvent:s.lastEvent?structuredClone(s.lastEvent):null,version:s.version,winnerKeys:[...s.winnerKeys],board:{rings:RINGS,segments:SEGMENTS},gestureVersion:'darts-gesture-v1'};}
export function botAction(s,key,now){if(s.status!=='active'||s.turnKey!==key||now<s.busyUntil||now-s.turnStartedAt<400)return null;const p=s.players.find(p=>p.key===key);if(!p||p.forfeited)return null;let x=0,y=-.62;if(p.remaining===50){x=0;y=0;}else if(p.remaining===25){x=.065;y=0;}else if(p.remaining<=20){const i=SEGMENTS.indexOf(p.remaining),a=i*Math.PI/10;x=Math.sin(a)*.35;y=-Math.cos(a)*.35;}else if(p.remaining<60){const candidates=SEGMENTS.filter(n=>n*2<=p.remaining);const n=candidates.at(-1)||1,a=SEGMENTS.indexOf(n)*Math.PI/10;x=Math.sin(a)*.965;y=-Math.cos(a)*.965;}
 // Vary reachable targets across turns; no hidden hit randomization or direct score assignment.
 if(p.remaining>60&&p.turns.length%3===1){x=.32;y=-.2;}return{type:'throw',gesture:gestureToward(x,y)};}
