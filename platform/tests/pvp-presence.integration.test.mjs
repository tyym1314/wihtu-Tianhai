/** Snapshot polling and durable presence, isolated database and no wallet. */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import * as run from '../arena/run/engine.mjs';
let pool,locked,tryLocked,closePools,routePvp,tickPvp,admin,localDir,created=false;
const name='oasis_pvp_test_'+process.pid+'_'+randomBytes(8).toString('hex');
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres'),dbUrl=new URL(adminUrl);dbUrl.pathname='/'+name;
const previous={database:process.env.OASIS_DATABASE_URL,local:process.env.OASIS_LOCAL_DIR},uid=prefix=>prefix+'_'+randomBytes(8).toString('hex');
before(async()=>{
 assert.match(name,/^oasis_pvp_test_[0-9]+_[a-f0-9]{16}$/);admin=new pg.Pool({connectionString:adminUrl.toString(),max:2});await admin.query(`CREATE DATABASE "${name}"`);created=true;
 localDir=await mkdtemp(join(tmpdir(),'oasis-presence-'));process.env.OASIS_DATABASE_URL=dbUrl.toString();process.env.OASIS_LOCAL_DIR=localDir;
 ({pool,locked,tryLocked,closePools}=await import('../server/db.mjs'));assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
 await(await import('../server/platform.mjs')).migratePlatform();const pvp=await import('../server/pvp/index.mjs');await pvp.migratePvp();({routePvp,tickPvp}=pvp);
});
after(async()=>{try{await closePools?.();if(created)await dropOwnedTestDatabase(admin,name,{created});}finally{await admin?.end();if(localDir)await rm(localDir,{recursive:true,force:true});for(const[k,v]of[['OASIS_DATABASE_URL',previous.database],['OASIS_LOCAL_DIR',previous.local]])if(v===undefined)delete process.env[k];else process.env[k]=v;}});
const read=async id=>(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];
const presence=async id=>(await pool.query('SELECT external_user_id,last_seen_at FROM pvp_presence WHERE room_id=$1 ORDER BY external_user_id',[id])).rows;
async function fixture(){
 const app=uid('presence_app'),owner={app_id:app,game_id:'run',external_user_id:'owner'},peer={...owner,external_user_id:'peer'};
 await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[app,'presence regression','test_partner','sandbox','test_scope','https://no-wallet.invalid','["run"]']);
 const call=(session,method,path,body={})=>routePvp(session,method,path,{request_id:uid('presence_req'),...body});
 const room=(await call(owner,'POST','/api/pvp/rooms',{game_id:'run',capacity:2,practice:true})).body;
 // A free fixture with two independent human identities, so timeout tests do
 // not need financial operations or BOT scheduling/physics. Pin the previous
 // immediate-start rules so these tests reach gameplay without v2.1 arming.
 const db=await read(room.id);Object.assign(db.players[1],{external_user_id:peer.external_user_id,bot:false,name:'peer'});
 // Historical fixtures predate the persisted Run course policy; keep that original absence.
 await pool.query("UPDATE pvp_rooms SET game_options=game_options-'run_course_policy'-'run_course_id',players=$2,rule_version=$3,terms=jsonb_set(terms,'{rule_version}',to_jsonb($3::text)) WHERE id=$1",[room.id,JSON.stringify(db.players),run.PREVIOUS_RULE_VERSION]);
 await call(owner,'POST',`/api/pvp/rooms/${room.id}/ready`);await tickPvp({roomIds:[room.id]});
 return{id:room.id,owner,peer,call,get:s=>call(s,'GET',`/api/pvp/rooms/${room.id}`)};
}

test('GET reads a committed snapshot without joining a held room lock; action ACK and later snapshots cannot regress',async()=>{
 const f=await fixture(),before=await read(f.id);let release,entered,holder,action,timer;
 const acquired=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
 try{
  holder=locked('pvp:'+f.id,async()=>{entered();await wait;});await acquired;
  action=f.call(f.owner,'POST',`/api/pvp/rooms/${f.id}/action`,{seq:1,action:{type:'jump'}});
  const snapshot=(await Promise.race([f.get(f.owner),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('snapshot waited for gameplay lock')),1000);})])).body;
  clearTimeout(timer);const unchanged=await read(f.id);
  assert.equal(snapshot.version,Number(before.version));assert.equal(snapshot.me_last_seq,0);
  assert.equal(unchanged.version,before.version);assert.deepEqual(unchanged.game_state,before.game_state);
  assert.equal((await presence(f.id)).length,1);release();await holder;const ack=(await action).body;
  assert.ok(ack.version>snapshot.version);assert.equal(ack.me_last_seq,1);
  const fresh=(await f.get(f.owner)).body;assert.ok(fresh.version>=ack.version);assert.equal(fresh.me_last_seq,1);
  assert.ok(fresh.server_now>=ack.server_now);assert.equal((await pool.query('SELECT count(*) FROM pvp_operations WHERE room_id=$1',[f.id])).rows[0].count,'0');
 }finally{clearTimeout(timer);release?.();await Promise.allSettled([holder,action]);}
});

test('concurrent and out-of-order presence survives stale player writes and preserves the exact 30-second boundary',async()=>{
 const f=await fixture(),before=await read(f.id),originalNow=Date.now;let clock=Number(before.last_tick_at)+1000;
 const seen=clock;
 try{
  Date.now=()=>clock;
  await Promise.all(Array.from({length:12},(_,i)=>f.get(i%2?f.owner:f.peer)));
  const rows=await presence(f.id);assert.equal(rows.length,2);assert.ok(rows.every(p=>Number(p.last_seen_at)===seen));
  clock=seen-100;await f.get(f.owner);assert.equal(Number((await presence(f.id)).find(p=>p.external_user_id==='owner').last_seen_at),seen);
  // Reproduce an older room writer replacing the players JSON after a poll.
  for(const p of before.players)p.last_seen_at=seen-30000;
  await pool.query('UPDATE pvp_rooms SET players=$2,last_tick_at=$3 WHERE id=$1',[f.id,JSON.stringify(before.players),seen]);
  clock=seen;await tickPvp({roomIds:[f.id]});let saved=await read(f.id);
  assert.equal(saved.status,'active');assert.ok(saved.players.every(p=>p.last_seen_at===seen));
  clock=seen+20000;await pool.query('UPDATE pvp_rooms SET last_tick_at=$2 WHERE id=$1',[f.id,clock-1]);await f.get(f.peer);
  clock=seen+30000;await pool.query('UPDATE pvp_rooms SET last_tick_at=$2 WHERE id=$1',[f.id,clock-1]);await tickPvp({roomIds:[f.id]});
  saved=await read(f.id);assert.equal(saved.status,'active');assert.ok(saved.game_state.players.every(p=>!p.forfeited));
  clock++;const late=(await f.get(f.owner)).body;
  assert.equal(late.players.find(p=>p.external_user_id==='owner').connected,false);
  assert.equal(Number((await presence(f.id)).find(p=>p.external_user_id==='owner').last_seen_at),seen);
  await tickPvp({roomIds:[f.id]});saved=await read(f.id);
  assert.equal(saved.status,'settled');assert.equal(saved.game_state.players.find(p=>p.key==='owner').forfeited,true);assert.equal(saved.game_state.players.find(p=>p.key==='peer').forfeited,false);
  const terminalPresence=await presence(f.id);clock+=100;await f.get(f.peer);assert.deepEqual(await presence(f.id),terminalPresence);
 }finally{Date.now=originalNow;}
});

test('non-members and foreign tenants cannot write presence',async()=>{
 const f=await fixture();await assert.rejects(f.get({...f.owner,external_user_id:'stranger'}),e=>e.code==='NOT_A_PLAYER');
 await assert.rejects(f.get({...f.owner,app_id:'foreign_app'}),e=>e.code==='ROOM_NOT_FOUND');
 assert.deepEqual(await presence(f.id),[]);
});

test('same-room lock waiters do not exhaust the database lock pool or delay unrelated keys',async()=>{
 const key=uid('pvp:lock_pressure');let entered,release,timer,holder;const order=[],waiting=[];
 const acquired=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 try{
  holder=locked(key,async()=>{entered();await hold;});await acquired;
  for(let i=0;i<63;i++)waiting.push(locked(key,async()=>order.push(i)));
  await assert.rejects(locked(key,async()=>assert.fail('overflow must not run')),e=>e.code==='LOCK_QUEUE_FULL'&&e.status===503);
  assert.equal(await tryLocked(key,()=>assert.fail('background work must skip busy local room')),undefined);
  assert.equal(await Promise.race([locked(uid('pvp:unrelated'),async()=>42),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('same-room waiters exhausted database connections')),1000);})]),42);
  clearTimeout(timer);release();await holder;await Promise.all(waiting);assert.deepEqual(order,Array.from({length:63},(_,i)=>i));
  // A failed callback still releases both levels of locks for a retry.
  await assert.rejects(locked(key,async()=>{throw Error('injected');}),/injected/);
  assert.equal(await tryLocked(key,async()=>17),17);
 }finally{clearTimeout(timer);release?.();await Promise.allSettled([holder,...waiting]);}
});
