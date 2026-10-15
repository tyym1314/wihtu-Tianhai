import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {firstpartyPlayerFixtureDeclaration,installFirstpartyPlayerFixture} from './firstparty-player-fixture-policy.mjs';

const name=`oasis_release_test_${process.pid}_${randomBytes(6).toString('hex')}`;
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
const databaseUrl=new URL(adminUrl);databaseUrl.pathname='/'+name;
const publicOrigin='https://platform-wallet.example.invalid',password='Isolated-player-fixture-2026!';
const declaration=firstpartyPlayerFixtureDeclaration({databaseName:name,origin:publicOrigin});
const priorEnv={...process.env};
const uid=prefix=>prefix+'_'+randomBytes(8).toString('hex');
let admin,pool,closePools,closeEnginePool,dir,created=false,platform,binding,players,wallet,pvp,runtime,app,registered,mapped,setAdmission;
const scopeOf=value=>Object.fromEntries(['partner_id','environment','wallet_scope_id','currency_id'].map(key=>[key,value[key]]).concat([['app_id',value.id]]));
const scopeId=value=>[value.partner_id,value.id,value.environment,value.wallet_scope_id,value.currency_id].join(':');
const command=(value,path,body)=>binding.walletRequest(value,'POST',path,JSON.stringify({...scopeOf(value),...body}),body.request_id);
// Isolated trusted-wallet arithmetic precondition, never new production admission.
async function historicalApp(options={}){
 const created=await platform.createApp('Platform wallet fixture',{partnerId:uid('partner'),...options});
 await pool.query("UPDATE gp_apps SET allowed_origins=$2,status='active' WHERE id=$1",[created.app.id,JSON.stringify([publicOrigin])]);
 return platform.appById(created.app.id);
}
async function player(value){
 const account=await players.registerPlayer(uid('user'),password,value.id);
 const externalUserId=await players.appPlayerId(pool,value.id,account.id);
 return{...account,externalUserId};
}
async function acceptedHistoricalMapping(value,account){
 // Only this uniquely created loopback fixture DB may seed a previously accepted
 // cross-App session. No public register/launch authority or financial approval
 // is inferred from these historical records.
 assert.equal((await pool.query('SELECT current_database() name')).rows[0].name,name);
 const externalUserId=uid('history_player'),db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query('INSERT INTO gp_player_app_ids(app_id,player_id,external_user_id) VALUES($1,$2,$3)',[value.id,account.id,externalUserId]);
  await db.query('INSERT INTO gp_sessions(id,app_id,external_user_id,game_id,host_origin,player_id) VALUES($1,$2,$3,$4,$5,$6)',[uid('history_session'),value.id,externalUserId,'match',publicOrigin,account.id]);
  assert.equal(await players.appPlayerId(db,value.id,account.id),externalUserId);
  await db.query('COMMIT');return{...account,externalUserId};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
before(async()=>{
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(adminUrl.hostname));
 assert.equal(adminUrl.pathname,'/postgres','INDEPENDENT_ADMIN_DATABASE_REQUIRED');
 admin=new pg.Pool({connectionString:adminUrl.href,max:1});await admin.query(`CREATE DATABASE "${name}"`);created=true;
 dir=await mkdtemp(join(tmpdir(),'oasis-platform-wallet-'));await writeFile(join(dir,'master.key'),randomBytes(32),{mode:0o600});
 Object.assign(process.env,{OASIS_DATABASE_URL:databaseUrl.href,OASIS_ENVIRONMENT:'production',OASIS_LOCAL_DIR:dir,OASIS_START_WALLET:'0',OASIS_PUBLIC_ORIGIN:publicOrigin,...declaration.runtimeEnv,OASIS_WALLET_ALLOWED_ORIGINS:'https://external-wallet.example.invalid'});
 ({pool,closePools}=await import('../server/db.mjs'));platform=await import('../server/platform.mjs');binding=await import('../server/wallet-binding.mjs');players=await import('../server/player-records.mjs');wallet=await import('../server/wallet/index.mjs');pvp=await import('../server/pvp/index.mjs');({runtime}=await import('../server/runtime-mode.mjs'));
 assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
 await wallet.migrateWallet(pool);await platform.migratePlatform();await pvp.migratePvp(pool);await binding.migrateWalletBindings(pool);
 await(await import('../server/runtime-mode.mjs')).migrateRuntime(pool);
 ({closeEnginePool}=await import('../server/pvp/engine-pool.mjs'));
 ({app,setAdmission}=await installFirstpartyPlayerFixture(pool,declaration,{name:'Firstparty zero-account fixture'}));
});
after(async()=>{
 await closeEnginePool?.();await closePools?.();if(created)await dropOwnedTestDatabase(admin,name,{created});await admin?.end();if(dir)await rm(dir,{recursive:true,force:true});
 for(const key of Object.keys(process.env))if(!(key in priorEnv))delete process.env[key];Object.assign(process.env,priorEnv);
});

test('production App defaults to a persisted zero-money platform provider and keeps admission closed',async()=>{
 const item=await platform.createApp('Production owned wallet',{partnerId:uid('partner')}),unadmitted=item.app;
 assert.equal(unadmitted.status,'paused');assert.equal(unadmitted.wallet_url,'');
 assert.equal((await binding.getWalletStatus(unadmitted.id)).mode,'platform');
 assert.equal((await binding.getWalletStatus(unadmitted.id)).can_configure,false);
 const snapshot=await wallet.readWalletSnapshot(pool,{scope:scopeOf(unadmitted)});
 assert.deepEqual(snapshot.treasury,{available_minor:'0',reserved_minor:'0',inbound_capacity_minor:'0'});assert.deepEqual(snapshot.users,[]);assert.deepEqual(snapshot.ledger,[]);
 assert.equal((await pool.query('SELECT count(*)::int count FROM wallet_keys')).rows[0].count,0);
 assert.equal((await pool.query("SELECT count(*)::int count FROM gp_keys WHERE direction='platform-to-wallet'")).rows[0].count,0);
 await binding.migrateWalletBindings(pool);assert.equal((await binding.getWalletStatus(unadmitted.id)).mode,'platform');
 assert.equal(Object.isFrozen(runtime),true);assert.equal(runtime.admissionEnabled,false);
 await assert.rejects(players.registerPlayer(uid('foreign'),password,unadmitted.id),{code:'FIRSTPARTY_APP_REQUIRED'});
 await setAdmission('closed');
 try{await assert.rejects(players.registerPlayer(uid('closed'),password,app.id),{code:'PRODUCTION_ACCEPTANCE_REQUIRED'});}
 finally{app=await setAdmission('open');}
});

test('registered player and per-App identity atomically open one zero-balance account without reference credits',async()=>{
 registered=await player(app);mapped=registered.externalUserId;
 const repeats=await Promise.all(Array.from({length:8},()=>players.appPlayerId(pool,app.id,registered.id)));assert.ok(repeats.every(value=>value===mapped));
 const balance=await binding.validatedWalletBalance(app,mapped);
 assert.deepEqual(balance.balance,{external_user_id:mapped,available_minor:'0',reserved_minor:'0',currency_scale:2,ledger_version:'0'});
 assert.equal((await pool.query("SELECT count(*)::int count FROM gp_audit WHERE app_id=$1 AND action='wallet.account_opened'",[app.id])).rows[0].count,1);
 assert.equal((await pool.query('SELECT count(*)::int count FROM wallet_ledger')).rows[0].count,0);
 assert.equal((await pool.query('SELECT count(*)::int count FROM wallet_keys')).rows[0].count,0);
 await assert.rejects(wallet.provisionWallet(pool,{scope:scopeOf(app)}),{code:'REFERENCE_PROVISION_SANDBOX_ONLY'});
});

test('failed zero-account creation rolls back registration and App identity together',async()=>{
 const username=uid('rollback');
 await pool.query(`CREATE FUNCTION reject_fixture_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture account unavailable'; END $$;
  CREATE TRIGGER reject_fixture_account BEFORE INSERT ON wallet_users FOR EACH ROW EXECUTE FUNCTION reject_fixture_account()`);
 try{
  await assert.rejects(players.registerPlayer(username,password,app.id),{code:'P0001'});
  assert.equal((await pool.query('SELECT 1 FROM gp_players WHERE username=$1',[username])).rowCount,0);
  assert.equal((await pool.query('SELECT count(*)::int count FROM gp_player_app_ids WHERE app_id=$1',[app.id])).rows[0].count,1);
  assert.equal((await pool.query('SELECT count(*)::int count FROM wallet_users WHERE scope_id=$1',[scopeId(app)])).rows[0].count,1);
 }finally{await pool.query('DROP TRIGGER reject_fixture_account ON wallet_users; DROP FUNCTION reject_fixture_account()');}
});

test('real player login launches, exchanges and enters free practice at zero balance, with durable replay',async()=>{
 const login=await players.loginPlayer(registered.username,password,app.id);assert.equal(login.player.id,registered.id);assert.match(login.token,/^[A-Za-z0-9_-]{43}$/);
 const body={...scopeOf(app),request_id:uid('launch'),game_id:'match',locale:'en',host_platform:'web',host_origin:publicOrigin};
 await assert.rejects(platform.createSession(app,{...body,external_user_id:mapped},JSON.stringify(body)),{code:'PLAYER_BFF_REQUIRED'});
 const launched=await platform.createSession(app,body,JSON.stringify(body),{playerId:registered.id});
 assert.deepEqual(await platform.createSession(app,body,JSON.stringify(body),{playerId:registered.id}),launched);
 const exchanged=await platform.exchange({launch_code:launched.launch_code,client_instance_id:uid('client'),host_origin:publicOrigin,game_id:'match'});
 const session=await platform.playSession({headers:{authorization:'Bearer '+exchanged.access_token}});
 assert.equal(session.player_id,registered.id);assert.equal(session.external_user_id,mapped);
 const made=await pvp.routePvp(session,'POST','/api/pvp/rooms',{request_id:uid('practice'),game_id:'match',capacity:2,practice:true});
 assert.equal(made.status,201);assert.equal(made.body.entry_minor,'0');assert.equal(made.body.practice,true);
 const ready=await pvp.routePvp(session,'POST',`/api/pvp/rooms/${made.body.id}/ready`,{request_id:uid('ready')});assert.equal(ready.status,200);
 await pvp.routePvp(session,'POST',`/api/pvp/rooms/${made.body.id}/leave`,{request_id:uid('leave')});
 const snapshot=await wallet.readWalletSnapshot(pool,{scope:scopeOf(app)});assert.equal(snapshot.users[0].available,'0');assert.deepEqual(snapshot.ledger,[]);assert.deepEqual(snapshot.operations,[]);
});

test('App isolation, scope pinning and insufficient funds fail without automatic funding',async()=>{
 const other=await historicalApp();
 await assert.rejects(players.loginPlayer(registered.username,password,other.id),{code:'FIRSTPARTY_APP_REQUIRED'});
 await assert.rejects(players.appPlayerId(pool,other.id,registered.id),{code:'FIRSTPARTY_APP_REQUIRED'});
 const historical=await acceptedHistoricalMapping(other,registered),otherId=historical.externalUserId;assert.notEqual(otherId,mapped);
 assert.equal((await players.loginPlayer(registered.username,password,other.id)).player.id,registered.id);
 await assert.rejects(binding.validatedWalletBalance(other,mapped),{status:404});
 await assert.rejects(binding.validatedWalletBalance({...app,currency_id:'OTHER'},mapped),{code:'WALLET_BINDING_CHANGED'});
 const terms={game_id:'match',rule_version:'pvp-match-v1.0.0',payout_template_version:'winner-all-v1',fee_bps:500,entry_minor:'1000',player_count:2,team_size:1};
 const reserve={request_id:uid('empty_reserve'),match_id:uid('empty_match'),reservation_id:uid('empty_hold'),external_user_id:mapped,seat_index:0,amount_minor:'1000',terms,expires_at:new Date(Date.now()+60000).toISOString()};
 const rejected=await command(app,'/wallet/v1/reservations',reserve);assert.equal(rejected.state,'REJECTED');assert.equal(rejected.rejection.code,'INSUFFICIENT_FUNDS');
 assert.deepEqual(await command(app,'/wallet/v1/reservations',reserve),rejected);
 const stolen={...scopeOf(other),...reserve,request_id:uid('scope_spoof')};
 await assert.rejects(binding.walletRequest(app,'POST','/wallet/v1/reservations',JSON.stringify(stolen),stolen.request_id),{code:'SCOPE_FORBIDDEN'});
 const snapshot=await wallet.readWalletSnapshot(pool,{scope:scopeOf(app)});assert.deepEqual(snapshot.ledger,[]);assert.equal(snapshot.users[0].available,'0');assert.equal(snapshot.users[0].reserved,'0');
 const {assertProductionAppReady}=await import('../server/runtime-mode.mjs');await assert.rejects(assertProductionAppReady(pool,{...app,game_ids:['tiger']}),{code:'FIRSTPARTY_APP_CONFIG_CHANGED'});
 const probability={...scopeOf(app),request_id:uid('blocked_probability'),game_id:'tiger',locale:'en',host_platform:'web',host_origin:publicOrigin};
 await assert.rejects(platform.createSession(app,probability,JSON.stringify(probability),{playerId:registered.id}),{code:'GAME_DISABLED'});
});

test('a production external wallet binds the simple-v1 protocol; pristine unconfigured production App can bind platform once',async()=>{
 const external=(await platform.createApp('External wallet option',{partnerId:uid('partner'),walletProvider:'external'})).app;
 assert.equal((await binding.getWalletStatus(external.id)).mode,'unconfigured');
 const input={wallet_url:'https://external-wallet.example.invalid',wallet_key_id:uid('key'),wallet_secret_base64:randomBytes(32).toString('base64')};
 assert.equal((await binding.configureWallet(external.id,input,'fixture_operator')).mode,'simple');
 await binding.migrateWalletBindings(pool);assert.equal((await binding.getWalletStatus(external.id)).mode,'simple');
 await assert.rejects(binding.configureWallet(external.id,{provider:'platform'},'fixture_operator'),{code:'WALLET_ALREADY_BOUND'});
 const legacy=(await platform.createApp('Pristine production option',{partnerId:uid('partner'),walletProvider:'external'})).app;
 assert.equal((await binding.configureWallet(legacy.id,{provider:'platform'},'fixture_operator')).mode,'platform');
 await assert.rejects(binding.configureWallet(legacy.id,input,'fixture_operator'),{code:'WALLET_ALREADY_BOUND'});
});

test('legacy binding schema migrates existing external URL, key and scope without reassignment',async()=>{
 await pool.query(`CREATE SCHEMA legacy_wallet_fixture;
  CREATE TABLE legacy_wallet_fixture.gp_wallet_bindings (
   app_id text PRIMARY KEY REFERENCES gp_apps(id),wallet_url text NOT NULL,wallet_key_id text NOT NULL REFERENCES gp_keys(id),
   scope jsonb NOT NULL,configured_by text NOT NULL,configured_at timestamptz NOT NULL DEFAULT now());
  INSERT INTO legacy_wallet_fixture.gp_wallet_bindings SELECT app_id,wallet_url,wallet_key_id,scope,configured_by,configured_at FROM public.gp_wallet_bindings WHERE provider IN ('external','simple')`);
 const legacy=new pg.Pool({connectionString:databaseUrl.href,max:1,options:'-c search_path=legacy_wallet_fixture,public'});
 try{
  const before=(await legacy.query('SELECT * FROM gp_wallet_bindings')).rows;assert.equal(before.length,1);
  await binding.migrateWalletBindings(legacy);
  const after=(await legacy.query('SELECT * FROM gp_wallet_bindings')).rows;
  assert.deepEqual(after,before.map(row=>({...row,provider:'external'})));
 }finally{await binding.migrateWalletBindings(pool);await legacy.end();}
});

async function creditedFixture(){
 // Fresh identities are genuinely registered only on the reviewed firstparty
 // zero-money scope. Other-App financial history is seeded explicitly below;
 // direct internal ledger commands here test arithmetic, not API admission.
 const value=await historicalApp(),accounts=[await acceptedHistoricalMapping(value,await player(app)),await acceptedHistoricalMapping(value,await player(app))],identifier=scopeId(value);
 const db=await pool.connect();try{
  await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[identifier]);
  for(const account of accounts){
   await db.query('UPDATE wallet_users SET available=10000 WHERE scope_id=$1 AND external_user_id=$2',[identifier,account.externalUserId]);
   await db.query(`INSERT INTO wallet_ledger(scope_id,operation_id,transaction_id,account,delta_available,meta)
    VALUES($1,$2,$2,$3,10000,'{"kind":"isolated_test_fixture"}'),($1,$2,$2,'isolated_test_fixture',-10000,'{"kind":"isolated_test_fixture"}')`,[identifier,uid('fixture'),`user:${account.externalUserId}`]);
  }
  await db.query('UPDATE wallet_scopes SET ledger_version=ledger_version+4 WHERE scope_id=$1',[identifier]);await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 const terms={game_id:'match',rule_version:'pvp-match-v1.0.0',payout_template_version:'winner-all-v1',fee_bps:500,entry_minor:'1000',player_count:2,team_size:1};
 return{value,accounts,terms,matchId:uid('match')};
}
async function reserveAccounts(fixture){
 const requests=fixture.accounts.map((account,index)=>({request_id:uid('reserve'),match_id:fixture.matchId,reservation_id:uid('reservation'),external_user_id:account.externalUserId,seat_index:index,amount_minor:'1000',terms:fixture.terms,expires_at:new Date(Date.now()+60000).toISOString()}));
 for(const request of requests){const results=await Promise.all(Array.from({length:5},()=>command(fixture.value,'/wallet/v1/reservations',request)));assert.equal(results[0].state,'SUCCEEDED');for(const result of results)assert.deepEqual(result,results[0]);}
 return requests;
}
const conserved=snapshot=>assert.equal(snapshot.ledger.reduce((total,row)=>total+BigInt(row.delta_available)+BigInt(row.delta_reserved),0n),0n);

test('platform provider reuses atomic reserve/capture/settle and replay survives a fresh connection pool',async()=>{
 const fixture=await creditedFixture(),requests=await reserveAccounts(fixture),value=fixture.value;
 const participants=requests.map(request=>({external_user_id:request.external_user_id,seat_index:request.seat_index,reservation_id:request.reservation_id,entry_minor:'1000'}));
 const captured=await command(value,'/wallet/v1/matches/capture',{request_id:uid('capture'),match_id:fixture.matchId,terms:fixture.terms,participants});assert.equal(captured.state,'SUCCEEDED');
 const settlement={request_id:uid('settlement'),match_id:fixture.matchId,resolution:'completed',result_hash:'a'.repeat(64),fee_minor:'100',payouts:participants.map((entry,index)=>({external_user_id:entry.external_user_id,seat_index:index,rank:index+1,payout_minor:index===0?'1900':'0'}))};
 const settled=await command(value,'/wallet/v1/matches/settle',settlement);assert.equal(settled.state,'SUCCEEDED');
 const before=await wallet.readWalletSnapshot(pool,{scope:scopeOf(value)});assert.deepEqual(before.users.map(user=>user.available).sort(),['10900','9000']);assert.ok(before.users.every(user=>user.reserved==='0'&&user.credit_pending==='0'));assert.equal(before.fee_minor,'100');conserved(before);
 const fresh=new pg.Pool({connectionString:databaseUrl.href,max:2});try{
  await binding.migrateWalletBindings(fresh);assert.deepEqual(await command(value,'/wallet/v1/matches/settle',settlement),settled);
  assert.deepEqual(await binding.walletRequest(value,'GET','/wallet/v1/operations/'+settlement.request_id),settled);
  await assert.rejects(command(value,'/wallet/v1/matches/settle',{...settlement,result_hash:'b'.repeat(64)}),{code:'IDEMPOTENCY_CONFLICT'});
 }finally{await binding.migrateWalletBindings(pool);await fresh.end();}
 assert.deepEqual(await wallet.readWalletSnapshot(pool,{scope:scopeOf(value)}),before);
});

test('release refunds exactly once and wallet expiration returns held production balances',async()=>{
 const fixture=await creditedFixture(),requests=await reserveAccounts(fixture),value=fixture.value;
 const release={request_id:uid('release'),match_id:fixture.matchId,reason:'lobby_cancelled'};
 const released=await command(value,'/wallet/v1/matches/release',release);assert.equal(released.state,'SUCCEEDED');assert.deepEqual(await command(value,'/wallet/v1/matches/release',release),released);
 let snapshot=await wallet.readWalletSnapshot(pool,{scope:scopeOf(value)});assert.ok(snapshot.users.every(user=>user.available==='10000'&&user.reserved==='0'));conserved(snapshot);
 const hold={...requests[0],request_id:uid('reserve'),match_id:uid('match'),reservation_id:uid('reservation')};assert.equal((await command(value,'/wallet/v1/reservations',hold)).state,'SUCCEEDED');
 await pool.query("UPDATE wallet_reservations SET expires_at=now()-interval '1 second' WHERE scope_id=$1 AND reservation_id=$2",[scopeId(value),hold.reservation_id]);
 assert.equal((await binding.validatedWalletBalance(value,hold.external_user_id)).balance.available_minor,'10000');
 snapshot=await wallet.readWalletSnapshot(pool,{scope:scopeOf(value)});assert.ok(snapshot.users.every(user=>user.reserved==='0'));conserved(snapshot);
 assert.equal((await pool.query("SELECT count(*)::int count FROM wallet_ledger WHERE meta->>'kind'='reference_provision'")).rows[0].count,0);
});
