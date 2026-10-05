// Production PvP route + real PostgreSQL locks/wallet in an owned disposable DB.
// Authentication over HTTP is separately covered by bowling-member-event.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import * as bowling from '../arena/bowling/engine.mjs';
const uid=p=>p+'_'+randomBytes(8).toString('hex'),normal={type:'roll',offset:0,angle:0,power:.78,spin:0};
const name='oasis_pvp_test_'+process.pid+'_'+randomBytes(8).toString('hex');
const adminURL=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres'),dbURL=new URL(adminURL);dbURL.pathname='/'+name;
const prior={...process.env};let admin,pool,closePools,dbPoolStats,closeEnginePool,enginePoolStats,preparations,routePvp,tickPvp,seal,provisionWallet,readWalletSnapshot,wallet,origin,dir,created=false,child;
before(async()=>{
 assert.ok(['127.0.0.1','localhost','[::1]'].includes(adminURL.hostname));admin=new pg.Pool({connectionString:adminURL.href});await admin.query(`CREATE DATABASE "${name}"`);created=true;
 dir=await mkdtemp(join(tmpdir(),'oasis-bowling-prepare-'));process.env.OASIS_DATABASE_URL=dbURL.href;process.env.OASIS_LOCAL_DIR=dir;
 ({pool,closePools,dbPoolStats}=await import('../server/db.mjs'));assert.equal((await pool.query('SELECT current_database() n')).rows[0].n,name);
 ({seal}=await import('../server/security.mjs'));await(await import('../server/platform.mjs')).migratePlatform();
 const w=await import('../server/wallet/index.mjs');await w.migrateWallet(pool);({provisionWallet,readWalletSnapshot}=w);await(await import('../server/wallet-binding.mjs')).migrateWalletBindings(pool);
 const p=await import('../server/pvp/index.mjs');await p.migratePvp(pool);({routePvp,tickPvp}=p);
 ({closeEnginePool,enginePoolStats}=await import('../server/pvp/engine-pool.mjs'));({bowlingPreparations:preparations}=await import('../server/pvp/bowling-preparation.mjs'));
 wallet=w.createWalletServer(pool);await new Promise(r=>wallet.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+wallet.address().port;process.env.OASIS_WALLET_ALLOWED_ORIGINS=origin;
});
after(async()=>{
 try{
  if(child&&child.exitCode===null&&!child.signalCode){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exited;}
  if(wallet?.listening)await new Promise(r=>wallet.close(r));await closeEnginePool?.();await closePools?.();if(created)await dropOwnedTestDatabase(admin,name,{created});
 }finally{await admin?.end();if(dir)await rm(dir,{recursive:true,force:true});for(const k of ['OASIS_DATABASE_URL','OASIS_LOCAL_DIR','OASIS_WALLET_ALLOWED_ORIGINS'])if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}
});
const read=async id=>(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];
const call=(session,id,body,options)=>routePvp(session,'POST',`/api/pvp/rooms/${id}/action`,body,options);
async function waitFor(check,message){const end=performance.now()+5000;while(performance.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,5));}assert.fail(message);}
async function fixture(n=4,existing){
 let f=existing;
 if(!f){const app=uid('prep_app'),scope={partner_id:uid('partner'),app_id:app,environment:'sandbox',wallet_scope_id:uid('scope'),currency_id:'COIN'},key=uid('key'),secret=randomBytes(32).toString('base64');
  await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[app,'preparation fixture',scope.partner_id,'sandbox',scope.wallet_scope_id,origin,'["bowling"]']);
  await pool.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'platform-to-wallet',$3)",[key,app,seal(secret)]);
  await provisionWallet(pool,{scope,key_id:key,secret_base64:secret,users:Array.from({length:n},(_,i)=>({external_user_id:'p'+i,balance_minor:'100000'})),treasury_minor:'100000000'});
  f={scope,sessions:Array.from({length:n},(_,i)=>({id:uid('session'),app_id:app,external_user_id:'p'+i,game_id:'bowling'}))};
 }
 const room=(await routePvp(f.sessions[0],'POST','/api/pvp/rooms',{request_id:uid('create'),game_id:'bowling',capacity:n,entry_minor:'1000'})).body;
 for(let i=1;i<n;i++)await routePvp(f.sessions[i],'POST',`/api/pvp/rooms/${room.code}/join`,{request_id:uid('join')});
 for(const s of f.sessions)await routePvp(s,'POST',`/api/pvp/rooms/${room.id}/ready`,{request_id:uid('ready')});
 await tickPvp({roomIds:[room.id]});assert.equal((await read(room.id)).status,'active');return{...f,id:room.id};
}
async function finish(f){
 for(const s of f.sessions){const r=await read(f.id);if(['settled','voided','cancelled'].includes(r.status))break;await routePvp(s,'POST',`/api/pvp/rooms/${f.id}/leave`,{request_id:uid('leave')});}
 await tickPvp({roomIds:[f.id]});const r=await read(f.id);assert.ok(['settled','voided'].includes(r.status));assert.equal((await pool.query('SELECT 1 FROM pvp_active_users WHERE room_id=$1',[f.id])).rowCount,0);
 const snapshot=await readWalletSnapshot(pool,{scope:f.scope});assert.equal(snapshot.operations.filter(o=>o.operation_id==='settle_'+f.id).length,1);assert.equal(snapshot.ledger.reduce((n,l)=>n+BigInt(l.delta_available)+BigInt(l.delta_reserved),0n),0n);
}
async function hold(id){const c=await pool.connect();await c.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['pvp:'+id]);let released=false;return async()=>{if(released)return;released=true;try{await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['pvp:'+id]);}finally{c.release();}};}
for(const n of [2,3,4])test(`${n} same-room lanes prepare while waiting for original lock and each persist exactly once`,async t=>{
 const f=await fixture(n),before=await read(f.id),stats=preparations.stats(),release=await hold(f.id);let requests=[];
 try{
  requests=f.sessions.map((s,i)=>call(s,f.id,{request_id:uid('roll'),seq:1,action:{...normal,angle:i%2?.01:0}}));
  await waitFor(()=>preparations.stats().started-stats.started===n&&dbPoolStats().local_lock_waiters>=n,'all same-room requests must start physics then queue before lock release');
  assert.equal(preparations.stats().active,n);await release();const results=await Promise.all(requests);assert.equal(preparations.stats().hits-stats.hits,n);
  const row=await read(f.id),audits=(await pool.query('SELECT * FROM pvp_actions WHERE room_id=$1 ORDER BY accepted_at,external_user_id',[f.id])).rows;assert.equal(audits.length,n);
  for(let i=0;i<n;i++){const response=results[i],key=f.sessions[i].external_user_id;assert.equal(response.status,200);assert.equal(response.body.me_last_seq,1);
   const expected=bowling.act(structuredClone(before.game_state),key,{...normal,angle:i%2?.01:0},response.body.server_now);
   assert.deepEqual(row.game_state.players.find(p=>p.key===key),expected.state.players.find(p=>p.key===key));assert.equal(row.players.find(p=>p.external_user_id===key).last_seq,1);
   const audit=audits.find(a=>a.external_user_id===key);assert.deepEqual(audit.event,expected.event);assert.equal(Number(audit.accepted_at),response.body.server_now);
  }
  const versions=results.map(r=>r.body.version).sort((a,b)=>a-b);assert.equal(new Set(versions).size,n);assert.ok(versions.every(v=>v>Number(before.version)));assert.equal(preparations.stats().active,0);
  if(n===4)assert.ok(enginePoolStats().maxRunning>=2,'real worker tasks overlap for independent lanes');t.diagnostic(JSON.stringify({n,hits:n,poolMaxRunning:enginePoolStats().maxRunning}));
 }finally{await release();await Promise.allSettled(requests);await finish(f);}
});
test('in-flight same request shares pure result; replay, conflicting body and fresh-process replay preserve one action',async()=>{
 const f=await fixture(2),body={request_id:uid('same_request'),seq:1,action:normal},stats=preparations.stats(),release=await hold(f.id);let requests=[];
 try{
  requests=Array.from({length:4},()=>call(f.sessions[0],f.id,body));await waitFor(()=>preparations.stats().shared-stats.shared===3,'retries must share one pending calculation');await release();const responses=await Promise.all(requests);for(const r of responses)assert.deepEqual(r,responses[0]);
  assert.equal(preparations.stats().started-stats.started,1);assert.equal(preparations.stats().hits-stats.hits,1);assert.equal((await pool.query('SELECT 1 FROM pvp_actions WHERE room_id=$1',[f.id])).rowCount,1);
  await assert.rejects(call(f.sessions[0],f.id,{...body,action:{...normal,power:.79}}),{code:'IDEMPOTENCY_CONFLICT'});
  const proc=child=spawn(process.execPath,['--import','tsx','tests/bowling-member-event-restart-child.mjs',JSON.stringify({session:f.sessions[0],roomId:f.id,body})],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env},stdio:['ignore','pipe','pipe']});let out='',err='';proc.stdout.on('data',b=>out+=b);proc.stderr.on('data',b=>err+=b);const exit=await new Promise((r,j)=>{proc.once('exit',r);proc.once('error',j);});assert.equal(exit,0,err);assert.deepEqual(JSON.parse(out),{replay:true,actions:1,unchanged:true});
 }finally{await release();await Promise.allSettled(requests);await finish(f);}
 const next=await fixture(2,f);try{await assert.rejects(call(next.sessions[0],next.id,body),{code:'IDEMPOTENCY_CONFLICT'});assert.equal((await pool.query('SELECT 1 FROM pvp_actions WHERE room_id=$1',[next.id])).rowCount,0);}finally{await finish(next);}
});
test('two request ids competing for one seq cannot overwrite or double apply',async()=>{
 const f=await fixture(2),release=await hold(f.id),stats=preparations.stats();let promises=[];
 try{promises=[call(f.sessions[0],f.id,{request_id:uid('first'),seq:1,action:normal}),call(f.sessions[0],f.id,{request_id:uid('second'),seq:1,action:{...normal,power:.8}})];
  await waitFor(()=>dbPoolStats().local_lock_waiters>=2,'both actions queue');await release();const all=await Promise.allSettled(promises);assert.equal(all.filter(r=>r.status==='fulfilled').length,1);assert.equal(all.find(r=>r.status==='rejected').reason.code,'INVALID_SEQUENCE');assert.equal(preparations.stats().conflictSkipped-stats.conflictSkipped,1);assert.equal((await pool.query('SELECT 1 FROM pvp_actions WHERE room_id=$1',[f.id])).rowCount,1);
 }finally{await release();await Promise.allSettled(promises);await finish(f);}
});
test('queued action samples clock after lock acquisition and retains a newer other-player shot',async()=>{
 const f=await fixture(3),initial=await read(f.id),release=await hold(f.id),originalNow=Date.now;let action;const early=Number(initial.last_tick_at)+50,later=early+300;
 try{Date.now=()=>early;action=call(f.sessions[0],f.id,{request_id:uid('queued'),seq:1,action:normal});await waitFor(()=>dbPoolStats().local_lock_waiters>=1,'request queues before computed result is applied');
  const updated=bowling.act(structuredClone(initial.game_state),'p1',{...normal,angle:.02},early+100).state;
  await pool.query('UPDATE pvp_rooms SET game_state=$2,last_tick_at=$3 WHERE id=$1',[f.id,updated,early+100]);Date.now=()=>later;await release();const result=await action,row=await read(f.id);
  assert.equal(result.body.server_now,later);assert.equal(row.game_state.players.find(p=>p.key==='p0').shotStartedAt,later);assert.deepEqual(row.game_state.players.find(p=>p.key==='p1'),updated.players.find(p=>p.key==='p1'));
 }finally{Date.now=originalNow;await release();await Promise.allSettled([action]);await finish(f);}
});
test('a timeout while waiting invalidates prepared rack and keeps the original post-timeout act result',async()=>{
 const f=await fixture(3),initial=await read(f.id),release=await hold(f.id),stats=preparations.stats();let action;const at=Number(initial.last_tick_at)+1000;
 try{action=call(f.sessions[0],f.id,{request_id:uid('deadline'),seq:1,action:normal},{now:at,skipGap:true});await waitFor(()=>preparations.stats().started>stats.started,'prepare starts');
  const changed=structuredClone(initial.game_state);changed.players.find(p=>p.key==='p0').shotDeadlineAt=at;await pool.query('UPDATE pvp_rooms SET game_state=$2 WHERE id=$1',[f.id,changed]);await release();const result=await action;
  const expected=bowling.act(changed,'p0',normal,at);assert.deepEqual((await read(f.id)).game_state.players.find(p=>p.key==='p0'),expected.state.players.find(p=>p.key==='p0'));assert.equal(result.body.me_last_seq,1);assert.equal(preparations.stats().stale-stats.stale,1);
 }finally{await release();await Promise.allSettled([action]);await finish(f);}
});
test('forfeit and total deadline while queued reject without consuming prepared results',async()=>{
 for(const mode of ['forfeit','deadline']){const f=await fixture(3),initial=await read(f.id),release=await hold(f.id),stats=preparations.stats();let action;
  try{const at=Number(initial.last_tick_at)+100;action=call(f.sessions[0],f.id,{request_id:uid('invalidated'),seq:1,action:normal},{now:at,skipGap:true});const caught=action.catch(e=>e);await waitFor(()=>preparations.stats().started>stats.started,'prepare starts');
   const changed=structuredClone(initial.game_state);if(mode==='forfeit')bowling.forfeit(changed,['p0'],at);else changed.deadlineAt=at;await pool.query('UPDATE pvp_rooms SET game_state=$2 WHERE id=$1',[f.id,changed]);await release();assert.equal((await caught).code,'NOT_ACTIVE');const row=await read(f.id);assert.equal(row.players.find(p=>p.external_user_id==='p0').last_seq,0);assert.equal((await pool.query('SELECT 1 FROM pvp_actions WHERE room_id=$1',[f.id])).rowCount,0);assert.equal(preparations.stats().hits-stats.hits,0);
  }finally{await release();await Promise.allSettled([action]);await finish(f);}
 }
});
test('transaction failure leaves no accepted seq/audit/replay and same request retries successfully',async()=>{
 const f=await fixture(2),body={request_id:uid('retry_transaction'),seq:1,action:normal};
 try{await pool.query("CREATE FUNCTION reject_prepared_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture action write failed'; END $$");await pool.query('CREATE TRIGGER reject_prepared_action BEFORE INSERT ON pvp_actions FOR EACH ROW EXECUTE FUNCTION reject_prepared_action()');
  await assert.rejects(call(f.sessions[0],f.id,body),{code:'P0001'});const failed=await read(f.id);assert.equal(failed.status,'active');assert.equal(failed.game_state.players.find(p=>p.key==='p0').pending,null);assert.equal(failed.players.find(p=>p.external_user_id==='p0').last_seq,0);assert.equal((await pool.query('SELECT 1 FROM pvp_actions WHERE room_id=$1',[f.id])).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM pvp_requests WHERE request_id=$1',[body.request_id])).rowCount,0);
  await pool.query('DROP TRIGGER reject_prepared_action ON pvp_actions');await pool.query('DROP FUNCTION reject_prepared_action()');const accepted=await call(f.sessions[0],f.id,body);assert.equal(accepted.body.me_last_seq,1);assert.deepEqual(await call(f.sessions[0],f.id,body),accepted);assert.equal(preparations.stats().active,0);
 }finally{await pool.query('DROP TRIGGER IF EXISTS reject_prepared_action ON pvp_actions');await pool.query('DROP FUNCTION IF EXISTS reject_prepared_action()');await finish(f);}
});
