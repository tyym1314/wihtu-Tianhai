/** Actual local PostgreSQL + official Player/PVP fixture; never production approval. */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createPlayerFixture} from '../../tests/player-hosted-fixture.mjs';
import {dropOwnedTestDatabase} from '../../tests/database-cleanup.mjs';
import {ARENA_IDS,ARENA_GAMES} from '../../shared/games.mjs';
import {RUN_PRACTICE_PROFILES} from '../../shared/run-practice-profiles.mjs';

const uid=prefix=>prefix+'_'+randomBytes(8).toString('hex');
let fixture,master,expected,databaseUrl,admin,restoredName,restoredPool,restoredCreated=false,runRoom;
let profileInspectSQL,validateProfileInspection,PRODUCTION_TABLES;
const psql=process.env.OASIS_TEST_PSQL||'psql';
function command(file,args,input,{binary=false}={}){
 const result=spawnSync(file,args,{input,encoding:binary?null:'utf8',timeout:45000,maxBuffer:8388608});
 assert.equal(result.status,0,'ISOLATED_POSTGRES_COMMAND_FAILED: '+file);
 return result.stdout;
}
function inspect(url=databaseUrl){
 const rows=command(psql,['--dbname',url.href,'-X','-qAt','-v','ON_ERROR_STOP=1'],profileInspectSQL(expected)).trim().split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
 assert.equal(rows.length,2);assert.equal(rows[1].database,url.pathname.slice(1));return {value:rows[0],identity:rows[1]};
}
const policyFields=['app_id','profile','state','revision','scope','currency_scale','allowed_origins','game_ids','release','manifest_sha256','proof_sha256','approved_by','approved_at'];
async function savePolicy(){const row=(await fixture.pool.query('SELECT * FROM gp_production_admission WHERE app_id=$1',[fixture.app.id])).rows[0];expected.policy_approvals.push(Object.fromEntries(policyFields.map(key=>[key,key==='approved_at'?row[key].toISOString():row[key]])));}
before(async()=>{
 fixture=await createPlayerFixture();assert.equal(fixture.admissionDeclaration.production_approval,false);
 ({profileInspectSQL,validateProfileInspection,PRODUCTION_TABLES}=await import('./inspect-backup.mjs'));
 const declaration=fixture.admissionDeclaration;
 expected={inspection_contract:'production-free-v2',runtime_profile:{profile:'firstparty-free-v1',public_origin:fixture.origin,app_id:fixture.app.id,release:declaration.release,manifest_sha256:declaration.manifest_sha256},policy_approvals:[]};
 databaseUrl=new URL(process.env.OASIS_DATABASE_URL);assert.match(databaseUrl.pathname,/^\/oasis_release_test_\d+_[a-f0-9]{12}$/);assert.equal(databaseUrl.hostname,'127.0.0.1');
 master=await readFile(new URL('file://'+process.env.OASIS_LOCAL_DIR+'/master.key'));assert.equal(master.length,32);
 for(const [module,method] of [['portal','migratePortal'],['credentials','migrateCredentials'],['overview-activity','migrateOverviewActivity'],['integration-checks','migrateIntegrationChecks']])await(await import('../../server/'+module+'.mjs'))[method]();
 await(await import('../../server/transfers/index.mjs')).migrateTransfers(fixture.pool);
 const {seal}=await import('../../server/security.mjs');await fixture.pool.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'partner-to-platform',$3)",[uid('key'),fixture.app.id,seal(randomBytes(32).toString('base64'))]);
 await savePolicy();
 const registered=await fixture.request('/api/player/register',{body:{app_id:fixture.app.id,username:'backup_player',password:'Local-backup-fixture-password-2026!'}});assert.equal(registered.status,201);
 const login=await fixture.request('/api/player/login',{body:{app_id:fixture.app.id,username:'backup_player',password:'Local-backup-fixture-password-2026!'}});assert.equal(login.status,200);
 const platform=await import('../../server/platform.mjs'),pvp=await import('../../server/pvp/index.mjs');
 for(const game of ARENA_IDS){
  const launched=await fixture.request('/api/player/launch',{cookie:login.cookie,headers:{'x-oasis-csrf':login.body.csrf_token},body:{app_id:fixture.app.id,request_id:uid('launch'),game_id:game,locale:'en',host_platform:'web'}});assert.equal(launched.status,201,game);
  const exchanged=await fixture.request('/v1/launch/exchange',{body:{launch_code:launched.body.launch_code,client_instance_id:uid('client'),host_origin:fixture.origin,game_id:game}});assert.equal(exchanged.status,200,game);
  const session=await platform.playSession({headers:{authorization:'Bearer '+exchanged.body.access_token}}),profile=RUN_PRACTICE_PROFILES.v2;
  const made=await pvp.routePvp(session,'POST','/api/pvp/rooms',{request_id:uid('room'),game_id:game,capacity:ARENA_GAMES[game].players[0],practice:true,entry_minor:'0',...(game==='run'?{run_input_protocol:profile.protocol,run_input_profile:profile.profileId}:{})});assert.equal(made.status,201,game);
  const path='/api/pvp/rooms/'+made.body.id,post=(verb,body={},time)=>pvp.routePvp(session,'POST',path+'/'+verb,{request_id:uid(verb),...body},time===undefined?{}:{now:time});
  await post('ready');await pvp.tickPvp({roomIds:[made.body.id]});
  if(game==='run'){
   const started=await post('scene-ready'),authority=started.body.run_inputs;assert.ok(authority);runRoom=made.body.id;
   const now=(await fixture.pool.query('SELECT starts_at FROM pvp_rooms WHERE id=$1',[runRoom])).rows[0].starts_at;
   const decided=await post('inputs',{roomId:runRoom,playerKey:session.external_user_id,clockEpoch:authority.clockEpoch,baseRevision:authority.revision,commands:[{commandSeq:1,type:'jump',executeTick:1}]},Number(now)+1000);assert.equal(decided.status,200);assert.equal(decided.body.run_inputs.decisions.length,1);
  }
  if(game==='match'){
   const room=(await fixture.pool.query('SELECT * FROM pvp_rooms WHERE id=$1',[made.body.id])).rows[0],legal=(await import('../../arena/match/engine.mjs')).legalMoves(room.game_state.players[session.external_user_id].board)[0];assert.ok(legal);
   const at=Number(room.starts_at)+1;assert.equal((await post('action',{seq:1,action:legal},at)).status,200);
   let final;for(let now=at+3000;now<room.game_state.deadlineAt+3000;now+=3000)final=await pvp.routePvp(session,'GET',path,{}, {now});assert.equal(final.body.status,'settled');assert.equal(final.body.result.resolution,'completed');
  }else await post('leave');
 }
 await fixture.setAdmission('closed');await savePolicy();
 const adminUrl=new URL(databaseUrl);adminUrl.pathname='/postgres';admin=new pg.Pool({connectionString:adminUrl.href,max:1});
 restoredName='oasis_release_test_'+process.pid+'_'+randomBytes(6).toString('hex');await admin.query(`CREATE DATABASE "${restoredName}"`);restoredCreated=true;
 const restoredUrl=new URL(databaseUrl);restoredUrl.pathname='/'+restoredName;restoredPool=new pg.Pool({connectionString:restoredUrl.href,max:1});
 const dump=command(process.env.OASIS_TEST_PG_DUMP||'pg_dump',['--dbname',databaseUrl.href,'--format=custom','--no-owner','--no-acl'],undefined,{binary:true});assert.ok(dump.subarray(0,5).equals(Buffer.from('PGDMP')));
 command(process.env.OASIS_TEST_PG_RESTORE||'pg_restore',['--dbname',restoredUrl.href,'--exit-on-error','--single-transaction','--no-owner','--no-acl'],dump);
});
after(async()=>{
 const errors=[];try{await restoredPool?.end();}catch(error){errors.push(error);}
 try{if(restoredCreated)await dropOwnedTestDatabase(admin,restoredName,{created:true});}catch(error){errors.push(error);}
 try{await admin?.end();}catch(error){errors.push(error);}try{await fixture?.close();}catch(error){errors.push(error);}master?.fill(0);
 if(errors.length)throw new AggregateError(errors,'ISOLATED_BACKUP_FIXTURE_CLEANUP_FAILED');
});
test('actual read-only SQL audits all 38 real tables, eleven rooms and real v2 durable decisions',()=>{
 const {value,identity}=inspect(),proof=validateProfileInspection(value,identity,master,expected);
 assert.equal(Object.keys(proof.row_counts).length,PRODUCTION_TABLES.length);assert.equal(proof.row_counts.gp_players,1);assert.equal(proof.row_counts.gp_sessions,11);assert.equal(proof.row_counts.pvp_rooms,11);assert.equal(proof.row_counts.pvp_run_input_decisions,1);assert.equal(proof.profile_snapshot.policy.state,'closed');assert.ok(Object.values(proof.audit).every(value=>value===0));
});
test('actual pg_dump restored into a separately owned database independently passes same profile',()=>{
 const original=inspect(),url=new URL(databaseUrl);url.pathname='/'+restoredName;const restored=inspect(url);
 assert.equal(validateProfileInspection(restored.value,restored.identity,master,expected).profile_snapshot_sha256,validateProfileInspection(original.value,original.identity,master,expected).profile_snapshot_sha256);assert.deepEqual(restored.value.rows,original.value.rows);
});
test('real SQL detects identity FK mismatch, changed frozen approval and financial obligation',async()=>{
 for(const [mutation,restore,audit] of [
  ["UPDATE pvp_rooms SET players=jsonb_set(players,'{0,external_user_id}','\"foreign_human\"'::jsonb) WHERE game_id='golf'","UPDATE pvp_rooms r SET players=jsonb_set(players,'{0,external_user_id}',to_jsonb((SELECT external_user_id FROM gp_player_app_ids WHERE app_id=r.app_id LIMIT 1))) WHERE game_id='golf'",'player_arena_identity_errors'],
  ["UPDATE gp_sessions SET external_user_id='foreign' WHERE game_id='golf'","UPDATE gp_sessions s SET external_user_id=m.external_user_id FROM gp_player_app_ids m WHERE s.app_id=m.app_id AND s.player_id=m.player_id",'player_arena_identity_errors'],
  ["UPDATE pvp_rooms SET terms=jsonb_set(terms,'{admission_proof_sha256}',to_jsonb(repeat('c',64))) WHERE game_id='golf'","UPDATE pvp_rooms SET terms=jsonb_set(terms,'{admission_proof_sha256}',to_jsonb((SELECT proof_sha256 FROM gp_production_admission LIMIT 1))) WHERE game_id='golf'",'admission_snapshot_errors'],
  ['UPDATE wallet_users SET credit_pending=1','UPDATE wallet_users SET credit_pending=0','nonzero_financial_state'],
  ["UPDATE pvp_run_input_decisions SET decision=decision||'{\"duplicate\":true}'::jsonb","UPDATE pvp_run_input_decisions SET decision=decision-'duplicate'",'run_decision_errors']
 ]){
  await fixture.pool.query(mutation);try{const {value,identity}=inspect();assert.ok(value.audit[audit]>0,audit);assert.throws(()=>validateProfileInspection(value,identity,master,expected),/OBLIGATION_OR_INTEGRITY/);}finally{await fixture.pool.query(restore);}
 }
});
test('database policy cannot approve itself and wrong archived AES key cannot decrypt',()=>{
 const {value,identity}=inspect();assert.throws(()=>validateProfileInspection(value,identity,randomBytes(32),expected));const unknown=structuredClone(expected);unknown.policy_approvals.pop();assert.throws(()=>validateProfileInspection(value,identity,master,unknown),/NOT_INDEPENDENTLY_APPROVED/);
});
test('actual zero account remains a required reverse mapping for every real App player',async()=>{
 const row=(await fixture.pool.query('SELECT * FROM wallet_users')).rows[0];assert.ok(row);assert.equal(row.available,'0');assert.equal(row.reserved,'0');assert.equal(row.credit_pending,'0');
 await fixture.pool.query('DELETE FROM wallet_users WHERE scope_id=$1 AND external_user_id=$2',[row.scope_id,row.external_user_id]);
 try{const {value,identity}=inspect();assert.ok(value.audit.wallet_player_identity_errors>0);assert.throws(()=>validateProfileInspection(value,identity,master,expected),/OBLIGATION_OR_INTEGRITY/);}
 finally{await fixture.pool.query('INSERT INTO wallet_users(scope_id,external_user_id,available,reserved,credit_pending) VALUES($1,$2,$3,$4,$5)',[row.scope_id,row.external_user_id,row.available,row.reserved,row.credit_pending]);}
});
