/**
 * Optional multi-process entry. OASIS_WORKERS=1 (default) runs index.mjs in this process unchanged.
 * With N>1, worker 1 is the leader (migrations, background jobs, reference wallet) and starts first;
 * followers only serve HTTP on the shared port. A dead worker is replaced with the same role.
 */
import cluster from 'node:cluster';
const workers=Math.max(1,Number(process.env.OASIS_WORKERS||1));
if(workers===1)await import('./index.mjs');
else if(cluster.isPrimary){
 const start=role=>new Promise(resolve=>{
  const w=cluster.fork({...process.env,OASIS_WORKER_ROLE:role});w.role=role;
  w.on('message',m=>{if(m?.type==='oasis-ready')resolve(w);});
 });
 cluster.on('exit',(w,code,signal)=>{console.error(JSON.stringify({event:'oasis.worker.exit',role:w.role,code,signal}));setTimeout(()=>start(w.role),1000);});
 await start('leader');
 for(let i=1;i<workers;i++)await start('follower');
 console.log(JSON.stringify({event:'oasis.cluster.ready',workers}));
}else await import('./index.mjs');
