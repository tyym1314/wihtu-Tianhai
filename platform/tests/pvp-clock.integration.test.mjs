/** Real advisory-lock regression; dedicated ephemeral DB, free practice only, no wallet. */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import * as run from '../arena/run/engine.mjs';
let pool,locked,closePools,routePvp,tickPvp,admin,localDir,created=false;
const name='oasis_clock_test_'+process.pid+'_'+randomBytes(8).toString('hex');
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres'),dbUrl=new URL(adminUrl);dbUrl.pathname='/'+name;
const previous={database:process.env.OASIS_DATABASE_URL,local:process.env.OASIS_LOCAL_DIR},uid=prefix=>prefix+'_'+randomBytes(8).toString('hex');
before(async()=>{
 assert.match(name,/^oasis_clock_test_[0-9]+_[a-f0-9]{16}$/);admin=new pg.Pool({connectionString:adminUrl.toString(),max:2});await admin.query(`CREATE DATABASE "${name}"`);created=true;
 localDir=await mkdtemp(join(tmpdir(),'oasis-clock-'));process.env.OASIS_DATABASE_URL=dbUrl.toString();process.env.OASIS_LOCAL_DIR=localDir;
 ({pool,locked,closePools}=await import('../server/db.mjs'));assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
 await(await import('../server/platform.mjs')).migratePlatform();const pvp=await import('../server/pvp/index.mjs');await pvp.migratePvp();({routePvp,tickPvp}=pvp);
});
after(async()=>{try{await closePools?.();if(created)await dropOwnedTestDatabase(admin,name,{created});}finally{await admin?.end();if(localDir)await rm(localDir,{recursive:true,force:true});for(const[k,v]of[['OASIS_DATABASE_URL',previous.database],['OASIS_LOCAL_DIR',previous.local]])if(v===undefined)delete process.env[k];else process.env[k]=v;}});
async function fixture(){const app=uid('clock_app'),session={app_id:app,game_id:'run',external_user_id:'runner'};await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[app,'clock regression','test_partner','sandbox','test_scope','https://no-wallet.invalid','["run"]']);const call=(method,path,body={})=>routePvp(session,method,path,{request_id:uid('clock_req'),...body});const room=(await call('POST','/api/pvp/rooms',{game_id:'run',capacity:2,practice:true})).body;await call('POST',`/api/pvp/rooms/${room.id}/ready`);await tickPvp({roomIds:[room.id]});return{session,id:room.id};}
const read=async id=>(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];
async function waitUntilQueued(){const until=performance.now()+3000;while(performance.now()<until){const q=await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");if(q.rows[0].n)return;await new Promise(r=>setTimeout(r,5));}assert.fail('request never reached the held advisory lock');}
for(const kind of ['route','ticker'])test(`${kind}: a queued request samples time after the room lock and clamps real clock rollback`,async()=>{
 const f=await fixture(),before=await read(f.id),first=Number(before.last_tick_at)+20,newer=first+100,afterLock=newer+100,originalNow=Date.now;let clock=first,unlock,entered;
 const acquired=new Promise(r=>entered=r),release=new Promise(r=>unlock=r);let holder,queued;
 try{
  Date.now=()=>clock;
  // Use another database session directly to model a different API process;
  // same-process waiters now queue before checking out a lock connection.
  holder=(async()=>{const c=await pool.connect();try{await c.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['pvp:'+f.id]);entered();await release;const room=await read(f.id);run.tick(room.game_state,newer);await pool.query('UPDATE pvp_rooms SET game_state=$2,last_tick_at=$3 WHERE id=$1',[f.id,room.game_state,newer]);}finally{await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['pvp:'+f.id]);c.release();}})();await acquired;
  // Snapshot GET no longer joins room locks. Exercise the mutation route,
  // whose admitted action clock must still be sampled after lock acquisition.
  queued=kind==='route'?routePvp(f.session,'POST',`/api/pvp/rooms/${f.id}/action`,{request_id:uid('queued_action'),seq:1,action:{type:'jump'}}):tickPvp({roomIds:[f.id]});
  // Observe a real PostgreSQL lock waiter, rather than guessing with a sleep.
  await waitUntilQueued();clock=afterLock;unlock();await holder;const response=await queued;
  let saved=await read(f.id);assert.equal(saved.status,'active',JSON.stringify(saved.error));assert.equal(saved.error?.code==='CLOCK_REWIND',false);assert.equal(Number(saved.last_tick_at),afterLock);assert.equal(saved.game_state.now,afterLock);if(kind==='route')assert.equal(response.body.server_now,afterLock);
  clock=first-50;if(kind==='route')await routePvp(f.session,'GET',`/api/pvp/rooms/${f.id}`);else await tickPvp({roomIds:[f.id]});
  saved=await read(f.id);assert.equal(saved.status,'active',JSON.stringify(saved.error));assert.equal(Number(saved.last_tick_at),afterLock);assert.equal(saved.game_state.now,afterLock);
  assert.equal((await pool.query('SELECT count(*) FROM pvp_operations WHERE room_id=$1',[f.id])).rows[0].count,'0');
 }finally{unlock?.();await Promise.allSettled([holder,queued]);Date.now=originalNow;}
});
for(const kind of ['route','ticker'])test(`${kind}: explicitly supplied now is not silently clamped`,async()=>{const f=await fixture(),r=await read(f.id),now=Number(r.last_tick_at)+100;if(kind==='route')await routePvp(f.session,'GET',`/api/pvp/rooms/${f.id}`,{},{now,skipGap:true});else await tickPvp({roomIds:[f.id],now,skipGap:true});assert.equal((await read(f.id)).game_state.now,now);if(kind==='route')await routePvp(f.session,'GET',`/api/pvp/rooms/${f.id}`,{},{now:now-1,skipGap:true});else await tickPvp({roomIds:[f.id],now:now-1,skipGap:true});const bad=await read(f.id);assert.equal(bad.status,'fault');assert.equal(bad.error.code,'CLOCK_REWIND');});
