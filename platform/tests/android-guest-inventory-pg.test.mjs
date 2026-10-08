/** Actual SQL against one fresh local-only owned database; no API/server/device. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {ANDROID_GUEST_INVENTORY_SQL as sql,ANDROID_INVENTORY_COUNTERS} from '../scripts/android-guest-inventory.mjs';

test('persistent APK guest obligations use actual PostgreSQL NULL/JSON and exact scope semantics',async t=>{
 const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');assert.ok(['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname));adminUrl.pathname='/postgres';
 const name=`oasis_release_test_${process.pid}_${randomBytes(6).toString('hex')}`,url=new URL(adminUrl);url.pathname='/'+name;
 const admin=new pg.Pool({connectionString:adminUrl.href,max:1,connectionTimeoutMillis:3000});let created=false,db;
 const empty={version:0,pendingPlay:null,cycleId:null,nextIndex:0};
 try{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;t.diagnostic('created owned database '+name);db=new pg.Pool({connectionString:url.href,max:1});
  await db.query(`CREATE TABLE gp_sessions(id text PRIMARY KEY,app_id text,external_user_id text,state jsonb);
   CREATE TABLE gp_cycles(id text PRIMARY KEY,session_id text,app_id text,external_user_id text,status text,result jsonb);
   CREATE TABLE gp_plays(id text,session_id text,cycle_id text,round_index int,acknowledged boolean);
   CREATE TABLE pvp_rooms(id text,status text,app_id text,players jsonb);
   CREATE TABLE pvp_active_users(app_id text,external_user_id text,room_id text);
   CREATE TABLE gp_operations(app_id text,aggregate_id text,state text);
   CREATE TABLE pvp_operations(app_id text,room_id text,state text);`);
  const reset=async()=>{await db.query('TRUNCATE gp_sessions,gp_cycles,gp_plays,pvp_rooms,pvp_active_users,gp_operations,pvp_operations');await db.query('INSERT INTO gp_sessions VALUES ($1,$2,$3,$4),($5,$2,$3,$4)',['old','app','guest',empty,'new']);};
  const read=async()=>{await db.query('BEGIN READ ONLY');try{return(await db.query(sql,['app','guest'])).rows[0];}finally{await db.query('ROLLBACK');}};
  const clean=counts=>ANDROID_INVENTORY_COUNTERS.slice(3).every(key=>counts[key]===0);
  const cycle=async({state={version:1,pendingPlay:null,cycleId:'cycle',nextIndex:1},result={rounds:[{freeSpinsAfter:0}]},ack=true,plays=true,status='SETTLED'}={})=>{
   await db.query('UPDATE gp_sessions SET state=$1 WHERE id=$2',[state,'old']);await db.query('INSERT INTO gp_cycles VALUES ($1,$2,$3,$4,$5,$6)',['cycle','old','app','guest',status,result]);
   if(plays)await db.query('INSERT INTO gp_plays VALUES ($1,$2,$3,0,$4)',['round','old','cycle',ack]);
  };
  await t.test('empty new session does not hide old pending or unacknowledged round',async()=>{
   await reset();await cycle({state:{version:1,pendingPlay:'round',cycleId:'cycle',nextIndex:1},ack:false});const counts=await read();assert.equal(counts.sessions,2);assert.equal(counts.pending_rounds,1);assert.equal(counts.unacknowledged_rounds,1);assert.equal(clean(counts),false);
  });
  await t.test('old bonus remainder and detached partial cycle are both refused',async()=>{
   await reset();await cycle({result:{rounds:[{freeSpinsAfter:1},{freeSpinsAfter:0}]}});assert.equal((await read()).remaining_cycles,1);assert.equal((await read()).unresolved_cycles,1);
   await db.query('UPDATE gp_sessions SET state=$1 WHERE id=$2',[empty,'old']);const detached=await read();assert.equal(detached.remaining_cycles,0);assert.equal(detached.unresolved_cycles,1);
  });
  await t.test('normal completed cycle is clean; missing/invalid JSON is never clean',async()=>{
   await reset();await cycle();assert.equal(clean(await read()),true);
   for(const state of [{},null,{...empty,nextIndex:null},{...empty,nextIndex:'0'},{...empty,nextIndex:-1},{...empty,nextIndex:1.5},{...empty,nextIndex:1e30},{...empty,version:null},{...empty,pendingPlay:{}},{version:1,pendingPlay:null,cycleId:'cycle'}]){
    await db.query('UPDATE gp_sessions SET state=$1 WHERE id=$2',[JSON.stringify(state),'old']);const value=await read();assert.ok(value.invalid_states>0,JSON.stringify(state));assert.equal(clean(value),false);
   }
   await db.query('UPDATE gp_sessions SET state=$1 WHERE id=$2',[{version:1,pendingPlay:null,cycleId:'cycle',nextIndex:1},'old']);
   for(const result of [{},null,{rounds:null},{rounds:{}},{rounds:[]}]){await db.query('UPDATE gp_cycles SET result=$1 WHERE id=$2',[JSON.stringify(result),'cycle']);const value=await read();assert.ok(value.invalid_states>0);assert.ok(value.invalid_cycles>0);}
  });
  await t.test('a different app or guest never contaminates the exact owner',async()=>{
   await reset();await db.query('INSERT INTO gp_sessions VALUES ($1,$2,$3,$4),($5,$6,$7,$4)',['foreign-app','other-app','guest',{pendingPlay:'foreign'},'foreign-guest','app','other-guest']);
   await db.query("INSERT INTO pvp_active_users VALUES ('other-app','guest','foreign'),('app','other-guest','foreign')");assert.equal(clean(await read()),true);
  });
  await t.test('active pointer, nonterminal membership and unresolved operations are reported',async()=>{
   await reset();await cycle({status:'AUTHORIZING',result:null,plays:false});await db.query("INSERT INTO gp_operations VALUES ('app','cycle','PENDING')");
   await db.query('INSERT INTO pvp_rooms VALUES ($1,$2,$3,$4)',['room','settling','app',JSON.stringify([{external_user_id:'guest'}])]);await db.query("INSERT INTO pvp_active_users VALUES ('app','guest','room');INSERT INTO pvp_operations VALUES ('app','room','PENDING')");
   const counts=await read();for(const key of ['active_rooms','nonterminal_rooms','unresolved_cycles','probability_operations','arena_operations'])assert.equal(counts[key],1,key);assert.equal(clean(counts),false);
  });
  await t.test('query itself performs no cleanup/recovery write',async()=>{
   const before=(await db.query('SELECT jsonb_agg(to_jsonb(s)) AS value FROM gp_sessions s')).rows[0].value;await read();assert.deepEqual((await db.query('SELECT jsonb_agg(to_jsonb(s)) AS value FROM gp_sessions s')).rows[0].value,before);
  });
 }finally{try{await db?.end();if(created){await dropOwnedTestDatabase(admin,name,{created:true});t.diagnostic('removed owned database '+name);}}finally{await admin.end();}}
});
