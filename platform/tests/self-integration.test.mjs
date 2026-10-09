import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {OasisClient} from '../specs/examples/sdk-node.mjs';
import {RELEASED_IDS} from '../shared/games.mjs';

const uid=p=>p+'_'+randomBytes(10).toString('hex'),base='http://127.0.0.1:19197',wallet='http://127.0.0.1:19198',proxyOrigin='http://127.0.0.1:19199';
const dbname='oasis_self_test_'+process.pid+'_'+randomBytes(5).toString('hex'),root=resolve(import.meta.dirname,'..');
const adminURL=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
assert.ok(['postgres:','postgresql:'].includes(adminURL.protocol),'LOCAL_POSTGRES_REQUIRED');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(adminURL.hostname),'LOCAL_POSTGRES_REQUIRED');
assert.equal(adminURL.search,'','POSTGRES_URL_OVERRIDES_FORBIDDEN');assert.equal(adminURL.hash,'','POSTGRES_URL_OVERRIDES_FORBIDDEN');adminURL.pathname='/postgres';
const databaseURL=new URL(adminURL);databaseURL.pathname='/'+dbname;
let admin,db,dir,child,proxy,cookie,partnerA,partnerB,app,logs='',dropCapture=false,observedCapture=false,created=false;
const evidence={checks:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label,ms=20000){for(const until=Date.now()+ms;Date.now()<until;){const v=await fn();if(v)return v;await sleep(80);}throw Error('Timed out: '+label);}
async function start(){child=spawn(process.execPath,['--import','tsx','server/index.mjs'],{cwd:root,env:{...process.env,OASIS_DATABASE_URL:databaseURL.href,OASIS_LOCAL_DIR:dir,OASIS_PUBLIC_ORIGIN:base,OASIS_API_PORT:'19197',OASIS_WALLET_PORT:'19198',OASIS_REFERENCE_WALLET_URL:wallet,OASIS_WALLET_ALLOWED_ORIGINS:proxyOrigin},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);await wait(async()=>{if(child.exitCode!==null)throw Error(logs);try{return(await fetch(base+'/health')).ok;}catch{return false;}},'API startup');}
async function stop(){if(child&&child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await end;}}
async function request(path,body,auth=cookie,method=body===undefined?'GET':'POST'){
 const r=await fetch(base+path,{method,headers:{origin:base,'content-type':'application/json',...(auth?{cookie:auth}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
const scope=a=>({partner_id:a.partner_id,app_id:a.id,environment:a.environment,wallet_scope_id:a.wallet_scope_id,currency_id:a.currency_id});
const client=item=>new OasisClient({baseUrl:base,keyId:item.credentials.key_id,secretBase64:item.credentials.secret_base64,scope:scope(item.app)});
before(async()=>{
 admin=new pg.Pool({connectionString:adminURL.href});await admin.query(`CREATE DATABASE "${dbname}"`);created=true;db=new pg.Pool({connectionString:databaseURL.href});dir=await mkdtemp(join(tmpdir(),'oasis-self-'));
 proxy=createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);if(dropCapture&&req.url.startsWith('/wallet/v1/operations/')){res.destroy();return;}
  const r=await fetch(wallet+req.url,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:Buffer.concat(chunks)}),raw=await r.text();
  if(dropCapture&&req.url==='/wallet/v1/matches/capture'){observedCapture=true;res.destroy();return;}res.writeHead(r.status,{'content-type':'application/json'});res.end(raw);
 }catch{res.destroy();}});await new Promise(r=>proxy.listen(19199,'127.0.0.1',r));await start();
 const credentials=JSON.parse(await readFile(join(dir,'development-credentials.json'),'utf8'));const login=await request('/api/admin/login',credentials,null);assert.equal(login.status,200);cookie=login.cookie;
 const makePartner=async name=>{const username=uid(name),password=randomBytes(18).toString('base64url');const created=await request('/api/admin/partner-accounts',{name,username,password});assert.equal(created.status,201);const login=await request('/api/partner/login',{username,password},null);assert.equal(login.status,200);return{...created.body.account,cookie:login.cookie};};
 partnerA=await makePartner('PartnerA');partnerB=await makePartner('PartnerB');app=(await request('/api/partner/apps',{name:'Independent acceptance fixture'},partnerA.cookie)).body;
});
after(async()=>{
 try{await stop();if(proxy?.listening)await new Promise(r=>proxy.close(r));await db?.end();if(created)await dropOwnedTestDatabase(admin,dbname,{created});}finally{await admin?.end();if(dir)await rm(dir,{recursive:true,force:true});}
 await mkdir(join(root,'review/phase-f'),{recursive:true});await writeFile(join(root,'review/phase-f/self-integration-tests.json'),JSON.stringify({at:new Date().toISOString(),...evidence,isolated_database_removed:true},null,2));
});
test('origin/game binding is checked before code consumption, while same-origin launch remains compatible',async()=>{
 const item=(await request('/api/partner/apps',{name:'Cross-origin fixture'},partnerA.cookie)).body,path=`/api/partner/apps/${item.app.id}/integration`;
 assert.equal((await request(path+'/origins',{allowed_origins:['http://127.0.0.1:8800']},partnerA.cookie)).status,200);
 assert.equal((await request(path+'/origins',{allowed_origins:['https://*.example.com']},partnerA.cookie)).status,400);
 const sdk=client(item);await assert.rejects(sdk.createSession({requestId:uid('launch'),externalUserId:'demo_player',gameId:'run',hostOrigin:'http://127.0.0.1:8802'}),e=>e.status===403);
 const launch=await sdk.createSession({requestId:uid('launch'),externalUserId:'demo_player',gameId:'run',locale:'zh',hostOrigin:'http://127.0.0.1:8800'}),exchange={launch_code:launch.launch_code,client_instance_id:uid('client'),host_origin:'http://127.0.0.1:8800',game_id:'run'};
 assert.equal((await request('/v1/launch/exchange',{...exchange,host_origin:base},null)).status,403);
 assert.equal((await request('/v1/launch/exchange',{...exchange,game_id:'tiger'},null)).status,403);
 const ok=await request('/v1/launch/exchange',exchange,null);assert.equal(ok.status,200);assert.equal(ok.body.host_origin,exchange.host_origin);assert.equal(ok.body.game_id,'run');
 assert.equal((await request('/v1/launch/exchange',exchange,null)).status,401);
 const local=await sdk.createSession({requestId:uid('local'),externalUserId:'demo_player',gameId:'tiger'});assert.equal((await request('/v1/launch/exchange',{launch_code:local.launch_code,client_instance_id:uid('client')},null)).status,200);
 evidence.checks.push('code origin/game binding before consume; hostile origin rejected; single-use; legacy same-origin launch');
});
test('integration config, wallet probe and check history enforce partner ownership and CSRF',async()=>{
 const path=`/api/partner/apps/${app.app.id}/integration`;
 for(const suffix of ['', '/checks'])assert.equal((await request(path+suffix,undefined,partnerB.cookie)).status,404);
 for(const [suffix,body]of [['/origins',{allowed_origins:[]}],['/probe',{}],['/checks',{request_id:uid('check'),confirm_sandbox_wallet:true}]])assert.equal((await request(path+suffix,body,partnerB.cookie)).status,404);
 assert.equal((await request(`/api/admin/apps/${app.app.id}/integration`,undefined,partnerA.cookie)).status,401);
 const denied=await fetch(base+path+'/origins',{method:'POST',headers:{origin:'https://evil.invalid',cookie:partnerA.cookie,'content-type':'application/json'},body:'{"allowed_origins":[]}'});assert.equal(denied.status,403);
 const status=(await request(path,undefined,partnerA.cookie));assert.equal(status.status,200);assert.equal(status.body.scope.partner_id,partnerA.partner_id);assert.ok(!JSON.stringify(status.body).includes('secret'));
 assert.equal((await request(path+'/probe',{},partnerA.cookie)).status,200);
 assert.equal((await request(path+'/checks',{request_id:uid('check')},partnerA.cookie)).status,400);
 evidence.checks.push('partner ownership and CSRF cover config/probe/check writes and reads');
});
test('real check survives committed capture response loss and API restart, then repeats capture/settlement without extra money',async()=>{
 await db.query('UPDATE gp_apps SET wallet_url=$2 WHERE id=$1',[app.app.id,proxyOrigin]);dropCapture=true;observedCapture=false;
 const path=`/api/partner/apps/${app.app.id}/integration/checks`,body={request_id:uid('acceptance'),confirm_sandbox_wallet:true};
 const started=await request(path,body,partnerA.cookie);assert.equal(started.status,202);const checkId=started.body.check.id;
 await wait(async()=>{
  const current=(await db.query('SELECT status,error_code,artifacts FROM gp_integration_checks WHERE id=$1',[checkId])).rows[0];
  assert.notEqual(current?.status,'FAILED',`check failed before capture: ${current?.error_code} (${current?.artifacts?.current_step})`);
  return observedCapture;
 },'committed capture at proxy');
 const before=(await db.query('SELECT * FROM gp_integration_checks WHERE id=$1',[checkId])).rows[0];assert.equal(before.status,'RUNNING');assert.ok(before.artifacts.room_id);
 assert.deepEqual(before.artifacts.launched.map(item=>item.game_id).sort(),[...RELEASED_IDS].sort(),'all authorised games must exchange a launch code before wallet acceptance');
 const matchId=before.artifacts.room_id,captured=(await db.query('SELECT state,captured_minor FROM wallet_matches WHERE match_id=$1',[matchId])).rows[0];assert.equal(captured.state,'CAPTURED');assert.equal(captured.captured_minor,'20000');
 await stop();dropCapture=false;await start();
 const report=await wait(async()=>{const r=(await db.query('SELECT * FROM gp_integration_checks WHERE id=$1',[checkId])).rows[0];if(r.status==='FAILED')throw Error(r.error_code);return r.status==='PASSED'?r:null;},'resumed check passes',30000);
 assert.equal(report.checks.length,8);assert.equal(report.artifacts.room_id,matchId);assert.deepEqual(report.artifacts.after,[{available:'1209000',reserved:'0'},{available:'1190000',reserved:'0'}]);assert.equal(report.artifacts.fee_minor,'1000');
 const same=await request(path,body,partnerA.cookie);assert.equal(same.body.check.id,checkId);assert.equal(same.body.check.status,'PASSED');
 assert.equal((await db.query("SELECT count(*)::int n FROM wallet_operations WHERE operation_id=ANY($1)",[[`capture_${matchId}`,`settle_${matchId}`]])).rows[0].n,2);
 assert.equal((await db.query('SELECT count(*)::int n FROM pvp_rooms WHERE id=$1',[matchId])).rows[0].n,1);
 assert.equal((await request(path,undefined,partnerB.cookie)).status,404);
 const text=JSON.stringify(report);assert.ok(!text.includes('access_token')&&!text.includes('secret_base64')&&!text.includes('launch_code'));
 evidence.checks.push('committed capture + dropped response + SIGKILL/restart resumes same room/operations; 10x capture + 10x settlement; correct final balances');
});
