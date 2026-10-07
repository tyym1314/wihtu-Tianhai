import * as Engine from '../../arena/run/engine.mjs';
import {RUN_COURSES_V21} from '../../arena/run/courses.mjs';

export const runFixtureTime=(state,tick)=>state.startedAt+Math.ceil(tick*1000/60);

/** Reach the real 180m boost pickup with normal, engine-admitted BOT advice.
 * The human's inventory, progress, timers and private history are never set by
 * the fixture. The returned state remains owned by the caller's real engine. */
export function createRunHeldBoostFixture({courseIndex=0,startedAt=1000,playerKey='human',botKey='bot'}={}){
 if(!Number.isSafeInteger(courseIndex)||courseIndex<0||courseIndex>=RUN_COURSES_V21.length)throw new Error('Unknown fixture course');
 const seed=courseIndex.toString(16).padStart(8,'0').padEnd(64,'0');
 const state=Engine.createState(seed,startedAt,{ruleVersion:Engine.PRACTICE_RULE_VERSION,startPolicy:Engine.RUN_SCENE_READY_POLICY,players:[{key:playerKey,seatIndex:0},{key:botKey,seatIndex:1,isBot:true}]});
 Engine.armStart(state,startedAt);
 const acceptedActions=[];let previousPublication=Engine.view(state,playerKey);
 for(let tick=0;tick<=6000&&state.status==='active';tick++){
  Engine.tick(state,runFixtureTime(state,tick));
  const player=state.players.find(player=>player.key===playerKey);
  if(player.inventory==='boost'&&player.pendingInput===null&&player.fallUntilTick===null&&state.tick>=player.stunUntilTick){
   return {state,game:Engine.view(state,playerKey),previousPublication,acceptedActions,playerKey,seed};
  }
  for(const runner of state.players){
   const action=Engine.botAction(state,runner.key,state.now);
   if(action){const accepted=Engine.act(state,runner.key,action,state.now);acceptedActions.push({...accepted.event,item:runner.pendingInput.item});}
  }
  if(tick%15===0)previousPublication=Engine.view(state,playerKey);
 }
 throw new Error('Legal fixture did not reach a held boost');
}
