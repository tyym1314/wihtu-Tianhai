import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {monitorConfig,createProbes} from '../deploy/monitor.mjs';
import {readWalletDependencies,checkWalletDependencies} from '../server/dependency-health.mjs';

// A real, independent production database and real API HTTP server behind a
// declared HTTPS origin. These loopback checks do not claim public TLS coverage.
const root=resolve(import.meta.dirname,'..'),origin='https://provider-health.example.invalid',externalOrigin='https://wallet.example.invalid';
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
if(!['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname))throw Error('ISOLATED_LOCAL_POSTGRES_REQUIRED');
const name='oasis_runtime_prod_'+process.pid+'_'+randomBytes(6).toString('hex');
let admin,db,made=false,dir,child,ended,sentinel,referenceCalls=0,port,referencePort,base,cookie,partnerCookie,platformApp,externalApp;
const databaseUrl=new URL(adminUrl);databaseUrl.pathname='/'+name;
const dependencies={environment:'production',referenceOrigin:'http://127.0.0.1:1',allowedOrigins:[externalOrigin]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,body,auth=cookie){
 const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(auth?{Cookie:auth}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
 return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
function config(extra={}){return monitorConfig({OASIS_ENVIRONMENT:'production',OASIS_START_WALLET:'0',OASIS_DATABASE_URL:databaseUrl.href,OASIS_API_PORT:String(port),OASIS_WALLET_PORT:String(referencePort),OASIS_REFERENCE_WALLET_URL:`http://127.0.0.1:${referencePort}`,OASIS_PUBLIC_ORIGIN:origin,OASIS_WALLET_ALLOWED_ORIGINS:externalOrigin,OASIS_MONITOR_BACKUP_DIR:join(dir,'backups'),OASIS_MONITOR_STATUS_FILE:join(dir,'reports','status.json'),OASIS_MONITOR_BACKUP_UNIT:'oasis-production-backup.service',OASIS_MONITOR_BACKUP_TIMER:'oasis-production-backup.timer',...extra});}
before(async()=>{
 admin=new pg.Pool({connectionString:adminUrl.href,max:1});assert.match(name,/^oasis_runtime_prod_\d+_[a-f0-9]{12}$/);await admin.query(`CREATE DATABASE "${name}"`);made=true;
 db=new pg.Pool({connectionString:databaseUrl.href,max:2});dir=await mkdtemp(join(tmpdir(),'oasis-provider-health-'));await mkdir(join(dir,'state'),{mode:0o700});await writeFile(join(dir,'state','master.key'),randomBytes(32),{mode:0o600,flag:'wx'});
 sentinel=createServer((_req,res)=>{referenceCalls++;res.end(JSON.stringify({status:'ok',service:'reference-partner-wallet',deployment:'local-reference-not-a-partner-production-wallet'}));});await new Promise(r=>sentinel.listen(0,'127.0.0.1',r));referencePort=sentinel.address().port;
 const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));port=socket.address().port;await new Promise(r=>socket.close(r));base=`http://127.0.0.1:${port}`;
 child=spawn(process.execPath,['--import','tsx','server/index.mjs'],{cwd:root,env:{...process.env,OASIS_DATABASE_URL:databaseUrl.href,OASIS_LOCAL_DIR:join(dir,'state'),OASIS_ENVIRONMENT:'production',OASIS_MONITOR_STATUS_FILE:join(dir,'reports','status.json'),OASIS_PRODUCTION_ADMISSION_ENABLED:'0',OASIS_START_WALLET:'0',OASIS_API_PORT:String(port),OASIS_WALLET_PORT:String(referencePort),OASIS_REFERENCE_WALLET_URL:`http://127.0.0.1:${referencePort}`,OASIS_PUBLIC_ORIGIN:origin,OASIS_WALLET_ALLOWED_ORIGINS:externalOrigin},stdio:['ignore','ignore','ignore']});
 ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 let ready=false;for(let i=0;i<180;i++){if(child.exitCode!==null)throw Error('Fixture API exited before readiness');try{if((await api('/health/ready',undefined,null)).body.environment==='production'){ready=true;break;}}catch{}await sleep(60);}assert.equal(ready,true);
 const credentials=JSON.parse(await readFile(join(dir,'state','development-credentials.json'),'utf8'));const login=await api('/api/admin/login',credentials,null);assert.equal(login.status,200);cookie=login.cookie;
});
after(async()=>{
 const errors=[];
 if(child?.exitCode===null){child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await ended;}catch(e){errors.push(e);}finally{clearTimeout(timer);}}
 if(sentinel?.listening)await new Promise(r=>sentinel.close(r));await db?.end();
 if(made)try{await dropOwnedTestDatabase(admin,name,{created:true});}catch(e){errors.push(e);}await admin?.end();
 if(dir)await rm(dir,{recursive:true,force:true});if(errors.length)throw new AggregateError(errors,'Provider health fixture cleanup failed');
});

test('real production startup without Apps does not require the healthy reference sentinel',async()=>{
 const session=await api('/api/admin/session');assert.equal(session.body.environment,'production');
 const health=await api('/api/admin/health');assert.equal(health.status,200);assert.equal(health.body.wallet,'ok');assert.equal(health.body.production_enabled,false);assert.equal(health.body.wallet_dependencies.reference_required,false);
 const probes=createProbes(config());assert.deepEqual(await probes.api(),{reachable:true});assert.equal((await probes.wallet()).status,'ok');assert.equal(Number((await probes.database()).cycles_pending),0);assert.equal(referenceCalls,0);
});
test('mixed production external App cannot be hidden by healthy platform or reference wallet',async()=>{
 const account=await api('/api/admin/partner-accounts',{name:'Health fixture',username:'provider_health',password:'Provider-health-fixture-2026!'});assert.equal(account.status,201);
 const login=await api('/api/partner/login',{username:'provider_health',password:'Provider-health-fixture-2026!'},null);assert.equal(login.status,200);partnerCookie=login.cookie;
 const created=await api('/api/partner/apps',{name:'External wallet health',wallet_provider:'external'},partnerCookie);assert.equal(created.status,201);externalApp=created.body.app;
 assert.equal((await api('/api/admin/health')).body.wallet,'ok','paused pristine unconfigured App is not admitted');
 const bound=await api(`/api/partner/apps/${externalApp.id}/integration/wallet`,{wallet_url:externalOrigin,wallet_key_id:'health_fixture_key',wallet_secret_base64:randomBytes(32).toString('base64')},partnerCookie);assert.equal(bound.status,200);
 const paused=await api('/api/admin/health');assert.equal(paused.body.wallet,'ok');assert.equal(paused.body.wallet_dependencies.external_connectivity,'not_checked');
 // Fixture-only state models an App admitted by a separately approved runtime.
 await db.query("UPDATE gp_apps SET status='active' WHERE id=$1",[externalApp.id]);
 try{
  const health=await api('/api/admin/health');assert.equal(health.body.wallet,'unavailable');assert.deepEqual(health.body.wallet_dependencies.codes,['EXTERNAL_WALLET_PROBE_REQUIRED']);
  const probes=createProbes(config());assert.equal((await probes.wallet()).status,'failed');assert.equal(Number((await probes.database()).cycles_pending),0);assert.equal(referenceCalls,0);
 }finally{await db.query("UPDATE gp_apps SET status='paused' WHERE id=$1",[externalApp.id]);}
});
test('wrong real DB environment or missing ledger schema cannot be masked by production API liveness',async()=>{
 await db.query("UPDATE gp_runtime_identity SET environment='sandbox'");
 try{const probes=createProbes(config());assert.deepEqual(await probes.api(),{reachable:true});await assert.rejects(probes.database(),/DATABASE_ENVIRONMENT_MISMATCH/);await assert.rejects(probes.wallet(),/DATABASE_ENVIRONMENT_MISMATCH/);assert.equal((await api('/api/admin/health')).body.wallet,'unavailable');}
 finally{await db.query("UPDATE gp_runtime_identity SET environment='production'");}
 await db.query('ALTER TABLE wallet_ledger RENAME TO fixture_hidden_wallet_ledger');
 try{await assert.rejects(readWalletDependencies(db,dependencies),/WALLET_SCHEMA_MISSING/);assert.equal((await api('/api/admin/health')).body.wallet,'unavailable');}
 finally{await db.query('ALTER TABLE fixture_hidden_wallet_ledger RENAME TO wallet_ledger');}
});
test('dependency checks execute in an explicitly READ ONLY transaction with no accounts or money created',async()=>{
 const client=await db.connect();let reads=0;
 try{await client.query('BEGIN READ ONLY');const result=await checkWalletDependencies(client,dependencies,{request:async()=>{reads++;throw Error('Must not call');}});assert.equal(result.status,'ok');await client.query('COMMIT');}
 finally{await client.query('ROLLBACK');client.release();}
 assert.equal(reads,0);assert.equal(referenceCalls,0);assert.equal((await db.query('SELECT count(*)::int n FROM wallet_ledger')).rows[0].n,0);
});
test('production backup requires runtime/database receipt, not a fresh sandbox-shaped directory',async()=>{
 const folder=join(dir,'backups','20261008T000000Z');await mkdir(folder,{recursive:true});
 for(const file of ['SHA256SUMS','database.dump','private-config.tar.gz','release.txt','database-contents.txt'])await writeFile(join(folder,file),'fixture-only', {flag:'wx'});
 const probe=()=>createProbes(config()).backup();await assert.rejects(probe(),/BACKUP_MISSING/);
 for(const identity of [{environment:'sandbox',database:name},{environment:'production',database:'other_database'}]){await writeFile(join(folder,'runtime-identity.json'),JSON.stringify(identity));await assert.rejects(probe(),/BACKUP_MISSING/);}
 await writeFile(join(folder,'runtime-identity.json'),JSON.stringify({environment:'production',database:name}));assert.ok(Number.isFinite((await probe()).completedAtMs));
});


test('real admin operations status rejects fresh sandbox report and accepts only complete matching production report',async()=>{
 const folder=join(dir,'reports');await mkdir(folder,{recursive:true});
 const report={schema_version:1,environment:'sandbox',checked_at:new Date().toISOString(),status:'ok',checks:['database','api','wallet','ingress','systemd','backup','disks','certificate'].map(name=>({name,status:'ok',codes:[],metrics:{}}))};
 await writeFile(join(folder,'status.json'),JSON.stringify(report));
 assert.equal((await api('/api/admin/operations-status')).body.monitor.status,'unavailable');
 report.environment='production';await writeFile(join(folder,'status.json'),JSON.stringify(report));
 assert.equal((await api('/api/admin/operations-status')).body.monitor.status,'ok');
 delete report.environment;await writeFile(join(folder,'status.json'),JSON.stringify(report));
 assert.equal((await api('/api/admin/operations-status')).body.monitor.status,'unavailable');
});
