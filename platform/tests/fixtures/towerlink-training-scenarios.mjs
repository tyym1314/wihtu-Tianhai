import assert from 'node:assert/strict';
import * as engine from '../../arena/towerlink/engine.mjs';
import {TRAINING_LESSONS} from '../../arena/towerlink/training.mjs';
const seed='01'.repeat(16);
export const make=(number,options={})=>{const lesson=TRAINING_LESSONS[number-1];return engine.createState(seed,1000,{players:Array.from({length:lesson.playerCount},(_,seatIndex)=>({key:'p'+seatIndex,seatIndex,isBot:seatIndex>0})),trainingLessonId:lesson.id,...options});};
export const schedules={
  1:[[0,'link',0,1]],2:[[0,'link',0,1],[8000,'stop',0]],3:[[0,'link',0,1],[250,'link',1,4]],4:[[0,'link',1,6],[250,'link',0,6]],5:[[0,'upgrade',0]],6:[[0,'link',0,2],[4000,'unlink',0,2],[4250,'link',0,1]],7:[[0,'upgrade',0],[500,'link',1,6],[1000,'link',2,6],[1500,'upgrade',1],[2000,'upgrade',2],[3000,'link',0,1],[3500,'link',0,2]],8:[[0,'upgrade',8],[250,'link',0,8],[3000,'link',8,12]],9:[[0,'upgrade',8],[4000,'link',8,1]],10:[[0,'link',0,1]],11:[],
};
// A real player strategy: invest in production/dispatch upgrades, concentrate
// each tower on one weak adjacent target, and relay rear troops toward a front.
// Decisions use only the public snapshot and its advertised legal commands.
export function learnerAction(state,now){
  const key='p0',v=engine.view(state,key);if(now<v.busyUntil)return null;
  const actions=v.legalActions,owned=v.towers.filter(t=>v.owners[t.id]===key),candidates=[],distance=new Map(),queue=[];
  for(const t of v.towers)if(v.owners[t.id]!==key){distance.set(t.id,0);queue.push(t.id);}
  for(const id of queue)for(const n of v.towers[id].neighbors)if(!distance.has(n)){distance.set(n,distance.get(id)+1);queue.push(n);}
  for(const t of owned){
    const upgrade=actions.find(a=>a.type==='upgrade'&&a.towerId===t.id);if(upgrade)candidates.push({action:upgrade,value:100-t.level});
    const cost=target=>(v.owners[target.id]===null?0:v.owners[target.id]===key?150:40)+target.troops;
    const targets=t.neighbors.map(id=>v.towers[id]).filter(target=>v.owners[target.id]!==key||distance.get(target.id)<distance.get(t.id)).sort((a,b)=>cost(a)-cost(b)||a.id-b.id),best=targets[0];if(!best)continue;
    const routes=v.orders.filter(route=>route.from===t.id);
    for(const route of routes)if(route.to!==best.id)candidates.push({action:{type:'unlink',from:t.id,to:route.to},value:70});
    if(!routes.some(route=>route.to===best.id)&&routes.length<t.routeLimit)candidates.push({action:{type:'link',from:t.id,to:best.id},value:60});
  }
  const action=candidates.sort((a,b)=>b.value-a.value)[0]?.action??null;
  if(action)assert.ok(actions.some(legal=>JSON.stringify(legal)===JSON.stringify(action)),'the test learner cannot bypass public legal actions');
  return action;
}
export function play(number,{bots=true,idle=false,trace=[],scheduleOverride=null,minHumanGapMs=500}={}){
  const state=make(number);let index=0,lastHuman=-Infinity;const act=(key,action,now)=>{engine.act(state,key,action,now);trace.push({atMs:now-state.startedAt,player:key,action});if(key==='p0')lastHuman=now;};
  for(let now=1000;now<=state.deadlineAt&&state.status==='active';now+=125){
    engine.tick(state,now);if(state.status!=='active')break;
    if(!idle&&now-lastHuman>=minHumanGapMs){if(number===12||number===11){
      if(now%250===0){const action=learnerAction(state,now);if(action)act('p0',action,now);}
    }else{
      const scheduled=(scheduleOverride||schedules[number])[index];
      if(scheduled&&now>=state.startedAt+scheduled[0]){act('p0',['link','unlink'].includes(scheduled[1])?{type:scheduled[1],from:scheduled[2],to:scheduled[3]}:{type:scheduled[1],towerId:scheduled[2]},now);index++;}
      else if(number===9&&now%250===0&&state.owners[1]==='p0'){const v=engine.view(state,'p0'),action=v.legalActions.find(a=>a.type==='upgrade'&&a.towerId===1)||v.legalActions.find(a=>a.type==='link'&&a.from===1&&a.to===0);if(action)act('p0',action,now);}
    }
    }
    if(bots&&state.status==='active')for(const key of Object.keys(state.players).filter(key=>key!=='p0')){const action=engine.botAction(state,key,now);if(action)act(key,action,now);}
  }
  return state;
}

