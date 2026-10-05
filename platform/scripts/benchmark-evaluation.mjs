/** Pure validation of the isolated capacity probe; no I/O or inferred samples. */
const MINIMUM_MS=900000;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const missing=value=>value===undefined||value===null;
const fatal=({clientError,roomRestartError,failure})=>Boolean(clientError||roomRestartError||failure);

/** actualDurationMs is the scheduler window, excluding post-window draining/cleanup. */
export function workloadCompleted({completed,durationSeconds,actualDurationMs,...errors}={}){
 return completed===true&&!fatal(errors)&&finite(durationSeconds)&&durationSeconds>0&&finite(actualDurationMs)&&actualDurationMs>=durationSeconds*1000;
}

export function evaluateMobileCapacity(input={}){
 const {completed,durationSeconds,actualDurationMs,internal,unexpectedErrors,httpRequests,requiredGames}=input;
 const failures=[],insufficient=[];
 const fail=reason=>failures.push(reason),lack=reason=>insufficient.push(reason);
 const sample=(value,path,{integer=false,positive=false}={})=>{
  if(missing(value)){lack(path+':missing');return false;}
  if(!finite(value)||value<0||(integer&&!Number.isSafeInteger(value))){fail(path+':invalid');return false;}
  if(positive&&value===0){lack(path+':empty');return false;}
  return true;
 };
 const histogram=(value,path)=>{
  if(missing(value)){lack(path+':missing');return;}
  if(typeof value!=='object'||Array.isArray(value)){fail(path+':invalid');return;}
  sample(value.count,path+'.count',{integer:true,positive:true});
  const fields=['p50_ms','p95_ms','p99_ms','max_ms'];
  const valid=fields.map(field=>sample(value[field],path+'.'+field));
  if(valid.every(Boolean)&&fields.some((field,i)=>i>0&&value[field]<value[fields[i-1]]))fail(path+':percentiles-out-of-order');
 };

 if(completed!==true)fail('workload:not-completed');
 if(fatal(input))fail('workload:fatal-error');
 if(!finite(durationSeconds)||durationSeconds<=0)fail('workload.configured_duration:invalid');
 if(!finite(actualDurationMs)||actualDurationMs<0)fail('workload.actual_duration:invalid');
 if(finite(durationSeconds)&&durationSeconds>0&&finite(actualDurationMs)&&actualDurationMs<durationSeconds*1000)fail('workload:ended-before-configured-duration');
 if(finite(durationSeconds)&&durationSeconds<900)lack('workload:shorter-than-900-seconds');

 if(missing(internal))lack('internal:missing');
 else if(typeof internal!=='object'||Array.isArray(internal))fail('internal:invalid');
 else{
  if(sample(internal.duration_ms,'internal.duration_ms')&&internal.duration_ms<MINIMUM_MS)lack('internal.duration_ms:shorter-than-900-seconds');
  if(missing(internal.routes)||Array.isArray(internal.routes)&&internal.routes.length===0)lack('internal.routes:empty');
  else if(!Array.isArray(internal.routes))fail('internal.routes:invalid');
  else for(const [index,route]of internal.routes.entries()){
   const path='internal.routes['+index+']';
   histogram(route,path);
   if(!route||typeof route!=='object')continue;
   if(missing(route.route)||route.route==='')lack(path+'.route:missing');
   else if(typeof route.route!=='string')fail(path+'.route:invalid');
   if(finite(route.p95_ms)&&route.p95_ms>100)fail(path+'.p95_ms:over-limit');
   if(finite(route.p99_ms)&&route.p99_ms>250)fail(path+'.p99_ms:over-limit');
  }
  const loop=internal.event_loop;
  if(missing(loop))lack('internal.event_loop:missing');
  else if(typeof loop!=='object'||Array.isArray(loop))fail('internal.event_loop:invalid');
  else{
   sample(loop.count,'internal.event_loop.count',{integer:true,positive:true});
   const valid=['p95_ms','p99_ms','max_ms'].map(field=>sample(loop[field],'internal.event_loop.'+field));
   if(valid.every(Boolean)&&(loop.p95_ms>loop.p99_ms||loop.p99_ms>loop.max_ms))fail('internal.event_loop:percentiles-out-of-order');
   if(finite(loop.p99_ms)&&loop.p99_ms>50)fail('internal.event_loop.p99_ms:over-limit');
  }
  const cpu=internal.cpu;
  if(missing(cpu))lack('internal.cpu:missing');
  else if(typeof cpu!=='object'||Array.isArray(cpu))fail('internal.cpu:invalid');
  else{
   sample(cpu.logical_cpus,'internal.cpu.logical_cpus',{integer:true,positive:true});
   for(const field of ['average_percent_of_one_core','average_percent_of_machine','peak_1s_percent_of_one_core','peak_1s_percent_of_machine'])sample(cpu[field],'internal.cpu.'+field);
   if(finite(cpu.peak_1s_percent_of_machine)&&cpu.peak_1s_percent_of_machine>=70)fail('internal.cpu.peak_1s_percent_of_machine:over-limit');
  }
 }
 if(requiredGames!==undefined){
  const supported=new Set(['run','bowling','towerlink','thunder','tiger']);
  if(!Array.isArray(requiredGames)||!requiredGames.length||new Set(requiredGames).size!==requiredGames.length||requiredGames.some(game=>!supported.has(game)))fail('required_games:invalid');
  else if(!Array.isArray(internal?.game_routes)||!internal.game_routes.length)lack('internal.game_routes:missing');
  else{
   const keys=new Set();
   for(const [index,row]of internal.game_routes.entries()){
    const path='internal.game_routes['+index+']';histogram(row,path);
    if(!row||typeof row!=='object')continue;
    if(!supported.has(row.game)||typeof row.route!=='string'||!row.route){fail(path+':invalid-game-or-route');continue;}
    const key=row.game+' '+row.route;if(keys.has(key))fail(path+':duplicate');keys.add(key);
    if(finite(row.p95_ms)&&row.p95_ms>100)fail(path+'.p95_ms:over-limit');
    if(finite(row.p99_ms)&&row.p99_ms>250)fail(path+'.p99_ms:over-limit');
   }
   for(const game of requiredGames){
    const action=['thunder','tiger'].includes(game)?'POST /api/play/'+game+'/spin':'POST /api/pvp/rooms/:id/action';
    if(!keys.has(game+' '+action))lack('internal.game_routes.'+game+':missing-action');
   }
  }
 }
 const errorsValid=sample(unexpectedErrors,'unexpected_errors',{integer:true});
 const requestsValid=sample(httpRequests,'http_requests',{integer:true,positive:true});
 if(errorsValid&&finite(httpRequests)&&unexpectedErrors>httpRequests)fail('unexpected_errors:exceeds-request-count');
 if(errorsValid&&requestsValid&&unexpectedErrors/httpRequests>=.001)fail('unexpected_errors:over-limit');
 return{
  status:failures.length?'fail':insufficient.length?'insufficient':'pass',
  scope:'Local isolated five-game synthetic workload only; not public server or physical-phone acceptance',
  duration_minimum_seconds:900,internal_p95_limit_ms:100,internal_p99_limit_ms:250,
  event_loop_p99_limit_ms:50,cpu_limit_percent_of_machine:70,
  reasons:[...failures,...insufficient],
 };
}
