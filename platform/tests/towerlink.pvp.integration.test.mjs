import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as towerlink from '../arena/towerlink/engine.mjs';
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
async function fixture(game='towerlink',balances=['100000','100000','100000','100000']){
 const app={id:uid('pvptest'),partner_id:uid('partner'),environment:'sandbox',wallet_scope_id:uid('wallet'),currency_id:'COIN',wallet_url:origin};const scope={partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id};
 const key_id=uid('walletkey'),secret_base64=randomBytes(32).toString('base64');
 await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[app.id,'PvP isolated test fixture',app.partner_id,app.environment,app.wallet_scope_id,origin,JSON.stringify(['towerlink'])]);
 await pool.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'platform-to-wallet',$3)",[key_id,app.id,seal(secret_base64)]);
 await provisionWallet(pool,{scope,key_id,secret_base64,users:balances.map((balance_minor,i)=>({external_user_id:'player_'+i,balance_minor})),treasury_minor:'1000000000'});
 return{app,scope,sessions:balances.map((_,i)=>({id:uid('session'),app_id:app.id,external_user_id:'player_'+i,game_id:game}))};
}
const call=(s,method,path,body={},opts={})=>routePvp(s,method,path,method==='POST'?{request_id:uid('request'),...body}:body,opts);
async function setup(f,n=2,entry='10000',practice=false,{countdown=false,ruleVersion}={}){
 const now=Date.now(),opts={now,skipGap:true};
 const created=await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'towerlink',capacity:n,entry_minor:entry,practice},{...opts});
 const room=created.body;if(ruleVersion)await pool.query('UPDATE pvp_rooms SET rule_version=$2 WHERE id=$1',[room.id,ruleVersion]);if(!practice)for(let i=1;i<n;i++)await call(f.sessions[i],'POST',`/api/pvp/rooms/${room.code}/join`,{},opts);
 for(let i=0;i<(practice?1:n);i++)await call(f.sessions[i],'POST',`/api/pvp/rooms/${room.id}/ready`,{},opts);
 await tickPvp({roomIds:[room.id],now,skipGap:true});
 let db=await read(room.id);assert.equal(db.status,'active',JSON.stringify(db.error));
 const at=countdown?now:Number(db.starts_at);
 await tickPvp({roomIds:[room.id],now:at,skipGap:true});
 return(await call(f.sessions[0],'GET',`/api/pvp/rooms/${room.id}`,{},{now:at,skipGap:true})).body;
}
const read=async id=>(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];
const snapshot=f=>readWalletSnapshot(pool,{scope:f.scope});
const get=(f,room,now,index=0)=>call(f.sessions[index],'GET',`/api/pvp/rooms/${room.id}`,{},{now,skipGap:true});
const action=(f,room,now,seq,move,index=0,request=uid('toweraction'))=>routePvp(f.sessions[index],'POST',`/api/pvp/rooms/${room.id}/action`,{request_id:request,seq,action:move},{now,skipGap:true});
async function finishAtDeadline(id){
 const r=await read(id),now=r.game_state.deadlineAt;for(const p of r.players)p.last_seen_at=now;
 await pool.query('UPDATE pvp_rooms SET players=$2 WHERE id=$1',[id,JSON.stringify(r.players)]);
 await tickPvp({roomIds:[id],now,skipGap:true});return read(id);
}
function conservation(s){assert.equal(s.ledger.reduce((sum,l)=>sum+BigInt(l.delta_available)+BigInt(l.delta_reserved),0n),0n);assert.ok(s.users.every(u=>BigInt(u.available)>=0n&&u.reserved==='0'&&u.credit_pending==='0'));}
const ownTower=(g,key)=>g.towers.find(t=>g.owners[t.id]===key);

test('Tower Link paid 1v1 starts together after 3 seconds; prestart input cannot produce or spend troops',async()=>{
 const f=await fixture(),r=await setup(f,2,'10000',false,{countdown:true}),now=r.server_now;
 assert.equal(r.room_mode,'competitive');assert.equal(r.starts_at,now+3000);assert.equal(r.end_at-r.starts_at,180000);
 assert.equal(r.game.ruleVersion,towerlink.RULE_VERSION);assert.ok(r.game.towers.filter(t=>r.game.owners[t.id]).every(t=>t.troops===30));
 const mine=ownTower(r.game,'player_0');
 await assert.rejects(action(f,r,now+1000,1,{type:'upgrade',towerId:mine.id}),e=>e.code==='GAME_NOT_STARTED'&&e.status<500);
 const during=(await get(f,r,now+2000)).body;assert.equal(during.me_last_seq,0);assert.ok(during.game.towers.filter(t=>during.game.owners[t.id]).every(t=>t.troops===30));
 const begun=(await get(f,r,r.starts_at)).body;assert.ok(begun.game.legalActions.some(a=>a.type==='link'));
 const peer=(await get(f,r,r.starts_at,1)).body;assert.deepEqual(peer.game.towers,begun.game.towers);assert.deepEqual(peer.game.edges,begun.game.edges);assert.equal(peer.game.seed,undefined);
 const done=await finishAtDeadline(r.id);assert.equal(done.status,'voided',JSON.stringify(done.error));
});

test('Tower Link genuine paid tie refunds both principals once with no fee',async()=>{
 const f=await fixture(),room=await setup(f),done=await finishAtDeadline(room.id);
 assert.equal(done.status,'voided',JSON.stringify(done.error));assert.equal(done.result.reason,'tied_game');
 assert.ok(done.result.rankings.every(p=>p.rank===1));assert.ok(done.result.payouts.every(p=>p.payout_minor==='10000'));assert.equal(done.result.fee_minor,'0');
 const before=await snapshot(f);await Promise.all([tickPvp({roomIds:[room.id]}),tickPvp({roomIds:[room.id]})]);const after=await snapshot(f);
 assert.equal(after.operations.length,4);assert.deepEqual(after.users,before.users);assert.equal(after.fee_minor,'0');assert.ok(after.users.every(u=>u.available==='100000'));conservation(after);
 const support=await readPvpMatch(f.app,room.id);validate('PlatformMatch',support);assert.equal(support.state,'VOIDED');assert.equal(support.fee_minor,'0');
});

for(const capacity of [3,4])test(`Tower Link rejects ${capacity}-player paid rooms before reserving any stake`,async()=>{
 const f=await fixture();await assert.rejects(call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'towerlink',capacity,entry_minor:'10000',practice:false}),e=>e.code==='TOWERLINK_PAID_1V1_ONLY'&&e.status===400);
 assert.equal((await pool.query('SELECT count(*) FROM pvp_rooms WHERE app_id=$1',[f.app.id])).rows[0].count,'0');assert.equal((await snapshot(f)).operations.length,0);
});

for(const version of ['towerlink-v2.0.0','towerlink-v2.1.0'])test(`Tower Link ${version} reference wallet independently rejects a three-player paid reservation`,async()=>{
 const f=await fixture(),{walletRequest}=await import('../server/wallet-binding.mjs'),request_id=uid('invalid_paid_trio');
 const body={...f.scope,request_id,match_id:uid('match'),reservation_id:uid('res'),external_user_id:'player_0',seat_index:0,amount_minor:'10000',terms:{game_id:'towerlink',rule_version:version,payout_template_version:'winner-all-v1',fee_bps:500,entry_minor:'10000',player_count:3,team_size:1},expires_at:new Date(Date.now()+60000).toISOString()};
 const reply=await walletRequest(f.app,'POST','/wallet/v1/reservations',JSON.stringify(body),request_id);assert.equal(reply.state,'REJECTED');assert.equal(reply.rejection.code,'INVALID_REQUEST');assert.ok((await snapshot(f)).users.every(u=>u.available==='100000'&&u.reserved==='0'));
});

for(const capacity of [2,3,4])test(`Tower Link ${capacity}-player real friend room has no bots or wallet operations and completes by territory`,async()=>{
 const f=await fixture(),room=await setup(f,capacity,'0');assert.equal(room.room_mode,'social');assert.equal(room.practice,false);assert.equal(room.fee_bps,0);assert.equal(room.prize_minor,'0');assert.ok(room.players.every(p=>!p.bot));
 assert.ok(room.game.legalActions.some(a=>a.type==='link'));const now=room.server_now;
 const move=room.game.legalActions.find(a=>a.type==='link');await action(f,room,now,1,move);
 const progressed=(await get(f,room,now+1000)).body;assert.ok(progressed.game.armies.length>0);assert.equal(progressed.game.orders.length,1);
 const done=await finishAtDeadline(room.id);assert.equal(done.status,'settled',JSON.stringify(done.error));assert.equal(done.result.fee_minor,'0');assert.ok(done.result.payouts.every(p=>p.payout_minor==='0'));assert.equal((await snapshot(f)).operations.length,0);
 assert.equal((await pool.query('SELECT count(*) FROM pvp_active_users WHERE room_id=$1',[room.id])).rows[0].count,'0');
 await assert.rejects(readPvpMatch(f.app,room.id),e=>e.code==='MATCH_NOT_FOUND'&&e.status===404,'free social rooms are not wallet matches');
});

test('Tower Link continuous link, stop and manual upgrade are sequenced and idempotent after reload',async()=>{
 const f=await fixture(),room=await setup(f),at=room.server_now,link=room.game.legalActions.find(a=>a.type==='link'),id=link.from;
 const body={request_id:uid('stable_link'),seq:1,action:link},opts={now:at,skipGap:true};
 const responses=await Promise.all(Array.from({length:3},()=>routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/action`,body,opts)));
 assert.ok(responses.every(r=>r.body.me_last_seq===1));assert.equal(responses[0].body.game.orders.filter(o=>o.from===id).length,1);
 const marching=(await get(f,room,at+1000)).body;assert.ok(marching.game.armies.some(a=>a.from===id&&a.ownerKey==='player_0'));
 await action(f,room,at+1250,2,{type:'stop',towerId:id});const stopped=(await get(f,room,at+1500)).body;assert.ok(stopped.game.orders.every(o=>o.from!==id));
 const before=stopped.game.towers.find(t=>t.id===id),upgrade={request_id:uid('stable_upgrade'),seq:3,action:{type:'upgrade',towerId:id}};
 const bought=await routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/action`,upgrade,{now:at+1500,skipGap:true});
 assert.equal(bought.body.game.towers.find(t=>t.id===id).troops,before.troops-20);assert.ok(bought.body.game.towers.find(t=>t.id===id).upgrade);
 const restored=await import('../server/pvp/index.mjs?tower_reload='+uid('module'));await restored.migratePvp(pool);
 assert.deepEqual(await restored.routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/action`,upgrade,{now:at+1750,skipGap:true}),bought);
 await assert.rejects(action(f,room,at+1750,3,{type:'stop',towerId:id}),e=>e.code==='INVALID_SEQUENCE');
 const completed=(await get(f,room,at+4500)).body;assert.equal(completed.game.towers.find(t=>t.id===id).level,2);assert.equal(completed.game.towers.find(t=>t.id===id).upgrade,null);
 assert.equal((await pool.query('SELECT count(*) FROM pvp_actions WHERE room_id=$1',[room.id])).rows[0].count,'3');
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/leave`,{},{now:at+4750,skipGap:true});await tickPvp({roomIds:[room.id],now:at+4750,skipGap:true});
 const done=await read(room.id);assert.equal(done.status,'settled',JSON.stringify(done.error));assert.equal(done.result.payouts.find(p=>p.external_user_id==='player_0').payout_minor,'0');assert.equal(done.result.payouts.find(p=>p.external_user_id==='player_1').payout_minor,'19000');conservation(await snapshot(f));
});

test('Tower Link invalid action does not fault the room or consume sequence',async()=>{
 const f=await fixture(),room=await setup(f),at=room.server_now;
 for(const bad of [null,{type:'bogus'},{type:'link',from:-1,to:0},{type:'unlink',from:-1,to:0},{type:'unlink',from:0,to:9999},{type:'upgrade',towerId:9999}])await assert.rejects(action(f,room,at,1,bad),e=>e.status>=400&&e.status<500);
 const state=await read(room.id);assert.equal(state.status,'active');assert.equal(state.players.find(p=>p.external_user_id==='player_0').last_seq,0);
 const accepted=await action(f,room,at,1,room.game.legalActions.find(a=>a.type==='link'));assert.equal(accepted.body.me_last_seq,1);
 await finishAtDeadline(room.id);conservation(await snapshot(f));
});

test('Tower Link v2.1 upgrades unlock rates/routes; unlink and stop remain sequenced after reload',async()=>{
 // This persisted v2.1 scenario requires three home neighbors. New bridgehead maps
 // deliberately have fewer roads; do not weaken the old three-route assertion.
 const f=await fixture(),room=await setup(f,2,'10000',false,{ruleVersion:'towerlink-v2.1.0'}),at=room.server_now,home=ownTower(room.game,'player_0');
 assert.equal(room.game.ruleVersion,'towerlink-v2.1.0');
 const links=room.game.legalActions.filter(a=>a.type==='link'&&a.from===home.id);assert.ok(links.length>=3);
 assert.equal(home.level,1);assert.equal(home.dispatchRate,1);assert.equal(home.routeLimit,1);
 await action(f,room,at,1,links[0]);
 await assert.rejects(action(f,room,at+250,2,links[1]),e=>e.code==='ROUTE_LIMIT_REACHED'&&e.status===409);
 const existing=await action(f,room,at+250,2,links[0]);assert.equal(existing.body.game.orders.filter(o=>o.from===home.id).length,1,'existing line is idempotent even when route cap is full');
 await action(f,room,at+500,3,{type:'stop',towerId:home.id});
 await action(f,room,at+750,4,{type:'upgrade',towerId:home.id});
 const level2=(await get(f,room,at+3750)).body,up2=level2.game.towers.find(t=>t.id===home.id);assert.equal(up2.level,2);assert.equal(up2.routeLimit,2);assert.equal(up2.dispatchRate,2);
 const ready=(await get(f,room,at+16250)).body;assert.ok(ready.game.towers.find(t=>t.id===home.id).troops>=35,'upgrade resources are genuinely produced');
 await action(f,room,at+16250,5,links[0]);const two=await action(f,room,at+16400,6,links[1]);
 assert.equal(two.body.game.orders.filter(o=>o.from===home.id).length,2,'level 2 retains both adjacent routes');
 await assert.rejects(action(f,room,at+16550,7,links[2]),e=>e.code==='ROUTE_LIMIT_REACHED'&&e.status===409);
 await action(f,room,at+16750,7,{type:'upgrade',towerId:home.id});
 const level3=(await get(f,room,at+20750)).body,up3=level3.game.towers.find(t=>t.id===home.id);assert.equal(up3.level,3);assert.equal(up3.routeLimit,3);assert.equal(up3.dispatchRate,3);
 const three=await action(f,room,at+20750,8,links[2]);assert.equal(three.body.game.orders.filter(o=>o.from===home.id).length,3);
 const marching=(await get(f,room,at+24000)).body,packets=marching.game.armies.filter(a=>a.from===home.id&&a.ownerKey==='player_0'&&a.departedAt===at+24000);
 assert.equal(packets.reduce((n,a)=>n+a.count,0),3,'level 3 dispatches 3 total in a fixed one-second cadence');assert.equal(packets.length,3);assert.ok(packets.every(a=>a.count===1));
 const before=(await get(f,room,at+24250)).body,unlink={request_id:uid('stable_unlink'),seq:9,action:{type:'unlink',from:home.id,to:links[0].to}},opts={now:at+24250,skipGap:true};
 const replies=await Promise.all(Array.from({length:3},()=>routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/action`,unlink,opts)));
 assert.ok(replies.every(response=>response.body.me_last_seq===9));assert.deepEqual(replies[1],replies[0]);
 const after=replies[0].body;assert.equal(after.game.orders.filter(o=>o.from===home.id).length,2);assert.ok(after.game.orders.every(o=>o.from!==home.id||o.to!==links[0].to));
 assert.deepEqual(after.game.armies,before.game.armies,'single-line removal cannot recall in-flight troops');
 const restored=await import('../server/pvp/index.mjs?multiroute_reload='+uid('module'));await restored.migratePvp(pool);
 assert.deepEqual(await restored.routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/action`,unlink,{now:at+24500,skipGap:true}),replies[0]);
 await assert.rejects(action(f,room,at+24500,9,{type:'stop',towerId:home.id}),e=>e.code==='INVALID_SEQUENCE');
 const continued=(await get(f,room,at+25000)).body;assert.ok(continued.game.armies.some(a=>a.from===home.id&&a.departedAt===at+25000));
 assert.ok(continued.game.armies.filter(a=>a.from===home.id&&a.departedAt===at+25000).every(a=>a.to!==links[0].to));
 const stopped=await action(f,room,at+25250,10,{type:'stop',towerId:home.id});assert.ok(stopped.body.game.orders.every(o=>o.from!==home.id));
 const stayed=(await get(f,room,at+26000)).body;assert.ok(stayed.game.armies.filter(a=>a.from===home.id).every(a=>a.departedAt<=at+25250));assert.ok(stayed.game.towers.find(t=>t.id===home.id).troops>=5);
 assert.equal((await pool.query('SELECT count(*)::int n FROM pvp_actions WHERE room_id=$1',[room.id])).rows[0].n,10);
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/leave`,{},{now:at+26250,skipGap:true});await tickPvp({roomIds:[room.id],now:at+26250,skipGap:true});assert.equal((await read(room.id)).status,'settled');conservation(await snapshot(f));
});

for(const capacity of [2,3,4])test(`Tower Link ${capacity}-player BOT practice is labelled, plays after countdown and never spends coins`,async()=>{
 const f=await fixture(),room=await setup(f,capacity,'10000',true);assert.equal(room.room_mode,'practice');assert.equal(room.entry_minor,'0');assert.ok(room.players.filter(p=>p.bot).every(p=>p.name.startsWith('BOT ')));
 const db=await read(room.id);assert.ok(db.players.filter(p=>p.bot).every(p=>['link','upgrade'].includes(p.last_event?.type)));
 await action(f,room,room.server_now,1,room.game.legalActions.find(a=>a.type==='link'));
 const left=await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/leave`,{},{now:room.server_now+250,skipGap:true});assert.equal(left.body.status,'cancelled');assert.equal((await snapshot(f)).operations.length,0);
});

test('Tower Link shared pause shifts soldiers, upgrade, deadline and presence together',async()=>{
 const f=await fixture(),room=await setup(f),at=room.server_now,link=room.game.legalActions.find(a=>a.type==='link');
 await action(f,room,at,1,link);await get(f,room,at+1000);await action(f,room,at+1250,2,{type:'upgrade',towerId:link.from});
 const before=await read(room.id),now=Number(before.last_tick_at)+10000;await tickPvp({roomIds:[room.id],now});const recovered=await read(room.id);
 assert.equal(recovered.status,'active',JSON.stringify(recovered.error));assert.equal(recovered.game_state.deadlineAt,before.game_state.deadlineAt+10000);assert.equal(recovered.game_state.serverNow,now);
 assert.deepEqual(recovered.game_state.towers.map(t=>[t.id,t.troops,t.level]),before.game_state.towers.map(t=>[t.id,t.troops,t.level]));assert.equal(recovered.seed_enc,before.seed_enc);
 const shifted=structuredClone(before.game_state);towerlink.shiftTime(shifted,10000);assert.deepEqual(recovered.game_state.armies,shifted.armies);assert.deepEqual(recovered.game_state.towers.map(t=>t.upgrade),shifted.towers.map(t=>t.upgrade));
 await finishAtDeadline(room.id);conservation(await snapshot(f));
});

test('Tower Link reconnect before 30 seconds keeps seat and orders; normal ticking prevents late revival',async()=>{
 const f=await fixture(),room=await setup(f,3,'0'),at=room.server_now,link=room.game.legalActions.find(a=>a.type==='link');await action(f,room,at,1,link);
 let db=await read(room.id);db.players.forEach(p=>p.last_seen_at=at);await pool.query('DELETE FROM pvp_presence WHERE room_id=$1',[room.id]);await pool.query('UPDATE pvp_rooms SET players=$2 WHERE id=$1',[room.id,JSON.stringify(db.players)]);
 const back=(await get(f,room,at+20000)).body;assert.equal(back.me_last_seq,1);assert.equal(back.players.find(p=>p.external_user_id==='player_0').seat_index,room.players.find(p=>p.external_user_id==='player_0').seat_index);assert.ok(back.game.orders.some(o=>o.from===link.from));
 db=await read(room.id);for(const p of db.players)p.last_seen_at=p.external_user_id==='player_0'?at:at+31001;
 await pool.query('UPDATE pvp_rooms SET players=$2,last_tick_at=$3 WHERE id=$1',[room.id,JSON.stringify(db.players),at+31001]);await tickPvp({roomIds:[room.id],now:at+31001,skipGap:true});
 const late=(await get(f,room,at+31001)).body;assert.equal(late.players.find(p=>p.external_user_id==='player_0').forfeited,true);assert.ok(late.game.orders.every(o=>o.ownerKey!=='player_0'));assert.ok(late.game.armies.every(a=>a.ownerKey!=='player_0'));
 await finishAtDeadline(room.id);assert.equal((await snapshot(f)).operations.length,0);
});

test('Tower Link simultaneous expired presence refunds all paid entries without fee',async()=>{
 const f=await fixture(),room=await setup(f),db=await read(room.id),now=room.server_now+31001;
 for(const p of db.players)p.last_seen_at=now-31001;await pool.query('DELETE FROM pvp_presence WHERE room_id=$1',[room.id]);await pool.query('UPDATE pvp_rooms SET players=$2,last_tick_at=$3 WHERE id=$1',[room.id,JSON.stringify(db.players),now]);
 await tickPvp({roomIds:[room.id],now,skipGap:true});const done=await read(room.id);assert.equal(done.status,'voided',JSON.stringify(done.error));assert.equal(done.result.fee_minor,'0');assert.ok(done.result.payouts.every(p=>p.payout_minor==='10000'));assert.ok((await snapshot(f)).users.every(u=>u.available==='100000'));conservation(await snapshot(f));
});

test('Tower Link shared outage over 60 seconds refunds rather than blaming disconnected players',async()=>{
 const f=await fixture(),room=await setup(f),now=room.server_now+61000;await tickPvp({roomIds:[room.id],now});const done=await read(room.id);
 assert.equal(done.status,'voided');assert.equal(done.result.reason,'platform_outage_over_60s');assert.equal(done.result.fee_minor,'0');assert.ok(done.result.payouts.every(p=>p.payout_minor==='10000'));conservation(await snapshot(f));
});

for(const version of ['towerlink-v1.0.0','towerlink-v1.1.0','towerlink-v2.0.0'])test(`Tower Link ${version} pinned active room is never reinterpreted and refunds`,async()=>{
 const f=await fixture(),room=await setup(f),db=await read(room.id),now=room.server_now;db.game_state.ruleVersion=version;
 await pool.query('UPDATE pvp_rooms SET rule_version=$2,game_state=$3 WHERE id=$1',[room.id,version,db.game_state]);
 await tickPvp({roomIds:[room.id],now,skipGap:true});const fault=await read(room.id);assert.equal(fault.status,'fault');assert.equal(fault.error.code,'PINNED_RULE_UNAVAILABLE');assert.equal(fault.game_state.ruleVersion,version);
 const isolated=await get(f,room,now);assert.equal(isolated.status,200);assert.equal(isolated.body.game,null,'legacy state is never passed through the new public view');
 await assert.rejects(action(f,room,now,1,{type:'link',from:0,to:1}),e=>e.status===409&&e.code==='NOT_ACTIVE');
 await tickPvp({roomIds:[room.id],now:now+60001,skipGap:true});const done=await read(room.id);assert.equal(done.status,'voided',JSON.stringify(done.error));assert.equal(done.result.reason,'shared_fault_unrecoverable');assert.equal(done.result.fee_minor,'0');assert.ok(done.result.payouts.every(p=>p.payout_minor==='10000'));assert.equal((await snapshot(f)).operations.length,4);conservation(await snapshot(f));
});

for(const version of ['towerlink-v1.1.0','towerlink-v2.0.0'])for(const status of ['waiting','funding'])test(`Tower Link ${version} ${status} lobby cancels before capture or new-engine creation`,async()=>{
 const f=await fixture(),now=Date.now(),room=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'towerlink',capacity:2,entry_minor:'10000'},{now})).body;
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${room.id}/join`,{},{now});
 if(status==='funding')for(const s of f.sessions.slice(0,2))await call(s,'POST',`/api/pvp/rooms/${room.id}/ready`,{},{now});
 await pool.query("UPDATE pvp_rooms SET rule_version=$2,terms=jsonb_set(terms,'{rule_version}',to_jsonb($2::text)) WHERE id=$1",[room.id,version]);
 await Promise.all([tickPvp({roomIds:[room.id],now}),tickPvp({roomIds:[room.id],now})]);const done=await read(room.id);assert.equal(done.status,'cancelled');assert.equal(done.game_state,null);assert.equal(done.captured,false);
 const wallet=await snapshot(f);assert.equal(wallet.operations.length,1);assert.ok(wallet.users.every(u=>u.available==='100000'));conservation(wallet);
});

test('Tower Link social waiting room cancellation never creates a wallet tombstone',async()=>{
 const f=await fixture(),room=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'towerlink',capacity:4,entry_minor:'0'})).body;
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/leave`);await tickPvp({roomIds:[room.id]});assert.equal((await read(room.id)).status,'cancelled');assert.equal((await snapshot(f)).operations.length,0);
});

for(const version of ['towerlink-v1.1.0','towerlink-v2.0.0'])test(`Tower Link ${version} funding with an already committed capture refunds using its original wallet identity`,async()=>{
 const f=await fixture(),now=Date.now(),room=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'towerlink',capacity:2,entry_minor:'10000'},{now})).body;
 await call(f.sessions[1],'POST',`/api/pvp/rooms/${room.id}/join`,{},{now});for(const s of f.sessions.slice(0,2))await call(s,'POST',`/api/pvp/rooms/${room.id}/ready`,{},{now});
 await pool.query("UPDATE pvp_rooms SET rule_version=$2,terms=jsonb_set(terms,'{rule_version}',to_jsonb($2::text)) WHERE id=$1",[room.id,version]);
 const db=await read(room.id),{walletRequest}=await import('../server/wallet-binding.mjs');
 const participants=db.players.map(p=>({external_user_id:p.external_user_id,seat_index:p.seat_index,reservation_id:`res_${db.id}_${p.seat_index}`,entry_minor:db.entry_minor}));
 const send=async(path,body)=>walletRequest(f.app,'POST',path,JSON.stringify(body),body.request_id);
 for(const p of participants)await send('/wallet/v1/reservations',{...f.scope,match_id:db.id,request_id:`reserve_${db.id}_${p.seat_index}`,reservation_id:p.reservation_id,external_user_id:p.external_user_id,seat_index:p.seat_index,amount_minor:p.entry_minor,terms:db.terms,expires_at:new Date(Date.now()+60000).toISOString()});
 await send('/wallet/v1/matches/capture',{...f.scope,match_id:db.id,request_id:`capture_${db.id}`,terms:db.terms,participants});
 // The old process died after capture committed, before persisting its receipt.
 assert.equal(db.captured,false);await tickPvp({roomIds:[room.id],now,skipGap:true});const done=await read(room.id);
 assert.equal(done.status,'voided',JSON.stringify(done.error));assert.equal(done.result.reason,'cancel_after_capture');assert.equal(done.game_state,null);assert.equal(done.result.fee_minor,'0');
 const before=await snapshot(f);await tickPvp({roomIds:[room.id],now:now+1,skipGap:true});const after=await snapshot(f);assert.deepEqual(after.users,before.users);assert.ok(after.users.every(u=>u.available==='100000'));assert.equal(after.operations.length,5);conservation(after);
});

test('Tower Link game-options migration upgrades an older table and is idempotent',async()=>{
 await pool.query('ALTER TABLE pvp_rooms DROP COLUMN game_options');await migratePvp(pool);
 const row=(await pool.query("SELECT column_default,is_nullable FROM information_schema.columns WHERE table_name='pvp_rooms' AND column_name='game_options'")).rows[0];assert.equal(row.is_nullable,'NO');assert.match(row.column_default,/jsonb/);
 await pool.query("UPDATE pvp_rooms SET game_options='{\"migration_probe\":true}'::jsonb WHERE id=(SELECT id FROM pvp_rooms LIMIT 1)");await migratePvp(pool);
 assert.equal((await pool.query("SELECT count(*) FROM pvp_rooms WHERE game_options->>'migration_probe'='true'")).rows[0].count,'1');
});

test('Tower Link training rejects paid or human modes, unknown lessons and the wrong roster size',async()=>{
 const f=await fixture(),base={game_id:'towerlink',capacity:2,practice:true,entry_minor:'0',training_lesson_id:'lesson-01'};
 for(const body of [{...base,practice:false},{...base,entry_minor:'10000'}])await assert.rejects(call(f.sessions[0],'POST','/api/pvp/rooms',body),e=>e.code==='INVALID_TRAINING_MODE'&&e.status===400);
 for(const body of [{...base,training_lesson_id:'lesson-99'},{...base,training_lesson_id:1},{...base,capacity:4},{...base,training_lesson_id:'lesson-10'}])await assert.rejects(call(f.sessions[0],'POST','/api/pvp/rooms',body),e=>e.code==='INVALID_TRAINING_LESSON'&&e.status===400);
 assert.equal((await pool.query('SELECT count(*) FROM pvp_rooms WHERE app_id=$1',[f.app.id])).rows[0].count,'0');assert.equal((await snapshot(f)).operations.length,0);
});

async function trainingRoom(f,lesson,now=Date.now()){
 const opts={now,skipGap:true},r=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'towerlink',capacity:lesson==='lesson-10'?3:2,practice:true,entry_minor:'0',training_lesson_id:lesson},opts)).body;
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/ready`,{},opts);await tickPvp({roomIds:[r.id],now,skipGap:true});const db=await read(r.id);assert.equal(db.status,'active',JSON.stringify(db.error));
 return(await get(f,r,Number(db.starts_at))).body;
}

test('Tower Link all 12 training lessons persist their identity and never call a wallet',async()=>{
 const f=await fixture();let now=Date.now();
 for(let n=1;n<=12;n++){
  const lesson='lesson-'+String(n).padStart(2,'0'),room=await trainingRoom(f,lesson,now);now=room.server_now+1000;
  assert.equal(room.practice,true);assert.equal(room.entry_minor,'0');assert.equal(room.training_lesson_id,lesson);assert.equal(room.game.training.lessonId,lesson);assert.equal(room.game.training.completed,false);assert.equal(room.game.training.failed,false);assert.equal(room.game.deadlineAt,room.end_at);
  assert.equal((await read(room.id)).game_options.training_lesson_id,lesson);if(n===11)assert.equal(room.end_at-room.starts_at,45000);
  const left=await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/leave`,{},{now,skipGap:true});assert.equal(left.body.status,'cancelled');assert.equal((await pool.query('SELECT count(*) FROM pvp_active_users WHERE room_id=$1',[room.id])).rows[0].count,'0');
 }
 assert.equal((await snapshot(f)).operations.length,0);
});

test('Tower Link a real lesson objective completes on the server and next lesson gets a new free room',async()=>{
 const f=await fixture(),room=await trainingRoom(f,'lesson-01'),at=room.server_now,targets=(await read(room.id)).game_state.training.targets,first=room.game.legalActions.find(a=>a.type==='link'&&a.from===targets.home&&a.to===targets.target);assert.ok(first);
 await action(f,room,at,1,first);let completed;
 for(let n=1;n<=40;n++){const state=(await get(f,room,at+n*500)).body;if(state.status!=='active'){completed=state;break;}}
 assert.ok(completed,'capturing the first neutral tower must complete the first lesson');assert.equal(completed.status,'settled');assert.equal(completed.game.training.completed,true);assert.equal(completed.game.training.nextLessonId,'lesson-02');assert.equal(completed.game.finishReason,'training-complete');
 assert.equal((await pool.query('SELECT count(*) FROM pvp_active_users WHERE room_id=$1',[room.id])).rows[0].count,'0');
 const next=await trainingRoom(f,completed.game.training.nextLessonId,completed.server_now+1000);assert.notEqual(next.id,room.id);assert.equal(next.game.training.lessonId,'lesson-02');assert.equal(next.game.training.completed,false);
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${next.id}/leave`,{},{now:next.server_now+250,skipGap:true});assert.equal((await snapshot(f)).operations.length,0);
});

for(const capacity of[2,3,4])test(`new ${capacity}-seat BOT practice has one shared second, with no prestart action or production`,async()=>{
 const f=await fixture(),room=await setup(f,capacity,'0',true,{countdown:true}),now=room.server_now,stored=await read(room.id);
 assert.equal(room.starts_at,now+1000);assert.equal(room.end_at-room.starts_at,180000);assert.equal(stored.game_options.start_policy,'towerlink-practice-start-v1');assert.equal(stored.game_options.start_delay_ms,1000);
 const before=(await get(f,room,now+999)).body,mine=ownTower(before.game,'player_0');assert.equal(before.me_last_seq,0);assert.deepEqual(before.game.legalActions,[]);assert.ok(before.game.towers.filter(t=>before.game.owners[t.id]).every(t=>t.troops===30));assert.equal(before.game.armies.length,0);
 await assert.rejects(action(f,room,now+999,1,{type:'upgrade',towerId:mine.id}),e=>e.code==='GAME_NOT_STARTED');const started=(await get(f,room,now+1000)).body;assert.ok(started.game.legalActions.length);assert.equal(started.game.startedAt,room.starts_at);assert.equal((await snapshot(f)).operations.length,0);
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/leave`,{},{now:now+1001,skipGap:true});
});
for(const status of['waiting','funding'])test(`old persisted ${status} BOT room restores its original three-second start after coordinator reload`,async()=>{
 const f=await fixture(),now=Date.now(),opts={now,skipGap:true},request={request_id:uid('oldcreate'),game_id:'towerlink',capacity:2,entry_minor:'0',practice:true};
 const created=await routePvp(f.sessions[0],'POST','/api/pvp/rooms',request,opts),room=created.body;
 await pool.query("UPDATE pvp_rooms SET game_options='{}'::jsonb WHERE id=$1",[room.id]);
 if(status==='funding')await call(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/ready`,{},opts);
 const restored=await import('../server/pvp/index.mjs?oldstart='+uid('reload'));await restored.migratePvp(pool);
 if(status==='waiting')await restored.routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/ready`,{request_id:uid('ready')},opts);
 await restored.tickPvp({roomIds:[room.id],now,skipGap:true});const started=(await restored.routePvp(f.sessions[0],'GET',`/api/pvp/rooms/${room.id}`,{},opts)).body;
 assert.equal(started.starts_at,now+3000);assert.equal(started.game.startedAt,started.starts_at);assert.deepEqual((await read(room.id)).game_options,{});
 const replay=await restored.routePvp(f.sessions[0],'POST','/api/pvp/rooms',request,opts);assert.deepEqual(replay,created);assert.deepEqual((await read(room.id)).game_options,{});
 const later=(await restored.routePvp(f.sessions[0],'GET',`/api/pvp/rooms/${room.id}`,{},{now:now+3200,skipGap:true})).body;assert.equal(later.starts_at,started.starts_at);assert.equal(later.game.startedAt,started.game.startedAt);assert.equal(later.end_at,started.end_at);
 await restored.routePvp(f.sessions[0],'POST',`/api/pvp/rooms/${room.id}/leave`,{request_id:uid('leave')},{now:now+3300,skipGap:true});assert.equal((await snapshot(f)).operations.length,0);
});
test('client-supplied countdown cannot shorten a real friend room or override normalized practice policy',async()=>{
 for(const practice of[false,true]){const f=await fixture(),now=Date.now(),opts={now,skipGap:true},r=(await call(f.sessions[0],'POST','/api/pvp/rooms',{game_id:'towerlink',capacity:2,entry_minor:'0',practice,start_policy:'towerlink-practice-start-v1',start_delay_ms:0,game_options:{start_policy:'towerlink-practice-start-v1',start_delay_ms:1}},opts)).body;
 if(!practice)await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/join`,{},opts);for(const s of f.sessions.slice(0,practice?1:2))await call(s,'POST',`/api/pvp/rooms/${r.id}/ready`,{},opts);await tickPvp({roomIds:[r.id],now,skipGap:true});const db=await read(r.id);assert.equal(Number(db.starts_at),now+(practice?1000:3000));assert.deepEqual(db.game_options,practice?{start_policy:'towerlink-practice-start-v1',start_delay_ms:1000}:{});
 await call(f.sessions[0],'POST',`/api/pvp/rooms/${r.id}/leave`,{},{now:now+1,skipGap:true});if(!practice)await call(f.sessions[1],'POST',`/api/pvp/rooms/${r.id}/leave`,{},{now:now+2,skipGap:true});assert.equal((await snapshot(f)).operations.length,0);}
});
