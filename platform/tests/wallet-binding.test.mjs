import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';

const suffix=process.pid+'_'+randomBytes(6).toString('hex'),names=['oasis_binding_'+suffix,'oasis_binding_wallet_'+suffix];
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
const dbUrl=name=>{const u=new URL(adminUrl);u.pathname='/'+name;return u.toString();};
const priorEnv=Object.fromEntries(['OASIS_DATABASE_URL','OASIS_LOCAL_DIR','OASIS_WALLET_ALLOWED_ORIGINS','OASIS_REFERENCE_WALLET_URL'].map(k=>[k,process.env[k]]));
const uid=p=>p+'_'+randomBytes(8).toString('hex');
let admin,pool,partnerPool,closePools,dir,binding,walletApi,seal,created=[];
const servers=[];
async function listen(server){servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;process.env.OASIS_WALLET_ALLOWED_ORIGINS=[process.env.OASIS_WALLET_ALLOWED_ORIGINS,origin].filter(Boolean).join(',');return origin;}
let partnerOrigin;
before(async()=>{
  admin=new pg.Pool({connectionString:adminUrl.toString()});
  for(const name of names){assert.match(name,/^oasis_binding_(wallet_)?\d+_[a-f0-9]{12}$/);await admin.query(`CREATE DATABASE "${name}"`);created.push(name);}
  dir=await mkdtemp(join(tmpdir(),'oasis-binding-test-'));
  process.env.OASIS_DATABASE_URL=dbUrl(names[0]);process.env.OASIS_LOCAL_DIR=dir;process.env.OASIS_WALLET_ALLOWED_ORIGINS='';process.env.OASIS_REFERENCE_WALLET_URL='http://127.0.0.1:8798';
  ({pool,closePools}=await import('../server/db.mjs'));({seal}=await import('../server/security.mjs'));
  partnerPool=new pg.Pool({connectionString:dbUrl(names[1])});
  await pool.query(await readFile(new URL('../server/schema.sql',import.meta.url),'utf8'));
  await pool.query(await readFile(new URL('../server/pvp/schema.sql',import.meta.url),'utf8'));
  binding=await import('../server/wallet-binding.mjs');walletApi=await import('../server/wallet/index.mjs');
  await binding.migrateWalletBindings(pool);await walletApi.migrateWallet(pool);await walletApi.migrateWallet(partnerPool);
  partnerOrigin=await listen(walletApi.createWalletServer(partnerPool));
  assert.equal((await pool.query('SELECT current_database() db')).rows[0].db,names[0]);
  assert.equal((await partnerPool.query('SELECT current_database() db')).rows[0].db,names[1]);
  console.log('[wallet-binding isolation] created two independent databases '+names.join(', '));
});
after(async()=>{
  const errors=[];
  for(const server of servers)try{server.closeAllConnections();await new Promise((r,j)=>server.close(e=>e?j(e):r()));}catch(e){errors.push(e);}
  if(closePools)await closePools();await partnerPool?.end();
  for(const name of created)await dropOwnedTestDatabase(admin,name,{created:true});
  await admin?.end();if(dir)await rm(dir,{recursive:true,force:true});
  for(const[k,v]of Object.entries(priorEnv))if(v===undefined)delete process.env[k];else process.env[k]=v;
  console.log('[wallet-binding isolation] both test databases dropped and absence verified');if(errors.length)throw new AggregateError(errors);
});
async function fixture({status='paused',url=partnerOrigin}={}){
  const app={id:uid('app'),partner_id:uid('partner'),environment:'sandbox',wallet_scope_id:uid('wallet'),currency_id:'COIN',currency_scale:2,status,wallet_url:'http://127.0.0.1:8798'};
  const scope={partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id};
  const oldKey=uid('reference'),partnerKey=uid('partnerkey'),wallet_key_id=uid('walletkey'),wallet_secret_base64=randomBytes(32).toString('base64');
  await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,status) VALUES($1,$2,$3,$4,$5,$6)',[app.id,'Independent binding test',app.partner_id,app.environment,app.wallet_scope_id,status]);
  await pool.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'platform-to-wallet',$3),($4,$2,'partner-to-platform',$3)",[oldKey,app.id,seal(randomBytes(32).toString('base64')),partnerKey]);
  await walletApi.provisionWallet(pool,{scope,key_id:oldKey,secret_base64:randomBytes(32).toString('base64'),users:[{external_user_id:'alice',balance_minor:'77777'}],treasury_minor:'1000000'});
  await walletApi.provisionWallet(partnerPool,{scope,key_id:wallet_key_id,secret_base64:wallet_secret_base64,users:[{external_user_id:'alice',balance_minor:'100000'},{external_user_id:'bob',balance_minor:'100000'}],treasury_minor:'1000000'});
  const input={wallet_url:url,wallet_key_id,wallet_secret_base64};return{app,scope,input,oldKey,partnerKey};
}
async function bound(opts){const f=await fixture(opts);await binding.configureWallet(f.app.id,f.input,'admin_test');f.app=(await pool.query('SELECT * FROM gp_apps WHERE id=$1',[f.app.id])).rows[0];return f;}

test('origin validation uses exact deployment entries and rejects path, credentials, encoded host and unsafe schemes',()=>{
  assert.equal(binding.validateWalletOrigin(partnerOrigin,{external:true}),partnerOrigin);
  for(const value of ['http://127.0.0.1:1','http://localhost:8801','http://169.254.169.254','file:///tmp/wallet',partnerOrigin+'/path',partnerOrigin+'?q=1',partnerOrigin+'#x',partnerOrigin.replace('127.0.0.1','2130706433'),partnerOrigin.replace('http://','http://user:pass@')])assert.throws(()=>binding.validateWalletOrigin(value,{external:true}));
  for(const ip of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','192.168.1.1','::1','::ffff:127.0.0.1','fe80::1','fd00::1'])assert.equal(binding.isPublicWalletAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','2606:4700:4700::1111'])assert.equal(binding.isPublicWalletAddress(ip),true,ip);
});
test('only a pristine paused App binds, direction keys stay separate and reference balances never migrate',async()=>{
  const f=await fixture(),before=await walletApi.readWalletSnapshot(pool,{scope:f.scope});
  const state=await binding.configureWallet(f.app.id,f.input,'admin_test');assert.equal(state.mode,'external');assert.equal(state.locked,true);assert.equal(state.balance_migration,false);assert.ok(!JSON.stringify(state).includes(f.input.wallet_secret_base64));
  assert.equal((await pool.query('SELECT active FROM gp_keys WHERE id=$1',[f.oldKey])).rows[0].active,false);
  assert.equal((await pool.query('SELECT active FROM gp_keys WHERE id=$1',[f.partnerKey])).rows[0].active,true);
  assert.deepEqual(await walletApi.readWalletSnapshot(pool,{scope:f.scope}),before);
  assert.equal((await binding.getWalletStatus(f.app.id)).can_configure,false);
  const audit=(await pool.query("SELECT detail FROM gp_audit WHERE app_id=$1 AND action='wallet.bound'",[f.app.id])).rows[0].detail;
  assert.ok(!JSON.stringify(audit).includes('secret'));assert.equal(audit.wallet_key_id,f.input.wallet_key_id);
  await assert.rejects(binding.configureWallet(f.app.id,f.input,'admin_test'),{code:'WALLET_ALREADY_BOUND'});
});
test('active Apps, existing sessions, existing rooms and existing outbox records cannot rebind',async()=>{
  const active=await fixture({status:'active'});await assert.rejects(binding.configureWallet(active.app.id,active.input,'admin_test'),{code:'WALLET_BINDING_REQUIRES_PAUSED_SANDBOX'});
  const session=await fixture();await pool.query("INSERT INTO gp_sessions(id,app_id,external_user_id,game_id) VALUES($1,$2,'alice','tiger')",[uid('session'),session.app.id]);await assert.rejects(binding.configureWallet(session.app.id,session.input,'admin_test'),{code:'WALLET_BINDING_HAS_ACTIVITY'});
  const outbox=await fixture();await pool.query("INSERT INTO gp_operations(id,app_id,aggregate_id,path,raw_body) VALUES($1,$2,'old','/wallet/v1/probability/authorize','{}')",[uid('op'),outbox.app.id]);await assert.rejects(binding.configureWallet(outbox.app.id,outbox.input,'admin_test'),{code:'WALLET_BINDING_HAS_ACTIVITY'});
  const room=await fixture();await pool.query("INSERT INTO pvp_rooms(id,code,app_id,game_id,capacity,practice,entry_minor,fee_bps,terms,scope,players,rule_version,seed_enc,last_tick_at,expires_at) VALUES($1,$2,$3,'match',2,true,0,500,'{}','{}','[]','test','test',0,100)",[uid('room'),uid('code'),room.app.id]);await assert.rejects(binding.configureWallet(room.app.id,room.input,'admin_test'),{code:'WALLET_BINDING_HAS_ACTIVITY'});
});
test('concurrent binding has one winner and App row lock observes a session committed ahead of binding',async()=>{
  const f=await fixture(),results=await Promise.allSettled([binding.configureWallet(f.app.id,f.input,'a'),binding.configureWallet(f.app.id,{...f.input,wallet_key_id:uid('alternative')},'b')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await pool.query('SELECT 1 FROM gp_wallet_bindings WHERE app_id=$1',[f.app.id])).rowCount,1);
  const race=await fixture(),db=await pool.connect();await db.query('BEGIN');await db.query('SELECT 1 FROM gp_apps WHERE id=$1 FOR UPDATE',[race.app.id]);const pending=binding.configureWallet(race.app.id,race.input,'a');await db.query("INSERT INTO gp_sessions(id,app_id,external_user_id,game_id) VALUES($1,$2,'alice','tiger')",[uid('session'),race.app.id]);await db.query('COMMIT');db.release();await assert.rejects(pending,{code:'WALLET_BINDING_HAS_ACTIVITY'});
});
test('signed balance probe reaches separate wallet DB and changes no money or operation records',async()=>{
  const f=await bound(),before=await walletApi.readWalletSnapshot(partnerPool,{scope:f.scope}),result=await binding.probeWallet(f.app.id,{external_user_id:'alice'});
  assert.equal(result.read_only,true);assert.equal(result.balance.balance.available_minor,'100000');assert.equal(result.balance.app_id,f.app.id);
  assert.deepEqual(await walletApi.readWalletSnapshot(partnerPool,{scope:f.scope}),before);
  assert.equal((await walletApi.readWalletSnapshot(pool,{scope:f.scope})).users[0].available,'77777');
  assert.ok((await partnerPool.query('SELECT count(*)::int n FROM wallet_nonces')).rows[0].n>0);
});
test('binding pins exact scope and wallet key, never silently switching to a newer active key',async()=>{
  const f=await bound();await pool.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'platform-to-wallet',$3)",[uid('unbound'),f.app.id,seal(randomBytes(32).toString('base64'))]);assert.equal((await binding.probeWallet(f.app.id,{external_user_id:'alice'})).balance.balance.available_minor,'100000');
  await assert.rejects(binding.walletRequest({...f.app,wallet_url:'http://127.0.0.1:1'},'GET','/wallet/v1/operations/test'),{code:'WALLET_BINDING_CHANGED'});
  await assert.rejects(binding.walletRequest({...f.app,currency_id:'OTHER'},'GET','/wallet/v1/operations/test'),{code:'WALLET_BINDING_CHANGED'});
  await pool.query('UPDATE gp_keys SET active=false WHERE id=$1',[f.input.wallet_key_id]);await assert.rejects(binding.probeWallet(f.app.id,{external_user_id:'alice'}),{code:'WALLET_NOT_CONFIGURED'});
});
test('redirect is rejected without contacting its target; oversized and malformed responses fail closed',async()=>{
  let targetHits=0;const target=await listen(createServer((req,res)=>{targetHits++;res.end('{}');}));
  for(const [code,handler]of [
    ['WALLET_REDIRECT_FORBIDDEN',(req,res)=>{res.writeHead(307,{location:target});res.end();}],
    ['WALLET_RESPONSE_TOO_LARGE',(req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({padding:'x'.repeat(131072)}));}],
    ['WALLET_INVALID_RESPONSE',(req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<html>wrong service</html>');}],
    ['WALLET_INVALID_RESPONSE',(req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{broken');}],
  ]){const origin=await listen(createServer(handler)),f=await bound({url:origin});await assert.rejects(binding.probeWallet(f.app.id,{external_user_id:'alice'}),{code});}
  assert.equal(targetHits,0);
});
test('timeout preserves unknown outcome and does not wait indefinitely',async()=>{
  const origin=await listen(createServer(()=>{})),f=await bound({url:origin}),start=Date.now();await assert.rejects(binding.probeWallet(f.app.id,{external_user_id:'alice'}),{code:'WALLET_UNKNOWN'});assert.ok(Date.now()-start>=2800&&Date.now()-start<6000);
});
test('balance response must match schema, user, currency precision and full trusted scope',async()=>{
  let answer;const origin=await listen(createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(answer));})),f=await bound({url:origin});
  const good={...f.scope,balance:{external_user_id:'alice',available_minor:'100000',reserved_minor:'0',currency_scale:2,ledger_version:'1'},as_of:new Date().toISOString()};
  for(const mutate of [r=>{r.app_id='other';},r=>{r.balance.external_user_id='bob';},r=>{r.balance.currency_scale=0;},r=>{r.balance.available_minor=100000;}]){answer=structuredClone(good);mutate(answer);await assert.rejects(binding.probeWallet(f.app.id,{external_user_id:'alice'}),{code:'WALLET_INVALID_BALANCE'});}
});
test('committed independent-wallet response loss recovers by original ID with one financial effect',async()=>{
  let drop=true,writes=0;const origin=await listen(createServer(async(req,res)=>{try{let raw='';for await(const c of req)raw+=c;const r=await fetch(partnerOrigin+req.url,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:raw});const text=await r.text();if(req.method==='POST')writes++;if(drop&&req.method==='POST'){drop=false;res.destroy();return;}res.writeHead(r.status,{'content-type':'application/json'});res.end(text);}catch{res.destroy();}})),f=await bound({url:origin});
  const body={...f.scope,request_id:uid('reserve'),reservation_id:uid('hold'),match_id:uid('match'),external_user_id:'alice',seat_index:0,amount_minor:'10000',terms:{game_id:'carrom',rule_version:'pvp-carrom-v1.0.0',payout_template_version:'winner-all-v1',fee_bps:500,entry_minor:'10000',player_count:2,team_size:1},expires_at:new Date(Date.now()+110000).toISOString()},raw=JSON.stringify(body);
  await assert.rejects(binding.walletRequest(f.app,'POST','/wallet/v1/reservations',raw,body.request_id),{code:'WALLET_UNKNOWN'});assert.equal(writes,1);
  const found=await binding.walletRequest(f.app,'GET','/wallet/v1/operations/'+body.request_id);assert.equal(found.state,'SUCCEEDED');assert.equal(found.operation_id,body.request_id);
  assert.deepEqual(await binding.walletRequest(f.app,'POST','/wallet/v1/reservations',raw,body.request_id),found);
  const snap=await walletApi.readWalletSnapshot(partnerPool,{scope:f.scope});assert.equal(snap.operations.length,1);assert.equal(snap.users.find(u=>u.external_user_id==='alice').available,'90000');assert.equal(snap.users.find(u=>u.external_user_id==='alice').reserved,'10000');
});
test('standalone process imports a private config, refuses the main database and preserves balances on restart',async()=>{
  const {startPartnerWallet}=await import('../examples/partner-wallet/server.mjs');
  await assert.rejects(startPartnerWallet({configPath:'unused',databaseUrl:dbUrl(names[0]),port:0}),/must not use the platform database/);
  const f=await fixture(),configPath=join(dir,'partner-config.json'),{getProfile}=await import('../server/math/index.ts');
  const config={schema_version:1,scope:f.scope,currency_scale:2,key_id:f.input.wallet_key_id,secret_base64:f.input.wallet_secret_base64,treasury_minor:'1000000',math_profiles:['thunder','tiger'].map(game=>{const m=getProfile(game,'99');return{game_id:game,math_version:m.version,math_config_hash:m.hash,max_payout_multiplier:String(m.maxMultiplier)};})};
  await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  let child,port=0,logs='';
  const launch=()=>new Promise((resolve,reject)=>{child=spawn(process.execPath,[new URL('../examples/partner-wallet/server.mjs',import.meta.url).pathname],{env:{...process.env,OASIS_PARTNER_WALLET_CONFIG:configPath,OASIS_PARTNER_WALLET_DATABASE_URL:dbUrl(names[1]),OASIS_PARTNER_WALLET_PORT:String(port)},stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Standalone wallet did not start'));},10000);child.on('error',reject);child.once('exit',code=>{if(code){clearTimeout(timer);reject(Error(logs));}});child.stderr.on('data',b=>{logs+=b;});child.stdout.on('data',b=>{logs+=b;for(const line of String(b).split('\n')){try{const v=JSON.parse(line);if(v.origin){clearTimeout(timer);port=Number(new URL(v.origin).port);resolve(v.origin);}}catch{}}});});
  const stop=async()=>{if(child&&child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await end;}};
  try{
    const origin=await launch();process.env.OASIS_WALLET_ALLOWED_ORIGINS+=','+origin;f.input.wallet_url=origin;await binding.configureWallet(f.app.id,f.input,'admin_test');
    const first=await binding.probeWallet(f.app.id,{external_user_id:'demo_player'});assert.equal(first.balance.balance.available_minor,'1200000');
    const snapshot=await walletApi.readWalletSnapshot(partnerPool,{scope:f.scope});assert.equal(snapshot.users.filter(u=>u.external_user_id.startsWith('demo_player')).length,4);
    await stop();assert.equal(await launch(),origin);assert.deepEqual(await walletApi.readWalletSnapshot(partnerPool,{scope:f.scope}),snapshot);
    assert.equal((await binding.probeWallet(f.app.id,{external_user_id:'demo_player'})).balance.balance.available_minor,'1200000');assert.ok(!logs.includes(f.input.wallet_secret_base64));
  }finally{await stop();}
});
