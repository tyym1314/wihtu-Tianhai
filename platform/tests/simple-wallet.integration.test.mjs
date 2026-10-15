import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {RELEASED_IDS} from '../shared/games.mjs';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {migrateSimpleDemoWallet,seedSimpleDemoUsers,simpleBalance,handleSimpleWallet} from '../examples/partner-demo/simple-wallet.mjs';

// A partner App on the simple-v1 protocol: only balance/debit/credit at the partner,
// every escrow state in the platform's internal ledger.
const suffix=process.pid+'_'+randomBytes(6).toString('hex'),name='oasis_release_test_'+suffix;
const origin='https://simple-wallet.example.invalid',walletOrigin='https://simple.partner.example';
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
const databaseUrl=new URL(adminUrl);databaseUrl.pathname='/'+name;
const previous={...process.env},uid=p=>p+'_'+randomBytes(8).toString('hex');
let admin,pool,tx,closePools,closeEnginePool,dir,created=false,platform,wallet,binding,pvp,cycles,runtimeMode,simple,partnerServer,app;
const walletKey={keyId:uid('wk'),secretBase64:randomBytes(32).toString('base64')};
const faults={dropNextDebitResponse:false};

const sessionFor=async(user,game)=>{
 const body={...platform.scope(app),request_id:uid('launch'),external_user_id:user,game_id:game,locale:'en',host_platform:'android'};
 const launched=await platform.createSession(app,body,JSON.stringify(body));
 const exchanged=await platform.exchange({launch_code:launched.launch_code,client_instance_id:uid('client'),host_origin:origin,game_id:game});
 return platform.playSession({headers:{authorization:'Bearer '+exchanged.access_token}});
};
const post=(s,path,body={})=>pvp.routePvp(s,'POST',path,{request_id:uid('req'),...body});
const partnerBalance=async u=>BigInt(await simpleBalance(pool,u));
const transit=async()=>(await pool.query("SELECT COALESCE(sum(available+reserved),0)::text n FROM wallet_users WHERE scope_id LIKE $1",[`%:${app.id}:%`])).rows[0].n;
const recover=()=>simple.recoverSimpleWallets(pool,async appId=>({app:await platform.appById(appId),binding:(await pool.query('SELECT * FROM gp_wallet_bindings WHERE app_id=$1',[appId])).rows[0]}));
async function tickUntil(roomId,statuses,limit=40){for(let i=0;i<limit;i++){await pvp.tickPvp({roomIds:[roomId]}).catch(()=>{});const s=(await pool.query('SELECT status FROM pvp_rooms WHERE id=$1',[roomId])).rows[0].status;if(statuses.includes(s))return s;await new Promise(r=>setTimeout(r,50));}return(await pool.query('SELECT status FROM pvp_rooms WHERE id=$1',[roomId])).rows[0].status;}

before(async()=>{
 admin=new pg.Pool({connectionString:adminUrl.href,max:1});await admin.query(`CREATE DATABASE "${name}"`);created=true;
 dir=await mkdtemp(join(tmpdir(),'oasis-simple-wallet-'));await writeFile(join(dir,'master.key'),randomBytes(32),{mode:0o600,flag:'wx'});
 for(const key of ['OASIS_ADMISSION_PROFILE','OASIS_FIRSTPARTY_APP_ID','OASIS_ADMISSION_RELEASE','OASIS_ADMISSION_MANIFEST_SHA256','OASIS_WALLET_ALLOWED_ORIGINS'])delete process.env[key];
 Object.assign(process.env,{OASIS_DATABASE_URL:databaseUrl.href,OASIS_ENVIRONMENT:'production',OASIS_LOCAL_DIR:dir,OASIS_START_WALLET:'0',OASIS_PUBLIC_ORIGIN:origin,OASIS_PRODUCTION_ADMISSION_ENABLED:'0',OASIS_PARTNER_ADMISSION:'1'});
 ({pool,tx,closePools}=await import('../server/db.mjs'));platform=await import('../server/platform.mjs');wallet=await import('../server/wallet/index.mjs');binding=await import('../server/wallet-binding.mjs');pvp=await import('../server/pvp/index.mjs');cycles=await import('../server/cycles.mjs');runtimeMode=await import('../server/runtime-mode.mjs');simple=await import('../server/simple-wallet.mjs');
 ({closeEnginePool}=await import('../server/pvp/engine-pool.mjs'));
 await wallet.migrateWallet(pool);await platform.migratePlatform();await pvp.migratePvp(pool);await binding.migrateWalletBindings(pool);await simple.migrateSimpleWallet(pool);await runtimeMode.migrateRuntime(pool);await(await import('../server/transfers/index.mjs')).migrateTransfers(pool);
 // The partner's own wallet tables live in a separate schema-free namespace of this test database.
 await migrateSimpleDemoWallet(pool);await seedSimpleDemoUsers(pool,[{external_user_id:'alice',balance_minor:'100000'},{external_user_id:'bob',balance_minor:'100000'},{external_user_id:'poor',balance_minor:'500'}]);
 partnerServer=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;if(!await handleSimpleWallet(pool,walletKey,req,res,raw)){res.writeHead(404);res.end('{}');}});
 await new Promise(r=>partnerServer.listen(0,'127.0.0.1',r));const loopback='http://127.0.0.1:'+partnerServer.address().port;
 binding.setWalletTransportForTests(async(target,method,path,headers,raw)=>{
  assert.equal(target,walletOrigin);
  const r=await fetch(loopback+path,{method,headers,body:method==='GET'?undefined:raw});const body=await r.json();
  if(path.endsWith('/debit')&&faults.dropNextDebitResponse){faults.dropNextDebitResponse=false;const e=new Error('lost');e.status=503;e.code='WALLET_UNKNOWN';throw e;}
  return{status:r.status,body};
 });
 ({app}=await platform.createApp('Simple Partner',{partnerId:'partner_simple_fixture',actor:'fixture'}));
});
after(async()=>{
 binding?.setWalletTransportForTests(null);if(partnerServer?.listening)await new Promise(r=>partnerServer.close(r));
 try{await closeEnginePool?.();}finally{try{await closePools?.();}finally{if(created)await dropOwnedTestDatabase(admin,name,{created});await admin?.end();if(dir)await rm(dir,{recursive:true,force:true});for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);}}
});

test('a new partner App starts paused and cannot launch before its wallet is bound',async()=>{
 assert.equal(app.status,'paused');assert.deepEqual(app.game_ids,RELEASED_IDS);assert.equal(app.wallet_url,'');
 await assert.rejects(platform.createApp('Platform wallet app',{partnerId:'partner_simple_fixture',actor:'fixture',walletProvider:'platform'}),{code:'INVALID_WALLET_PROVIDER'});
 await assert.rejects(tx(db=>runtimeMode.assertProductionAppReady(db,{...app,status:'active'},{intent:'activate'})),{code:'PRODUCTION_EXTERNAL_WALLET_REQUIRED'});
 const body={...platform.scope(app),request_id:uid('launch'),external_user_id:'alice',game_id:'match',locale:'en',host_platform:'web'};
 await assert.rejects(platform.createSession(app,body,JSON.stringify(body)),{code:'PRODUCTION_EXTERNAL_WALLET_REQUIRED'});
 await assert.rejects(binding.configureWallet(app.id,{wallet_url:'http://simple.partner.example',wallet_key_id:walletKey.keyId,wallet_secret_base64:walletKey.secretBase64},'fixture'),{code:'WALLET_HTTPS_REQUIRED'});
 await assert.rejects(binding.configureWallet(app.id,{wallet_url:walletOrigin,wallet_key_id:walletKey.keyId,wallet_secret_base64:walletKey.secretBase64,protocol:'full-v1'},'fixture'),{code:'INVALID_REQUEST'});
});

test('binding a simple-v1 wallet opens an internal escrow ledger and admits sessions',async()=>{
 const bound=await binding.configureWallet(app.id,{wallet_url:walletOrigin,wallet_key_id:walletKey.keyId,wallet_secret_base64:walletKey.secretBase64},'fixture');
 assert.equal(bound.mode,'simple');
 await tx(async db=>{const locked=(await db.query('SELECT * FROM gp_apps WHERE id=$1 FOR UPDATE',[app.id])).rows[0];await runtimeMode.assertProductionAppReady(db,{...locked,status:'active'},{intent:'activate'});await db.query("UPDATE gp_apps SET status='active' WHERE id=$1",[app.id]);});
 app=await platform.appById(app.id);
 const balance=await cycles.walletBalance(app,'alice');assert.equal(balance.balance.available_minor,'100000');
 const session=await sessionFor('alice','match');assert.equal(session.admission_profile,'partner-external-v1');assert.equal(session.player_id,null);
 const games=platform.gamesFor(app);assert.equal(games.games.length,RELEASED_IDS.length);assert.ok(games.games.every(g=>g.available&&g.configuration_version==='partner-external-v1'));
});

test('a paid room debits entries at the partner and credits only the payout',async()=>{
 const [alice,bob]=await Promise.all([sessionFor('alice','bowling'),sessionFor('bob','bowling')]);
 const room=(await post(alice,'/api/pvp/rooms',{game_id:'bowling',capacity:2,entry_minor:'1000'})).body;
 await post(bob,`/api/pvp/rooms/${room.code}/join`);for(const s of [alice,bob])await post(s,`/api/pvp/rooms/${room.id}/ready`);
 assert.equal(await tickUntil(room.id,['active']),'active');
 assert.equal(await partnerBalance('alice'),99000n);assert.equal(await partnerBalance('bob'),99000n);
 await post(bob,`/api/pvp/rooms/${room.id}/leave`);assert.equal(await tickUntil(room.id,['settled']),'settled');
 assert.equal(await partnerBalance('alice'),100900n,'2000 pool minus 5% fee');assert.equal(await partnerBalance('bob'),99000n);
 assert.equal(await transit(),'0');
});

test('a rejected partner debit cancels the room and refunds the other entry',async()=>{
 const [alice,poor]=await Promise.all([sessionFor('alice','match'),sessionFor('poor','match')]);
 const room=(await post(alice,'/api/pvp/rooms',{game_id:'match',capacity:2,entry_minor:'1000'})).body;
 await post(poor,`/api/pvp/rooms/${room.code}/join`);for(const s of [alice,poor])await post(s,`/api/pvp/rooms/${room.id}/ready`);
 const status=await tickUntil(room.id,['cancelled','voided']);assert.ok(['cancelled','voided'].includes(status),status);
 await recover();
 assert.equal(await partnerBalance('alice'),100900n);assert.equal(await partnerBalance('poor'),500n);assert.equal(await transit(),'0');
});

test('a lost debit response is replayed by request_id and charged exactly once',async()=>{
 const [alice,bob]=await Promise.all([sessionFor('alice','darts'),sessionFor('bob','darts')]);
 const room=(await post(alice,'/api/pvp/rooms',{game_id:'darts',capacity:2,entry_minor:'1000'})).body;
 await post(bob,`/api/pvp/rooms/${room.code}/join`);for(const s of [alice,bob])await post(s,`/api/pvp/rooms/${room.id}/ready`);
 faults.dropNextDebitResponse=true;
 await pvp.tickPvp({roomIds:[room.id]}).catch(()=>{});
 assert.equal(faults.dropNextDebitResponse,false,'the debit response was dropped');
 const pendingLeg=(await pool.query("SELECT state,attempts FROM gp_simple_wallet_legs WHERE id LIKE $1 AND attempts>0",[`in_reserve_${room.id}_%`])).rows;assert.deepEqual(pendingLeg,[{state:'PENDING',attempts:1}]);
 await pool.query("UPDATE gp_simple_wallet_legs SET next_attempt_at=now()");await pool.query("UPDATE pvp_operations SET next_attempt_at=now() WHERE room_id=$1",[room.id]).catch(()=>{});
 assert.equal(await tickUntil(room.id,['active'],80),'active');
 assert.equal(await partnerBalance('alice'),99900n);assert.equal(await partnerBalance('bob'),98000n);
 const debits=(await pool.query("SELECT count(*)::int n FROM demo_simple_transactions WHERE kind='debit' AND request_id LIKE $1",[`in_reserve_${room.id}_%`])).rows[0].n;assert.equal(debits,2);
 for(const s of [alice,bob])await post(s,`/api/pvp/rooms/${room.id}/leave`);
 await tickUntil(room.id,['settled','voided']);await recover();assert.equal(await transit(),'0');
});

test('a probability cycle debits the stake and credits the complete-cycle win',async()=>{
 const s=await sessionFor('alice','thunder'),before=await partnerBalance('alice');
 const view=await cycles.publicSession(s);assert.equal(view.mode,'production');
 const {round}=await cycles.spin(s,{requestId:uid('spin'),bet:10,expectedVersion:view.stateVersion});
 const cycle=(await pool.query('SELECT * FROM gp_cycles WHERE id=$1',[round.cycleId])).rows[0];assert.equal(cycle.status,'SETTLED');
 await recover();
 assert.equal(await partnerBalance('alice'),before-1000n+BigInt(cycle.payout_minor));assert.equal(await transit(),'0');
});

test('quick match pairs strangers with identical terms and a leaver only frees their seat',async()=>{
 const [alice,bob]=await Promise.all([sessionFor('alice','ludo'),sessionFor('bob','ludo')]);
 const quick=(s,entry='1000')=>post(s,'/api/pvp/matchmaking',{game_id:'ludo',capacity:2,entry_minor:entry});
 const first=(await quick(alice)).body;assert.equal(first.matchmaking,true);assert.equal(first.status,'waiting');
 const other=(await quick(bob,'5000')).body;assert.notEqual(other.id,first.id,'different entry never matches');
 await post(bob,`/api/pvp/rooms/${other.id}/leave`);await pvp.tickPvp({roomIds:[other.id]});
 const second=(await quick(bob)).body;assert.equal(second.id,first.id);
 assert.equal((await post(bob,`/api/pvp/rooms/${first.id}/leave`)).body.status,'cancelled');
 assert.deepEqual((await pool.query('SELECT players FROM pvp_rooms WHERE id=$1',[first.id])).rows[0].players.map(p=>p.external_user_id),['alice']);
 assert.equal((await quick(bob)).body.id,first.id);
 for(const s of [alice,bob])await post(s,`/api/pvp/rooms/${first.id}/ready`);
 assert.equal(await tickUntil(first.id,['active']),'active');
 for(const s of [alice,bob])await post(s,`/api/pvp/rooms/${first.id}/leave`);
 await tickUntil(first.id,['settled','voided']);await recover();assert.equal(await transit(),'0');
});

test('pausing the App blocks new sessions and the hosted platform account flow is unavailable',async()=>{
 await assert.rejects(tx(db=>runtimeMode.assertProductionAppReady(db,app,{intent:'register'})),{code:'PLAYER_BFF_NOT_AVAILABLE'});
 await assert.rejects(platform.createSession(app,{},'{}',{playerId:'player_x'}),{code:'PLAYER_BFF_NOT_AVAILABLE'});
 await pool.query("UPDATE gp_apps SET status='paused' WHERE id=$1",[app.id]);app=await platform.appById(app.id);
 const body={...platform.scope(app),request_id:uid('launch'),external_user_id:'alice',game_id:'match',locale:'en',host_platform:'web'};
 await assert.rejects(platform.createSession(app,body,JSON.stringify(body)),{code:'APP_PAUSED'});
});
