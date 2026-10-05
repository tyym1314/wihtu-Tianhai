import {test,before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';

const uid=p=>p+'_'+randomBytes(8).toString('hex');
const databaseName='oasis_recovery_test_'+process.pid+'_'+randomBytes(8).toString('hex');
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
const databaseUrl=new URL(adminUrl);databaseUrl.pathname='/'+databaseName;
const envNames=['OASIS_DATABASE_URL','OASIS_LOCAL_DIR','OASIS_WALLET_ALLOWED_ORIGINS'];
const previousEnv=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
let admin,pool,closePools,locked,seal,migratePlatform,migrateWallet,provisionWallet,createWalletServer,readWalletSnapshot,getProfile,advanceCycle,recoverPending;
let localDir,wallet,proxy,walletOrigin,proxyOrigin,databaseCreated=false;
const faults=new Map(),requests=[],children=new Set();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(const deadline=Date.now()+12000;Date.now()<deadline;){if(await fn())return;await sleep(15);}throw Error('Timeout: '+label);}
const readCycle=async id=>(await pool.query('SELECT * FROM gp_cycles WHERE id=$1',[id])).rows[0];
const readOp=async id=>(await pool.query('SELECT *,extract(epoch FROM(next_attempt_at-updated_at))*1000 AS delay_ms FROM gp_operations WHERE id=$1',[id])).rows[0];

before(async()=>{
  assert.match(databaseName,/^oasis_recovery_test_[0-9]+_[a-f0-9]{16}$/);
  admin=new pg.Pool({connectionString:adminUrl.toString(),max:2});
  await admin.query(`CREATE DATABASE "${databaseName}"`);databaseCreated=true;
  localDir=await mkdtemp(join(tmpdir(),'oasis-recovery-test-'));
  process.env.OASIS_DATABASE_URL=databaseUrl.toString();process.env.OASIS_LOCAL_DIR=localDir;
  ({pool,closePools,locked}=await import('../server/db.mjs'));
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,databaseName);
  ({seal}=await import('../server/security.mjs'));
  ({migratePlatform}=await import('../server/platform.mjs'));
  ({migrateWallet,provisionWallet,createWalletServer,readWalletSnapshot}=await import('../server/wallet/index.mjs'));
  ({getProfile}=await import('../server/math/index.ts'));
  ({advanceCycle,recoverPending}=await import('../server/cycles.mjs'));
  await migratePlatform();await migrateWallet(pool);await (await import('../server/wallet-binding.mjs')).migrateWalletBindings(pool);
  wallet=createWalletServer(pool);await new Promise(r=>wallet.listen(0,'127.0.0.1',r));walletOrigin='http://127.0.0.1:'+wallet.address().port;
  proxy=createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString();
      const body=raw?JSON.parse(raw):null,operation=req.url.split('/operations/')[1];
      const cycle=body?.cycle_id||operation?.replace(/^(authorize|accept|settle)_/,''),fault=faults.get(cycle);
      requests.push({cycle,method:req.method,path:req.url,raw});
      if(fault?.kind==='poison'){res.writeHead(503,{'content-type':'application/json'});res.end('{"code":"INJECTED_WALLET_OUTAGE"}');return;}
      if(fault?.kind==='pending'&&body){
        const now=new Date().toISOString(),scope=Object.fromEntries(['partner_id','app_id','environment','wallet_scope_id','currency_id'].map(k=>[k,body[k]]));
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...scope,operation_id:body.request_id,kind:'authorize_probability',state:'PENDING',body_sha256:createHash('sha256').update(raw).digest('hex'),created_at:now,updated_at:now}));return;
      }
      if(fault?.kind==='gate'){fault.entered=true;await fault.promise;}
      const response=await fetch(walletOrigin+req.url,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:raw}),text=await response.text();
      if(fault?.kind==='hold-settle'&&req.url.endsWith('/probability/settle')){fault.committed=true;return;}
      res.writeHead(response.status,{'content-type':'application/json'});res.end(text);
    }catch{res.destroy();}
  });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));proxyOrigin='http://127.0.0.1:'+proxy.address().port;
  process.env.OASIS_WALLET_ALLOWED_ORIGINS=proxyOrigin;
  console.log('[recovery isolation] created '+databaseName+'; actual database verified; ephemeral wallet/proxy ports');
});
afterEach(async()=>{
  // Keep one fault scenario from feeding the next worker batch. This only
  // touches the uniquely named disposable database asserted in before().
  for(const fault of faults.values())fault.release?.();faults.clear();requests.length=0;
  if(pool)await pool.query("UPDATE gp_cycles SET status='REJECTED' WHERE status NOT IN ('SETTLED','REJECTED')");
});
after(async()=>{
  const remaining=[...children];for(const child of remaining)child.kill('SIGKILL');await Promise.all(remaining.map(child=>child.done));
  for(const server of [proxy,wallet])if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}
  await closePools?.();
  if(databaseCreated){await dropOwnedTestDatabase(admin,databaseName,{created:databaseCreated});console.log('[recovery isolation] dropped database; verified absent');}
  await admin?.end();if(localDir)await rm(localDir,{recursive:true,force:true});
  for(const key of envNames)if(previousEnv[key]===undefined)delete process.env[key];else process.env[key]=previousEnv[key];
});

async function fixture(){
  const app={id:uid('recoveryapp'),partner_id:uid('partner'),environment:'sandbox',wallet_scope_id:uid('scope'),currency_id:'COIN',wallet_url:proxyOrigin};
  const scope={partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id};
  const key_id=uid('walletkey'),secret_base64=randomBytes(32).toString('base64'),profile=getProfile('tiger','99');
  await pool.query('INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,wallet_url) VALUES($1,$2,$3,$4,$5,$6)',[app.id,'Recovery isolated test',app.partner_id,app.environment,app.wallet_scope_id,proxyOrigin]);
  await pool.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'platform-to-wallet',$3)",[key_id,app.id,seal(secret_base64)]);
  await provisionWallet(pool,{scope,key_id,secret_base64,users:[{external_user_id:'player',balance_minor:'100000000'}],treasury_minor:'100000000000',math_profiles:[{game_id:'tiger',math_version:profile.version,math_config_hash:profile.hash,max_payout_multiplier:String(profile.maxMultiplier)}]});
  return{app,scope,profile};
}
async function cycle(f,{status='AUTHORIZING',missingMath=false}={}){
  const sid=uid('session'),id=uid('cycle');
  await pool.query("INSERT INTO gp_sessions(id,app_id,external_user_id,game_id) VALUES($1,$2,'player','tiger')",[sid,f.app.id]);
  await pool.query("INSERT INTO gp_cycles(id,session_id,app_id,external_user_id,game_id,request_id,stake_minor,math_profile,math_version,math_hash,max_payout_minor,status) VALUES($1,$2,$3,'player','tiger',$4,1000,'99',$5,$6,$7,$8)",[id,sid,f.app.id,uid('spin'),missingMath?'missing-pinned-version':f.profile.version,f.profile.hash,String(f.profile.maxMultiplier*1000),status]);
  return id;
}
async function due(ids){
  await pool.query("UPDATE gp_cycles SET error=jsonb_set(error,'{next_attempt_at}',to_jsonb(now()-interval '1 second')) WHERE id=ANY($1) AND error IS NOT NULL",[ids]);
  await pool.query("UPDATE gp_operations SET next_attempt_at=now()-interval '1 second' WHERE aggregate_id=ANY($1)",[ids]);
}
function worker(cycleId){
  const child=spawn(process.execPath,['--import','tsx','tests/recovery-worker.mjs',...(cycleId?[cycleId]:[])],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env},stdio:['ignore','pipe','pipe']});
  children.add(child);let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  child.done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{children.delete(child);resolve({code,signal,output});});});return child;
}

test('20 poisoned older cycles cannot starve a healthy later cycle; batch remains at most 20',async()=>{
  const f=await fixture(),poison=[];for(let i=0;i<20;i++){const id=await cycle(f);poison.push(id);faults.set(id,{kind:'poison'});}const healthy=await cycle(f);
  await recoverPending();assert.equal((await readCycle(healthy)).status,'AUTHORIZING');
  assert.equal((await pool.query('SELECT count(*)::int n FROM gp_operations WHERE aggregate_id=ANY($1)',[poison])).rows[0].n,20);
  assert.equal(requests.length,20);
  // Make every poison eligible again. Fairness must not depend on a fast
  // worker finishing all requests before the three-second delay expires.
  await due(poison);requests.length=0;await recoverPending();
  assert.equal((await readCycle(healthy)).status,'SETTLED');
  assert.equal(new Set(requests.map(r=>r.cycle)).size,20);
  assert.equal(requests.filter(r=>r.cycle===healthy&&r.method==='POST').length,3);
  const snap=await readWalletSnapshot(pool,{scope:f.scope});assert.equal(snap.operations.length,3);
  assert.equal(snap.ledger.reduce((sum,l)=>sum+BigInt(l.delta_available)+BigInt(l.delta_reserved),0n),0n);
});

test('non-wallet pinned-math failures also back off and yield to healthy cycles',async()=>{
  const f=await fixture(),poison=[];for(let i=0;i<21;i++)poison.push(await cycle(f,{status:'ACCEPTED',missingMath:true}));const healthy=await cycle(f);
  await recoverPending();const first=await readCycle(poison[0]);assert.equal(first.error.code,'PINNED_MATH_UNAVAILABLE');assert.equal(first.error.recovery_attempts,1);assert.ok(Date.parse(first.error.next_attempt_at)>first.updated_at.getTime());
  await due(poison);await recoverPending();assert.equal((await readCycle(healthy)).status,'SETTLED');
  assert.equal((await pool.query('SELECT count(*)::int n FROM gp_operations WHERE aggregate_id=ANY($1)',[poison])).rows[0].n,0);
});

test('persisted operation deadlines survive absent cycle metadata; manual retries remain immediate and idempotent',async()=>{
  const f=await fixture(),id=await cycle(f);faults.set(id,{kind:'poison'});
  await assert.rejects(advanceCycle(id),e=>e.code==='SETTLEMENT_PENDING');const op=await readOp('authorize_'+id);assert.equal(Number(op.delay_ms),3000);
  await pool.query('UPDATE gp_cycles SET error=NULL WHERE id=$1',[id]);requests.length=0;
  await recoverPending();assert.equal(requests.length,0);assert.equal((await readOp(op.id)).attempts,1);
  const restarted=worker(),out=await restarted.done;assert.equal(out.code,0,out.output);assert.equal(requests.length,0);
  faults.delete(id);await advanceCycle(id);assert.equal((await readCycle(id)).status,'SETTLED');
  const retried=await readOp(op.id);assert.equal(retried.raw_body,op.raw_body);assert.equal(retried.attempts,2);
  await advanceCycle(id);assert.equal((await readWalletSnapshot(pool,{scope:f.scope})).operations.length,3);
});

test('PENDING receipts schedule retries and repeated errors use a bounded exponential delay',async()=>{
  const f=await fixture(),id=await cycle(f);faults.set(id,{kind:'pending'});
  await assert.rejects(advanceCycle(id),e=>e.code==='SETTLEMENT_PENDING');let op=await readOp('authorize_'+id);assert.equal(op.state,'PENDING');assert.equal(Number(op.delay_ms),3000);
  requests.length=0;await recoverPending();assert.equal(requests.length,0);
  faults.set(id,{kind:'poison'});await assert.rejects(advanceCycle(id),e=>e.code==='SETTLEMENT_PENDING');op=await readOp(op.id);assert.equal(Number(op.delay_ms),6000);
  await pool.query('UPDATE gp_operations SET attempts=99 WHERE id=$1',[op.id]);await pool.query("UPDATE gp_cycles SET error=jsonb_set(error,'{recovery_attempts}','99') WHERE id=$1",[id]);
  await assert.rejects(advanceCycle(id),e=>e.code==='SETTLEMENT_PENDING');op=await readOp(op.id);assert.equal(Number(op.delay_ms),300000);
  const c=await readCycle(id);assert.equal(c.error.recovery_attempts,100);assert.equal(Date.parse(c.error.next_attempt_at)-c.updated_at.getTime(),300000);
});

test('workers do not overlap across process/module boundaries while one wallet request is in flight',async()=>{
  const f=await fixture(),id=await cycle(f),gate={kind:'gate'};gate.promise=new Promise(r=>gate.release=r);faults.set(id,gate);
  const running=recoverPending();await until(()=>gate.entered,'first worker at wallet');
  try{
    const peer=worker(),out=await peer.done;assert.equal(out.code,0,out.output);
    await recoverPending();assert.equal(requests.length,1);
  }finally{faults.delete(id);gate.release();await running;}
  assert.equal((await readCycle(id)).status,'SETTLED');assert.equal((await readWalletSnapshot(pool,{scope:f.scope})).operations.length,3);
});

test('worker skips a manually locked cycle without delaying another due cycle',async()=>{
  const f=await fixture(),busy=await cycle(f),healthy=await cycle(f);
  await locked('cycle:'+busy,async()=>{
    await recoverPending();assert.equal((await readCycle(busy)).status,'AUTHORIZING');assert.equal((await readCycle(healthy)).status,'SETTLED');
  });
  await recoverPending();assert.equal((await readCycle(busy)).status,'SETTLED');
});

test('SIGKILL after wallet commit recovers the original result, bytes and operation ID without another payout',async()=>{
  const f=await fixture(),id=await cycle(f),fault={kind:'hold-settle'};faults.set(id,fault);
  const first=worker(id);let before,snapshot,originalOp;
  try{
    await until(()=>fault.committed,'wallet settlement committed with response withheld');
    before=await readCycle(id);assert.equal(before.status,'RESULT_FIXED');originalOp=await readOp('settle_'+id);
    snapshot=await readWalletSnapshot(pool,{scope:f.scope});assert.equal(snapshot.operations.find(o=>o.operation_id===originalOp.id).state,'SUCCEEDED');
  }finally{first.kill('SIGKILL');assert.equal((await first.done).signal,'SIGKILL');faults.delete(id);}
  const second=worker(),out=await second.done;assert.equal(out.code,0,out.output);
  const after=await readCycle(id);assert.equal(after.status,'SETTLED');assert.equal(after.result_hash,before.result_hash);assert.deepEqual(after.result,before.result);
  const recoveredOp=await readOp(originalOp.id);assert.equal(recoveredOp.raw_body,originalOp.raw_body);assert.equal(recoveredOp.state,'SUCCEEDED');
  const settled=await readWalletSnapshot(pool,{scope:f.scope});assert.deepEqual(settled.users,snapshot.users);assert.deepEqual(settled.ledger,snapshot.ledger);assert.equal(settled.operations.length,3);
  assert.equal(new Set(requests.filter(r=>r.path.endsWith('/probability/settle')).map(r=>r.raw)).size,1);
});
