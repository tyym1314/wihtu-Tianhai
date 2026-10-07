import {parentPort} from 'node:worker_threads';
import {engines} from './engines.mjs';
import {supportsRules} from './rule-support.mjs';
import {runRequiresSceneReady} from '../../arena/run/start-policy.mjs';

// Pure game computation only. No database, wallet, credentials or room locks
// are imported into this process; the caller owns admission and persistence.
export function executeEngineTask(job){
  const engine=engines[job.gameId];
  if(job.kind==='prepare-bowling-roll'){
    if(job.gameId!=='bowling'||job.ruleVersion!==engine.RULE_VERSION||job.physicsVersion!==engine.PHYSICS_VERSION){const e=new Error('Pinned game rules unavailable');e.code='PINNED_RULE_UNAVAILABLE';e.status=503;throw e;}
    return engine.prepareRoll(job.standing,job.action);
  }
  if(!supportsRules(engine,job.ruleVersion)||job.state?.ruleVersion!==job.ruleVersion){const e=new Error('Pinned game rules unavailable');e.code='PINNED_RULE_UNAVAILABLE';e.status=503;throw e;}
  const state=job.state,now=job.now;
  if(job.kind==='act')return engine.act(state,job.playerKey,job.action,now);
  if(job.kind==='act-prepared'&&job.gameId==='bowling')return engine.actPrepared(state,job.playerKey,job.action,now,job.prepared);
  if(job.kind!=='advance'){const e=new Error('Unknown engine task');e.code='INVALID_ENGINE_TASK';e.status=400;throw e;}
  if(job.forfeits?.length)engine.forfeit(state,job.forfeits,now);
  engine.tick(state,now);
  const botUpdates=[];
  for(const bot of job.bots||[]){
    if(state.status!=='active'||state.phase==='fault'||state.fault)break;
    const botPeriod=job.gameId==='run'&&(job.ruleVersion==='pvp-run-v2.0.0'||runRequiresSceneReady(job.ruleVersion))?100:1200;
    if(now-(bot.lastBotAt||0)<botPeriod)continue;
    const action=engine.botAction?.(state,bot.key,now);
    if(action){const response=engine.act(state,bot.key,action,now);botUpdates.push({key:bot.key,lastEvent:response.event||null,lastBotAt:now});}
  }
  engine.tick(state,now);return{state,botUpdates};
}

if(parentPort)parentPort.on('message',({id,job})=>{
  try{parentPort.postMessage({id,result:executeEngineTask(job)});}
  catch(e){parentPort.postMessage({id,error:{code:e.code||'ENGINE_COMPUTATION_FAILED',status:e.status||500,message:String(e.message||'Game computation failed').slice(0,256)}});}
});
