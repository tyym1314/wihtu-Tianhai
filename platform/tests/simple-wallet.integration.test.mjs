import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {migrateSimpleDemoWallet,seedSimpleDemoUsers,simpleBalance,handleSimpleWallet} from '../examples/partner-demo/simple-wallet.mjs';

// Unreleased casino definitions are playable in this test (OASIS_CASINO_PREVIEW=test).
process.env.OASIS_CASINO_PREVIEW='test';
const {ALL_GAME_IDS:RELEASED_IDS}=await import('../shared/games.mjs');

// A partner App on the simple-v1 protocol: only balance/debit/credit at the partner,
// every escrow state in the platform's internal ledger.
const suffix=process.pid+'_'+randomBytes(6).toString('hex'),name='oasis_release_test_'+suffix;
const origin='https://simple-wallet.example.invalid',walletOrigin='https://simple.partner.example';
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
const databaseUrl=new URL(adminUrl);databaseUrl.pathname='/'+name;
const previous={...process.env},uid=p=>p+'_'+randomBytes(8).toString('hex');
let admin,pool,tx,closePools,closeEnginePool,dir,created=false,platform,wallet,binding,pvp,cycles,runtimeMode,simple,casino,partnerServer,app;
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
 ({pool,tx,closePools}=await import('../server/db.mjs'));platform=await import('../server/platform.mjs');wallet=await import('../server/wallet/index.mjs');binding=await import('../server/wallet-binding.mjs');pvp=await import('../server/pvp/index.mjs');cycles=await import('../server/cycles.mjs');runtimeMode=await import('../server/runtime-mode.mjs');simple=await import('../server/simple-wallet.mjs');casino=await import('../server/casino/rounds.mjs');
 ({closeEnginePool}=await import('../server/pvp/engine-pool.mjs'));
 await wallet.migrateWallet(pool);await platform.migratePlatform();await pvp.migratePvp(pool);await binding.migrateWalletBindings(pool);await simple.migrateSimpleWallet(pool);await casino.migrateCasino(pool);await(await import('../server/casino/instant.mjs')).migrateInstant(pool);await(await import('../server/casino/arcade.mjs')).migrateArcade(pool);await runtimeMode.migrateRuntime(pool);await(await import('../server/transfers/index.mjs')).migrateTransfers(pool);
 // The partner's own wallet tables live in a separate schema-free namespace of this test database.
 await migrateSimpleDemoWallet(pool);await seedSimpleDemoUsers(pool,[{external_user_id:'alice',balance_minor:'100000'},{external_user_id:'bob',balance_minor:'100000'},{external_user_id:'carol',balance_minor:'5000000'},{external_user_id:'dave',balance_minor:'5000000'},{external_user_id:'poor',balance_minor:'500'}]);
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
 try{await closeEnginePool?.();}finally{try{await closePools?.();}finally{if(created)await dropOwnedTestDatabase(admin,name,{created});await admin?.end();if(dir)await rm(dir,{recursive:true,force:true});delete process.env.OASIS_CASINO_PREVIEW;for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);}}
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

test('a shared GreedyLion round debits each bet and credits winners at their multiplier',async()=>{
 await pool.query("UPDATE gp_apps SET status='active' WHERE id=$1",[app.id]);app=await platform.appById(app.id);
 const [alice,bob]=await Promise.all([sessionFor('alice','greedylion'),sessionFor('bob','greedylion')]);
 const state=await casino.casinoState(alice,{balance:true});assert.equal(state.round.status,'betting');assert.ok(state.round.commitment);assert.equal(state.round.result,undefined);
 assert.equal((await casino.casinoState(bob)).round.id,state.round.id,'one shared round per App and game');
 const before={alice:await partnerBalance('alice'),bob:await partnerBalance('bob')};
 const bet=(s,option,stake='10000',request_id=uid('bet'))=>casino.placeBet(s,{request_id,round_id:state.round.id,option_id:option,stake_minor:stake});
 const first=await bet(alice,'tomato','10000','alice_bet_0001');assert.equal(first.status,'ACCEPTED');
 assert.deepEqual(await bet(alice,'tomato','10000','alice_bet_0001'),first,'same request_id is one bet');
 await bet(alice,'chicken','10000');for(const o of ['corn','carrot','lettuce','shrimp'])await bet(alice,o);
 await assert.rejects(bet(alice,'fish'),{code:'TOO_MANY_OPTIONS'});
 await assert.rejects(bet(alice,'tomato','12345'),{code:'INVALID_STAKE'});
 await bet(bob,'steak','10000');
 assert.equal(await partnerBalance('alice'),before.alice-60000n);assert.equal(await partnerBalance('bob'),before.bob-10000n);
 const totals=(await casino.casinoState(bob)).totals;assert.equal(totals.tomato.stake_minor,'10000');assert.equal(totals.steak.players,1);
 await pool.query('UPDATE casino_rounds SET bet_until=$2 WHERE id=$1',[state.round.id,Date.now()-1]);
 await assert.rejects(bet(bob,'fish'),{code:'BETTING_CLOSED'});
 await casino.tickCasino();await casino.tickCasino();await recover();
 const round=(await pool.query('SELECT status,result FROM casino_rounds WHERE id=$1',[state.round.id])).rows[0];assert.equal(round.status,'settled');
 const bets=(await pool.query('SELECT external_user_id,option_id,stake_minor,payout_minor,status FROM casino_bets WHERE round_id=$1',[state.round.id])).rows;
 assert.ok(bets.every(b=>b.status==='SETTLED'));
 const m={tomato:5,corn:5,carrot:5,lettuce:5,shrimp:10,fish:15,steak:25,chicken:45};
 for(const b of bets)assert.equal(BigInt(b.payout_minor),round.result.winners.includes(b.option_id)?BigInt(b.stake_minor)*BigInt(m[b.option_id]):0n);
 const won=u=>bets.filter(b=>b.external_user_id===u).reduce((a,b)=>a+BigInt(b.payout_minor),0n);
 assert.equal(await partnerBalance('alice'),before.alice-60000n+won('alice'));assert.equal(await partnerBalance('bob'),before.bob-10000n+won('bob'));
 assert.equal(await transit(),'0');
 const after=await casino.casinoState(alice);assert.equal(after.history[0]?.outcome??round.result.outcome,round.result.outcome);
});


test('RocketStar2 hides the crash point in flight and pays manual and automatic cash-outs below it',async()=>{
 const {timeToReach}=await import('../server/casino/crash.mjs');
 const [alice,bob]=await Promise.all([sessionFor('alice','rocketstar2'),sessionFor('bob','rocketstar2')]);
 const s0=await casino.casinoState(alice);assert.equal(s0.round.status,'betting');assert.equal(s0.round.reveal_at,null);
 const before={alice:await partnerBalance('alice'),bob:await partnerBalance('bob')};
 const auto=await casino.placeBet(alice,{request_id:uid('bet'),round_id:s0.round.id,option_id:'a',stake_minor:'10000',auto_x100:150});
 await assert.rejects(casino.placeBet(alice,{request_id:uid('bet'),round_id:s0.round.id,option_id:'a',stake_minor:'10000'}),{code:'OPTION_ALREADY_BET'});
 await assert.rejects(casino.placeBet(alice,{request_id:uid('bet'),round_id:s0.round.id,option_id:'b',stake_minor:'10000',auto_x100:100}),{code:'INVALID_AUTO_CASHOUT'});
 const manual=await casino.placeBet(bob,{request_id:uid('bet'),round_id:s0.round.id,option_id:'a',stake_minor:'10000'});
 const late=await casino.placeBet(bob,{request_id:uid('bet'),round_id:s0.round.id,option_id:'b',stake_minor:'10000'});
 // Close betting with a pinned crash point (5.00x) and the flight at ~1.30x, for a deterministic test.
 const now=Date.now(),start=now-timeToReach(130);
 await pool.query(`UPDATE casino_rounds SET status='drawing',result='{"outcome":"5.00","crash_x100":500}'::jsonb,bet_until=$2,reveal_at=$3,ends_at=$4 WHERE id=$1`,[s0.round.id,start,start+timeToReach(500),start+timeToReach(500)+3500]);
 const flying=await casino.casinoState(bob);assert.equal(flying.round.status,'drawing');assert.equal(flying.round.result,undefined);assert.equal(flying.round.reveal_at,null);
 const out=await casino.cashOut(bob,{bet_id:manual.id});assert.ok(out.cashout_x100>=130&&out.cashout_x100<140,String(out.cashout_x100));
 assert.equal((await casino.casinoState(bob)).cashouts.length,1);
 await pool.query('UPDATE casino_rounds SET reveal_at=$2,ends_at=$3 WHERE id=$1',[s0.round.id,Date.now()-1,Date.now()+3000]);
 await assert.rejects(casino.cashOut(bob,{bet_id:late.id}),{code:'CRASHED'});
 await casino.tickCasino();await casino.tickCasino();await recover();
 const bets=Object.fromEntries((await pool.query('SELECT id,payout_minor,status FROM casino_bets WHERE round_id=$1',[s0.round.id])).rows.map(b=>[b.id,b]));
 assert.equal(bets[auto.id].payout_minor,'15000');assert.equal(bets[late.id].payout_minor,'0');assert.equal(bets[manual.id].payout_minor,String(100*out.cashout_x100));
 assert.ok(Object.values(bets).every(b=>b.status==='SETTLED'));
 assert.equal(await partnerBalance('alice'),before.alice-10000n+15000n);assert.equal(await partnerBalance('bob'),before.bob-20000n+BigInt(100*out.cashout_x100));
 assert.equal(await transit(),'0');
 const done=await casino.casinoState(alice);assert.equal(done.round.result.crash_x100,500);
});

test('TeenPatti deals three hands and pays the winning hand x2.91',async()=>{
 const alice=await sessionFor('alice','teenpatti'),s0=await casino.casinoState(alice),before=await partnerBalance('alice');
 for(const o of ['ruby','jade','sapphire'])await casino.placeBet(alice,{request_id:uid('bet'),round_id:s0.round.id,option_id:o,stake_minor:'10000'});
 assert.equal(await partnerBalance('alice'),before-30000n);
 await pool.query('UPDATE casino_rounds SET bet_until=$2 WHERE id=$1',[s0.round.id,Date.now()-1]);
 await casino.tickCasino();await casino.tickCasino();await recover();
 const r=(await pool.query('SELECT result,status FROM casino_rounds WHERE id=$1',[s0.round.id])).rows[0];
 assert.equal(r.status,'settled');assert.equal(new Set(Object.values(r.result.hands).flat()).size,9,'nine distinct cards');
 assert.equal(await partnerBalance('alice'),before-30000n+29100n);assert.equal(await transit(),'0');
});

test('an Olympus spin is one wallet cycle: stake debited, the complete win credited once',async()=>{
 const alice=await sessionFor('alice','olympus'),before=await partnerBalance('alice');
 const st=await casino.casinoState(alice,{balance:true});assert.equal(st.kind,'instant');
 const instant=await import('../server/casino/instant.mjs');
 const request_id=uid('spin'),r=await instant.spin(alice,{request_id,stake_minor:'1000'});
 assert.equal(r.status,'SETTLED');assert.ok(r.result.spins.length>=1);
 assert.deepEqual(await instant.spin(alice,{request_id,stake_minor:'1000'}),r,'same request_id replays the same spin');
 await recover();
 assert.equal(await partnerBalance('alice'),before-1000n+BigInt(r.payout_minor));assert.equal(await transit(),'0');
});

test('buying the Olympus free spins debits base x 10.2 and plays the feature directly',async()=>{
 const alice=await sessionFor('alice','olympus'),before=await partnerBalance('alice'),instant=await import('../server/casino/instant.mjs');
 const r=await instant.spin(alice,{request_id:uid('buy'),stake_minor:'1000',buy:true});
 assert.equal(r.mode,'buy');assert.equal(r.stake_minor,'10200');assert.equal(r.base_stake_minor,'1000');assert.ok(r.result.spins.every(s=>s.free));
 await recover();assert.equal(await partnerBalance('alice'),before-10200n+BigInt(r.payout_minor));assert.equal(await transit(),'0');
});

test('GreedyKing group bets: SALAD pays x1.25 on any vegetable and PIZZA x4.37 on any meat',async()=>{
 const alice=await sessionFor('carol','greedyking'),s0=await casino.casinoState(alice),before=await partnerBalance('carol');
 await casino.placeBet(alice,{request_id:uid('bet'),round_id:s0.round.id,option_id:'salad',stake_minor:'100000'});
 await assert.rejects(casino.placeBet(alice,{request_id:uid('bet'),round_id:s0.round.id,option_id:'pizza',stake_minor:'10000'}),{code:'INVALID_STAKE'});
 await pool.query('UPDATE casino_rounds SET bet_until=$2 WHERE id=$1',[s0.round.id,Date.now()-1]);await casino.tickCasino();await casino.tickCasino();await recover();
 const r=(await pool.query('SELECT result FROM casino_rounds WHERE id=$1',[s0.round.id])).rows[0].result;
 const veg=['carrot','cabbage','corn','tomato'].some(v=>r.winners.includes(v));
 assert.equal(await partnerBalance('carol'),before-100000n+(veg?125000n:0n));assert.equal(await transit(),'0');
});

test('FruitParty feeds 2% of each stake into the jackpot and a jackpot draw pays it to the winning bets',async()=>{
 const [alice,bob]=await Promise.all([sessionFor('carol','fruitparty'),sessionFor('dave','fruitparty')]);
 const s0=await casino.casinoState(alice),fruits=['cherry','lemon','orange','plum','bell','watermelon','seven','star'];
 const before={carol:await partnerBalance('carol'),dave:await partnerBalance('dave')};
 for(const f of fruits)await casino.placeBet(alice,{request_id:uid('bet'),round_id:s0.round.id,option_id:f,stake_minor:'100000'});
 await casino.placeBet(bob,{request_id:uid('bet'),round_id:s0.round.id,option_id:'star',stake_minor:'100000'});
 const pool0=BigInt((await casino.casinoState(alice)).jackpot_minor);assert.equal(pool0,9n*2000n,'2% of nine 1,000-coin bets');
 // Force the close to draw a jackpot bonus by pinning the round seed until one is found.
 const {wheelModel,drawWheel}=await import('../server/casino/wheel.mjs');const {CASINO_GAMES}=await import('../shared/casino-games.mjs');const {seal}=await import('../server/security.mjs');
 const m=wheelModel(CASINO_GAMES.fruitparty);let seed;do seed=randomBytes(32).toString('hex');while(drawWheel(m,seed).bonus.type!=='jackpot');
 await pool.query('UPDATE casino_rounds SET seed_enc=$2,bet_until=$3 WHERE id=$1',[s0.round.id,seal(seed),Date.now()-1]);
 await casino.tickCasino();await casino.tickCasino();await recover();
 const r=(await pool.query('SELECT result FROM casino_rounds WHERE id=$1',[s0.round.id])).rows[0].result;
 assert.equal(r.bonus.type,'jackpot');assert.equal(r.jackpot.pool_minor,String(pool0));
 const bets=(await pool.query('SELECT external_user_id,option_id,stake_minor,payout_minor,jackpot_minor FROM casino_bets WHERE round_id=$1',[s0.round.id])).rows;
 const jack=bets.reduce((a,b)=>a+BigInt(b.jackpot_minor||0),0n);assert.equal(String(jack),r.jackpot.paid_minor);assert.ok(jack>0n);
 assert.equal(BigInt((await casino.casinoState(alice)).jackpot_minor),pool0-jack);
 const paid=u=>bets.filter(b=>b.external_user_id===u).reduce((a,b)=>a+BigInt(b.payout_minor),0n);
 assert.equal(await partnerBalance('carol'),before.carol-800000n+paid('carol'));assert.equal(await partnerBalance('dave'),before.dave-100000n+paid('dave'));
 assert.equal(await transit(),'0');
});

test('lines and ways slots (OceanSlot, MahjongSlot) settle one complete cycle per spin',async()=>{
 const instant=await import('../server/casino/instant.mjs');
 for(const game of ['oceanslot','mahjongslot']){
  const carol=await sessionFor('carol',game),before=await partnerBalance('carol');
  const r=await instant.spin(carol,{request_id:uid('spin'),stake_minor:'1000'});
  assert.equal(r.status,'SETTLED');assert.ok(r.result.spins[0].initial.length===5,game);
  await recover();assert.equal(await partnerBalance('carol'),before-1000n+BigInt(r.payout_minor),game);
 }
 assert.equal(await transit(),'0');
});

test('SicBo and roulette settle every board bet against the drawn dice or number',async()=>{
 for(const [game,options] of [['sicbo',['big','small','triple']],['roulette',['zero','d1','red','odd']]]){
  const carol=await sessionFor('carol',game),s0=await casino.casinoState(carol),before=await partnerBalance('carol');
  for(const o of options)await casino.placeBet(carol,{request_id:uid('bet'),round_id:s0.round.id,option_id:o,stake_minor:'100000'});
  await pool.query('UPDATE casino_rounds SET bet_until=$2 WHERE id=$1',[s0.round.id,Date.now()-1]);await casino.tickCasino();await casino.tickCasino();await recover();
  const r=(await pool.query('SELECT result FROM casino_rounds WHERE id=$1',[s0.round.id])).rows[0].result;
  const bets=(await pool.query('SELECT option_id,payout_minor FROM casino_bets WHERE round_id=$1',[s0.round.id])).rows;
  if(game==='sicbo'){const d=r.outcome.slice(1).split('').map(Number),t=d[0]===d[1]&&d[1]===d[2],s=d[0]+d[1]+d[2];
   assert.equal(bets.find(b=>b.option_id==='big').payout_minor,!t&&s>=11?'200000':'0');assert.equal(bets.find(b=>b.option_id==='triple').payout_minor,t?'3500000':'0');}
  const paid=bets.reduce((a,b)=>a+BigInt(b.payout_minor),0n);
  assert.equal(await partnerBalance('carol'),before-BigInt(options.length)*100000n+paid,game);
 }
 assert.equal(await transit(),'0');
});

test('casino history lists the player\'s revealed rounds and spins with stake and payout',async()=>{
 await pool.query("UPDATE casino_rounds SET reveal_at=$1 WHERE game_id='sicbo' AND status='settled'",[Date.now()-1]);
 const carol=await sessionFor('carol','sicbo'),h=await casino.casinoHistory(carol);
 assert.equal(h.kind,'round');assert.ok(h.records.length>=1);const r=h.records[0];assert.equal(r.bets.length,3);
 assert.equal(r.stake_minor,'300000');assert.equal(r.payout_minor,String(r.bets.reduce((a,b)=>a+BigInt(b.payout_minor),0n)));
 const spins=await casino.casinoHistory(await sessionFor('carol','oceanslot'));assert.equal(spins.kind,'instant');assert.equal(spins.records[0].stake_minor,'1000');
 const other=await casino.casinoHistory(await sessionFor('dave','sicbo'));assert.equal(other.records.length,0,'never another player\'s records');
});

test('an arcade session (Monster) debits its ammo once, resolves shots on the server and settles wins plus unused ammo',async()=>{
 const arcade=await import('../server/casino/arcade.mjs');
 const carol=await sessionFor('carol','monster'),before=await partnerBalance('carol');
 const open=await arcade.openArcade(carol,{request_id:uid('arc'),bet_minor:'1000',shots:20});
 assert.equal(open.status,'OPEN');assert.equal(await partnerBalance('carol'),before-20000n);
 await assert.rejects(arcade.openArcade(carol,{request_id:uid('arc'),bet_minor:'1000',shots:20}),{code:'ARCADE_OPEN'});
 let seq=0,last;
 for(let i=0;i<5;i++)last=await arcade.shoot(carol,{arcade_id:open.id,seq:++seq,weapon:'arrow',targets:['dragon']});
 const again=await arcade.shoot(carol,{arcade_id:open.id,seq,weapon:'arrow',targets:['dragon']});assert.deepEqual(again.hits,last.hits,'a replayed shot returns its stored result');
 await assert.rejects(arcade.shoot(carol,{arcade_id:open.id,seq:seq+2,weapon:'arrow',targets:['bat']}),{code:'SHOT_OUT_OF_ORDER'});
 await arcade.shoot(carol,{arcade_id:open.id,seq:++seq,weapon:'lightning',targets:['bat','slime','goblin','wolf','orc']});
 await assert.rejects(arcade.shoot(carol,{arcade_id:open.id,seq:++seq,weapon:'triple',targets:['bat','slime','goblin','wolf']}),{code:'INVALID_TARGETS'});
 const closed=await arcade.closeArcade(carol,{arcade_id:open.id});assert.equal(closed.status,'SETTLED');assert.equal(closed.used,10);assert.ok(closed.seed);
 await recover();
 assert.equal(await partnerBalance('carol'),before-20000n+BigInt(closed.win_minor)+10000n);assert.equal(await transit(),'0');
});
