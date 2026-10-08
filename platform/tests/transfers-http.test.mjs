import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {createPlayerFixture} from './player-hosted-fixture.mjs';
import {migrateTransfers,createTransferService} from '../server/transfers/index.mjs';
import {routeTransfers} from '../server/transfers/routes.mjs';
const uid=p=>p+'_'+randomBytes(8).toString('hex');
let fixture,server,base,security,platform,service,key,secret,account,binding,databaseName;
before(async()=>{
 fixture=await createPlayerFixture();security=await import('../server/security.mjs');platform=await import('../server/platform.mjs');await migrateTransfers(fixture.pool);
 databaseName=(await fixture.pool.query('SELECT current_database() AS name')).rows[0].name;
 const player=await(await import('../server/player-records.mjs')).registerPlayer(uid('user'),'Synthetic-transfer-password!',fixture.app.id);
 const mapped=(await fixture.pool.query('SELECT external_user_id FROM gp_player_app_ids WHERE app_id=$1 AND player_id=$2',[fixture.app.id,player.id])).rows[0].external_user_id;
 key=uid('key');secret=randomBytes(32).toString('base64');binding=uid('binding');account=uid('account');
 await fixture.pool.query("INSERT INTO gp_keys(id,app_id,direction,secret_enc) VALUES($1,$2,'partner-to-platform',$3)",[key,fixture.app.id,security.seal(secret)]);
 const scopeId=[fixture.app.partner_id,fixture.app.id,'production',fixture.app.wallet_scope_id,'COIN'].join(':');
 await fixture.pool.query("INSERT INTO gp_transfer_bindings(id,app_id,scope_id,issuer,merchant,adapter_id,config,approved_by) VALUES($1,$2,$3,'issuer','merchant','unconfigured','{}','synthetic_operator')",[binding,fixture.app.id,scopeId]);
 await fixture.pool.query("INSERT INTO gp_transfer_accounts(id,binding_id,app_id,player_id,external_user_id,partner_account,proof,verified_by,active) VALUES($1,$2,$3,$4,$5,'remote','{\"proof\":\"synthetic\"}','synthetic_operator',true)",[account,binding,fixture.app.id,player.id,mapped]);
 service=createTransferService({pool:fixture.pool,environment:'production'});
 server=createServer(async(req,res)=>{try{const{raw,body}=await security.readBody(req);const app=await platform.authenticatePartner(req,raw,body);const result=await routeTransfers(service,app,req,req.url,{raw});security.send(res,result?.status||404,result?.body||{code:'NOT_FOUND'});}catch(e){security.send(res,e.status||500,{code:e.code||'INTERNAL_ERROR'});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{if(server?.listening)await new Promise(r=>server.close(r));await service?.close();await fixture?.close();console.log(JSON.stringify({cleanup:'owned-transfer-http-database-and-listeners-removed',name:databaseName,listening:server?.listening===true}));});
function signed(body,extra={}){const raw=JSON.stringify(body);return{method:'POST',body:raw,headers:{...security.sign({key_id:key,secret_base64:secret,method:'POST',path:'/v1/transfers',raw,request_id:body.request_id}),...extra}};}
test('actual loopback HTTP HMAC authenticates only App; it cannot bypass independent financial grants or manufacture an adapter',async()=>{
 const body={request_id:uid('request'),account_id:account,direction:'IN',amount_minor:'100',currency_id:'COIN'};
 let r=await fetch(base+'/v1/transfers',signed(body,{'X-GP-Signature':'v1='+'0'.repeat(64)}));assert.equal(r.status,401);assert.equal((await r.json()).code,'SIGNATURE_INVALID');
 r=await fetch(base+'/v1/transfers',signed(body));assert.equal(r.status,403);assert.equal((await r.json()).code,'TRANSFER_CAPABILITY_REQUIRED');
 await fixture.pool.query("UPDATE gp_transfer_bindings SET capabilities=$2,status='active' WHERE id=$1",[binding,{[key]:['IN','READ']}]);
 r=await fetch(base+'/v1/transfers',signed(body));assert.equal(r.status,503);assert.equal((await r.json()).code,'TRANSFER_ADAPTER_UNCONFIGURED');
 assert.equal((await fixture.pool.query('SELECT 1 FROM gp_transfers')).rowCount,0);assert.equal((await fixture.pool.query('SELECT 1 FROM wallet_users WHERE credit_pending<>0 OR reserved<>0 OR available<>0')).rowCount,0);
});
test('replayed network authentication nonce is rejected before intent handling',async()=>{
 const body={request_id:uid('request'),account_id:account,direction:'IN',amount_minor:'100',currency_id:'COIN'},options=signed(body);
 assert.equal((await fetch(base+'/v1/transfers',options)).status,503);const r=await fetch(base+'/v1/transfers',options);assert.equal(r.status,401);assert.equal((await r.json()).code,'NONCE_REPLAY');
});
test('reviewed synthetic adapter over real authenticated HTTP exposes only the exact original receipt and reconcilable ledger',async()=>{
 await service.close();let calls=0;
 const adapter={idempotentReplay:true,authoritativeQuery:true,validateBinding:()=>true,submit:async h=>{calls++;return{...h.operation,body_sha256:h.body_sha256,state:'SUCCEEDED',transaction_id:'synthetic_'+h.operation.operation_id};},query:async()=>{throw Error('unexpected original-order query');}};
 service=createTransferService({pool:fixture.pool,environment:'production',adapters:{unconfigured:adapter}});
 await fixture.pool.query('UPDATE gp_transfer_bindings SET capabilities=$2 WHERE id=$1',[binding,{[key]:['IN','READ','RECONCILE']}]);
 const body={request_id:uid('request'),account_id:account,direction:'IN',amount_minor:'100',currency_id:'COIN'};
 const first=await fetch(base+'/v1/transfers',signed(body));assert.equal(first.status,202);const admitted=await first.json();assert.equal(calls,0);
 await service.advance(admitted.transfer_id);assert.equal(calls,1);
 const get=async path=>{const r=await fetch(base+path,{headers:security.sign({key_id:key,secret_base64:secret,method:'GET',path,raw:'',request_id:uid('query')})});assert.equal(r.status,200);return r.json();};
 const result=await get('/v1/transfers/'+admitted.transfer_id);assert.equal(result.state,'SUCCEEDED');assert.equal(result.request_id,body.request_id);assert.equal(result.receipt.amount_minor,'100');
 const replay=await fetch(base+'/v1/transfers',signed(body));assert.equal(replay.status,200);assert.deepEqual((await replay.json()).receipt,result.receipt);assert.equal(calls,1);
 const ledger=await get('/v1/transfer-ledger/'+binding+'/0/latest');assert.equal(ledger.entries.length,3);assert(ledger.entries.every(row=>row.request_id===body.request_id));assert.equal(ledger.entries[0].state_at_entry,'PENDING');assert.deepEqual(ledger.entries[1].final_receipt,result.receipt);
});
