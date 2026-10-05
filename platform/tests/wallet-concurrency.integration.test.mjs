/** Real wallet HTTP, scope-lock contention and ledger checks in a disposable DB. */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {migrateWallet,provisionWallet,createWalletServer,signWalletRequest,readWalletSnapshot,walletQueueStats} from '../server/wallet/index.mjs';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
const uid=prefix=>prefix+'_'+randomBytes(8).toString('hex');
const name=`oasis_release_test_${process.pid}_${randomBytes(6).toString('hex')}`;
const adminURL=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres'),databaseURL=new URL(adminURL);databaseURL.pathname='/'+name;
const previous=process.env.OASIS_DATABASE_URL;
let admin,control,pool,walletPool,closePools,server,origin,created=false;
before(async()=>{
 admin=new pg.Pool({connectionString:adminURL.href,max:1});await admin.query(`CREATE DATABASE "${name}"`);created=true;
 process.env.OASIS_DATABASE_URL=databaseURL.href;({pool,walletPool,closePools}=await import('../server/db.mjs'));
 assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
 control=new pg.Pool({connectionString:databaseURL.href,max:2});await migrateWallet(walletPool);
 server=createWalletServer(walletPool);await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
});
after(async()=>{try{if(server?.listening)await new Promise(r=>server.close(r));await control?.end();await closePools?.();if(created)await dropOwnedTestDatabase(admin,name,{created});}finally{await admin?.end();if(previous===undefined)delete process.env.OASIS_DATABASE_URL;else process.env.OASIS_DATABASE_URL=previous;}});
async function fixture(){const f={scope:{partner_id:uid('partner'),app_id:'queue_app',environment:'sandbox',wallet_scope_id:'main',currency_id:'COIN'},key_id:uid('key'),secret_base64:randomBytes(32).toString('base64'),users:['a','b'].map(external_user_id=>({external_user_id,balance_minor:'100000'})),treasury_minor:'100000000'};await provisionWallet(walletPool,f);f.scopeId=Object.values(f.scope).join(':');return f;}
const balancePath=f=>`/wallet/v1/scopes/${f.scope.wallet_scope_id}/currencies/${f.scope.currency_id}/users/a/balance`;
async function call(f,path,body,url=origin){const method=body===undefined?'GET':'POST',raw=body===undefined?'':JSON.stringify({...f.scope,...body}),headers=signWalletRequest({...f,request_id:body?.request_id||uid('query'),method,path,raw_body:raw,nonce:randomBytes(16).toString('hex')});const r=await fetch(url+path,{method,headers,...(body===undefined?{}:{body:raw}),signal:AbortSignal.timeout(10000)});return{status:r.status,body:await r.json()};}
async function heldScope(f){const c=await control.connect();await c.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[f.scopeId]);return async()=>{await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[f.scopeId]);c.release();};}
async function until(fn){const end=performance.now()+3000;while(performance.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('concurrent fixture did not reach expected queue state');}
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('unrelated work waited for blocked wallet scope')),1000);})]);}finally{clearTimeout(timer);}}
const conserved=s=>assert.equal(s.ledger.reduce((n,l)=>n+BigInt(l.delta_available)+BigInt(l.delta_reserved),0n),0n);

test('reference wallet has an independent bounded pool; same-scope waiters leave connections for unrelated work',async()=>{
 assert.notEqual(walletPool,pool);assert.equal(walletPool.options.max,8);assert.equal(pool.options.max,20);
 const f=await fixture(),other=await fixture(),release=await heldScope(f),requests=[];let finished=0;
 try{
  for(let i=0;i<13;i++)requests.push(call(f,balancePath(f)).then(r=>{finished++;return r;}));
  await until(()=>walletQueueStats(walletPool).admitted===13);
  const waits=(await control.query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n;
  assert.equal(waits,1,'only the queue head may wait in PostgreSQL');assert.equal(finished,0);assert.equal(walletPool.waitingCount,0);
  assert.equal((await bounded(call(other,balancePath(other)))).status,200);assert.equal((await bounded(pool.query('SELECT 42 AS n'))).rows[0].n,42);
 }finally{await release();await Promise.allSettled(requests);}
 assert.ok((await Promise.all(requests)).every(r=>r.status===200));assert.equal(walletQueueStats(walletPool).admitted,0);
 const held=await Promise.all(Array.from({length:8},()=>walletPool.connect()));try{assert.equal((await bounded(pool.query('SELECT 17 AS n'))).rows[0].n,17);}finally{held.forEach(c=>c.release());}
});

test('scope queue overflow returns retryable 503 before any financial operation; original request retries once',async()=>{
 const f=await fixture(),release=await heldScope(f),requests=[];
 const body={request_id:uid('reserve'),match_id:uid('match'),reservation_id:uid('reservation'),external_user_id:'a',seat_index:0,amount_minor:'10000',terms:{game_id:'carrom',rule_version:'carrom-1.0.0',payout_template_version:'winner-all-v1',fee_bps:500,entry_minor:'10000',player_count:2,team_size:1},expires_at:new Date(Date.now()+110000).toISOString()};
 try{
  for(let i=0;i<64;i++)requests.push(call(f,balancePath(f)));await until(()=>walletQueueStats(walletPool).admitted===64);
  const rejected=await bounded(call(f,'/wallet/v1/reservations',body));assert.equal(rejected.status,503);assert.equal(rejected.body.code,'RATE_LIMITED');assert.equal(rejected.body.retryable,true);
  const untouched=(await control.query(`SELECT
   (SELECT count(*) FROM wallet_operations WHERE scope_id=$1 AND operation_id=$2)::int operations,
   (SELECT count(*) FROM wallet_operation_ids WHERE operation_id=$2)::int registry,
   (SELECT count(*) FROM wallet_ledger WHERE scope_id=$1 AND operation_id=$2)::int ledger,
   (SELECT count(*) FROM wallet_reservations WHERE scope_id=$1 AND reservation_id=$3)::int reservations`,[f.scopeId,body.request_id,body.reservation_id])).rows[0];
  assert.deepEqual(untouched,{operations:0,registry:0,ledger:0,reservations:0});
  assert.equal((await control.query('SELECT available FROM wallet_users WHERE scope_id=$1 AND external_user_id=$2',[f.scopeId,'a'])).rows[0].available,'100000');
 }finally{await release();await Promise.allSettled(requests);}
 const retried=await Promise.all(Array.from({length:12},()=>call(f,'/wallet/v1/reservations',body)));
 assert.ok(retried.every(r=>r.status===200&&r.body.state==='SUCCEEDED'));for(const r of retried)assert.deepEqual(r.body,retried[0].body);
 let s=await readWalletSnapshot(walletPool,f);const user=s.users.find(u=>u.external_user_id==='a');assert.equal(user.available,'90000');assert.equal(user.reserved,'10000');assert.equal(s.operations.filter(o=>o.operation_id===body.request_id).length,1);assert.equal(s.ledger.filter(l=>l.operation_id===body.request_id).length,1);conserved(s);
 assert.equal((await call(f,'/wallet/v1/matches/release',{request_id:uid('release'),match_id:body.match_id,reason:'lobby_cancelled'})).body.state,'SUCCEEDED');
 s=await readWalletSnapshot(walletPool,f);assert.ok(s.users.every(u=>u.available==='100000'&&u.reserved==='0'));conserved(s);
});

test('scope FIFO releases after business failure and connection checkout failure',async()=>{
 const f=await fixture(),before=await readWalletSnapshot(walletPool,f),release=await heldScope(f);let bad,good;
 try{bad=call(f,balancePath(f).replace('/users/a/','/users/missing/'));await until(()=>walletQueueStats(walletPool).admitted===1);good=call(f,balancePath(f));await until(()=>walletQueueStats(walletPool).admitted===2);}finally{await release();}
 assert.equal((await bad).status,404);assert.equal((await good).status,200);assert.equal(walletQueueStats(walletPool).admitted,0);
 let failConnect=true;const facade={query:(...args)=>walletPool.query(...args),connect:()=>{if(failConnect){failConnect=false;return Promise.reject(Object.assign(Error('injected checkout failure'),{code:'TEST_CHECKOUT_FAILED'}));}return walletPool.connect();}};
 const fixtureServer=createWalletServer(facade);await new Promise(r=>fixtureServer.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+fixtureServer.address().port;
 try{assert.equal((await call(f,balancePath(f),undefined,url)).status,503);assert.equal(walletQueueStats(facade).admitted,0);assert.equal((await call(f,balancePath(f),undefined,url)).status,200);}finally{await new Promise(r=>fixtureServer.close(r));}
 const after=await readWalletSnapshot(walletPool,f);assert.deepEqual(after.users,before.users);assert.deepEqual(after.ledger,before.ledger);conserved(after);
});
