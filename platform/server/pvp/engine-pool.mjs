import {Worker} from 'node:worker_threads';
import {availableParallelism} from 'node:os';
import {performance} from 'node:perf_hooks';
import {executeEngineTask} from './engine-worker.mjs';

const heavyGames=new Set(['bowling','pool','carrom','golf']);
function unavailable(code){const e=new Error(code);e.code=code;e.status=503;e.engineUnavailable=true;return e;}
function positive(value,fallback,max){const n=Number(value??fallback);if(!Number.isInteger(n)||n<1||n>max)throw new Error('Invalid engine pool configuration');return n;}

export function createEnginePool(options={}){
  const size=positive(options.size,Math.min(4,Math.max(1,availableParallelism()-1)),32);
  const maxQueue=positive(options.maxQueue,32,1000),queueTimeoutMs=positive(options.queueTimeoutMs,1500,30000),taskTimeoutMs=positive(options.taskTimeoutMs,5000,60000);
  const workerUrl=options.workerUrl||new URL('./engine-worker.mjs',import.meta.url);
  const slots=new Set(),queue=[],metrics={submitted:0,completed:0,failed:0,rejected:0,timeouts:0,restarts:0,maxQueued:0,maxRunning:0,totalQueueMs:0,totalComputeMs:0};
  let sequence=0,closing=false,closePromise;
  function finish(slot,error,result){
    const task=slot.task;if(!task)return;slot.task=null;clearTimeout(task.timer);
    metrics.totalComputeMs+=performance.now()-task.started;
    if(error){metrics.failed++;task.reject(error);}else{metrics.completed++;task.resolve(result);}
    slot.worker.unref();drain();
  }
  function retire(slot,error){
    if(slot.dead)return;slot.dead=true;slots.delete(slot);
    // Do not schedule another task on a worker with unknown liveness.
    if(slot.task){const task=slot.task;slot.task=null;clearTimeout(task.timer);metrics.failed++;metrics.totalComputeMs+=performance.now()-task.started;task.reject(error);}
    slot.worker.terminate().catch(()=>{});metrics.restarts++;drain();
  }
  function spawnSlot(){
    const worker=new Worker(workerUrl,{execArgv:[]}),slot={worker,task:null,dead:false};slots.add(slot);worker.unref();
    worker.on('message',message=>{
      if(slot.dead||!slot.task)return;
      if(message.id!==slot.task.id){retire(slot,unavailable('ENGINE_WORKER_PROTOCOL'));return;}
      const error=message.error?Object.assign(new Error(message.error.message),{code:message.error.code,status:message.error.status}):null;
      finish(slot,error,message.result);
    });
    worker.on('error',()=>retire(slot,unavailable('ENGINE_WORKER_LOST')));
    worker.on('exit',()=>{if(!slot.dead){slot.dead=true;slots.delete(slot);if(slot.task){const task=slot.task;clearTimeout(task.timer);slot.task=null;metrics.failed++;task.reject(unavailable('ENGINE_WORKER_LOST'));}if(!closing){metrics.restarts++;drain();}}});
    return slot;
  }
  function start(slot,task){
    clearTimeout(task.timer);task.started=performance.now();metrics.totalQueueMs+=task.started-task.queued;slot.task=task;slot.worker.ref();
    metrics.maxRunning=Math.max(metrics.maxRunning,[...slots].filter(s=>s.task).length);
    task.timer=setTimeout(()=>{metrics.timeouts++;retire(slot,unavailable('ENGINE_TASK_TIMEOUT'));},taskTimeoutMs);
    try{slot.worker.postMessage({id:task.id,job:task.job});}catch{retire(slot,unavailable('ENGINE_WORKER_PROTOCOL'));}
  }
  function drain(){
    if(closing)return;
    while(queue.length){let slot=[...slots].find(s=>!s.task&&!s.dead);if(!slot&&slots.size<size)slot=spawnSlot();if(!slot)return;start(slot,queue.shift());}
  }
  function run(job){
    if(closing){metrics.rejected++;return Promise.reject(unavailable('ENGINE_POOL_CLOSED'));}
    // Bound waiting work independently of the fixed number of running tasks.
    if(queue.length>=maxQueue&&![...slots].some(s=>!s.task)&&slots.size>=size){metrics.rejected++;return Promise.reject(unavailable('ENGINE_QUEUE_FULL'));}
    metrics.submitted++;
    return new Promise((resolve,reject)=>{
      const task={id:++sequence,job,resolve,reject,queued:performance.now(),timer:null};
      task.timer=setTimeout(()=>{const i=queue.indexOf(task);if(i<0)return;queue.splice(i,1);metrics.timeouts++;metrics.failed++;reject(unavailable('ENGINE_QUEUE_TIMEOUT'));},queueTimeoutMs);
      queue.push(task);metrics.maxQueued=Math.max(metrics.maxQueued,queue.length);drain();
    });
  }
  function stats(){return{size,maxQueue,queueTimeoutMs,taskTimeoutMs,workers:slots.size,running:[...slots].filter(s=>s.task).length,queued:queue.length,closing,...metrics};}
  function close(){
    if(closePromise)return closePromise;closing=true;
    for(const task of queue.splice(0)){clearTimeout(task.timer);metrics.failed++;task.reject(unavailable('ENGINE_POOL_CLOSED'));}
    closePromise=Promise.all([...slots].map(async slot=>{if(slot.task){clearTimeout(slot.task.timer);metrics.failed++;slot.task.reject(unavailable('ENGINE_POOL_CLOSED'));slot.task=null;}slot.dead=true;await slot.worker.terminate();slots.delete(slot);}));return closePromise;
  }
  return{run,stats,close};
}

// This shortcut is pinned to the verified Bowling pending-result contract.
// An unknown/malformed state keeps the conservative worker path. Never tick
// speculatively here: the shared executor still owns both ticks and forfeits.
function bowlingBotStillBusy(job,bot){
  const state=job.state;
  if(job.kind!=='advance'||job.gameId!=='bowling'||job.ruleVersion!=='pvp-bowling-v1.1.0'||state?.ruleVersion!==job.ruleVersion||state.physicsVersion!=='bowling-rigid-v1.1.0'||state.gameId!=='bowling'||state.status!=='active'||state.phase!=='playing'||state.fault||!Number.isSafeInteger(job.now)||!Number.isSafeInteger(state.serverNow)||job.now<state.serverNow||!Array.isArray(state.players))return false;
  const matches=state.players.filter(p=>p?.key===bot.key),p=matches[0];
  if(matches.length!==1||p.completed!==false||p.forfeited!==false||p.isBot!==true||!Number.isSafeInteger(p.busyUntil)||job.now>=p.busyUntil||!Number.isSafeInteger(p.shotStartedAt)||p.busyUntil<=p.shotStartedAt)return false;
  const pending=p.pending;
  if(!pending||typeof pending!=='object'||Array.isArray(pending)||!Array.isArray(pending.down)||!Array.isArray(pending.remaining)||typeof pending.gutter!=='boolean'||!Array.isArray(p.standing)||p.standing.length<1||p.standing.length>10)return false;
  const pins=[...pending.down,...pending.remaining];
  return pins.length===p.standing.length&&new Set(p.standing).size===p.standing.length&&new Set(pins).size===pins.length&&pins.every(id=>Number.isInteger(id)&&id>=1&&id<=10&&p.standing.includes(id));
}

let singleton;
function sharedPool(){return singleton??=createEnginePool({size:process.env.OASIS_ENGINE_WORKERS,maxQueue:process.env.OASIS_ENGINE_QUEUE,queueTimeoutMs:process.env.OASIS_ENGINE_QUEUE_TIMEOUT_MS,taskTimeoutMs:process.env.OASIS_ENGINE_TASK_TIMEOUT_MS});}
export async function runEngineTask(job){
  // tick/forfeit only resolve already computed physical results. Avoid copying
  // every trajectory through a worker merely to advance a clock. A due BOT
  // can produce a new physical shot, so that complete batch stays off-thread.
  const maySimulate=job.kind==='act'||job.kind==='prepare-bowling-roll'||job.bots?.some(bot=>job.now-(bot.lastBotAt||0)>=1200&&!bowlingBotStillBusy(job,bot));
  if(heavyGames.has(job.gameId)&&maySimulate)return sharedPool().run(job);
  return executeEngineTask({...job,state:structuredClone(job.state)});
}
let bowlingPreparationStats=()=>({initialized:false});
export function registerBowlingPreparationStats(reader){bowlingPreparationStats=reader;}
export const enginePoolStats=()=>({...singleton?.stats()||{workers:0,running:0,queued:0,initialized:false},bowlingPreparation:bowlingPreparationStats()});
export const closeEnginePool=()=>singleton?.close()||Promise.resolve();
