import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';

const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
const databaseName='oasis_credentials_'+process.pid+'_'+randomBytes(6).toString('hex'),databaseUrl=new URL(adminUrl);databaseUrl.pathname='/'+databaseName;
const password='Credential-fixture-only-2026!',nextPassword='Replacement-fixture-only-2026!';
let admin,db,pools,security,platform,portal,credentials,integration,server,origin,dir,created=false,adminCookie,serial=0;
const uid=prefix=>prefix+'_'+randomBytes(8).toString('hex');
async function request(path,body,cookie=adminCookie,method=body===undefined?'GET':'POST',extra={}){
 const response=await fetch(origin+path,{method,headers:{Origin:origin,'x-real-ip':'198.18.'+Math.floor(++serial/250)+'.'+(serial%250+1),...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return{status:response.status,body:await response.json(),headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function account(){const username=uid('credential'),r=await request('/api/admin/partner-accounts',{name:'Credentials Test',username,password});assert.equal(r.status,201);const login=await request('/api/partner/login',{username,password},null);assert.equal(login.status,200);return{account:r.body.account,username,cookie:login.cookie};}
async function app(owner){const r=await request('/api/partner/apps',{name:'Key lifecycle test'},owner.cookie);assert.equal(r.status,201);return r.body;}
async function authenticate(key){const headers=security.sign({...key,path:'/v1/games',method:'GET',raw:'',request_id:uid('read')});return request('/v1/games',undefined,null,'GET',headers);}
const keyPath=(item,suffix='')=>`/api/partner/apps/${item.app.id}/integration/keys${suffix}`;
before(async()=>{
 assert.match(databaseName,/^oasis_credentials_\d+_[a-f0-9]{12}$/);admin=new pg.Pool({connectionString:adminUrl.href,max:2});await admin.query(`CREATE DATABASE "${databaseName}"`);created=true;
 dir=await mkdtemp(join(tmpdir(),'oasis-credentials-'));process.env.OASIS_DATABASE_URL=databaseUrl.href;process.env.OASIS_LOCAL_DIR=dir;process.env.OASIS_TRUST_LOOPBACK_PROXY='1';
 server=createServer(async(req,res)=>{try{
  const {raw,body}=await security.readBody(req);
  if(await credentials.routeCredentials(req,res,req.url,body))return;
  if(await integration.routeIntegration(req,res,req.url,body))return;
  if(await portal.routePortal(req,res,req.url,body))return;
  if(req.url==='/v1/games'){const value=await platform.authenticatePartner(req,raw,body);security.send(res,200,platform.gamesFor(value));return;}
  security.fail(404,'NOT_FOUND');
 }catch(e){security.send(res,e.status||500,{error:{code:e.code||'INTERNAL_ERROR'}});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;process.env.OASIS_PUBLIC_ORIGIN=origin;
 pools=await import('../server/db.mjs');db=pools.pool;security=await import('../server/security.mjs');platform=await import('../server/platform.mjs');portal=await import('../server/portal.mjs');credentials=await import('../server/credentials.mjs');integration=await import('../server/integration-routes.mjs');
 assert.equal((await db.query('SELECT current_database() name')).rows[0].name,databaseName);
 await platform.migratePlatform();await portal.migratePortal();await credentials.migrateCredentials();await(await import('../server/wallet/index.mjs')).migrateWallet(db);
 const material=await credentials.passwordMaterial(password);await db.query('INSERT INTO gp_admins(id,username,salt,password_hash) VALUES($1,$2,$3,$4)',['credential_admin','credential_admin',material.salt,material.password_hash]);
 adminCookie='oasis_admin='+(await platform.login('credential_admin',password)).token;
});
after(async()=>{
 try{if(server?.listening)await new Promise(r=>server.close(r));await pools?.closePools();if(created)await dropOwnedTestDatabase(admin,databaseName,{created});}
 finally{await admin?.end();if(dir)await rm(dir,{recursive:true,force:true});}
});

test('migration preserves existing credentials and sessions across repeated calls',async()=>{
 const rows=(await db.query('SELECT * FROM gp_admins')).rows,sessions=(await db.query('SELECT * FROM gp_admin_sessions')).rows;
 await credentials.migrateCredentials();assert.deepEqual((await db.query('SELECT * FROM gp_admins')).rows,rows);assert.deepEqual((await db.query('SELECT * FROM gp_admin_sessions')).rows,sessions);
});

test('key overlap preserves both signatures, idempotent retries reveal same key only within its window',async()=>{
 const owner=await account(),item=await app(owner),body={request_id:uid('issue')};
 const results=await Promise.all(Array.from({length:5},()=>request(keyPath(item),body,owner.cookie)));
 assert(results.every(r=>r.status===201));for(const r of results)assert.deepEqual(r.body,results[0].body);
 const next=results[0].body.credentials;assert.notEqual(next.key_id,item.credentials.key_id);
 assert.equal((await authenticate(item.credentials)).status,200);assert.equal((await authenticate(next)).status,200);
 const list=await request(keyPath(item),undefined,owner.cookie);assert.equal(list.body.keys.filter(k=>k.active).length,2);assert.doesNotMatch(JSON.stringify(list.body),/secret|password|response_enc/);
 assert.equal((await request(keyPath(item),{request_id:uid('third')},owner.cookie)).body.error.code,'ACTIVE_KEY_LIMIT');
 await db.query("UPDATE gp_key_issues SET expires_at=now()-interval '1 second' WHERE app_id=$1",[item.app.id]);
 const expired=await request(keyPath(item),body,owner.cookie);assert.equal(expired.body.error.code,'KEY_RESPONSE_EXPIRED');assert.equal((await request(keyPath(item),undefined,owner.cookie)).body.keys.length,2);
 const audit=JSON.stringify((await db.query('SELECT detail FROM gp_audit WHERE app_id=$1',[item.app.id])).rows);assert(!audit.includes(next.secret_base64));assert(!audit.includes(item.credentials.secret_base64));
});

test('concurrent creation is bounded and concurrent revocation cannot remove the final key',async()=>{
 const owner=await account(),item=await app(owner);
 const results=await Promise.all([1,2].map(()=>request(keyPath(item),{request_id:uid('parallel')},owner.cookie)));assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 const next=results.find(r=>r.status===201).body.credentials;
 const revoked=await Promise.all([item.credentials,next].map(k=>request(keyPath(item,'/'+k.key_id+'/revoke'),{},owner.cookie)));
 assert.deepEqual(revoked.map(r=>r.status).sort(),[200,409]);
 const list=(await request(keyPath(item),undefined,owner.cookie)).body.keys,valid=list.find(k=>k.active),invalid=list.find(k=>!k.active);
 assert.equal(list.filter(k=>k.active).length,1);assert(invalid.revoked_at);assert.equal((await request(keyPath(item,'/'+invalid.id+'/revoke'),{},owner.cookie)).status,200);
 for(const k of [item.credentials,next])assert.equal((await authenticate(k)).status,k.key_id===valid.id?200:401);
});

test('key management enforces owner, direction, Origin and credentials without secret history',async()=>{
 const a=await account(),b=await account(),item=await app(a),foreign=await app(b),path=keyPath(item);
 assert.equal((await request(path,undefined,b.cookie)).status,404);
 assert.equal((await request(path,{request_id:uid('cross')},b.cookie)).status,404);
 assert.equal((await request(path,{request_id:uid('csrf')},a.cookie,'POST',{Origin:'https://foreign.invalid'})).status,403);
 assert.equal((await request(path,{request_id:uid('anon')},null)).status,401);
 assert.equal((await request(path+'/'+foreign.credentials.key_id+'/revoke',{},a.cookie)).status,404);
 const wallet=(await db.query("SELECT id FROM gp_keys WHERE app_id=$1 AND direction='platform-to-wallet'",[item.app.id])).rows[0];assert.equal((await request(path+'/'+wallet.id+'/revoke',{},a.cookie)).status,404);
 const issued=await request(path,{request_id:uid('issue')},a.cookie);const key=issued.body.credentials;
 assert.equal((await request(path+'/'+key.key_id+'/revoke',{},a.cookie)).status,200);
 assert.equal((await db.query('SELECT response_enc FROM gp_key_issues WHERE key_id=$1',[key.key_id])).rows[0].response_enc,null);
});

test('self password change validates current password and revokes all partner sessions',async()=>{
 const owner=await account(),second=await request('/api/partner/login',{username:owner.username,password},null);
 const wrong=await request('/api/partner/password',{current_password:'wrong',new_password:nextPassword},owner.cookie);assert.equal(wrong.body.error.code,'CURRENT_PASSWORD_INVALID');
 assert.equal((await request('/api/partner/password',{current_password:password,new_password:'short'},owner.cookie)).status,400);
 assert.equal((await request('/api/partner/password',{current_password:password,new_password:nextPassword},owner.cookie,'POST',{Origin:'https://foreign.invalid'})).status,403);
 const changed=await request('/api/partner/password',{current_password:password,new_password:nextPassword},owner.cookie);assert.equal(changed.status,200);assert.match(changed.headers.get('set-cookie'),/Max-Age=0/);
 for(const c of [owner.cookie,second.cookie])assert.equal((await request('/api/partner/apps',undefined,c)).status,401);
 assert.equal((await request('/api/partner/login',{username:owner.username,password},null)).status,401);
 assert.equal((await request('/api/partner/login',{username:owner.username,password:nextPassword},null)).status,200);
 const audits=JSON.stringify((await db.query('SELECT detail FROM gp_audit WHERE actor=$1',[owner.account.id])).rows);assert(!audits.includes(password));assert(!audits.includes(nextPassword));
});

test('admin can disable, enable and reset partners; partner cannot manage other accounts',async()=>{
 const owner=await account(),path='/api/admin/partner-accounts/'+owner.account.id;
 assert.equal((await request(path,{active:false},owner.cookie,'PATCH')).status,401);
 assert.equal((await request(path,{active:false},adminCookie,'PATCH')).status,200);
 assert.equal((await request('/api/partner/apps',undefined,owner.cookie)).status,401);
 assert.equal((await request('/api/partner/login',{username:owner.username,password},null)).status,401);
 assert.equal((await request(path,{active:true},adminCookie,'PATCH')).status,200);
 const old=await request('/api/partner/login',{username:owner.username,password},null);assert.equal(old.status,200);
 const reset=await request(path+'/password',{new_password:nextPassword});assert.equal(reset.status,200);assert.doesNotMatch(JSON.stringify(reset.body),/password|salt|secret/);
 assert.equal((await request('/api/partner/apps',undefined,old.cookie)).status,401);
 assert.equal((await request('/api/partner/login',{username:owner.username,password},null)).status,401);
 assert.equal((await request('/api/partner/login',{username:owner.username,password:nextPassword},null)).status,200);
});

test('a password reset committed during login prevents stale password session admission',async()=>{
 const owner=await account(),locker=await db.connect(),material=await credentials.passwordMaterial(nextPassword);let login;
 try{
  await locker.query('BEGIN');await locker.query('SELECT id FROM gp_partner_accounts WHERE id=$1 FOR UPDATE',[owner.account.id]);
  login=credentials.loginCredential('partner',owner.username,password).then(()=>({accepted:true}),e=>({code:e.code}));
  let waiting=false;for(let i=0;i<100;i++){waiting=(await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%SELECT * FROM gp_partner_accounts WHERE id=%'",[databaseName])).rowCount>0;if(waiting)break;await new Promise(r=>setTimeout(r,10));}
  assert(waiting,'login must reach the row lock before reset commits');
  await locker.query('UPDATE gp_partner_accounts SET salt=$2,password_hash=$3 WHERE id=$1',[owner.account.id,material.salt,material.password_hash]);await locker.query('DELETE FROM gp_partner_sessions WHERE account_id=$1',[owner.account.id]);await locker.query('COMMIT');
  assert.equal((await login).code,'LOGIN_FAILED');assert.equal((await db.query('SELECT 1 FROM gp_partner_sessions WHERE account_id=$1',[owner.account.id])).rowCount,0);
 }finally{await locker.query('ROLLBACK');locker.release();if(login)await login;}
});

test('partner login rate buckets use trusted proxy client identity instead of one shared loopback bucket',async()=>{
 const owner=await account(),headers={'x-real-ip':'198.19.100.1'};
 for(let i=0;i<12;i++)assert.equal((await request('/api/partner/login',{username:owner.username,password:'invalid'},null,'POST',headers)).status,401);
 assert.equal((await request('/api/partner/login',{username:owner.username,password},null,'POST',headers)).status,429);
 assert.equal((await request('/api/partner/login',{username:owner.username,password},null,'POST',{'x-real-ip':'198.19.100.2'})).status,200);
});

test('admin password change uses old password and invalidates every admin session',async()=>{
 const previous=await platform.login('credential_admin',password);
 const changed=await request('/api/admin/password',{current_password:password,new_password:nextPassword});assert.equal(changed.status,200);assert.match(changed.headers.get('set-cookie'),/Path=\/api\/admin;.*Max-Age=0/);
 assert.equal(await platform.adminUser({headers:{cookie:adminCookie}}),null);assert.equal(await platform.adminUser({headers:{cookie:'oasis_admin='+previous.token}}),null);
 await assert.rejects(platform.login('credential_admin',password),e=>e.code==='LOGIN_FAILED');adminCookie='oasis_admin='+(await platform.login('credential_admin',nextPassword)).token;
});
