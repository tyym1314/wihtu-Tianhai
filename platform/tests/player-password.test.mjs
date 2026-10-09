import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createPlayerFixture} from './player-hosted-fixture.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Real isolated PG + loopback HTTP test; never run against a deployed database.
const password='Player-password-fixture-2026!',nextPassword='New-player-password-fixture-2026!';
let fixture,records,credentials,serial=0;
const uid=prefix=>prefix+'_'+(++serial);
const headers=login=>({'x-oasis-csrf':login.body.csrf_token});
async function request(path,options={}){
 return fixture.request(path,{...options,headers:{'x-real-ip':`198.19.${Math.floor(++serial/250)%250}.${serial%250+1}`,...options.headers}});
}
async function account(){
 const username=uid('password_player'),player=await records.registerPlayer(username,password,fixture.app.id);
 const login=await request('/api/player/login',{body:{app_id:fixture.app.id,username,password}});assert.equal(login.status,200);
 return{username,player,login};
}
const change=(login,body={current_password:password,new_password:nextPassword},extra={})=>request('/api/player/password',{body,cookie:login.cookie,...extra,headers:{...headers(login),...extra.headers}});
const saved=async player=>(await fixture.pool.query('SELECT salt,password_hash FROM gp_players WHERE id=$1',[player.id])).rows[0];
async function waitForLocks(count){
 for(let attempt=0;attempt<500;attempt++){
  const result=await fixture.pool.query("SELECT count(*)::int count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM gp_players WHERE id=%FOR UPDATE'");
  if(result.rows[0].count>=count)return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail('credential operations did not reach the actual player row lock');
}
before(async()=>{
 fixture=await createPlayerFixture();process.env.OASIS_TRUST_LOOPBACK_PROXY='1';
 records=await import('../server/player-records.mjs');credentials=await import('../server/credentials.mjs');
});
after(async()=>{await fixture?.close();});

test('player password route requires its current login, POST, exact Origin/CSRF and a narrow body',async()=>{
 const owner=await account(),before=await saved(owner.player);
 const denied=[
  ()=>request('/api/player/password',{body:{current_password:password,new_password:nextPassword}}),
  ()=>request('/api/player/password',{cookie:owner.login.cookie}),
  ()=>change(owner.login,undefined,{headers:{origin:'https://foreign.invalid'}}),
  ()=>change(owner.login,undefined,{headers:{'x-oasis-csrf':''}}),
  ()=>change(owner.login,undefined,{headers:{'x-oasis-csrf':'0'.repeat(64)}}),
  ()=>change(owner.login,{current_password:password,new_password:nextPassword,player_id:'other_player'}),
  ()=>change(owner.login,{current_password:password,new_password:nextPassword,app_id:fixture.app.id}),
  ()=>change(owner.login,{current_password:'wrong',new_password:nextPassword}),
  ()=>change(owner.login,{current_password:password,new_password:'short'}),
  ()=>change(owner.login,{current_password:password,new_password:password}),
 ];
 const codes=['LOGIN_REQUIRED','METHOD_NOT_ALLOWED','ORIGIN_FORBIDDEN','CSRF_FORBIDDEN','CSRF_FORBIDDEN','INVALID_REQUEST','INVALID_REQUEST','CURRENT_PASSWORD_INVALID','INVALID_PASSWORD','PASSWORD_UNCHANGED'];
 for(let index=0;index<denied.length;index++)assert.equal((await denied[index]()).body.error.code,codes[index]);
 assert.deepEqual(await saved(owner.player),before);assert.equal((await request('/api/player/session',{cookie:owner.login.cookie})).status,200);
 assert.equal((await fixture.pool.query("SELECT 1 FROM gp_audit WHERE actor=$1 AND action='player.password_changed'",[owner.player.id])).rowCount,0);
});

test('one global player change revokes logins across Apps but preserves other players, mappings, wallets and accepted games',async()=>{
 const owner=await account(),other=await account(),platform=await import('../server/platform.mjs');
 const secondApp=(await platform.createApp('Password second tenant',{partnerId:uid('other_partner')})).app;
 await fixture.pool.query("UPDATE gp_apps SET status='active',allowed_origins=$2,game_ids='[\"match\"]' WHERE id=$1",[secondApp.id,JSON.stringify([fixture.origin])]);
 const unacceptedLogin=await request('/api/player/login',{body:{app_id:secondApp.id,username:owner.username,password}});assert.equal(unacceptedLogin.status,409);assert.equal(unacceptedLogin.body.error.code,'FIRSTPARTY_APP_REQUIRED');
 assert.equal((await fixture.pool.query('SELECT 1 FROM gp_player_app_ids WHERE app_id=$1',[secondApp.id])).rowCount,0);
 // Explicit synthetic historical obligation in this unique loopback DB only.
 // It tests global login revocation, never first-time foreign-App admission.
 const oldExternal=uid('historically_accepted_player');
 await fixture.pool.query('INSERT INTO gp_player_app_ids(app_id,player_id,external_user_id) VALUES($1,$2,$3)',[secondApp.id,owner.player.id,oldExternal]);
 await fixture.pool.query('INSERT INTO gp_sessions(id,app_id,player_id,external_user_id,game_id,host_origin) VALUES($1,$2,$3,$4,$5,$6)',[uid('historically_accepted_session'),secondApp.id,owner.player.id,oldExternal,'match',fixture.origin]);
 const secondLogin=await request('/api/player/login',{body:{app_id:secondApp.id,username:owner.username,password}});assert.equal(secondLogin.status,200);
 const launch=await request('/api/player/launch',{body:{app_id:fixture.app.id,game_id:'match',request_id:uid('accepted'),host_origin:fixture.origin},cookie:owner.login.cookie,headers:headers(owner.login)});assert.equal(launch.status,201);
 const snapshot=async()=>({mappings:(await fixture.pool.query('SELECT * FROM gp_player_app_ids ORDER BY app_id,player_id')).rows,wallets:(await fixture.pool.query('SELECT * FROM wallet_users ORDER BY scope_id,external_user_id')).rows,games:(await fixture.pool.query('SELECT * FROM gp_sessions ORDER BY id')).rows,ledger:(await fixture.pool.query('SELECT * FROM wallet_ledger ORDER BY id')).rows});
 const before=await snapshot(),changed=await change(secondLogin);assert.equal(changed.status,200);assert.deepEqual(changed.body,{ok:true,reauthenticate:true});
 assert.equal(changed.headers.get('set-cookie'),'__Host-oasis_player=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');assert.equal(changed.headers.get('cache-control'),'no-store');
 for(const login of [owner.login,secondLogin])assert.equal((await request('/api/player/session',{cookie:login.cookie})).status,401);
 assert.equal((await request('/api/player/session',{cookie:other.login.cookie})).status,200);assert.deepEqual(await snapshot(),before);
 assert.equal((await request('/api/player/login',{body:{app_id:fixture.app.id,username:owner.username,password}})).status,401);
 assert.equal((await request('/api/player/login',{body:{app_id:fixture.app.id,username:owner.username,password:nextPassword}})).status,200);
 const audits=(await fixture.pool.query("SELECT detail FROM gp_audit WHERE actor=$1 AND action='player.password_changed'",[owner.player.id])).rows;
 assert.deepEqual(audits,[{detail:{account_id:owner.player.id,sessions_revoked:true}}]);
 for(const secret of [password,nextPassword,owner.login.cookie.split('=')[1]])assert(!JSON.stringify(audits).includes(secret));
});

test('password change remains available to authenticated players during actual admission pause',async()=>{
 const owner=await account();await fixture.setAdmission('closed');
 try{
  assert.equal(Object.isFrozen(fixture.runtime),true);assert.equal(fixture.runtime.admissionEnabled,false);
  assert.throws(()=>{fixture.runtime.production=false;},TypeError);
  assert.equal((await change(owner.login)).status,200);
 }finally{await fixture.setAdmission('open');}
});

test('an actual separate sandbox runtime rejects the player password route before any database access',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oasis-password-sandbox-')),env={...process.env,OASIS_ENVIRONMENT:'sandbox',OASIS_LOCAL_DIR:dir};
 for(const key of ['OASIS_ADMISSION_PROFILE','OASIS_FIRSTPARTY_APP_ID','OASIS_ADMISSION_RELEASE','OASIS_ADMISSION_MANIFEST_SHA256'])delete env[key];
 try{
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`import assert from 'node:assert/strict';import{routePlayer}from'./server/player-routes.mjs';import{runtime}from'./server/runtime-mode.mjs';import{pool,closePools}from'./server/db.mjs';assert.equal(runtime.production,false);await assert.rejects(routePlayer({}, {}, '/api/player/password', {}, ''),{code:'NOT_FOUND'});assert.equal(pool.totalCount,0);await closePools();console.log('SANDBOX_PLAYER_ROUTE_REFUSED_WITHOUT_DATABASE_ACCESS');`],{cwd:new URL('../',import.meta.url),env,encoding:'utf8',timeout:10000});
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'SANDBOX_PLAYER_ROUTE_REFUSED_WITHOUT_DATABASE_ACCESS');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('password attempts are rate limited without mutating credentials or deleting the current session',async()=>{
 const owner=await account(),before=await saved(owner.player),extra={headers:{'x-real-ip':'198.18.255.254'}};
 for(let i=0;i<8;i++)assert.equal((await change(owner.login,{current_password:'incorrect',new_password:nextPassword},extra)).body.error.code,'CURRENT_PASSWORD_INVALID');
 assert.equal((await change(owner.login,undefined,extra)).body.error.code,'RATE_LIMITED');assert.deepEqual(await saved(owner.player),before);
 assert.equal((await request('/api/player/session',{cookie:owner.login.cookie})).status,200);
});

test('two real concurrent changes sharing the old credential cannot both commit',async()=>{
 const owner=await account(),locker=await fixture.pool.connect(),pending=[];
 try{
  await locker.query('BEGIN');await locker.query('SELECT id FROM gp_players WHERE id=$1 FOR UPDATE',[owner.player.id]);
  pending.push(change(owner.login));pending.push(change(owner.login,{current_password:password,new_password:'Alternative-player-fixture-2026!'}));
  await waitForLocks(2);await locker.query('COMMIT');
  const results=await Promise.all(pending);assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  assert.equal(results.find(result=>result.status===409).body.error.code,'CREDENTIAL_CHANGED');
  assert.equal((await fixture.pool.query('SELECT 1 FROM gp_player_sessions WHERE player_id=$1',[owner.player.id])).rowCount,0);
  assert.equal((await fixture.pool.query("SELECT 1 FROM gp_audit WHERE actor=$1 AND action='player.password_changed'",[owner.player.id])).rowCount,1);
 }finally{await locker.query('ROLLBACK');locker.release();await Promise.allSettled(pending);}
});

test('old-password login already waiting behind a password change cannot admit a surviving session',async()=>{
 const owner=await account(),locker=await fixture.pool.connect();let changePending,loginPending;
 try{
  await locker.query('BEGIN');await locker.query('SELECT id FROM gp_players WHERE id=$1 FOR UPDATE',[owner.player.id]);
  changePending=change(owner.login);await waitForLocks(1);
  loginPending=records.loginPlayer(owner.username,password,fixture.app.id).then(()=>({accepted:true}),error=>({code:error.code}));
  await waitForLocks(2);await locker.query('COMMIT');
  assert.equal((await changePending).status,200);assert.deepEqual(await loginPending,{code:'LOGIN_FAILED'});
  assert.equal((await fixture.pool.query('SELECT 1 FROM gp_player_sessions WHERE player_id=$1',[owner.player.id])).rowCount,0);
 }finally{await locker.query('ROLLBACK');locker.release();await Promise.allSettled([changePending,loginPending]);}
});

test('a session revoked after HTTP authentication but before the credential lock cannot change the password',async()=>{
 const owner=await account(),before=await saved(owner.player),locker=await fixture.pool.connect();let pending;
 try{
  await locker.query('BEGIN');await locker.query('SELECT id FROM gp_players WHERE id=$1 FOR UPDATE',[owner.player.id]);
  pending=change(owner.login);await waitForLocks(1);
  await locker.query('DELETE FROM gp_player_sessions WHERE player_id=$1',[owner.player.id]);await locker.query('COMMIT');
  assert.equal((await pending).body.error.code,'LOGIN_REQUIRED');assert.deepEqual(await saved(owner.player),before);
 }finally{await locker.query('ROLLBACK');locker.release();await Promise.allSettled([pending]);}
});

test('audit failure rolls back password update and session revocation in the same transaction',async()=>{
 const owner=await account(),before=await saved(owner.player);
 await fixture.pool.query(`CREATE FUNCTION password_fixture_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='player.password_changed' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER password_fixture_audit_fail BEFORE INSERT ON gp_audit FOR EACH ROW EXECUTE FUNCTION password_fixture_audit_fail()`);
 try{
  assert.equal((await change(owner.login)).status,500);assert.deepEqual(await saved(owner.player),before);
  assert.equal((await request('/api/player/session',{cookie:owner.login.cookie})).status,200);
 }finally{await fixture.pool.query('DROP TRIGGER password_fixture_audit_fail ON gp_audit; DROP FUNCTION password_fixture_audit_fail()');}
});
