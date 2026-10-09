import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash,randomBytes,scryptSync} from 'node:crypto';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {signedHeaders} from '../specs/examples/sdk-node.mjs';
import {ARENA_IDS} from '../shared/games.mjs';

// Exercise real boot/migrations over loopback HTTP. The configured public Origin
// is HTTPS, exactly as behind a TLS terminator; this is not a certificate test.
const root=resolve(import.meta.dirname,'..'),publicOrigin='https://runtime-isolation.example.invalid';
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
const suffix=process.pid+'_'+randomBytes(6).toString('hex'),names=['prod','sandbox','legacy'].map(kind=>'oasis_runtime_'+kind+'_'+suffix);
const made=[],children=new Set(),pools=[];
let admin,dir,production,productionDb,productionCookie,partnerCookie,partner,item,walletSentinel,walletPort,walletRequests=0;
const urlFor=name=>{const value=new URL(adminUrl);value.pathname='/'+name;return value.href;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function launch(name,environment,folder,extra={},provisionMaster=true){
 const port=await freePort();await mkdir(folder,{recursive:true,mode:0o700});
 if(environment==='production'&&provisionMaster)await writeFile(join(folder,'master.key'),randomBytes(32),{mode:0o600,flag:'wx'});
 const child=spawn(process.execPath,['--import','tsx','server/index.mjs'],{cwd:root,env:{...process.env,OASIS_DATABASE_URL:urlFor(name),OASIS_LOCAL_DIR:folder,OASIS_ENVIRONMENT:environment,OASIS_PRODUCTION_ADMISSION_ENABLED:'0',OASIS_PUBLIC_ORIGIN:publicOrigin,OASIS_START_WALLET:'0',OASIS_API_PORT:String(port),OASIS_WALLET_PORT:String(walletPort),OASIS_REFERENCE_WALLET_URL:'http://127.0.0.1:'+walletPort,OASIS_WALLET_ALLOWED_ORIGINS:'http://127.0.0.1:38998',...extra},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',b=>logs+=String(b));child.stderr.on('data',b=>logs+=String(b));
 const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 const instance={child,ended,get logs(){return logs;},base:'http://127.0.0.1:'+port,folder};children.add(instance);return instance;
}
async function ready(instance){
 for(let i=0;i<150;i++){if(instance.child.exitCode!==null||instance.child.signalCode)throw Error('Runtime exited before readiness: '+instance.logs);try{const response=await fetch(instance.base+'/health',{signal:AbortSignal.timeout(400)});if(response.ok)return await response.json();}catch{}await sleep(60);}
 throw Error('Runtime readiness timeout: '+instance.logs);
}
async function stop(instance){if(!instance)return;if(instance.child.exitCode===null&&!instance.child.signalCode){instance.child.kill('SIGTERM');const timer=setTimeout(()=>instance.child.kill('SIGKILL'),4000);try{await instance.ended;}finally{clearTimeout(timer);}}children.delete(instance);}
async function rejectBoot(instance,expected=/DATABASE_ENVIRONMENT_MISMATCH/){
 const timer=setTimeout(()=>instance.child.kill('SIGKILL'),10000);let result;try{result=await instance.ended;}finally{clearTimeout(timer);children.delete(instance);}
 assert.notEqual(result.code,0);assert.notEqual(result.signal,'SIGKILL','invalid runtime must fail on its own');assert.match(instance.logs,expected);return result;
}
async function request(instance,path,body,cookie,method=body===undefined?'GET':'POST',headers={}){
 const response=await fetch(instance.base+path,{method,headers:{Origin:publicOrigin,...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
 return{status:response.status,body:await response.json(),headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function count(db,table){return Number((await db.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);}
before(async()=>{
 admin=new pg.Pool({connectionString:adminUrl.href,max:2});
 for(const name of names){assert.match(name,/^oasis_runtime_(prod|sandbox|legacy)_\d+_[a-f0-9]{12}$/);await admin.query(`CREATE DATABASE "${name}"`);made.push(name);}
 dir=await mkdtemp(join(tmpdir(),'oasis-runtime-'));
 walletSentinel=createServer((req,res)=>{walletRequests++;res.writeHead(503);res.end('Reference wallet must not be used');});await new Promise(r=>walletSentinel.listen(0,'127.0.0.1',r));walletPort=walletSentinel.address().port;
 productionDb=new pg.Pool({connectionString:urlFor(names[0]),max:3});pools.push(productionDb);assert.equal((await productionDb.query('SELECT current_database() name')).rows[0].name,names[0]);
 production=await launch(names[0],'production',join(dir,'production'));const health=await ready(production);assert.equal(health.environment,'production');
});
after(async()=>{
 const errors=[];for(const child of children)try{await stop(child);}catch(e){errors.push(e);}
 if(walletSentinel?.listening)try{await new Promise(r=>walletSentinel.close(r));}catch(e){errors.push(e);}
 for(const db of pools)try{await db.end();}catch(e){errors.push(e);}
 for(const name of made)try{await dropOwnedTestDatabase(admin,name,{created:true});}catch(e){errors.push(e);}
 await admin?.end();if(dir)await rm(dir,{recursive:true,force:true});if(errors.length)throw new AggregateError(errors,'Runtime isolation cleanup failed');
});

test('production boots with independent master key and an admin, without demo apps or reference balances',async()=>{
 assert.equal((await productionDb.query('SELECT environment FROM gp_runtime_identity')).rows[0].environment,'production');
 assert.equal(await count(productionDb,'gp_admins'),1);
 for(const table of ['gp_apps','gp_keys','gp_players','gp_player_sessions','gp_player_app_ids','wallet_scopes','wallet_users','wallet_keys','wallet_ledger'])assert.equal(await count(productionDb,table),0,table+' must be empty');
 const master=await readFile(join(production.folder,'master.key'));assert.equal(master.length,32);assert.equal((await stat(join(production.folder,'master.key'))).mode&0o777,0o600);
 await assert.rejects(readFile(join(production.folder,'sandbox-app-credentials.json')),e=>e.code==='ENOENT');assert.equal(walletRequests,0);
 const localCredentials=JSON.parse(await readFile(join(production.folder,'development-credentials.json'),'utf8'));
 const login=await request(production,'/api/admin/login',localCredentials);assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/; Secure/);productionCookie=login.cookie;
 const session=await request(production,'/api/admin/session',undefined,productionCookie);assert.equal(session.status,200);assert.equal(session.body.environment,'production');assert.equal(session.body.user.id,login.body.user.id);
 const overview=await request(production,'/api/admin/overview',undefined,productionCookie);assert.equal(overview.status,200);assert.equal(overview.body.wallet_status,'app_scoped');
});

test('production external-wallet App starts paused with released competitive games and zero test money or wallet keys',async()=>{
 const password='Runtime-fixture-only-2026!',created=await request(production,'/api/admin/partner-accounts',{name:'Runtime partner',username:'runtime_partner',password},productionCookie);assert.equal(created.status,201);partner=created.body.account;
 const login=await request(production,'/api/partner/login',{username:partner.username,password});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/; Secure/);partnerCookie=login.cookie;
 const createdApp=await request(production,'/api/partner/apps',{name:'Production isolation fixture',wallet_provider:'external'},partnerCookie);assert.equal(createdApp.status,201);item=createdApp.body;
 assert.equal(item.app.environment,'production');assert.equal(item.app.status,'paused');assert.equal(item.app.wallet_url,'');assert.deepEqual([...item.app.game_ids].sort(),[...ARENA_IDS].sort());assert.equal(item.app.game_ids.length,ARENA_IDS.length);
 const actual=(await productionDb.query('SELECT * FROM gp_apps WHERE id=$1',[item.app.id])).rows[0];assert.equal(actual.status,'paused');assert.equal(actual.environment,'production');
 assert.equal((await productionDb.query("SELECT count(*)::int n FROM gp_keys WHERE app_id=$1 AND direction='partner-to-platform'",[item.app.id])).rows[0].n,1);
 assert.equal((await productionDb.query("SELECT count(*)::int n FROM gp_keys WHERE direction='platform-to-wallet'")).rows[0].n,0);
 for(const table of ['wallet_scopes','wallet_users','wallet_keys','wallet_ledger'])assert.equal(await count(productionDb,table),0);
 const integration=await request(production,`/api/partner/apps/${item.app.id}/integration`,undefined,partnerCookie);assert.equal(integration.status,200);assert.equal(integration.body.wallet.mode,'unconfigured');assert.equal(integration.body.wallet.can_configure,true);assert.equal(walletRequests,0);
 const missingProbeUser=await request(production,`/api/partner/apps/${item.app.id}/integration/probe`,{},partnerCookie);assert.equal(missingProbeUser.status,400);assert.equal(missingProbeUser.body.error.code,'INVALID_USER');assert.equal(walletRequests,0);
});

test('production rejects HTTP loopback hosts and preserves the deployed four-column launch-intent insert',async()=>{
 const loopback=await request(production,`/api/partner/apps/${item.app.id}/integration/origins`,{allowed_origins:['http://127.0.0.1:8800']},partnerCookie);
 assert.equal(loopback.status,400);assert.equal(loopback.body.error.code,'INVALID_ORIGIN');
 const columns=(await productionDb.query("SELECT column_name FROM information_schema.columns WHERE table_name='gp_launch_intents' ORDER BY ordinal_position")).rows.map(row=>row.column_name);
 assert.deepEqual(columns,['app_id','request_id','digest','response_enc']);
 const db=await productionDb.connect();
 try{await db.query('BEGIN');await db.query('INSERT INTO gp_launch_intents VALUES($1,$2,$3,$4)',[item.app.id,'rollback_arity_probe','digest','cipher']);await db.query('ROLLBACK');}
 finally{await db.query('ROLLBACK').catch(()=>{});db.release();}
});

test('both admin and partner activation stay closed and console launch cannot bypass the production backend',async()=>{
 for(const[role,cookie]of [['admin',productionCookie],['partner',partnerCookie]]){
  const path=`/api/${role}/apps/${item.app.id}`;
  const activated=await request(production,path,{status:'active'},cookie,'PATCH');assert.equal(activated.status,409);assert.equal(activated.body.error.code,'PRODUCTION_ACCEPTANCE_REQUIRED');
  const launched=await request(production,path+'/launch',{game_id:'match'},cookie);assert.equal(launched.status,403);assert.equal(launched.body.error.code,'PRODUCTION_LAUNCH_REQUIRES_PARTNER_BACKEND');
 }
 const actual=(await productionDb.query('SELECT status FROM gp_apps WHERE id=$1',[item.app.id])).rows[0];assert.equal(actual.status,'paused');assert.equal(await count(productionDb,'gp_sessions'),0);assert.equal(await count(productionDb,'gp_launch_intents'),0);
 const scope=Object.fromEntries(['partner_id','environment','wallet_scope_id','currency_id'].map(k=>[k,item.app[k]]));
 const body={...scope,app_id:item.app.id,request_id:'runtime_backend_launch',external_user_id:'real_identity_fixture',game_id:'match',locale:'en',host_platform:'web'};
 const headers=signedHeaders({keyId:item.credentials.key_id,secretBase64:item.credentials.secret_base64,method:'POST',path:'/v1/sessions',rawBody:JSON.stringify(body),requestId:body.request_id});
 const signed=await request(production,'/v1/sessions',body,null,'POST',headers);assert.equal(signed.status,403);assert.equal(signed.body.message,'PLAYER_BFF_REQUIRED');assert.equal(await count(productionDb,'gp_sessions'),0);
});

test('platform player cookie, per-App identity and BFF resume reject forged, cross-App and expired access without test credits',async()=>{
 const appTwo=(await request(production,'/api/partner/apps',{name:'Second production App',wallet_provider:'external'},partnerCookie)).body.app;
 const password='Player-fixture-only-2026!';
 const blockedRegister=await request(production,'/api/player/register',{app_id:item.app.id,username:'new_player',password});
 assert.equal(blockedRegister.status,409);assert.equal(blockedRegister.body.error.code,'PRODUCTION_ACCEPTANCE_REQUIRED');assert.equal(await count(productionDb,'gp_players'),0);
 // These records stand for previously accepted obligations, not accounts
 // created by a closed production admission path.
 const players={};
 for(const username of ['player_alpha','player_bravo','player_unbound']){
  const playerId='accepted_'+username,salt=randomBytes(16).toString('hex');players[username]=playerId;
  await productionDb.query('INSERT INTO gp_players(id,username,salt,password_hash) VALUES($1,$2,$3,$4)',[playerId,username,salt,scryptSync(password,salt,64).toString('hex')]);
 }
 const acceptedIds={
  accepted_alpha_one:'player_'+randomBytes(16).toString('hex'),
  accepted_alpha_two:'player_'+randomBytes(16).toString('hex'),
  accepted_bravo_one:'player_'+randomBytes(16).toString('hex'),
  accepted_bravo_two:'player_'+randomBytes(16).toString('hex')
 };
 for(const [sessionId,appId,playerId] of [
  ['accepted_alpha_one',item.app.id,players.player_alpha],
  ['accepted_alpha_two',appTwo.id,players.player_alpha],
  ['accepted_bravo_one',item.app.id,players.player_bravo],
  ['accepted_bravo_two',appTwo.id,players.player_bravo]
 ])await productionDb.query('INSERT INTO gp_sessions(id,app_id,external_user_id,game_id,host_origin,player_id) VALUES($1,$2,$3,$4,$5,$6)',[sessionId,appId,acceptedIds[sessionId],'match',publicOrigin,playerId]);
 const storedPlayer=(await productionDb.query("SELECT salt,password_hash FROM gp_players WHERE username='player_alpha'")).rows[0];assert.notEqual(storedPlayer.password_hash,password);assert.match(storedPlayer.password_hash,/^[a-f0-9]{128}$/);
 const playerLogin=async(username,appId)=>request(production,'/api/player/login',{username,password,app_id:appId});
 const unbound=await playerLogin('player_unbound',item.app.id);assert.equal(unbound.status,409);assert.equal(unbound.body.error.code,'PRODUCTION_ACCEPTANCE_REQUIRED');
 assert.equal(await count(productionDb,'gp_player_app_ids'),0);assert.equal(await count(productionDb,'gp_player_sessions'),0);
 const alphaOne=await playerLogin('player_alpha',item.app.id),alphaAgain=await playerLogin('player_alpha',item.app.id),alphaTwo=await playerLogin('player_alpha',appTwo.id),bravoOne=await playerLogin('player_bravo',item.app.id),bravoTwo=await playerLogin('player_bravo',appTwo.id);
 for(const login of [alphaOne,alphaAgain,alphaTwo,bravoOne,bravoTwo]){assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/^__Host-oasis_player=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict;/);assert.match(login.body.external_user_id,/^player_[a-f0-9]{32}$/);assert.equal('token' in login.body,false,'browser JSON must not expose the login bearer');}
 const sessionRead=await request(production,'/api/player/session',undefined,alphaOne.cookie);assert.equal(sessionRead.status,200);assert.equal(sessionRead.body.csrf_token,alphaOne.body.csrf_token);assert.equal('token' in sessionRead.body,false);
 assert.equal(alphaOne.body.external_user_id,alphaAgain.body.external_user_id,'same player/App mapping must be stable');
 assert.notEqual(alphaOne.body.external_user_id,alphaTwo.body.external_user_id,'same player gets different IDs in different Apps');
 assert.notEqual(alphaOne.body.external_user_id,bravoOne.body.external_user_id,'different players get different IDs');
 assert.notEqual(bravoOne.body.external_user_id,bravoTwo.body.external_user_id,'second player also gets a separate ID per App');
 assert.notEqual(alphaTwo.body.external_user_id,bravoTwo.body.external_user_id,'players stay distinct inside the second App');
 assert.equal((await productionDb.query('SELECT count(*)::int n FROM gp_player_app_ids')).rows[0].n,4);
 const rawCookie=alphaOne.cookie.split('=')[1],storedHash=createHash('sha256').update(rawCookie).digest('hex');
 assert.equal((await productionDb.query('SELECT token_hash FROM gp_player_sessions WHERE token_hash=$1',[storedHash])).rows[0].token_hash,storedHash);
 assert.equal(await count(productionDb,'wallet_users'),0);assert.equal(await count(productionDb,'wallet_ledger'),0);
 const launchBody={app_id:item.app.id,request_id:'player_new_closed',game_id:'match',locale:'en',host_platform:'web'};
 const playerLaunch=(body,cookie,csrf,extra={})=>request(production,'/api/player/launch',body,cookie,'POST',{...(csrf?{'x-oasis-csrf':csrf}:{}),...extra});
 const missingCsrf=await playerLaunch(launchBody,alphaOne.cookie);assert.equal(missingCsrf.status,403);assert.equal(missingCsrf.body.error.code,'CSRF_FORBIDDEN');
 const foreignOrigin=await playerLaunch(launchBody,alphaOne.cookie,alphaOne.body.csrf_token,{Origin:'https://foreign.example.invalid'});assert.equal(foreignOrigin.status,403);assert.equal(foreignOrigin.body.error.code,'ORIGIN_FORBIDDEN');
 const forged=await playerLaunch({...launchBody,external_user_id:bravoOne.body.external_user_id},alphaOne.cookie,alphaOne.body.csrf_token);assert.equal(forged.status,400);assert.equal(forged.body.error.code,'INVALID_REQUEST');
 const closed=await playerLaunch(launchBody,alphaOne.cookie,alphaOne.body.csrf_token);assert.equal(closed.status,409);assert.equal(closed.body.error.code,'PRODUCTION_ACCEPTANCE_REQUIRED');assert.equal(await count(productionDb,'gp_sessions'),4);
 const hmacResume={partner_id:item.app.partner_id,app_id:item.app.id,environment:item.app.environment,wallet_scope_id:item.app.wallet_scope_id,currency_id:item.app.currency_id,request_id:'hmac_resume_denied',external_user_id:alphaOne.body.external_user_id,game_id:'match',locale:'en',host_platform:'web',resume_session_id:'accepted_alpha_one'};
 const hmacHeaders=signedHeaders({keyId:item.credentials.key_id,secretBase64:item.credentials.secret_base64,method:'POST',path:'/v1/sessions',rawBody:JSON.stringify(hmacResume),requestId:hmacResume.request_id});
 const hmacDenied=await request(production,'/v1/sessions',hmacResume,null,'POST',hmacHeaders);assert.equal(hmacDenied.status,403);assert.equal(hmacDenied.body.message,'PLAYER_BFF_REQUIRED');
 const resumeOne={...launchBody,request_id:'player_resume_one',resume_session_id:'accepted_alpha_one'};
 const stolen=await playerLaunch(resumeOne,bravoOne.cookie,bravoOne.body.csrf_token);assert.equal(stolen.status,403);assert.equal(stolen.body.error.code,'SCOPE_FORBIDDEN');
 const wrongApp=await playerLaunch({...resumeOne,app_id:appTwo.id,request_id:'player_cross_app'},alphaTwo.cookie,alphaTwo.body.csrf_token);assert.equal(wrongApp.status,403);assert.equal(wrongApp.body.error.code,'SCOPE_FORBIDDEN');
 const resumed=await playerLaunch(resumeOne,alphaOne.cookie,alphaOne.body.csrf_token);assert.equal(resumed.status,201);assert.equal(resumed.body.session_id,'accepted_alpha_one');
 const sameReplay=await playerLaunch(resumeOne,alphaOne.cookie,alphaOne.body.csrf_token);assert.equal(sameReplay.status,201);assert.deepEqual(sameReplay.body,resumed.body);
 const replayByOther=await playerLaunch(resumeOne,bravoOne.cookie,bravoOne.body.csrf_token);assert.equal(replayByOther.status,403);assert.equal(replayByOther.body.error.code,'SCOPE_FORBIDDEN');
 const resumedTwo=await playerLaunch({...resumeOne,app_id:appTwo.id,request_id:'player_resume_two',resume_session_id:'accepted_alpha_two'},alphaTwo.cookie,alphaTwo.body.csrf_token);assert.equal(resumedTwo.status,201);assert.equal(resumedTwo.body.session_id,'accepted_alpha_two');
 const exchanged=await request(production,'/v1/launch/exchange',{launch_code:resumed.body.launch_code,client_instance_id:'player_fixture_client',host_origin:publicOrigin,game_id:'match'});assert.equal(exchanged.status,200);assert.equal(exchanged.body.external_user_id,alphaOne.body.external_user_id);
 await productionDb.query("UPDATE gp_player_sessions SET expires_at=now()-interval '1 minute' WHERE player_id=$1",[alphaOne.body.player.id]);
 const expired=await playerLaunch({...resumeOne,request_id:'player_expired_login'},alphaOne.cookie,alphaOne.body.csrf_token);assert.equal(expired.status,401);assert.equal(expired.body.error.code,'LOGIN_REQUIRED');
 const logoutMissingCsrf=await request(production,'/api/player/logout',{},bravoTwo.cookie);assert.equal(logoutMissingCsrf.status,403);
 const logout=await request(production,'/api/player/logout',{},bravoTwo.cookie,'POST',{'x-oasis-csrf':bravoTwo.body.csrf_token});assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
 assert.equal((await request(production,'/api/player/session',undefined,bravoTwo.cookie)).status,401);
 assert.equal((await request(production,'/api/player/session',undefined,bravoOne.cookie)).status,200,'another session remains valid');
 await stop(production);production=await launch(names[0],'production',join(dir,'production'),{},false);assert.equal((await ready(production)).environment,'production');
 const afterRestart=await playerLogin('player_alpha',item.app.id);assert.equal(afterRestart.status,200);assert.equal(afterRestart.body.external_user_id,alphaOne.body.external_user_id,'mapping survives a server restart');
 assert.equal(await count(productionDb,'wallet_users'),0);assert.equal(await count(productionDb,'wallet_ledger'),0);assert.equal(walletRequests,0);
});

test('concurrent player login and accepted-session launch use player-before-App lock order',async()=>{
 const player=(await productionDb.query("SELECT id FROM gp_players WHERE username='player_alpha'")).rows[0];
 const password='Player-fixture-only-2026!';
 const loginBody={username:'player_alpha',password,app_id:item.app.id};
 const existing=await request(production,'/api/player/login',loginBody);assert.equal(existing.status,200);
 const blocker=await productionDb.connect();let resumePromise,observedWait=false,appAvailable=false;
 try{
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM gp_players WHERE id=$1 FOR UPDATE',[player.id]);
  const resumeBody={app_id:item.app.id,request_id:'player_lock_order_resume',game_id:'match',locale:'en',host_platform:'web',resume_session_id:'accepted_alpha_one'};
  resumePromise=request(production,'/api/player/launch',resumeBody,existing.cookie,'POST',{'x-oasis-csrf':existing.body.csrf_token}).catch(error=>({error}));
  for(let attempt=0;attempt<100;attempt++){
   const waiting=await productionDb.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%gp_players%' AND query LIKE '%FOR SHARE%' LIMIT 1");
   if(waiting.rowCount){observedWait=true;break;}await sleep(20);
  }
  const observer=await productionDb.connect();
  try{
   await observer.query('BEGIN');
   await observer.query('SELECT id FROM gp_apps WHERE id=$1 FOR UPDATE NOWAIT',[item.app.id]);
   appAvailable=true;
  }catch(error){if(error.code!=='55P03')throw error;}
  finally{await observer.query('ROLLBACK');observer.release();}
  const concurrentLogin=request(production,'/api/player/login',loginBody).catch(error=>({error}));
  await sleep(30);
  await blocker.query('COMMIT');
  const [resumed,loggedIn]=await Promise.all([resumePromise,concurrentLogin]);
  assert.equal(resumed.status,201,JSON.stringify(resumed));assert.equal(resumed.body.session_id,'accepted_alpha_one');
  assert.equal(loggedIn.status,200,JSON.stringify(loggedIn));
 }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();if(resumePromise)await resumePromise;}
 assert.equal(observedWait,true,'launch must reach the player row lock while it is held');
 assert.equal(appAvailable,true,'launch must not hold the App row while waiting for the player');
});

test('production refuses a stored HTTP loopback host even for an accepted-session resume',async()=>{
 const login=await request(production,'/api/player/login',{username:'player_alpha',password:'Player-fixture-only-2026!',app_id:item.app.id});assert.equal(login.status,200);
 await productionDb.query('UPDATE gp_apps SET allowed_origins=$2 WHERE id=$1',[item.app.id,JSON.stringify(['http://127.0.0.1:8800'])]);
 try{
  const result=await request(production,'/api/player/launch',{app_id:item.app.id,request_id:'production_loopback_resume',game_id:'match',locale:'en',host_platform:'web',host_origin:'http://127.0.0.1:8800',resume_session_id:'accepted_alpha_one'},login.cookie,'POST',{'x-oasis-csrf':login.body.csrf_token});
  assert.equal(result.status,400);assert.equal(result.body.error.code,'INVALID_ORIGIN');
 }finally{await productionDb.query('UPDATE gp_apps SET allowed_origins=$2 WHERE id=$1',[item.app.id,'[]']);}
});

test('production rejects even allowlisted loopback HTTP wallet without persisting credentials or binding',async()=>{
 const result=await request(production,`/api/partner/apps/${item.app.id}/integration/wallet`,{wallet_url:'http://127.0.0.1:38998',wallet_key_id:'runtime_http_wallet',wallet_secret_base64:randomBytes(32).toString('base64')},partnerCookie);
 assert.equal(result.status,400);assert.equal(result.body.error.code,'WALLET_HTTPS_REQUIRED');assert.equal(await count(productionDb,'gp_wallet_bindings'),0);
 assert.equal((await productionDb.query("SELECT count(*)::int n FROM gp_keys WHERE direction='platform-to-wallet'")).rows[0].n,0);assert.equal((await productionDb.query('SELECT wallet_url FROM gp_apps WHERE id=$1',[item.app.id])).rows[0].wallet_url,'');assert.equal(walletRequests,0);
});

test('generic production env approval is rejected before boot and external Apps remain closed',async()=>{
 const newApp=(await request(production,'/api/partner/apps',{name:'Wallet preflight fixture',wallet_provider:'external'},partnerCookie)).body.app;
 await productionDb.query('UPDATE gp_apps SET allowed_origins=$2 WHERE id=$1',[newApp.id,JSON.stringify([publicOrigin])]);
 const beforeApps=(await productionDb.query('SELECT * FROM gp_apps ORDER BY id')).rows,master=await readFile(join(production.folder,'master.key'));
 const beforePlayers=await count(productionDb,'gp_players'),beforeSessions=await count(productionDb,'gp_sessions');
 await stop(production);
 const invalid=await launch(names[0],'production',join(dir,'production'),{OASIS_PRODUCTION_ADMISSION_ENABLED:'1'},false);
 await rejectBoot(invalid,/GENERIC_PRODUCTION_ADMISSION_FORBIDDEN/);
 assert.deepEqual((await productionDb.query('SELECT * FROM gp_apps ORDER BY id')).rows,beforeApps);
 assert.deepEqual(await readFile(join(production.folder,'master.key')),master);
 assert.equal(await count(productionDb,'gp_players'),beforePlayers);assert.equal(await count(productionDb,'gp_sessions'),beforeSessions);
 production=await launch(names[0],'production',join(dir,'production'),{OASIS_WALLET_ALLOWED_ORIGINS:'https://wallet.example.invalid'},false);assert.equal((await ready(production)).environment,'production');
 const bound=await request(production,`/api/partner/apps/${newApp.id}/integration/wallet`,{
  wallet_url:'https://wallet.example.invalid',wallet_key_id:'unreachable_wallet_key',wallet_secret_base64:randomBytes(32).toString('base64')
 },partnerCookie);assert.equal(bound.status,200);
 for(const status of ['paused','active']){
  await productionDb.query('UPDATE gp_apps SET status=$2 WHERE id=$1',[newApp.id,status]);
  const registration=await request(production,'/api/player/register',{app_id:newApp.id,username:'wallet_player',password:'Wallet-player-fixture-2026!'});
  assert.equal(registration.status,409);assert.equal(registration.body.error.code,'PRODUCTION_ACCEPTANCE_REQUIRED');
  const login=await request(production,'/api/player/login',{app_id:newApp.id,username:'player_alpha',password:'Player-fixture-only-2026!'});
  assert.equal(login.status,409);assert.equal(login.body.error.code,'PRODUCTION_ACCEPTANCE_REQUIRED');
 }
 assert.equal((await productionDb.query('SELECT count(*)::int n FROM gp_player_app_ids WHERE app_id=$1',[newApp.id])).rows[0].n,0);
 assert.equal((await productionDb.query('SELECT count(*)::int n FROM gp_sessions WHERE app_id=$1',[newApp.id])).rows[0].n,0);
 assert.equal((await productionDb.query('SELECT count(*)::int n FROM gp_launch_intents WHERE app_id=$1',[newApp.id])).rows[0].n,0);
 assert.equal(await count(productionDb,'gp_players'),beforePlayers);assert.equal(await count(productionDb,'wallet_users'),0);assert.equal(await count(productionDb,'wallet_ledger'),0);assert.equal(walletRequests,0);
 await stop(production);production=await launch(names[0],'production',join(dir,'production'),{},false);assert.equal((await ready(production)).environment,'production');
});

test('sandbox cannot reopen a production database or replace its identity, app, or master key',async()=>{
 const master=await readFile(join(production.folder,'master.key')),apps=(await productionDb.query('SELECT * FROM gp_apps ORDER BY id')).rows;
 await stop(production);
 const wrong=await launch(names[0],'sandbox',join(dir,'wrong-sandbox'));await rejectBoot(wrong);
 assert.equal((await productionDb.query('SELECT environment FROM gp_runtime_identity')).rows[0].environment,'production');assert.deepEqual((await productionDb.query('SELECT * FROM gp_apps ORDER BY id')).rows,apps);assert.deepEqual(await readFile(join(production.folder,'master.key')),master);
 assert.equal(await count(productionDb,'wallet_users'),0);assert.equal(await count(productionDb,'gp_admins'),1);
});

test('production cannot promote a sandbox database and does not replace sandbox identity or test balances',async()=>{
 const sandboxDb=new pg.Pool({connectionString:urlFor(names[1]),max:2});pools.push(sandboxDb);
 const sandbox=await launch(names[1],'sandbox',join(dir,'sandbox'));assert.equal((await ready(sandbox)).environment,'sandbox');
 const credentials=JSON.parse(await readFile(join(sandbox.folder,'development-credentials.json'),'utf8'));
 const loggedIn=await request(sandbox,'/api/admin/login',credentials);assert.equal(loggedIn.status,200);
 const session=await request(sandbox,'/api/admin/session',undefined,loggedIn.cookie);assert.equal(session.status,200);assert.equal(session.body.environment,'sandbox');assert.equal(session.body.user.id,loggedIn.body.user.id);
 const apps=(await sandboxDb.query('SELECT * FROM gp_apps ORDER BY id')).rows,users=(await sandboxDb.query('SELECT * FROM wallet_users ORDER BY scope_id,external_user_id')).rows;
 assert(apps.length>0);assert(apps.every(a=>a.environment==='sandbox'));assert(users.length>0);
 const sandboxMaster=await readFile(join(sandbox.folder,'master.key'));assert.notDeepEqual(sandboxMaster,await readFile(join(production.folder,'master.key')));
 await stop(sandbox);
 const wrong=await launch(names[1],'production',join(dir,'wrong-production'));await rejectBoot(wrong);
 assert.equal((await sandboxDb.query('SELECT environment FROM gp_runtime_identity')).rows[0].environment,'sandbox');assert.deepEqual((await sandboxDb.query('SELECT * FROM gp_apps ORDER BY id')).rows,apps);assert.deepEqual((await sandboxDb.query('SELECT * FROM wallet_users ORDER BY scope_id,external_user_id')).rows,users);
});

test('failed first production boot against legacy sandbox apps rolls back creation of runtime identity',async()=>{
 const legacyDb=new pg.Pool({connectionString:urlFor(names[2]),max:2});pools.push(legacyDb);
 await legacyDb.query(await readFile(new URL('../server/schema.sql',import.meta.url),'utf8'));
 await legacyDb.query("INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,status) VALUES('legacy_app','Preserve legacy app','legacy_partner','sandbox','legacy_wallet','paused')");
 assert.equal((await legacyDb.query("SELECT to_regclass('public.gp_runtime_identity') AS name")).rows[0].name,null);
 const wrong=await launch(names[2],'production',join(dir,'legacy-attempt'));await rejectBoot(wrong);
 assert.equal((await legacyDb.query("SELECT to_regclass('public.gp_runtime_identity') AS name")).rows[0].name,null);
 assert.equal((await legacyDb.query('SELECT environment FROM gp_apps WHERE id=$1',['legacy_app'])).rows[0].environment,'sandbox');assert.equal(await count(legacyDb,'gp_admins'),0);assert.equal(await count(legacyDb,'gp_keys'),0);
});

test('production missing its pre-provisioned master key fails without inventing a replacement key',async()=>{
 const original=await readFile(join(production.folder,'master.key')),folder=join(dir,'missing-master');
 const wrong=await launch(names[0],'production',folder,{},false);await rejectBoot(wrong,/PRODUCTION_MASTER_KEY_MISSING/);
 await assert.rejects(readFile(join(folder,'master.key')),e=>e.code==='ENOENT');assert.deepEqual(await readFile(join(production.folder,'master.key')),original);
 assert.equal((await productionDb.query('SELECT environment FROM gp_runtime_identity')).rows[0].environment,'production');assert.equal(await count(productionDb,'gp_apps'),3);
});
