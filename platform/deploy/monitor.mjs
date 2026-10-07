/** Read-only, bounded operational checks. Never log credentials, SQL rows or HTTP bodies. */
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {X509Certificate, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chmod, chown, lstat, mkdir, open, readFile, readdir, rename, stat, statfs, unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const exec=promisify(execFile),DAY=86400000;
const number=(env,key,fallback,min=1,max=Number.MAX_SAFE_INTEGER)=>{
 const value=Number(env[key]??fallback);
 if(!Number.isFinite(value)||value<min||value>max)throw new Error('MONITOR_CONFIG_INVALID');
 return value;
};
export function monitorConfig(env=process.env){
 const origin=new URL(env.OASIS_PUBLIC_ORIGIN||'https://game.tianyahuyu.com');
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('MONITOR_CONFIG_INVALID');
 if(!env.OASIS_DATABASE_URL)throw new Error('MONITOR_DATABASE_CONFIG_MISSING');
 const port=key=>number(env,key,{OASIS_API_PORT:18881,OASIS_WALLET_PORT:18882,OASIS_DEMO_PORT:18885}[key],1024,65535);
 return {
  databaseUrl:env.OASIS_DATABASE_URL,origin:origin.origin,host:origin.host,hostname:origin.hostname,
  apiPort:port('OASIS_API_PORT'),walletPort:port('OASIS_WALLET_PORT'),demoPort:port('OASIS_DEMO_PORT'),
  timeoutMs:number(env,'OASIS_MONITOR_TIMEOUT_MS',5000,100,15000),
  overdueSeconds:number(env,'OASIS_MONITOR_OVERDUE_SECONDS',120),
  roomStaleSeconds:number(env,'OASIS_MONITOR_ROOM_STALE_SECONDS',180),
  backlogLimit:number(env,'OASIS_MONITOR_BACKLOG_LIMIT',100,0),
  diskUsedLimit:number(env,'OASIS_MONITOR_DISK_USED_PERCENT',85,1,99.9),
  backupMaxHours:number(env,'OASIS_MONITOR_BACKUP_MAX_HOURS',30),
  certMinDays:number(env,'OASIS_MONITOR_CERT_MIN_DAYS',14),
  diskPaths:(env.OASIS_MONITOR_DISK_PATHS||'/opt/oasis,/var/lib/docker').split(',').map(x=>x.trim()),
  backupDir:env.OASIS_MONITOR_BACKUP_DIR||'/opt/oasis/backups',
  certFile:env.OASIS_MONITOR_CERT_FILE||'/opt/oasis/acme/config/live/oasis-game/fullchain.pem',
  reportFile:'/opt/oasis/private/monitor/status.json',
  reportGroupRead:env.OASIS_MONITOR_REPORT_GROUP_READ==='1',
 };
}

// Use original creation/deadline times: retries continuously update updated_at.
export const BACKLOG_SQL=`SELECT
 (SELECT count(*) FROM gp_cycles WHERE status NOT IN ('SETTLED','REJECTED')) AS cycles_pending,
 (SELECT count(*) FROM gp_cycles WHERE status NOT IN ('SETTLED','REJECTED') AND created_at < now()-($1::double precision*interval '1 second')) AS cycles_overdue,
 (SELECT count(*) FROM gp_operations WHERE state='PENDING') AS probability_operations_pending,
 (SELECT count(*) FROM gp_operations WHERE state='PENDING' AND created_at < now()-($1::double precision*interval '1 second')) AS probability_operations_overdue,
 (SELECT count(*) FROM pvp_operations WHERE state='PENDING') AS pvp_operations_pending,
 (SELECT count(*) FROM pvp_operations WHERE state='PENDING' AND created_at < now()-($1::double precision*interval '1 second')) AS pvp_operations_overdue,
 (SELECT count(*) FROM pvp_rooms WHERE status='fault') AS rooms_faulted,
 (SELECT count(*) FROM pvp_rooms WHERE
   (status='active' AND updated_at < now()-($2::double precision*interval '1 second')) OR
   (status IN ('settling','voiding') AND COALESCE(end_at,extract(epoch FROM created_at)*1000) < extract(epoch FROM now())*1000-$1*1000) OR
   (status='fault' AND COALESCE(fault_at,extract(epoch FROM created_at)*1000) < extract(epoch FROM now())*1000-$1*1000) OR
   (status IN ('waiting','funding','cancelling') AND LEAST(expires_at,COALESCE(ready_deadline_at,expires_at)) < extract(epoch FROM now())*1000-$1*1000)
 ) AS rooms_overdue`;
const metricNames=['cycles_pending','cycles_overdue','probability_operations_pending','probability_operations_overdue','pvp_operations_pending','pvp_operations_overdue','rooms_faulted','rooms_overdue'];
const units=['oasis-api.service','oasis-demo.service','nginx.service','oasis-backup.timer','oasis-certificate.timer','oasis-backup.service','oasis-certificate.service'];

export function requestHealth(url,{host,timeoutMs=5000,maxBytes=131072}={}){
 return new Promise((resolve,reject)=>{
  const transport=new URL(url).protocol==='https:'?httpsRequest:httpRequest;
  const abort=code=>{reject(new Error(code));req.destroy();};
  const req=transport(url,{method:'GET',headers:host?{Host:host}:{},rejectUnauthorized:true,agent:false},res=>{
   const chunks=[];let size=0;
   res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)abort('RESPONSE_TOO_LARGE');else chunks.push(chunk);});
   res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
   res.on('error',reject);
  });
  const timer=setTimeout(()=>abort('PROBE_TIMEOUT'),timeoutMs);
  req.on('close',()=>clearTimeout(timer));req.on('error',reject);req.end();
 });
}
export function createProbes(config){
 const jsonOK=async url=>{
  const response=await requestHealth(url,{host:config.host,timeoutMs:config.timeoutMs});
  if(response.status!==200)throw new Error('UNHEALTHY_HTTP');
  const data=JSON.parse(response.body);
  if(data.status!=='ok')throw new Error('UNHEALTHY_BODY');
  return {reachable:true};
 };
 return {
  database:async()=>{
   const client=new pg.Client({connectionString:config.databaseUrl,application_name:'oasis-readonly-monitor',
    connectionTimeoutMillis:config.timeoutMs,query_timeout:config.timeoutMs,statement_timeout:config.timeoutMs,
    options:'-c default_transaction_read_only=on'});
   client.on('error',()=>{}); // Query/connect errors are reported as fixed codes, never driver text.
   try{await client.connect();return (await client.query(BACKLOG_SQL,[config.overdueSeconds,config.roomStaleSeconds])).rows[0];}
   finally{await client.end();}
  },
  api:()=>jsonOK(`http://127.0.0.1:${config.apiPort}/health`),
  wallet:()=>jsonOK(`http://127.0.0.1:${config.walletPort}/health`),
  ingress:()=>jsonOK(`${config.origin}/health`),
  demo:async()=>{
   // /api/demo/config creates a guest and is rate limited. This check creates no identity.
   const response=await requestHealth(`http://127.0.0.1:${config.demoPort}/demo/`,{host:config.host,timeoutMs:config.timeoutMs});
   if(response.status!==200||!/<script type="module" src="\/demo\/static\/[a-f0-9]{64}\/host\.mjs"><\/script>/.test(response.body)||!response.body.includes('OASIS 游戏试玩'))throw new Error('DEMO_UNAVAILABLE');
   return {reachable:true};
  },
  systemd:async()=>Object.fromEntries(await Promise.all(units.map(async unit=>{
   const {stdout}=await exec('systemctl',['show',unit,'--no-pager','--property=LoadState,ActiveState,SubState,Result,ExecMainStatus'],{timeout:config.timeoutMs,maxBuffer:8192});
   return [unit,Object.fromEntries(stdout.trim().split('\n').map(line=>{const pos=line.indexOf('=');return [line.slice(0,pos),line.slice(pos+1)];}))];
  }))),
  backup:async()=>{
   const candidates=(await readdir(config.backupDir)).filter(name=>/^\d{8}T\d{6}Z$/.test(name)).sort().reverse().slice(0,50);
   for(const name of candidates){
    try{
     const files=await Promise.all(['SHA256SUMS','database.dump','private-config.tar.gz','release.txt','database-contents.txt'].map(file=>stat(path.join(config.backupDir,name,file))));
     if(files.every(item=>item.isFile()&&item.size>0))return {completedAtMs:files[0].mtimeMs};
    }catch{/* A partial backup must not hide the last completed backup. */}
   }
   throw new Error('BACKUP_MISSING');
  },
  disks:async()=>Promise.all(config.diskPaths.map(async item=>{
   const info=await statfs(item);
   if(info.blocks<=0)throw new Error('DISK_INVALID');
   return {usedPercent:(1-info.bavail/info.blocks)*100};
  })),
  certificate:async()=>{
   const cert=new X509Certificate(await readFile(config.certFile));
   return {expiresAtMs:Date.parse(cert.validTo),validFromMs:Date.parse(cert.validFrom),hostnameMatches:Boolean(cert.checkHost(config.hostname))};
  },
 };
}

function bounded(probe,timeoutMs){
 let timer;
 return Promise.race([Promise.resolve().then(probe),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('PROBE_TIMEOUT')),timeoutMs);})]).finally(()=>clearTimeout(timer));
}
const check=(name,codes=[],metrics={})=>({name,status:codes.length?'failed':'ok',codes,metrics});
const validNumber=value=>Number.isFinite(Number(value))&&Number(value)>=0;
const round=value=>Math.round(value*100)/100;
export async function collectHealth(config,probes,{now=Date.now()}={}){
 const names=['database','api','wallet','ingress','demo','systemd','backup','disks','certificate'];
 const results=await Promise.all(names.map(async name=>{
  try{return {name,value:await bounded(probes[name],config.timeoutMs+500)};}catch{return {name,failed:true};}
 }));
 const checks=[];
 for(const {name,value,failed} of results){
  if(failed){checks.push(check(name,['PROBE_FAILED']));continue;}
  if(name==='database'){
   if(!metricNames.every(key=>validNumber(value?.[key])&&Number.isSafeInteger(Number(value[key])))){
    checks.push(check(name,['METRICS_INVALID']));continue;
   }
   const metrics=Object.fromEntries(metricNames.map(key=>[key,Number(value[key])])),codes=[];
   if(['cycles_overdue','probability_operations_overdue','pvp_operations_overdue','rooms_overdue'].some(key=>metrics[key]>0))codes.push('SETTLEMENT_OR_ROOM_OVERDUE');
   if(metrics.rooms_faulted>0)codes.push('ROOM_FAULT');
   if(['cycles_pending','probability_operations_pending','pvp_operations_pending'].some(key=>metrics[key]>config.backlogLimit))codes.push('BACKLOG_LIMIT_EXCEEDED');
   checks.push(check(name,codes,metrics));
  }else if(name==='systemd'){
   const codes=[];
   for(const unit of units){
    const state=value?.[unit],isJob=['oasis-backup.service','oasis-certificate.service'].includes(unit);
    if(state?.LoadState!=='loaded'||state.ActiveState==='failed'||(!isJob&&state.ActiveState!=='active')||
      (isJob&&(state.Result!=='success'||Number(state.ExecMainStatus)!==0))){codes.push('UNIT_UNHEALTHY:'+unit);}
   }
   checks.push(check(name,codes));
  }else if(name==='backup'){
   const age=(now-value?.completedAtMs)/3600000;
   checks.push(Number.isFinite(age)&&age>=0?check(name,age>config.backupMaxHours?['BACKUP_STALE']:[],{ageHours:round(age)}):check(name,['BACKUP_TIMESTAMP_INVALID']));
  }else if(name==='disks'){
   if(!Array.isArray(value)||value.length!==config.diskPaths.length||!value.every(item=>validNumber(item?.usedPercent)&&item.usedPercent<=100)){
    checks.push(check(name,['DISK_METRICS_INVALID']));continue;
   }
   const max=Math.max(...value.map(item=>item.usedPercent));checks.push(check(name,max>=config.diskUsedLimit?['DISK_SPACE_LOW']:[],{maxUsedPercent:round(max)}));
  }else if(name==='certificate'){
   const days=(value?.expiresAtMs-now)/DAY,codes=[];
   if(!value?.hostnameMatches)codes.push('CERTIFICATE_HOST_MISMATCH');
   if(!Number.isFinite(days)||!Number.isFinite(value?.validFromMs)||value.validFromMs>now)codes.push('CERTIFICATE_INVALID');
   else if(days<config.certMinDays)codes.push('CERTIFICATE_EXPIRING');
   checks.push(check(name,codes,Number.isFinite(days)?{remainingDays:round(days)}:{}));
  }else checks.push(check(name,value?.reachable===true?[]:['HTTP_UNHEALTHY']));
 }
 return {schema_version:1,checked_at:new Date(now).toISOString(),status:checks.some(item=>item.status==='failed')?'failed':'ok',checks};
}

export async function atomicReport(filename,report,{groupRead=false}={}){
 const directoryName=path.dirname(filename),directoryMode=groupRead?0o750:0o700,fileMode=groupRead?0o640:0o600;
 await mkdir(directoryName,{recursive:true,mode:directoryMode});
 const info=await lstat(directoryName);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('REPORT_DIRECTORY_UNSAFE');
 // Group is the service's fixed oasis group; callers cannot choose an arbitrary group.
 if(groupRead)await chown(directoryName,process.getuid(),process.getgid());
 await chmod(directoryName,directoryMode);
 const temporary=filename+'.'+randomUUID()+'.tmp';
 let handle;
 try{
  handle=await open(temporary,'wx',fileMode);await handle.chmod(fileMode);await handle.writeFile(JSON.stringify(report,null,2)+'\n');await handle.sync();await handle.close();handle=null;
  await rename(temporary,filename);
  const directory=await open(path.dirname(filename),'r');try{await directory.sync();}finally{await directory.close();}
 }finally{if(handle)await handle.close();await unlink(temporary).catch(()=>{});}
}
const fingerprint=report=>JSON.stringify(report?.checks?.map(({name,status,codes})=>({name,status,codes})));
export function stateChange(previous,current){
 if(!previous){return current.status==='failed'?{event:'oasis.monitor.degraded',status:current.status,changed:current.checks.filter(item=>item.status==='failed').map(({name,codes})=>({name,codes}))}:null;}
 if(fingerprint(previous)===fingerprint(current))return null;
 const changed=current.checks.filter(item=>{
  const prior=previous.checks?.find(candidate=>candidate.name===item.name);
  return !prior||prior.status!==item.status||JSON.stringify(prior.codes)!==JSON.stringify(item.codes);
 }).map(({name,status,codes})=>({name,status,codes}));
 return {event:current.status==='ok'?'oasis.monitor.recovered':'oasis.monitor.changed',status:current.status,changed};
}
export async function runMonitor(config,{probes=createProbes(config),now=Date.now(),readPrevious,writeReport,emit}={}){
 readPrevious??=async()=>{try{return JSON.parse(await readFile(config.reportFile,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
 writeReport??=report=>atomicReport(config.reportFile,report,{groupRead:config.reportGroupRead});
 emit??=event=>process.stdout.write(JSON.stringify(event)+'\n');
 const report=await collectHealth(config,probes,{now});
 let previous;
 try{previous=await readPrevious();}catch{report.checks.push(check('report_history',['PREVIOUS_REPORT_UNREADABLE']));report.status='failed';}
 const event=stateChange(previous,report);
 await writeReport(report);
 if(event)emit({...event,checked_at:report.checked_at});
 return {exitCode:report.status==='ok'?0:1,report};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.exitCode=(await runMonitor(monitorConfig())).exitCode;}
 catch{process.stderr.write(JSON.stringify({event:'oasis.monitor.execution_failed',status:'failed',code:'MONITOR_EXECUTION_FAILED'})+'\n');process.exitCode=1;}
}
