/** Test-process instrumentation; never imported by the deployed application. */
import {Server} from 'node:http';
import {monitorEventLoopDelay,createHistogram,performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {RELEASED_IDS} from '../shared/games.mjs';

const benchmarkGames=new Set(RELEASED_IDS);
export function benchmarkGameTag(headers,path){
 const tag=headers?.['x-oasis-benchmark-game'];
 if(typeof tag!=='string'||!benchmarkGames.has(tag))return null;
 const play=path.match(/^\/api\/play\/([^/]+)\//);
 return play&&play[1]!==tag?null:tag;
}

export function installBenchmarkObserver(apiPort){
 const original=Server.prototype.emit,delay=monitorEventLoopDelay({resolution:10}),routes=new Map(),gameRoutes=new Map();
 let running=false,started=0,cpuStart,peakOneCore=0,peakMachineShare=0,previousCpu,previousAt;
 const clock=()=>performance.now();
 const cpuSample=()=>{if(!running)return;const cpu=process.cpuUsage(),at=clock(),seconds=(at-previousAt)*1000;
  if(seconds>0){const percent=((cpu.user-previousCpu.user)+(cpu.system-previousCpu.system))/seconds*100;peakOneCore=Math.max(peakOneCore,percent);peakMachineShare=Math.max(peakMachineShare,percent/cpus().length);}
  previousCpu=cpu;previousAt=at;
 };
 const interval=setInterval(cpuSample,1000);interval.unref();
 Server.prototype.emit=function(name,...args){
  if(name==='request'&&running&&this.address()?.port===apiPort){
   const [req,res]=args,path=(req.url||'').split('?')[0];
   if(path.startsWith('/api/pvp/')||path.startsWith('/api/play/')||path.startsWith('/v1/')){
    const at=clock(),key=req.method+' '+path.replace(/\/rooms\/[^/]+/,'/rooms/:id'),game=benchmarkGameTag(req.headers,path);
    res.once('finish',()=>{if(!running)return;const elapsed=Math.max(1,Math.round((clock()-at)*1e6));let histogram=routes.get(key);if(!histogram){histogram=createHistogram();routes.set(key,histogram);}histogram.record(elapsed);
     if(game){const tagged=game+' '+key;let row=gameRoutes.get(tagged);if(!row){row={game,route:key,histogram:createHistogram()};gameRoutes.set(tagged,row);}row.histogram.record(elapsed);}
    });
   }
  }
  return original.call(this,name,...args);
 };
 const summarize=()=>{cpuSample();const elapsed=clock()-started,cpu=process.cpuUsage(cpuStart),oneCore=(cpu.user+cpu.system)/(elapsed*1000)*100;
  return {scope:'Isolated API process, request event to response finish; local transport backpressure included. API workers included in process CPU; generator/Postgres CPU excluded. Not production capacity.',duration_ms:elapsed,
   routes:[...routes].map(([route,h])=>({route,count:h.count,p50_ms:h.percentile(50)/1e6,p95_ms:h.percentile(95)/1e6,p99_ms:h.percentile(99)/1e6,max_ms:h.max/1e6})),
   game_routes:[...gameRoutes.values()].map(({game,route,histogram:h})=>({game,route,count:h.count,p50_ms:h.percentile(50)/1e6,p95_ms:h.percentile(95)/1e6,p99_ms:h.percentile(99)/1e6,max_ms:h.max/1e6})),
   game_tag_scope:'Test-generator game label only, sent in x-oasis-benchmark-game; not an authenticated production identity. Probability path mismatches are excluded.',
   event_loop:{count:delay.count,p95_ms:delay.percentile(95)/1e6,p99_ms:delay.percentile(99)/1e6,max_ms:delay.max/1e6},
   cpu:{logical_cpus:cpus().length,average_percent_of_one_core:oneCore,average_percent_of_machine:oneCore/cpus().length,peak_1s_percent_of_one_core:peakOneCore,peak_1s_percent_of_machine:peakMachineShare}};
 };
 const message=m=>{if(m?.type==='measure-start'){routes.clear();gameRoutes.clear();started=clock();cpuStart=previousCpu=process.cpuUsage();previousAt=started;peakOneCore=peakMachineShare=0;delay.reset();delay.enable();running=true;process.send?.({type:'measure-started'});}else if(m?.type==='measure-stop'){const result=summarize();running=false;delay.disable();process.send?.({type:'measure-summary',result});}};
 process.on('message',message);
 return()=>{running=false;delay.disable();clearInterval(interval);process.off('message',message);Server.prototype.emit=original;};
}
