import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {RUN_PRACTICE_INPUT_PROTOCOL} from '../server/pvp/run-practice-inputs.mjs';
import {closeEnginePool} from '../server/pvp/engine-pool.mjs';
let pool,closePools,routePvp,admin,localDir,created=false;
const uid=p=>p+'_'+randomBytes(8).toString('hex');
const name='oasis_pvp_test_'+process.pid+'_'+randomBytes(8).toString('hex');
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres'),dbUrl=new URL(adminUrl);dbUrl.pathname='/'+name;
const previous={database:process.env.OASIS_DATABASE_URL,local:process.env.OASIS_LOCAL_DIR};
before(async()=>{
 admin=new pg.Pool({connectionString:adminUrl.toString(),max:2});await admin.query(`CREATE DATABASE "${name}"`);created=true;
 localDir=await mkdtemp(join(tmpdir(),'oasis-run-inputs-'));process.env.OASIS_DATABASE_URL=dbUrl.toString();process.env.OASIS_LOCAL_DIR=localDir;
 ({pool,closePools}=await import('../server/db.mjs'));
 assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
 await(await import('../server/platform.mjs')).migratePlatform();const pvp=await import('../server/pvp/index.mjs');await pvp.migratePvp();({routePvp}=pvp);
});
after(async()=>{try{await closeEnginePool();await closePools?.();if(created)await dropOwnedTestDatabase(admin,name,{created});}finally{await admin?.end();if(localDir)await rm(localDir,{recursive:true,force:true});for(const[k,v]of[['OASIS_DATABASE_URL',previous.database],['OASIS_LOCAL_DIR',previous.local]])if(v===undefined)delete process.env[k];else process.env[k]=v;}});
async function fixture(){
 const session={app_id:uid('run_app'),game_id:'run',external_user_id:'human'},now=1000000;
 await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[session.app_id,'run input integration','test_partner','sandbox','test_scope','https://no-wallet.invalid','["run"]']);
 const call=(method,path,body={},time=now)=>routePvp(session,method,path,method==='POST'?{request_id:uid('run_req'),...body}:body,{now:time});
 const room=(await call('POST','/api/pvp/rooms',{game_id:'run',capacity:2,practice:true,run_input_protocol:RUN_PRACTICE_INPUT_PROTOCOL})).body;
 const path='/api/pvp/rooms/'+room.id;
 const ready=(await call('POST',path+'/ready')).body;assert.equal(ready.game.phase,'arming');assert.equal(ready.run_inputs,undefined);
 const start=(await call('POST',path+'/scene-ready')).body;
 const payload=(commands,authority=start.run_inputs)=>({roomId:room.id,playerKey:'human',clockEpoch:authority.clockEpoch,baseRevision:authority.revision,commands});
 return {session,now,room,start,path,call,payload};
}
const read=async id=>(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];
const receipts=async id=>(await pool.query('SELECT * FROM pvp_run_input_decisions WHERE room_id=$1 ORDER BY command_seq',[id])).rows;

test('opt-in alone selects 2.3; scene ACK creates private history, no wallet or old action admission',async()=>{
 const f=await fixture();assert.equal(f.start.game.ruleVersion,'pvp-run-v2.3.0');assert.equal(f.start.run_inputs.clockEpoch,1);
 assert.equal(f.start.run_inputs.headTick,0);assert.equal(f.start.game.resultCommitted,false);
 assert.equal(JSON.stringify(f.start).includes('integrity'),false);assert.equal(JSON.stringify(f.start).includes('"anchor":'),false);
 assert.deepEqual(Object.keys(f.start.run_inputs.selfReplay).sort(),['acceptedCommands','anchorTick','player','schema']);
 assert.equal(f.start.run_inputs.selfReplay.player.key,'human');assert.equal(f.start.run_inputs.selfReplay.player.isBot,undefined);
 await assert.rejects(f.call('POST',f.path+'/action',{seq:1,action:{type:'jump'}}),{code:'INPUT_PROTOCOL_REQUIRED'});
 assert.equal((await pool.query('SELECT count(*) FROM pvp_operations WHERE room_id=$1',[f.room.id])).rows[0].count,'0');
 const old=await f.call('POST',f.path+'/leave');assert.equal(old.body.status,'cancelled');
 const normal=(await f.call('POST','/api/pvp/rooms',{game_id:'run',capacity:2,practice:true})).body;
 assert.equal((await read(normal.id)).rule_version,'pvp-run-v2.2.0');
 await assert.rejects(f.call('POST','/api/pvp/rooms',{game_id:'run',capacity:2,practice:false,entry_minor:'1000',run_input_protocol:RUN_PRACTICE_INPUT_PROTOCOL}),{code:'INVALID_INPUT_PROTOCOL'});
});
test('accepted and rejected commands persist atomically, duplicate prefix is replayed from durable receipts',async()=>{
 const f=await fixture(),commands=[{commandSeq:1,type:'jump',executeTick:1},{commandSeq:2,type:'slide',executeTick:7}];
 const request={request_id:uid('exact_retry'),...f.payload(commands)};
 const a=(await f.call('POST',f.path+'/inputs',request,f.now+300)).body;
 assert.equal(a.run_inputs.processedThroughCommandSeq,2);assert.equal(a.run_inputs.acceptedInputNo,1);
 assert.deepEqual(a.run_inputs.decisions.map(d=>d.outcome),['accepted','rejected']);assert.equal(a.run_inputs.decisions[1].code,'AIRBORNE');
 const saved=await read(f.room.id);assert.equal(saved.run_input_state.decisions.length,0);assert.equal(saved.run_input_state.durableThrough,2);
 assert.equal((await receipts(f.room.id)).length,2);
 assert.deepEqual((await f.call('POST',f.path+'/inputs',request,f.now+600)).body,a);
 const duplicate=(await f.call('POST',f.path+'/inputs',f.payload(commands),f.now+700)).body;
 assert.equal(duplicate.run_inputs.decisions.every(d=>d.duplicate),true);assert.equal(duplicate.run_inputs.acceptedInputNo,1);
 assert.equal((await receipts(f.room.id)).length,2);
 const conflict=f.payload([{...commands[1],type:'right'},{commandSeq:3,type:'left',executeTick:40}],duplicate.run_inputs);
 await assert.rejects(f.call('POST',f.path+'/inputs',conflict,f.now+700),{code:'COMMAND_CONFLICT'});
 assert.equal((await read(f.room.id)).run_input_state.lastCommandSeq,2);assert.equal((await receipts(f.room.id)).length,2);
});
test('failure after decision insert and room save rolls back all three durable records',async()=>{
 const f=await fixture(),requestId=uid('rollback'),request={request_id:requestId,...f.payload([{commandSeq:1,type:'jump',executeTick:1}])};
 await f.call('GET',f.path,{},f.now+100);const baseline=await read(f.room.id);
 await pool.query(`CREATE FUNCTION refuse_run_response() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${requestId}' THEN RAISE EXCEPTION 'injected response failure'; END IF; RETURN NEW; END $$`);
 await pool.query('CREATE TRIGGER refuse_run_response BEFORE INSERT ON pvp_requests FOR EACH ROW EXECUTE FUNCTION refuse_run_response()');
 try{await assert.rejects(f.call('POST',f.path+'/inputs',request,f.now+100),/injected response failure/);}
 finally{await pool.query('DROP TRIGGER refuse_run_response ON pvp_requests');await pool.query('DROP FUNCTION refuse_run_response()');}
 const saved=await read(f.room.id);assert.deepEqual(saved.run_input_state,baseline.run_input_state);assert.deepEqual(saved.game_state,baseline.game_state);
 assert.equal((await receipts(f.room.id)).length,0);
 assert.equal((await pool.query('SELECT 1 FROM pvp_requests WHERE request_id=$1',[requestId])).rowCount,0);
 const retry=(await f.call('POST',f.path+'/inputs',request,f.now+100)).body;assert.equal(retry.run_inputs.acceptedInputNo,1);assert.equal((await receipts(f.room.id)).length,1);
});
test('concurrent overlapping batches and lost ACK keep one durable command history',async()=>{
 const f=await fixture(),one={commandSeq:1,type:'jump',executeTick:1},two={commandSeq:2,type:'right',executeTick:7};
 const requests=[{request_id:uid('overlap_a'),...f.payload([one])},{request_id:uid('overlap_b'),...f.payload([one,two])}];
 const responses=await Promise.all(requests.map(body=>f.call('POST',f.path+'/inputs',body,f.now+300)));
 const saved=await read(f.room.id);assert.equal(saved.run_input_state.lastCommandSeq,2);
 assert.equal(saved.game_state.players.find(p=>p.key==='human').inputNo,2);assert.equal((await receipts(f.room.id)).length,2);
 assert.equal(responses.flatMap(r=>r.body.run_inputs.decisions).filter(d=>d.duplicate).length,1);
 for(let i=0;i<requests.length;i++)assert.deepEqual(await f.call('POST',f.path+'/inputs',requests[i],f.now+600),responses[i]);
 await assert.rejects(f.call('POST',f.path+'/inputs',{...requests[0],commands:[{...one,type:'left'}]},f.now+600),{code:'IDEMPOTENCY_CONFLICT'});
 assert.equal((await receipts(f.room.id)).length,2);
});
test('missing durable prefix rejects the entire new tail without consuming its sequence',async()=>{
 const f=await fixture(),one={commandSeq:1,type:'jump',executeTick:1};
 const a=(await f.call('POST',f.path+'/inputs',f.payload([one]),f.now+300)).body;
 await pool.query('DELETE FROM pvp_run_input_decisions WHERE room_id=$1',[f.room.id]);
 await assert.rejects(f.call('POST',f.path+'/inputs',f.payload([one,{commandSeq:2,type:'right',executeTick:7}],a.run_inputs),f.now+300),{code:'DURABLE_DECISION_MISSING'});
 assert.equal((await read(f.room.id)).run_input_state.lastCommandSeq,1);assert.equal((await read(f.room.id)).status,'active');
});
test('more than 1000 durable decisions keep bounded room history and do not exhaust the 128-decision window',async()=>{
 const f=await fixture();let authority=f.start.run_inputs;
 for(let n=0;n<1000;n+=8){
  const commands=Array.from({length:8},(_,i)=>({commandSeq:n+i+1,type:'not-an-action',executeTick:1}));
  authority=(await f.call('POST',f.path+'/inputs',f.payload(commands,authority),f.now+100)).body.run_inputs;
 }
 assert.equal(authority.processedThroughCommandSeq,1000);assert.equal(authority.acceptedInputNo,0);
 const saved=await read(f.room.id);assert.equal(saved.run_input_state.decisions.length,0);assert.equal(saved.run_input_state.durableThrough,1000);
 assert.ok(Buffer.byteLength(JSON.stringify(saved.run_input_state))<20000);assert.equal((await receipts(f.room.id)).length,1000);
 const duplicate=(await f.call('POST',f.path+'/inputs',f.payload([{commandSeq:1,type:'not-an-action',executeTick:1}]),f.now+100)).body;
 assert.equal(duplicate.run_inputs.decisions[0].duplicate,true);
});
test('shared pause rotates epoch without losing sequence or treating old pending inputs as new',async()=>{
 const f=await fixture();const first=(await f.call('POST',f.path+'/inputs',f.payload([{commandSeq:1,type:'jump',executeTick:1}]),f.now+100)).body;
 const recovered=(await f.call('GET',f.path,{},f.now+6100)).body;
 assert.equal(recovered.run_inputs.clockEpoch,2);assert.equal(recovered.run_inputs.headTick,first.run_inputs.headTick);assert.equal(recovered.run_inputs.processedThroughCommandSeq,1);
 assert.equal(recovered.starts_at,first.starts_at+6000);
 await assert.rejects(f.call('POST',f.path+'/inputs',f.payload([{commandSeq:2,type:'right',executeTick:13}],first.run_inputs),f.now+6100),{code:'STALE_CLOCK_EPOCH'});
 await assert.rejects(f.call('POST',f.path+'/inputs',f.payload([{commandSeq:1,type:'jump',executeTick:1}],recovered.run_inputs),f.now+6100),{code:'DECISION_EPOCH_MISMATCH'});
 const a=(await f.call('POST',f.path+'/inputs',f.payload([{commandSeq:2,type:'right',executeTick:13}],recovered.run_inputs),f.now+6250)).body;
 assert.equal(a.run_inputs.decisions[0].acceptedInputNo,2);
});
test('scope, malformed batches, excessive replay work and post-leave input cannot mutate command history',async()=>{
 const f=await fixture(),authority=(await f.call('GET',f.path,{},f.now+2000)).body.run_inputs;
 await assert.rejects(f.call('POST',f.path+'/inputs',{...f.payload([{commandSeq:1,type:'jump',executeTick:1}],authority),playerKey:'other'},f.now+2000),{code:'INVALID_INPUT_SCOPE'});
 await assert.rejects(routePvp({...f.session,external_user_id:'other'},'POST',f.path+'/inputs',{request_id:uid('other'),...f.payload([{commandSeq:1,type:'jump',executeTick:1}],authority)},{now:f.now+2000}),{code:'NOT_A_PLAYER'});
 await assert.rejects(f.call('POST',f.path+'/inputs',f.payload([{commandSeq:2,type:'jump',executeTick:1}],authority),f.now+2000),{code:'COMMAND_SEQUENCE_GAP'});
 const commands=[['item',119],['right',1],['item',119],['left',13],['item',119],['right',25],['item',119],['left',37]].map(([type,executeTick],i)=>({commandSeq:i+1,type,executeTick}));
 await assert.rejects(f.call('POST',f.path+'/inputs',f.payload(commands,authority),f.now+2000),e=>e.code==='WORK_BUDGET_EXCEEDED'&&e.status===422);
 assert.equal((await read(f.room.id)).status,'active');assert.equal((await receipts(f.room.id)).length,0);
 await f.call('POST',f.path+'/leave',{},f.now+2000);
 await assert.rejects(f.call('POST',f.path+'/inputs',f.payload([{commandSeq:1,type:'jump',executeTick:1}],authority),f.now+2000),{code:'NOT_ACTIVE'});
 assert.equal((await read(f.room.id)).status,'cancelled');
});
test('speculative terminal result is withheld until the rollback watermark commits it exactly once',async()=>{
 const f=await fixture();let latest=f.start,speculative=false;
 for(let delta=1000;delta<=105000;delta+=1000){
  latest=(await f.call('GET',f.path,{},f.now+delta)).body;
  if(latest.game.status==='finished'&&!latest.result){speculative=true;assert.deepEqual(latest.game.winnerKeys,[]);assert.equal(latest.run_inputs.resultAuthorization,null);assert.equal(latest.status,'active');}
  if(latest.result)break;
 }
 assert.equal(speculative,true);assert.equal(latest.status,'settled');assert.ok(latest.run_inputs.resultAuthorization);assert.equal(latest.game.resultCommitted,true);
 const result=latest.result;assert.deepEqual((await f.call('GET',f.path,{},f.now+120000)).body.result,result);
 assert.equal((await pool.query('SELECT 1 FROM pvp_active_users WHERE room_id=$1',[f.room.id])).rowCount,0);
 assert.equal((await pool.query('SELECT 1 FROM pvp_operations WHERE room_id=$1',[f.room.id])).rowCount,0);
});
test('background terminal cleanup failure rolls back settlement and later recovery releases the active slot',async()=>{
 const f=await fixture();let latest=f.start;
 for(let delta=1000;delta<=105000;delta+=1000){latest=(await f.call('GET',f.path,{},f.now+delta)).body;if(latest.game.status==='finished'&&!latest.result)break;}
 assert.equal(latest.game.status,'finished');assert.equal(latest.result,null);const before=await read(f.room.id);
 await pool.query(`CREATE FUNCTION refuse_terminal_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.room_id='${f.room.id}' THEN RAISE EXCEPTION 'injected terminal cleanup failure'; END IF; RETURN OLD; END $$`);
 await pool.query('CREATE TRIGGER refuse_terminal_cleanup BEFORE DELETE ON pvp_active_users FOR EACH ROW EXECUTE FUNCTION refuse_terminal_cleanup()');
 try{await assert.rejects(f.call('GET',f.path,{},Number(before.last_tick_at)+2200),/injected terminal cleanup failure/);}
 finally{await pool.query('DROP TRIGGER refuse_terminal_cleanup ON pvp_active_users');await pool.query('DROP FUNCTION refuse_terminal_cleanup()');}
 const failed=await read(f.room.id);assert.equal(failed.status,'active');assert.equal(failed.result,null);
 assert.equal(failed.version,before.version);assert.deepEqual(failed.run_input_state,before.run_input_state);
 assert.equal((await pool.query('SELECT 1 FROM pvp_active_users WHERE room_id=$1',[f.room.id])).rowCount,1);
 const recovered=(await f.call('GET',f.path,{},Number(before.last_tick_at)+2300)).body;
 assert.equal(recovered.status,'settled');assert.ok(recovered.result);
 assert.equal((await pool.query('SELECT 1 FROM pvp_active_users WHERE room_id=$1',[f.room.id])).rowCount,0);
 assert.equal((await f.call('POST','/api/pvp/rooms',{game_id:'run',capacity:2,practice:true},Number(before.last_tick_at)+2400)).status,201);
});
