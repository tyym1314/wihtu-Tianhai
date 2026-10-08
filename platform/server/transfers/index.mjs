import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {withTransferLedger} from '../wallet/index.mjs';
import {parseRaw} from '../wallet/security.mjs';

const fields=['partner_id','app_id','environment','wallet_scope_id','currency_id'];
const scopeOf=a=>({partner_id:a.partner_id,app_id:a.id,environment:a.environment,wallet_scope_id:a.wallet_scope_id,currency_id:a.currency_id});
const scopeId=s=>fields.map(k=>s[k]).join(':');
const safe=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const hash=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
const same=(a,b)=>canonical(a)===canonical(b);
const frozen=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))frozen(x);Object.freeze(v);}return v;};
const bindingIdentity=b=>({id:b.id,app_id:b.app_id,scope_id:b.scope_id,issuer:b.issuer,merchant:b.merchant,adapter_id:b.adapter_id,config:b.config});
const accountIdentity=a=>({id:a.id,binding_id:a.binding_id,app_id:a.app_id,player_id:a.player_id,external_user_id:a.external_user_id,partner_account:a.partner_account,proof:a.proof});
const publicOrder=t=>({transfer_id:t.id,request_id:t.request_id,app_id:t.app_id,direction:t.direction,amount_minor:t.amount_minor,currency_id:t.currency_id,state:t.state,observation:t.observation,receipt:t.receipt,created_at:t.created_at,updated_at:t.updated_at});
export class TransferError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
export const TRANSFER_PUBLIC_CODES=Object.freeze(['TRANSFER_PRODUCTION_REQUIRED','TRANSFER_PLATFORM_WALLET_REQUIRED','TRANSFER_CAPABILITY_REQUIRED','TRANSFER_ADMISSION_CLOSED','TRANSFER_ACCOUNT_UNVERIFIED','TRANSFER_ADAPTER_UNCONFIGURED','TRANSFER_BINDING_INVALID','TRANSFER_STOPPING','TRANSFER_BUSY']);
const fail=(status,code)=>{throw new TransferError(status,code);};
const delay=attempt=>Math.min(300000,3000*2**Math.min(7,Math.max(0,attempt-1)));

export async function migrateTransfers(pool){
 const db=await pool.connect();
 try{await db.query('BEGIN');await db.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));await db.query('COMMIT');}
 catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}

/** adapters is a trusted, code-reviewed registry, never request/config code.
 * No real partner protocol is assumed or registered by the service default. */
export function createTransferService({pool,adapters={},environment='sandbox',timeoutMs=3000}={}){
 if(!pool||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw Error('INVALID_TRANSFER_SERVICE');
 const registry=new Map(Object.entries(adapters)),active=new Map(),physical=new Map();let recoveryTask=null,closed=false;
 const adapterFor=b=>{
  const a=registry.get(b.adapter_id);
  if(!a||a.idempotentReplay!==true||a.authoritativeQuery!==true||typeof a.query!=='function'||typeof a.submit!=='function'||typeof a.validateBinding!=='function'||a.validateBinding(frozen(structuredClone(bindingIdentity(b))))!==true)fail(503,'TRANSFER_ADAPTER_UNCONFIGURED');
  return a;
 };
 async function currentApp(db,app){
  if(environment!=='production'||app?.environment!=='production'||!safe(app.id))fail(403,'TRANSFER_PRODUCTION_REQUIRED');
  const a=(await db.query('SELECT * FROM gp_apps WHERE id=$1 FOR SHARE',[app.id])).rows[0];
  if(!a||a.environment!=='production'||!same(scopeOf(a),scopeOf(app)))fail(403,'SCOPE_FORBIDDEN');
  const b=(await db.query('SELECT * FROM gp_wallet_bindings WHERE app_id=$1 FOR SHARE',[a.id])).rows[0];
  if(b?.provider!=='platform'||a.wallet_url!==''||b.wallet_url!==null||b.wallet_key_id!==null||!same(b.scope,scopeOf(a)))fail(403,'TRANSFER_PLATFORM_WALLET_REQUIRED');
  return a;
 }
 async function authorize(db,app,keyId,bindingId,capability,{admit=false}={}){
  const a=await currentApp(db,app);
  const b=(await db.query('SELECT * FROM gp_transfer_bindings WHERE id=$1 AND app_id=$2 FOR SHARE',[bindingId,a.id])).rows[0];
  const key=(await db.query("SELECT id FROM gp_keys WHERE id=$1 AND app_id=$2 AND active AND direction='partner-to-platform' FOR SHARE",[keyId,a.id])).rows[0];
  if(!b||b.scope_id!==scopeId(scopeOf(a))||!key||!Array.isArray(b.capabilities[keyId])||!b.capabilities[keyId].includes(capability)||!b.approved_by)fail(403,'TRANSFER_CAPABILITY_REQUIRED');
  if(admit&&(a.status!=='active'||b.status!=='active'))fail(403,'TRANSFER_ADMISSION_CLOSED');
  return b;
 }
 async function create(app,{keyId,requestId,raw}){
  if(closed)fail(503,'TRANSFER_STOPPING');
  if(typeof raw!=='string'||Buffer.byteLength(raw)>8192)fail(400,'INVALID_REQUEST');
  const body=parseRaw(Buffer.from(raw));
  if(!same(Object.keys(body).sort(),['account_id','amount_minor','currency_id','direction','request_id'])||!safe(body.account_id)||!safe(body.request_id)||body.request_id!==requestId||!['IN','OUT'].includes(body.direction)||typeof body.amount_minor!=='string'||!/^[1-9][0-9]{0,18}$/.test(body.amount_minor)||BigInt(body.amount_minor)>9223372036854775807n||body.currency_id!==app.currency_id)fail(400,'INVALID_REQUEST');
  const s=scopeOf(app),tid='transfer_'+randomUUID().replaceAll('-','');
  return withTransferLedger(pool,s,tid,async c=>{
   const old=(await c.db.query('SELECT * FROM gp_transfers WHERE app_id=$1 AND request_id=$2',[app.id,requestId])).rows[0];
   if(old){await authorize(c.db,app,keyId,old.binding_id,old.direction);if(old.request_body!==raw)fail(409,'IDEMPOTENCY_CONFLICT');return publicOrder(old);}
   const account=(await c.db.query('SELECT * FROM gp_transfer_accounts WHERE id=$1 AND app_id=$2 FOR SHARE',[body.account_id,app.id])).rows[0];
   if(!account||!account.active||!account.verified_by||!account.proof||!Object.keys(account.proof).length)fail(403,'TRANSFER_ACCOUNT_UNVERIFIED');
   const b=await authorize(c.db,app,keyId,account.binding_id,body.direction,{admit:true});adapterFor(b);
   const mapped=(await c.db.query('SELECT 1 FROM gp_player_app_ids m JOIN gp_players p ON p.id=m.player_id WHERE m.app_id=$1 AND m.player_id=$2 AND m.external_user_id=$3 AND p.active FOR SHARE',[app.id,account.player_id,account.external_user_id])).rowCount;
   if(!mapped)fail(403,'TRANSFER_ACCOUNT_UNVERIFIED');
   if(!safe(b.issuer)||!safe(b.merchant)||!safe(account.partner_account))fail(409,'TRANSFER_BINDING_INVALID');
   await c.hold(account.external_user_id,body.direction,body.amount_minor);
   const row=(await c.db.query(`INSERT INTO gp_transfers(id,request_id,app_id,scope_id,binding_id,account_id,external_user_id,direction,amount_minor,currency_id,request_body,request_sha256,binding_snapshot,account_snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[tid,requestId,app.id,c.scopeId,b.id,account.id,account.external_user_id,body.direction,body.amount_minor,body.currency_id,raw,hash(raw),bindingIdentity(b),accountIdentity(account)])).rows[0];
   const operation={...s,operation_id:tid,issuer:b.issuer,merchant:b.merchant,partner_account:account.partner_account,direction:body.direction,amount_minor:body.amount_minor,currency_scale:c.scope.currency_scale};
   const bytes=canonical(operation);
   await c.db.query('INSERT INTO gp_transfer_outbox(transfer_id,operation_id,raw_body,body_sha256,issuer,merchant,environment) VALUES($1,$1,$2,$3,$4,$5,$6)',[tid,bytes,hash(bytes),b.issuer,b.merchant,s.environment]);
   await c.db.query("INSERT INTO gp_audit(actor,action,app_id,detail) VALUES($1,'transfer.created',$2,$3)",[keyId,app.id,{transfer_id:tid,direction:body.direction,amount_minor:body.amount_minor}]);
   return publicOrder(row);
  });
 }
 async function read(app,id,{keyId}={}){
  if(!safe(id))fail(400,'INVALID_REQUEST');
  const t=(await pool.query('SELECT * FROM gp_transfers WHERE id=$1 AND app_id=$2',[id,app.id])).rows[0];if(!t)fail(404,'NOT_FOUND');
  await authorize(pool,app,keyId,t.binding_id,'READ');return publicOrder(t);
 }
 async function claim(id){
  const t=(await pool.query('SELECT * FROM gp_transfers WHERE id=$1',[id])).rows[0];if(!t||t.state!=='PENDING')return null;
  // Scope is read from the authoritative wallet row, never adapter config.
  const scope=(await pool.query('SELECT * FROM wallet_scopes WHERE scope_id=$1',[t.scope_id])).rows[0];if(!scope||scope.environment!=='production')fail(409,'TRANSFER_SCOPE_CHANGED');
  return withTransferLedger(pool,Object.fromEntries(fields.map(k=>[k,scope[k]])),id,async c=>{
   await currentApp(c.db,{...scope,id:scope.app_id});
   const row=(await c.db.query('SELECT * FROM gp_transfers WHERE id=$1 FOR UPDATE',[id])).rows[0];if(row.state!=='PENDING')return null;
   const out=(await c.db.query('SELECT *,next_attempt_at<=clock_timestamp() AS due,(lease_until IS NULL OR lease_until<=clock_timestamp()) AS free FROM gp_transfer_outbox WHERE transfer_id=$1 FOR UPDATE',[id])).rows[0];
   if(!out.due||!out.free)return null;
   const b=(await c.db.query('SELECT * FROM gp_transfer_bindings WHERE id=$1 FOR SHARE',[row.binding_id])).rows[0];
   if(!b||!same(bindingIdentity(b),row.binding_snapshot))fail(409,'TRANSFER_BINDING_CHANGED');
   const expected={...Object.fromEntries(fields.map(k=>[k,scope[k]])),operation_id:row.id,issuer:b.issuer,merchant:b.merchant,partner_account:row.account_snapshot.partner_account,direction:row.direction,amount_minor:row.amount_minor,currency_scale:scope.currency_scale};
   if(hash(out.raw_body)!==out.body_sha256||!same(parseRaw(Buffer.from(out.raw_body)),expected)||hash(row.request_body)!==row.request_sha256)fail(409,'TRANSFER_OUTBOX_CHANGED');
   const a=adapterFor(b),token=randomUUID();
   await c.db.query("UPDATE gp_transfer_outbox SET attempts=attempts+1,lease_token=$2,lease_until=clock_timestamp()+interval '30 seconds',next_attempt_at=clock_timestamp()+$3::int*interval '1 millisecond' WHERE transfer_id=$1",[id,token,delay(out.attempts+1)]);
   return{row,out,adapter:a,token,scope:Object.fromEntries(fields.map(k=>[k,scope[k]]))};
  });
 }
 async function adapterCall(adapter,method,handle){
  if(physical.size>=4)fail(503,'TRANSFER_BUSY');
  const controller=new AbortController();let timer;
  const work=Promise.resolve().then(()=>adapter[method](handle,{signal:controller.signal}));
  physical.set(work,controller);work.then(()=>physical.delete(work),()=>physical.delete(work));
  // An adapter ignoring abort retains its physical slot until it actually
  // settles. Timeouts cannot turn a broken adapter into unlimited live I/O.
  try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new TransferError(503,'TRANSFER_UNKNOWN'));},timeoutMs);})]);}
  finally{clearTimeout(timer);}
 }
 function validateResult(result,handle){
  if(!result||typeof result!=='object'||Array.isArray(result)||Buffer.byteLength(JSON.stringify(result))>32768)fail(503,'TRANSFER_RECEIPT_INVALID');
  for(const[k,v]of Object.entries(handle.operation))if(result[k]!==v)fail(503,'TRANSFER_RECEIPT_INVALID');
  if(result.body_sha256!==handle.body_sha256||!['PENDING','SUCCEEDED','REJECTED','NOT_FOUND'].includes(result.state))fail(503,'TRANSFER_RECEIPT_INVALID');
  if(result.state==='SUCCEEDED'&&!safe(result.transaction_id))fail(503,'TRANSFER_RECEIPT_INVALID');
  if(result.state==='REJECTED'&&(result.final!==true||!safe(result.rejection_code)))fail(503,'TRANSFER_RECEIPT_INVALID');
  return result;
 }
 async function settle(job,result,errorCode){
  return withTransferLedger(pool,job.scope,job.row.id,async c=>{
   const t=(await c.db.query('SELECT * FROM gp_transfers WHERE id=$1 FOR UPDATE',[job.row.id])).rows[0];
   const out=(await c.db.query('SELECT * FROM gp_transfer_outbox WHERE transfer_id=$1 FOR UPDATE',[t.id])).rows[0];
   if(t.state!=='PENDING'||out.lease_token!==job.token)return publicOrder(t);
   if(errorCode||!['SUCCEEDED','REJECTED'].includes(result?.state)){
    await c.db.query('UPDATE gp_transfer_outbox SET lease_token=NULL,lease_until=NULL WHERE transfer_id=$1',[t.id]);
    return publicOrder((await c.db.query('UPDATE gp_transfers SET observation=$2,updated_at=now() WHERE id=$1 RETURNING *',[t.id,errorCode||result.state])).rows[0]);
   }
   const success=result.state==='SUCCEEDED',bs=t.binding_snapshot,clearing='transfer:'+hash(canonical([bs.issuer,bs.merchant]));
   if(success){
    // The unique issuer/merchant/environment transaction key survives App/key changes.
    await c.db.query('UPDATE gp_transfer_outbox SET external_transaction_id=$2 WHERE transfer_id=$1',[t.id,result.transaction_id]);
    await c.db.query(`INSERT INTO wallet_transfer_clearing(scope_id,issuer,merchant,account,net_minor) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(scope_id,issuer,merchant) DO UPDATE SET net_minor=wallet_transfer_clearing.net_minor+EXCLUDED.net_minor`,[t.scope_id,bs.issuer,bs.merchant,clearing,(BigInt(t.amount_minor)*(t.direction==='IN'?-1n:1n)).toString()]);
   }
   await c.finish(t.external_user_id,t.direction,t.amount_minor,success,clearing);
   const receipt={transfer_id:t.id,external_operation_id:out.operation_id,external_transaction_id:success?result.transaction_id:null,direction:t.direction,amount_minor:t.amount_minor,currency_id:t.currency_id,ledger_transaction_id:c.transactionId,body_sha256:t.request_sha256,...(!success?{rejection_code:result.rejection_code}:{})};
   await c.db.query('UPDATE gp_transfer_outbox SET result=$2,lease_token=NULL,lease_until=NULL WHERE transfer_id=$1',[t.id,result]);
   const row=(await c.db.query('UPDATE gp_transfers SET state=$2,observation=$2,receipt=$3,ledger_transaction_id=$4,updated_at=now() WHERE id=$1 RETURNING *',[t.id,result.state,receipt,c.transactionId])).rows[0];
   await c.db.query("INSERT INTO gp_audit(actor,action,app_id,detail) VALUES('transfer-worker','transfer.finalized',$1,$2)",[t.app_id,{transfer_id:t.id,state:row.state,ledger_transaction_id:c.transactionId}]);
   return publicOrder(row);
  });
 }
 async function run(id){
  const job=await claim(id);if(!job)return null;
  const handle=frozen({binding:structuredClone(job.row.binding_snapshot),operation:JSON.parse(job.out.raw_body),raw_body:job.out.raw_body,body_sha256:job.out.body_sha256});
  try{
   let result;
   if(job.out.attempts>0)result=validateResult(await adapterCall(job.adapter,'query',handle),handle);
   if(!result||result.state==='NOT_FOUND')result=validateResult(await adapterCall(job.adapter,'submit',handle),handle);
   return await settle(job,result);
  }catch(error){return settle(job,null,error.code==='23505'?'TRANSFER_DUPLICATE_EXTERNAL_TRANSACTION':error.code==='TRANSFER_RECEIPT_INVALID'?'TRANSFER_RECEIPT_INVALID':'TRANSFER_UNKNOWN');}
 }
 function advance(id){
  if(!safe(id))return Promise.reject(new TransferError(400,'INVALID_REQUEST'));
  if(closed)return Promise.reject(new TransferError(503,'TRANSFER_STOPPING'));
  if(active.has(id))return active.get(id);
  if(active.size>=4||physical.size>=4)return Promise.reject(new TransferError(503,'TRANSFER_BUSY'));
  const task=run(id).finally(()=>active.delete(id));active.set(id,task);return task;
 }
 function recoverPending(){
  if(closed||recoveryTask||environment!=='production')return recoveryTask||Promise.resolve();
  recoveryTask=(async()=>{
   const rows=(await pool.query("SELECT t.id FROM gp_transfers t JOIN gp_transfer_outbox o ON o.transfer_id=t.id WHERE t.state='PENDING' AND o.next_attempt_at<=now() AND (o.lease_until IS NULL OR o.lease_until<=now()) ORDER BY o.next_attempt_at,t.id LIMIT 10")).rows;
   for(const r of rows){if(closed)break;try{await advance(r.id);}catch{await pool.query("UPDATE gp_transfer_outbox SET next_attempt_at=now()+interval '5 minutes' WHERE transfer_id=$1 AND (lease_until IS NULL OR lease_until<=now())",[r.id]);}}
  })().finally(()=>{recoveryTask=null;});
  return recoveryTask;
 }
 async function statement(app,{keyId,bindingId,after='0',through=null,limit=100}){
  if(!/^(0|[1-9][0-9]{0,18})$/.test(after)||through!==null&&!/^(0|[1-9][0-9]{0,18})$/.test(through)||!Number.isInteger(limit)||limit<1||limit>100)fail(400,'INVALID_REQUEST');
  const b=await authorize(pool,app,keyId,bindingId,'RECONCILE');
  const ceiling=through??(await pool.query('SELECT coalesce(max(id),0)::text n FROM wallet_ledger WHERE scope_id=$1',[b.scope_id])).rows[0].n;
  const rows=(await pool.query(`SELECT l.id::text,l.operation_id,l.transaction_id,l.account,l.delta_available,l.delta_reserved,l.meta,l.created_at,
   t.id AS transfer_id,t.request_id,t.direction,t.amount_minor,t.currency_id,t.binding_id,t.account_id,o.operation_id AS external_operation_id,
   CASE WHEN l.transaction_id=t.ledger_transaction_id THEN t.state ELSE 'PENDING' END AS state_at_entry,
   CASE WHEN l.transaction_id=t.ledger_transaction_id THEN o.external_transaction_id ELSE NULL END AS external_transaction_id,
   CASE WHEN l.transaction_id=t.ledger_transaction_id THEN t.receipt ELSE NULL END AS final_receipt
   FROM wallet_ledger l JOIN gp_transfers t ON t.id=l.operation_id JOIN gp_transfer_outbox o ON o.transfer_id=t.id
   WHERE t.binding_id=$1 AND t.app_id=$2 AND l.scope_id=$3 AND l.id>$4::numeric AND l.id<=$5::numeric ORDER BY l.id LIMIT $6`,[bindingId,app.id,b.scope_id,after,ceiling,limit])).rows;
  return{through:ceiling,next:rows.at(-1)?.id||after,entries:rows};
 }
 return Object.freeze({create,read,advance,recoverPending,statement,state:()=>({closed,active:active.size,physical:physical.size}),async close(){closed=true;for(const controller of physical.values())controller.abort();await Promise.allSettled([...active.values(),recoveryTask]);return{closed:true,unsettled_adapter_calls:physical.size};}});
}
