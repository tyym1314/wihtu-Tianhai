import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';
import {migrateWallet,readWalletSnapshot,giftForTest} from '../server/wallet/index.mjs';
import {migrateTransfers,createTransferService} from '../server/transfers/index.mjs';
import {transferAudit,transferObligations,transferSchema} from '../server/transfers/audit.mjs';
import {restoreAuditSQL,restoreInspectSQL} from '../deploy/restore-drill.mjs';
import {routeTransfers} from '../server/transfers/routes.mjs';

const uid=p=>p+'_'+randomBytes(8).toString('hex');
const name=`oasis_release_test_${process.pid}_${randomBytes(6).toString('hex')}`;
const adminUrl=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
const dbUrl=new URL(adminUrl);dbUrl.pathname='/'+name;
const sha=s=>createHash('sha256').update(s).digest('hex');
const exec=promisify(execFile);
let admin,pool,created=false,scratch,activationSQL;const services=[];
async function psqlProgram(sql,url=dbUrl){
 const path=join(scratch,uid('read_only')+'.sql');await writeFile(path,sql,{mode:0o600,flag:'wx'});
 try{const r=await exec('psql',['-X','-qAt','-v','ON_ERROR_STOP=1','--dbname',url.href,'-f',path],{timeout:30000,maxBuffer:1024*1024});return JSON.parse(r.stdout.trim());}
 finally{await rm(path);}
}
before(async()=>{
 assert(['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname),'loopback-only test database');
 admin=new pg.Pool({connectionString:adminUrl.href,max:1});await admin.query(`CREATE DATABASE "${name}"`);created=true;
 pool=new pg.Pool({connectionString:dbUrl.href,max:8});assert.equal((await pool.query('SELECT current_database() n')).rows[0].n,name);
 await migrateWallet(pool);await pool.query(await readFile(new URL('../server/schema.sql',import.meta.url),'utf8'));
 await pool.query(await readFile(new URL('../server/pvp/schema.sql',import.meta.url),'utf8'));
 const portal=(await readFile(new URL('../server/portal.mjs',import.meta.url),'utf8')).match(/export async function migratePortal\(\)\{await pool.query\(`([\s\S]+?)`\);\}/);assert(portal);await pool.query(portal[1]);
 await pool.query(`CREATE TABLE gp_wallet_bindings(app_id text PRIMARY KEY REFERENCES gp_apps,provider text NOT NULL,wallet_url text,wallet_key_id text,scope jsonb NOT NULL)`);
 scratch=await mkdtemp(join(tmpdir(),'oasis-transfer-psql-'));
 activationSQL=(await exec('python3',['-B','-c',"import importlib.util,sys; sys.path.insert(0,'deploy'); s=importlib.util.spec_from_file_location('activation','deploy/activate-release.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.pending_sql())"],{timeout:10000,maxBuffer:1024*1024})).stdout;
 assert.equal((await psqlProgram(restoreInspectSQL())).transfer_schema,'absent');assert.equal((await psqlProgram(activationSQL)).transfer_schema,'absent');
 assert.equal(await transferSchema(pool),'absent');
 await migrateTransfers(pool);
});
after(async()=>{await Promise.all(services.map(s=>s.close()));await pool?.end();if(created){await dropOwnedTestDatabase(admin,name,{created});console.log(JSON.stringify({cleanup:'owned-transfer-database-removed',name}));}await admin?.end();if(scratch)await rm(scratch,{recursive:true,force:true});});
function service(adapters={}){const s=createTransferService({pool,adapters,environment:'production'});services.push(s);return s;}
function synthetic(){
 const records=new Map(),calls=[],behavior={lost:false,reject:false,pending:false,corrupt:false,transaction:null,wait:null};
 const result=(h,state='SUCCEEDED')=>({...h.operation,body_sha256:h.body_sha256,state,...(state==='SUCCEEDED'?{transaction_id:behavior.transaction||uid('external')}:{final:true,rejection_code:'DECLINED'})});
 const adapter={idempotentReplay:true,authoritativeQuery:true,validateBinding:b=>b.config.protocol==='synthetic-only-v1',
  async submit(h){calls.push({method:'submit',raw:h.raw_body,id:h.operation.operation_id});assert(Object.isFrozen(h)&&Object.isFrozen(h.operation));assert.equal(sha(h.raw_body),h.body_sha256);if(behavior.wait)await behavior.wait;
   let r=records.get(h.operation.operation_id);if(!r){r=result(h,behavior.pending?'PENDING':behavior.reject?'REJECTED':'SUCCEEDED');records.set(h.operation.operation_id,r);}
   if(behavior.lost){behavior.lost=false;throw Error('synthetic lost ACK');}return behavior.corrupt?{...r,amount_minor:'1'}:r;},
  async query(h){calls.push({method:'query',raw:h.raw_body,id:h.operation.operation_id});return records.get(h.operation.operation_id)||result(h,'NOT_FOUND');}
 };
 return{adapter,records,calls,behavior,result};
}
async function fixture(){
 const app={id:uid('app'),partner_id:uid('partner'),environment:'production',wallet_scope_id:uid('scope'),currency_id:'COIN',currency_scale:2,status:'active',wallet_url:''};
 const scope={partner_id:app.partner_id,app_id:app.id,environment:'production',wallet_scope_id:app.wallet_scope_id,currency_id:'COIN'};
 // Scope field order matches the established ledger identifier, not object serialization.
 const scopeId=[scope.partner_id,scope.app_id,scope.environment,scope.wallet_scope_id,scope.currency_id].join(':');
 const key=uid('key'),binding=uid('binding'),account=uid('account'),player=uid('player'),user=uid('mapped'),partnerAccount=uid('remote');
 await pool.query("INSERT INTO gp_apps(id,name,partner_id,environment,wallet_scope_id,status,wallet_url,game_ids) VALUES($1,'transfer fixture',$2,'production',$3,'active','','[\"run\"]')",[app.id,app.partner_id,app.wallet_scope_id]);
 await pool.query('INSERT INTO wallet_scopes(scope_id,partner_id,app_id,environment,wallet_scope_id,currency_id,treasury_available) VALUES($1,$2,$3,$4,$5,$6,0)',[scopeId,scope.partner_id,scope.app_id,scope.environment,scope.wallet_scope_id,scope.currency_id]);
 await pool.query("INSERT INTO gp_wallet_bindings VALUES($1,'platform',NULL,NULL,$2)",[app.id,scope]);
 await pool.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'partner-to-platform','synthetic-not-a-live-key')",[key,app.id]);
 await pool.query("INSERT INTO gp_players(id,username,salt,password_hash) VALUES($1,$1,'synthetic','synthetic')",[player]);
 await pool.query('INSERT INTO gp_player_app_ids(app_id,player_id,external_user_id) VALUES($1,$2,$3)',[app.id,player,user]);
 await pool.query('INSERT INTO wallet_users(scope_id,external_user_id,available) VALUES($1,$2,0)',[scopeId,user]);
 await pool.query("INSERT INTO gp_transfer_bindings(id,app_id,scope_id,issuer,merchant,adapter_id,config,capabilities,status,approved_by) VALUES($1,$2,$3,'fixture_issuer',$4,'synthetic', $5,$6,'active','fixture_operator')",[binding,app.id,scopeId,uid('merchant'),{protocol:'synthetic-only-v1'},{[key]:['IN','OUT','READ','RECONCILE']}]);
 await pool.query("INSERT INTO gp_transfer_accounts(id,binding_id,app_id,player_id,external_user_id,partner_account,proof,verified_by,active) VALUES($1,$2,$3,$4,$5,$6,'{\"kind\":\"synthetic-proof\"}','fixture_operator',true)",[account,binding,app.id,player,user,partnerAccount]);
 const remote=synthetic(),api=service({synthetic:remote.adapter});
 const body=(direction='IN',amount='100',requestId=uid('intent'))=>({request_id:requestId,account_id:account,direction,amount_minor:amount,currency_id:'COIN'});
 const create=(b=body(),s=api)=>s.create(app,{keyId:key,requestId:b.request_id,raw:JSON.stringify(b)});
 const balance=async()=> (await pool.query('SELECT available,reserved,credit_pending FROM wallet_users WHERE scope_id=$1 AND external_user_id=$2',[scopeId,user])).rows[0];
 return{app,scope,scopeId,key,binding,account,player,user,remote,api,body,create,balance};
}
const due=id=>pool.query('UPDATE gp_transfer_outbox SET next_attempt_at=now()-interval \'1 second\',lease_until=NULL WHERE transfer_id=$1',[id]);
async function credit(f,n='100'){const t=await f.create(f.body('IN',n));assert.equal((await f.api.advance(t.transfer_id)).state,'SUCCEEDED');return t;}
async function cleanAudit(){assert.deepEqual(await transferAudit(pool),{clearing_mismatches:0,transfer_order_mismatches:0,wallet_hold_mismatches:0});}

test('unknown production adapter, missing capability and unverified account fail before holding money',async()=>{
 const f=await fixture(),b=f.body();
 await assert.rejects(f.create(b,service()),{code:'TRANSFER_ADAPTER_UNCONFIGURED'});
 await pool.query("UPDATE gp_transfer_bindings SET capabilities='{}' WHERE id=$1",[f.binding]);
 await assert.rejects(f.create(b),{code:'TRANSFER_CAPABILITY_REQUIRED'});
 await pool.query('UPDATE gp_transfer_bindings SET capabilities=$2 WHERE id=$1',[f.binding,{[f.key]:['IN']}]);
 await pool.query('UPDATE gp_transfer_accounts SET active=false WHERE id=$1',[f.account]);
 await assert.rejects(f.create(b),{code:'TRANSFER_ACCOUNT_UNVERIFIED'});
 assert.deepEqual(await f.balance(),{available:'0',reserved:'0',credit_pending:'0'});assert.equal(f.remote.calls.length,0);
 assert.equal((await pool.query('SELECT 1 FROM gp_transfers WHERE app_id=$1',[f.app.id])).rowCount,0);
});
test('inbound reserves capacity then posts one balanced credit; original byte replay is immutable',async()=>{
 const f=await fixture(),body=f.body(),t=await f.create(body);
 assert.deepEqual(await f.balance(),{available:'0',reserved:'0',credit_pending:'100'});
 assert.equal((await f.create(body)).transfer_id,t.transfer_id);
 await assert.rejects(f.create({...body,amount_minor:'101'}),{code:'IDEMPOTENCY_CONFLICT'});
 const done=await f.api.advance(t.transfer_id);assert.equal(done.state,'SUCCEEDED');assert.deepEqual(await f.balance(),{available:'100',reserved:'0',credit_pending:'0'});
 assert.deepEqual((await f.create(body)).receipt,done.receipt);assert.equal(await f.api.advance(t.transfer_id),null);assert.equal(f.remote.calls.length,1);
 const snap=await readWalletSnapshot(pool,{scope:f.scope});assert.equal(snap.ledger.length,3);assert.equal(snap.ledger.reduce((n,r)=>n+BigInt(r.delta_available)+BigInt(r.delta_reserved),0n),0n);await cleanAudit();
});
test('lost external debit ACK retains capacity; process recreation queries original order without a second debit',async()=>{
 const f=await fixture();f.remote.behavior.lost=true;const t=await f.create();const pending=await f.api.advance(t.transfer_id);assert.equal(pending.state,'PENDING');assert.equal(pending.observation,'TRANSFER_UNKNOWN');
 assert.equal((await f.balance()).credit_pending,'100');await due(t.transfer_id);
 const restarted=service({synthetic:f.remote.adapter}),done=await restarted.advance(t.transfer_id);assert.equal(done.state,'SUCCEEDED');
 assert.deepEqual(f.remote.calls.map(x=>x.method),['submit','query']);assert.equal(new Set(f.remote.calls.map(x=>x.raw)).size,1);await cleanAudit();
});
test('outbound lost ACK retains only its owned hold; definitive rejection releases and never changes external clearing',async()=>{
 const f=await fixture();await credit(f,'200');f.remote.behavior.lost=true;const t=await f.create(f.body('OUT','75'));assert.deepEqual(await f.balance(),{available:'125',reserved:'75',credit_pending:'0'});
 await f.api.advance(t.transfer_id);assert.equal((await f.balance()).reserved,'75');await due(t.transfer_id);assert.equal((await f.api.advance(t.transfer_id)).state,'SUCCEEDED');
 assert.deepEqual(await f.balance(),{available:'125',reserved:'0',credit_pending:'0'});
 f.remote.behavior.reject=true;const rejected=await f.create(f.body('OUT','25'));const r=await f.api.advance(rejected.transfer_id);assert.equal(r.state,'REJECTED');assert.equal(r.receipt.rejection_code,'DECLINED');assert.equal((await f.balance()).available,'125');await cleanAudit();
});
test('same external financial transaction under a new request cannot credit twice, including after key rotation',async()=>{
 const f=await fixture();f.remote.behavior.transaction='same_external_transaction';await credit(f);
 const key2=uid('key');await pool.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'partner-to-platform','synthetic')",[key2,f.app.id]);await pool.query('UPDATE gp_transfer_bindings SET capabilities=$2 WHERE id=$1',[f.binding,{[key2]:['IN','READ']}]);
 const body=f.body(),t=await f.api.create(f.app,{keyId:key2,requestId:body.request_id,raw:JSON.stringify(body)});const result=await f.api.advance(t.transfer_id);
 assert.equal(result.state,'PENDING');assert.equal(result.observation,'TRANSFER_DUPLICATE_EXTERNAL_TRANSACTION');assert.deepEqual(await f.balance(),{available:'100',reserved:'0',credit_pending:'100'});await cleanAudit();
});
test('actual shared wallet lock serializes a return against concurrent game-wallet spend without overdraft',async()=>{
 const f=await fixture();await credit(f,'100');const other=uid('mapped');await pool.query('INSERT INTO wallet_users(scope_id,external_user_id,available) VALUES($1,$2,0)',[f.scopeId,other]);
 const results=await Promise.allSettled([f.create(f.body('OUT','80')),giftForTest(pool,{scope:f.scope,request_id:uid('game_spend'),from_user_id:f.user,to_user_id:other,amount_minor:'80'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'INSUFFICIENT_FUNDS');
 const b=await f.balance();assert.equal(b.available,'20');assert(['0','80'].includes(b.reserved));await cleanAudit();
});
test('inbound capacity cannot overflow after external debit; game credits count that reserved capacity',async()=>{
 const f=await fixture();await credit(f,'9223372036854775806');const other=uid('mapped');await pool.query('INSERT INTO wallet_users(scope_id,external_user_id,available) VALUES($1,$2,0)',[f.scopeId,other]);
 await giftForTest(pool,{scope:f.scope,request_id:uid('gift_out'),from_user_id:f.user,to_user_id:other,amount_minor:'1'});
 const t=await f.create(f.body('IN','2'));
 await assert.rejects(f.create(f.body('IN','1')),{code:'AMOUNT_MISMATCH'});assert.equal(f.remote.calls.length,1);
 await assert.rejects(giftForTest(pool,{scope:f.scope,request_id:uid('gift_back'),from_user_id:other,to_user_id:f.user,amount_minor:'1'}),{code:'AMOUNT_MISMATCH'});
 assert.equal((await pool.query('SELECT available FROM wallet_users WHERE scope_id=$1 AND external_user_id=$2',[f.scopeId,other])).rows[0].available,'1');
 await f.api.advance(t.transfer_id);assert.equal((await f.balance()).available,'9223372036854775807');await cleanAudit();
});
test('foreign receipt, unknown and pending responses retain holds and do not become success on HTTP-style status',async()=>{
 const f=await fixture();f.remote.behavior.corrupt=true;const t=await f.create();const r=await f.api.advance(t.transfer_id);assert.equal(r.state,'PENDING');assert.equal(r.observation,'TRANSFER_RECEIPT_INVALID');assert.equal((await f.balance()).available,'0');
 f.remote.behavior.corrupt=false;await due(t.transfer_id);assert.equal((await f.api.advance(t.transfer_id)).state,'SUCCEEDED');
 f.remote.behavior.pending=true;const p=await f.create();assert.equal((await f.api.advance(p.transfer_id)).state,'PENDING');await due(p.transfer_id);await f.api.advance(p.transfer_id);assert.deepEqual(f.remote.calls.slice(-2).map(c=>c.method),['submit','query']);await cleanAudit();
});
test('404 normalized not-found retries original bytes and ID, never releases a pending hold',async()=>{
 const f=await fixture();f.remote.adapter.submit=async h=>{f.remote.calls.push({method:'submit',id:h.operation.operation_id,raw:h.raw_body});throw Error('not sent or unknown');};
 const t=await f.create();await f.api.advance(t.transfer_id);await due(t.transfer_id);await f.api.advance(t.transfer_id);
 assert.deepEqual(f.remote.calls.map(c=>c.method),['submit','query','submit']);assert.equal(new Set(f.remote.calls.map(c=>c.id)).size,1);assert.equal(new Set(f.remote.calls.map(c=>c.raw)).size,1);assert.equal((await f.balance()).credit_pending,'100');
});
test('cross-instance concurrent advances use a durable lease and do not dispatch duplicate attempts',async()=>{
 const f=await fixture();let release;f.remote.behavior.wait=new Promise(r=>release=r);const t=await f.create();const first=f.api.advance(t.transfer_id);
 while(!f.remote.calls.length)await new Promise(r=>setTimeout(r,1));const second=service({synthetic:f.remote.adapter});assert.equal(await second.advance(t.transfer_id),null);release();assert.equal((await first).state,'SUCCEEDED');assert.equal(f.remote.calls.length,1);
});
test('audit failure rolls back money and terminal receipt; later original query safely finalizes once',async()=>{
 const f=await fixture(),t=await f.create();await pool.query(`CREATE FUNCTION fail_transfer_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='transfer.finalized' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER fail_transfer_audit BEFORE INSERT ON gp_audit FOR EACH ROW EXECUTE FUNCTION fail_transfer_audit()`);
 try{assert.equal((await f.api.advance(t.transfer_id)).state,'PENDING');assert.deepEqual(await f.balance(),{available:'0',reserved:'0',credit_pending:'100'});}finally{await pool.query('DROP TRIGGER fail_transfer_audit ON gp_audit;DROP FUNCTION fail_transfer_audit()');}
 await due(t.transfer_id);assert.equal((await f.api.advance(t.transfer_id)).state,'SUCCEEDED');assert.deepEqual(f.remote.calls.map(c=>c.method),['submit','query']);await cleanAudit();
});
test('pause rejects new admission but accepted replay, read and recovery preserve original obligation',async()=>{
 const f=await fixture(),body=f.body(),t=await f.create(body);await pool.query("UPDATE gp_transfer_bindings SET status='disabled' WHERE id=$1",[f.binding]);await pool.query("UPDATE gp_apps SET status='paused' WHERE id=$1",[f.app.id]);
 assert.equal((await f.create(body)).transfer_id,t.transfer_id);await assert.rejects(f.create(),{code:'TRANSFER_ADMISSION_CLOSED'});assert.equal((await f.api.read(f.app,t.transfer_id,{keyId:f.key})).state,'PENDING');assert.equal((await f.api.advance(t.transfer_id)).state,'SUCCEEDED');
});
test('binding destination mutation blocks recovery without releasing or redirecting accepted money',async()=>{
 const f=await fixture(),t=await f.create();await pool.query("UPDATE gp_transfer_bindings SET merchant='changed' WHERE id=$1",[f.binding]);await assert.rejects(f.api.advance(t.transfer_id),{code:'TRANSFER_BINDING_CHANGED'});assert.equal(f.remote.calls.length,0);assert.equal((await f.balance()).credit_pending,'100');
});
test('bounded statement is an append-only ledger cursor; foreign App and ordinary key cannot read',async()=>{
 const f=await fixture();await credit(f);const first=await f.api.statement(f.app,{keyId:f.key,bindingId:f.binding,limit:1});await credit(f,'50');const second=await f.api.statement(f.app,{keyId:f.key,bindingId:f.binding,after:first.next,through:first.through});assert.equal(first.entries.length+second.entries.length,3);
 assert(first.entries.every(r=>r.operation_id.startsWith('transfer_')));await assert.rejects(f.api.statement(f.app,{keyId:'ordinary',bindingId:f.binding}),{code:'TRANSFER_CAPABILITY_REQUIRED'});
 const foreign=await fixture(),t=await f.create();await assert.rejects(foreign.api.read(foreign.app,t.transfer_id,{keyId:foreign.key}),{code:'NOT_FOUND'});
});
test('route contract rejects methods and routes exact authenticated intents; pending is 202, no implicit money retry',async()=>{
 const f=await fixture(),b=f.body(),req={method:'POST',headers:{'x-gp-key-id':f.key,'x-gp-request-id':b.request_id}};
 const r=await routeTransfers(f.api,f.app,req,'/v1/transfers',{raw:JSON.stringify(b)});assert.equal(r.status,202);assert.equal(f.remote.calls.length,0);
 assert.equal((await routeTransfers(f.api,f.app,{...req,method:'GET'},'/v1/transfers')).status,405);
 assert.equal((await routeTransfers(f.api,f.app,{...req,method:'GET'},'/v1/transfers/'+r.body.transfer_id)).body.state,'PENDING');
 assert.equal(await routeTransfers(f.api,f.app,req,'/v1/other',{}),null);
});
test('migration is additive/repeatable, and read-only obligation/audit interfaces retain unresolved transfers',async()=>{
 const before=(await pool.query('SELECT count(*)::int n FROM gp_transfers')).rows[0].n;await migrateTransfers(pool);assert.equal((await pool.query('SELECT count(*)::int n FROM gp_transfers')).rows[0].n,before);
 assert(BigInt((await transferObligations(pool)).pending_transfers)>0n);await cleanAudit();
});
test('timeout and abort-ignoring adapter retain at most four physical slots; close cannot fabricate their completion',async()=>{
 const f=await fixture(),work=[];f.remote.adapter.submit=async()=>new Promise(resolve=>work.push(resolve));
 const bounded=createTransferService({pool,adapters:{synthetic:f.remote.adapter},environment:'production',timeoutMs:5});services.push(bounded);
 const orders=await Promise.all(Array.from({length:5},()=>f.create()));
 for(const t of orders.slice(0,4))assert.equal((await bounded.advance(t.transfer_id)).state,'PENDING');
 assert.equal(bounded.state().physical,4);await assert.rejects(bounded.advance(orders[4].transfer_id),{code:'TRANSFER_BUSY'});
 assert.deepEqual(await bounded.close(),{closed:true,unsettled_adapter_calls:4});
 for(const resolve of work)resolve({state:'SUCCEEDED'});await new Promise(r=>setImmediate(r));assert.equal(bounded.state().physical,0);
 assert.equal((await f.balance()).credit_pending,'500');await assert.rejects(bounded.advance(orders[0].transfer_id),{code:'TRANSFER_STOPPING'});
});
test('full hold reconstruction detects extra or missing transfer capacity and clearing drift',async()=>{
 const f=await fixture();await credit(f);await f.create(f.body('OUT','20'));await f.create(f.body('IN','30'));await cleanAudit();
 await pool.query('UPDATE wallet_users SET credit_pending=credit_pending+1 WHERE scope_id=$1',[f.scopeId]);assert.equal((await transferAudit(pool)).wallet_hold_mismatches,1);
 await pool.query('UPDATE wallet_users SET credit_pending=credit_pending-1 WHERE scope_id=$1',[f.scopeId]);
 await pool.query('UPDATE wallet_transfer_clearing SET net_minor=net_minor+1 WHERE scope_id=$1',[f.scopeId]);assert.equal((await transferAudit(pool)).clearing_mismatches,2);
 await pool.query('UPDATE wallet_transfer_clearing SET net_minor=net_minor-1 WHERE scope_id=$1',[f.scopeId]);await cleanAudit();
});
test('terminal receipt corruption is audited even when balances and external result remain intact',async()=>{
 const f=await fixture(),t=await credit(f),row=(await pool.query('SELECT receipt FROM gp_transfers WHERE id=$1',[t.transfer_id])).rows[0];
 const changes={amount_minor:'999',direction:'OUT',currency_id:'OTHER',external_operation_id:'other_operation',external_transaction_id:'other_external',body_sha256:'0'.repeat(64),unexpected:'not-a-generated-receipt-field'};
 for(const [field,value] of Object.entries(changes)){
  try{
   await pool.query('UPDATE gp_transfers SET receipt=$2 WHERE id=$1',[t.transfer_id,{...row.receipt,[field]:value}]);
   assert.deepEqual(await transferAudit(pool),{clearing_mismatches:0,transfer_order_mismatches:1,wallet_hold_mismatches:0},field);
  }finally{await pool.query('UPDATE gp_transfers SET receipt=$2 WHERE id=$1',[t.transfer_id,row.receipt]);}
 }
 await cleanAudit();
});
test('terminal transaction proof rejects missing, borrowed and own hold IDs while all four valid outcomes stay auditable',async()=>{
 const f=await fixture(),credited=await credit(f,'500');
 const returned=await f.create(f.body('OUT','50'));await f.api.advance(returned.transfer_id);
 f.remote.behavior.reject=true;
 const rejectedIn=await f.create(f.body('IN','25'));await f.api.advance(rejectedIn.transfer_id);
 const rejectedOut=await f.create(f.body('OUT','25'));await f.api.advance(rejectedOut.transfer_id);
 const ids=[credited,returned,rejectedIn,rejectedOut].map(t=>t.transfer_id);
 const rows=(await pool.query('SELECT id,receipt,ledger_transaction_id FROM gp_transfers WHERE id=ANY($1::text[]) ORDER BY id',[ids])).rows;
 assert.equal(rows.length,4);await cleanAudit();
 for(const row of rows){
  const hold=(await pool.query('SELECT transaction_id FROM wallet_ledger WHERE scope_id=$1 AND operation_id=$2 ORDER BY id LIMIT 1',[f.scopeId,row.id])).rows[0].transaction_id;
  const borrowed=rows.find(other=>other.id!==row.id).ledger_transaction_id;
  for(const wrong of [uid('missing_transaction'),borrowed,hold]){
   try{
    await pool.query('UPDATE gp_transfers SET ledger_transaction_id=$2,receipt=$3 WHERE id=$1',[row.id,wrong,{...row.receipt,ledger_transaction_id:wrong}]);
    assert.deepEqual(await transferAudit(pool),{clearing_mismatches:0,transfer_order_mismatches:1,wallet_hold_mismatches:0},row.id+':'+wrong);
   }finally{await pool.query('UPDATE gp_transfers SET ledger_transaction_id=$2,receipt=$3 WHERE id=$1',[row.id,row.ledger_transaction_id,row.receipt]);}
  }
 }
 // Moving a clearing row's operation association changes no balance, amount,
 // transaction sum or ledger version. It must still invalidate this order.
 const clearing=(await pool.query("SELECT id,operation_id FROM wallet_ledger WHERE scope_id=$1 AND operation_id=$2 AND account LIKE 'transfer:%'",[f.scopeId,credited.transfer_id])).rows[0];
 try{
  await pool.query('UPDATE wallet_ledger SET operation_id=$2 WHERE id=$1',[clearing.id,uid('unrelated_order')]);
  assert.deepEqual(await transferAudit(pool),{clearing_mismatches:0,transfer_order_mismatches:1,wallet_hold_mismatches:0});
 }finally{await pool.query('UPDATE wallet_ledger SET operation_id=$2 WHERE id=$1',[clearing.id,clearing.operation_id]);}
 await cleanAudit();
});
test('real pg_dump/restore retains pending holds, original outbox bytes and final receipts, then recovers once',async()=>{
 const f=await fixture();const original=await credit(f,'500');const originalReceipt=(await f.api.read(f.app,original.transfer_id,{keyId:f.key})).receipt;
 f.remote.behavior.lost=true;const pending=await f.create(f.body('OUT','75'));await f.api.advance(pending.transfer_id);
 const restoredName=`oasis_release_test_${process.pid}_${randomBytes(6).toString('hex')}`,restoredUrl=new URL(adminUrl);restoredUrl.pathname='/'+restoredName;
 let restoredPool,restoreCreated=false,restoredService;const dir=await mkdtemp(join(tmpdir(),'oasis-transfer-restore-'));
 try{
  await exec('pg_dump',['--format=custom','--no-owner','--no-acl','--file',join(dir,'snapshot.dump'),dbUrl.href],{timeout:30000,maxBuffer:1024*1024});
  await admin.query(`CREATE DATABASE "${restoredName}"`);restoreCreated=true;
  await exec('pg_restore',['--no-owner','--no-acl','--exit-on-error','--dbname',restoredUrl.href,join(dir,'snapshot.dump')],{timeout:30000,maxBuffer:1024*1024});
  restoredPool=new pg.Pool({connectionString:restoredUrl.href,max:4});await migrateTransfers(restoredPool);
  assert.deepEqual((await restoredPool.query('SELECT * FROM gp_transfer_outbox WHERE transfer_id=$1',[pending.transfer_id])).rows,(await pool.query('SELECT * FROM gp_transfer_outbox WHERE transfer_id=$1',[pending.transfer_id])).rows);
  assert.deepEqual(await transferAudit(restoredPool),await transferAudit(pool));assert.deepEqual(await transferObligations(restoredPool),await transferObligations(pool));
  const restoredAudit=(await restoredPool.query(restoreAuditSQL(true))).rows[0];
  const originalAudit=(await pool.query(restoreAuditSQL(true))).rows[0];assert.deepEqual(restoredAudit,originalAudit);
  const inspected=await psqlProgram(restoreInspectSQL(),restoredUrl),obligations=await psqlProgram(activationSQL,restoredUrl);
  assert.equal(inspected.transfer_schema,'present');assert.equal(obligations.transfer_schema,'present');assert(obligations.pending_transfers>0);assert.equal(obligations.pending_games,0);
  assert.deepEqual(obligations.audit,{clearing_mismatches:0,transfer_order_mismatches:0,wallet_hold_mismatches:0});
  for(const k of ['balance_mismatches','scope_mismatches','unbalanced_transactions','ledger_version_mismatches','orphan_records','invalid_constraints','clearing_mismatches','transfer_order_mismatches','wallet_hold_mismatches'])assert.equal(inspected.audit[k],0,k);
  restoredService=createTransferService({pool:restoredPool,adapters:{synthetic:f.remote.adapter},environment:'production'});
  assert.deepEqual((await restoredService.read(f.app,original.transfer_id,{keyId:f.key})).receipt,originalReceipt);
  await restoredPool.query('UPDATE gp_transfer_outbox SET next_attempt_at=now()-interval \'1 second\' WHERE transfer_id=$1',[pending.transfer_id]);
  assert.equal((await restoredService.advance(pending.transfer_id)).state,'SUCCEEDED');assert.equal(f.remote.calls.at(-1).method,'query');
  assert.equal((await restoredPool.query('SELECT available FROM wallet_users WHERE scope_id=$1 AND external_user_id=$2',[f.scopeId,f.user])).rows[0].available,'425');
 }finally{await restoredService?.close();await restoredPool?.end();if(restoreCreated){await dropOwnedTestDatabase(admin,restoredName,{created:true});console.log(JSON.stringify({cleanup:'owned-transfer-restore-database-removed',name:restoredName}));}await rm(dir,{recursive:true,force:true});}
});
test('statement high watermark never rewrites pending rows with future terminal state; rejected IN remains reconcilable',async()=>{
 const f=await fixture(),body=f.body(),t=await f.create(body);
 const before=await f.api.statement(f.app,{keyId:f.key,bindingId:f.binding,limit:1});assert.equal(before.entries.length,1);
 const row=before.entries[0];assert.equal(row.transfer_id,t.transfer_id);assert.equal(row.request_id,body.request_id);assert.equal(row.external_operation_id,t.transfer_id);assert.equal(row.state_at_entry,'PENDING');assert.equal(row.external_transaction_id,null);assert.equal(row.final_receipt,null);
 await f.api.advance(t.transfer_id);
 const frozen=await f.api.statement(f.app,{keyId:f.key,bindingId:f.binding,through:before.through});assert.deepEqual(frozen.entries,before.entries);
 const after=await f.api.statement(f.app,{keyId:f.key,bindingId:f.binding,after:before.next,limit:1});assert.equal(after.entries.length,1);assert.equal(after.entries[0].state_at_entry,'SUCCEEDED');assert.equal(after.entries[0].external_transaction_id,after.entries[0].final_receipt.external_transaction_id);assert(after.entries[0].external_transaction_id);
 const rest=await f.api.statement(f.app,{keyId:f.key,bindingId:f.binding,after:after.next,through:after.through});assert.equal(rest.entries.length,1);assert.deepEqual(rest.entries[0].final_receipt,after.entries[0].final_receipt);
 f.remote.behavior.reject=true;const rejected=await f.create();await f.api.advance(rejected.transfer_id);
 const events=(await f.api.statement(f.app,{keyId:f.key,bindingId:f.binding,after:rest.next})).entries;assert.deepEqual(events.map(r=>r.state_at_entry),['PENDING','REJECTED']);assert(events.every(r=>r.delta_available==='0'&&r.delta_reserved==='0'));assert.equal(events[1].final_receipt.rejection_code,'DECLINED');
});
test('missing/partial/view transfer schema cannot impersonate the genuine pre-transfer database',async()=>{
 assert.equal(await transferSchema(pool),'present');const db=await pool.connect();
 try{
  await db.query('BEGIN');await db.query('ALTER TABLE gp_transfer_accounts RENAME TO hidden_transfer_accounts');await assert.rejects(transferSchema(db),/TRANSFER_SCHEMA_INCOMPLETE/);await db.query('ROLLBACK');
  await db.query('BEGIN');await db.query('ALTER TABLE gp_transfer_accounts RENAME TO hidden_transfer_accounts;CREATE VIEW gp_transfer_accounts AS SELECT * FROM hidden_transfer_accounts');await assert.rejects(transferSchema(db),/TRANSFER_SCHEMA_INCOMPLETE/);await db.query('ROLLBACK');
  await db.query('BEGIN');await db.query('DROP TABLE gp_transfer_outbox,gp_transfers,gp_transfer_accounts,gp_transfer_bindings,wallet_transfer_clearing CASCADE');await assert.rejects(transferSchema(db),/TRANSFER_SCHEMA_INCOMPLETE/);await db.query('ROLLBACK');
 }finally{await db.query('ROLLBACK');db.release();}
});
test('real psql deploy/restore programs refuse partial schema; sandbox recovery always returns a settled Promise',async()=>{
 await pool.query('ALTER TABLE gp_transfer_accounts RENAME TO hidden_transfer_accounts');
 const refused=label=>error=>{console.log(JSON.stringify({partial_schema_program:label,exit_code:error.code,stderr:error.stderr}));return Number.isInteger(error.code)&&error.code!==0;};
 try{await assert.rejects(psqlProgram(restoreInspectSQL()),refused('restore'));await assert.rejects(psqlProgram(activationSQL),refused('activate'));}finally{await pool.query('ALTER TABLE hidden_transfer_accounts RENAME TO gp_transfer_accounts');}
 const sandbox=createTransferService({pool:{query(){throw Error('sandbox must not query money');}},environment:'sandbox'});await sandbox.recoverPending().catch(()=>assert.fail('sandbox worker rejected'));await sandbox.close();await sandbox.recoverPending().catch(()=>assert.fail('closed worker rejected'));
});
test('outbox byte corruption fails before any external request and is independently audited',async()=>{
 const f=await fixture(),t=await f.create();await pool.query("UPDATE gp_transfer_outbox SET raw_body=raw_body||' ' WHERE transfer_id=$1",[t.transfer_id]);
 await assert.rejects(f.api.advance(t.transfer_id),{code:'TRANSFER_OUTBOX_CHANGED'});assert.equal(f.remote.calls.length,0);assert.equal((await transferAudit(pool)).transfer_order_mismatches,1);
 await pool.query('UPDATE gp_transfer_outbox SET raw_body=rtrim(raw_body) WHERE transfer_id=$1',[t.transfer_id]);await cleanAudit();
});
