import * as legacy from './engine-v2.1.mjs';
import {createBoard as createLegacyBoard} from './levels-v2.1.mjs';
import {randomInt} from '../boardkit/engine-utils.mjs';
import {LEVELS,createBoard,createTrainingBoard} from './levels.mjs';
import {getTrainingLesson,makeTraining,observeTraining,updateTraining,publicTraining,trainingBotProfile} from './training.mjs';

// Persisted v1 rooms must use the coordinator's unavailable-pinned-rule void
// flow. Their instant-claim points cannot be reinterpreted as RTS armies.
export const RULE_VERSION='towerlink-v2.2.0';
export const supportsRuleVersion=version=>version===RULE_VERSION||version===legacy.RULE_VERSION;
export const RULES=Object.freeze({durationMs:180000,stepMs:125,dispatchMs:1000,reserve:5,actionMs:150,maxEvents:48,maxPauseMs:60000,maxTowers:13});
const clone=value=>structuredClone(value);
const roster=state=>Object.values(state.players).sort((a,b)=>a.seatIndex-b.seatIndex);
function fail(code,message=code,status=409){const error=new Error(message);error.code=code;error.status=status;throw error;}
function timestamp(now){if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-RULES.durationMs-60000)fail('INVALID_TIME','Invalid server timestamp',400);}
function clock(state,now){timestamp(now);if(now<state.serverNow)fail('CLOCK_REWIND','Server time cannot move backwards');}
function rules(state){if(state?.ruleVersion!==RULE_VERSION)fail('PINNED_RULE_UNAVAILABLE','Pinned Tower Link rules unavailable',503);}
function player(state,key){if(typeof key!=='string'||!Object.hasOwn(state.players,key))fail('NOT_A_PLAYER','Player is not in this room',403);return state.players[key];}
function parsePlayers(input){
  if(!Array.isArray(input)||![2,3,4].includes(input.length))fail('INVALID_PLAYERS','Tower Link supports 2–4 unique players',400);
  const seen=new Set(),seats=new Set();
  return input.map((value,i)=>{
    const p=typeof value==='string'?{key:value}:value,key=p?.key,seatIndex=p?.seatIndex??i;
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(key)||['__proto__','constructor','prototype'].includes(key)||seen.has(key)||!Number.isInteger(seatIndex)||seatIndex<0||seatIndex>=input.length||seats.has(seatIndex))fail('INVALID_PLAYERS','Players and seats must be unique and valid',400);
    seen.add(key);seats.add(seatIndex);
    return{key,seatIndex,name:typeof p.name==='string'?p.name.slice(0,64):key,isBot:Boolean(p.isBot),score:1,towers:1,totalTroops:30,forfeited:false,eliminated:false,busyUntil:0,lastEventId:null};
  }).sort((a,b)=>a.seatIndex-b.seatIndex);
}
const stats=t=>t.kind==='citadel'?{rate:2,cap:60}:{rate:t.level,cap:20+t.level*20};
const dispatchStats=t=>({rate:t.kind==='citadel'?2:t.level,routeLimit:t.kind==='citadel'?2:t.level});
// The first route retains the v2 fixture/debugging shape. Public snapshots expose
// only the flat route list; dispatch state lives on the tower, not the routes.
const routesOf=order=>order?(order.routes??[order]):[];
function setRoutes(state,id,routes){state.orders[id]=routes.length?{...routes[0],routes}:null;}
// Neutral ownership is the null value, never the valid player ID "null".
// Check the typed identity before any object-key coercion or prototype lookup.
const ownerPlayer=(state,ownerKey)=>ownerKey!==null&&typeof ownerKey==='string'&&Object.hasOwn(state.players,ownerKey)?state.players[ownerKey]:null;
function refresh(state){
  for(const p of roster(state)){p.towers=0;p.totalTroops=0;}
  for(const t of state.towers){const p=ownerPlayer(state,state.owners[t.id]);if(p){p.towers++;p.totalTroops+=t.troops;}}
  for(const a of state.armies){const p=ownerPlayer(state,a.ownerKey);if(p)p.totalTroops+=a.count;}
  for(const p of roster(state)){p.score=p.towers;p.eliminated=!p.forfeited&&p.towers===0&&p.totalTroops===0;}
}
function record(state,type,at,details={}){
  const event={id:`towerlink:${++state.eventSequence}`,type,at,...details};observeTraining(state,event);state.lastEvent=clone(event);state.events.push(clone(event));
  if(state.events.length>RULES.maxEvents)state.events.splice(0,state.events.length-RULES.maxEvents);return event;
}
const stronger=(a,b)=>a.towers>b.towers||(a.towers===b.towers&&a.totalTroops>b.totalTroops);
function finish(state,at,reason){
  if(state.status!=='active')return;
  refresh(state);state.status='finished';state.finishedAt=at;state.finishReason=reason;
  const remaining=roster(state).filter(p=>!p.forfeited),best=remaining.reduce((best,p)=>!best||stronger(p,best)?p:best,null);
  state.outcome=!remaining.length||reason==='all-eliminated'?'void':reason==='last-player'?'forfeit':'completed';
  state.winnerKeys=state.outcome==='void'?[]:remaining.filter(p=>!stronger(best,p)).map(p=>p.key);
  if(state.training){
    observeTraining(state,{type:'finish',at,reason,winnerKeys:state.winnerKeys});updateTraining(state,at);
    if(state.outcome!=='void')state.winnerKeys=state.training.completed?[state.training.learnerKey]:remaining.filter(p=>p.key!==state.training.learnerKey).map(p=>p.key);
  }
  state.version++;record(state,'finish',at,{reason,winnerKeys:[...state.winnerKeys],outcome:state.outcome});
}
function endIfNeeded(state,at){
  refresh(state);updateTraining(state,at);
  if(state.training?.completed){finish(state,at,'training-complete');return;}
  if(state.training?.failed){finish(state,at,'training-failed');return;}
  const remaining=roster(state).filter(p=>!p.forfeited),alive=remaining.filter(p=>!p.eliminated);
  if(!remaining.length)finish(state,at,'all-forfeited');
  else if(remaining.length===1)finish(state,at,'last-player');
  else if(!alive.length)finish(state,at,'all-eliminated');
  else if(alive.length===1&&state.training?.lessonId!=='lesson-11')finish(state,at,'conquest');
  else if(at>=state.deadlineAt)finish(state,state.deadlineAt,'deadline');
}
export function createState(seedHex,now,options={}){
  if(options.ruleVersion===legacy.RULE_VERSION)return legacy.createState(seedHex,now,options);
  if(options.ruleVersion!==undefined&&options.ruleVersion!==RULE_VERSION)fail('PINNED_RULE_UNAVAILABLE','Pinned Tower Link rules unavailable',503);
  const {players:input=[],startAt=now,trainingLessonId=null}=options;
  timestamp(now);timestamp(startAt);if(startAt<now||startAt-now>60000)fail('INVALID_TIME','Start must be within the next 60 seconds',400);
  if(typeof seedHex!=='string'||!/^(?:[0-9a-f]{2}){16,64}$/i.test(seedHex))fail('INVALID_SEED','Expected 16–64 bytes of server entropy',400);
  const seed=seedHex.toLowerCase(),ps=parsePlayers(input),lesson=trainingLessonId===null?null:getTrainingLesson(trainingLessonId);
  if(trainingLessonId!==null&&!lesson)fail('INVALID_TRAINING_LESSON','Unknown training lesson',400);
  if(lesson&&(ps.length!==lesson.playerCount||ps.filter(p=>!p.isBot).length!==1||ps.find(p=>!p.isBot)?.seatIndex!==0))fail('INVALID_TRAINING_PLAYERS','Training requires one learner and the specified AI seats',400);
  const map=lesson?(lesson.number!==12?createTrainingBoard(lesson):createLegacyBoard(ps.length,randomInt(seed,legacy.RULE_VERSION+':map',0,2))):createBoard(ps.length,randomInt(seed,RULE_VERSION+':map',0,2));
  const owners=Array(map.towers.length).fill(null);ps.forEach(p=>{owners[map.starts[p.seatIndex]]=p.key;p.busyUntil=startAt;});
  const towers=map.towers.map(t=>({...t,troops:owners[t.id]!==null?30:t.core?20:10,level:1,upgrade:null,productionCredit:0,productionAt:startAt,dispatchCursor:0}));
  const state={gameId:'towerlink',ruleVersion:RULE_VERSION,seed,status:'active',outcome:null,startedAt:startAt,serverNow:now,simulationAt:startAt,deadlineAt:startAt+(lesson?.durationMs??RULES.durationMs),version:0,turn:0,eventSequence:0,armySequence:0,level:map.level,board:map.board,towers,edges:map.edges,roads:map.roads,owners,players:Object.fromEntries(ps.map(p=>[p.key,p])),orders:Array(towers.length).fill(null),armies:[],events:[],lastEvent:null,winnerKeys:[]};
  if(lesson)configureTraining(state,lesson);
  return state;
}

function configureTraining(state,lesson){
  const people=roster(state),human=people.find(p=>!p.isBot).key,bots=people.filter(p=>p.isBot).map(p=>p.key),enemy=bots[0],n=lesson.number;
  const home=state.towers.find(t=>state.owners[t.id]===human).id,targets={home},markers=[];
  const own=(id,key,count)=>{state.owners[id]=key;if(count!==undefined)state.towers[id].troops=count;};
  if(n<=7){
    state.owners.fill(null);for(const t of state.towers)t.troops=10;
    own(0,human,30);own([4,7].includes(n)?5:3,enemy,30);targets.home=0;
  }
  if(n===1||n===2){targets.target=1;markers.push({towerId:1,label:'目标中立塔'});}
  if(n===3){own(1,human,5);targets.front=1;targets.target=4;markers.push({towerId:0,label:'后方'},{towerId:1,label:'前线'},{towerId:4,label:'目标塔'});}
  if(n===4){own(1,human,40);own(6,enemy,12);targets.front=1;targets.target=6;state.orders[6]={from:6,to:1,ownerKey:enemy,since:state.startedAt-1};markers.push({towerId:1,label:'左翼'},{towerId:6,label:'敌方前哨'});}
  if(n===5)markers.push({towerId:0,label:'升级这座兵营'});
  if(n===6){own(1,human,5);own(4,enemy,22);state.towers[4].level=2;state.orders[4]={from:4,to:1,ownerKey:enemy,since:state.startedAt-1};targets.attack=2;targets.defend=1;markers.push({towerId:2,label:'先派兵'},{towerId:1,label:'再增援'});}
  if(n===7){own(1,human,25);own(2,human,25);own(6,enemy,20);targets.left=1;targets.right=2;targets.target=6;state.towers[5].level=2;state.orders[5]={from:5,to:6,ownerKey:enemy,since:state.startedAt-1};state.orders[6]={from:6,to:1,ownerKey:enemy,since:state.startedAt-1};markers.push({towerId:0,label:'后方升级'},{towerId:1,label:'左翼'},{towerId:2,label:'右翼'},{towerId:6,label:'合围目标'});}
  if(n===8){own(8,human,30);own(10,enemy,30);state.orders[10]={from:10,to:12,ownerKey:enemy,since:state.startedAt-1};targets.target=12;markers.push({towerId:8,label:'己方桥头'},{towerId:10,label:'敌方桥头'},{towerId:12,label:'补给并守住 12 秒'});}
  if(n===9){own(0,enemy,12);own(8,human,40);state.towers[8].level=2;state.orders[0]={from:0,to:1,ownerKey:enemy,since:state.startedAt-1};targets.home=0;targets.reserve=8;targets.bridge=1;markers.push({towerId:8,label:'保住预备兵营'},{towerId:1,label:'先夺中继站'},{towerId:0,label:'夺回并守住 10 秒'});}
  if(n===10){
    state.towers[12].troops=0;targets.coalition=12;targets.target=1;
    for(const [index,key]of [human,...bots].entries()){
      const id=9+index,count=[5,4,2][index];own(id,key,20-count);
      const travelMs=road(state,id,12).travelMs;state.armies.push({id:`army:${++state.armySequence}`,ownerKey:key,from:id,to:12,count,departedAt:state.startedAt,arrivesAt:state.startedAt+travelMs});
    }
    markers.push({towerId:12,label:'5／4／2 同刻抵消'},{towerId:1,label:'亲自占领此塔'});
  }
  if(n===11){targets.reserve=8;own(0,human,40);own(8,human,40);own(4,enemy,30);own(10,enemy,30);own(11,enemy,30);markers.push({towerId:0,label:'守住补给基地 A'},{towerId:8,label:'守住补给基地 B'},{towerId:12,label:'可争夺的中立要塞'});}
  state.training=makeTraining(lesson,human,targets,markers);refresh(state);
}

function road(state,from,to){return state.roads.find(r=>r.from===Math.min(from,to)&&r.to===Math.max(from,to));}
// Simultaneous coalition cancellation is deliberately independent of player
// seat, packet insertion order and network action arrival ordering.
function survivor(groups){
  let total=0;for(const count of groups.values())total+=count;
  for(const [ownerKey,count]of groups)if(count>total-count)return{ownerKey,count:count-(total-count)};
  return{ownerKey:null,count:0};
}
function roadBattles(state,previousAt,at){
  const byRoad=new Map();
  for(const a of state.armies){const key=`${Math.min(a.from,a.to)}:${Math.max(a.from,a.to)}`;if(!byRoad.has(key))byRoad.set(key,[]);byRoad.get(key).push(a);}
  for(const [edge,packets]of byRoad){
    const encounters=new Map();
    for(let i=0;i<packets.length;i++)for(let j=i+1;j<packets.length;j++){
      const a=packets[i],b=packets[j];if(a.ownerKey===b.ownerKey||a.from!==b.to||a.to!==b.from)continue;
      const duration=a.arrivesAt-a.departedAt,meetingAt=(a.departedAt+b.departedAt+duration)/2;
      if(meetingAt<=previousAt||meetingAt>at||meetingAt<Math.max(a.departedAt,b.departedAt)||meetingAt>Math.min(a.arrivesAt,b.arrivesAt))continue;
      const position=a.from<a.to?(meetingAt-a.departedAt)/duration:1-(meetingAt-a.departedAt)/duration,key=`${meetingAt}:${position.toFixed(8)}`;
      encounters.set(key,{at:meetingAt,position,duration});
    }
    for(const meeting of [...encounters.values()].sort((a,b)=>a.at-b.at||a.position-b.position)){
      const contact=packets.filter(a=>a.count>0&&a.departedAt<=meeting.at&&a.arrivesAt>=meeting.at&&Math.abs((a.from<a.to?(meeting.at-a.departedAt)/meeting.duration:1-(meeting.at-a.departedAt)/meeting.duration)-meeting.position)<1e-7);
      const groups=new Map();for(const a of contact)groups.set(a.ownerKey,(groups.get(a.ownerKey)||0)+a.count);if(groups.size<2)continue;
      const result=survivor(groups),before=contact.reduce((sum,a)=>sum+a.count,0),winners=contact.filter(a=>a.ownerKey===result.ownerKey),winningTotal=groups.get(result.ownerKey)||0;
      const allocations=winners.map(a=>({army:a,exact:result.count*a.count/winningTotal}));
      let assigned=0;for(const allocation of allocations){allocation.count=Math.floor(allocation.exact);assigned+=allocation.count;}
      allocations.sort((a,b)=>(b.exact-b.count)-(a.exact-a.count)||a.army.departedAt-b.army.departedAt||a.army.from-b.army.from||a.army.id.localeCompare(b.army.id));
      for(let i=0;i<result.count-assigned;i++)allocations[i].count++;
      for(const a of contact)a.count=0;for(const allocation of allocations)allocation.army.count=allocation.count;
      record(state,'road-battle',meeting.at,{edge:edge.split(':').map(Number),position:meeting.position,casualties:before-result.count,ownerKey:result.ownerKey,survivors:result.count,participants:[...groups].map(([ownerKey,count])=>({ownerKey,count}))});
    }
  }
  state.armies=state.armies.filter(a=>a.count>0);
}
function arrivals(state,at){
  const arriving=new Map();for(const a of state.armies)if(a.arrivesAt<=at){if(!arriving.has(a.to))arriving.set(a.to,[]);arriving.get(a.to).push(a);}
  state.armies=state.armies.filter(a=>a.arrivesAt>at);
  for(const [towerId,packets]of [...arriving].sort(([a],[b])=>a-b)){
    const tower=state.towers[towerId],oldOwner=state.owners[towerId],groups=new Map([[oldOwner,tower.troops]]);
    for(const a of packets)groups.set(a.ownerKey,(groups.get(a.ownerKey)||0)+a.count);
    const result=survivor(groups),total=[...groups.values()].reduce((sum,n)=>sum+n,0);
    tower.troops=result.count;
    if(result.count>0&&result.ownerKey!==oldOwner){
      state.owners[towerId]=result.ownerKey;state.orders[towerId]=null;tower.dispatchCursor=0;tower.upgrade=null;tower.productionCredit=0;tower.productionAt=at;
      record(state,'capture',at,{towerId,previousOwner:oldOwner,ownerKey:result.ownerKey,troops:tower.troops,level:tower.level});
    }
    record(state,'arrival',at,{towerId,previousOwner:oldOwner,ownerKey:state.owners[towerId],troops:tower.troops,arrived:packets.map(a=>({ownerKey:a.ownerKey,from:a.from,count:a.count})),casualties:total-result.count,participants:[...groups].map(([ownerKey,count])=>({ownerKey,count}))});
  }
}
function completeUpgrade(state,tower){
  const upgrade=tower.upgrade;tower.level=upgrade.toLevel;tower.upgrade=null;tower.productionCredit=0;tower.productionAt=upgrade.completesAt;
  record(state,'upgrade-complete',upgrade.completesAt,{towerId:tower.id,ownerKey:state.owners[tower.id],level:tower.level});
}
function step(state,at){
  const previousAt=state.simulationAt;
  // An upgrade finishing between ticks is already complete before an arrival
  // at this tick. On an exact tie, arrival combat precedes completion.
  for(const tower of state.towers)if(tower.upgrade&&tower.upgrade.completesAt<at)completeUpgrade(state,tower);
  roadBattles(state,previousAt,at);arrivals(state,at);
  for(const tower of state.towers){
    if(tower.upgrade&&at>=tower.upgrade.completesAt)completeUpgrade(state,tower);
    if(ownerPlayer(state,state.owners[tower.id])&&!tower.upgrade){
      const {rate,cap}=stats(tower),elapsed=Math.max(0,at-Math.max(previousAt,tower.productionAt));
      if(tower.troops>=cap)tower.productionCredit=0;
      else{tower.productionCredit+=elapsed*rate;const produced=Math.min(cap-tower.troops,Math.floor(tower.productionCredit/1000));tower.troops+=produced;if(produced>0)observeTraining(state,{type:'production',at,towerId:tower.id,ownerKey:state.owners[tower.id],level:tower.level,count:produced});tower.productionCredit-=produced*1000;if(tower.troops>=cap)tower.productionCredit=0;}
    }
    tower.productionAt=at;
  }
  // A shared one-second cadence never resets on route edits or upgrades. Idle
  // allowance is discarded: a tower sends only its current level's 1/2/3 units.
  if((at-state.startedAt)%RULES.dispatchMs===0)for(const tower of state.towers){
    const ownerKey=state.owners[tower.id],routes=routesOf(state.orders[tower.id]).filter(order=>order.since<at&&order.ownerKey===ownerKey);
    if(!routes.length||tower.upgrade||!ownerPlayer(state,ownerKey))continue;
    const count=Math.min(dispatchStats(tower).rate,Math.max(0,tower.troops-RULES.reserve));if(!count)continue;
    const eligible=new Set(routes.map(order=>order.to)),allocation=new Map(),neighbors=tower.neighbors;
    // Round robin every individual soldier, including the scarce one-soldier
    // case. Stable neighbor positions survive route insertion/removal, so even
    // repeated editing cannot restart the allowance or bias the integer remainder.
    for(let sent=0;sent<count;sent++){
      let cursor=(tower.dispatchCursor??0)%neighbors.length;
      while(!eligible.has(neighbors[cursor]))cursor=(cursor+1)%neighbors.length;
      const to=neighbors[cursor];allocation.set(to,(allocation.get(to)||0)+1);tower.dispatchCursor=(cursor+1)%neighbors.length;
    }
    tower.troops-=count;
    for(const [to,sent]of allocation){observeTraining(state,{type:'dispatch',at,ownerKey,from:tower.id,to,count:sent});state.armies.push({id:`army:${++state.armySequence}`,ownerKey,from:tower.id,to,count:sent,departedAt:at,arrivesAt:at+road(state,tower.id,to).travelMs});}
  }
  state.simulationAt=at;state.version++;endIfNeeded(state,at);
}
function advance(state,now){
  const target=Math.min(now,state.deadlineAt);
  while(state.status==='active'&&state.simulationAt+RULES.stepMs<=target&&state.simulationAt+RULES.stepMs<state.deadlineAt)step(state,state.simulationAt+RULES.stepMs);
  state.serverNow=now;
  if(state.status==='active'&&now>=state.deadlineAt)finish(state,state.deadlineAt,'deadline');
}
function checkActionShape(state,action){
  if(!action||typeof action!=='object'||Array.isArray(action))fail('INVALID_ACTION','Expected an action object',400);
  const routeAction=['link','unlink'].includes(action.type),fields=routeAction?['type','from','to']:['stop','upgrade'].includes(action.type)?['type','towerId']:null;
  if(!fields||Object.keys(action).length!==fields.length||fields.some(k=>!Object.hasOwn(action,k)))fail('INVALID_ACTION','Unexpected action fields',400);
  const ids=routeAction?[action.from,action.to]:[action.towerId];
  if(ids.some(id=>!Number.isInteger(id)||id<0||id>=state.towers.length))fail('INVALID_ACTION','Invalid tower index',400);
  if(routeAction&&!state.towers[action.from].neighbors.includes(action.to))fail('INVALID_LINK','Choose a directly connected tower',400);
}
function legal(state,key){
  if(state.status!=='active'||state.serverNow<state.startedAt||typeof key!=='string'||!Object.hasOwn(state.players,key)||state.players[key].forfeited||state.players[key].eliminated)return[];
  return state.towers.flatMap(t=>{
    if(state.owners[t.id]!==key)return[];
    const routes=routesOf(state.orders[t.id]),active=new Set(routes.map(order=>order.to));
    const actions=t.neighbors.flatMap(to=>active.has(to)?[{type:'unlink',from:t.id,to}]:routes.length<dispatchStats(t).routeLimit?[{type:'link',from:t.id,to}]:[]);
    if(state.orders[t.id])actions.push({type:'stop',towerId:t.id});
    if(t.kind==='barracks'&&t.level<3&&!t.upgrade&&t.troops>=(t.level===1?20:30)+RULES.reserve)actions.push({type:'upgrade',towerId:t.id});
    return actions;
  });
}
export function act(state,key,action,now){if(state?.ruleVersion===legacy.RULE_VERSION)return legacy.act(state,key,action,now);
  rules(state);clock(state,now);const p=player(state,key);
  if(p.forfeited||p.eliminated)fail('NOT_A_PLAYER','Player is no longer active',403);
  if(state.status!=='active')fail('NOT_ACTIVE','Game is complete');
  if(now<state.startedAt)fail('GAME_NOT_STARTED','Wait for the shared countdown');
  if(now>=state.deadlineAt)fail('DEADLINE_PASSED','Game deadline passed');
  checkActionShape(state,action);
  if(now<p.busyUntil)fail('BUSY','Commands are too frequent');
  // Advance on a copy: a rejected command must not mutate the persisted state,
  // even when travel/production would change its ownership before validation.
  const next=clone(state);advance(next,now);
  if(next.status!=='active')fail('NOT_ACTIVE','Game is complete');
  const id=['link','unlink'].includes(action.type)?action.from:action.towerId,tower=next.towers[id];
  if(next.owners[id]!==key)fail('NOT_YOUR_TOWER','Only owned towers can be commanded',403);
  let details;
  if(action.type==='link'){
    const routes=routesOf(next.orders[id]);
    if(!routes.some(order=>order.to===action.to)){
      if(routes.length>=dispatchStats(tower).routeLimit)fail('ROUTE_LIMIT_REACHED','Remove a route or upgrade this tower before adding another');
      setRoutes(next,id,[...routes,{from:id,to:action.to,ownerKey:key,since:now}]);
    }
    details={from:id,to:action.to};
  }else if(action.type==='unlink'){
    setRoutes(next,id,routesOf(next.orders[id]).filter(order=>order.to!==action.to));details={from:id,to:action.to};
  }else if(action.type==='stop'){
    next.orders[id]=null;details={towerId:id};
  }else{
    if(tower.kind!=='barracks')fail('NOT_UPGRADABLE','The central citadel cannot be upgraded');
    if(tower.upgrade)fail('ALREADY_UPGRADING','This tower is already upgrading');
    if(tower.level>=3)fail('MAX_LEVEL','This tower has reached its maximum level');
    const cost=tower.level===1?20:30,durationMs=tower.level===1?3000:4000;
    if(tower.troops<cost+RULES.reserve)fail('INSUFFICIENT_TROOPS','Upgrading must leave at least 5 defenders');
    tower.troops-=cost;tower.productionCredit=0;tower.productionAt=now;tower.upgrade={fromLevel:tower.level,toLevel:tower.level+1,startedAt:now,completesAt:now+durationMs,cost};
    details={towerId:id,upgrade:clone(tower.upgrade),troops:tower.troops};
  }
  next.turn++;next.version++;next.players[key].busyUntil=now+RULES.actionMs;
  const event=record(next,action.type,now,{playerKey:key,...details,busyUntil:next.players[key].busyUntil});next.players[key].lastEventId=event.id;if(next.training&&next.players[key].isBot)next.training.botLastActionAt[key]=now;endIfNeeded(next,now);
  Object.assign(state,next);return{state,event:clone(event)};
}
export function tick(state,now){if(state?.ruleVersion===legacy.RULE_VERSION)return legacy.tick(state,now);rules(state);clock(state,now);advance(state,now);return{state};}
export function forfeit(state,keys,now){if(state?.ruleVersion===legacy.RULE_VERSION)return legacy.forfeit(state,keys,now);
  rules(state);clock(state,now);
  if(!Array.isArray(keys)||keys.length>roster(state).length||keys.some(key=>typeof key!=='string'||!Object.hasOwn(state.players,key)))fail('INVALID_PLAYERS','Unknown forfeiting player',400);
  if(state.status!=='active')return{state};
  advance(state,now);if(state.status!=='active')return{state};
  const changed=[...new Set(keys)].filter(key=>!state.players[key].forfeited);
  for(const key of changed){
    state.players[key].forfeited=true;
    for(const tower of state.towers)if(state.owners[tower.id]===key){state.owners[tower.id]=null;state.orders[tower.id]=null;tower.dispatchCursor=0;tower.upgrade=null;tower.productionCredit=0;tower.productionAt=now;}
  }
  state.armies=state.armies.filter(a=>!changed.includes(a.ownerKey));
  let event;if(changed.length){state.version++;event=record(state,'forfeit',now,{playerKeys:changed});}endIfNeeded(state,Math.min(now,state.deadlineAt));return{state,event:event?clone(event):undefined};
}
export function shiftTime(state,ms){if(state?.ruleVersion===legacy.RULE_VERSION)return legacy.shiftTime(state,ms);
  rules(state);if(!Number.isSafeInteger(ms)||ms<0||ms>RULES.maxPauseMs||state.deadlineAt+ms>Number.MAX_SAFE_INTEGER-60000)fail('INVALID_PAUSE','Recovery pause must be 0–60000 ms',400);
  if(state.status!=='active')return state;
  for(const field of ['startedAt','serverNow','simulationAt','deadlineAt'])state[field]+=ms;
  for(const p of roster(state))p.busyUntil+=ms;
  if(state.training){if(state.training.centerOwnedSince!==null)state.training.centerOwnedSince+=ms;if(state.training.homeOwnedSince!=null)state.training.homeOwnedSince+=ms;for(const key of Object.keys(state.training.botLastActionAt))state.training.botLastActionAt[key]+=ms;}
  for(const tower of state.towers){tower.productionAt+=ms;if(tower.upgrade){tower.upgrade.startedAt+=ms;tower.upgrade.completesAt+=ms;}}
  for(let id=0;id<state.orders.length;id++)if(state.orders[id])setRoutes(state,id,routesOf(state.orders[id]).map(order=>({...order,since:order.since+ms})));
  for(const army of state.armies){army.departedAt+=ms;army.arrivesAt+=ms;}
  for(const event of [...state.events,...(state.lastEvent?[state.lastEvent]:[])]){event.at+=ms;if(Number.isSafeInteger(event.busyUntil))event.busyUntil+=ms;if(event.upgrade){event.upgrade.startedAt+=ms;event.upgrade.completesAt+=ms;}}
  return state;
}
export function rank(state){if(state?.ruleVersion===legacy.RULE_VERSION)return legacy.rank(state);
  rules(state);refresh(state);const ps=roster(state).filter(p=>!p.forfeited);
  return roster(state).map(p=>({playerKey:p.key,rank:p.forfeited?null:state.training&&state.status==='finished'?(state.training.completed?(p.key===state.training.learnerKey?1:2):(p.key===state.training.learnerKey?2:1)):1+ps.filter(q=>stronger(q,p)).length,score:p.towers,towers:p.towers,totalTroops:p.totalTroops,forfeited:p.forfeited,eliminated:p.eliminated}));
}
export function view(state,key){if(state?.ruleVersion===legacy.RULE_VERSION)return legacy.view(state,key);
  rules(state);const p=player(state,key);refresh(state);
  const towers=state.towers.map(({productionCredit,productionAt,dispatchCursor,...t})=>({...t,productionRate:stats(t).rate,productionCap:stats(t).cap,dispatchRate:dispatchStats(t).rate,routeLimit:dispatchStats(t).routeLimit})),orders=state.orders.flatMap(routesOf);
  return clone({gameId:'towerlink',status:state.status,outcome:state.outcome,finishReason:state.finishReason??null,ruleVersion:state.ruleVersion,serverNow:state.serverNow,simulationAt:state.simulationAt,startedAt:state.startedAt,deadlineAt:state.deadlineAt,finishedAt:state.finishedAt??null,level:state.level,levels:LEVELS.filter(l=>l.playerCount===roster(state).length),board:state.board,owners:state.owners,towers,edges:state.edges,roads:state.roads,orders,armies:state.armies,links:orders.map(order=>({...order,playerKey:order.ownerKey,at:order.since})),players:roster(state),turn:state.turn,version:state.version,busyUntil:p.busyUntil,actionMs:RULES.actionMs,lastEvent:state.lastEvent,recentEvents:state.events,legalActions:legal(state,key),winnerKeys:state.winnerKeys,training:publicTraining(state),rules:{durationMs:state.deadlineAt-state.startedAt,reserve:RULES.reserve,dispatchIntervalMs:RULES.dispatchMs,dispatchByLevel:[1,2,3],routesByLevel:[1,2,3],citadelDispatchPerSecond:2,citadelRouteLimit:2,stepMs:RULES.stepMs}});
}
export function botAction(state,key,now){if(state?.ruleVersion===legacy.RULE_VERSION)return legacy.botAction(state,key,now);
  rules(state);clock(state,now);
  if(state.status!=='active'||now<state.startedAt||now>=state.deadlineAt||typeof key!=='string'||!Object.hasOwn(state.players,key)||state.players[key].forfeited||state.players[key].eliminated||now<state.players[key].busyUntil)return null;
  if(state.training){const profile=trainingBotProfile(state.training);if(now<state.startedAt+profile.startsAfterMs||now-(state.training.botLastActionAt[key]??state.startedAt)<profile.intervalMs)return null;}
  const actions=legal(state,key),owned=state.towers.filter(t=>state.owners[t.id]===key),hostileDistance=new Map();
  // A breadth-first distance on public roads supplies reinforcements toward a
  // front line. Bots receive no hidden resources or faster action clock.
  for(const t of state.towers)if(state.owners[t.id]!==key)hostileDistance.set(t.id,0);
  const queue=[...hostileDistance.keys()];for(const id of queue)for(const n of state.towers[id].neighbors)if(!hostileDistance.has(n)){hostileDistance.set(n,hostileDistance.get(id)+1);queue.push(n);}
  const candidates=[];
  for(const t of owned){
    const enemies=t.neighbors.filter(id=>state.owners[id]!==key).map(id=>state.towers[id]);
    const standing=routesOf(state.orders[t.id]);
    for(const order of standing)if(state.owners[order.to]===key&&(hostileDistance.get(order.to)??99)>=(hostileDistance.get(t.id)??99))candidates.push({action:{type:'unlink',from:t.id,to:order.to},value:55});
    const upgrade=actions.find(a=>a.type==='upgrade'&&a.towerId===t.id);
    if(upgrade&&((owned.length>=2&&!enemies.length)||t.troops>=(t.level===1?35:45)))candidates.push({action:upgrade,value:90-t.level*10});
    const links=actions.filter(a=>a.type==='link'&&a.from===t.id);
    for(const action of links){
      const target=state.towers[action.to];let value;
      if(state.owners[target.id]!==key)value=60-target.troops*.7+(target.core?8:0)+(state.owners[target.id]===null?8:0);
      else if((hostileDistance.get(target.id)??99)<(hostileDistance.get(t.id)??99))value=30+(t.troops-RULES.reserve)*.2;
      else continue;
      // Add additional useful fronts, but prefer upgrading or a fresh tower to
      // splitting an already useful stream into many weak packets.
      value-=standing.length*12;
      candidates.push({action,value});
    }
  }
  candidates.sort((a,b)=>b.value-a.value||(a.action.from??a.action.towerId)-(b.action.from??b.action.towerId)||(a.action.to??-1)-(b.action.to??-1));
  return candidates[0]?.value>0?candidates[0].action:null;
}
