import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {RELEASED_IDS} from '../shared/games.mjs';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';

// A production-shaped instance with third-party admission: partner-signed
// sessions settle only through the partner's own (here: loopback reference) wallet.
const suffix=process.pid+'_'+randomBytes(6).toString('hex'),name='oasis_release_test_'+suffix;
const origin='https://partner-admission.example.invalid',walletOrigin='https://wallet.partner.example';
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
const databaseUrl=new URL(adminUrl);databaseUrl.pathname='/'+name;
const previous={...process.env},uid=prefix=>prefix+'_'+randomBytes(8).toString('hex');
let admin,pool,tx,closePools,closeEnginePool,dir,created=false,platform,wallet,binding,pvp,cycles,runtimeMode,referenceServer,app,walletScope;

const sessionFor=async(user,game,extra={})=>{
 const body={...platform.scope(app),request_id:uid('launch'),external_user_id:user,game_id:game,locale:'en',host_platform:'android',...extra};
 const launched=await platform.createSession(app,body,JSON.stringify(body));
 assert.equal(launched.entry_url,origin+'/play/'+game);
 const exchanged=await platform.exchange({launch_code:launched.launch_code,client_instance_id:uid('client'),host_origin:origin,game_id:game});
 return platform.playSession({headers:{authorization:'Bearer '+exchanged.access_token}});
};
const post=(s,path,body={})=>pvp.routePvp(s,'POST',path,{request_id:uid('req'),...body});
const balance=async user=>BigInt((await cycles.walletBalance(await platform.appById(app.id),user)).balance.available_minor);

before(async()=>{
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(adminUrl.hostname),'ISOLATED_LOCAL_POSTGRES_REQUIRED');
 admin=new pg.Pool({connectionString:adminUrl.href,max:1});await admin.query(`CREATE DATABASE "${name}"`);created=true;
 dir=await mkdtemp(join(tmpdir(),'oasis-partner-admission-'));await writeFile(join(dir,'master.key'),randomBytes(32),{mode:0o600,flag:'wx'});
 for(const key of ['OASIS_ADMISSION_PROFILE','OASIS_FIRSTPARTY_APP_ID','OASIS_ADMISSION_RELEASE','OASIS_ADMISSION_MANIFEST_SHA256','OASIS_WALLET_ALLOWED_ORIGINS'])delete process.env[key];
 Object.assign(process.env,{OASIS_DATABASE_URL:databaseUrl.href,OASIS_ENVIRONMENT:'production',OASIS_LOCAL_DIR:dir,OASIS_START_WALLET:'0',OASIS_PUBLIC_ORIGIN:origin,OASIS_PRODUCTION_ADMISSION_ENABLED:'0',OASIS_PARTNER_ADMISSION:'1'});
 ({pool,tx,closePools}=await import('../server/db.mjs'));platform=await import('../server/platform.mjs');wallet=await import('../server/wallet/index.mjs');binding=await import('../server/wallet-binding.mjs');pvp=await import('../server/pvp/index.mjs');cycles=await import('../server/cycles.mjs');runtimeMode=await import('../server/runtime-mode.mjs');
 ({closeEnginePool}=await import('../server/pvp/engine-pool.mjs'));
 assert.equal(runtimeMode.runtime.partnerAdmission,true);assert.equal(runtimeMode.runtime.admissionProfile,'closed');
 await wallet.migrateWallet(pool);await platform.migratePlatform();await pvp.migratePvp(pool);await binding.migrateWalletBindings(pool);await runtimeMode.migrateRuntime(pool);await(await import('../server/transfers/index.mjs')).migrateTransfers(pool);
 referenceServer=wallet.createWalletServer(pool);await new Promise(resolve=>referenceServer.listen(0,'127.0.0.1',resolve));
 const loopback='http://127.0.0.1:'+referenceServer.address().port;
 binding.setWalletTransportForTests(async(target,method,path,headers,raw)=>{
  assert.equal(target,walletOrigin);
  const response=await fetch(loopback+path,{method,headers,body:method==='GET'?undefined:raw});
  return{status:response.status,body:await response.json()};
 });
});
after(async()=>{
 binding?.setWalletTransportForTests(null);
 if(referenceServer?.listening)await new Promise(resolve=>referenceServer.close(resolve));
 try{await closeEnginePool?.();}finally{try{await closePools?.();}finally{
  if(created)await dropOwnedTestDatabase(admin,name,{created});await admin?.end();if(dir)await rm(dir,{recursive:true,force:true});
  for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);
 }}
});

test('a new partner App starts paused with an external wallet and cannot launch before binding',async()=>{
 ({app}=await platform.createApp('Partner Social App',{partnerId:'partner_social_fixture',actor:'fixture'}));
 assert.equal(app.status,'paused');assert.deepEqual(app.game_ids,RELEASED_IDS);assert.equal(app.wallet_url,'');
 assert.equal((await pool.query('SELECT count(*)::int n FROM gp_wallet_bindings WHERE app_id=$1',[app.id])).rows[0].n,0);
 await assert.rejects(platform.createApp('Platform wallet app',{partnerId:'partner_social_fixture',actor:'fixture',walletProvider:'platform'}),{code:'INVALID_WALLET_PROVIDER'});
 await assert.rejects(tx(db=>runtimeMode.assertProductionAppReady(db,{...app,status:'active'},{intent:'activate'})),{code:'PRODUCTION_EXTERNAL_WALLET_REQUIRED'});
 const body={...platform.scope(app),request_id:uid('launch'),external_user_id:'alice',game_id:'match',locale:'en',host_platform:'web'};
 await assert.rejects(platform.createSession(app,body,JSON.stringify(body)),{code:'PRODUCTION_EXTERNAL_WALLET_REQUIRED'});
});

test('binding the partner HTTPS wallet and activating admits partner-signed sessions',async()=>{
 const key=uid('wk'),secret=randomBytes(32).toString('base64');
 walletScope=platform.scope(app);
 await wallet.provisionWallet(pool,{scope:walletScope,key_id:key,secret_base64:secret,users:['alice','bob'].map(external_user_id=>({external_user_id,balance_minor:'100000'})),treasury_minor:'1000000000',partnerOwnedScope:true});
 const {getProfile}=await import('../server/math/index.ts');
 await wallet.registerMathProfiles(pool,{scope:walletScope,math_profiles:['thunder','tiger'].map(game=>{const m=getProfile(game,'99');return{game_id:game,math_version:m.version,math_config_hash:m.hash,max_payout_multiplier:String(m.maxMultiplier)};})});
 await assert.rejects(binding.configureWallet(app.id,{wallet_url:'http://wallet.partner.example',wallet_key_id:key,wallet_secret_base64:secret},'fixture'),{code:'WALLET_HTTPS_REQUIRED'});
 const bound=await binding.configureWallet(app.id,{wallet_url:walletOrigin,wallet_key_id:key,wallet_secret_base64:secret},'fixture');
 assert.equal(bound.mode,'external');assert.equal(bound.wallet_url,walletOrigin);
 app=await platform.appById(app.id);
 await tx(async db=>{const locked=(await db.query('SELECT * FROM gp_apps WHERE id=$1 FOR UPDATE',[app.id])).rows[0];const info=await runtimeMode.assertProductionAppReady(db,{...locked,status:'active'},{intent:'activate'});assert.equal(info.profile,'partner-external-v1');await db.query("UPDATE gp_apps SET status='active' WHERE id=$1",[app.id]);});
 app=await platform.appById(app.id);
 const session=await sessionFor('alice','match');
 assert.equal(session.admission_profile,'partner-external-v1');assert.equal(session.player_id,null);assert.equal(session.external_user_id,'alice');
 assert.equal(await balance('alice'),100000n);
 const games=platform.gamesFor(app);assert.equal(games.games.length,RELEASED_IDS.length);assert.ok(games.games.every(g=>g.available&&g.configuration_version==='partner-external-v1'));
});

test('a paid two-player room reserves, captures and settles through the partner wallet',async()=>{
 const alice=await sessionFor('alice','bowling'),bob=await sessionFor('bob','bowling');
 const room=(await post(alice,'/api/pvp/rooms',{game_id:'bowling',capacity:2,entry_minor:'1000'})).body;
 assert.equal(room.practice,false);
 await post(bob,`/api/pvp/rooms/${room.code}/join`);
 for(const s of [alice,bob])await post(s,`/api/pvp/rooms/${room.id}/ready`);
 for(let i=0;i<20;i++){await pvp.tickPvp({roomIds:[room.id]});const r=(await pool.query('SELECT status FROM pvp_rooms WHERE id=$1',[room.id])).rows[0];if(r.status==='active')break;await new Promise(r=>setTimeout(r,50));}
 const active=(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[room.id])).rows[0];
 assert.equal(active.status,'active',JSON.stringify({error:active.error,ops:(await pool.query('SELECT id,state,response FROM pvp_operations WHERE room_id=$1',[room.id])).rows}));assert.equal(active.captured,true);assert.equal('admission_profile' in active.terms,false);
 assert.equal(await balance('alice'),99000n);assert.equal(await balance('bob'),99000n);
 await post(bob,`/api/pvp/rooms/${room.id}/leave`);
 for(let i=0;i<40;i++){await pvp.tickPvp({roomIds:[room.id]});const r=(await pool.query('SELECT status FROM pvp_rooms WHERE id=$1',[room.id])).rows[0];if(r.status==='settled')break;await new Promise(r=>setTimeout(r,50));}
 const settled=(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[room.id])).rows[0];
 assert.equal(settled.status,'settled');
 // 2000 pool, 5% fee: the winner receives 1900.
 assert.equal(await balance('alice'),100900n);assert.equal(await balance('bob'),99000n);
});

test('quick match pairs strangers with identical terms and a leaver only frees their seat',async()=>{
 const users=['alice','bob'];const sessions=await Promise.all(users.map(u=>sessionFor(u,'match')));
 const quick=s=>post(s,'/api/pvp/matchmaking',{game_id:'match',capacity:2,entry_minor:'1000'});
 const first=(await quick(sessions[0])).body;assert.equal(first.matchmaking,true);assert.equal(first.status,'waiting');assert.equal(first.practice,false);
 const other=(await post(sessions[1],'/api/pvp/matchmaking',{game_id:'match',capacity:2,entry_minor:'5000'})).body;assert.notEqual(other.id,first.id,'different entry never matches');
 await post(sessions[1],`/api/pvp/rooms/${other.id}/leave`);await pvp.tickPvp({roomIds:[other.id]});
 assert.equal((await pool.query('SELECT status FROM pvp_rooms WHERE id=$1',[other.id])).rows[0].status,'cancelled');
 const second=(await quick(sessions[1])).body;assert.equal(second.id,first.id);assert.equal(second.players.length,2);
 const left=(await post(sessions[1],`/api/pvp/rooms/${first.id}/leave`)).body;assert.equal(left.status,'cancelled');
 const room=(await pool.query('SELECT status,players FROM pvp_rooms WHERE id=$1',[first.id])).rows[0];assert.equal(room.status,'waiting');assert.deepEqual(room.players.map(p=>p.external_user_id),['alice']);
 const again=(await quick(sessions[1])).body;assert.equal(again.id,first.id);
 for(const s of sessions)await post(s,`/api/pvp/rooms/${first.id}/ready`);
 for(let i=0;i<20;i++){await pvp.tickPvp({roomIds:[first.id]});if((await pool.query('SELECT status FROM pvp_rooms WHERE id=$1',[first.id])).rows[0].status==='active')break;await new Promise(r=>setTimeout(r,50));}
 assert.equal((await pool.query('SELECT status FROM pvp_rooms WHERE id=$1',[first.id])).rows[0].status,'active');
 for(const s of sessions)await post(s,`/api/pvp/rooms/${first.id}/leave`);
 for(let i=0;i<40;i++){await pvp.tickPvp({roomIds:[first.id]});if(['settled','voided'].includes((await pool.query('SELECT status FROM pvp_rooms WHERE id=$1',[first.id])).rows[0].status))break;await new Promise(r=>setTimeout(r,50));}
});

test('probability games authorize, accept and settle a complete cycle through the partner wallet',async()=>{
 const s=await sessionFor('alice','thunder'),before=await balance('alice');
 const view=await cycles.publicSession(s);assert.equal(view.mode,'production');assert.equal(view.financial_admission_enabled,true);assert.equal(view.internal_game_coins,false);
 const {round}=await cycles.spin(s,{requestId:uid('spin'),bet:10,expectedVersion:view.stateVersion});
 const cycle=(await pool.query('SELECT * FROM gp_cycles WHERE id=$1',[round.cycleId])).rows[0];
 assert.equal(cycle.status,'SETTLED');
 assert.equal(await balance('alice'),before-1000n+BigInt(cycle.payout_minor));
});

test('pausing the App blocks new sessions and the hosted platform account flow is unavailable for partner Apps',async()=>{
 await assert.rejects(tx(db=>runtimeMode.assertProductionAppReady(db,app,{intent:'register'})),{code:'PLAYER_BFF_NOT_AVAILABLE'});
 await assert.rejects(platform.createSession(app,{},'{}',{playerId:'player_x'}),{code:'PLAYER_BFF_NOT_AVAILABLE'});
 await pool.query("UPDATE gp_apps SET status='paused' WHERE id=$1",[app.id]);app=await platform.appById(app.id);
 const body={...platform.scope(app),request_id:uid('launch'),external_user_id:'alice',game_id:'match',locale:'en',host_platform:'web'};
 await assert.rejects(platform.createSession(app,body,JSON.stringify(body)),{code:'APP_PAUSED'});
});
