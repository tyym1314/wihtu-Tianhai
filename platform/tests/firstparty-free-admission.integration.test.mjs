import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {ARENA_IDS,ARENA_GAMES} from '../shared/games.mjs';
import {RUN_PRACTICE_PROFILES} from '../shared/run-practice-profiles.mjs';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';

// An independent production-shaped database and actual HTTP BFF. All identity,
// zero-account, launch, room and ledger behavior is official application code.
// Approval is synthetic, confined to this unique loopback fixture; it is never
// a production approval, a device test, or acceptance of probability math.
const suffix=process.pid+'_'+randomBytes(6).toString('hex'),name='oasis_release_test_'+suffix;
const appId='app_firstparty_'+suffix,origin='https://firstparty-free.example.invalid';
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
const databaseUrl=new URL(adminUrl);databaseUrl.pathname='/'+name;
const previous={...process.env},source='/opt/oasis/releases/20261010-99',manifest='a'.repeat(64),proof='b'.repeat(64),password='Firstparty-fixture-password-2026!';
const uid=prefix=>prefix+'_'+randomBytes(8).toString('hex');
let admin,pool,tx,closePools,closeEnginePool,dir,server,base,created=false,platform,wallet,binding,players,pvp,cycles,admission,app,login,account;
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
 });app=await platform.appById(appId);
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
async function noMoney(){
 for(const table of ['wallet_ledger','wallet_operations','wallet_matches','wallet_reservations','wallet_probability','wallet_transfer_clearing','gp_cycles','gp_operations','gp_plays','gp_transfers','gp_transfer_accounts','gp_transfer_outbox'])assert.equal(await count(table),0,table+' must remain empty');
 const balances=(await pool.query('SELECT available,reserved,credit_pending FROM wallet_users')).rows;assert.ok(balances.length>0);
 for(const row of balances)assert.deepEqual(row,{available:'0',reserved:'0',credit_pending:'0'});
 const scope=(await pool.query('SELECT treasury_available,treasury_reserved,treasury_inbound,fee_available,fee_pending,ledger_version FROM wallet_scopes')).rows;
 assert.equal(scope.length,1);for(const value of Object.values(scope[0]))assert.equal(value,'0');
}

before(async()=>{
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(adminUrl.hostname),'ISOLATED_LOCAL_POSTGRES_REQUIRED');
 assert.equal(adminUrl.pathname,'/postgres','INDEPENDENT_ADMIN_DATABASE_REQUIRED');
 admin=new pg.Pool({connectionString:adminUrl.href,max:1});await admin.query(`CREATE DATABASE "${name}"`);created=true;
 dir=await mkdtemp(join(tmpdir(),'oasis-firstparty-free-'));await writeFile(join(dir,'master.key'),randomBytes(32),{mode:0o600,flag:'wx'});
 Object.assign(process.env,{OASIS_DATABASE_URL:databaseUrl.href,OASIS_ENVIRONMENT:'production',OASIS_LOCAL_DIR:dir,OASIS_START_WALLET:'0',OASIS_PUBLIC_ORIGIN:origin,OASIS_PRODUCTION_ADMISSION_ENABLED:'0',OASIS_ADMISSION_PROFILE:'firstparty-free-v1',OASIS_FIRSTPARTY_APP_ID:appId,OASIS_ADMISSION_RELEASE:source,OASIS_ADMISSION_MANIFEST_SHA256:manifest});
 ({pool,tx,closePools}=await import('../server/db.mjs'));platform=await import('../server/platform.mjs');wallet=await import('../server/wallet/index.mjs');binding=await import('../server/wallet-binding.mjs');players=await import('../server/player-records.mjs');pvp=await import('../server/pvp/index.mjs');cycles=await import('../server/cycles.mjs');admission=await import('../server/production-admission.mjs');
 ({closeEnginePool}=await import('../server/pvp/engine-pool.mjs'));
 assert.equal((await pool.query('SELECT current_database() name')).rows[0].name,name);
 await wallet.migrateWallet(pool);await platform.migratePlatform();await pvp.migratePvp(pool);await binding.migrateWalletBindings(pool);await(await import('../server/runtime-mode.mjs')).migrateRuntime(pool);await(await import('../server/transfers/index.mjs')).migrateTransfers(pool);
 await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,status,game_ids,allowed_origins) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[appId,'Isolated firstparty fixture','partner_oasis_platform','production',uid('wallet'),'','paused',JSON.stringify(ARENA_IDS),JSON.stringify([origin])]);
 app=await platform.appById(appId);await tx(db=>import('../server/platform-wallet.mjs').then(m=>m.createPlatformWallet(db,app,'fixture')));
 await pool.query('INSERT INTO gp_production_admission(app_id,profile,state,revision,scope,currency_scale,allowed_origins,game_ids,release,manifest_sha256,proof_sha256,approved_by,approved_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,now())',[appId,'firstparty-free-v1','closed',JSON.stringify(platform.scope(app)),2,JSON.stringify([origin]),JSON.stringify(ARENA_IDS),source,manifest,proof,'isolated_fixture']);
 const {routePlayer}=await import('../server/player-routes.mjs'),{send}=await import('../server/security.mjs');
 server=createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};
  if(await routePlayer(req,res,req.url,body,raw))return;
  if(req.url==='/v1/launch/exchange'&&req.method==='POST'&&req.headers.origin===origin)return send(res,200,await platform.exchange(body));
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

test('closed policy is real metadata and cannot create users, codes or money',async()=>{
 const metadata=await request('/api/player/app?app_id='+appId);assert.equal(metadata.status,200);assert.equal(metadata.body.admission_open,false);assert.equal(metadata.body.free_training_only,true);assert.equal(metadata.body.financial_admission_enabled,false);assert.deepEqual(metadata.body.game_ids,ARENA_IDS);
 assert.equal('proof_sha256' in metadata.body,false);assert.equal('release' in metadata.body,false);
 const result=await request('/api/player/register',{body:{app_id:appId,username:'closed_player',password}});assert.equal(result.status,409);assert.equal(result.body.error.code,'PRODUCTION_ACCEPTANCE_REQUIRED');
 for(const table of ['gp_players','gp_player_app_ids','gp_sessions','gp_launch_codes','wallet_users','wallet_ledger'])assert.equal(await count(table),0);
});

test('open scope registers a real player, logs in securely and opens one durable zero account',async()=>{
 await setAdmission('open');const result=await request('/api/player/register',{body:{app_id:appId,username:'firstparty_player',password}});assert.equal(result.status,201,JSON.stringify(result.body));account=result.body.player;
 login=await request('/api/player/login',{body:{app_id:appId,username:account.username,password}});assert.equal(login.status,200);assert.equal(login.body.player.id,account.id);assert.match(login.headers.get('set-cookie'),/^__Host-oasis_player=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict;/);assert.equal('token' in login.body,false);
 const walletRead=await request('/api/player/wallet?app_id='+appId,{cookie:login.cookie});assert.equal(walletRead.status,200);assert.equal(walletRead.body.balance.available_minor,'0');assert.equal(walletRead.body.balance.reserved_minor,'0');assert.equal(walletRead.body.balance.ledger_version,'0');
 assert.equal(await count('wallet_users'),1);assert.equal(await count('wallet_keys'),0);await noMoney();
});

test('real one-use launch codes preserve identity and stamp persisted free session provenance',async()=>{
 const session=await launchGame('match'),record=launches.get('match');assert.equal(session.player_id,account.id);assert.equal(session.external_user_id,login.body.external_user_id);assert.equal(session.admission_profile,'firstparty-free-v1');assert.equal(session.admission_revision,'2');
 const replay=await playerLaunch(record.body);assert.equal(replay.status,201);assert.deepEqual(replay.body,record.launched.body);
 const used=await request('/v1/launch/exchange',{body:record.exchangeBody});assert.equal(used.status,401);assert.equal(used.body.error.code,'LAUNCH_CODE_INVALID');
 const noCsrf=await request('/api/player/launch',{body:{...record.body,request_id:uid('csrf')},cookie:login.cookie});assert.equal(noCsrf.status,403);
 await rejectCode(platform.createSession(app,{...platform.scope(app),request_id:uid('hmac'),external_user_id:session.external_user_id,game_id:'match',locale:'en',host_platform:'web'},'{}'),'PLAYER_BFF_REQUIRED');
 const view=await cycles.publicSession(session);assert.equal(view.balance,0);assert.equal(view.mode,'production');assert.equal(view.admission_profile,'firstparty-free-v1');assert.equal(view.admission_revision,'2');assert.equal(view.free_training_only,true);assert.equal(view.financial_admission_enabled,false);assert.deepEqual(view.allowed_room_modes,['bot-practice']);assert.equal(view.mathVersion,null);assert.deepEqual(view.betChoices,[]);
});

test('all eleven official free BOT room paths retain frozen scope and make no wallet commands',async()=>{
 for(const game of ARENA_IDS){
  const session=sessions.get(game)||await launchGame(game),{made}=await makeRoom(session),room=(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[made.body.id])).rows[0];
  assert.equal(room.practice,true);assert.equal(room.entry_minor,'0');assert.equal(room.fee_bps,0);assert.equal(room.terms.admission_profile,'firstparty-free-v1');assert.equal(room.terms.admission_manifest_sha256,manifest);assert.equal(room.terms.admission_proof_sha256,proof);assert.deepEqual(room.scope,platform.scope(app));
  assert.equal(room.players.filter(p=>!p.bot).length,1);assert.equal(room.players.filter(p=>p.bot).length,room.capacity-1);assert.equal(room.players.find(p=>!p.bot).external_user_id,session.external_user_id);
  const ready=await roomPost(session,room.id,'ready');assert.equal(ready.status,200);await pvp.tickPvp({roomIds:[room.id]});
  const left=await roomPost(session,room.id,'leave');assert.equal(left.status,200);assert.ok(['cancelled','settled','voided'].includes(left.body.status));
 }
 assert.equal(await count('pvp_active_users'),0);await noMoney();
});

test('paid, real-human, coerced entry and probability requests fail without financial effects',async()=>{
 const session=sessions.get('match');
 for(const extra of [{practice:false,entry_minor:'1000'},{practice:true,entry_minor:'1000'},{practice:true,entry_minor:0},{practice:true,entry_minor:null}])await rejectCode(pvp.routePvp(session,'POST','/api/pvp/rooms',{request_id:uid('blocked'),game_id:'match',capacity:2,...extra}),'FIRSTPARTY_FREE_PRACTICE_ONLY');
 await rejectCode(pvp.routePvp(sessions.get('towerlink'),'POST','/api/pvp/rooms',{request_id:uid('social'),game_id:'towerlink',capacity:2,practice:false,entry_minor:'0'}),'FIRSTPARTY_FREE_PRACTICE_ONLY');
 const {made}=await makeRoom(session);await rejectCode(roomPost(session,made.body.id,'join'),'FIRSTPARTY_FREE_PRACTICE_ONLY');await roomPost(session,made.body.id,'leave');
 for(const game of ['thunder','tiger']){const result=await playerLaunch({app_id:appId,request_id:uid('probability'),game_id:game,locale:'en',host_platform:'web'});assert.equal(result.status,409);assert.equal(result.body.error.code,'GAME_DISABLED');}
 await rejectCode(cycles.spin({...session,game_id:'thunder'},{requestId:uid('spin'),bet:10,expectedVersion:0}),'PRODUCTION_FINANCIAL_ACCEPTANCE_REQUIRED');
 await noMoney();
});

test('Run protocol v1 and negotiated v2 remain exact and independent of free admission',async()=>{
 const session=sessions.get('run');
 for(const profile of [RUN_PRACTICE_PROFILES.v1,RUN_PRACTICE_PROFILES.v2]){
  const {made}=await makeRoom(session,{run_input_protocol:profile.protocol,...(profile.profileId?{run_input_profile:profile.profileId}:{})});
  const row=(await pool.query('SELECT rule_version,terms FROM pvp_rooms WHERE id=$1',[made.body.id])).rows[0];assert.equal(row.rule_version,profile.ruleVersion);assert.equal(row.terms.admission_profile,'firstparty-free-v1');
  await roomPost(session,made.body.id,'ready');const scene=await roomPost(session,made.body.id,'scene-ready');assert.equal(scene.status,200);await roomPost(session,made.body.id,'leave');
 }await noMoney();
});

test('a server-accepted match action completes after admission close without a ledger payout',async()=>{
 const session=sessions.get('match'),{made}=await makeRoom(session);await roomPost(session,made.body.id,'ready');await pvp.tickPvp({roomIds:[made.body.id]});
 const room=(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[made.body.id])).rows[0];
 const own=room.game_state.players[session.external_user_id],{legalMoves}=await import('../arena/match/engine.mjs');
 const action=legalMoves(own.board)[0];assert.ok(action);await setAdmission('closed');
 const at=Number(room.starts_at)+1,acted=await pvp.routePvp(session,'POST',`/api/pvp/rooms/${room.id}/action`,{request_id:uid('swap'),seq:1,action},{now:at});assert.equal(acted.status,200);
 let final;for(let now=at+3000;now<room.game_state.deadlineAt+3000;now+=3000)final=await pvp.routePvp(session,'GET','/api/pvp/rooms/'+room.id,{}, {now});
 assert.equal(final.status,200);assert.equal(final.body.status,'settled');assert.equal(final.body.result.resolution,'completed');
 const committed=(await pool.query('SELECT result,result_hash,game_state FROM pvp_rooms WHERE id=$1',[room.id])).rows[0];assert.match(committed.result_hash,/^[a-f0-9]{64}$/);assert.equal(committed.game_state.status,'finished');assert.ok(committed.game_state.players[session.external_user_id].score>0);
 assert.equal(committed.result.fee_minor,'0');for(const payout of committed.result.payouts)assert.equal(payout.payout_minor,'0');assert.equal(await count('pvp_active_users'),0);await noMoney();await setAdmission('open');
});

test('failure opening the official zero account rolls back the player and App mapping',async()=>{
 const prior=await count('gp_players');
 await pool.query(`CREATE FUNCTION reject_firstparty_fixture_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture account unavailable'; END $$;
  CREATE TRIGGER reject_firstparty_fixture_account BEFORE INSERT ON wallet_users FOR EACH ROW EXECUTE FUNCTION reject_firstparty_fixture_account()`);
 try{await rejectCode(players.registerPlayer('rollback_firstparty',password,appId),'P0001');assert.equal(await count('gp_players'),prior);assert.equal((await pool.query("SELECT 1 FROM gp_players WHERE username='rollback_firstparty'")).rowCount,0);assert.equal(await count('gp_player_app_ids'),1);assert.equal(await count('wallet_users'),1);}
 finally{await pool.query('DROP TRIGGER reject_firstparty_fixture_account ON wallet_users; DROP FUNCTION reject_firstparty_fixture_account()');}
 await noMoney();
});

test('closed after real play keeps accepted replay, resume, login, ready and exit authority',async()=>{
 const session=sessions.get('match'),{body,made}=await makeRoom(session);await setAdmission('closed');
 const metadata=await request('/api/player/app?app_id='+appId);assert.equal(metadata.body.admission_open,false);assert.equal(metadata.body.free_training_only,true);
 const relogin=await request('/api/player/login',{body:{app_id:appId,username:account.username,password}});assert.equal(relogin.status,200);assert.equal(relogin.body.external_user_id,session.external_user_id);
 const repeated=await pvp.routePvp(session,'POST','/api/pvp/rooms',body);assert.deepEqual(repeated,made);const changed={...body,capacity:3};await rejectCode(pvp.routePvp(session,'POST','/api/pvp/rooms',changed),'IDEMPOTENCY_CONFLICT');
 const ready=await roomPost(session,made.body.id,'ready');assert.equal(ready.status,200);await pvp.tickPvp({roomIds:[made.body.id]});
 const recovered=await request('/api/player/recovery?app_id='+appId,{cookie:relogin.cookie});assert.equal(recovered.status,200);assert.ok(recovered.body.sessions.some(v=>v.session_id===session.id));
 const record=launches.get('match'),replay=await playerLaunch(record.body);assert.equal(replay.status,201);assert.deepEqual(replay.body,record.launched.body);
 const resumed=await playerLaunch({...record.body,request_id:uid('resume'),resume_session_id:session.id});assert.equal(resumed.status,201);assert.equal(resumed.body.session_id,session.id);
 const resumedExchange=await request('/v1/launch/exchange',{body:{launch_code:resumed.body.launch_code,client_instance_id:uid('resumeclient'),host_origin:origin,game_id:'match'}});assert.equal(resumedExchange.status,200);
 const reauthorized=await platform.playSession({headers:{authorization:'Bearer '+resumedExchange.body.access_token}});assert.equal(reauthorized.id,session.id);
 const rejected=await playerLaunch({...record.body,request_id:uid('closednew')});assert.equal(rejected.status,409);assert.equal(rejected.body.error.code,'PRODUCTION_ACCEPTANCE_REQUIRED');
 await rejectCode(players.registerPlayer('closed_late_player',password,appId),'PRODUCTION_ACCEPTANCE_REQUIRED');await rejectCode(makeRoom(reauthorized),'PRODUCTION_ACCEPTANCE_REQUIRED');
 const snapshot=await pvp.routePvp(reauthorized,'GET','/api/pvp/rooms/'+made.body.id);assert.equal(snapshot.status,200);await roomPost(reauthorized,made.body.id,'leave');assert.equal(await count('pvp_active_users'),0);await noMoney();
});

test('a concurrent close holds App then policy locks; blocked new work resumes only to reject',async()=>{
 await setAdmission('open');const session=sessions.get('golf'),blocker=await pool.connect();let tasks=[];
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT id FROM gp_apps WHERE id=$1 FOR UPDATE',[appId]);await blocker.query('SELECT app_id FROM gp_production_admission WHERE app_id=$1 FOR UPDATE',[appId]);
  await blocker.query("UPDATE gp_apps SET status='paused' WHERE id=$1",[appId]);await blocker.query("UPDATE gp_production_admission SET state='closed',revision=revision+1 WHERE app_id=$1",[appId]);
  tasks=[players.registerPlayer('race_late_player',password,appId),makeRoom(session),platform.createSession(app,{...platform.scope(app),request_id:uid('race_launch'),game_id:'golf',locale:'en',host_platform:'web',host_origin:origin},'race_launch',{playerId:account.id})].map(p=>p.then(value=>({value}),error=>({error})));
  let waiters=0;for(let attempt=0;attempt<150;attempt++){waiters=(await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%gp_apps%' ")).rows[0].n;if(waiters>=3)break;await delay(20);}assert.ok(waiters>=3,'all three admission paths must wait on actual PostgreSQL App locks');
  await blocker.query('COMMIT');const outcomes=await Promise.all(tasks);for(const result of outcomes)assert.equal(result.error?.code,'PRODUCTION_ACCEPTANCE_REQUIRED');
 }finally{await blocker.query('ROLLBACK');blocker.release();await Promise.all(tasks);}
 app=await platform.appById(appId);assert.equal((await pool.query("SELECT 1 FROM gp_players WHERE username='race_late_player'")).rowCount,0);assert.equal(await count('pvp_active_users'),0);await noMoney();
});

test('source, App, scope and user balance changes are not accepted from stale input',async()=>{
 await setAdmission('open');const stale=app;
 await pool.query("UPDATE gp_production_admission SET manifest_sha256=$2 WHERE app_id=$1",[appId,'c'.repeat(64)]);
 try{await rejectCode(tx(db=>admission.readProductionAdmission(db,stale,{intent:'session'})),'FIRSTPARTY_SOURCE_APPROVAL_REQUIRED');}finally{await pool.query('UPDATE gp_production_admission SET manifest_sha256=$2 WHERE app_id=$1',[appId,manifest]);}
 await pool.query('UPDATE gp_apps SET currency_scale=3 WHERE id=$1',[appId]);
 try{await rejectCode(tx(db=>admission.readProductionAdmission(db,stale,{intent:'session'})),'FIRSTPARTY_APP_CONFIG_CHANGED');}finally{await pool.query('UPDATE gp_apps SET currency_scale=2 WHERE id=$1',[appId]);}
 await pool.query('UPDATE wallet_users SET available=1 WHERE external_user_id=$1',[login.body.external_user_id]);
 try{const result=await playerLaunch({app_id:appId,request_id:uid('dirtybalance'),game_id:'golf',locale:'en',host_platform:'web'});assert.equal(result.status,409);assert.equal(result.body.error.code,'FIRSTPARTY_FINANCIAL_STATE_NOT_EMPTY');}finally{await pool.query('UPDATE wallet_users SET available=0 WHERE external_user_id=$1',[login.body.external_user_id]);}
 const foreign=await platform.createApp('Other isolated platform App',{partnerId:'partner_oasis_platform',walletProvider:'external'});await pool.query("UPDATE gp_apps SET status='active',allowed_origins=$2 WHERE id=$1",[foreign.app.id,JSON.stringify([origin])]);
 await rejectCode(players.registerPlayer('foreign_app_player',password,foreign.app.id),'FIRSTPARTY_APP_REQUIRED');await setAdmission('closed');await noMoney();
});
