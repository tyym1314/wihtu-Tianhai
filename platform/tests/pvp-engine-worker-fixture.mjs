import {parentPort} from 'node:worker_threads';
parentPort.on('message',({id,job})=>{
  if(job.crash)process.exit(7);
  if(job.delay)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,job.delay);
  parentPort.postMessage({id:job.wrongId?id+1:id,result:{value:job.value}});
});
