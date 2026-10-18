import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {ARENA_IDS,RELEASED_IDS,ARENA_GAMES} from '../shared/games.mjs';
import {RUN_PRACTICE_PROFILES} from '../shared/run-practice-profiles.mjs';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';

// An independent production-shaped database and actual HTTP BFF. All identity,
// account, launch, room and real internal ledger behavior is official application code.
// Approval is synthetic, confined to this unique loopback fixture; it is never
// a production approval, a device test, or acceptance of probability math.
const suffix=process.pid+'_'+randomBytes(6).toString('hex'),name='oasis_release_test_'+suffix;
const appId='app_firstparty_'+suffix,origin='https://internal-games.example.invalid';
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
const databaseUrl=new URL(adminUrl);databaseUrl.pathname='/'+name;
const previous={...process.env},source='/opt/oasis/releases/20261010-99',manifest='a'.repeat(64),proof='b'.repeat(64),password='Firstparty-fixture-password-2026!';
const uid=prefix=>prefix+'_'+randomBytes(8).toString('hex');
let inspectionExpected,seamEvidence;
let admin,pool,tx,closePools,closeEnginePool,dir,server,base,created=false,platform,wallet,binding,players,pvp,cycles,admission,app,login,account;
const policyFields=['app_id','profile','state','revision','scope','currency_scale','allowed_origins','game_ids','release','manifest_sha256','proof_sha256','approved_by','approved_at'];
const pythonScript=String.raw`import sys,json,importlib.util
from pathlib import Path
v=json.load(sys.stdin);base=Path(v['base'])
def load(name,file):
 s=importlib.util.spec_from_file_location(name,base/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
c=load('owned_test_core','upgrade-admission.py');a=load('owned_test_admission','admission-runtime.py')
if v['mode']=='snapshot':print(json.dumps({'sql':c.snapshot_sql(v['app_id'],profile=v['profile'])}))
else:
 r=load('owned_test_refresh','refresh-firstparty-source.py');r.SOURCE=Path(v['before_release']);r.SOURCE_MANIFEST=v['before_manifest'];c.OID=v['database_oid']
 policy=r.refresh_policy(v['data']['policy'],v['approval'],Path(v['target']),v['manifest'],v['proof'],target_profile=a.INTERNAL_PROFILE)
 sql=r.policy_sql(c,v['data'],policy)
 # Bind only the owned fixture's DB identity. Every App/policy/binding/wallet CAS
 # and the actual production migration statements stay unmodified.
 sql=sql.replace("current_database()!='oasis_production'", "current_database()!="+c.literal(v['database']))
 print(json.dumps({'sql':sql,'policy':policy}))
`;
function python(value){const result=spawnSync('python3',['-c',pythonScript],{input:JSON.stringify({base:fileURLToPath(new URL('../deploy/production-instance/',import.meta.url)),...value}),encoding:'utf8',timeout:10000,maxBuffer:8388608});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
async function snapshot(profile){const sql=python({mode:'snapshot',app_id:appId,profile}).sql;const results=await pool.query(sql);return results.flatMap(r=>r.rows||[]).find(r=>r.json_build_object)?.json_build_object;}
async function savePolicy(){const row=(await pool.query('SELECT * FROM gp_production_admission WHERE app_id=$1',[appId])).rows[0];inspectionExpected.policy_approvals.push(Object.fromEntries(policyFields.map(key=>[key,key==='approved_at'?row[key].toISOString():row[key]])));}
const launches=new Map(),sessions=new Map();
const request=async(path,{body,cookie,headers={},method=body===undefined?'GET':'POST'}={})=>{
 const response=await fetch(base+path,{method,headers:{origin,...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
 return{status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
};
const playerLaunch=body=>request('/api/player/launch',{body,cookie:login.cookie,headers:{'x-oasis-csrf':login.body.csrf_token}});
const count=async table=>(await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
async function setAdmission(state){
 await tx(async db=>{
  await db.query('SELECT id FROM gp_apps WHERE id=$1 FOR UPDATE',[appId]);
  await db.query('SELECT app_id FROM gp_production_admission WHERE app_id=$1 FOR UPDATE',[appId]);
  await db.query('UPDATE gp_apps SET status=$2 WHERE id=$1',[appId,state==='open'?'active':'paused']);
  await db.query('UPDATE gp_production_admission SET state=$2,revision=revision+1,updated_at=now() WHERE app_id=$1',[appId,state]);
 });app=await platform.appById(appId);if(inspectionExpected)await savePolicy();
}
async function launchGame(game,extra={}){
 const body={app_id:appId,request_id:uid('launch'),game_id:game,locale:'en',host_platform:'web',...extra};
 const launched=await playerLaunch(body);assert.equal(launched.status,201,JSON.stringify(launched.body));
 const exchangeBody={launch_code:launched.body.launch_code,client_instance_id:uid('client'),host_origin:origin,game_id:game};
 const exchanged=await request('/v1/launch/exchange',{body:exchangeBody});assert.equal(exchanged.status,200,JSON.stringify(exchanged.body));
 const session=await platform.playSession({headers:{authorization:'Bearer '+exchanged.body.access_token}});
 launches.set(game,{body,launched,exchanged,exchangeBody});sessions.set(game,session);return session;
}
async function makeRoom(session,extra={}){
 const body={request_id:uid('room'),game_id:session.game_id,capacity:ARENA_GAMES[session.game_id].players[0],practice:true,entry_minor:'0',...extra};
 const made=await pvp.routePvp(session,'POST','/api/pvp/rooms',body);assert.equal(made.status,201);return{body,made};
}
const roomPost=(session,id,verb,body={})=>pvp.routePvp(session,'POST',`/api/pvp/rooms/${id}/${verb}`,{request_id:uid(verb),...body});
const rejectCode=(promise,code)=>assert.rejects(promise,{code});

before(async()=>{
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(adminUrl.hostname),'ISOLATED_LOCAL_POSTGRES_REQUIRED');
 assert.equal(adminUrl.pathname,'/postgres','INDEPENDENT_ADMIN_DATABASE_REQUIRED');
 admin=new pg.Pool({connectionString:adminUrl.href,max:1});await admin.query(`CREATE DATABASE "${name}"`);created=true;
 dir=await mkdtemp(join(tmpdir(),'oasis-internal-games-'));await writeFile(join(dir,'master.key'),randomBytes(32),{mode:0o600,flag:'wx'});
 Object.assign(process.env,{OASIS_DATABASE_URL:databaseUrl.href,OASIS_ENVIRONMENT:'production',OASIS_LOCAL_DIR:dir,OASIS_START_WALLET:'0',OASIS_PUBLIC_ORIGIN:origin,OASIS_PRODUCTION_ADMISSION_ENABLED:'0',OASIS_ADMISSION_PROFILE:'firstparty-internal-games-v1',OASIS_FIRSTPARTY_APP_ID:appId,OASIS_ADMISSION_RELEASE:source,OASIS_ADMISSION_MANIFEST_SHA256:manifest});
 ({pool,tx,closePools}=await import('../server/db.mjs'));platform=await import('../server/platform.mjs');wallet=await import('../server/wallet/index.mjs');binding=await import('../server/wallet-binding.mjs');players=await import('../server/player-records.mjs');pvp=await import('../server/pvp/index.mjs');cycles=await import('../server/cycles.mjs');admission=await import('../server/production-admission.mjs');
 ({closeEnginePool}=await import('../server/pvp/engine-pool.mjs'));
 assert.equal((await pool.query('SELECT current_database() name')).rows[0].name,name);
 await wallet.migrateWallet(pool);await platform.migratePlatform();await pvp.migratePvp(pool);await binding.migrateWalletBindings(pool);await(await import('../server/runtime-mode.mjs')).migrateRuntime(pool);await(await import('../server/transfers/index.mjs')).migrateTransfers(pool);
 await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,status,game_ids,allowed_origins) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[appId,'Isolated firstparty fixture','partner_oasis_platform','production',uid('wallet'),'','paused',JSON.stringify(ARENA_IDS),JSON.stringify([origin])]);
 await pool.query('UPDATE gp_apps SET currency_scale=0 WHERE id=$1',[appId]);
 app=await platform.appById(appId);await tx(db=>import('../server/platform-wallet.mjs').then(m=>m.createPlatformWallet(db,app,'fixture')));
 await pool.query('INSERT INTO gp_production_admission(app_id,profile,state,revision,scope,currency_scale,allowed_origins,game_ids,release,manifest_sha256,proof_sha256,approved_by,approved_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,now())',[appId,'firstparty-free-v1','closed',JSON.stringify(platform.scope(app)),0,JSON.stringify([origin]),JSON.stringify(ARENA_IDS),'/opt/oasis/releases/20261010-98','c'.repeat(64),proof,'isolated_fixture']);
 for(const [module,method]of [['portal','migratePortal'],['credentials','migrateCredentials'],['overview-activity','migrateOverviewActivity'],['integration-checks','migrateIntegrationChecks']])await(await import('../server/'+module+'.mjs'))[method]();
 const {seal}=await import('../server/security.mjs');await pool.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'partner-to-platform',$3)",[uid('key'),appId,seal(randomBytes(32).toString('base64'))]);
 // Recreate the witnessed old zero schema only in this newly owned database.
 await pool.query("ALTER TABLE wallet_scopes DROP COLUMN internal_coin_issued; ALTER TABLE gp_production_admission DROP CONSTRAINT gp_production_admission_profile_check; ALTER TABLE gp_production_admission ADD CONSTRAINT gp_production_admission_profile_check CHECK(profile='firstparty-free-v1')");
 const before=await snapshot('firstparty-free-v1'),tables=(await pool.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY relname")).rows.map(r=>r.relname);
 const reviewed={...before.policy,profile:'firstparty-internal-games-v1',game_ids:RELEASED_IDS,approved_by:'isolated_fixture',approved_at:new Date().toISOString()};
 const prepared=python({mode:'refresh',data:before,approval:reviewed,before_release:before.policy.release,before_manifest:before.policy.manifest_sha256,database:before.database,database_oid:before.database_oid,target:source,manifest,proof});
 const client=await pool.connect();try{
  await client.query('UPDATE wallet_scopes SET treasury_available=1');
  await assert.rejects(client.query(prepared.sql),/WALLET_SCOPE_CHANGED_AFTER_CHECK/);await client.query('ROLLBACK');
  assert.equal((await client.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='wallet_scopes' AND column_name='internal_coin_issued'")).rows[0].n,0,'failed CAS performs no schema edit');
  await client.query('UPDATE wallet_scopes SET treasury_available=0');await client.query(prepared.sql);
 }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
 app=await platform.appById(appId);const after=await snapshot('firstparty-internal-games-v1');
 assert.deepEqual(after.app.game_ids,[...RELEASED_IDS].sort());assert.equal(after.wallet_scope.internal_coin_issued,0);assert.equal(after.policy.state,'closed');assert.equal(after.policy.profile,'firstparty-internal-games-v1');assert.equal(after.financial_rows,0);assert.equal(after.nonzero_money,0);assert.deepEqual(after.internal_audit,{internal_coin_integrity_errors:0,internal_financial_scope_errors:0});
 assert.deepEqual((await pool.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY relname")).rows.map(r=>r.relname),tables);
 seamEvidence={before,after,tables};inspectionExpected={inspection_contract:'production-internal-games-v1',runtime_profile:{profile:'firstparty-internal-games-v1',public_origin:origin,app_id:appId,release:source,manifest_sha256:manifest},policy_approvals:[]};await savePolicy();
 const {routePlayer}=await import('../server/player-routes.mjs'),{send}=await import('../server/security.mjs');
 server=createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};
  admission.assertExternalFinancialRouteAllowed((await import('../server/runtime-mode.mjs')).runtime,req.url);
  if(await routePlayer(req,res,req.url,body,raw))return;
  if(req.url==='/v1/launch/exchange'&&req.method==='POST'&&req.headers.origin===origin)return send(res,200,await platform.exchange(body));
  const game=req.url.match(/^\/api\/play\/(thunder|tiger)\/(session|spin|ack|history)$/);
  if(game){const s=await platform.playSession(req);if(s.game_id!==game[1])throw Object.assign(new Error('scope'),{status:403,code:'SCOPE_FORBIDDEN'});if(game[2]==='session')return send(res,200,await cycles.publicSession(s));if(game[2]==='spin')return send(res,200,await cycles.spin(s,body));if(game[2]==='ack')return send(res,200,await cycles.acknowledge(s,body));if(game[2]==='history')return send(res,200,{rounds:(await pool.query('SELECT payload FROM gp_plays WHERE session_id=$1 ORDER BY created_at DESC',[s.id])).rows.map(r=>r.payload)});}
  send(res,404,{error:{code:'NOT_FOUND'}});
 }catch(error){send(res,error.status||500,{error:{code:error.code||'INTERNAL_ERROR'}});}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{
 const errors=[];if(server?.listening)try{await new Promise(resolve=>server.close(resolve));}catch(error){errors.push(error);}
 try{await closeEnginePool?.();}catch(error){errors.push(error);}try{await closePools?.();}catch(error){errors.push(error);}
 if(created)try{await dropOwnedTestDatabase(admin,name,{created});}catch(error){errors.push(error);}try{await admin?.end();}catch(error){errors.push(error);}
 if(dir)await rm(dir,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);
 if(errors.length)throw new AggregateError(errors,'Firstparty fixture cleanup failed');
});

test('closed internal policy reports thirteen entries but denies new registration and cash gateways',async()=>{
 const metadata=await request('/api/player/app?app_id='+appId);assert.equal(metadata.status,200);assert.deepEqual([...metadata.body.game_ids].sort(),[...RELEASED_IDS].sort());assert.equal(metadata.body.admission_open,false);assert.equal(metadata.body.financial_admission_enabled,false);
 const registration=await request('/api/player/register',{body:{app_id:appId,username:'closed_internal',password}});assert.equal(registration.status,409);
 for(const path of ['/api/player/deposit','/api/player/withdraw','/api/recharge','/v1/transfers']){
  for(const direction of ['IN','OUT']){const r=await request(path,{body:{direction,amount_minor:'100',request_id:uid('cash')}});assert.equal(r.status,409);assert.equal(r.body.error.code,'EXTERNAL_FINANCIAL_ADMISSION_DISABLED');}
 }
 for(const table of ['wallet_ledger','wallet_operations','gp_cycles','gp_transfers','gp_transfer_outbox'])assert.equal(await count(table),0);
});

test('real player registration issues once-only balanced internal funds, login never resets the ledger',async()=>{
 await setAdmission('open');const registration=await request('/api/player/register',{body:{app_id:appId,username:'internal_player',password}});assert.equal(registration.status,201,JSON.stringify(registration.body));account=registration.body.player;
 login=await request('/api/player/login',{body:{app_id:appId,username:account.username,password}});assert.equal(login.status,200);
 const balance=await request('/api/player/wallet?app_id='+appId,{cookie:login.cookie});assert.equal(balance.status,200);assert.equal(balance.body.balance.available_minor,'10000');assert.equal(balance.body.balance.currency_scale,0);
 assert.equal(await count('wallet_operations'),2);assert.equal(await count('wallet_ledger'),4);assert.equal(await count('wallet_math_profiles'),4);assert.equal(await count('wallet_keys'),0);
 const state=(await pool.query('SELECT * FROM wallet_scopes')).rows[0];assert.equal(state.treasury_available,'1000000000');assert.equal(state.internal_coin_issued,'1000010000');assert.equal(state.ledger_version,'4');
 for(let i=0;i<3;i++){const again=await request('/api/player/login',{body:{app_id:appId,username:account.username,password}});assert.equal(again.status,200);}
 assert.equal(await count('wallet_operations'),2);assert.equal(await count('wallet_ledger'),4);
 const conservation=await pool.query('SELECT transaction_id FROM wallet_ledger GROUP BY transaction_id HAVING sum(delta_available+delta_reserved)<>0');assert.equal(conservation.rowCount,0);
});

test('all thirteen sessions are server-authenticated; eleven BOT rooms keep real free rules',async()=>{
 const metadata=await request('/api/player/app?app_id='+appId);assert.equal(metadata.body.financial_admission_enabled,true);assert.equal(metadata.body.probability_admission_enabled,true);assert.deepEqual([...metadata.body.game_ids].sort(),[...RELEASED_IDS].sort());
 for(const game of RELEASED_IDS){const s=await launchGame(game);assert.equal(s.admission_profile,'firstparty-internal-games-v1');assert.equal(s.external_user_id,login.body.external_user_id);}
 const ledgerBefore=await count('wallet_ledger');
 for(const game of ARENA_IDS){const s=sessions.get(game),{made}=await makeRoom(s),r=(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[made.body.id])).rows[0];assert.equal(r.practice,true);assert.equal(r.entry_minor,'0');assert.equal(r.fee_bps,0);assert.equal(r.terms.admission_profile,'firstparty-internal-games-v1');await roomPost(s,r.id,'ready');await pvp.tickPvp({roomIds:[r.id]});await roomPost(s,r.id,'leave');}
 assert.equal(await count('pvp_active_users'),0);assert.equal(await count('wallet_ledger'),ledgerBefore);
});

test('Thunder and Tiger use real authorize/accept/fixed-result/settle, replay and ACK do not spend twice',async()=>{
 for(const game of ['thunder','tiger']){
  const s=sessions.get(game),headers={Authorization:'Bearer '+launches.get(game).exchanged.body.access_token};
  const state=await request(`/api/play/${game}/session`,{headers});assert.equal(state.status,200);assert.equal(state.body.mode,'production');assert.equal(state.body.unitsPerCoin,1);assert.deepEqual(state.body.betChoices,[1000,5000,10000,20000,50000]);
  const body={requestId:uid('spin'),bet:state.body.betChoices[0],expectedVersion:state.body.stateVersion};
  const first=await request(`/api/play/${game}/spin`,{body,headers});assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.round.settlementStatus,'SETTLED');
  const cycle=(await pool.query('SELECT * FROM gp_cycles WHERE id=$1',[first.body.round.cycleId])).rows[0];assert.equal(cycle.status,'SETTLED');assert.equal(cycle.stake_minor,'1000');assert.match(cycle.result_hash,/^[a-f0-9]{64}$/);assert.ok(cycle.seed_enc);
  const financial=(await pool.query('SELECT path,state FROM gp_operations WHERE aggregate_id=$1 ORDER BY created_at',[cycle.id])).rows;assert.deepEqual(financial.map(v=>v.path),['/wallet/v1/probability/authorize','/wallet/v1/probability/accept','/wallet/v1/probability/settle']);assert.ok(financial.every(v=>v.state==='SUCCEEDED'));
  const ledgerBefore=await count('wallet_ledger'),available=(await pool.query('SELECT available FROM wallet_users')).rows[0].available;
  const replay=await request(`/api/play/${game}/spin`,{body,headers});assert.equal(replay.status,200);assert.deepEqual(replay.body.round,first.body.round);assert.equal(await count('wallet_ledger'),ledgerBefore);assert.equal((await pool.query('SELECT available FROM wallet_users')).rows[0].available,available);
  const ack=await request(`/api/play/${game}/ack`,{body:{roundId:first.body.round.id},headers});assert.equal(ack.status,200);assert.equal(ack.body.session.pendingRound,null);assert.equal(await count('wallet_ledger'),ledgerBefore);
  const history=await request(`/api/play/${game}/history`,{headers});assert.equal(history.status,200);assert.equal(history.body.rounds[0].cycleId,cycle.id);
  const funds=await binding.validatedWalletBalance(app,s.external_user_id);assert.equal(Number(funds.balance.available_minor),first.body.round.balanceAfter);assert.equal(funds.balance.reserved_minor,'0');
 }
});

test('ordinary login and wallet scope lock interleave without reverse row/advisory deadlock',async()=>{
 const scopeId=Object.values(platform.scope(app)).join(':'),client=await pool.connect();let loginPromise,loginPid;
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[scopeId]);
  loginPromise=tx(async db=>{loginPid=db.processID;return players.appPlayerId(db,appId,account.id);});
  let waiting=false;for(let i=0;i<100;i++){if(loginPid){const row=(await pool.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[loginPid])).rows[0];if(row?.wait_event==='advisory'){waiting=true;break;}}await delay(5);}
  assert.equal(waiting,true,'login reaches the advisory lock before taking wallet row');
  await client.query('SELECT scope_id FROM wallet_scopes WHERE scope_id=$1 FOR UPDATE NOWAIT',[scopeId]);
  await client.query('COMMIT');await loginPromise;
  assert.equal(await count('wallet_operations'),8,'login does not reissue after the two real cycles');
 }finally{await client.query('ROLLBACK').catch(()=>{});client.release();if(loginPromise)await loginPromise.catch(()=>{});}
});

test('policy close denies new cycles while confirmed result recovery remains available',async()=>{
 await setAdmission('closed');
 for(const game of ['thunder','tiger']){
  const headers={Authorization:'Bearer '+launches.get(game).exchanged.body.access_token},s=sessions.get(game),state=(await request(`/api/play/${game}/session`,{headers})).body;
  const last=(await pool.query('SELECT * FROM gp_cycles WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1',[s.id])).rows[0];
  if(last.result.rounds.length===1){const response=await request(`/api/play/${game}/spin`,{body:{requestId:uid('closed_spin'),bet:state.betChoices[0],expectedVersion:state.stateVersion},headers});assert.equal(response.status,409);assert.equal(response.body.error.code,'PRODUCTION_ACCEPTANCE_REQUIRED');}
 }
 const r=await request('/api/player/register',{body:{app_id:appId,username:'after_close',password}});assert.equal(r.status,409);
 for(const table of ['gp_transfer_bindings','gp_transfer_accounts','gp_transfers','gp_transfer_outbox','wallet_transfer_clearing'])assert.equal(await count(table),0);
});

test('internal issuer is a real conserved account and all legacy integrity keys remain zero',async()=>{
 const {restoreAuditSQL}=await import('../deploy/restore-drill.mjs');
 const result=(await pool.query(restoreAuditSQL(true,{internalGameCoins:true}))).rows[0];
 const audit=result.audit||result.json_build_object||Object.values(result)[0];for(const [key,value]of Object.entries(audit))assert.equal(value,0,key);
 const state=(await pool.query('SELECT internal_coin_issued,ledger_version FROM wallet_scopes')).rows[0];assert.equal(state.internal_coin_issued,'1000010000');assert.equal(Number(state.ledger_version),await count('wallet_ledger'));
});


test('old FREE11 migration uses complete original CAS, keeps all 48 tables (47 + wallet_scope_shards) and starts closed without issued coins',()=>{
 assert.equal(seamEvidence.tables.length,48);assert.equal(seamEvidence.before.app.game_ids.length,11);assert.equal(seamEvidence.after.app.game_ids.length,13);
 const allowed=new Set(['game_ids']);for(const key of Object.keys(seamEvidence.before.app))if(!allowed.has(key))assert.deepEqual(seamEvidence.after.app[key],seamEvidence.before.app[key],key);
 assert.deepEqual(seamEvidence.after.binding,seamEvidence.before.binding);assert.deepEqual(seamEvidence.after.wallet_scope,{...seamEvidence.before.wallet_scope,internal_coin_issued:0});
});

test('new internal SQL audits real nonzero ledger and rejects missing typed resource fields',async()=>{
 const {INTERNAL_AUDIT_SQL,profileInspectSQL,validateProfileInspection,PRODUCTION_TABLES}=await import('../deploy/production-instance/inspect-backup.mjs');
 const audited=(await pool.query(INTERNAL_AUDIT_SQL)).rows[0].json_build_object;assert.deepEqual(audited,{internal_coin_integrity_errors:0,internal_financial_scope_errors:0});
 const current=await snapshot('firstparty-internal-games-v1');assert.ok(current.financial_rows>0);assert.ok(current.nonzero_money>0);assert.equal(current.wallet_scope.internal_coin_issued,1000010000);assert.deepEqual(current.internal_audit,audited);
 // Remove only psql's schema-present dispatch; execute the exact generated read-only SQL.
 const script=profileInspectSQL(inspectionExpected);const start=script.indexOf(" SELECT json_build_object('inspection_contract'"),end=script.indexOf(' \\else',start);assert.ok(start>0&&end>start);
 const results=await pool.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=pg_catalog,public;'+script.slice(start,end)+' COMMIT;');
 const rows=results.flatMap(r=>r.rows||[]),value=rows.find(r=>r.json_build_object)?.json_build_object,identity=rows.find(r=>r.identity)?.identity,master=await(await import('node:fs/promises')).readFile(join(dir,'master.key'));
 try{const verified=validateProfileInspection(value,identity,master,inspectionExpected);assert.equal(Object.keys(verified.audit).length,28);assert.ok(Object.values(verified.audit).every(v=>v===0));assert.equal(Object.keys(verified.row_counts).length,PRODUCTION_TABLES.length);}finally{master.fill(0);}
 const client=await pool.connect();try{
  await client.query('BEGIN');
  await client.query("UPDATE wallet_operations SET operation=operation #- '{receipt,resource,profile}' WHERE kind='issue_internal_coins'");
  const broken=(await client.query(INTERNAL_AUDIT_SQL)).rows[0].json_build_object;assert.ok(broken.internal_coin_integrity_errors>0,'missing profile must fail rather than NULL-pass');
  await client.query('ROLLBACK');await client.query('BEGIN');
  await client.query("UPDATE gp_plays SET payload=payload-'settlementStatus'");
  assert.ok((await client.query(INTERNAL_AUDIT_SQL)).rows[0].json_build_object.internal_financial_scope_errors>0,'missing settled marker fails');
 }finally{await client.query('ROLLBACK');client.release();}
});
