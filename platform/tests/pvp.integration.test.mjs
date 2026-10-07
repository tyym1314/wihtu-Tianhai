import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as match from '../arena/match/engine.mjs';
import {ARENA_IDS,ARENA_GAMES} from '../shared/games.mjs';
import {engines} from '../server/pvp/engines.mjs';
let pool,closePools,locked,seal,validate,migratePlatform,migrateWallet,provisionWallet,createWalletServer,readWalletSnapshot,giftForTest,migratePvp,routePvp,tickPvp,readPvpMatch;
let wallet,origin,admin,databaseCreated=false,localDir;
const uid=p=>p+'_'+randomBytes(8).toString('hex');
const databaseName='oasis_pvp_test_'+process.pid+'_'+randomBytes(8).toString('hex');
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
const databaseUrl=new URL(adminUrl);databaseUrl.pathname='/'+databaseName;
const previousEnv={database:process.env.OASIS_DATABASE_URL,localDir:process.env.OASIS_LOCAL_DIR,walletOrigins:process.env.OASIS_WALLET_ALLOWED_ORIGINS};
before(async()=>{
 // This must precede every backend import: db.mjs creates its pools at module evaluation.
 assert.match(databaseName,/^oasis_pvp_test_[0-9]+_[a-f0-9]{16}$/);
 admin=new pg.Pool({connectionString:adminUrl.toString(),max:2});
 await admin.query(`CREATE DATABASE "${databaseName}"`);databaseCreated=true;
 localDir=await mkdtemp(join(tmpdir(),'oasis-pvp-test-'));
 process.env.OASIS_DATABASE_URL=databaseUrl.toString();process.env.OASIS_LOCAL_DIR=localDir;
 ({pool,closePools,locked}=await import('../server/db.mjs'));
 ({seal}=await import('../server/security.mjs'));
 ({validate,migratePlatform}=await import('../server/platform.mjs'));
 ({migrateWallet,provisionWallet,createWalletServer,readWalletSnapshot,giftForTest}=await import('../server/wallet/index.mjs'));
 ({migratePvp,routePvp,tickPvp,readPvpMatch}=await import('../server/pvp/index.mjs'));
 assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,databaseName);
 await migratePlatform();await migrateWallet(pool);await migratePvp(pool);await (await import('../server/wallet-binding.mjs')).migrateWalletBindings(pool);
 wallet=createWalletServer(pool);await new Promise(r=>wallet.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+wallet.address().port;process.env.OASIS_WALLET_ALLOWED_ORIGINS=origin;
 console.log('[pvp isolation] created '+databaseName+'; actual pool verified; wallet uses isolated database');
});
after(async()=>{
 const errors=[];
 if(wallet?.listening)try{await new Promise((resolve,reject)=>wallet.close(e=>e?reject(e):resolve()));}catch(e){errors.push(e);}
 if(closePools)try{await closePools();}catch(e){errors.push(e);}
 if(databaseCreated)try{
  await dropOwnedTestDatabase(admin,databaseName,{created:databaseCreated});
  console.log('[pvp isolation] dropped '+databaseName+'; verified absent from pg_database');
 }catch(e){errors.push(e);}
 if(admin)try{await admin.end();}catch(e){errors.push(e);}
 if(localDir)try{await rm(localDir,{recursive:true,force:true});}catch(e){errors.push(e);}
 for(const [key,value]of [['OASIS_DATABASE_URL',previousEnv.database],['OASIS_LOCAL_DIR',previousEnv.localDir],['OASIS_WALLET_ALLOWED_ORIGINS',previousEnv.walletOrigins]])if(value===undefined)delete process.env[key];else process.env[key]=value;
 if(errors.length)throw new AggregateError(errors,'Isolated PvP test cleanup failed');
});
async function fixture(game='match',balances=['100000','100000','100000','100000']){
 const app={id:uid('pvptest'),partner_id:uid('partner'),environment:'sandbox',wallet_scope_id:uid('wallet'),currency_id:'COIN',wallet_url:origin};const scope={partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id};
 const key_id=uid('walletkey'),secret_base64=randomBytes(32).toString('base64');
 await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[app.id,'PvP isolated test fixture',app.partner_id,app.environment,app.wallet_scope_id,origin,JSON.stringify(ARENA_IDS)]);
 await pool.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'platform-to-wallet',$3)",[key_id,app.id,seal(secret_base64)]);
 await provisionWallet(pool,{scope,key_id,secret_base64,users:balances.map((balance_minor,i)=>({external_user_id:'player_'+i,balance_minor})),treasury_minor:'1000000000'});
 return{app,scope,sessions:balances.map((_,i)=>({id:uid('session'),app_id:app.id,external_user_id:'player_'+i,game_id:game}))};
}
const call=(s,method,path,body={},opts={})=>routePvp(s,method,path,method==='POST'?{request_id:uid('request'),...body}:body,opts);
async function setup(f,n=2,entry='10000',practice=false){const created=await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:f.sessions[0].game_id,capacity:n,entry_minor:entry,practice});const room=created.body;if(!practice)for(let i=1;i<n;i++)await call(f.sessions[i],'POST',`/api/pvp/rooms/${room.code}/join`);for(let i=0;i<(practice?1:n);i++)await call(f.sessions[i],'POST',`/api/pvp/rooms/${room.id}/ready`);await tickPvp({roomIds:[room.id]});if(f.sessions[0].game_id==='run')for(let i=0;i<(practice?1:n);i++)await call(f.sessions[i],'POST',`/api/pvp/rooms/${room.id}/scene-ready`);return(await call(f.sessions[0],'GET',`/api/pvp/rooms/${room.id}`)).body;}
const read=async id=>(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];
const snapshot=f=>readWalletSnapshot(pool,{scope:f.scope});
async function startPaidRunRace(f,room){
 const armed=await read(room.id);assert.equal(armed.game_state.phase,'countdown');
 const raceAt=Number(armed.starts_at)+1;
 const started=(await call(f.sessions[0],'GET',`/api/pvp/rooms/${room.id}`,{}, {now:raceAt,skipGap:true})).body;
 assert.equal(started.game.phase,'racing');assert.equal(started.starts_at,Number(armed.starts_at));
 return raceAt;
}
async function deadline(id){await locked('pvp:'+id,async()=>{const r=await read(id),now=Date.now()-1;r.game_state.deadlineAt=now;for(const p of Object.values(r.game_state.players))p.busyUntil=now;await pool.query('UPDATE pvp_rooms SET game_state=$2,last_tick_at=$3 WHERE id=$1',[id,r.game_state,now]);});await tickPvp({roomIds:[id]});}
function conservation(s){assert.equal(s.ledger.reduce((sum,l)=>sum+BigInt(l.delta_available)+BigInt(l.delta_reserved),0n),0n);assert.ok(s.users.every(u=>BigInt(u.available)>=0n&&u.reserved==='0'&&u.credit_pending==='0'));}
for(const game of['run','match','golf','towerlink'])test(`${game} historical waiting rooms start and execute their pinned rules after deployment`,async()=>{
 const f=await fixture(game),legacyVersion=game==='towerlink'?'towerlink-v2.1.0':`pvp-${game}-v1.0.0`;
 const r=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:game,capacity:2,entry_minor:'0',practice:true})).body;
 await pool.query("UPDATE pvp_rooms SET rule_version=$2,terms=jsonb_set(terms,'{rule_version}',to_jsonb($2::text)) WHERE id=$1",[r.id,legacyVersion]);
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/ready`);await tickPvp({roomIds:[r.id]});
 const started=(await call(f.sessions[0],'GET',`/api/pvp/rooms/${r.id}`)).body;assert.equal(started.status,'active');assert.equal(started.game.ruleVersion,legacyVersion);
 let db=await read(r.id);assert.equal(db.rule_version,legacyVersion);assert.equal(db.game_state.ruleVersion,legacyVersion);assert.equal(db.terms.rule_version,legacyVersion);
 const now=Math.max(Date.now(),Number(db.last_tick_at),db.game_state.startedAt||0);engines[game].tick(db.game_state,now);const action=game==='run'?{type:'jump'}:engines[game].botAction(db.game_state,'player_0',now);assert(action,'historical rules produce a legal action');
 const acted=(await call(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/action`,{seq:1,action},{now})).body;assert.equal(acted.game.ruleVersion,legacyVersion);assert.equal(acted.me_last_seq,1);
 await tickPvp({roomIds:[r.id]});db=await read(r.id);assert.equal(db.game_state.ruleVersion,legacyVersion);assert.equal(db.status,'active');
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/leave`);assert.equal((await read(r.id)).status,'cancelled');assert.equal((await snapshot(f)).operations.length,0);
});
test('new paid Run waits for both rendered humans, then uses one immutable countdown and supports reconnect',async()=>{
 const f=await fixture('run');const created=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'run',capacity:2,entry_minor:'10000'})).body;
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${created.id}/join`);
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${created.id}/ready`);
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${created.id}/ready`);
 await tickPvp({roomIds:[created.id]});let db=await read(created.id);
 assert.equal(db.rule_version,engines.run.RULE_VERSION);assert.equal(db.game_state.phase,'arming');assert.equal(db.starts_at,null);
 assert.ok(db.game_state.players.every(p=>p.distanceU===0));
 const firstAt=Number(db.last_tick_at)+1000,firstRequest={request_id:uid('scene_ready')};
 await assert.rejects(call(f.sessions[2],'POST',`/api/pvp/rooms/${created.id}/scene-ready`,{}, {now:firstAt,skipGap:true}),{code:'NOT_A_PLAYER'});
 const first=await routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${created.id}/scene-ready`,firstRequest,{now:firstAt,skipGap:true});
 assert.equal(first.body.start_protocol.ready_count,1);assert.equal(first.body.game.phase,'arming');
 const replay=await routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${created.id}/scene-ready`,firstRequest,{now:firstAt+1,skipGap:true});assert.deepEqual(replay,first);
 db=await read(created.id);assert.equal(db.game_state.tick,0);
 const secondAt=firstAt+5000;
 await tickPvp({roomIds:[created.id],now:secondAt-1,skipGap:true});db=await read(created.id);assert.equal(db.game_state.phase,'arming');assert.ok(db.game_state.players.every(p=>p.distanceU===0));
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${created.id}/scene-ready`,{}, {now:secondAt-100,skipGap:true});
 const second=await call(f.sessions[1],'POST',`/api/pvp/rooms/${created.id}/scene-ready`,{}, {now:secondAt,skipGap:true});
 assert.equal(second.body.game.phase,'countdown');assert.equal(second.body.start_protocol.ready_count,2);
 const startAt=secondAt+engines.run.RUN_START_COUNTDOWN_MS;assert.equal(second.body.starts_at,startAt);
 await assert.rejects(call(f.sessions[0],'POST',`/api/pvp/rooms/${created.id}/action`,{seq:1,action:{type:'jump'}},{now:startAt-1,skipGap:true}),{code:'NOT_STARTED'});
 await tickPvp({roomIds:[created.id],now:startAt-1,skipGap:true});db=await read(created.id);assert.equal(db.game_state.tick,0);assert.ok(db.game_state.players.every(p=>p.distanceU===0));
 const repeat=await call(f.sessions[0],'POST',`/api/pvp/rooms/${created.id}/scene-ready`,{}, {now:startAt-1,skipGap:true});assert.equal(repeat.body.starts_at,startAt);
 const resumed=(await call(f.sessions[0],'GET',`/api/pvp/rooms/${created.id}`,{}, {now:startAt+1000,skipGap:true})).body;
 assert.equal(resumed.starts_at,startAt);assert.equal(resumed.game.phase,'racing');assert.ok(resumed.game.snapshotTick>=60);assert.equal(resumed.players.filter(p=>p.scene_ready).length,2);
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${created.id}/leave`,{}, {now:startAt+1001,skipGap:true});await tickPvp({roomIds:[created.id],now:startAt+1002,skipGap:true});conservation(await snapshot(f));
});
test('Run scene-ready deadline and explicit departure void captured matches with full refunds',async()=>{
 for(const scenario of ['timeout','departure']){
  const f=await fixture('run');const room=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'run',capacity:2,entry_minor:'10000'})).body;
  await call(f.sessions[1],'POST',`/api/pvp/rooms/${room.id}/join`);for(const s of f.sessions.slice(0,2))await call(s,'POST',`/api/pvp/rooms/${room.id}/ready`);
  await tickPvp({roomIds:[room.id]});let db=await read(room.id);assert.equal(db.status,'active');assert.equal(db.game_state.phase,'arming');assert.equal((await snapshot(f)).users[0].available,'90000');
  await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/scene-ready`);
  if(scenario==='timeout')await tickPvp({roomIds:[room.id],now:Number(db.game_state.armingDeadlineAt)+1,skipGap:true});
  else await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/leave`);
  db=await read(room.id);assert.equal(db.status,'voided',JSON.stringify(db.error));assert.equal(db.result.resolution,'void');assert.equal(db.result.reason,scenario==='timeout'?'scene_ready_timeout':'scene_ready_aborted');assert.equal(db.result.fee_minor,'0');
  const walletState=await snapshot(f);assert.ok(walletState.users.every(u=>u.available==='100000'));conservation(walletState);
 }
});
test('Run arming deadline remains absolute when the room receives no ticks',async()=>{
 const f=await fixture('run'),room=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'run',capacity:2,entry_minor:'10000'})).body;
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${room.id}/join`);
 for(const session of f.sessions.slice(0,2))await call(session,'POST',`/api/pvp/rooms/${room.id}/ready`);
 await tickPvp({roomIds:[room.id]});const armed=await read(room.id),deadline=Number(armed.game_state.armingDeadlineAt);
 assert.equal(armed.game_state.phase,'arming');assert.ok(deadline-Number(armed.last_tick_at)>5000);
 await assert.rejects(call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/scene-ready`,{}, {now:deadline+1}),{code:'NOT_ACTIVE'});
 const ended=await read(room.id),walletState=await snapshot(f);
 assert.equal(ended.status,'voided');assert.equal(ended.result.reason,'scene_ready_timeout');assert.equal(ended.result.fee_minor,'0');
 assert.equal(Number(ended.game_state.armingDeadlineAt),deadline);
 assert.ok(walletState.users.every(user=>user.available==='100000'));conservation(walletState);
});
test('Run paid countdown departure before starts_at voids with no fee',async()=>{
 const f=await fixture('run'),room=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'run',capacity:2,entry_minor:'10000'})).body;
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${room.id}/join`);
 for(const session of f.sessions.slice(0,2))await call(session,'POST',`/api/pvp/rooms/${room.id}/ready`);
 await tickPvp({roomIds:[room.id]});const armed=await read(room.id),firstAt=Number(armed.last_tick_at)+500;
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/scene-ready`,{}, {now:firstAt,skipGap:true});
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${room.id}/scene-ready`,{}, {now:firstAt+500,skipGap:true});
 const countdown=await read(room.id);assert.equal(countdown.game_state.phase,'countdown');assert.equal(countdown.game_state.tick,0);
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/leave`,{}, {now:Number(countdown.starts_at)-1});
 const ended=await read(room.id),walletState=await snapshot(f);
 assert.equal(ended.status,'voided');assert.equal(ended.result.reason,'scene_ready_aborted');assert.equal(ended.result.fee_minor,'0');
 assert.ok(walletState.users.every(user=>user.available==='100000'));conservation(walletState);
});
test('Run waits for recently present humans and refunds if a ready player stays away',async()=>{
 const f=await fixture('run'),room=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'run',capacity:2,entry_minor:'10000'})).body;
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${room.id}/join`);
 for(const session of f.sessions.slice(0,2))await call(session,'POST',`/api/pvp/rooms/${room.id}/ready`);
 await tickPvp({roomIds:[room.id]});const armed=await read(room.id),firstAt=Number(armed.last_tick_at)+1000;
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/scene-ready`,{}, {now:firstAt,skipGap:true});
 const secondAt=firstAt+5000;
 const second=(await call(f.sessions[1],'POST',`/api/pvp/rooms/${room.id}/scene-ready`,{}, {now:secondAt,skipGap:true})).body;
 assert.equal(second.game.phase,'arming');assert.equal(second.start_protocol.ready_count,1);assert.equal(second.starts_at,null);
 await tickPvp({roomIds:[room.id],now:Number(armed.game_state.armingDeadlineAt)+1});
 const ended=await read(room.id),walletState=await snapshot(f);
 assert.equal(ended.status,'voided');assert.equal(ended.result.reason,'scene_ready_timeout');assert.equal(ended.result.fee_minor,'0');
 assert.ok(walletState.users.every(user=>user.available==='100000'));conservation(walletState);
});
test('Run foreground polling alone cannot replace a fresh rendered-frame acknowledgement',async()=>{
 const f=await fixture('run'),room=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'run',capacity:2,entry_minor:'10000'})).body;
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${room.id}/join`);
 for(const session of f.sessions.slice(0,2))await call(session,'POST',`/api/pvp/rooms/${room.id}/ready`);
 await tickPvp({roomIds:[room.id]});const armed=await read(room.id),firstAt=Number(armed.last_tick_at)+1000,secondAt=firstAt+5000;
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/scene-ready`,{}, {now:firstAt,skipGap:true});
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${room.id}/scene-ready`,{}, {now:secondAt,skipGap:true});
 const polled=(await call(f.sessions[0],'GET',`/api/pvp/rooms/${room.id}`,{}, {now:secondAt+100,skipGap:true})).body;
 assert.equal(polled.game.phase,'arming');assert.equal(polled.starts_at,null);
 const refreshed=(await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/scene-ready`,{}, {now:secondAt+200,skipGap:true})).body;
 assert.equal(refreshed.game.phase,'countdown');assert.equal(refreshed.starts_at,secondAt+200+engines.run.RUN_START_COUNTDOWN_MS);
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/leave`,{}, {now:refreshed.starts_at-1,skipGap:true});
 const ended=await read(room.id);assert.equal(ended.status,'voided');assert.equal(ended.result.fee_minor,'0');conservation(await snapshot(f));
});
test('persisted Run v2.0 room keeps immediate start and rejects the new acknowledgement',async()=>{
 const f=await fixture('run'),room=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'run',capacity:2,entry_minor:'0',practice:true})).body;
 const previous='pvp-run-v2.0.0';await pool.query("UPDATE pvp_rooms SET rule_version=$2,terms=jsonb_set(terms,'{rule_version}',to_jsonb($2::text)) WHERE id=$1",[room.id,previous]);
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/ready`);await tickPvp({roomIds:[room.id]});const db=await read(room.id);
 assert.equal(db.game_state.ruleVersion,previous);assert.equal(db.game_state.phase,'racing');assert.equal(Number(db.starts_at),db.game_state.startedAt);
 await assert.rejects(call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/scene-ready`),{code:'UNSUPPORTED_START_PROTOCOL'});
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/leave`);
});
for(const n of [2,3,4])test(`real ${n}-player reserve/capture/tied settlement persists one fee and complete roster`,async()=>{
 const f=await fixture(),r=await setup(f,n);assert.equal(r.status,'active',JSON.stringify(r.error));assert.equal(r.players.length,n);assert.ok(r.players.every(p=>!p.bot));assert.equal(new Set(r.players.map(p=>p.seat_index)).size,n);
 let snap=await snapshot(f);assert.equal(snap.users[0].available,'90000');assert.equal(snap.fee_minor,'0');await deadline(r.id);const done=await read(r.id);assert.equal(done.status,'settled',JSON.stringify(done.error));assert.equal(done.result.fee_minor,String(n*500));assert.ok(done.result.payouts.every(p=>p.payout_minor==='9500'));
 const before=await snapshot(f);await Promise.all([tickPvp({roomIds:[r.id]}),tickPvp({roomIds:[r.id]})]);snap=await snapshot(f);assert.equal(snap.operations.length,n+2);assert.deepEqual(snap.users,before.users);assert.equal(snap.fee_minor,String(n*500));conservation(snap);const support=await readPvpMatch(f.app,r.id);validate('PlatformMatch',support);assert.equal(support.state,'SETTLED');assert.ok(!JSON.stringify(support).includes('board'));
});
test('all five entry tiers conserve the 5% total-pot fee and return principal within payout',async()=>{
 for(const entry of ['1000','5000','10000','20000','50000']){const f=await fixture(),r=await setup(f,2,entry);await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/leave`);await tickPvp({roomIds:[r.id]});const done=await read(r.id);assert.equal(done.status,'settled');assert.equal(done.result.payouts.find(p=>p.external_user_id==='player_0').payout_minor,String(BigInt(entry)*2n*95n/100n));const s=await snapshot(f);assert.equal(s.fee_minor,String(BigInt(entry)/10n));conservation(s);}
});
test('actions are private, sequenced, concurrent-replay safe and survive a module reload',async()=>{
 const f=await fixture(),r=await setup(f);let db=await read(r.id);const action=match.botAction(db.game_state,'player_0',Date.now()),body={request_id:uid('stable'),seq:1,action};
 const responses=await Promise.all(Array.from({length:5},()=>routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/action`,body)));assert.ok(responses.every(v=>v.body.me_last_seq===1));assert.equal((await pool.query('SELECT count(*) FROM pvp_actions WHERE room_id=$1',[r.id])).rows[0].count,'1');
 await assert.rejects(call(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/action`,{seq:1,action}),e=>e.code==='INVALID_SEQUENCE');await assert.rejects(routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/action`,{...body,seq:2}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 const peer=(await call(f.sessions[1],'GET',`/api/pvp/rooms/${r.id}`)).body;assert.equal(peer.game.moves,0);assert.ok(!JSON.stringify(peer).includes('refillCounters'));assert.ok(!JSON.stringify(peer.game).includes('seed'));assert.match(peer.seed_commitment,/^[a-f0-9]{64}$/);
 const restored=await import('../server/pvp/index.mjs?reload='+uid('reload'));await restored.migratePvp(pool);const again=await restored.routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/action`,body);assert.deepEqual(again,responses[0]);
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/leave`);await pool.query("UPDATE pvp_rooms SET game_state=jsonb_set(game_state,ARRAY['players','player_0','busyUntil'],to_jsonb($2::bigint)) WHERE id=$1",[r.id,Date.now()-1]);await tickPvp({roomIds:[r.id]});
});
test('App/game isolation and one active seat prevent user impersonation or double-entry',async()=>{
 const f=await fixture(),other=await fixture(),r=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'match',capacity:2,entry_minor:'10000'})).body;
 validate('PlatformMatch',await readPvpMatch(f.app,r.id));await assert.rejects(call(other.sessions[0],'POST',`/api/pvp/rooms/${r.code}/join`),e=>e.code==='ROOM_NOT_FOUND');await assert.rejects(call({...f.sessions[1],game_id:'golf'},'GET',`/api/pvp/rooms/${r.id}`),e=>e.code==='ROOM_NOT_FOUND');await assert.rejects(call(f.sessions[1],'GET',`/api/pvp/rooms/${r.id}`),e=>e.code==='NOT_A_PLAYER');
 await assert.rejects(call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'match',capacity:2,entry_minor:'10000'}),e=>e.code==='ALREADY_IN_ROOM');await call(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/leave`);await tickPvp({roomIds:[r.id]});assert.equal((await read(r.id)).status,'cancelled');assert.equal((await pool.query('SELECT 1 FROM pvp_active_users WHERE room_id=$1',[r.id])).rowCount,0);
});
test('free practice names all bots and never sends a financial operation',async()=>{
 for(const game of ['match','golf']){const f=await fixture(game),r=await setup(f,4,'10000',true);assert.equal(r.status,'active');assert.equal(r.entry_minor,'0');assert.equal(r.players.filter(p=>p.bot&&p.name.startsWith('BOT')).length,3);assert.equal((await snapshot(f)).operations.length,0);await tickPvp({roomIds:[r.id]});const db=await read(r.id);assert.ok(db.players.filter(p=>p.bot).every(p=>p.last_event));await call(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/leave`);assert.equal((await read(r.id)).status,'cancelled');assert.equal((await pool.query('SELECT 1 FROM pvp_active_users WHERE room_id=$1',[r.id])).rowCount,0);}
});
test('atomic gift racing funding cannot overdraw; failed lobby releases any successful holds',async()=>{
 const f=await fixture('match',['10000','10000','0','0']);const r=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'match',capacity:2,entry_minor:'10000'})).body;await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/join`);await call(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/ready`);await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/ready`);
 await Promise.allSettled([tickPvp({roomIds:[r.id]}),giftForTest(pool,{scope:f.scope,request_id:uid('gift'),from_user_id:'player_0',to_user_id:'player_2',amount_minor:'10000'})]);let db=await read(r.id);if(db.status==='active'){await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/leave`);}await tickPvp({roomIds:[r.id]});db=await read(r.id);assert.ok(['settled','cancelled'].includes(db.status),JSON.stringify(db.error));conservation(await snapshot(f));
});
test('30-second heartbeat batches simultaneous disconnects to void; reconnect before deadline preserves board and seat',async()=>{
 const f=await fixture(),r=await setup(f,3);let db=await read(r.id);const original=structuredClone(db.game_state.players.player_0.board);db.players.forEach(p=>p.last_seen_at=Date.now()-20000);await pool.query('DELETE FROM pvp_presence WHERE room_id=$1',[r.id]);await pool.query('UPDATE pvp_rooms SET players=$2 WHERE id=$1',[r.id,JSON.stringify(db.players)]);const reconnected=(await call(f.sessions[0],'GET',`/api/pvp/rooms/${r.id}`)).body;assert.deepEqual(reconnected.game.board,original);assert.equal(reconnected.players.find(p=>p.external_user_id==='player_0').seat_index,r.players.find(p=>p.external_user_id==='player_0').seat_index);
 db=await read(r.id);db.players.forEach(p=>p.last_seen_at=Date.now()-31000);await pool.query('DELETE FROM pvp_presence WHERE room_id=$1',[r.id]);await pool.query('UPDATE pvp_rooms SET players=$2,last_tick_at=$3 WHERE id=$1',[r.id,JSON.stringify(db.players),Date.now()]);await tickPvp({roomIds:[r.id]});db=await read(r.id);assert.equal(db.status,'voided');assert.equal(db.result.fee_minor,'0');const s=await snapshot(f);assert.ok(s.users.every(u=>u.available==='100000'));conservation(s);
});
test('pause stops new admission, keeps accepted result settlement; shared service outage over60s refunds',async()=>{
 const f=await fixture(),r=await setup(f);await pool.query("UPDATE gp_apps SET status='paused' WHERE id=$1",[f.app.id]);await assert.rejects(call(f.sessions[2],'POST','/api/pvp/rooms',{game_id:'match',capacity:2,entry_minor:'10000'}),e=>e.code==='APP_PAUSED');await deadline(r.id);assert.equal((await read(r.id)).status,'settled');
 const g=await fixture(),v=await setup(g);await pool.query('UPDATE pvp_rooms SET last_tick_at=$2 WHERE id=$1',[v.id,Date.now()-61000]);await tickPvp({roomIds:[v.id]});assert.equal((await read(v.id)).status,'voided');assert.equal((await snapshot(g)).fee_minor,'0');
});
test('Golf paid two-player shot is authoritative and forfeit settles with the same wallet protocol',async()=>{
 const f=await fixture('golf'),r=await setup(f);const shot=await call(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/action`,{seq:1,action:{type:'shot',angle:0,power:.5}});assert.equal(shot.body.me_last_seq,1);assert.ok(shot.body.game.me.trajectory.length>1);await assert.rejects(call(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/action`,{seq:2,action:{type:'shot',angle:0,power:999,score:0}}),e=>['BUSY','INVALID_ACTION'].includes(e.code));await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/leave`);await tickPvp({roomIds:[r.id]});const db=await read(r.id);assert.equal(db.status,'settled');assert.equal(db.result.payouts.find(p=>p.external_user_id==='player_0').payout_minor,'19000');conservation(await snapshot(f));
});
test('dropped successful capture and settlement HTTP responses recover by original durable operation IDs',async()=>{
 const f=await fixture();let drops=new Set(['capture','settle']),forwarded=[];
 const proxy=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const upstream=await fetch(origin+req.url,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:raw});const data=await upstream.text();forwarded.push({method:req.method,path:req.url});const kind=req.url.split('/').pop();if(req.method==='POST'&&drops.has(kind)&&JSON.parse(data).state==='SUCCEEDED'){drops.delete(kind);req.socket.destroy();return;}res.writeHead(upstream.status,{'content-type':'application/json'});res.end(data);});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 try{process.env.OASIS_WALLET_ALLOWED_ORIGINS+=',http://127.0.0.1:'+proxy.address().port;await pool.query('UPDATE gp_apps SET wallet_url=$2 WHERE id=$1',[f.app.id,'http://127.0.0.1:'+proxy.address().port]);let r=await setup(f);assert.equal(r.status,'funding');await pool.query("UPDATE pvp_operations SET next_attempt_at=now() WHERE room_id=$1",[r.id]);await tickPvp({roomIds:[r.id]});assert.equal((await read(r.id)).status,'active');await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/leave`);await tickPvp({roomIds:[r.id]});let db=await read(r.id);assert.equal(db.status,'settling');const fixed=db.result_hash;const s=await snapshot(f);assert.equal(s.fee_minor,'1000');await pool.query("UPDATE pvp_operations SET next_attempt_at=now() WHERE room_id=$1",[r.id]);const restored=await import('../server/pvp/index.mjs?walletrestart='+uid('restart'));await restored.migratePvp(pool);await restored.tickPvp({roomIds:[r.id]});db=await read(r.id);assert.equal(db.status,'settled');assert.equal(db.result_hash,fixed);assert.ok(forwarded.some(x=>x.method==='GET'&&x.path.endsWith('capture_'+r.id)));assert.ok(forwarded.some(x=>x.method==='GET'&&x.path.endsWith('settle_'+r.id)));assert.equal((await snapshot(f)).fee_minor,'1000');conservation(await snapshot(f));}finally{await new Promise(r=>proxy.close(r));}
});

test('fresh OS processes restore the exact room, shuffled seats and board without creating a new entry',async()=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const f=await fixture(),r=await setup(f,4);
 const child=()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./pvp-recovery-child.mjs',import.meta.url)),JSON.stringify({session:f.sessions[0],room_id:r.id,advance:true})],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,OASIS_DATABASE_URL:databaseUrl.toString(),OASIS_LOCAL_DIR:localDir,OASIS_EXPECT_TEST_DATABASE:databaseName},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));});
 const a=await child(),b=await child();assert.equal(a.id,b.id);assert.deepEqual(a.game.board,b.game.board);assert.deepEqual(a.players.map(p=>p.seat_index),b.players.map(p=>p.seat_index));assert.equal((await snapshot(f)).operations.length,5);await deadline(r.id);assert.equal((await read(r.id)).status,'settled');
});
test('four-player tied winners split minor-unit remainder by frozen random seat, never by account ID',async()=>{
 const f=await fixture(),r=await setup(f,4,'1000');await call(f.sessions[3],'POST',`/api/pvp/rooms/${r.id}/leave`);await deadline(r.id);const done=await read(r.id),winners=done.result.payouts.filter(p=>p.rank===1).sort((a,b)=>a.seat_index-b.seat_index);assert.deepEqual(winners.map(p=>p.payout_minor),['1267','1267','1266']);assert.equal(done.result.payouts.find(p=>p.external_user_id==='player_3').payout_minor,'0');assert.equal(done.result.fee_minor,'200');conservation(await snapshot(f));
});
test('readiness expiry records a cancellation tombstone and never captures entries',async()=>{
 const f=await fixture(),r=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'match',capacity:2,entry_minor:'10000'})).body;await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/join`);await call(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/ready`);await pool.query('UPDATE pvp_rooms SET ready_deadline_at=$2 WHERE id=$1',[r.id,Date.now()-1]);await tickPvp({roomIds:[r.id]});assert.equal((await read(r.id)).status,'cancelled');const snap=await snapshot(f);assert.equal(snap.operations.length,1);assert.equal((await pool.query('SELECT response FROM pvp_operations WHERE room_id=$1',[r.id])).rows[0].response.receipt.resource.state,'CANCELLED');assert.ok(snap.users.every(u=>u.available==='100000'));await assert.rejects(call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/ready`),e=>e.code==='NOT_WAITING');
});
test('short shared-service pause shifts clock and heartbeat equally, preserving the same seed/board',async()=>{
 const f=await fixture(),r=await setup(f),old=await read(r.id);const ago=Date.now()-10000;await pool.query('UPDATE pvp_rooms SET last_tick_at=$2 WHERE id=$1',[r.id,ago]);await tickPvp({roomIds:[r.id]});const recovered=await read(r.id);assert.equal(recovered.status,'active');assert.ok(recovered.game_state.deadlineAt-old.game_state.deadlineAt>=10000);assert.deepEqual(recovered.game_state.players.player_0.board,old.game_state.players.player_0.board);assert.equal(recovered.seed_enc,old.seed_enc);await deadline(r.id);conservation(await snapshot(f));
});
test('cancelling an unknown-but-committed capture refunds all seats through one void settlement',async()=>{
 const f=await fixture();let dropped=false;const proxy=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const upstream=await fetch(origin+req.url,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:raw});const data=await upstream.text();if(!dropped&&req.method==='POST'&&req.url.endsWith('/capture')&&JSON.parse(data).state==='SUCCEEDED'){dropped=true;req.socket.destroy();return;}res.writeHead(upstream.status,{'content-type':'application/json'});res.end(data);});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 try{process.env.OASIS_WALLET_ALLOWED_ORIGINS+=',http://127.0.0.1:'+proxy.address().port;await pool.query('UPDATE gp_apps SET wallet_url=$2 WHERE id=$1',[f.app.id,'http://127.0.0.1:'+proxy.address().port]);const r=await setup(f);assert.equal(r.status,'funding');await call(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/leave`);await tickPvp({roomIds:[r.id]});const db=await read(r.id);assert.equal(db.status,'voided',JSON.stringify(db.error));assert.equal(db.result.fee_minor,'0');const snap=await snapshot(f);assert.ok(snap.users.every(u=>u.available==='100000'));assert.equal(snap.fee_minor,'0');assert.equal(snap.operations.filter(o=>o.operation_id===`settle_${r.id}`).length,1);conservation(snap);}finally{await new Promise(r=>proxy.close(r));}
});

for(const n of [3,4])test(`Golf ${n} real players share the same atomic capture and winner settlement`,async()=>{
 const f=await fixture('golf'),r=await setup(f,n);assert.equal(r.status,'active');for(let i=1;i<n;i++)await call(f.sessions[i],'POST',`/api/pvp/rooms/${r.id}/leave`);await tickPvp({roomIds:[r.id]});const db=await read(r.id);assert.equal(db.status,'settled');assert.equal(db.result.payouts.find(p=>p.external_user_id==='player_0').payout_minor,String(n*9500));assert.equal(db.result.payouts.filter(p=>p.payout_minor==='0').length,n-1);conservation(await snapshot(f));
});
test('an App fee change cannot rewrite a waiting room economic contract',async()=>{
 const f=await fixture();const hasColumn=(await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='gp_apps' AND column_name='competitive_fee_bps'")).rowCount;assert.ok(hasColumn,'platform migration must add competitive_fee_bps before reference-service tests');
 await pool.query('UPDATE gp_apps SET competitive_fee_bps=1000 WHERE id=$1',[f.app.id]);const r=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'match',capacity:2,entry_minor:'10000'})).body;assert.equal(r.fee_bps,1000);await pool.query('UPDATE gp_apps SET competitive_fee_bps=300 WHERE id=$1',[f.app.id]);await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/join`);for(const session of f.sessions.slice(0,2))await call(session,'POST',`/api/pvp/rooms/${r.id}/ready`);await tickPvp({roomIds:[r.id]});await deadline(r.id);const db=await read(r.id);assert.equal(db.status,'settled',JSON.stringify({status:db.status,error:db.error}));assert.ok(db.result,'settled fee fixture must contain a result');assert.equal(db.result.fee_minor,'2000');assert.equal((await snapshot(f)).fee_minor,'2000');conservation(await snapshot(f));
});

test('leaving free practice immediately ends all bots, frees the seat, replays safely and permits a new room',async()=>{
 for(const game of ['match','golf'])for(const capacity of [2,3,4]){
  const f=await fixture(game),room=await setup(f,capacity,'10000',true),before=await snapshot(f),request={request_id:uid('practiceleave')};
  assert.equal(room.status,'active');const left=await routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/leave`,request);
  assert.equal(left.body.status,'cancelled');assert.ok(left.body.end_at<=Date.now());assert.equal(left.body.result,null);
  assert.equal((await pool.query('SELECT 1 FROM pvp_active_users WHERE app_id=$1 AND external_user_id=$2',[f.app.id,f.sessions[0].external_user_id])).rowCount,0,'seat must be released by the leave transaction');
  const stopped=await read(room.id);await tickPvp({roomIds:[room.id]});assert.deepEqual((await read(room.id)).game_state,stopped.game_state,'bots must not keep advancing after the room has ended');
  assert.deepEqual(await routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/leave`,request),left,'lost response must replay the same completed leave');
  const next=await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:game,capacity,entry_minor:'10000',practice:true});assert.equal(next.status,201,'the same human can immediately create another room');assert.notEqual(next.body.id,room.id);
  await call(f.sessions[0],'POST',`/api/pvp/rooms/${next.body.id}/leave`);const after=await snapshot(f);assert.equal(after.operations.length,0);assert.deepEqual(after.users,before.users);assert.equal(after.fee_minor,'0');
 }
});

for(const game of ['carrom','jackaroo'])test(`${game} team membership freezes before funding; opposite seats capture and teammate forfeits the whole team`,async()=>{
 const f=await fixture(game),lobby=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:game,capacity:4,entry_minor:'10000'})).body;
 assert.equal(lobby.team_size,2);assert.match(lobby.seed_commitment,/^[a-f0-9]{64}$/);assert.equal(lobby.players[0].team_id,'team_a');
 for(let i=1;i<4;i++)await call(f.sessions[i],'POST',`/api/pvp/rooms/${lobby.code}/join`);
 const before=(await call(f.sessions[0],'GET',`/api/pvp/rooms/${lobby.id}`)).body;
 assert.deepEqual(before.players.map(p=>p.team_id),['team_a','team_b','team_a','team_b']);assert.equal((await snapshot(f)).operations.length,0);
 for(const s of f.sessions)await call(s,'POST',`/api/pvp/rooms/${lobby.id}/ready`);
 await tickPvp({roomIds:[lobby.id]});let r=(await call(f.sessions[0],'GET',`/api/pvp/rooms/${lobby.id}`)).body;
 assert.equal(r.status,'active',JSON.stringify(r.error));assert.equal(r.seed_commitment,lobby.seed_commitment);assert.deepEqual(r.players.map(p=>p.team_id),before.players.map(p=>p.team_id));
 for(const team of ['team_a','team_b']){const seats=r.players.filter(p=>p.team_id===team).map(p=>p.seat_index);assert.equal(Math.abs(seats[0]-seats[1]),2);}
 const contract=await readPvpMatch(f.app,r.id);validate('PlatformMatch',contract);assert.equal(contract.terms.team_size,2);assert.equal(contract.participants.filter(p=>p.team_id==='team_a').length,2);
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/leave`);await tickPvp({roomIds:[r.id]});const done=await read(r.id);
 assert.equal(done.status,'settled',JSON.stringify(done.error));assert.equal(done.result.fee_minor,'2000');assert.deepEqual(done.result.payouts.map(p=>p.payout_minor),['19000','0','19000','0']);assert.ok(done.result.rankings.filter(p=>['player_1','player_3'].includes(p.playerKey)).every(p=>p.forfeited));conservation(await snapshot(f));
});
for(const game of ['carrom','jackaroo'])test(`${game} simultaneous full-table disconnect refunds everyone without fee`,async()=>{
 const f=await fixture(game),r=await setup(f,4),db=await read(r.id);db.players.forEach(p=>p.last_seen_at=Date.now()-31000);await pool.query('DELETE FROM pvp_presence WHERE room_id=$1',[r.id]);
 await pool.query('UPDATE pvp_rooms SET players=$2,last_tick_at=$3 WHERE id=$1',[r.id,JSON.stringify(db.players),Date.now()]);await tickPvp({roomIds:[r.id]});
 const done=await read(r.id);assert.equal(done.status,'voided',JSON.stringify(done.error));assert.equal(done.result.fee_minor,'0');assert.ok((await snapshot(f)).users.every(u=>u.available==='100000'));conservation(await snapshot(f));
});
for(const game of ['carrom','darts','ludo','jackaroo','domino','pool','bowling','run'])test(`${game} rejects unsupported capacity; practice action is durable and replay safe`,async()=>{
 const f=await fixture(game);for(const n of [2,3,4].filter(n=>!ARENA_GAMES[game].players.includes(n)))await assert.rejects(call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:game,capacity:n,entry_minor:'10000'}),e=>e.code==='INVALID_ROOM');
 const r=await setup(f,ARENA_GAMES[game].players[0],'0',true);assert.equal(r.status,'active',JSON.stringify(r.error));let accepted=false,clock=Date.now();
 for(let i=0;i<128&&!accepted;i++){
  const now=clock+=1000;await routePvp(f.sessions[0],'GET',`/api/pvp/rooms/${r.id}`,{}, {now,skipGap:true});
  const db=await read(r.id),action=engines[game].botAction(db.game_state,'player_0',now);
  if(action){const body={request_id:uid('phase_d_action'),seq:1,action};const res=await routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/action`,body,{now,skipGap:true});assert.equal(res.body.me_last_seq,1);assert.deepEqual(JSON.parse(JSON.stringify(await routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/action`,body,{now,skipGap:true}))),JSON.parse(JSON.stringify(res)));accepted=true;}
  else await tickPvp({now,roomIds:[r.id],skipGap:true});
 }
 assert.ok(accepted,'human seat must receive a legal action');assert.equal((await pool.query('SELECT count(*) FROM pvp_actions WHERE room_id=$1',[r.id])).rows[0].count,'1');await routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/leave`,{request_id:uid('endpractice')},{now:clock,skipGap:true});assert.equal((await read(r.id)).status,'cancelled');assert.equal((await snapshot(f)).operations.length,0);
});
for(const game of ['darts','ludo','domino','carrom','pool','bowling','run'])test(`${game} paid duel captures and settles a 190-coin winner`,async()=>{
 const f=await fixture(game),r=await setup(f,2);assert.equal(r.status,'active',JSON.stringify(r.error));
 const raceAt=game==='run'?await startPaidRunRace(f,r):null;
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/leave`,{},raceAt===null?{}:{now:raceAt+1,skipGap:true});
 await tickPvp({roomIds:[r.id],...(raceAt===null?{}:{now:raceAt+2,skipGap:true})});
 const done=await read(r.id);assert.equal(done.status,'settled',JSON.stringify(done.error));assert.equal(done.result.payouts.find(p=>p.external_user_id==='player_0').payout_minor,'19000');assert.equal(done.result.fee_minor,'1000');conservation(await snapshot(f));
});
for(const game of ['jackaroo','domino'])test(`${game} views omit opponents hands, stock sequence and RNG`,async()=>{
 const f=await fixture(game),r=await setup(f,game==='jackaroo'?4:2);
 for(const session of f.sessions.slice(0,r.capacity)){
  const v=(await call(session,'GET',`/api/pvp/rooms/${r.id}`)).body;assert.equal(v.seed_commitment,r.seed_commitment);for(const k of ['seed','rng','deck','stock'])assert.equal(v.game[k],undefined);
  for(const p of Object.values(v.game.players||{}))if((p.key||p.playerKey)!==session.external_user_id){assert.equal(p.hand,undefined);assert.equal(p.cards,undefined);}
  if(game==='domino')assert.ok(v.players.every(p=>p.score===0&&p.rank===null));
 }
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/leave`);await tickPvp({roomIds:[r.id]});conservation(await snapshot(f));
});

for(const game of ['carrom','jackaroo','ludo','darts','domino'])test(`${game}: an explicit leave batches with the opponent's third turn timeout before fixing a winner`,async()=>{
 const team=['carrom','jackaroo'].includes(game),f=await fixture(game),r=await setup(f,team?4:2),db=await read(r.id),now=Date.now()+25,s=db.game_state;
 const p=s.players.find(p=>p.key==='player_0');p.timeouts=2;s.turnKey=p.key;s.turnIndex=s.players.indexOf(p);s.turnStartedAt=now-20000;s.turnDeadlineAt=now;s.serverNow=now-1;s.now=now-1;s.busyUntil=now-1;s.pendingNext=false;s.pending=null;
 if(game==='jackaroo'){s.phase='play';s.exchangeDeadlineAt=now-20001;}
 if(game==='carrom')s.phase='aiming';
 if(game==='darts'){s.turnHadThrow=false;s.currentDarts=[];s.turnStartRemaining=p.remaining;}
 await pool.query('UPDATE pvp_rooms SET game_state=$2,last_tick_at=$3 WHERE id=$1',[r.id,s,now-1]);
 await routePvp(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/leave`,{request_id:uid('same_tick_leave')},{now,skipGap:true});await tickPvp({roomIds:[r.id],now,skipGap:true});
 const done=await read(r.id);assert.equal(done.status,'voided',JSON.stringify({status:done.status,error:done.error,result:done.result}));assert.equal(done.result.fee_minor,'0');assert.ok(done.result.payouts.every(p=>p.payout_minor==='10000'));assert.ok((await snapshot(f)).users.every(u=>u.available==='100000'));conservation(await snapshot(f));
});
for(const variant of ['capture-extra','capture-duplicate','settle-extra','settle-roster','settle-terms'])test(`schema-valid ${variant} wallet receipt stays unknown until the exact original receipt is recovered`,async()=>{
 const f=await fixture();let changed=false;const kind=variant.startsWith('capture')?'capture':'settle';
 const proxy=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const upstream=await fetch(origin+req.url,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:raw});const data=await upstream.json();
  if(!changed&&req.method==='POST'&&req.url.endsWith('/'+kind)&&data.state==='SUCCEEDED'){
   const resource=data.receipt.resource;
   if(variant==='capture-extra')resource.participants.push({...resource.participants[0],external_user_id:'outsider',seat_index:2,reservation_id:'res_outsider'});
   if(variant==='capture-duplicate')resource.participants.push({...resource.participants[0]});
   if(variant==='settle-extra')resource.payouts.push({external_user_id:'outsider',seat_index:2,rank:1,payout_minor:'1000'});
   if(variant==='settle-roster')resource.participants[0].external_user_id='outsider';
   if(variant==='settle-terms')resource.terms.fee_bps=1000;
   validate('Operation',data);changed=true;
  }
  res.writeHead(upstream.status,{'content-type':'application/json'});res.end(JSON.stringify(data));
 });await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 try{process.env.OASIS_WALLET_ALLOWED_ORIGINS+=',http://127.0.0.1:'+proxy.address().port;await pool.query('UPDATE gp_apps SET wallet_url=$2 WHERE id=$1',[f.app.id,'http://127.0.0.1:'+proxy.address().port]);const r=await setup(f);
  if(kind==='settle'){assert.equal(r.status,'active');await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/leave`);}
  const pending=await read(r.id);assert.ok(changed);assert.equal(pending.status,kind==='capture'?'funding':'settling');assert.ok(['WALLET_INVALID_RECEIPT','WALLET_PENDING'].includes(pending.error.code));
  const op=(await pool.query('SELECT * FROM pvp_operations WHERE id=$1',[kind+'_'+r.id])).rows[0];assert.equal(op.state,'PENDING');assert.equal(op.error.code,'WALLET_INVALID_RECEIPT');const fixed=pending.result_hash;
  await pool.query('UPDATE pvp_operations SET next_attempt_at=now() WHERE id=$1',[op.id]);await tickPvp({roomIds:[r.id]});const recovered=await read(r.id);assert.equal(recovered.status,kind==='capture'?'active':'settled');if(kind==='settle')assert.equal(recovered.result_hash,fixed);else{await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/leave`);await tickPvp({roomIds:[r.id]});}
  assert.equal((await snapshot(f)).fee_minor,'1000');conservation(await snapshot(f));
 }finally{await new Promise(resolve=>proxy.close(resolve));}
});

for(const game of ['pool','bowling','run'])test(`${game} simultaneous disconnect uses a single full-refund result and no fee`,async()=>{
 const f=await fixture(game),r=await setup(f,game==='pool'?2:4),db=await read(r.id);db.players.forEach(p=>p.last_seen_at=Date.now()-31000);await pool.query('DELETE FROM pvp_presence WHERE room_id=$1',[r.id]);
 await pool.query('UPDATE pvp_rooms SET players=$2,last_tick_at=$3 WHERE id=$1',[r.id,JSON.stringify(db.players),Date.now()]);await tickPvp({roomIds:[r.id]});
 const done=await read(r.id);assert.equal(done.status,'voided',JSON.stringify(done.error));assert.equal(done.result.fee_minor,'0');assert.ok(done.result.payouts.every(p=>p.payout_minor==='10000'));assert.ok((await snapshot(f)).users.every(u=>u.available==='100000'));conservation(await snapshot(f));
});
for(const game of ['bowling','run'])test(`${game} four-person individual room retains last eligible player and pays the net pool once`,async()=>{
 const f=await fixture(game),r=await setup(f,4);assert.equal(r.status,'active');assert.equal(r.team_size,1);assert.ok(r.players.every(p=>p.team_id===null));
 const raceAt=game==='run'?await startPaidRunRace(f,r):null;
 for(const [index,session]of f.sessions.slice(1,4).entries())await call(session,'POST',`/api/pvp/rooms/${r.id}/leave`,{},raceAt===null?{}:{now:raceAt+index+1,skipGap:true});
 await tickPvp({roomIds:[r.id],...(raceAt===null?{}:{now:raceAt+4,skipGap:true})});const done=await read(r.id);assert.equal(done.status,'settled',JSON.stringify(done.error));assert.equal(done.result.payouts.find(p=>p.external_user_id==='player_0').payout_minor,'38000');assert.equal(done.result.fee_minor,'2000');assert.equal((await snapshot(f)).fee_minor,'2000');conservation(await snapshot(f));
});

for(const game of ['pool','bowling','run'])test(`${game} practice deadline is resolved before a bot can send a stale action`,async()=>{
 const f=await fixture(game),r=await setup(f,ARENA_GAMES[game].players[0],'0',true),db=await read(r.id),now=r.starts_at+ARENA_GAMES[game].duration+12000;
 db.players.forEach(p=>{p.last_seen_at=now;p.last_bot_at=0;});
 await pool.query('UPDATE pvp_rooms SET players=$2,last_tick_at=$3 WHERE id=$1',[r.id,JSON.stringify(db.players),now-1]);
 await tickPvp({roomIds:[r.id],now,skipGap:true});const done=await read(r.id);
 assert.ok(['settled','voided'].includes(done.status),JSON.stringify({status:done.status,error:done.error}));assert.equal(done.result.fee_minor,'0');assert.equal((await snapshot(f)).operations.length,0);
});
