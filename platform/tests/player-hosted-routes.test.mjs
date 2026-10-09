import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createPlayerFixture} from './player-hosted-fixture.mjs';
import {ARENA_IDS} from '../shared/games.mjs';

let fixture;
before(async()=>{fixture=await createPlayerFixture();});
after(async()=>{await fixture?.close();});

test('public player metadata is read-only, narrowly projected and validates App queries',async()=>{
 const {request,app,pool}=fixture;
 const result=await request('/api/player/app?app_id='+app.id);
 assert.equal(result.status,200);assert.deepEqual(result.body,{name:app.name,game_ids:ARENA_IDS,admission_profile:'firstparty-free-v1',admission_open:true,free_training_only:true,financial_admission_enabled:false,allowed_room_modes:['bot-practice']});
 assert.equal(fixture.admissionDeclaration.kind,'isolated-firstparty-free-fixture');assert.equal(fixture.admissionDeclaration.production_approval,false);
 assert.equal(result.headers.get('cache-control'),'no-store');
 for(const query of ['', '?app_id=unknown','?app_id='+app.id+'&app_id='+app.id,'?app_id='+app.id+'&return_url=https://evil.invalid','?app_id=bad%2Fapp']){
  const denied=await request('/api/player/app'+query);assert.ok([400,404].includes(denied.status));
 }
 assert.equal((await request('/api/player/app?app_id='+app.id,{body:{}})).status,405);
 for(const table of ['gp_players','gp_player_sessions','gp_sessions','wallet_users','wallet_ledger'])assert.equal((await pool.query(`SELECT count(*)::int count FROM ${table}`)).rows[0].count,0);
});

test('metadata closes when production, App or same-origin host admission is unavailable',async()=>{
 const {request,app,pool,runtime}=fixture;
 assert.equal(Object.isFrozen(runtime),true);assert.equal(runtime.admissionEnabled,false);
 assert.throws(()=>{runtime.admissionEnabled=true;},TypeError);
 const {runtimeConfiguration}=await import('../server/runtime-mode.mjs');assert.throws(()=>runtimeConfiguration({...process.env,OASIS_PRODUCTION_ADMISSION_ENABLED:'1'}),/GENERIC_PRODUCTION_ADMISSION_FORBIDDEN/);
 await fixture.setAdmission('closed');
 assert.equal((await request('/api/player/app?app_id='+app.id)).body.admission_open,false);
 const closed=await request('/api/player/register',{body:{app_id:app.id,username:'closed_hosted',password:'Hosted-player-fixture-2026!'}});assert.equal(closed.status,409);assert.equal(closed.body.error.code,'PRODUCTION_ACCEPTANCE_REQUIRED');
 await fixture.setAdmission('open');
 await pool.query("UPDATE gp_apps SET status='paused' WHERE id=$1",[app.id]);
 assert.equal((await request('/api/player/app?app_id='+app.id)).body.admission_open,false);
 await pool.query("UPDATE gp_apps SET status='active',allowed_origins='[\"https://other.example.invalid\"]' WHERE id=$1",[app.id]);
 assert.equal((await request('/api/player/app?app_id='+app.id)).body.admission_open,false);
 await pool.query('UPDATE gp_apps SET allowed_origins=$2 WHERE id=$1',[app.id,JSON.stringify([fixture.origin])]);
 const policy=(await pool.query('SELECT proof_sha256 FROM gp_production_admission WHERE app_id=$1',[app.id])).rows[0];
 await pool.query("UPDATE gp_production_admission SET proof_sha256='unapproved fixture' WHERE app_id=$1",[app.id]);
 try{
  assert.equal((await request('/api/player/app?app_id='+app.id)).body.admission_open,false);
  const unreviewed=await request('/api/player/register',{body:{app_id:app.id,username:'unreviewed_hosted',password:'Hosted-player-fixture-2026!'}});assert.equal(unreviewed.status,409);assert.equal(unreviewed.body.error.code,'FIRSTPARTY_SOURCE_APPROVAL_REQUIRED');
 }finally{await pool.query('UPDATE gp_production_admission SET proof_sha256=$2 WHERE app_id=$1',[app.id,policy.proof_sha256]);}
});

test('real HTTP player account flow protects launch and binds original-session recovery without credits',async()=>{
 const {request,app,pool}=fixture,password='Hosted-player-fixture-2026!',account={app_id:app.id,username:'hosted_player',password};
 assert.equal((await request('/api/player/register',{body:account})).status,201);
 const login=await request('/api/player/login',{body:account});assert.equal(login.status,200);
 assert.match(login.headers.get('set-cookie'),/; Secure; HttpOnly; SameSite=Strict;/);assert.equal(login.body.token,undefined);
 const session=await request('/api/player/session',{cookie:login.cookie});assert.equal(session.body.player.username,account.username);
 const body={app_id:app.id,game_id:'match',request_id:'hosted_launch_one',host_origin:fixture.origin},headers={'x-oasis-csrf':session.body.csrf_token};
 assert.equal((await request('/api/player/launch',{body,cookie:login.cookie})).status,403);
 const launch=await request('/api/player/launch',{body,cookie:login.cookie,headers});assert.equal(launch.status,201);
 const replay=await request('/api/player/launch',{body,cookie:login.cookie,headers});assert.deepEqual(replay.body,launch.body);
 const probability=await request('/api/player/launch',{body:{...body,request_id:'not_permitted_game',game_id:'thunder'},cookie:login.cookie,headers});assert.equal(probability.status,409);assert.equal(probability.body.error.code,'GAME_DISABLED');
 assert.equal((await request('/api/player/launch',{body:{...body,request_id:'forged_player_request',external_user_id:'forged'},cookie:login.cookie,headers})).status,400);
 const exchange=await request('/v1/launch/exchange',{body:{launch_code:launch.body.launch_code,game_id:'match',host_origin:fixture.origin,client_instance_id:'hosted_http_instance'}});assert.equal(exchange.status,200);
 const gameHeaders={authorization:'Bearer '+exchange.body.access_token};
 const room=await request('/api/pvp/rooms',{body:{request_id:'hosted_http_practice',game_id:'match',capacity:2,practice:true},headers:gameHeaders});assert.equal(room.status,201);
 await request('/api/pvp/rooms/'+room.body.id+'/ready',{body:{request_id:'hosted_http_ready'},headers:gameHeaders});
 const recoveryPath='/api/player/recovery?app_id='+app.id;
 assert.equal((await request(recoveryPath)).status,401);
 assert.deepEqual((await request(recoveryPath,{cookie:login.cookie})).body,{sessions:[{session_id:launch.body.session_id,game_id:'match'}]});
 assert.equal((await request(recoveryPath+'&session_id=foreign',{cookie:login.cookie})).status,400);
 const otherAccount={...account,username:'other_hosted_player'};assert.equal((await request('/api/player/register',{body:otherAccount})).status,201);
 const otherLogin=await request('/api/player/login',{body:otherAccount});assert.deepEqual((await request(recoveryPath,{cookie:otherLogin.cookie})).body,{sessions:[]});
 const otherApp=(await(await import('../server/platform.mjs')).createApp('Other hosted App',{partnerId:'other_hosted_partner'})).app;
 assert.deepEqual((await request('/api/player/recovery?app_id='+otherApp.id,{cookie:login.cookie})).body,{sessions:[]});
 assert.equal((await request('/api/player/app?app_id='+otherApp.id)).body.admission_open,false);
 const foreign=await request('/api/player/login',{body:{...account,app_id:otherApp.id}});assert.equal(foreign.status,409);assert.equal(foreign.body.error.code,'FIRSTPARTY_APP_REQUIRED');
 await fixture.setAdmission('closed');
 const resumed=await request('/api/player/launch',{body:{...body,request_id:'hosted_resume_one',resume_session_id:launch.body.session_id},cookie:login.cookie,headers});assert.equal(resumed.status,201);assert.equal(resumed.body.session_id,launch.body.session_id);
 assert.deepEqual((await request(recoveryPath,{cookie:login.cookie})).body,{sessions:[{session_id:launch.body.session_id,game_id:'match'}]});
 assert.equal((await request('/api/pvp/rooms/'+room.body.id+'/leave',{body:{request_id:'hosted_http_leave'},headers:gameHeaders})).status,200);
 assert.deepEqual((await request(recoveryPath,{cookie:login.cookie})).body,{sessions:[]});
 assert.equal((await pool.query('SELECT count(*)::int count FROM gp_sessions')).rows[0].count,1);
 assert.equal((await pool.query('SELECT available::text FROM wallet_users')).rows[0].available,'0');
 assert.equal((await pool.query('SELECT count(*)::int count FROM wallet_ledger')).rows[0].count,0);
 assert.equal((await request('/api/player/logout',{body:{},cookie:login.cookie,headers})).status,200);
 assert.equal((await request('/api/player/session',{cookie:login.cookie})).status,401);
 await fixture.setAdmission('open');
});
