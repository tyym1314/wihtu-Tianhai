import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes,scryptSync} from 'node:crypto';
import {createPlayerFixture} from './player-hosted-fixture.mjs';

const uid=p=>p+'_'+randomBytes(8).toString('hex'),password='Synthetic-financial-console-2026!';
let f,pool,portal,security,platform,operations,service,server,base,adminCookie,a,b,secondApp,otherEnvironment,orders={},calls=0,dbName;
const adapters={};
const request=async(path,{cookie=adminCookie,method='GET'}={})=>{const r=await fetch(base+path,{method,headers:{cookie:cookie||'',origin:f.origin}});return{status:r.status,body:await r.json(),headers:r.headers};};
async function partner(name){
 const id=uid('pa'),partnerId=uid('partner'),salt=uid('salt');
 await pool.query('INSERT INTO gp_partner_accounts(id,partner_id,name,username,salt,password_hash) VALUES($1,$2,$3,$1,$4,$5)',[id,partnerId,name,salt,scryptSync(password,salt,64).toString('hex')]);
 const token=randomBytes(32).toString('base64url');await pool.query("INSERT INTO gp_partner_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[security.hash(token),id]);
 return{user:{id,partner_id:partnerId,role:'partner_developer'},cookie:'oasis_partner='+token};
}
async function app(owner){
 const created=await platform.createApp('Synthetic operations app',{partnerId:owner.user.partner_id});
 await pool.query("UPDATE gp_apps SET allowed_origins=$2,status='active' WHERE id=$1",[created.app.id,JSON.stringify([f.origin])]);
 const current=await platform.appById(created.app.id),player=await(await import('../server/player-records.mjs')).registerPlayer(uid('user'),password,current.id);
 const user=(await pool.query('SELECT external_user_id FROM gp_player_app_ids WHERE app_id=$1 AND player_id=$2',[current.id,player.id])).rows[0].external_user_id;
 const key=uid('key'),binding=uid('binding'),account=uid('account'),scope=[current.partner_id,current.id,current.environment,current.wallet_scope_id,current.currency_id].join(':');
 await pool.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'partner-to-platform',$3)",[key,current.id,security.seal('synthetic-secret-do-not-export')]);
 await pool.query("INSERT INTO gp_transfer_bindings(id,app_id,scope_id,issuer,merchant,adapter_id,config,capabilities,status,approved_by) VALUES($1,$2,$3,'fixture','merchant','synthetic',$4,$5,'active','fixture')",[binding,current.id,scope,{endpoint:'https://secret.invalid',credential_ref:'never-export'},{[key]:['IN','OUT','READ']}]);
 await pool.query("INSERT INTO gp_transfer_accounts(id,binding_id,app_id,player_id,external_user_id,partner_account,proof,verified_by,active) VALUES($1,$2,$3,$4,$5,'private-external-account',$6,'fixture',true)",[account,binding,current.id,player.id,user,{private_proof:'never-export'}]);
 return{app:current,key,binding,account,user,scope};
}
async function create(item,label,direction='IN',amount='100'){
 const body={request_id:label,account_id:item.account,direction,amount_minor:amount,currency_id:'COIN'};
 return service.create(item.app,{keyId:item.key,requestId:label,raw:JSON.stringify(body)});
}
async function snapshot(){
 const names=['gp_transfers','gp_transfer_outbox','gp_transfer_bindings','gp_transfer_accounts','wallet_transfer_clearing','wallet_users','wallet_scopes','wallet_ledger','gp_audit'];
 return Object.fromEntries(await Promise.all(names.map(async name=>[name,(await pool.query(`SELECT COALESCE(jsonb_agg(v ORDER BY v::text),'[]') AS rows FROM (SELECT to_jsonb(x) v FROM ${name} x) t`)).rows[0].rows])));
}
before(async()=>{
 f=await createPlayerFixture();pool=f.pool;dbName=(await pool.query('SELECT current_database() AS name')).rows[0].name;
 security=await import('../server/security.mjs');platform=await import('../server/platform.mjs');portal=await import('../server/portal.mjs');operations=await import('../server/transfer-operations.mjs');await portal.migratePortal();
 const core=await import('../server/transfers/index.mjs');await core.migrateTransfers(pool);
 const salt=uid('salt');await pool.query('INSERT INTO gp_admins(id,username,salt,password_hash) VALUES($1,$1,$2,$3)',['ops_admin',salt,scryptSync(password,salt,64).toString('hex')]);
 adminCookie='oasis_admin='+(await platform.login('ops_admin',password)).token;
 a=await partner('Alpha');b=await partner('Beta');a.item=await app(a);b.item=await app(b);secondApp=await app(a);otherEnvironment=await app(a);
 service=core.createTransferService({pool,environment:'production',adapters:{synthetic:{idempotentReplay:true,authoritativeQuery:true,validateBinding:()=>true,
  submit:async h=>{calls++;const state=adapters[h.operation.operation_id]||'SUCCEEDED';if(state==='UNKNOWN')throw Error('secret-provider-error');return{...h.operation,body_sha256:h.body_sha256,state,transaction_id:'ext_'+h.operation.operation_id,final:state==='REJECTED',rejection_code:'DECLINED',provider_raw:{secret:'never-export'}};},query:async()=>{calls++;throw Error('No console query may call adapter');}}}});
 orders.pending=await create(a.item,'request_pending');orders.success=await create(a.item,'request_success');await service.advance(orders.success.transfer_id);
 orders.rejected=await create(a.item,'request_rejected');adapters[orders.rejected.transfer_id]='REJECTED';await service.advance(orders.rejected.transfer_id);
 orders.unknown=await create(a.item,'request_unknown','OUT','40');adapters[orders.unknown.transfer_id]='UNKNOWN';await service.advance(orders.unknown.transfer_id);
 orders.otherApp=await create(secondApp,'request_other_app');orders.foreign=await create(b.item,'request_foreign');orders.sandbox=await create(otherEnvironment,'request_other_environment');
 await pool.query("UPDATE gp_apps SET environment='sandbox' WHERE id=$1",[otherEnvironment.app.id]);await pool.query("UPDATE wallet_scopes SET environment='sandbox' WHERE scope_id=$1",[otherEnvironment.scope]);
 server=createServer(async(req,res)=>{try{
  if(await portal.routePortal(req,res,req.url,{}))return;
  const user=await platform.adminUser(req);if(!user)security.fail(401,'LOGIN_REQUIRED');
  if(await operations.routeTransferOperations(req,res,req.url,user,{pool,environment:'production'}))return;
  security.fail(404,'NOT_FOUND');
 }catch(e){security.send(res,e.status||500,{error:{code:e.code||'INTERNAL_ERROR'}});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{if(server?.listening)await new Promise(r=>server.close(r));await service?.close();await f?.close();console.log(JSON.stringify({cleanup:'owned-transfer-operations-database-and-loopback-listeners-removed',name:dbName,listening:server?.listening===true}));});

test('existing console cookie identities enforce admin/partner separation and GET-only authority',async()=>{
 assert.equal((await request('/api/admin/transfers',{cookie:null})).status,401);
 assert.equal((await request('/api/admin/transfers',{cookie:a.cookie})).status,401);
 assert.equal((await request('/api/partner/transfers',{cookie:adminCookie})).status,401);
 assert.equal((await request('/api/admin/transfers',{method:'POST'})).status,405);
 assert.equal((await request('/api/partner/transfers',{cookie:a.cookie,method:'POST'})).status,405);
 await assert.rejects(operations.readTransferOperations(pool,{id:'viewer',role:'unrecognized'},'production','/api/admin/transfers'),{code:'SCOPE_FORBIDDEN'});
 await assert.rejects(operations.readTransferOperations(pool,{...a.user,role:'platform_admin'},'production','/api/partner/transfers'),{code:'SCOPE_FORBIDDEN'});
});
test('SQL scopes list and detail by partner, App and runtime environment before projection',async()=>{
 const all=await request('/api/admin/transfers');assert.equal(all.status,200);assert.equal(all.body.transfers.length,6);assert(all.body.transfers.every(t=>t.environment==='production'));
 const own=await request('/api/partner/transfers',{cookie:a.cookie});assert.equal(own.status,200);assert.equal(own.body.transfers.length,5);assert(own.body.transfers.every(t=>t.partner_id===a.user.partner_id));
 const one=await request('/api/partner/transfers?app_id='+a.item.app.id,{cookie:a.cookie});assert.equal(one.body.transfers.length,4);assert(one.body.transfers.every(t=>t.app_id===a.item.app.id));
 for(const path of ['/api/partner/transfers?app_id='+b.item.app.id,'/api/partner/transfers/'+orders.foreign.transfer_id,'/api/partner/transfers/transfer_missing','/api/partner/transfers/'+orders.pending.transfer_id+'?app_id='+secondApp.app.id])assert.equal((await request(path,{cookie:a.cookie})).status,404);
 for(const prefix of ['/api/admin','/api/partner']){const cookie=prefix.endsWith('partner')?a.cookie:adminCookie;assert.equal((await request(prefix+'/transfers/'+orders.sandbox.transfer_id,{cookie})).status,404);assert.equal((await request(prefix+'/transfers?app_id='+otherEnvironment.app.id,{cookie})).status,404);}
});
test('bounded exact filters reject duplicate, injected tenant, malformed and oversized pagination parameters',async()=>{
 for(const q of ['limit=0','limit=101','limit=1e2','limit=01','limit=-1','limit=2&limit=3','state=FAILED','partner_id='+b.user.partner_id,'environment=sandbox','app_id=','request_id=a%27','cursor=','cursor=e30','limit='+('9'.repeat(4096))]){
  const r=await request('/api/partner/transfers?'+q,{cookie:a.cookie});assert.equal(r.status,400,q);
 }
 for(const suffix of ['/bad%2Fid','/bad/extra','/'+orders.pending.transfer_id+'?state=PENDING'])assert([400,404].includes((await request('/api/admin/transfers'+suffix)).status));
 const r=await request('/api/partner/transfers?request_id=request_unknown&state=PENDING',{cookie:a.cookie});assert.equal(r.body.transfers.length,1);assert.equal(r.body.transfers[0].transfer_id,orders.unknown.transfer_id);
});
test('keyset pagination preserves microsecond ordering, excludes later inserts and binds its tenant/filter',async()=>{
 const ids=[orders.pending.transfer_id,orders.success.transfer_id,orders.rejected.transfer_id,orders.unknown.transfer_id];
 for(let i=0;i<ids.length;i++)await pool.query("UPDATE gp_transfers SET created_at='2026-01-01T00:00:00Z'::timestamptz+$2::int*interval '1 microsecond' WHERE id=$1",[ids[i],i]);
 const path='/api/partner/transfers?app_id='+a.item.app.id+'&limit=1',first=await request(path,{cookie:a.cookie});assert.equal(first.body.transfers[0].transfer_id,ids[3]);assert(first.body.next_cursor);
 const late=await create(a.item,'request_later');const seen=[first.body.transfers[0].transfer_id];let cursor=first.body.next_cursor;
 while(cursor){const page=await request(path+'&cursor='+cursor,{cookie:a.cookie});assert.equal(page.status,200);seen.push(...page.body.transfers.map(t=>t.transfer_id));cursor=page.body.next_cursor;assert(seen.length<=4);}
 assert.deepEqual(seen,ids.reverse());assert(!seen.includes(late.transfer_id));
 for(const [target,cookie] of [[path.replace(a.item.app.id,secondApp.app.id),a.cookie],[path+'&state=PENDING',a.cookie],[path,b.cookie]])assert.equal((await request(target+'&cursor='+first.body.next_cursor,{cookie})).status,400);
 for(const invalid of [['not-a-time','transfer_bad'],['0000-01-01T00:00:00.000000Z','transfer_bad'],['2026-02-31T00:00:00.000000Z','transfer_bad'],['2025-02-29T00:00:00.000000Z','transfer_bad'],['2026-01-01T24:00:00.000000Z','transfer_bad'],['2025-01-01T00:00:00.000000Z',['transfer_bad']]]){
  const tampered=JSON.parse(Buffer.from(first.body.next_cursor,'base64url'));tampered.after=invalid;assert.equal((await request(path+'&cursor='+Buffer.from(JSON.stringify(tampered)).toString('base64url'),{cookie:a.cookie})).status,400,JSON.stringify(invalid));
 }
});
test('pending unknown OUT retains hold, original age and durable backoff; GET never advances or mutates',async()=>{
 await pool.query("UPDATE gp_transfers SET created_at=now()-interval '2 days',updated_at=now() WHERE id=$1",[orders.unknown.transfer_id]);
 await pool.query("UPDATE gp_transfer_outbox SET next_attempt_at=now()+interval '4 minutes' WHERE transfer_id=$1",[orders.unknown.transfer_id]);
 await pool.query("UPDATE gp_transfer_bindings SET status='disabled' WHERE id=$1",[a.item.binding]);
 const before=await snapshot(),count=calls,r=await request('/api/partner/transfers/'+orders.unknown.transfer_id,{cookie:a.cookie}),t=r.body.transfer;
 assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(t.state,'PENDING');assert.equal(t.status_basis,'stored_order_not_reconciled');assert.equal(t.error_category,'OUTCOME_UNKNOWN');assert.equal(t.local_state,'FUNDS_HELD');assert.equal(t.external_state,'UNKNOWN');assert.equal(t.retry_state,'BACKOFF');assert(t.age_seconds>=172799);assert.equal(t.attempts,1);assert.deepEqual(t.hold,{kind:'FUNDS_RESERVED',amount_minor:'40'});assert.equal(t.receipt,null);assert.equal(t.admission.binding_status,'disabled');
 await request('/api/admin/transfers?state=PENDING');await request('/api/partner/transfers?app_id='+a.item.app.id,{cookie:a.cookie});
 assert.deepEqual(await snapshot(),before);assert.equal(calls,count);
});
test('terminal bilateral receipt is whitelisted, while rejected and pending capacity have distinct financial semantics',async()=>{
 for(const name of ['success','rejected','pending']){
  const r=await request('/api/admin/transfers/'+orders[name].transfer_id);assert.equal(r.status,200);const t=r.body.transfer;
  assert(!/never-export|private-external-account|synthetic-secret|secret-provider-error|provider_raw|binding_snapshot|account_snapshot|lease_token|raw_body|capabilities|credential_ref/.test(JSON.stringify(r.body)));
  if(name==='success'){assert.equal(t.local_state,'CREDITED');assert.equal(t.external_state,'SUCCEEDED');assert.equal(t.pending_age_seconds,null);assert.equal(t.next_attempt_at,null);assert.equal(t.retry_state,'TERMINAL');assert.equal(t.receipt.external_transaction_id,t.external_transaction_id);assert(t.receipt.ledger_transaction_id);assert.equal(t.hold.amount_minor,'0');}
  if(name==='rejected'){assert.equal(t.local_state,'HOLD_RELEASED');assert.equal(t.external_state,'REJECTED');assert.equal(t.receipt.rejection_code,'DECLINED');assert.equal(t.external_transaction_id,null);}
  if(name==='pending'){assert.equal(t.local_state,'CAPACITY_HELD');assert.equal(t.external_state,'NOT_OBSERVED');assert.equal(t.hold.kind,'CREDIT_CAPACITY_RESERVED');}
 }
});
test('IN_FLIGHT and unknown observations remain honest, no raw arbitrary provider error escapes',async()=>{
 await pool.query("UPDATE gp_transfer_outbox SET lease_until=now()+interval '20 seconds',lease_token='private-lease-token' WHERE transfer_id=$1",[orders.pending.transfer_id]);
 await pool.query("UPDATE gp_transfers SET observation='unexpected:password=never-export' WHERE id=$1",[orders.pending.transfer_id]);
 const r=await request('/api/admin/transfers/'+orders.pending.transfer_id);assert.equal(r.body.transfer.retry_state,'IN_FLIGHT');assert.equal(r.body.transfer.observation,'UNKNOWN');assert.equal(r.body.transfer.error_category,'UNCLASSIFIED');assert(!JSON.stringify(r.body).includes('never-export'));assert(!JSON.stringify(r.body).includes('private-lease-token'));
});
test('readonly transaction rejects accidental SQL writes and releases connections after errors',async()=>{
 let transactionChecked=false;
 const instrumented={async connect(){const c=await pool.connect();return{release:()=>c.release(),async query(sql,args){const result=await c.query(sql,args);if(sql==='SELECT transaction_timestamp() AS at'){
  assert.equal((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');assert.equal((await c.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'repeatable read');transactionChecked=true;
 }return result;}};}};
 await operations.readTransferOperations(instrumented,{id:'ops_admin',role:'platform_admin'},'production','/api/admin/transfers');assert(transactionChecked);
 const before=await snapshot();for(let i=0;i<3;i++)assert.equal((await request('/api/admin/transfers/transfer_missing')).status,404);assert.deepEqual(await snapshot(),before);
});
test('expired or disabled partner account revokes access without relying on UI visibility',async()=>{
 await pool.query('UPDATE gp_partner_accounts SET active=false WHERE id=$1',[a.user.id]);assert.equal((await request('/api/partner/transfers',{cookie:a.cookie})).status,401);
 await pool.query("UPDATE gp_partner_sessions SET expires_at=now()-interval '1 second' WHERE account_id=$1",[b.user.id]);assert.equal((await request('/api/partner/transfers/'+orders.foreign.transfer_id,{cookie:b.cookie})).status,401);
 assert.equal((await request('/api/admin/transfers/'+orders.foreign.transfer_id)).status,200);
});
