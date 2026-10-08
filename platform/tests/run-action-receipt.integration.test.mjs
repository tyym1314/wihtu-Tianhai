// Real PostgreSQL + production PvP route/worker in a disposable database.
// Authenticated-session inputs and server clocks are controlled fixtures; this
// does not claim HTTP middleware, public network or physical-device acceptance.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {executeEngineTask} from '../server/pvp/engine-worker.mjs';
import {runRequiresSceneReady} from '../arena/run/start-policy.mjs';
import {readRunActionReceipt} from '../shared/run-action-receipt.mjs';
const uid=prefix=>prefix+'_'+randomBytes(8).toString('hex');
const databaseName='oasis_pvp_test_'+process.pid+'_'+randomBytes(8).toString('hex');
const adminURL=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres'),databaseURL=new URL(adminURL);databaseURL.pathname='/'+databaseName;
const prior={database:process.env.OASIS_DATABASE_URL,local:process.env.OASIS_LOCAL_DIR};
let admin,pool,closePools,closeEnginePool,routePvp,tickPvp,created=false,localDir;
before(async()=>{
 assert.ok(['127.0.0.1','localhost','[::1]'].includes(adminURL.hostname));
 admin=new pg.Pool({connectionString:adminURL.href});await admin.query(`CREATE DATABASE "${databaseName}"`);created=true;
 localDir=await mkdtemp(join(tmpdir(),'oasis-run-receipts-'));
 process.env.OASIS_DATABASE_URL=databaseURL.href;process.env.OASIS_LOCAL_DIR=localDir;
 ({pool,closePools}=await import('../server/db.mjs'));assert.equal((await pool.query('SELECT current_database() n')).rows[0].n,databaseName);
 await(await import('../server/platform.mjs')).migratePlatform();
 const pvp=await import('../server/pvp/index.mjs');await pvp.migratePvp(pool);({routePvp,tickPvp}=pvp);
 ({closeEnginePool}=await import('../server/pvp/engine-pool.mjs'));
 console.log('[run receipt isolation] created '+databaseName+'; actual pool verified');
});
after(async()=>{
 try{await closeEnginePool?.();await closePools?.();if(created){await dropOwnedTestDatabase(admin,databaseName,{created});console.log('[run receipt isolation] dropped '+databaseName+'; verified absent');}}
 finally{await admin?.end();if(localDir)await rm(localDir,{recursive:true,force:true});for(const [key,value]of [['OASIS_DATABASE_URL',prior.database],['OASIS_LOCAL_DIR',prior.local]])if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
const read=async id=>(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];
const call=(session,verb,id,body,now)=>routePvp(session,'POST',id?`/api/pvp/rooms/${id}/${verb}`:'/api/pvp/rooms',{request_id:uid('request'),...body},{now,skipGap:true});
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
const stateHash=state=>createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');
async function fixture(ruleVersion){
 const appId=uid('receipt_app');
 await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',
  [appId,'Run receipt isolated fixture',uid('partner'),'sandbox',uid('scope'),'https://unused-wallet.invalid',JSON.stringify(['run'])]);
 const session={app_id:appId,external_user_id:uid('human'),game_id:'run'},start=Date.now()+100;
 const room=(await call(session,null,null,{game_id:'run',capacity:2,practice:true},start)).body;
 // Historical fixtures predate the persisted Run course policy; keep that original absence.
 if(ruleVersion!==room.game?.ruleVersion)await pool.query("UPDATE pvp_rooms SET game_options=game_options-'run_course_policy'-'run_course_id',rule_version=$2,terms=jsonb_set(terms,'{rule_version}',to_jsonb($2::text)) WHERE id=$1",[room.id,ruleVersion]);
 await call(session,'ready',room.id,{},start+1);await tickPvp({roomIds:[room.id],now:start+2,skipGap:true});
 if(runRequiresSceneReady(ruleVersion))await call(session,'scene-ready',room.id,{},start+3);
 const row=await read(room.id),now=Math.max(Number(row.last_tick_at),row.game_state.startedAt)+1;
 return{session,id:room.id,now};
}
async function cleanup(f){
 const row=await read(f.id);await call(f.session,'leave',f.id,{},Math.max(Number(row.last_tick_at)+1,Date.now()));
 assert.equal((await read(f.id)).status,'cancelled');
 assert.equal((await pool.query('SELECT 1 FROM pvp_active_users WHERE room_id=$1',[f.id])).rowCount,0);
 assert.equal((await pool.query('SELECT 1 FROM pvp_operations WHERE room_id=$1',[f.id])).rowCount,0);
}
for(const ruleVersion of ['pvp-run-v1.0.0','pvp-run-v2.0.0','pvp-run-v2.1.0','pvp-run-v2.2.0'])test(`Run ${ruleVersion} POST-only receipt is durable and changes no authoritative computation`,async()=>{
 const f=await fixture(ruleVersion);
 try{
  const before=await read(f.id),body={request_id:uid('jump'),seq:1,action:{type:'jump'}};
  const advanced=executeEngineTask({kind:'advance',gameId:'run',ruleVersion,state:structuredClone(before.game_state),now:f.now,forfeits:[],
   bots:before.players.filter(p=>p.bot).map(p=>({key:p.external_user_id,lastBotAt:p.last_bot_at||0}))});
  const computed=executeEngineTask({kind:'act',gameId:'run',ruleVersion,state:advanced.state,playerKey:f.session.external_user_id,action:body.action,now:f.now});
  const response=await call(f.session,'action',f.id,body,f.now),receipt=response.body.action_receipt;
  assert.equal(response.status,200);assert.deepEqual(receipt,{roomId:f.id,playerKey:f.session.external_user_id,request_id:body.request_id,
   seq:1,type:'jump',inputNo:computed.event.inputNo,acceptedTick:computed.event.acceptedTick,ruleVersion});
  assert.deepEqual(readRunActionReceipt(response.body,{...receipt}),receipt);
  const saved=await read(f.id),mine=saved.game_state.players.find(p=>p.key===f.session.external_user_id);
  assert.equal(stateHash(saved.game_state),stateHash(computed.state),'receipt path adds no tick, move, collision or bot action');
  assert.equal(mine.pendingInput.no,receipt.inputNo);assert.equal(mine.jumpStartTick,null);assert.equal(mine.appliedInputNo,0);
  assert.equal(response.body.game.snapshotTick+1,receipt.acceptedTick);
  assert.equal(Object.hasOwn(response.body.game.players.find(p=>p.key===f.session.external_user_id),'pendingInput'),false);
  assert.deepEqual(saved.players.find(p=>p.external_user_id===f.session.external_user_id).last_event,computed.event);
  const audit=(await pool.query('SELECT action,event FROM pvp_actions WHERE room_id=$1',[f.id])).rows;
  assert.deepEqual(audit,[{action:body.action,event:computed.event}]);
  assert.deepEqual((await pool.query('SELECT response FROM pvp_requests WHERE request_id=$1',[body.request_id])).rows[0].response,response.body);
  const replays=await Promise.all(Array.from({length:3},()=>call(f.session,'action',f.id,body,f.now+1000)));
  for(const replay of replays)assert.deepEqual(replay,response);
  const afterReplay=await read(f.id);assert.equal(stateHash(afterReplay.game_state),stateHash(saved.game_state));assert.equal(afterReplay.version,saved.version);
  const get=await routePvp(f.session,'GET',`/api/pvp/rooms/${f.id}`);
  assert.equal(get.body.action_receipt,undefined);assert.equal(readRunActionReceipt(get.body,receipt),null);
  assert.equal(get.body.game.lastAcceptedInput,undefined);assert.equal(stateHash((await read(f.id)).game_state),stateHash(saved.game_state));
  const other={...f.session,external_user_id:saved.players.find(p=>p.bot).external_user_id};
  const otherView=await routePvp(other,'GET',`/api/pvp/rooms/${f.id}`);assert.equal(otherView.body.action_receipt,undefined);
  assert.equal(otherView.body.me,other.external_user_id);assert.equal(readRunActionReceipt(otherView.body,receipt),null);
  await assert.rejects(call(f.session,'action',f.id,{...body,action:{type:'slide'}},f.now),{code:'IDEMPOTENCY_CONFLICT'});
  const rejectedId=uid('rejected');await assert.rejects(call(f.session,'action',f.id,{request_id:rejectedId,seq:2,action:{type:'slide'}},f.now),error=>{
   assert.equal(error.action_receipt,undefined);return error.code==='INPUT_PENDING';
  });
  assert.equal((await pool.query('SELECT 1 FROM pvp_requests WHERE request_id=$1',[rejectedId])).rowCount,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM pvp_actions WHERE room_id=$1',[f.id])).rows[0].n,1);
  const beforeTick=await read(f.id),nextNow=f.now+100;
  const expectedTick=executeEngineTask({kind:'advance',gameId:'run',ruleVersion,state:structuredClone(beforeTick.game_state),now:nextNow,forfeits:[],
   bots:beforeTick.players.filter(p=>p.bot).map(p=>({key:p.external_user_id,lastBotAt:p.last_bot_at||0}))});
  await tickPvp({roomIds:[f.id],now:nextNow,skipGap:true});const ticked=await read(f.id);
  assert.equal(stateHash(ticked.game_state),stateHash(expectedTick.state));
  assert.equal(ticked.game_state.players.find(p=>p.key===f.session.external_user_id).appliedInputNo,receipt.inputNo);
  const updated=await routePvp(f.session,'GET',`/api/pvp/rooms/${f.id}`);assert.equal(updated.body.action_receipt,undefined);
  assert.deepEqual(await call(f.session,'action',f.id,body,nextNow),response,'older ACK stays bound to its original receipt after newer GET');
 }finally{await cleanup(f);}
});
test('historical successful ledger response without receipt replays unchanged after module reload',async()=>{
 const f=await fixture('pvp-run-v2.2.0');
 try{
  const body={request_id:uid('legacy_ack'),seq:1,action:{type:'jump'}},first=await call(f.session,'action',f.id,body,f.now);
  const historical=structuredClone(first.body);delete historical.action_receipt;
  await pool.query('UPDATE pvp_requests SET response=$2 WHERE request_id=$1',[body.request_id,historical]);
  const before=await read(f.id),reloaded=await import('../server/pvp/index.mjs?receipt='+uid('reload'));await reloaded.migratePvp(pool);
  const replay=await reloaded.routePvp(f.session,'POST',`/api/pvp/rooms/${f.id}/action`,body,{now:f.now+1000,skipGap:true});
  assert.deepEqual(replay.body,historical);assert.equal(replay.body.action_receipt,undefined);
  assert.equal(readRunActionReceipt(replay.body,{roomId:f.id,playerKey:f.session.external_user_id,...body,type:'jump',ruleVersion:'pvp-run-v2.2.0'}),null);
  assert.equal(stateHash((await read(f.id)).game_state),stateHash(before.game_state));
 }finally{await cleanup(f);}
});
