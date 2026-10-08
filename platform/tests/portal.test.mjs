import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,scryptSync} from 'node:crypto';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';

// No imports with database/master-key side effects until the isolated environment is set.
const dbname='oasis_portal_test_'+randomBytes(8).toString('hex');
const admin=new pg.Pool({connectionString:process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres'});
const dir=mkdtempSync(join(tmpdir(),'oasis-portal-test-'));
let db,server,base,security,platform,portal,pools,adminCookie,a,b,aa,ab,ba,created=false;
const password='Portal-test-only-2026!';
async function request(path,body,cookie,method=body===undefined?'GET':'POST',requestOrigin=base){const response=await fetch(base+path,{method,headers:{origin:requestOrigin,...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};}
async function account(name,username){const created=await request('/api/admin/partner-accounts',{name,username,password},adminCookie);assert.equal(created.status,201);const login=await request('/api/partner/login',{username,password});assert.equal(login.status,200);return{account:created.data.account,user:login.data.user,cookie:login.cookie};}
async function app(name,owner){const created=await request('/api/partner/apps',{name},owner.cookie);assert.equal(created.status,201,created.data.error?.message);return created.data;}

before(async()=>{
 await admin.query(`CREATE DATABASE ${dbname}`);created=true;
 const target=new URL(admin.options.connectionString);target.pathname='/'+dbname;
 process.env.OASIS_DATABASE_URL=target.href;process.env.OASIS_LOCAL_DIR=dir;
 server=createServer(async(req,res)=>{try{const{body}=await security.readBody(req);if(await portal.routePortal(req,res,req.url,body))return;if(req.url==='/api/admin/session'){security.send(res,200,{user:await platform.adminUser(req)});return;}if(req.url==='/api/admin/apps'){const user=await platform.adminUser(req);if(!user)security.fail(401,'LOGIN_REQUIRED');security.send(res,200,{apps:(await db.query('SELECT id FROM gp_apps')).rows});return;}security.fail(404,'NOT_FOUND');}catch(e){security.send(res,e.status||500,{error:{code:e.code||'INTERNAL_ERROR',message:e.status?e.message:'Test harness server error'}});}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 process.env.OASIS_PUBLIC_ORIGIN=base;process.env.OASIS_REFERENCE_WALLET_URL=base+'/unused-reference-wallet';
 pools=await import('../server/db.mjs');db=pools.pool;security=await import('../server/security.mjs');platform=await import('../server/platform.mjs');portal=await import('../server/portal.mjs');
 await platform.migratePlatform();await(await import('../server/wallet/index.mjs')).migrateWallet(db);await(await import('../server/pvp/index.mjs')).migratePvp(db);
 const salt='portal-isolation-test-salt';await db.query('INSERT INTO gp_admins(id,username,salt,password_hash) VALUES($1,$2,$3,$4)',['portal_test_admin','portal_admin',salt,scryptSync(password,salt,64).toString('hex')]);
 const login=await platform.login('portal_admin',password);adminCookie='oasis_admin='+login.token;
 await portal.migratePortal();a=await account('Partner Alpha','alpha_portal');b=await account('Partner Beta','beta_portal');
 aa=await app('Alpha First',a);ab=await app('Alpha Second',a);ba=await app('Beta First',b);
});
after(async()=>{try{if(server?.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await pools?.closePools();if(created)await dropOwnedTestDatabase(admin,dbname,{created});}finally{await admin.end();rmSync(dir,{recursive:true,force:true});}});

test('portal migration is idempotent and preserves original admin account/session',async()=>{
 const before=(await db.query('SELECT * FROM gp_admins')).rows,sessions=(await db.query('SELECT * FROM gp_admin_sessions')).rows;
 await portal.migratePortal();assert.deepEqual((await db.query('SELECT * FROM gp_admins')).rows,before);assert.deepEqual((await db.query('SELECT * FROM gp_admin_sessions')).rows,sessions);
 assert.equal((await request('/api/admin/session',undefined,adminCookie)).data.user.role,'platform_admin');
});
test('administrator creates isolated partners without echoing password material; username uniqueness is normalized',async()=>{
 assert.notEqual(a.account.partner_id,b.account.partner_id);assert.equal(a.user.role,'partner_developer');
 const list=await request('/api/admin/partner-accounts',undefined,adminCookie);assert.equal(list.status,200);assert.equal(list.data.accounts.length,2);
 assert(!/password|salt|secret/.test(JSON.stringify(list.data)));assert(!JSON.stringify(list.data).includes(password));
 assert.equal((await request('/api/admin/partner-accounts',{name:'Duplicate','username':' ALPHA_PORTAL ',password},adminCookie)).status,409);
 assert.equal((await request('/api/admin/partner-accounts',{name:'Bad Role',username:'bad_role',password,role:'platform_admin'},adminCookie)).status,400);
 assert.equal((await request('/api/admin/partner-accounts',{name:'Short Password',username:'short_password',password:'tiny'},adminCookie)).status,400);
 const stored=(await db.query('SELECT password_hash FROM gp_partner_accounts WHERE id=$1',[a.user.id])).rows[0];assert.equal(stored.password_hash.length,128);assert.notEqual(stored.password_hash,password);
});
test('admin and partner cookies are disjoint authorities; account creation never accepts partner authentication',async()=>{
 assert.equal((await request('/api/admin/apps',undefined,a.cookie)).status,401);
 assert.equal((await request('/api/admin/partner-accounts',undefined,a.cookie)).status,401);
 assert.equal((await request('/api/admin/partner-accounts',{name:'Escalation',username:'escape_admin',password},a.cookie)).status,401);
 assert.equal((await request('/api/partner/apps',undefined,adminCookie)).status,401);
 const partnerSession=await request('/api/partner/session',undefined,adminCookie);assert.equal(partnerSession.data.user,null);assert.equal(partnerSession.data.environment,'sandbox');
 const forged=a.cookie.replace('oasis_partner=','oasis_admin=');assert.equal((await request('/api/admin/apps',undefined,forged)).status,401);
 assert.equal((await request('/api/partner/login',{username:'portal_admin',password})).status,401);
});
test('partner sessions use restricted HttpOnly cookie; writes and login require the configured Origin',async()=>{
 const r=await request('/api/partner/login',{username:'alpha_portal',password});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/Path=\/api\/partner; HttpOnly; SameSite=Strict/);
 assert.equal((await request('/api/partner/login',{username:'alpha_portal',password},undefined,'POST','https://foreign.invalid')).status,403);
 assert.equal((await request('/api/partner/apps',{name:'CSRF Attempt'},a.cookie,'POST','https://foreign.invalid')).status,403);
 assert.equal((await request('/api/admin/partner-accounts',{name:'CSRF Attempt',username:'csrf_attempt',password},adminCookie,'POST','https://foreign.invalid')).status,403);
});
test('all partner app lists and details are server-scoped and expose credentials only on creation',async()=>{
 const alpha=(await request('/api/partner/apps',undefined,a.cookie)).data.apps,beta=(await request('/api/partner/apps',undefined,b.cookie)).data.apps;
 assert.deepEqual(alpha.map(v=>v.id).sort(),[aa.app.id,ab.app.id].sort());assert.deepEqual(beta.map(v=>v.id),[ba.app.id]);assert(alpha.every(v=>v.partner_id===a.user.partner_id));
 assert.equal((await request('/api/partner/apps/'+ba.app.id,undefined,a.cookie)).status,404);
 assert.equal((await request('/api/partner/apps/app_missing',undefined,a.cookie)).status,404);
 assert.equal((await request('/api/partner/apps/'+aa.app.id,undefined,a.cookie)).data.app.id,aa.app.id);
 assert(aa.credentials.secret_base64);assert(!/secret|password|salt/.test(JSON.stringify(alpha)));assert.equal(aa.app.partner_id,a.user.partner_id);
 for(const extra of [{partner_id:b.user.partner_id},{environment:'production'},{wallet_url:'https://foreign.invalid'},{role:'platform_admin'}])assert.equal((await request('/api/partner/apps',{name:'Injected scope',...extra},a.cookie)).status,400);
 const audit=(await db.query("SELECT actor FROM gp_audit WHERE action='app.created' AND app_id=$1",[aa.app.id])).rows[0];assert.equal(audit.actor,a.user.id);
});
test('owned app changes allow only name, status and released-game subset; foreign updates leave records unchanged',async()=>{
 const before=(await db.query('SELECT * FROM gp_apps WHERE id=$1',[ba.app.id])).rows[0];
 assert.equal((await request('/api/partner/apps/'+ba.app.id,{name:'Stolen App'},a.cookie,'PATCH')).status,404);assert.deepEqual((await db.query('SELECT * FROM gp_apps WHERE id=$1',[ba.app.id])).rows[0],before);
 for(const patch of [{math_profile:'98'},{competitive_fee_bps:1000},{partner_id:b.user.partner_id},{environment:'live'},{wallet_scope_id:ba.app.wallet_scope_id},{wallet_url:'https://foreign.invalid'}])assert.equal((await request('/api/partner/apps/'+aa.app.id,patch,a.cookie,'PATCH')).status,400);
 for(const game_ids of [['unknown'],['golf','golf']])assert.equal((await request('/api/partner/apps/'+aa.app.id,{game_ids},a.cookie,'PATCH')).status,400);
 assert.equal((await request('/api/partner/apps/'+aa.app.id,{name:'Alpha renamed',game_ids:['golf']},a.cookie,'PATCH')).status,200);
 assert.equal((await request('/api/partner/apps/'+aa.app.id,{game_ids:aa.app.game_ids},a.cookie,'PATCH')).status,200);
 assert.equal((await request('/api/partner/profiles',undefined,a.cookie)).status,404);
});
test('partner launch binds app identity and game grant; foreign App and caller-supplied scope are rejected',async()=>{
 assert.equal((await request('/api/partner/apps/'+ba.app.id+'/launch',{game_id:'golf',external_user_id:'same_user'},a.cookie)).status,404);
 assert.equal((await request('/api/partner/apps/'+aa.app.id+'/launch',{game_id:'golf',partner_id:b.user.partner_id},a.cookie)).status,400);
 await request('/api/partner/apps/'+aa.app.id,{game_ids:['golf']},a.cookie,'PATCH');
 assert.equal((await request('/api/partner/apps/'+aa.app.id+'/launch',{game_id:'pool'},a.cookie)).status,403);
 for(const item of [aa,ab]){const r=await request('/api/partner/apps/'+item.app.id+'/launch',{game_id:'golf',external_user_id:'same_user'},a.cookie);assert.equal(r.status,200);const session=(await db.query('SELECT app_id,external_user_id FROM gp_sessions WHERE id=$1',[r.data.session_id])).rows[0];assert.equal(session.app_id,item.app.id);assert.equal(session.external_user_id,'same_user');}
 await request('/api/partner/apps/'+aa.app.id,{status:'paused'},a.cookie,'PATCH');assert.equal((await request('/api/partner/apps/'+aa.app.id+'/launch',{game_id:'golf'},a.cookie)).status,403);await request('/api/partner/apps/'+aa.app.id,{status:'active',game_ids:aa.app.game_ids},a.cookie,'PATCH');
});

async function fixture(item,label){
 const session='fixture_session_'+label,cycle='fixture_cycle_'+label,room='fixture_room_'+label;
 await db.query('INSERT INTO gp_sessions(id,app_id,external_user_id,game_id) VALUES($1,$2,$3,$4)',[session,item.app.id,'shared_external_user','tiger']);
 await db.query("INSERT INTO gp_cycles(id,session_id,app_id,external_user_id,game_id,request_id,stake_minor,math_profile,math_version,math_hash,max_payout_minor,status,payout_minor) VALUES($1,$2,$3,'shared_external_user','tiger','shared_request',100,'99','fixture','fixture',1000,'SETTLED',90)",[cycle,session,item.app.id]);
 await db.query("INSERT INTO pvp_rooms(id,code,app_id,game_id,status,capacity,practice,entry_minor,fee_bps,terms,scope,players,rule_version,seed_enc,last_tick_at,expires_at,result) VALUES($1,$2,$3,'golf','settled',2,false,100,500,'{}','{}','[]','fixture','fixture',0,1,$4)",[room,'PORTAL_'+label,item.app.id,JSON.stringify({fee_minor:'10',payouts:[{external_user_id:'shared_external_user',payout_minor:'190'}]})]);
 const response={state:'SUCCEEDED',secret_base64:'fixture-sensitive',nested:{access_token:'fixture-sensitive'}};
 await db.query("INSERT INTO gp_operations(id,app_id,aggregate_id,path,raw_body,state,response) VALUES($1,$2,$3,'/fixture','{}','SUCCEEDED',$4)",['fixture_op_'+label,item.app.id,cycle,response]);
 await db.query("INSERT INTO pvp_operations(id,app_id,room_id,path,raw_body,state,response) VALUES($1,$2,$3,'/fixture','{}','SUCCEEDED',$4)",['fixture_pvp_op_'+label,item.app.id,room,response]);
 await platform.audit('test_actor','fixture.audit',item.app.id,{secret_base64:'fixture-sensitive',label});
}
test('probability and PvP lists, operation receipts, audit and aggregate queries filter both sides before returning data',async()=>{
 await fixture(aa,'alpha');await fixture(ba,'beta');await platform.audit(b.user.id,'fixture.private_login',null,{partner_id:b.user.partner_id});
 const rounds=(await request('/api/partner/rounds',undefined,a.cookie)).data.rounds;assert.equal(rounds.length,2);assert(rounds.every(r=>r.app_id===aa.app.id));assert.deepEqual(new Set(rounds.map(r=>r.category)),new Set(['probability','competitive']));
 const operations=(await request('/api/partner/operations',undefined,a.cookie)).data.operations;assert.equal(operations.length,2);assert(operations.every(o=>o.app_id===aa.app.id));assert(!JSON.stringify(operations).includes('fixture-sensitive'));
 const events=(await request('/api/partner/audit',undefined,a.cookie)).data.events;assert(events.some(e=>e.action==='fixture.audit'));assert(events.every(e=>e.app_id===null?e.actor===a.user.id:[aa.app.id,ab.app.id].includes(e.app_id)));assert(!JSON.stringify(events).includes('fixture-sensitive'));
 const summary=(await request('/api/partner/overview',undefined,a.cookie)).data;assert.equal(summary.apps_count,2);assert.equal(summary.cycles_count,2);assert.equal(summary.fee_minor,'10');assert.equal(summary.pending_count,0);
 const foreignFilter=await request('/api/partner/rounds?partner_id='+b.user.partner_id,undefined,a.cookie);assert.equal(foreignFilter.status,404);
 const health=(await request('/api/partner/health',undefined,a.cookie)).data;assert.equal(health.partner_id,a.user.partner_id);assert.equal(health.production_enabled,false);assert.equal(health.wallet,'app_check_required');
});
test('requirePartnerApp is a reusable backend authorization boundary, not a frontend selector',async()=>{
 assert.equal((await portal.requirePartnerApp(a.user,aa.app.id)).id,aa.app.id);
 await assert.rejects(portal.requirePartnerApp(a.user,ba.app.id),{status:404,code:'NOT_FOUND'});
 await assert.rejects(portal.requirePartnerApp(null,aa.app.id),{status:401});
 await assert.rejects(portal.requirePartnerApp({role:'platform_admin',partner_id:a.user.partner_id},aa.app.id),{status:401});
});
test('expiry, logout and disabled account revoke portal access without changing admin sessions',async()=>{
 const extra=await request('/api/partner/login',{username:'alpha_portal',password});assert.equal(extra.status,200);
 assert.equal((await request('/api/partner/logout',{},extra.cookie)).status,200);assert.equal((await request('/api/partner/apps',undefined,extra.cookie)).status,401);assert.equal((await request('/api/partner/session',undefined,extra.cookie)).data.user,null);
 const token=a.cookie.split('=')[1];await db.query("UPDATE gp_partner_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[security.hash(token)]);assert.equal((await request('/api/partner/apps',undefined,a.cookie)).status,401);
 await db.query('UPDATE gp_partner_accounts SET active=false WHERE id=$1',[b.user.id]);assert.equal((await request('/api/partner/apps',undefined,b.cookie)).status,401);assert.equal((await request('/api/partner/login',{username:'beta_portal',password})).status,401);
 assert.equal((await request('/api/admin/session',undefined,adminCookie)).data.user.role,'platform_admin');
});
