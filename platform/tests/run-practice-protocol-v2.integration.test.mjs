import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {RUN_PRACTICE_PROFILES as P} from '../shared/run-practice-profiles.mjs';
import {closeEnginePool} from '../server/pvp/engine-pool.mjs';
let pool,closePools,routePvp,admin,localDir,created=false,protocol;
const uid=p=>p+'_'+randomBytes(8).toString('hex');
const name='oasis_pvp_test_'+process.pid+'_'+randomBytes(8).toString('hex');
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
assert(['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname),'ISOLATED_LOCAL_POSTGRES_REQUIRED');adminUrl.pathname='/postgres';
const dbUrl=new URL(adminUrl);dbUrl.pathname='/'+name;
const previous={database:process.env.OASIS_DATABASE_URL,local:process.env.OASIS_LOCAL_DIR};
before(async()=>{
 admin=new pg.Pool({connectionString:adminUrl.href,max:2});await admin.query(`CREATE DATABASE "${name}"`);created=true;
 localDir=await mkdtemp(join(tmpdir(),'oasis-run-v2-inputs-'));process.env.OASIS_DATABASE_URL=dbUrl.href;process.env.OASIS_LOCAL_DIR=localDir;
 ({pool,closePools}=await import('../server/db.mjs'));assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
 await(await import('../server/platform.mjs')).migratePlatform();const pvp=await import('../server/pvp/index.mjs');await pvp.migratePvp();({routePvp}=pvp);
 protocol=await import('../server/pvp/run-practice-protocol.mjs');
});
after(async()=>{try{await closeEnginePool();await closePools?.();if(created)await dropOwnedTestDatabase(admin,name,{created});}finally{await admin?.end();if(localDir)await rm(localDir,{recursive:true,force:true});for(const[k,v]of[['OASIS_DATABASE_URL',previous.database],['OASIS_LOCAL_DIR',previous.local]])if(v===undefined)delete process.env[k];else process.env[k]=v;}});
const read=async id=>(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];
const receipts=async id=>(await pool.query('SELECT * FROM pvp_run_input_decisions WHERE room_id=$1 ORDER BY command_seq',[id])).rows;
const command=(commandSeq,type,executeTick)=>({commandSeq,type,executeTick});
async function fixture({capacity=4,profile=P.v2,course='canal-crossing'}={}){
 const session={app_id:uid('run_app'),game_id:'run',external_user_id:'human'},now=1000000;
 await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[session.app_id,'run v2 integration','test_partner','sandbox','test_scope','https://no-wallet.invalid','["run"]']);
 const call=(method,path,body={},time=now)=>routePvp(session,method,path,method==='POST'?{request_id:uid('run_req'),...body}:body,{now:time});
 const room=(await call('POST','/api/pvp/rooms',{game_id:'run',capacity,practice:true,run_course_id:course,...(profile?{run_input_protocol:profile.protocol,...(profile.profileId?{run_input_profile:profile.profileId}:{})}:{})})).body;
 const path='/api/pvp/rooms/'+room.id;
 const ready=(await call('POST',path+'/ready')).body;assert.equal(ready.game.phase,'arming');assert.equal(ready.run_inputs,undefined);
 const start=(await call('POST',path+'/scene-ready')).body;
 const payload=(commands,authority=start.run_inputs)=>({roomId:room.id,playerKey:'human',clockEpoch:authority.clockEpoch,baseRevision:authority.revision,commands});
 return {session,now,room,start,path,call,payload};
}

test('new tuple is confirmed while waiting, 1–3BOT profiles are walletless, old clients still create original rooms',async()=>{
 for(const capacity of [2,3,4]){
  const f=await fixture({capacity});assert.deepEqual(f.room.run_input_profile,{rule_version:P.v2.ruleVersion,protocol:P.v2.protocol,profile_id:P.v2.profileId});
  assert.equal(f.start.game.ruleVersion,P.v2.ruleVersion);assert.equal(f.start.run_inputs.profileId,P.v2.profileId);assert.equal(f.start.run_inputs.protocol,P.v2.protocol);
  assert.deepEqual(f.start.run_inputs.committedOwnEvents,[]);assert.equal(f.start.players.filter(p=>p.bot).length,capacity-1);
  const stored=await read(f.room.id);assert.equal(stored.terms.run_input_profile,P.v2.profileId);assert.equal(stored.terms.run_input_protocol,P.v2.protocol);
  assert.equal((await pool.query('SELECT 1 FROM pvp_operations WHERE room_id=$1',[f.room.id])).rowCount,0);
 }
 for(const profile of [P.v1,null]){const f=await fixture({profile});assert.equal(f.start.game.ruleVersion,profile?P.v1.ruleVersion:'pvp-run-v2.2.0');assert.equal(f.start.run_inputs?.profileId,undefined);if(profile)assert.equal(f.start.run_inputs.protocol,P.v1.protocol);}
});

test('paid, nonpractice, other game, missing or mixed tuple opt-ins reject before creating records',async()=>{
 const f=await fixture();await f.call('POST',f.path+'/leave');
 const base={game_id:'run',capacity:2,practice:true,run_input_protocol:P.v2.protocol,run_input_profile:P.v2.profileId};
 for(const bad of [{...base,practice:false,entry_minor:'1000'},{...base,entry_minor:'1000'},{...base,run_input_profile:undefined},{...base,run_input_protocol:P.v1.protocol},{...base,run_input_protocol:undefined},{...base,run_input_profile:'free-bot-999-v1'}])await assert.rejects(f.call('POST','/api/pvp/rooms',bad),{code:'INVALID_INPUT_PROTOCOL'});
 const before=(await pool.query('SELECT count(*) AS count FROM pvp_rooms WHERE app_id=$1',[f.session.app_id])).rows[0].count;
 assert.equal(before,'1');
 const other={...f.session,game_id:'ludo'};await assert.rejects(routePvp(other,'POST','/api/pvp/rooms',{request_id:uid('other'),...base,game_id:'ludo'},{now:f.now}),{code:'INVALID_INPUT_PROTOCOL'});
});

test('every new stored room/terms/roster/envelope binding fails closed, never falls back to ordinary engine or wallet',async()=>{
 const f=await fixture(),original=await read(f.room.id);
 const mutations=[r=>{r.entry_minor='1000';},r=>{r.fee_bps=500;},r=>{r.practice=false;},r=>{r.terms.entry_minor='1000';},r=>{r.terms.fee_bps=500;},r=>{r.terms.run_input_profile='wrong';},r=>{delete r.terms.run_input_protocol;},r=>{r.terms.rule_version=P.v1.ruleVersion;},r=>{r.capacity=3;},r=>{r.terms.player_count=2;},r=>{r.players[1].bot=false;},r=>{r.players[1].seat_index=0;},r=>{r.run_input_state.protocol=P.v1.protocol;},r=>{r.run_input_state.feeBps=500;},r=>{r.run_input_state.profileId='wrong';},r=>{r.rule_version=P.v1.ruleVersion;},r=>{r.run_input_state=null;},r=>{r.run_input_state.anchor.practiceOwnEvents=null;},r=>{r.run_input_state.current.practiceOwnEvents=[{id:1,type:'fall',tick:0,at:0,playerKey:'bot_other'}];}];
 for(const mutate of mutations){const r=structuredClone(original);mutate(r);
  await pool.query('UPDATE pvp_rooms SET entry_minor=$2,fee_bps=$3,practice=$4,terms=$5,capacity=$6,players=$7,run_input_state=$8,rule_version=$9 WHERE id=$1',[r.id,r.entry_minor,r.fee_bps,r.practice,r.terms,r.capacity,JSON.stringify(r.players),r.run_input_state,r.rule_version]);
  try{await assert.rejects(f.call('GET',f.path,{},f.now+100),{code:'INVALID_PRACTICE_SCOPE'});assert.equal((await receipts(f.room.id)).length,0);assert.equal((await pool.query('SELECT 1 FROM pvp_operations WHERE room_id=$1',[f.room.id])).rowCount,0);}
  finally{await pool.query('UPDATE pvp_rooms SET entry_minor=$2,fee_bps=$3,practice=$4,terms=$5,capacity=$6,players=$7,run_input_state=$8,rule_version=$9 WHERE id=$1',[original.id,original.entry_minor,original.fee_bps,original.practice,original.terms,original.capacity,JSON.stringify(original.players),original.run_input_state,original.rule_version]);}
 }
});

test('359-tick late real fall repair persists exact durable decisions and retries without readmitting a command',async()=>{
 const f=await fixture();let old=(await f.call('GET',f.path,{},f.now+4000)).body;
 const head=(await f.call('GET',f.path,{},f.now+10000)).body;
 // Keep the existing >5s recovery policy: a6s coordinator gap rotates epoch.
 assert.equal(head.run_inputs.clockEpoch,2);assert.equal(head.run_inputs.headTick,old.run_inputs.headTick);
 const f2=await fixture();old=(await f2.call('GET',f2.path,{},f2.now+4000)).body;
 await f2.call('GET',f2.path,{},f2.now+8000);const late=(await f2.call('GET',f2.path,{},f2.now+10000)).body;
 assert.equal(late.run_inputs.headTick,600);assert.ok(late.game.players[0].hits>0);
 const commands=[command(1,'jump',241),command(2,'jump',240),command(3,'jump',602)],request={request_id:uid('lost_ack'),...f2.payload(commands,old.run_inputs)};
 const corrected=(await f2.call('POST',f2.path+'/inputs',request,f2.now+10000)).body;
 assert.deepEqual(corrected.run_inputs.decisions.map(d=>d.code),[null,'INPUT_EXPIRED','FUTURE_INPUT']);assert.equal(corrected.run_inputs.acceptedInputNo,1);assert.equal(corrected.run_inputs.correction.fromTick,241);
 assert.deepEqual((await f2.call('POST',f2.path+'/inputs',request,f2.now+11000)).body,corrected);
 const retried=(await f2.call('POST',f2.path+'/inputs',f2.payload(commands,corrected.run_inputs),f2.now+11000)).body;
 assert.ok(retried.run_inputs.decisions.every(d=>d.duplicate));assert.equal((await receipts(f2.room.id)).length,3);
 const saved=await read(f2.room.id);assert.equal(saved.run_input_state.durableThrough,3);assert.deepEqual(saved.run_input_state.decisions,[]);
});

test('failure after real ledger inserts and room save rolls back input, response and decision atomically',async()=>{
 const f=await fixture(),requestId=uid('rollback_v2');await f.call('GET',f.path,{},f.now+2000);const baseline=await read(f.room.id);
 const request={request_id:requestId,...f.payload([command(1,'jump',1)],protocol.runInputAuthority(baseline))};
 await pool.query(`CREATE FUNCTION refuse_v2_response() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${requestId}' THEN RAISE EXCEPTION 'injected v2 response failure'; END IF; RETURN NEW; END $$`);
 await pool.query('CREATE TRIGGER refuse_v2_response BEFORE INSERT ON pvp_requests FOR EACH ROW EXECUTE FUNCTION refuse_v2_response()');
 try{await assert.rejects(f.call('POST',f.path+'/inputs',request,f.now+2000),/injected v2 response failure/);}finally{await pool.query('DROP TRIGGER refuse_v2_response ON pvp_requests');await pool.query('DROP FUNCTION refuse_v2_response()');}
 const stored=await read(f.room.id);assert.deepEqual(stored.run_input_state,baseline.run_input_state);assert.deepEqual(stored.game_state,baseline.game_state);assert.equal((await receipts(f.room.id)).length,0);
 assert.equal((await pool.query('SELECT 1 FROM pvp_requests WHERE request_id=$1',[requestId])).rowCount,0);
 assert.equal((await f.call('POST',f.path+'/inputs',request,f.now+2000)).body.run_inputs.acceptedInputNo,1);
});

test('a new server process reads JSONB-pinned v2 history and durable old receipts after restart',async()=>{
 const f=await fixture(),one=command(1,'right',1),first=(await f.call('POST',f.path+'/inputs',f.payload([one]),f.now+1000)).body;
 const source=`import {migratePvp,routePvp} from './server/pvp/index.mjs';import {closePools} from './server/db.mjs';import {closeEnginePool} from './server/pvp/engine-pool.mjs';try{await migratePvp();const r=await routePvp(${JSON.stringify(f.session)},'POST',${JSON.stringify(f.path+'/inputs')},${JSON.stringify({request_id:uid('restart_v2'),...f.payload([one],first.run_inputs)})},{now:${f.now+1100}});console.log(JSON.stringify(r.body.run_inputs));}finally{await closeEnginePool();await closePools();}`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{cwd:new URL('../',import.meta.url),env:{...process.env},stdio:['ignore','pipe','pipe']});let out='',error='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>error+=b);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,error);
 const restored=JSON.parse(out.trim());assert.equal(restored.profileId,P.v2.profileId);assert.equal(restored.processedThroughCommandSeq,1);assert.equal(restored.acceptedInputNo,1);assert.equal(restored.decisions[0].duplicate,true);assert.equal((await receipts(f.room.id)).length,1);
});

test('committed actual own falls remain available and provisional terminal never exposes result or payouts',async()=>{
 const f=await fixture();let latest=f.start,sawProvisional=false,sawFall=false;
 for(let delta=1000;delta<=106000;delta+=1000){latest=(await f.call('GET',f.path,{},f.now+delta)).body;
  const a=latest.run_inputs;assert.ok(a.committedOwnEvents.length<=256);assert.ok(a.committedOwnEvents.every(event=>event.playerKey==='human'&&event.tick<=a.committedThroughTick));
  sawFall||=a.committedOwnEvents.some(event=>event.type==='fall');
  if(latest.game.status==='finished'&&!latest.result){sawProvisional=true;assert.equal(a.resultAuthorization,null);assert.deepEqual(latest.game.winnerKeys,[]);assert.equal(latest.game.resultCommitted,false);}
  if(latest.result)break;
 }
 assert.ok(sawFall);assert.ok(sawProvisional);assert.equal(latest.status,'settled');assert.ok(latest.run_inputs.resultAuthorization);
 const saved=await read(f.room.id);assert.equal(saved.result.pool_minor,'0');assert.equal(saved.result.fee_minor,'0');assert.ok(saved.result.payouts.every(p=>p.payout_minor==='0'));
 const result=latest.result;assert.deepEqual((await f.call('GET',f.path,{},f.now+120000)).body.result,result);
 assert.equal((await pool.query('SELECT 1 FROM pvp_operations WHERE room_id=$1',[f.room.id])).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM pvp_active_users WHERE room_id=$1',[f.room.id])).rowCount,0);
});
