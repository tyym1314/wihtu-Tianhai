import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {evaluateWalletDependencies,readWalletDependencies,referenceWalletHealth} from '../server/dependency-health.mjs';
import {monitorConfig,createProbes,collectHealth,requestHealth} from '../deploy/monitor.mjs';
const referenceOrigin='http://127.0.0.1:8798',wallet='https://wallet.example.invalid';
const options={environment:'production',referenceOrigin,allowedOrigins:[wallet]};
const row=()=>({id:'app',partner_id:'partner',environment:'production',status:'active',wallet_scope_id:'wallet',currency_id:'CREDITS',currency_scale:2,wallet_url:'',provider:'platform',binding_url:null,wallet_key_id:null,
 binding_scope:{partner_id:'partner',app_id:'app',environment:'production',wallet_scope_id:'wallet',currency_id:'CREDITS'},wallet_key_ready:false,ledger_scope_ready:true,has_obligations:false});
const external=()=>({...row(),provider:'external',wallet_url:wallet,binding_url:wallet,wallet_key_id:'key',wallet_key_ready:true,ledger_scope_ready:false});
const sandbox=()=>({...row(),environment:'sandbox',provider:null,binding_scope:null,wallet_url:referenceOrigin,wallet_key_ready:true});
const productionEnv={OASIS_ENVIRONMENT:'production',OASIS_START_WALLET:'0',OASIS_DATABASE_URL:'postgres://fixture@127.0.0.1/database',OASIS_API_PORT:'18891',OASIS_PUBLIC_ORIGIN:'https://production.example.invalid',OASIS_MONITOR_BACKUP_DIR:'/opt/oasis/production-backups',OASIS_MONITOR_STATUS_FILE:'/opt/oasis/private/production/monitor/status.json',OASIS_MONITOR_BACKUP_UNIT:'oasis-production-backup.service',OASIS_MONITOR_BACKUP_TIMER:'oasis-production-backup.timer'};

test('all-platform production has no reference dependency, including an empty runtime',()=>{
 for(const rows of [[],[row()]]){const result=evaluateWalletDependencies(rows,options);assert.equal(result.status,'ok');assert.equal(result.reference_required,false);assert.equal(result.external_required,0);}
});
test('active external is explicitly unverified even beside a healthy internal ledger; paused obligations still require it',()=>{
 for(const a of [external(),{...external(),status:'paused',has_obligations:true}]){
  const result=evaluateWalletDependencies([row(),{...a,id:'second',binding_scope:{...a.binding_scope,app_id:'second'}}],options);
  assert.equal(result.status,'failed');assert.deepEqual(result.codes,['EXTERNAL_WALLET_PROBE_REQUIRED']);assert.equal(result.external_connectivity,'not_checked');assert.equal(result.reference_required,false);
 }
 const paused=evaluateWalletDependencies([{...external(),status:'paused'}],options);assert.equal(paused.status,'ok');assert.equal(paused.providers.external,1);assert.equal(paused.external_connectivity,'not_checked');
});
test('pristine paused external App can remain unconfigured; activation and obligations cannot',()=>{
 const a={...row(),provider:null,binding_scope:null,ledger_scope_ready:false,status:'paused'};
 assert.equal(evaluateWalletDependencies([a],options).status,'ok');
 for(const change of [{status:'active'},{has_obligations:true},{wallet_url:wallet}])assert.ok(evaluateWalletDependencies([{...a,...change}],options).codes.includes('WALLET_BINDING_REQUIRED'));
});
test('provider, scope, runtime, key, URL and ledger errors never fall back to reference health',()=>{
 for(const patch of [{provider:'unknown'},{environment:'sandbox'},{binding_scope:{...row().binding_scope,app_id:'other'}},{ledger_scope_ready:false},{wallet_url:referenceOrigin},{binding_url:wallet},{wallet_key_id:'key'}])assert.equal(evaluateWalletDependencies([{...row(),...patch}],options).status,'failed');
 for(const patch of [{wallet_key_ready:false},{wallet_url:referenceOrigin,binding_url:referenceOrigin},{wallet_url:'https://other.example.invalid',binding_url:'https://other.example.invalid'},{binding_url:'https://other.example.invalid'}])assert.ok(evaluateWalletDependencies([{...external(),...patch}],options).codes.includes('EXTERNAL_WALLET_NOT_CONFIGURED'));
 assert.throws(()=>evaluateWalletDependencies(Array(2001).fill(row()),options),/INVENTORY_INVALID/);
});
test('sandbox reference and external Apps are evaluated separately; production cannot accept the reference binding',()=>{
 const result=evaluateWalletDependencies([sandbox()],{...options,environment:'sandbox'});assert.equal(result.status,'ok');assert.equal(result.reference_required,true);
 assert.equal(evaluateWalletDependencies([{...sandbox(),wallet_url:wallet}],{...options,environment:'sandbox'}).status,'failed');
 assert.equal(evaluateWalletDependencies([{...sandbox(),environment:'production'}],options).status,'failed');
 const mixed=evaluateWalletDependencies([sandbox(),{...external(),environment:'sandbox',binding_scope:{...row().binding_scope,environment:'sandbox'}}],{...options,environment:'sandbox'});
 assert.equal(mixed.reference_required,true);assert.ok(mixed.codes.includes('EXTERNAL_WALLET_PROBE_REQUIRED'));
});
test('database identity and missing ledger tables fail closed without driver/body data',async()=>{
 for(const rows of [[],[{environment:'sandbox'}],[{environment:'production'},{environment:'production'}]])await assert.rejects(readWalletDependencies({query:async()=>({rows})},options),/DATABASE_ENVIRONMENT_MISMATCH/);
 const db={query:async(sql)=>({rows:sql.includes('gp_runtime_identity')?[{environment:'production'}]:[{name:'wallet_scopes',relation:null}]})};
 await assert.rejects(readWalletDependencies(db,options),/WALLET_SCHEMA_MISSING/);
});
test('reference HTTP requires its exact service marker, not an unrelated healthy API',async t=>{
 let body={status:'ok',environment:'sandbox'};
 const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(body));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${server.address().port}`;
 await assert.rejects(referenceWalletHealth(url,{request:requestHealth}),/REFERENCE_HEALTH_INVALID/);
 body={status:'ok',service:'reference-partner-wallet',deployment:'local-reference-not-a-partner-production-wallet'};
 assert.deepEqual(await referenceWalletHealth(url,{request:requestHealth}),{reachable:true});
});
test('production API probe really rejects sandbox/missing identity, wrong endpoint and non-200 HTTP',async t=>{
 let body={status:'ok',environment:'sandbox'},status=200;const paths=[];
 const server=createServer((req,res)=>{paths.push(req.url);res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const config=monitorConfig({...productionEnv,OASIS_API_PORT:String(server.address().port)}),probe=createProbes(config).api;
 for(const value of [{status:'ok',environment:'sandbox'},{status:'ok'}, {status:'failed',environment:'production'}]){body=value;await assert.rejects(probe());}
 body={status:'ok',environment:'production'};assert.deepEqual(await probe(),{reachable:true});status=503;await assert.rejects(probe());
 assert.deepEqual(new Set(paths),new Set(['/health/ready']));
});
test('production requires independent operational dependencies and excludes demo/reference services',()=>{
 const config=monitorConfig(productionEnv);assert.equal(config.production,true);assert.equal(config.serviceUnits.includes('oasis-demo.service'),false);assert.equal(config.serviceUnits.includes('oasis-api.service'),false);assert.equal(config.serviceUnits.includes('oasis-production.service'),true);
 for(const key of ['OASIS_START_WALLET','OASIS_API_PORT','OASIS_PUBLIC_ORIGIN','OASIS_MONITOR_BACKUP_DIR','OASIS_MONITOR_STATUS_FILE','OASIS_MONITOR_BACKUP_UNIT','OASIS_MONITOR_BACKUP_TIMER']){const env={...productionEnv};delete env[key];assert.throws(()=>monitorConfig(env),/MONITOR_(?:PRODUCTION_|CONFIG_INVALID)/);}
 for(const environment of ['prod','staging',''])assert.throws(()=>monitorConfig({...productionEnv,OASIS_ENVIRONMENT:environment||'unknown'}),/MONITOR_CONFIG_INVALID/);
 for(const unit of ['nginx.service','oasis-api.service','oasis-demo.service','oasis-production.service','oasis-certificate.service'])assert.throws(()=>monitorConfig({...productionEnv,OASIS_MONITOR_BACKUP_UNIT:unit,OASIS_MONITOR_BACKUP_TIMER:unit.replace('.service','.timer')}),/MONITOR_CONFIG_INVALID/);
 assert.throws(()=>monitorConfig({...productionEnv,OASIS_MONITOR_BACKUP_TIMER:'oasis-unrelated.timer'}),/MONITOR_CONFIG_INVALID/);
});
test('production cannot green with shallow wallet reachability; excludes demo only by its validated runtime config',async()=>{
 const config=monitorConfig(productionEnv),now=Date.now(),deps=evaluateWalletDependencies([row()],options);
 let demoCalls=0;const probes={database:async()=>({transfer_schema:'present',...Object.fromEntries(['pending_transfers','transfers_overdue','clearing_mismatches','transfer_order_mismatches','wallet_hold_mismatches','cycles_pending','cycles_overdue','probability_operations_pending','probability_operations_overdue','pvp_operations_pending','pvp_operations_overdue','rooms_faulted','rooms_overdue'].map(x=>[x,0]))}),api:async()=>({reachable:true}),ingress:async()=>({reachable:true}),wallet:async()=>deps,demo:async()=>{demoCalls++;throw Error('No demo');},systemd:async()=>Object.fromEntries(config.serviceUnits.map(x=>[x,{LoadState:'loaded',ActiveState:config.jobUnits.includes(x)?'inactive':'active',Result:'success',ExecMainStatus:'0'}])),backup:async()=>({completedAtMs:now-1000}),disks:async()=>config.diskPaths.map(()=>({usedPercent:20})),certificate:async()=>({expiresAtMs:now+30*86400000,validFromMs:now-1000,hostnameMatches:true})};
 assert.equal((await collectHealth(config,probes,{now})).status,'ok');assert.equal(demoCalls,0);
 probes.wallet=async()=>({reachable:true});const falseGreen=await collectHealth(config,probes,{now});assert.equal(falseGreen.status,'failed');assert.deepEqual(falseGreen.checks.find(c=>c.name==='wallet').codes,['DEPENDENCY_REPORT_INVALID']);
 probes.wallet=async()=>evaluateWalletDependencies([row(),external()],options);assert.equal((await collectHealth(config,probes,{now})).status,'failed');
});
