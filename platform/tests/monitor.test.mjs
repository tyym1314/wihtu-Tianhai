import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {atomicReport,collectHealth,monitorConfig,readTransferMonitor,requestHealth,runMonitor} from '../deploy/monitor.mjs';
import {TRANSFER_TABLES,TRANSFER_AUDIT_SQL,TRANSFER_OBLIGATIONS_SQL} from '../server/transfers/audit.mjs';

const NOW=1900000000000,SECRET='never-show-this-password-or-token';
const config=monitorConfig({OASIS_DATABASE_URL:`postgres://user:${SECRET}@localhost/platform`,OASIS_PUBLIC_ORIGIN:'https://game.tianyahuyu.com'});
function healthy(){
 return {
  database:async()=>({cycles_pending:'0',cycles_overdue:'0',probability_operations_pending:'0',probability_operations_overdue:'0',pvp_operations_pending:'0',pvp_operations_overdue:'0',rooms_faulted:'0',rooms_overdue:'0',transfer_schema:'present',pending_transfers:'0',transfers_overdue:'0',clearing_mismatches:'0',transfer_order_mismatches:'0',wallet_hold_mismatches:'0'}),
  api:async()=>({reachable:true}),wallet:async()=>({reachable:true}),ingress:async()=>({reachable:true}),demo:async()=>({reachable:true}),
  systemd:async()=>Object.fromEntries(['oasis-api.service','oasis-demo.service','nginx.service','oasis-backup.timer','oasis-certificate.timer','oasis-backup.service','oasis-certificate.service'].map(unit=>[unit,{
   LoadState:'loaded',ActiveState:['oasis-backup.service','oasis-certificate.service'].includes(unit)?'inactive':'active',Result:'success',ExecMainStatus:'0',
  }])),
  backup:async()=>({completedAtMs:NOW-3*3600000}),
  disks:async()=>[{usedPercent:25},{usedPercent:30}],
  certificate:async()=>({expiresAtMs:NOW+60*86400000,validFromMs:NOW-20*86400000,hostnameMatches:true}),
 };
}
async function run(probes,{previous=null,...options}={}){
 const events=[],written=[];
 const result=await runMonitor(config,{probes,now:NOW,readPrevious:async()=>previous,writeReport:async report=>written.push(structuredClone(report)),emit:event=>events.push(event),...options});
 return {...result,events,written};
}

test('healthy dependencies produce a private, structured report and no repeated all-clear journal events',async()=>{
 const first=await run(healthy());assert.equal(first.exitCode,0);assert.equal(first.report.checks.length,9);assert.equal(first.report.schema_version,1);assert.deepEqual(first.events,[]);
 const again=await run(healthy(),{previous:first.report,now:NOW+60000});assert.equal(again.exitCode,0);assert.deepEqual(again.events,[]);
 assert.equal(again.written.length,1);assert.equal(JSON.stringify(again).includes(SECRET),false);
});

test('database failure is unhealthy even when shallow HTTP health is green, without leaking driver error text',async()=>{
 const probes=healthy();probes.database=async()=>{throw new Error(`connect ${config.databaseUrl} Authorization: ${SECRET}`);};
 const result=await run(probes);
 assert.equal(result.exitCode,1);assert.equal(result.report.checks.find(item=>item.name==='api').status,'ok');
 assert.deepEqual(result.report.checks.find(item=>item.name==='database').codes,['PROBE_FAILED']);
 assert.equal(result.events[0].event,'oasis.monitor.degraded');assert.equal(JSON.stringify(result).includes(SECRET),false);
});

test('old settlement work fails even with small queues and creates one change event, then one recovery event',async()=>{
 const before=(await run(healthy())).report,probes=healthy();
 probes.database=async()=>({...await healthy().database(),cycles_pending:2,cycles_overdue:2,pvp_operations_pending:1,pvp_operations_overdue:1});
 const failed=await run(probes,{previous:before});assert.equal(failed.exitCode,1);
 assert.deepEqual(failed.report.checks.find(item=>item.name==='database').codes,['SETTLEMENT_OR_ROOM_OVERDUE']);
 assert.equal(failed.events[0].event,'oasis.monitor.changed');
 probes.database=async()=>({...await healthy().database(),cycles_pending:3,cycles_overdue:3,pvp_operations_pending:1,pvp_operations_overdue:1});
 const stillFailed=await run(probes,{previous:failed.report});assert.equal(stillFailed.exitCode,1);assert.deepEqual(stillFailed.events,[]);
 const recovered=await run(healthy(),{previous:stillFailed.report});assert.equal(recovered.exitCode,0);assert.equal(recovered.events[0].event,'oasis.monitor.recovered');
 const quiet=await run(healthy(),{previous:recovered.report});assert.deepEqual(quiet.events,[]);
});

test('pending backlog, faulted rooms and malformed SQL metrics cannot report healthy',async()=>{
 const probes=healthy();probes.database=async()=>({...await healthy().database(),cycles_pending:101,rooms_faulted:1});
 const result=await run(probes);assert.equal(result.exitCode,1);
 assert.deepEqual(result.report.checks.find(item=>item.name==='database').codes,['ROOM_FAULT','BACKLOG_LIMIT_EXCEEDED']);
 probes.database=async()=>({password:SECRET});const invalid=await run(probes);
 assert.deepEqual(invalid.report.checks.find(item=>item.name==='database').codes,['METRICS_INVALID']);assert.equal(JSON.stringify(invalid).includes(SECRET),false);
});

test('transfer overdue and integrity failures are unhealthy independently of backlog size',async()=>{
 const probes=healthy();probes.database=async()=>({...await healthy().database(),pending_transfers:'1',transfers_overdue:'1'});
 assert.deepEqual((await run(probes)).report.checks.find(c=>c.name==='database').codes,['TRANSFER_OVERDUE']);
 for(const field of ['clearing_mismatches','transfer_order_mismatches','wallet_hold_mismatches']){
  probes.database=async()=>({...await healthy().database(),[field]:'1'});
  assert.deepEqual((await run(probes)).report.checks.find(c=>c.name==='database').codes,['TRANSFER_LEDGER_INCONSISTENT']);
 }
 probes.database=async()=>({...await healthy().database(),pending_transfers:'101'});
 assert.deepEqual((await run(probes)).report.checks.find(c=>c.name==='database').codes,['BACKLOG_LIMIT_EXCEEDED']);
});

test('missing audit/schema and contradictory legacy transfer metrics never default to healthy zero',async()=>{
 for(const damage of [v=>delete v.transfer_schema,v=>delete v.clearing_mismatches,v=>v.wallet_hold_mismatches=null,
  v=>v.transfer_schema='partial',v=>{v.transfer_schema='absent';v.pending_transfers='1';}]){
  const probes=healthy(),v=await probes.database();damage(v);probes.database=async()=>v;
  assert.deepEqual((await run(probes)).report.checks.find(c=>c.name==='database').codes,['METRICS_INVALID']);
 }
 const probes=healthy();probes.database=async()=>({...await healthy().database(),transfer_schema:'absent'});
 assert.equal((await run(probes)).exitCode,0);
});

test('transfer monitor reuses the caller snapshot and ages all PENDING outcomes from creation, without provider details',async()=>{
 const calls=[],db={query:async(sql,values)=>{
  calls.push({sql,values});
  if(sql.includes('FROM pg_class'))return{rows:TRANSFER_TABLES.map(relname=>({relname,relkind:'r'}))};
  if(sql===TRANSFER_AUDIT_SQL)return{rows:[{audit:{clearing_mismatches:0,transfer_order_mismatches:0,wallet_hold_mismatches:0}}]};
  if(sql===TRANSFER_OBLIGATIONS_SQL)return{rows:[{pending_transfers:'2',pending_inbound_minor:'999999999999999999999',pending_outbound_minor:'0',secret:SECRET}]};
  assert.match(sql,/state='PENDING' AND created_at < now\(\)/);assert.doesNotMatch(sql,/updated_at|lease|observation|next_attempt/);
  assert.deepEqual(values,[120]);return{rows:[{transfers_overdue:'1'}]};
 }};
 const result=await readTransferMonitor(db,120);
 assert.deepEqual(result,{transfer_schema:'present',clearing_mismatches:0,transfer_order_mismatches:0,wallet_hold_mismatches:0,pending_transfers:'2',transfers_overdue:'1'});
 assert.equal(calls.length,4);assert.equal(JSON.stringify(result).includes(SECRET),false);
 assert.equal(calls.some(c=>/BEGIN|COMMIT|UPDATE|INSERT/i.test(c.sql)),false);
});

test('transfer feature is absent only with all tables and transfer ledger traces absent; partial/view fails',async()=>{
 const absent={query:async sql=>({rows:sql.includes('FROM pg_class')?[]:[{found:false}]})};
 const result=await readTransferMonitor(absent,120);assert.equal(result.transfer_schema,'absent');assert.equal(result.pending_transfers,'0');
 for(const rows of [[{relname:'gp_transfers',relkind:'r'}],TRANSFER_TABLES.map(relname=>({relname,relkind:relname==='gp_transfers'?'v':'r'}))]){
  await assert.rejects(readTransferMonitor({query:async()=>({rows})},120),/TRANSFER_SCHEMA_INCOMPLETE/);
 }
 await assert.rejects(readTransferMonitor({query:async sql=>({rows:sql.includes('FROM pg_class')?[]:[{found:true}]})},120),/TRANSFER_SCHEMA_INCOMPLETE/);
});

test('failed backup job and stopped renewal timer are flagged independently of API health',async()=>{
 const probes=healthy(),states=await probes.systemd();
 states['oasis-backup.service']={LoadState:'loaded',ActiveState:'failed',Result:'exit-code',ExecMainStatus:'1'};
 states['oasis-certificate.timer'].ActiveState='inactive';probes.systemd=async()=>states;
 const result=await run(probes);assert.equal(result.exitCode,1);
 assert.deepEqual(result.report.checks.find(item=>item.name==='systemd').codes,['UNIT_UNHEALTHY:oasis-certificate.timer','UNIT_UNHEALTHY:oasis-backup.service']);
});

test('backup freshness, certificate expiry and disk usage thresholds fail together without paths or secrets',async()=>{
 const probes=healthy();probes.backup=async()=>({completedAtMs:NOW-31*3600000,secret:SECRET});probes.certificate=async()=>({expiresAtMs:NOW+13*86400000,validFromMs:NOW-86400000,hostnameMatches:true,privateKey:SECRET});
 probes.disks=async()=>[{usedPercent:86,mount:SECRET},{usedPercent:40}];
 const result=await run(probes);assert.equal(result.exitCode,1);
 assert.deepEqual(result.report.checks.filter(item=>item.status==='failed').map(item=>item.name),['backup','disks','certificate']);assert.equal(JSON.stringify(result).includes(SECRET),false);
});

test('hanging probes are bounded and missing systemd units fail closed',async()=>{
 const probes=healthy();probes.api=()=>new Promise(()=>{});probes.systemd=async()=>({});
 const started=Date.now(),report=await collectHealth({...config,timeoutMs:10},probes,{now:NOW});
 assert.ok(Date.now()-started<1500);assert.equal(report.status,'failed');
 assert.deepEqual(report.checks.find(item=>item.name==='api').codes,['PROBE_FAILED']);assert.equal(report.checks.find(item=>item.name==='systemd').codes.length,7);
});

test('reports replace atomically with private permissions and no orphaned temporary file',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'oasis-monitor-'));
 try{
  const file=path.join(dir,'private','status.json'),first=(await run(healthy())).report;
  await atomicReport(file,first);assert.deepEqual(JSON.parse(await readFile(file,'utf8')),first);assert.equal((await stat(file)).mode&0o777,0o600);
  const next={...first,status:'failed'};await atomicReport(file,next);assert.equal(JSON.parse(await readFile(file,'utf8')).status,'failed');assert.deepEqual(await readdir(path.dirname(file)),['status.json']);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('group access requires explicit flag and produces root-service-group readable reports without world access',async()=>{
 assert.equal(config.reportGroupRead,false);
 for(const value of ['true','yes','0'])assert.equal(monitorConfig({OASIS_DATABASE_URL:config.databaseUrl,OASIS_MONITOR_REPORT_GROUP_READ:value}).reportGroupRead,false);
 assert.equal(monitorConfig({OASIS_DATABASE_URL:config.databaseUrl,OASIS_MONITOR_REPORT_GROUP_READ:'1'}).reportGroupRead,true);
 const dir=await mkdtemp(path.join(tmpdir(),'oasis-monitor-group-'));
 try{
  const file=path.join(dir,'private','status.json'),report=(await run(healthy())).report;
  await atomicReport(file,report);assert.equal((await stat(path.dirname(file))).mode&0o777,0o700);
  await atomicReport(file,report,{groupRead:true});assert.equal((await stat(file)).mode&0o777,0o640);assert.equal((await stat(path.dirname(file))).mode&0o777,0o750);assert.equal((await stat(file)).gid,process.getgid());
  await atomicReport(file,report);assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await stat(path.dirname(file))).mode&0o777,0o700);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('unreadable prior report is observable; failed persistence cannot claim monitoring succeeded',async()=>{
 const invalid=await run(healthy(),{readPrevious:async()=>{throw new Error(SECRET);}});
 assert.equal(invalid.exitCode,1);assert.equal(JSON.stringify(invalid).includes(SECRET),false);
 await assert.rejects(()=>run(healthy(),{writeReport:async()=>{throw new Error('disk full');}}),/disk full/);
});

test('HTTP checks preserve Host routing, refuse oversized responses and bound slow responses',async t=>{
 const server=createServer((req,res)=>{
  if(req.url==='/slow')return;
  if(req.url==='/large'){res.end('x'.repeat(4096));return;}
  res.end(JSON.stringify({status:'ok',host:req.headers.host}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const url=`http://127.0.0.1:${server.address().port}`;
 const reply=await requestHealth(url,{host:config.host});assert.equal(reply.status,200);assert.equal(JSON.parse(reply.body).host,'game.tianyahuyu.com');
 await assert.rejects(requestHealth(url+'/large',{maxBytes:256}),/RESPONSE_TOO_LARGE/);
 await assert.rejects(requestHealth(url+'/slow',{timeoutMs:25}),/PROBE_TIMEOUT/);
});

test('thresholds are configurable and unsafe numeric or credentialed public origin inputs fail without logging input',()=>{
 const custom=monitorConfig({OASIS_DATABASE_URL:config.databaseUrl,OASIS_MONITOR_OVERDUE_SECONDS:'240',OASIS_MONITOR_BACKLOG_LIMIT:'10'});
 assert.equal(custom.overdueSeconds,240);assert.equal(custom.backlogLimit,10);
 for(const env of [{OASIS_MONITOR_TIMEOUT_MS:'Infinity'},{OASIS_MONITOR_DISK_USED_PERCENT:'105'},{OASIS_PUBLIC_ORIGIN:`https://user:${SECRET}@example.com`}]){
  assert.throws(()=>monitorConfig({OASIS_DATABASE_URL:config.databaseUrl,...env}),error=>!error.message.includes(SECRET)&&error.message==='MONITOR_CONFIG_INVALID');
 }
});
