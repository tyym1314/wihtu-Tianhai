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
if(!['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname))throw Error('LOCAL_POSTGRES_REQUIRED');
const previous={database:process.env.OASIS_DATABASE_URL,local:process.env.OASIS_LOCAL_DIR};
before(async()=>{
 admin=new pg.Pool({connectionString:adminUrl.toString(),max:2});await admin.query(`CREATE DATABASE "${name}"`);created=true;
 localDir=await mkdtemp(join(tmpdir(),'oasis-run-inputs-'));process.env.OASIS_DATABASE_URL=dbUrl.toString();process.env.OASIS_LOCAL_DIR=localDir;
 ({pool,closePools}=await import('../server/db.mjs'));
 assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
 await(await import('../server/platform.mjs')).migratePlatform();const pvp=await import('../server/pvp/index.mjs');await pvp.migratePvp();({routePvp}=pvp);
});
after(async()=>{try{await closeEnginePool();await closePools?.();if(created)await dropOwnedTestDatabase(admin,name,{created});}finally{await admin?.end();if(localDir)await rm(localDir,{recursive:true,force:true});for(const[k,v]of[['OASIS_DATABASE_URL',previous.database],['OASIS_LOCAL_DIR',previous.local]])if(v===undefined)delete process.env[k];else process.env[k]=v;}});

const seed='0000000400000000000000000000000000000000000000000000000000000000';
async function fixture(game='run'){
 const session={app_id:uid('course_app'),game_id:game,external_user_id:'human'},now=1000000;
 await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url,game_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[session.app_id,'course integration','test_partner','sandbox','test_scope','https://no-wallet.invalid',JSON.stringify([game])]);
 return {now,session,call:(method,path,body={},time=now)=>routePvp(session,method,path,method==='POST'?{request_id:uid('course_req'),...body}:body,{now:time})};
}
const create=(f,body={})=>f.call('POST','/api/pvp/rooms',{game_id:f.session.game_id,capacity:2,practice:true,entry_minor:'0',...body});
const read=async id=>(await pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[id])).rows[0];

test('server confirms beginner course before ready for old/new clients, creates no wallet operation',async()=>{
 for(const protocol of [undefined,RUN_PRACTICE_INPUT_PROTOCOL]){
  const f=await fixture(),waiting=(await create(f,protocol?{run_input_protocol:protocol}:{})).body;
  assert.equal(waiting.status,'waiting');assert.equal(waiting.game,null);assert.equal(waiting.run_course.id,'sunrise-arches');assert.equal(waiting.run_course.difficulty,1);
  const saved=await read(waiting.id);assert.deepEqual(saved.game_options,{run_course_policy:'run-practice-course-v1',run_course_id:'sunrise-arches'});
  const ready=(await f.call('POST',`/api/pvp/rooms/${waiting.id}/ready`)).body;
  assert.equal(ready.game.courseId,waiting.run_course.id);assert.equal(ready.game.ruleVersion,protocol?'pvp-run-v2.3.0':'pvp-run-v2.2.0');
  assert.equal((await pool.query('SELECT 1 FROM pvp_operations WHERE room_id=$1',[waiting.id])).rowCount,0);
 }
});
test('legacy practice stake normalization still creates a zero-entry beginner room',async()=>{
 const f=await fixture(),r=(await create(f,{entry_minor:'1000'})).body;assert.equal(r.entry_minor,'0');assert.equal(r.run_course.id,'sunrise-arches');assert.equal((await read(r.id)).game_options.run_course_id,'sunrise-arches');
});
test('all six explicit courses stay pinned across ready, scene-ready, worker advance and idempotent replay',async()=>{
 const {RUN_COURSES_V21}=await import('../arena/run/courses.mjs');
 for(const c of RUN_COURSES_V21){
  const f=await fixture(),request={request_id:uid('course_once'),run_course_id:c.id,run_input_protocol:RUN_PRACTICE_INPUT_PROTOCOL};
  const created=await create(f,request),waiting=created.body,path='/api/pvp/rooms/'+waiting.id;
  assert.equal(waiting.run_course.id,c.id);assert.equal(waiting.run_course.difficulty,c.difficulty);assert.deepEqual(await create(f,request),created);
  await assert.rejects(create(f,{...request,run_course_id:c.id==='sunrise-arches'?'rapid-bridges':'sunrise-arches'}),{code:'IDEMPOTENCY_CONFLICT'});
  const ready=(await f.call('POST',path+'/ready')).body;assert.equal(ready.game.courseId,c.id);
  const running=(await f.call('POST',path+'/scene-ready')).body;assert.equal(running.game.phase,'racing');assert.equal(running.game.courseId,c.id);
  const advanced=(await f.call('GET',path,{},f.now+1000)).body;assert.equal(advanced.game.courseId,c.id);assert.equal(advanced.game.contentVersion,c.contentVersion);
  assert.deepEqual((await read(waiting.id)).game_options,{run_course_policy:'run-practice-course-v1',run_course_id:c.id});
 }
});
test('old waiting and active rooms without a stored strategy retain their original seed route',async()=>{
 const {seal}=await import('../server/security.mjs');
 for(const protocol of [undefined,RUN_PRACTICE_INPUT_PROTOCOL]){
  const f=await fixture(),waiting=(await create(f,protocol?{run_input_protocol:protocol}:{})).body,path='/api/pvp/rooms/'+waiting.id;
  // A persisted pre-policy waiting room, with known original entropy.
  await pool.query("UPDATE pvp_rooms SET game_options='{}',seed_enc=$2 WHERE id=$1",[waiting.id,seal(seed)]);
  const old=(await f.call('GET',path)).body;assert.equal(old.run_course,undefined);
  const ready=(await f.call('POST',path+'/ready')).body;assert.equal(ready.game.courseId,'rapid-bridges');assert.equal(ready.run_course,undefined);
  await f.call('POST',path+'/scene-ready');const current=(await f.call('GET',path,{},f.now+1000)).body;
  assert.equal(current.game.courseId,'rapid-bridges');assert.equal(current.run_course,undefined);assert.deepEqual((await read(waiting.id)).game_options,{});
 }
});
test('unknown courses and unauthorized selection reject before room/active-user writes',async()=>{
 const f=await fixture();
 for(const body of [{run_course_id:'unknown'},{run_course_id:null},{run_course_policy:'run-practice-course-v1'},{run_difficulty:3}])await assert.rejects(create(f,body),{code:'INVALID_RUN_COURSE'});
 for(const body of [{practice:false,entry_minor:'1000'},{practice:true,entry_minor:'1000'}])await assert.rejects(create(f,{...body,run_course_id:'sunrise-arches'}),{code:'INVALID_RUN_COURSE_MODE'});
 const other=await fixture('match');await assert.rejects(create(other,{run_course_id:'sunrise-arches'}),{code:'INVALID_RUN_COURSE_MODE'});
 for(const owner of [f,other])assert.equal((await pool.query('SELECT 1 FROM pvp_rooms WHERE app_id=$1',[owner.session.app_id])).rowCount,0);
});
